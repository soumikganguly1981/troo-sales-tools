// Supplier names for Meter Capture. Troo's HubDB table supplier_code_map turns registry supplier
// codes (from Electralink / Xoserve) into Utility Click's supplier names; reps only pick from
// suppliers Troo trades with. If the table isn't there yet, the Meter's "Incumbent supplier"
// dropdown options are used, so the card still works.
const { readTable } = require('./hubdb');
const { propertyOptions } = require('./crm');

const TABLE = 'supplier_code_map';
let cache = null;

async function supplierMap(meterType) {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.value;
  let rows = [];
  let source = 'hubdb';
  try { rows = await readTable(TABLE); } catch { source = 'property'; }
  const options = meterType ? await propertyOptions(meterType, 'mc_current_supplier') : [];
  const byCode = {};
  for (const r of rows) {
    if (!r.code || !r.name) continue;
    for (const c of String(r.code).split(/[,\s]+/).filter(Boolean)) byCode[c.toUpperCase()] = { name: r.name, fuel: r.fuel || null };
  }
  let names = rows.filter((r) => r.name && r.trades_with !== false).map((r) => r.name);
  if (!names.length) { names = options; source = 'property'; }
  // a supplier can only be saved if it's an option on the Meter dropdown
  if (options.length) names = names.filter((n) => options.includes(n));
  const value = { names: [...new Set(names)].sort((a, b) => a.localeCompare(b)), byCode, source };
  cache = { at: Date.now(), value };
  return value;
}

module.exports = { supplierMap, TABLE };
