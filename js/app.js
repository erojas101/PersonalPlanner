import {
  LocalAdapter, NativeAdapter, ServerAdapter, categorize, emptyDoc, live, mergeDocs, monthOf,
  monthSummary, normalize, now, planFor, seedDoc, uid,
} from './store.js';
import { ROLES, detectHeader, readRows, rowsToTransactions } from './importers.js';

// ---------- Estado ----------

const state = {
  doc: emptyDoc(),
  adapter: null,
  server: null,          // info de /api/ping en modo servidor
  view: 'resumen',
  month: currentMonth(),
  filters: { q: '', account: '', category: '' },
  importing: null,       // { file, rows, headerIndex, mapping, accountId, positiveIsExpense }
  saving: false,
  dirty: false,
  lastSync: null,
  error: null,
};

const $main = document.getElementById('main');
const $dialog = document.getElementById('dialog');
const CLP = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });
const money = (n) => CLP.format(Math.round(n || 0));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Servidor o app nativa: los datos van directo a la carpeta de iCloud.
const isRemote = () => state.adapter && state.adapter.kind !== 'local';
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

function currentMonth(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  return currentMonth(new Date(y, m - 1 + delta, 1));
}
function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const categories = () => live(state.doc.collections.categories).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
const accounts = () => live(state.doc.collections.accounts);
const catById = (id) => state.doc.collections.categories.find((c) => c.id === id && !c.deleted);
const accById = (id) => state.doc.collections.accounts.find((a) => a.id === id && !a.deleted);

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2800);
}

// ---------- Mutaciones y guardado ----------

function upsert(collection, rec) {
  const list = state.doc.collections[collection];
  const stamped = { ...rec, updatedAt: now() };
  const i = list.findIndex((r) => r.id === rec.id);
  if (i >= 0) list[i] = { ...list[i], ...stamped };
  else list.push(stamped);
  markDirty();
  return stamped;
}
function remove(collection, id) {
  const list = state.doc.collections[collection];
  const i = list.findIndex((r) => r.id === id);
  if (i >= 0) list[i] = { id, deleted: true, updatedAt: now() };
  markDirty();
}
function markDirty() {
  state.dirty = true;
  if (state.adapter?.kind === 'local') ls.set('planner.unsaved', '1');
  clearTimeout(markDirty.t);
  markDirty.t = setTimeout(save, 500);
  renderSync();
}

async function save() {
  if (state.saving) { markDirty(); return; }
  state.saving = true;
  state.dirty = false;
  renderSync();
  try {
    const result = await state.adapter.save(state.doc);
    // Fusionar con lo local por si hubo cambios mientras se guardaba.
    state.doc = mergeDocs(state.doc, result);
    state.lastSync = new Date();
    state.error = null;
  } catch (e) {
    state.dirty = true;
    state.error = e.message;
  } finally {
    state.saving = false;
    renderSync();
  }
}

async function refreshFromServer() {
  if (!isRemote() || state.saving || state.dirty) return;
  try {
    const remote = await state.adapter.load();
    const before = JSON.stringify(state.doc);
    state.doc = mergeDocs(state.doc, remote);
    state.lastSync = new Date();
    state.error = null;
    // No re-renderizar mientras se escribe en un campo o hay un diálogo abierto.
    if (JSON.stringify(state.doc) !== before && !$dialog.open && !document.activeElement?.matches('input,select,textarea')) render();
  } catch (e) { state.error = e.message; }
  renderSync();
}

function renderSync() {
  const el = document.getElementById('sync-status');
  const mode = { server: `Carpeta iCloud vía ${state.server?.device || 'servidor'}`, native: 'Carpeta iCloud (app Mac)' }[state.adapter?.kind]
    || 'Local en este navegador';
  let status = 'Guardado';
  if (state.saving) status = 'Guardando…';
  else if (state.dirty) status = 'Cambios pendientes';
  if (state.error) status = `⚠︎ ${state.error}`;
  if (state.adapter?.kind === 'local') {
    const out = ls.get('planner.lastOut');
    status += out ? ` · iCloud: ${new Date(out).toLocaleString('es-CL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ' · nunca guardado en iCloud';
    el.innerHTML = `<div>${esc(mode)}</div><div>${esc(status)}</div>`;
    return;
  }
  el.innerHTML = `<div>${esc(mode)}</div><div>${esc(status)}${state.lastSync && !state.error ? ` · ${state.lastSync.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}` : ''}</div>`;
}

// ---------- Arranque ----------

async function boot() {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || ls.get('planner.token') || '';
  if (location.hash.includes('token=')) { ls.set('planner.token', token); history.replaceState(null, '', location.pathname); }
  const server = NativeAdapter.available() ? null : await ServerAdapter.detect(token);
  if (server && !server.authorized) return renderTokenPrompt();
  if (NativeAdapter.available() || server) {
    state.adapter = NativeAdapter.available() ? new NativeAdapter() : new ServerAdapter(token);
    state.server = server || await state.adapter.info();
    state.doc = mergeDocs(await state.adapter.load());
    setInterval(refreshFromServer, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshFromServer(); });
  } else {
    state.adapter = new LocalAdapter();
    // Pedir que el navegador no borre los datos por falta de espacio.
    navigator.storage?.persist?.().catch(() => {});
    state.doc = mergeDocs((await state.adapter.load()) || emptyDoc());
  }
  if (!live(state.doc.collections.categories).length) {
    state.doc = mergeDocs(state.doc, seedDoc());
    markDirty();
  }
  if ('serviceWorker' in navigator && window.isSecureContext && state.adapter.kind !== 'native') navigator.serviceWorker.register('sw.js').catch(() => {});
  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) { state.view = b.dataset.view; render(); window.scrollTo(0, 0); }
  });
  render();
  renderSync();
}

function renderTokenPrompt() {
  $main.innerHTML = `
    <h1>Conectar con el Mac</h1>
    <div class="card">
      <p>El servidor del Mac pide un código de acceso. Lo ves en la ventana de Terminal donde se inició el Planner.</p>
      <form id="token-form" class="row">
        <input type="password" name="token" placeholder="Código de acceso" autocomplete="off" required>
        <button class="btn primary">Conectar</button>
      </form>
    </div>`;
  document.getElementById('token-form').addEventListener('submit', (e) => {
    e.preventDefault();
    ls.set('planner.token', new FormData(e.target).get('token').trim());
    location.reload();
  });
}

// ---------- Vistas ----------

function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  const views = { resumen: viewResumen, movimientos: viewMovimientos, presupuesto: viewPresupuesto, importar: viewImportar, ajustes: viewAjustes };
  $main.innerHTML = views[state.view]();
}

function monthNav() {
  return `<div class="monthnav">
    <button class="btn small" data-action="month" data-delta="-1" aria-label="Mes anterior">‹</button>
    <span class="label">${esc(monthLabel(state.month))}</span>
    <button class="btn small" data-action="month" data-delta="1" aria-label="Mes siguiente">›</button>
  </div>`;
}

const STATUS_LABEL = { ok: 'En línea', risk: 'En riesgo', over: 'Excedido' };

function viewResumen() {
  const s = monthSummary(state.doc, state.month);
  const available = s.totalPlan - s.totalReal;
  const pct = s.totalPlan > 0 ? Math.round((s.totalReal / s.totalPlan) * 100) : 0;
  const alerts = s.rows.filter((r) => r.status !== 'ok');
  const active = s.rows.filter((r) => r.plan > 0 || r.real > 0);
  const isCurrent = s.elapsed > 0 && s.elapsed < 1;
  const noPlan = s.totalPlan === 0;
  return `
    <div class="head"><h1>Resumen</h1>${monthNav()}</div>
    ${s.uncategorized ? `<div class="banner">${s.uncategorized} movimiento(s) sin categoría (${money(s.uncategorizedAmount)}).
      <a href="#" data-action="goto-uncat">Clasificar</a></div>` : ''}
    ${localSyncBanner()}
    ${noPlan ? `<div class="banner">Aún no hay presupuesto para este mes. <a href="#" data-action="goto" data-view="presupuesto">Definir plan</a></div>` : ''}
    <div class="grid">
      <div class="kpi"><div class="label">Gastado</div><div class="value num">${money(s.totalReal)}</div>
        <div class="sub">${pct}% del plan${isCurrent ? ` · ${Math.round(s.elapsed * 100)}% del mes` : ''}</div></div>
      <div class="kpi"><div class="label">Plan de gastos</div><div class="value num">${money(s.totalPlan)}</div>
        <div class="sub">${s.rows.filter((r) => r.plan > 0).length} categorías</div></div>
      <div class="kpi"><div class="label">${available >= 0 ? 'Disponible' : 'Sobre el plan'}</div>
        <div class="value num" style="color:${available >= 0 ? 'var(--ok)' : 'var(--over)'}">${money(Math.abs(available))}</div>
        <div class="sub">${isCurrent ? `Proyección: ${money(s.projected)}` : '&nbsp;'}</div></div>
      <div class="kpi"><div class="label">Ingresos</div><div class="value num pos">${money(s.income)}</div>
        <div class="sub">${s.planIncome ? `Plan ${money(s.planIncome)}` : 'Ahorro: ' + money(s.income - s.totalReal)}</div></div>
    </div>
    ${alerts.length ? `<div class="card"><h2>Alertas</h2>${alerts.map((r) => `
      <div class="row" style="justify-content:space-between;padding:4px 0">
        <span><span class="badge ${r.status}">${STATUS_LABEL[r.status]}</span> ${esc(r.category.name)}</span>
        <span class="num muted">${r.status === 'over' ? `+${money(r.real - r.plan)} sobre el plan` : `proyección ${money(r.projected)} vs ${money(r.plan)}`}</span>
      </div>`).join('')}</div>` : ''}
    <div class="card">
      <h2>Cumplimiento por categoría</h2>
      ${active.length ? active.map((r) => catRow(r, s.elapsed)).join('') : '<div class="empty">Sin gastos ni plan este mes.</div>'}
    </div>
    <div class="card chart"><h2>Últimos 6 meses</h2>${historyChart()}</div>`;
}

function catRow(r, elapsed) {
  const width = r.plan > 0 ? Math.min(100, (r.real / r.plan) * 100) : (r.real > 0 ? 100 : 0);
  const pace = elapsed > 0 && elapsed < 1 && r.plan > 0 ? `<s style="left:${elapsed * 100}%"></s>` : '';
  const pct = r.plan > 0 ? `${Math.round((r.real / r.plan) * 100)}%` : 'sin plan';
  return `<div class="cat">
    <div class="name"><span class="dot" style="background:${esc(r.category.color)}"></span><span>${esc(r.category.name)}</span></div>
    <div class="amounts num"><b>${money(r.real)}</b> / ${money(r.plan)} · <span class="badge ${r.status}">${pct}</span></div>
    <div class="bar ${r.status}"><i style="width:${width}%"></i>${pace}</div>
  </div>`;
}

function historyChart() {
  const months = [...Array(6).keys()].map((i) => shiftMonth(state.month, i - 5));
  // El plan base vale para todos los meses; mostrarlo solo desde el primer movimiento.
  const first = live(state.doc.collections.transactions).reduce((min, t) => (t.date < min ? t.date : min), '9999');
  const data = months.map((m) => {
    const s = monthSummary(state.doc, m);
    return { m, plan: m >= monthOf(first) ? s.totalPlan : 0, real: s.totalReal };
  });
  const max = Math.max(1, ...data.flatMap((d) => [d.plan, d.real]));
  const W = 600; const H = 180; const base = H - 22; const colW = W / 6; const bw = 22;
  const bars = data.map((d, i) => {
    const x = i * colW + colW / 2;
    const hp = (d.plan / max) * (base - 10);
    const hr = (d.real / max) * (base - 10);
    const over = d.plan > 0 && d.real > d.plan;
    const lbl = new Date(...d.m.split('-').map((v, j) => (j ? v - 1 : +v)), 1).toLocaleDateString('es-CL', { month: 'short' });
    return `<rect x="${x - bw - 2}" y="${base - hp}" width="${bw}" height="${hp}" rx="4" fill="var(--border)"><title>Plan ${money(d.plan)}</title></rect>
      <rect x="${x + 2}" y="${base - hr}" width="${bw}" height="${hr}" rx="4" fill="${over ? 'var(--over)' : 'var(--accent)'}"><title>Real ${money(d.real)}</title></rect>
      <text x="${x}" y="${H - 6}" text-anchor="middle" font-size="12" fill="var(--muted)">${esc(lbl)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Plan versus gasto real, últimos 6 meses">
    <line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="var(--border)"/>${bars}</svg>
    <div class="legend"><span><i style="background:var(--border)"></i>Plan</span><span><i style="background:var(--accent)"></i>Real</span><span><i style="background:var(--over)"></i>Real sobre el plan</span></div>`;
}

function categoryOptions(selected, { allowNone = true, noneLabel = 'Sin categoría' } = {}) {
  const groups = { expense: 'Gastos', income: 'Ingresos', transfer: 'Movimientos internos' };
  return (allowNone ? `<option value="">${esc(noneLabel)}</option>` : '') + Object.entries(groups).map(([kind, label]) =>
    `<optgroup label="${label}">${categories().filter((c) => c.kind === kind).map((c) =>
      `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
}
function accountOptions(selected, allLabel) {
  return (allLabel ? `<option value="">${esc(allLabel)}</option>` : '')
    + accounts().map((a) => `<option value="${esc(a.id)}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
}

function filteredTransactions() {
  const { q, account, category } = state.filters;
  const nq = normalize(q);
  return live(state.doc.collections.transactions)
    .filter((t) => monthOf(t.date) === state.month)
    .filter((t) => !account || t.accountId === account)
    .filter((t) => !category || (category === '__none' ? !catById(t.categoryId) : t.categoryId === category))
    .filter((t) => !nq || normalize(t.description).includes(nq) || normalize(t.note).includes(nq))
    .sort((a, b) => (b.date.localeCompare(a.date)) || a.description.localeCompare(b.description));
}

function viewMovimientos() {
  const txs = filteredTransactions();
  const total = txs.reduce((s, t) => s + t.amount, 0);
  let lastDay = '';
  const rows = txs.map((t) => {
    const cat = catById(t.categoryId);
    const acc = accById(t.accountId);
    let header = '';
    if (t.date !== lastDay) {
      lastDay = t.date;
      const d = new Date(`${t.date}T12:00:00`);
      header = `<div class="daygroup">${esc(d.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' }))}</div>`;
    }
    return `${header}<div class="tx ${cat ? '' : 'uncat'}" data-action="edit-tx" data-id="${esc(t.id)}">
      <div class="desc">${esc(t.description)}</div>
      <div class="amt num ${t.amount > 0 ? 'pos' : 'neg'}">${t.amount > 0 ? '+' : ''}${money(t.amount)}</div>
      <div class="meta"><span class="cat-pill">${cat ? `<span class="dot" style="background:${esc(cat.color)}"></span>${esc(cat.name)}` : 'Sin categoría'}</span>
        ${acc ? `· ${esc(acc.name)}` : ''}${t.note ? ` · ${esc(t.note)}` : ''}</div>
    </div>`;
  }).join('');
  return `
    <div class="head"><h1>Movimientos</h1>${monthNav()}</div>
    <div class="filters">
      <input type="search" data-filter="q" placeholder="Buscar descripción o nota" value="${esc(state.filters.q)}">
      <select data-filter="account">${accountOptions(state.filters.account, 'Todas las cuentas')}</select>
      <select data-filter="category"><option value="">Todas las categorías</option>
        <option value="__none" ${state.filters.category === '__none' ? 'selected' : ''}>Sin categoría</option>
        ${categoryOptions(state.filters.category, { allowNone: false })}</select>
    </div>
    <div class="row" style="justify-content:space-between;margin-bottom:6px">
      <span class="muted">${txs.length} movimientos · neto <span class="num">${money(total)}</span></span>
      <div class="row">
        <button class="btn small" data-action="autocat">Auto-clasificar</button>
        <button class="btn small primary" data-action="new-tx">+ Agregar</button>
      </div>
    </div>
    <div class="card" style="padding:4px 12px">${rows || '<div class="empty">No hay movimientos con estos filtros. Importa una cartola desde la pestaña Importar.</div>'}</div>`;
}

function viewPresupuesto() {
  const m = state.month;
  const prev = [1, 2, 3].map((i) => shiftMonth(m, -i));
  const avgFor = (catId, kind) => {
    const vals = prev.map((pm) => {
      const txs = live(state.doc.collections.transactions).filter((t) => monthOf(t.date) === pm && t.categoryId === catId);
      const sum = txs.reduce((s, t) => s + t.amount, 0);
      return kind === 'income' ? sum : -sum;
    });
    return vals.reduce((a, b) => a + b, 0) / 3;
  };
  const budget = (month, catId) => live(state.doc.collections.budgets).find((b) => b.month === month && b.categoryId === catId);
  const section = (kind, title) => {
    const cats = categories().filter((c) => c.kind === kind);
    let tBase = 0; let tMonth = 0; let tAvg = 0;
    const rows = cats.map((c) => {
      const base = budget('*', c.id);
      const over = budget(m, c.id);
      const avg = avgFor(c.id, kind);
      tBase += base?.amount || 0; tMonth += planFor(state.doc, m, c.id); tAvg += avg;
      return `<tr>
        <td><span class="dot" style="background:${esc(c.color)};display:inline-block;margin-right:6px"></span>${esc(c.name)}</td>
        <td class="r"><input type="number" min="0" step="1000" inputmode="numeric" data-budget="*" data-cat="${esc(c.id)}" value="${base ? base.amount : ''}" placeholder="0"></td>
        <td class="r"><input type="number" min="0" step="1000" inputmode="numeric" data-budget="${esc(m)}" data-cat="${esc(c.id)}" value="${over ? over.amount : ''}" placeholder="${base ? base.amount : '='}"></td>
        <td class="r num muted">${avg ? money(avg) : '—'}</td>
      </tr>`;
    }).join('');
    return `<div class="card"><h2>${title}</h2><div class="table-wrap"><table>
      <thead><tr><th>Categoría</th><th class="r">Plan base mensual</th><th class="r">Ajuste ${esc(monthLabel(m))}</th><th class="r">Promedio 3 meses</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>Total</td><td class="r num">${money(tBase)}</td><td class="r num">${money(tMonth)}</td><td class="r num muted">${money(tAvg)}</td></tr></tfoot>
    </table></div></div>`;
  };
  return `
    <div class="head"><h1>Presupuesto</h1>${monthNav()}</div>
    <p class="muted">El <b>plan base</b> se aplica a todos los meses. Usa <b>ajuste</b> para cambiar solo ${esc(monthLabel(m))}; déjalo vacío para usar el base.</p>
    <div class="row" style="margin-bottom:14px"><button class="btn small" data-action="suggest-budget">Completar plan base vacío con el promedio de 3 meses</button></div>
    ${section('expense', 'Gastos')}
    ${section('income', 'Ingresos esperados')}`;
}

function viewImportar() {
  const imp = state.importing;
  const bankCard = state.adapter.kind === 'server' ? `
    <div class="card">
      <h2>Conexión bancaria automática</h2>
      <p class="muted">Descarga movimientos desde los bancos configurados en el Mac (Fintoc). La configuración se explica en el README.</p>
      <button class="btn" data-action="bank-sync">Sincronizar bancos</button>
      <div id="bank-result" class="muted" style="margin-top:8px"></div>
    </div>` : '';
  if (!imp) {
    return `<h1>Importar cartola</h1>
      <div class="card">
        <p>Descarga la cartola o el estado de cuenta desde el sitio de tu banco (CSV, Excel .xlsx o el "Excel" en HTML que entregan muchos bancos chilenos) y selecciónalo aquí. Reimportar el mismo archivo no duplica movimientos.</p>
        <label class="field">Cuenta<select id="imp-account">${accountOptions(ls.get('planner.lastAccount'))}</select></label>
        <label class="field">Archivo<input type="file" id="imp-file" accept=".csv,.txt,.tsv,.xls,.xlsx,.html,.htm,text/csv"></label>
      </div>${bankCard}`;
  }
  const acc = accById(imp.accountId);
  const maxCols = Math.max(...imp.rows.slice(0, 40).map((r) => r.length));
  const sample = imp.rows.slice(Math.max(0, imp.headerIndex), Math.max(0, imp.headerIndex) + 12);
  let parsed = null; let error = null;
  try { parsed = rowsToTransactions(imp.rows, imp); } catch (e) { error = e.message; }
  const existing = new Set(state.doc.collections.transactions.map((t) => t.id));
  const fresh = parsed ? parsed.transactions.filter((t) => !existing.has(t.id)) : [];
  const spend = fresh.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
  return `<h1>Importar cartola</h1>
    <div class="card">
      <div class="row" style="justify-content:space-between"><b>${esc(imp.file)}</b><span class="muted">→ ${esc(acc?.name || '')}</span></div>
      <p class="muted">Revisa qué representa cada columna. La fila en cursiva es el encabezado detectado.</p>
      <div class="table-wrap"><table class="preview">
        <thead><tr>${[...Array(maxCols).keys()].map((i) => `<th><select data-map="${i}">${ROLES.map(([v, l]) =>
          `<option value="${v}" ${imp.mapping[i] === v ? 'selected' : ''}>${l}</option>`).join('')}</select></th>`).join('')}</tr></thead>
        <tbody>${sample.map((r, ri) => `<tr class="${ri === 0 && imp.headerIndex >= 0 ? 'hdr' : ''}">${[...Array(maxCols).keys()].map((i) => `<td>${esc(r[i])}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <label class="field" style="margin-top:12px">Fila de encabezado
        <input type="number" min="0" id="imp-header" value="${imp.headerIndex + 1}" style="width:100px"></label>
      ${imp.mapping.includes('amount') ? `<label class="check"><input type="checkbox" id="imp-sign" ${imp.positiveIsExpense ? 'checked' : ''}>
        Los montos positivos son gastos (habitual en estados de tarjeta de crédito)</label>` : ''}
      ${error ? `<div class="banner">${esc(error)}</div>` : `<p><b>${fresh.length}</b> movimientos nuevos (${money(spend)} en cargos)
        · ${parsed.transactions.length - fresh.length} ya importados · ${parsed.skipped} filas ignoradas</p>`}
      <div class="row"><button class="btn primary" data-action="do-import" ${error || !fresh.length ? 'disabled' : ''}>Importar ${fresh.length}</button>
        <button class="btn" data-action="cancel-import">Cancelar</button></div>
    </div>`;
}

function viewAjustes() {
  const rules = live(state.doc.collections.rules).sort((a, b) => a.pattern.localeCompare(b.pattern));
  const isServer = isRemote();
  return `<h1>Ajustes</h1>
    <div class="card"><h2>Sincronización</h2>
      ${isServer ? `<p>Los datos se guardan en la carpeta de iCloud del Mac:<br><code>${esc(state.server.dataDir)}</code></p>
        <p class="muted">Cada dispositivo escribe su propio archivo en esa carpeta y la app los fusiona, así no hay conflictos de iCloud.</p>
        ${state.adapter.kind === 'native' ? '<div class="row"><button class="btn small" data-action="choose-folder">Cambiar carpeta…</button></div>' : ''}
        ${state.server.lanUrl ? `<p>Abrir desde el iPhone (misma red Wi-Fi): <code>${esc(state.server.lanUrl)}</code></p>` : ''}`
        : `<p>Modo local: los datos viven en este navegador. Para sincronizar con iCloud Drive:</p>
        <label class="field">Nombre de este dispositivo<input type="text" id="device-name" value="${esc(ls.get('planner.device') || 'iphone')}"></label>
        <div class="row">
          <label class="btn">Cargar desde iCloud…<input type="file" id="sync-in" accept=".json,application/json" multiple hidden></label>
          <button class="btn primary" data-action="sync-out">Guardar en iCloud…</button>
        </div>
        <p class="muted" style="margin-top:8px">«Cargar»: elige todos los .json de <code>Planner/data</code> en Archivos. «Guardar»: elige «Guardar en Archivos» y esa misma carpeta.</p>`}
      <div class="row" style="margin-top:8px"><button class="btn small" data-action="backup">Descargar respaldo</button></div>
    </div>
    <div class="card"><h2>Cuentas</h2>
      ${accounts().map((a) => `<div class="list-item">
        <div class="grow"><b>${esc(a.name)}</b> <span class="muted">${esc(a.bank || '')} · ${a.type === 'credito' ? 'Tarjeta de crédito' : a.type === 'vista' ? 'Cuenta vista / RUT' : 'Cuenta corriente'}</span></div>
        <button class="btn small" data-action="edit-account" data-id="${esc(a.id)}">Editar</button></div>`).join('')}
      <button class="btn small" data-action="edit-account" style="margin-top:8px">+ Cuenta</button>
    </div>
    <div class="card"><h2>Categorías</h2>
      ${categories().map((c) => `<div class="list-item">
        <input type="color" value="${esc(c.color)}" data-cat-color="${esc(c.id)}" aria-label="Color">
        <div class="grow">${esc(c.name)} <span class="muted">· ${c.kind === 'income' ? 'ingreso' : c.kind === 'transfer' ? 'interno (no cuenta)' : c.fixed ? 'gasto fijo' : 'gasto'}</span></div>
        <button class="btn small" data-action="edit-category" data-id="${esc(c.id)}">Editar</button></div>`).join('')}
      <button class="btn small" data-action="edit-category" style="margin-top:8px">+ Categoría</button>
    </div>
    <div class="card"><h2>Reglas de clasificación</h2>
      <p class="muted">Si la descripción contiene el texto, se asigna la categoría. Gana el texto más largo.</p>
      <form id="rule-form" class="row" style="margin-bottom:8px">
        <input type="text" name="pattern" placeholder="Texto, ej. JUMBO" required style="flex:1">
        <select name="categoryId" required>${categoryOptions('', { allowNone: false })}</select>
        <button class="btn small primary">Agregar</button>
      </form>
      ${rules.map((r) => `<div class="list-item"><div class="grow"><code>${esc(r.pattern)}</code> → ${esc(catById(r.categoryId)?.name || '¿?')}</div>
        <button class="btn small danger" data-action="del-rule" data-id="${esc(r.id)}" aria-label="Borrar regla">✕</button></div>`).join('')}
    </div>`;
}

// ---------- Diálogos ----------

function openDialog(html, onSubmit) {
  $dialog.innerHTML = `<form method="dialog" id="dlg-form">${html}</form>`;
  const form = document.getElementById('dlg-form');
  form.addEventListener('submit', (e) => {
    const action = e.submitter?.value;
    if (action === 'cancel') return;
    e.preventDefault();
    if (onSubmit(action, new FormData(form)) !== false) { $dialog.close(); render(); }
  });
  $dialog.showModal();
}

function editTx(id) {
  const t = id ? state.doc.collections.transactions.find((x) => x.id === id) : null;
  // Sugerir un fragmento contiguo con dos palabras significativas, para que la regla coincida.
  const picked = [];
  let significant = 0;
  for (const tok of normalize(t?.description).split(' ')) {
    if (/[0-9*#]/.test(tok) || significant === 2) break;
    picked.push(tok);
    if (tok.length > 2) significant++;
  }
  const words = picked.join(' ');
  openDialog(`<h2>${t ? 'Editar movimiento' : 'Nuevo movimiento'}</h2>
    <label class="field">Descripción<input type="text" name="description" value="${esc(t?.description)}" required></label>
    <div class="row" style="align-items:flex-start">
      <label class="field" style="flex:1">Fecha<input type="date" name="date" value="${esc(t?.date || new Date().toISOString().slice(0, 10))}" required></label>
      <label class="field" style="flex:1">Monto (negativo = gasto)<input type="number" name="amount" step="any" inputmode="decimal" value="${t ? t.amount : ''}" placeholder="-15990" required></label>
    </div>
    <label class="field">Cuenta<select name="accountId">${accountOptions(t?.accountId)}</select></label>
    <label class="field">Categoría<select name="categoryId">${categoryOptions(t?.categoryId)}</select></label>
    <label class="field">Nota<input type="text" name="note" value="${esc(t?.note)}"></label>
    ${t && words ? `<label class="check"><input type="checkbox" name="makeRule"> Crear regla: siempre clasificar «<input type="text" name="rulePattern" value="${esc(words)}" style="width:150px;padding:3px 6px">» así</label>` : ''}
    <div class="actions">
      ${t ? '<button class="btn danger" value="delete" formnovalidate>Eliminar</button><span class="spacer"></span>' : ''}
      <button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Guardar</button>
    </div>`, (action, f) => {
    if (action === 'delete') { remove('transactions', t.id); return; }
    const rec = {
      id: t?.id || uid('tx'), source: t?.source || 'manual',
      description: f.get('description').trim(), date: f.get('date'), amount: Number(f.get('amount')),
      accountId: f.get('accountId'), categoryId: f.get('categoryId') || null, note: f.get('note').trim(),
    };
    upsert('transactions', rec);
    if (f.get('makeRule') && rec.categoryId && f.get('rulePattern').trim()) {
      const pattern = normalize(f.get('rulePattern'));
      upsert('rules', { id: uid('rule'), pattern, categoryId: rec.categoryId });
      const n = applyRules(true);
      toast(`Regla creada${n ? `; ${n} movimiento(s) clasificados` : ''}`);
    }
  });
}

// Bancos que operan en Chile (registro CMF). «Otro…» cubre cualquier institución que falte.
const CHILE_BANKS = [
  'Banco BICE', 'Banco BTG Pactual Chile', 'Banco Consorcio', 'Banco de Chile', 'Banco de Crédito e Inversiones (BCI)',
  'Banco de la Nación Argentina', 'Banco Falabella', 'Banco Internacional', 'Banco Ripley', 'Banco Santander Chile',
  'Banco Security', 'BancoEstado', 'Bank of China (Agencia en Chile)', 'China Construction Bank (Agencia en Chile)',
  'HSBC Bank Chile', 'Itaú Chile', 'JP Morgan Chase Bank', 'MUFG Bank', 'Scotiabank Chile', 'Tanner Banco Digital',
];
const CHILE_OTHERS = ['Coopeuch', 'Los Héroes (Prepago)', 'MACH', 'Mercado Pago', 'Tenpo'];

function bankSelect(current) {
  const isOther = !!current && ![...CHILE_BANKS, ...CHILE_OTHERS].includes(current);
  const opt = (b) => `<option value="${esc(b)}" ${b === current ? 'selected' : ''}>${esc(b)}</option>`;
  return `<label class="field">Banco<select name="bankChoice">
      <option value="" ${current ? '' : 'selected'}>— Selecciona —</option>
      <optgroup label="Bancos">${CHILE_BANKS.map(opt).join('')}</optgroup>
      <optgroup label="Cooperativas y billeteras">${CHILE_OTHERS.map(opt).join('')}</optgroup>
      <option value="__other" ${isOther ? 'selected' : ''}>Otro…</option>
    </select></label>
    <label class="field" id="bank-other" ${isOther ? '' : 'hidden'}>Nombre de la institución
      <input type="text" name="bankOther" value="${esc(isOther ? current : '')}" placeholder="Ej. Caja Los Andes"></label>`;
}

function editAccount(id) {
  const a = id ? accById(id) : null;
  openDialog(`<h2>${a ? 'Editar cuenta' : 'Nueva cuenta'}</h2>
    <label class="field">Nombre<input type="text" name="name" value="${esc(a?.name)}" required placeholder="Cuenta corriente Banco de Chile"></label>
    ${bankSelect(a?.bank)}
    <label class="field">Tipo<select name="type">
      ${[['corriente', 'Cuenta corriente'], ['vista', 'Cuenta vista / RUT'], ['credito', 'Tarjeta de crédito']].map(([v, l]) =>
        `<option value="${v}" ${a?.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="actions">
      ${a ? '<button class="btn danger" value="delete" formnovalidate>Eliminar</button><span class="spacer"></span>' : ''}
      <button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Guardar</button>
    </div>`, (action, f) => {
    if (action === 'delete') {
      if (live(state.doc.collections.transactions).some((t) => t.accountId === a.id)) { toast('La cuenta tiene movimientos; no se puede eliminar.'); return false; }
      remove('accounts', a.id); return;
    }
    const choice = f.get('bankChoice');
    const bank = choice === '__other' ? f.get('bankOther').trim() : choice;
    upsert('accounts', { id: a?.id || uid('acc'), name: f.get('name').trim(), bank, type: f.get('type') });
  });
  const form = document.getElementById('dlg-form');
  form.bankChoice.addEventListener('change', () => {
    const other = form.bankChoice.value === '__other';
    document.getElementById('bank-other').hidden = !other;
    if (other) form.bankOther.focus();
  });
}

function editCategory(id) {
  const c = id ? catById(id) : null;
  openDialog(`<h2>${c ? 'Editar categoría' : 'Nueva categoría'}</h2>
    <label class="field">Nombre<input type="text" name="name" value="${esc(c?.name)}" required></label>
    <label class="field">Tipo<select name="kind">
      ${[['expense', 'Gasto'], ['income', 'Ingreso'], ['transfer', 'Interno (no cuenta como gasto ni ingreso)']].map(([v, l]) =>
        `<option value="${v}" ${c?.kind === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="field">Color<input type="color" name="color" value="${esc(c?.color || '#0ea5e9')}"></label>
    <label class="check"><input type="checkbox" name="fixed" ${c?.fixed ? 'checked' : ''}> Gasto fijo mensual (arriendo, cuentas): no se proyecta según el avance del mes</label>
    <div class="actions">
      ${c ? '<button class="btn danger" value="delete" formnovalidate>Eliminar</button><span class="spacer"></span>' : ''}
      <button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Guardar</button>
    </div>`, (action, f) => {
    if (action === 'delete') {
      const n = live(state.doc.collections.transactions).filter((t) => t.categoryId === c.id).length;
      if (n && !confirm(`${n} movimiento(s) quedarán sin categoría. ¿Eliminar?`)) return false;
      remove('categories', c.id); return;
    }
    upsert('categories', { id: c?.id || uid('cat'), name: f.get('name').trim(), kind: f.get('kind'), color: f.get('color'), fixed: !!f.get('fixed'), order: c?.order ?? 999 });
  });
}

// Clasifica los movimientos sin categoría. Devuelve cuántos cambió.
function applyRules(silent) {
  const rules = state.doc.collections.rules;
  let n = 0;
  for (const t of live(state.doc.collections.transactions)) {
    if (catById(t.categoryId)) continue;
    const cat = categorize(t.description, rules);
    if (cat) { upsert('transactions', { ...t, categoryId: cat }); n++; }
  }
  if (!silent) toast(n ? `${n} movimiento(s) clasificados` : 'No hubo coincidencias con las reglas');
  return n;
}

// ---------- Importación ----------

async function startImport(file) {
  const accountId = document.getElementById('imp-account').value;
  if (!accountId) { toast('Primero crea una cuenta en Ajustes'); return; }
  ls.set('planner.lastAccount', accountId);
  try {
    const rows = await readRows(file);
    if (!rows.length) throw new Error('El archivo está vacío.');
    const { headerIndex, mapping } = detectHeader(rows);
    const width = Math.max(...rows.slice(0, 40).map((r) => r.length));
    while (mapping.length < width) mapping.push('ignore');
    state.importing = { file: file.name, rows, headerIndex, mapping, accountId, positiveIsExpense: accById(accountId)?.type === 'credito' };
    render();
  } catch (e) { toast(e.message); }
}

function doImport() {
  const imp = state.importing;
  const { transactions } = rowsToTransactions(imp.rows, imp);
  const existing = new Set(state.doc.collections.transactions.map((t) => t.id));
  const t = now();
  const fresh = transactions.filter((x) => !existing.has(x.id)).map((x) => ({
    ...x, categoryId: categorize(x.description, state.doc.collections.rules), importedAt: t, updatedAt: t,
  }));
  state.doc.collections.transactions.push(...fresh);
  markDirty();
  const months = [...new Set(fresh.map((x) => monthOf(x.date)))].sort();
  const uncat = fresh.filter((x) => !x.categoryId).length;
  state.importing = null;
  if (months.length) state.month = months[months.length - 1];
  state.view = 'movimientos';
  state.filters = { q: '', account: '', category: uncat ? '__none' : '' };
  render();
  toast(`${fresh.length} movimientos importados${uncat ? `, ${uncat} sin categoría` : ''}`);
}

// ---------- Sincronización por archivos (modo local) ----------

async function syncIn(files) {
  let docs = [];
  for (const f of files) {
    try { docs.push(JSON.parse(await f.text())); } catch { toast(`No pude leer ${f.name}`); }
  }
  docs = docs.filter((d) => d && d.collections);
  if (!docs.length) return;
  const before = state.doc.collections.transactions.length;
  state.doc = mergeDocs(state.doc, ...docs);
  await state.adapter.save(state.doc);
  state.lastSync = new Date();
  ls.set('planner.lastIn', state.lastSync.toISOString());
  render(); renderSync();
  toast(`Sincronizado (${docs.length} archivo(s), ${state.doc.collections.transactions.length - before} movimientos nuevos)`);
}

// Devuelve false si el usuario canceló la hoja de compartir.
async function exportFile(name) {
  if (state.adapter.kind === 'native') return state.adapter.saveFile(name, JSON.stringify(state.doc));
  const blob = new Blob([JSON.stringify(state.doc)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

async function syncOut() {
  const device = (ls.get('planner.device') || 'iphone').replace(/[^\w-]/g, '') || 'iphone';
  if (!(await exportFile(`${device}.json`))) return;
  ls.set('planner.unsaved', '0');
  ls.set('planner.lastOut', new Date().toISOString());
  renderSync();
  if (state.view === 'resumen') render();
}

// Recordatorio en modo local: cambios sin enviar a iCloud o datos del Mac sin traer hace días.
function localSyncBanner() {
  if (state.adapter.kind !== 'local') return '';
  if (ls.get('planner.unsaved') === '1') {
    return `<div class="banner">Tienes cambios que aún no están en iCloud.
      <a href="#" data-action="sync-out">Guardar en iCloud</a></div>`;
  }
  const lastIn = ls.get('planner.lastIn');
  if (!lastIn || Date.now() - new Date(lastIn).getTime() > 3 * 86400000) {
    return `<div class="banner">${lastIn ? 'Hace más de 3 días que no traes' : 'Aún no traes'} los datos del Mac.
      <label style="cursor:pointer;font-weight:600;text-decoration:underline">Cargar desde iCloud<input type="file" id="sync-in" accept=".json,application/json" multiple hidden></label></div>`;
  }
  return '';
}

// ---------- Eventos ----------

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.closest('dialog')) return;
  e.preventDefault();
  const { action, id } = el.dataset;
  switch (action) {
    case 'month': state.month = shiftMonth(state.month, Number(el.dataset.delta)); render(); break;
    case 'goto': state.view = el.dataset.view; render(); break;
    case 'goto-uncat': state.view = 'movimientos'; state.filters = { q: '', account: '', category: '__none' }; render(); break;
    case 'edit-tx': editTx(id); break;
    case 'new-tx': editTx(null); break;
    case 'autocat': applyRules(false); render(); break;
    case 'edit-account': editAccount(id); break;
    case 'edit-category': editCategory(id); break;
    case 'del-rule': remove('rules', id); render(); break;
    case 'do-import': doImport(); break;
    case 'cancel-import': state.importing = null; render(); break;
    case 'sync-out': await syncOut(); break;
    case 'backup': exportFile(`planner-respaldo-${new Date().toISOString().slice(0, 10)}.json`); break;
    case 'suggest-budget': suggestBudget(); break;
    case 'bank-sync': await bankSync(el); break;
    case 'choose-folder': {
      state.server = await state.adapter.chooseFolder();
      state.doc = mergeDocs(await state.adapter.load());
      render(); renderSync();
      break;
    }
    default: break;
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.closest('dialog')) return;
  if (el.id === 'imp-file' && el.files[0]) startImport(el.files[0]);
  else if (el.id === 'sync-in' && el.files.length) syncIn([...el.files]);
  else if (el.id === 'device-name') ls.set('planner.device', el.value.trim() || 'iphone');
  else if (el.dataset.map !== undefined) { state.importing.mapping[Number(el.dataset.map)] = el.value; render(); }
  else if (el.id === 'imp-header') { state.importing.headerIndex = Math.max(-1, Number(el.value) - 1); render(); }
  else if (el.id === 'imp-sign') { state.importing.positiveIsExpense = el.checked; render(); }
  else if (el.dataset.filter && el.dataset.filter !== 'q') { state.filters[el.dataset.filter] = el.value; render(); }
  else if (el.dataset.budget) {
    const id = `${el.dataset.budget}:${el.dataset.cat}`;
    if (el.value === '') remove('budgets', id);
    else upsert('budgets', { id, month: el.dataset.budget, categoryId: el.dataset.cat, amount: Math.max(0, Number(el.value)) });
    render();
  } else if (el.dataset.catColor) {
    upsert('categories', { ...catById(el.dataset.catColor), color: el.value });
  }
});

document.addEventListener('input', (e) => {
  if (e.target.dataset.filter === 'q') {
    state.filters.q = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const input = document.querySelector('[data-filter="q"]');
    input.focus(); input.setSelectionRange(pos, pos);
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'rule-form') return;
  e.preventDefault();
  const f = new FormData(e.target);
  upsert('rules', { id: uid('rule'), pattern: normalize(f.get('pattern')), categoryId: f.get('categoryId') });
  const n = applyRules(true);
  render();
  toast(`Regla agregada${n ? `; ${n} movimiento(s) clasificados` : ''}`);
});

function suggestBudget() {
  const m = state.month;
  const prev = [1, 2, 3].map((i) => shiftMonth(m, -i));
  let n = 0;
  for (const c of categories().filter((x) => x.kind !== 'transfer')) {
    if (live(state.doc.collections.budgets).some((b) => b.month === '*' && b.categoryId === c.id)) continue;
    const sum = live(state.doc.collections.transactions)
      .filter((t) => prev.includes(monthOf(t.date)) && t.categoryId === c.id)
      .reduce((s, t) => s + t.amount, 0);
    const avg = Math.round(Math.abs(sum) / 3 / 1000) * 1000;
    if (avg > 0) { upsert('budgets', { id: `*:${c.id}`, month: '*', categoryId: c.id, amount: avg }); n++; }
  }
  render();
  toast(n ? `${n} categorías completadas` : 'No hay historial suficiente en los 3 meses anteriores');
}

async function bankSync(btn) {
  const out = document.getElementById('bank-result');
  btn.disabled = true;
  out.textContent = 'Consultando bancos…';
  try {
    if (state.dirty) await save();
    const r = await state.adapter.bankSync();
    if (!r.ok) { out.textContent = r.error; return; }
    state.doc = mergeDocs(state.doc, r.doc);
    const n = applyRules(true);
    out.textContent = `${r.added} movimientos nuevos de ${r.accounts} cuenta(s)${n ? `, ${n} clasificados` : ''}.${r.warnings?.length ? ' ' + r.warnings.join(' ') : ''}`;
    markDirty();
  } catch (e) { out.textContent = e.message; } finally { btn.disabled = false; }
}

boot().catch((e) => { $main.innerHTML = `<div class="card">No se pudo iniciar: ${esc(e.message)}</div>`; });
