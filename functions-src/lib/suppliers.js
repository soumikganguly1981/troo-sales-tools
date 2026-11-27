// Troo's single supplier list. One row per supplier, named as in Utility Click.
// The master copy is the HubDB table supplier_code_map (Kieran / Pricing keep it up to date). It is
// seeded from hubdb/suppliers.csv, which is also bundled here as the fallback when HubDB can't be read.
// Every app resolves supplier names and codes through this list:
//  - Meter Capture: registry codes (Electralink / Xoserve) and bill wording -> name; the Meter's
//    "Incumbent supplier" dropdown holds every name
//  - Pricing: price-book file codes -> name; the deal's "Accepted supplier" dropdown holds the
//    suppliers Troo trades with
//  - Revenue calculator: name -> stipulation supplier group
let CSV_TEXT;
try { CSV_TEXT = require('../../hubdb/suppliers.csv'); } // bundled as text by scripts/build-functions.mjs
catch { CSV_TEXT = require('fs').readFileSync(require('path').join(__dirname, '../../hubdb/suppliers.csv'), 'utf8'); }

const TABLE = 'supplier_code_map';
const CACHE_MS = 10 * 60 * 1000;
let cache = null;

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

const list = (v) => String(v || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
function normalise(r) {
  return {
    name: String(r.name || '').trim(),
    tradesWith: r.trades_with === true || r.trades_with === 1 || String(r.trades_with).toLowerCase() === 'true',
    stipsGroup: String(r.stips_group || '').trim() || null,
    pricebookCodes: list(r.pricebook_codes).map((c) => c.toUpperCase()),
    registryCodes: list(r.registry_codes || r.code).map((c) => c.toUpperCase()),
    aliases: list(r.aliases),
    tier: String(r.tier || '').trim() || null,
  };
}

const bundled = () => parseCsv(CSV_TEXT).map(normalise).filter((r) => r.name);

// Bill or legacy wording ("British Gas Business", "EDF Energy Customers Ltd") -> a comparable key
const key = (s) => String(s || '').toLowerCase().replace(/\b(ltd|limited|plc|uk|business|customers|trading|retail|supply|the)\b/g, '').replace(/[^a-z0-9]/g, '');

function index(rows) {
  const exact = new Map(); const keyed = new Map(); const byRegistry = {}; const byPricebook = {};
  for (const r of rows) {
    for (const n of [r.name, ...r.aliases]) {
      if (!exact.has(n.toLowerCase())) exact.set(n.toLowerCase(), r);
      if (key(n) && !keyed.has(key(n))) keyed.set(key(n), r);
    }
    for (const c of r.registryCodes) byRegistry[c] = r;
    for (const c of r.pricebookCodes) byPricebook[c] = r;
  }
  // any wording -> the supplier row, or null
  const resolve = (text) => {
    if (!text) return null;
    const t = String(text).trim();
    const k = key(t);
    if (exact.has(t.toLowerCase())) return exact.get(t.toLowerCase());
    if (k && keyed.has(k)) return keyed.get(k);
    if (k.length < 3) return null;
    // "Yu Energy Retail Limited" -> Yu Energy: longest name whose key starts the text's key
    let best = null;
    for (const [kk, r] of keyed) if (kk.length >= 3 && k.startsWith(kk) && (!best || kk.length > best[0].length)) best = [kk, r];
    return best ? best[1] : null;
  };
  return { resolve, byRegistry, byPricebook };
}

function build(rows, source) {
  const ix = index(rows);
  const names = [...new Set(rows.map((r) => r.name))].sort((a, b) => a.localeCompare(b));
  return {
    rows, source, names,
    tradesWith: names.filter((n) => rows.find((r) => r.name === n).tradesWith),
    resolve: ix.resolve,
    fromRegistryCode: (c) => ix.byRegistry[String(c || '').toUpperCase()] || null,
    fromPricebookCode: (c) => ix.byPricebook[String(c || '').toUpperCase()] || null,
    stipsGroup: (text) => (ix.resolve(text) || {}).stipsGroup || '',
  };
}

// The list from HubDB (the master), or the bundled copy if HubDB can't be read.
async function loadSuppliers() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value;
  try {
    const { readTable } = require('./hubdb');
    const rows = (await readTable(TABLE)).map(normalise).filter((r) => r.name);
    value = rows.length ? build(rows, 'hubdb') : build(bundled(), 'bundled');
  } catch { value = build(bundled(), 'bundled'); }
  cache = { at: Date.now(), value };
  return value;
}

// Meter Capture's view: every supplier for the incumbent (a customer can be with anyone).
async function supplierMap() {
  const s = await loadSuppliers();
  const byCode = {};
  for (const r of s.rows) for (const c of r.registryCodes) byCode[c] = { name: r.name };
  return { names: s.names, tradesWith: s.tradesWith, byCode, resolve: s.resolve, source: s.source };
}

module.exports = { TABLE, loadSuppliers, supplierMap, parseCsv, bundledSuppliers: () => build(bundled(), 'bundled') };
