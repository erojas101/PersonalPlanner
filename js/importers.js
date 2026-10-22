// Lectura de cartolas bancarias: CSV, "Excel" HTML (común en bancos chilenos)
// y .xlsx reales. Sin dependencias: el .xlsx se descomprime con
// DecompressionStream, disponible en Safari 16.4+ y Chrome.

import { hash, normalize } from './store.js';

// ---------- Lectura de archivos a filas ----------

export async function readRows(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0x50 && buf[1] === 0x4b) return readXlsx(buf);
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    throw new Error('Este .xls usa el formato binario antiguo de Excel. Ábrelo en Numbers o Excel y expórtalo como CSV o .xlsx.');
  }
  const text = decodeText(buf);
  if (/^\s*</.test(text)) return readHtmlTable(text);
  return readCsv(text);
}

function decodeText(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
  return new TextDecoder('windows-1252').decode(buf);
}

export function readCsv(text) {
  const firstLines = text.split(/\r?\n/).slice(0, 15).join('\n');
  const delim = [';', '\t', ',', '|']
    .map((d) => [d, firstLines.split(d).length])
    .sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

function readHtmlTable(text) {
  const dom = new DOMParser().parseFromString(text, 'text/html');
  const tables = [...dom.querySelectorAll('table')];
  if (!tables.length) throw new Error('No encontré ninguna tabla en el archivo.');
  // Tablas anidadas: quedarse con la que tiene más filas propias.
  const best = tables
    .map((t) => [t, [...t.rows].filter((r) => r.closest('table') === t)])
    .sort((a, b) => b[1].length - a[1].length)[0][1];
  return best
    .map((tr) => [...tr.cells].map((td) => td.textContent.replace(/\s+/g, ' ').trim()))
    .filter((r) => r.some((c) => c !== ''));
}

async function readXlsx(buf) {
  const files = await unzip(buf, (name) =>
    name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  const sheetName = Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort(
    (a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))[0];
  if (!sheetName) throw new Error('El .xlsx no tiene hojas legibles.');
  const parser = new DOMParser();
  const shared = files['xl/sharedStrings.xml']
    ? [...parser.parseFromString(files['xl/sharedStrings.xml'], 'application/xml').getElementsByTagName('si')]
        .map((si) => [...si.getElementsByTagName('t')].map((t) => t.textContent).join(''))
    : [];
  const sheet = parser.parseFromString(files[sheetName], 'application/xml');
  const rows = [];
  for (const rowEl of sheet.getElementsByTagName('row')) {
    const row = [];
    for (const c of rowEl.getElementsByTagName('c')) {
      const ref = c.getAttribute('r') || '';
      const col = colIndex(ref.replace(/\d+/g, '')) ?? row.length;
      const type = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      let value;
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = [...c.getElementsByTagName('t')].map((t) => t.textContent).join('');
      else if (type === 'str' || type === 'b' || type === 'e') value = v;
      else value = v === '' ? '' : Number(v);
      while (row.length < col) row.push('');
      row[col] = typeof value === 'string' ? value.trim() : value;
    }
    if (row.some((x) => x !== '')) rows.push(row);
  }
  return rows;
}

function colIndex(letters) {
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function unzip(buf, wanted) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('El .xlsx está dañado.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = {};
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = buf.subarray(start, start + csize);
    if (method === 0) out[name] = dec.decode(data);
    else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      out[name] = await new Response(stream).text();
    }
  }
  return out;
}

// ---------- Interpretación de valores chilenos ----------

export function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v || '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$\s]|CLP|US\$|USD/gi, '');
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    s = s.split(thousands).join('').replace(decimal, '.');
  } else if (lastDot >= 0) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  } else if (lastComma >= 0) {
    s = /^\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

const MONTHS = { ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, SEP: 9, SET: 9, OCT: 10, NOV: 11, DIC: 12 };
const pad = (n) => String(n).padStart(2, '0');

export function parseDate(v, today = new Date()) {
  if (typeof v === 'number') {
    // Número de serie de Excel (días desde 1899-12-30).
    if (v > 20000 && v < 80000) {
      const d = new Date(Math.round((v - 25569) * 86400000));
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    return null;
  }
  const s = normalize(v);
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return valid(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/))) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return valid(y, +m[2], +m[1]);
  }
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})$/))) return withInferredYear(+m[2], +m[1], today);
  if ((m = s.match(/^(\d{1,2})[\s/.-]*([A-Z]{3})[A-Z]*[\s/.-]*(\d{2,4})?/)) && MONTHS[m[2]]) {
    if (!m[3]) return withInferredYear(MONTHS[m[2]], +m[1], today);
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return valid(y, MONTHS[m[2]], +m[1]);
  }
  return null;
}

function valid(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

// Fechas sin año (ej. "15/10"): año actual, o el anterior si quedaría en el futuro.
function withInferredYear(mo, d, today) {
  let y = today.getFullYear();
  if (mo > today.getMonth() + 1) y--;
  return valid(y, mo, d);
}

// ---------- Detección de columnas ----------

const ROLE_PATTERNS = {
  date: /FECHA/,
  description: /DESCRIP|DETALLE|GLOSA|COMERCIO|CONCEPTO|MOVIMIENTO|TRANSACCI|NOMBRE|LUGAR/,
  debit: /CARGO|DEBITO|GIRO|EGRESO/,
  credit: /ABONO|CREDITO|DEPOSITO|INGRESO/,
  amount: /MONTO|IMPORTE|VALOR|TOTAL/,
};

export const ROLES = [
  ['ignore', '— ignorar —'],
  ['date', 'Fecha'],
  ['description', 'Descripción'],
  ['amount', 'Monto (con signo)'],
  ['debit', 'Cargo (gasto)'],
  ['credit', 'Abono (ingreso)'],
];

export function detectHeader(rows) {
  let best = { index: -1, score: 0 };
  rows.slice(0, 40).forEach((row, index) => {
    const cells = row.map((c) => normalize(c));
    let score = 0;
    if (cells.some((c) => ROLE_PATTERNS.date.test(c))) score += 2;
    if (cells.some((c) => ROLE_PATTERNS.description.test(c))) score += 2;
    if (cells.some((c) => ROLE_PATTERNS.debit.test(c) || ROLE_PATTERNS.amount.test(c))) score += 1;
    if (score > best.score) best = { index, score };
  });
  if (best.score < 4) return { headerIndex: -1, mapping: guessFromData(rows) };
  const header = rows[best.index].map((c) => normalize(c));
  const mapping = header.map(() => 'ignore');
  const take = (role, exclude = []) => {
    const i = header.findIndex((h, idx) => mapping[idx] === 'ignore' && ROLE_PATTERNS[role].test(h)
      && !exclude.some((r) => ROLE_PATTERNS[r].test(h)));
    if (i >= 0) mapping[i] = role;
    return i;
  };
  take('date');
  take('debit', ['credit']);
  take('credit', ['debit']);
  if (!mapping.includes('debit')) take('amount');
  take('description');
  return { headerIndex: best.index, mapping };
}

// Sin encabezado reconocible: deducir por contenido de las primeras filas.
function guessFromData(rows) {
  const sample = rows.slice(0, 20);
  const width = Math.max(...sample.map((r) => r.length), 0);
  const mapping = Array(width).fill('ignore');
  const ratio = (i, fn) => sample.filter((r) => fn(r[i])).length / (sample.length || 1);
  const dateCol = [...Array(width).keys()].find((i) => ratio(i, (v) => parseDate(v)) > 0.6);
  if (dateCol !== undefined) mapping[dateCol] = 'date';
  const textCol = [...Array(width).keys()].find((i) => mapping[i] === 'ignore'
    && ratio(i, (v) => typeof v === 'string' && /[A-Za-z]{3}/.test(v)) > 0.6);
  if (textCol !== undefined) mapping[textCol] = 'description';
  const numCol = [...Array(width).keys()].find((i) => mapping[i] === 'ignore' && ratio(i, (v) => parseAmount(v) !== null) > 0.6);
  if (numCol !== undefined) mapping[numCol] = 'amount';
  return mapping;
}

// Convierte filas en transacciones. `positiveIsExpense` sirve para estados de
// tarjeta de crédito, donde las compras aparecen con monto positivo.
export function rowsToTransactions(rows, { headerIndex, mapping, accountId, positiveIsExpense }) {
  const col = (role) => mapping.indexOf(role);
  const iDate = col('date');
  const iDesc = col('description');
  const iAmt = col('amount');
  const iDeb = col('debit');
  const iCred = col('credit');
  if (iDate < 0) throw new Error('Indica qué columna es la fecha.');
  if (iAmt < 0 && iDeb < 0 && iCred < 0) throw new Error('Indica la columna de monto, o las de cargo y abono.');
  const out = [];
  const seen = new Map();
  let skipped = 0;
  for (const row of rows.slice(headerIndex + 1)) {
    const date = parseDate(row[iDate]);
    if (!date) { skipped++; continue; }
    let amount = null;
    if (iAmt >= 0) {
      amount = parseAmount(row[iAmt]);
      if (amount !== null && positiveIsExpense) amount = -amount;
    } else {
      const deb = iDeb >= 0 ? parseAmount(row[iDeb]) : null;
      const cred = iCred >= 0 ? parseAmount(row[iCred]) : null;
      if (deb) amount = -Math.abs(deb);
      else if (cred) amount = Math.abs(cred);
    }
    if (amount === null || amount === 0) { skipped++; continue; }
    const description = String(iDesc >= 0 ? row[iDesc] ?? '' : '').trim() || '(sin descripción)';
    // Movimientos idénticos el mismo día se distinguen por orden de aparición,
    // así reimportar la misma cartola no duplica.
    const key = `${accountId}|${date}|${amount}|${normalize(description)}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    out.push({ id: `tx_${hash(`${key}|${n}`)}`, accountId, date, amount, description, source: 'import' });
  }
  return { transactions: out, skipped };
}
