// app function uid: mc_lookup
// parameters: { dealId, meters: [{ number, fuel, postcode? }] }  (the card sends up to 25 at a time)
// For each meter: is it already in HubSpot (it will be linked, not duplicated), and what does the
// registry say (Electralink for electricity, Xoserve for gas; supplier code turned into Troo's name).
const { ok, fail } = require('./lib/http');
const { api } = require('./lib/http');
const { objectTypes, searchIn, associatedIds, batchRead } = require('./lib/crm');
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

    // The customer's own addresses: company postcode and its Sites. The registry address is checked against these.
    const dealId = /^\d+$/.test(String(p.dealId || '')) ? String(p.dealId) : null;
    const companyIds = dealId ? await associatedIds('deals', dealId, 'companies') : [];
    const companyId = companyIds[0] || null;
    const known = [];
    if (companyId) {
      const c = await api('GET', `/crm/v3/objects/companies/${companyId}?properties=zip,name`);
      if (c.body?.properties?.zip) known.push(c.body.properties.zip);
      const siteIds = await associatedIds('companies', companyId, types.sites);
      for (const s of await batchRead(types.sites, siteIds, ['postal_code'])) if (s.properties.postal_code) known.push(s.properties.postal_code);
    }
    // Meters already in HubSpot under another company: never moved silently
    const existingIds = [...new Set(found.map((f) => f.id))];
    const owners = new Map();
    for (let i = 0; i < existingIds.length; i += 100) {
      const r = await api('POST', `/crm/v4/associations/${types.meters}/companies/batch/read`, { inputs: existingIds.slice(i, i + 100).map((id) => ({ id })) });
      for (const row of r.body?.results || []) owners.set(String(row.from?.id), (row.to || []).map((t) => String(t.toObjectId)));
    }
    const otherIds = [...new Set([...owners.values()].flat().filter((id) => id !== String(companyId)))];
    const names = new Map((await batchRead('companies', otherIds, ['name'])).map((c) => [String(c.id), c.properties.name || `Company ${c.id}`]));
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
        reg.companyCheck = !known.length ? 'unknown'
          : known.some((k) => ['match', 'same area'].includes(postcodeCheck(reg.postcode, k))) ? 'match' : 'elsewhere';
        reg.knownPostcodes = [...new Set(known.map((k) => String(k).toUpperCase()))].slice(0, 5);
      }
      const otherCompanies = existing ? (owners.get(String(existing.id)) || []).filter((id) => id !== String(companyId)).map((id) => names.get(id) || `Company ${id}`) : [];
      results.push({
        number: String(m.number),
        existing: existing ? { id: existing.id, supplier: existing.properties.mc_current_supplier || existing.properties.current_supplier || null,
          ced: existing.properties.contract_end_date || null, postcode: existing.properties.postcode || null,
          // pricing data already on the meter, used to fill gaps
          profile: (String(existing.properties.top_line_meter_number || '').replace(/\D/g, '').slice(0, 2)) || existing.properties.mp_profile_class || null,
          meterType: existing.properties.meter_type || null, annualKwh: Number(existing.properties.aq) || Number(existing.properties.consumption__kwh_) || null,
          ldz: existing.properties.mp_gas_ldz || null, kva: Number(existing.properties.kva) || null, voltage: existing.properties.mp_hh_voltage || null,
          otherCompanies } : null,
        registry: reg,
      });
    }
    return ok({ results });
  } catch (e) {
    return fail(500, `Lookup failed: ${e.message}`);
  }
};
