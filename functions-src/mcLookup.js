// app function uid: mc_lookup
// parameters: { dealId, meters: [{ number, fuel, postcode? }] }  (the card sends up to 25 at a time)
// For each meter: is it already in HubSpot (it will be linked, not duplicated), and what does the
// registry say (Electralink for electricity, Xoserve for gas; supplier code turned into Troo's name).
const { ok, fail } = require('./lib/http');
const { objectTypes, searchIn } = require('./lib/crm');
const { supplierMap } = require('./lib/suppliers');
const { lookup } = require('./lib/registry');
const { postcodeCheck } = require('./lib/meters');

const MAX = 50;
const PARALLEL = 8; // registry calls take ~0.5 s each; 50 meters finish in a few seconds

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

exports.main = async (context) => {
  try {
    const p = context.parameters || {};
    const meters = (Array.isArray(p.meters) ? p.meters : []).filter((m) => m && m.number).slice(0, MAX);
    if (!meters.length) return ok({ results: [] });
    const types = await objectTypes();
    const props = ['meter_number', 'bottom_line_meter_number__unique_identifier_', 'mc_current_supplier', 'current_supplier', 'contract_end_date', 'postcode',
      'top_line_meter_number', 'mp_profile_class', 'meter_type', 'aq', 'consumption__kwh_', 'mp_gas_ldz', 'kva', 'mp_hh_voltage'];
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
    const { byCode } = await supplierMap();
    const regs = await mapLimit(meters, PARALLEL, (m) => lookup(m));
    const results = [];
    for (const [i, m] of meters.entries()) {
      const existing = byNumber.get(String(m.number));
      const reg = regs[i];
      if (reg.status === 'ok') {
        // Troo's name for the supplier comes from the single supplier list; Xoserve's own name is kept as a hint
        reg.registryName = reg.supplierName || null;
        reg.supplierName = reg.supplierCode ? byCode[String(reg.supplierCode).toUpperCase()]?.name || null : null;
        reg.postcodeCheck = postcodeCheck(reg.postcode, m.postcode || existing?.properties.postcode);
      }
      results.push({
        number: String(m.number),
        existing: existing ? { id: existing.id, supplier: existing.properties.mc_current_supplier || existing.properties.current_supplier || null,
          ced: existing.properties.contract_end_date || null, postcode: existing.properties.postcode || null,
          // pricing data already on the meter, used to fill gaps
          profile: (String(existing.properties.top_line_meter_number || '').replace(/\D/g, '').slice(0, 2)) || existing.properties.mp_profile_class || null,
          meterType: existing.properties.meter_type || null, annualKwh: Number(existing.properties.aq) || Number(existing.properties.consumption__kwh_) || null,
          ldz: existing.properties.mp_gas_ldz || null, kva: Number(existing.properties.kva) || null, voltage: existing.properties.mp_hh_voltage || null } : null,
        registry: reg,
      });
    }
    return ok({ results });
  } catch (e) {
    return fail(500, `Lookup failed: ${e.message}`);
  }
};
