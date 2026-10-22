// Modelo de datos, fusión entre dispositivos y persistencia.
//
// Cada registro lleva `id` y `updatedAt`. Los borrados son lápidas
// (`deleted: true`) para que la fusión los propague. Fusionar = unir por id
// y quedarse con la versión de `updatedAt` más reciente.

export const COLLECTIONS = ['accounts', 'categories', 'budgets', 'transactions', 'rules'];
const EPOCH = '1970-01-01T00:00:00.000Z';

export const now = () => new Date().toISOString();
export const uid = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function emptyDoc() {
  return { version: 1, collections: Object.fromEntries(COLLECTIONS.map((c) => [c, []])) };
}

function newer(a, b) {
  const ta = a.updatedAt || EPOCH;
  const tb = b.updatedAt || EPOCH;
  if (ta !== tb) return ta > tb ? a : b;
  // Empate: elección determinista para que todos los dispositivos converjan.
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

export function mergeDocs(...docs) {
  const out = emptyDoc();
  for (const c of COLLECTIONS) {
    const byId = new Map();
    for (const doc of docs) {
      for (const rec of doc?.collections?.[c] || []) {
        if (!rec || !rec.id) continue;
        const prev = byId.get(rec.id);
        byId.set(rec.id, prev ? newer(prev, rec) : rec);
      }
    }
    out.collections[c] = [...byId.values()];
  }
  return out;
}

// FNV-1a de 53 bits: ids estables sin depender de crypto.subtle
// (no disponible en http:// por la red local).
export function hash(str) {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const normalize = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

// ---------- Datos iniciales (Chile) ----------

const DEFAULT_CATEGORIES = [
  ['vivienda', 'Vivienda (arriendo/dividendo)', 'expense', '#6366f1'],
  ['gastos_comunes', 'Gastos comunes', 'expense', '#8b5cf6'],
  ['servicios', 'Servicios básicos', 'expense', '#0ea5e9'],
  ['telecom', 'Internet y teléfono', 'expense', '#06b6d4'],
  ['supermercado', 'Supermercado', 'expense', '#22c55e'],
  ['restaurantes', 'Restaurantes y delivery', 'expense', '#f97316'],
  ['transporte', 'Transporte (bencina, TAG, apps)', 'expense', '#eab308'],
  ['salud', 'Salud', 'expense', '#ef4444'],
  ['educacion', 'Educación', 'expense', '#14b8a6'],
  ['seguros', 'Seguros', 'expense', '#64748b'],
  ['suscripciones', 'Suscripciones', 'expense', '#a855f7'],
  ['entretencion', 'Entretención', 'expense', '#ec4899'],
  ['ropa', 'Ropa y tiendas', 'expense', '#f43f5e'],
  ['hogar', 'Hogar', 'expense', '#84cc16'],
  ['mascotas', 'Mascotas', 'expense', '#d97706'],
  ['viajes', 'Viajes', 'expense', '#0284c7'],
  ['creditos', 'Créditos y deudas', 'expense', '#b91c1c'],
  ['ahorro', 'Ahorro e inversión', 'expense', '#059669'],
  ['otros', 'Otros gastos', 'expense', '#9ca3af'],
  ['sueldo', 'Sueldo', 'income', '#16a34a'],
  ['otros_ingresos', 'Otros ingresos', 'income', '#4ade80'],
  ['transferencias', 'Transferencias propias / pago tarjeta', 'transfer', '#94a3b8'],
];

// Gastos fijos: se pagan una vez al mes, así que no se proyectan linealmente.
const FIXED = new Set(['vivienda', 'gastos_comunes', 'servicios', 'telecom', 'educacion', 'seguros', 'suscripciones', 'creditos', 'ahorro']);

const DEFAULT_RULES = {
  vivienda: ['ARRIENDO', 'DIVIDENDO'],
  gastos_comunes: ['GASTOS COMUNES', 'GASTO COMUN', 'EDIFICIO', 'COMUNIDAD'],
  supermercado: ['LIDER', 'JUMBO', 'UNIMARC', 'SANTA ISABEL', 'TOTTUS', 'ACUENTA', 'MAYORISTA 10', 'ALVI'],
  restaurantes: ['UBER EATS', 'RAPPI', 'PEDIDOSYA', 'STARBUCKS', 'MCDONALD', 'BURGER KING', 'JUAN MAESTRO', 'DOMINO'],
  transporte: ['COPEC', 'SHELL', 'PETROBRAS', 'ARAMCO', 'UBER', 'CABIFY', 'DIDI', 'METRO', 'BIP', 'AUTOPISTA', 'COSTANERA NORTE', 'VESPUCIO NORTE', 'VESPUCIO SUR', 'AUTOPASE', 'TAG'],
  servicios: ['ENEL', 'AGUAS ANDINAS', 'METROGAS', 'ABASTIBLE', 'LIPIGAS', 'GASCO', 'CGE', 'ESVAL', 'ESSBIO'],
  telecom: ['ENTEL', 'MOVISTAR', 'WOM', 'CLARO', 'VTR', 'MUNDO PACIFICO', 'GTD'],
  suscripciones: ['NETFLIX', 'SPOTIFY', 'DISNEY', 'HBO', 'APPLE.COM', 'GOOGLE', 'AMAZON PRIME', 'YOUTUBE', 'CHATGPT', 'OPENAI', 'ANTHROPIC'],
  salud: ['CRUZ VERDE', 'SALCOBRAND', 'AHUMADA', 'DR SIMI', 'ISAPRE', 'COLMENA', 'BANMEDICA', 'CONSALUD', 'CRUZ BLANCA', 'FONASA', 'CLINICA', 'INTEGRAMEDICA'],
  ropa: ['FALABELLA', 'PARIS', 'RIPLEY', 'H&M', 'ZARA', 'HITES', 'LA POLAR'],
  hogar: ['SODIMAC', 'HOMECENTER', 'EASY', 'IKEA', 'CONSTRUMART'],
  entretencion: ['CINEMARK', 'CINEPOLIS', 'TICKETMASTER', 'PUNTOTICKET', 'STEAM', 'PLAYSTATION'],
  sueldo: ['REMUNERACION', 'SUELDO', 'PAGO NOMINA', 'NOMINA'],
  transferencias: ['PAGO TARJETA', 'PAGO TC', 'PAGO DE TARJETA', 'PAGO RECIBIDO', 'TRASPASO'],
};

export function seedDoc() {
  const t = now();
  const doc = emptyDoc();
  doc.collections.categories = DEFAULT_CATEGORIES.map(([id, name, kind, color], i) => ({
    id: `cat_${id}`, name, kind, color, order: i, fixed: FIXED.has(id), updatedAt: t,
  }));
  doc.collections.rules = Object.entries(DEFAULT_RULES).flatMap(([cat, patterns]) =>
    patterns.map((p) => ({ id: `rule_${hash(cat + p)}`, pattern: p, categoryId: `cat_${cat}`, updatedAt: t })),
  );
  doc.collections.accounts = [
    { id: 'acc_corriente', name: 'Cuenta corriente', bank: '', type: 'corriente', updatedAt: t },
    { id: 'acc_tc', name: 'Tarjeta de crédito', bank: '', type: 'credito', updatedAt: t },
  ];
  return doc;
}

// ---------- Consultas ----------

export const live = (list) => list.filter((r) => !r.deleted);

export function categorize(description, rules) {
  const d = normalize(description);
  // Patrón más largo primero: "UBER EATS" gana a "UBER".
  const sorted = live(rules).slice().sort((a, b) => b.pattern.length - a.pattern.length);
  for (const r of sorted) {
    const p = normalize(r.pattern);
    if (!p) continue;
    const re = new RegExp(`(^|[^A-Z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Z0-9])`);
    if (re.test(d)) return r.categoryId;
  }
  return null;
}

export const monthOf = (isoDate) => isoDate.slice(0, 7);

export function planFor(doc, month, categoryId) {
  const budgets = live(doc.collections.budgets);
  const specific = budgets.find((b) => b.month === month && b.categoryId === categoryId);
  if (specific) return specific.amount;
  const def = budgets.find((b) => b.month === '*' && b.categoryId === categoryId);
  return def ? def.amount : 0;
}

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

// Fracción del mes transcurrida (1 para meses pasados, 0 para futuros).
export function elapsedFraction(month, today = new Date()) {
  const cur = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  if (month < cur) return 1;
  if (month > cur) return 0;
  return today.getDate() / daysInMonth(month);
}

export function monthSummary(doc, month, today = new Date()) {
  const cats = live(doc.collections.categories);
  const catById = new Map(cats.map((c) => [c.id, c]));
  const txs = live(doc.collections.transactions).filter((t) => monthOf(t.date) === month);
  const spent = new Map();
  let income = 0;
  let uncategorized = 0;
  let uncategorizedAmount = 0;
  for (const t of txs) {
    const cat = catById.get(t.categoryId);
    if (!cat) {
      uncategorized++;
      if (t.amount < 0) uncategorizedAmount += -t.amount;
      continue;
    }
    if (cat.kind === 'transfer') continue;
    if (cat.kind === 'income') { income += t.amount; continue; }
    // Gasto: cargos negativos suman, devoluciones (positivas) restan.
    spent.set(cat.id, (spent.get(cat.id) || 0) - t.amount);
  }
  const frac = elapsedFraction(month, today);
  const rows = cats
    .filter((c) => c.kind === 'expense')
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .map((c) => {
      const plan = planFor(doc, month, c.id);
      const real = spent.get(c.id) || 0;
      const pct = plan > 0 ? real / plan : real > 0 ? Infinity : 0;
      let status = 'ok';
      if (real > plan) status = 'over';
      else if (!c.fixed && plan > 0 && frac < 1 && pct > Math.max(0.9, frac + 0.15)) status = 'risk';
      const projected = c.fixed ? Math.max(real, plan) : frac > 0 ? real / frac : real;
      return { category: c, plan, real, pct, status, projected };
    });
  const totalPlan = rows.reduce((s, r) => s + r.plan, 0);
  const totalReal = rows.reduce((s, r) => s + r.real, 0) + uncategorizedAmount;
  const planIncome = cats.filter((c) => c.kind === 'income').reduce((s, c) => s + planFor(doc, month, c.id), 0);
  return {
    month, rows, income, planIncome, totalPlan, totalReal, uncategorized, uncategorizedAmount,
    elapsed: frac, txCount: txs.length,
    projected: rows.reduce((sum, r) => sum + r.projected, 0) + (frac > 0 ? uncategorizedAmount / frac : uncategorizedAmount),
  };
}

// ---------- Persistencia ----------

// Modo servidor: el Mac (o el iPhone por la red local) habla con server.py,
// que guarda en la carpeta de iCloud.
export class ServerAdapter {
  constructor(token) { this.token = token; this.kind = 'server'; }
  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.token) h['X-Planner-Token'] = this.token;
    return h;
  }
  async load() {
    const r = await fetch('api/data', { headers: this.headers(), cache: 'no-store' });
    if (r.status === 401) throw Object.assign(new Error('token'), { code: 401 });
    if (!r.ok) throw new Error(`Servidor respondió ${r.status}`);
    return r.json();
  }
  async save(doc) {
    const r = await fetch('api/data', { method: 'PUT', headers: this.headers(), body: JSON.stringify(doc) });
    if (!r.ok) throw new Error(`No se pudo guardar (${r.status})`);
    return r.json();
  }
  async bankSync() {
    const r = await fetch('api/bank/sync', { method: 'POST', headers: this.headers() });
    return r.json();
  }
  static async detect(token) {
    try {
      const r = await fetch('api/ping', { cache: 'no-store', headers: token ? { 'X-Planner-Token': token } : {} });
      if (!r.ok && r.status !== 401) return null;
      const info = await r.json();
      return { ...info, authorized: r.status !== 401 };
    } catch { return null; }
  }
}

// Modo app nativa de Mac: el puente Swift lee y escribe la carpeta de iCloud.
export class NativeAdapter {
  constructor() { this.kind = 'native'; }
  async call(op, extra = {}) {
    const reply = await window.webkit.messageHandlers.planner.postMessage({ op, ...extra });
    return JSON.parse(reply);
  }
  load() { return this.call('load'); }
  save(doc) { return this.call('save', { doc: JSON.stringify(doc) }); }
  info() { return this.call('info'); }
  chooseFolder() { return this.call('chooseFolder'); }
  saveFile(name, content) { return this.call('saveFile', { name, content }); }
  static available() { return !!window.webkit?.messageHandlers?.planner; }
}

// Modo local: el documento vive en IndexedDB del navegador y se sincroniza
// con iCloud Drive mediante archivos (importar/exportar desde la app Archivos).
export class LocalAdapter {
  constructor() { this.kind = 'local'; }
  db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('planner', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async load() {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const req = db.transaction('kv').objectStore('kv').get('doc');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async save(doc) {
    const db = await this.db();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(doc, 'doc');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return doc;
  }
}
