// Reads the published stipulation tables from HubDB and normalises rows into plain objects.
const { api } = require('./http');

const TABLES = { products: 'stip_products', bands: 'stip_comms_bands', rules: 'stip_rules' };
const CACHE_MS = 5 * 60 * 1000; // warm function instances reuse the tables for 5 minutes
let cache = null;

const pad = (x) => String(x).padStart(2, '0');
function normaliseValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object' && !Array.isArray(v) && 'name' in v) return v.name; // SELECT option
  return v;
}
// columns: [{name, type}] ; DATE values arrive as epoch ms at UTC midnight
function normaliseRow(values, columns) {
  const out = {};
  for (const col of columns) {
    let v = normaliseValue(values[col.name]);
    if (v === null) { out[col.name] = null; continue; }
    if (col.type === 'DATE') { const d = new Date(Number(v)); v = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
    else if (col.type === 'BOOLEAN') v = v === true || v === 1 || v === '1' || v === 'true';
    else if (col.type === 'NUMBER') v = Number(v);
    out[col.name] = v;
  }
  return out;
}

async function readTable(name) {
  const meta = await api('GET', `/cms/v3/hubdb/tables/${name}`);
  if (meta.status !== 200) throw new Error(`HubDB table ${name}: ${meta.status} ${JSON.stringify(meta.body).slice(0, 200)}`);
  const columns = meta.body.columns.map((c) => ({ name: c.name, type: c.type }));
  const rows = []; let after = null;
  do {
    const r = await api('GET', `/cms/v3/hubdb/tables/${name}/rows?limit=1000${after ? `&after=${after}` : ''}`);
    if (r.status !== 200) throw new Error(`HubDB rows ${name}: ${r.status}`);
    rows.push(...r.body.results.map((x) => normaliseRow(x.values, columns)));
    after = r.body.paging?.next?.after || null;
  } while (after);
  return rows;
}

async function loadStipulations() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.tables;
  const [products, bands, rules] = await Promise.all(Object.values(TABLES).map(readTable));
  const months = products.map((p) => p.stip_month).filter(Boolean).sort();
  const tables = { products, bands, rules, stipMonth: months[months.length - 1] || null };
  cache = { at: Date.now(), tables };
  return tables;
}

module.exports = { loadStipulations, normaliseRow };
