// app function uid: mc_lookup
// parameters: { dealId, meters: [{ number, fuel }] }
// For each meter: is it already in HubSpot (it will be linked, not duplicated), and what does the
// registry say (Electralink for electricity, Xoserve for gas; supplier code turned into Troo's name).
const { ok, fail } = require('./lib/http');
const { objectTypes, searchIn } = require('./lib/crm');
const { supplierMap } = require('./lib/suppliers');
const { lookup } = require('./lib/registry');

const MAX = 150;

exports.main = async (context) => {
  try {
    const p = context.parameters || {};
    const meters = (Array.isArray(p.meters) ? p.meters : []).filter((m) => m && m.number).slice(0, MAX);
    if (!meters.length) return ok({ results: [] });
    const types = await objectTypes();
    const props = ['meter_number', 'bottom_line_meter_number__unique_identifier_', 'mc_current_supplier', 'current_supplier', 'contract_end_date', 'postcode'];
    const numbers = meters.map((m) => String(m.number));
    const found = [
      ...(await searchIn(types.meters, 'meter_number', numbers, props)),
      ...(await searchIn(types.meters, 'bottom_line_meter_number__unique_identifier_', numbers, props)),
    ];
    const byNumber = new Map();
    for (const f of found) {
      for (const n of [f.properties.meter_number, f.properties.bottom_line_meter_number__unique_identifier_]) {
        if (n && !byNumber.has(String(n).trim())) byNumber.set(String(n).trim(), f);
      }
    }
    const { byCode } = await supplierMap(types.meters);
    const results = [];
    for (const m of meters) {
      const existing = byNumber.get(String(m.number));
      const reg = await lookup(m);
      if (reg.status === 'ok' && reg.supplierCode) reg.supplierName = byCode[String(reg.supplierCode).toUpperCase()]?.name || null;
      results.push({
        number: String(m.number),
        existing: existing ? { id: existing.id, supplier: existing.properties.mc_current_supplier || existing.properties.current_supplier || null,
          ced: existing.properties.contract_end_date || null, postcode: existing.properties.postcode || null } : null,
        registry: reg,
      });
    }
    return ok({ results });
  } catch (e) {
    return fail(500, `Lookup failed: ${e.message}`);
  }
};
