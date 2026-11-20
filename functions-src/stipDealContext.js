// app function uid: stip_deal_context
// parameters: { dealId }
// Prefills the calculator from the deal: fuel and AQ from associated Meters, start date from the CED,
// current supplier from the Meter's current contract supplier.
const { api, ok, fail } = require('./lib/http');

const METER = '2-112673604';
const ELEC = new Set(['HH', 'NHH', 'Half Hourly Electric', 'Non Half Hourly Electric']);
const HH = new Set(['HH', 'Half Hourly Electric']);
const GROUPS = [
  [/^(bg|bgb|bg lite|bg plus|british gas)\b/i, 'bg'],
  [/^corona/i, 'corona'],
  [/^crown/i, 'crown'],
  [/^drax/i, 'drax'],
  [/^edf/i, 'edf'],
  [/^engie/i, 'engie'],
  [/^npower/i, 'npower'],
  [/^shell/i, 'shell'],
  [/^smartest/i, 'smartest'],
  [/^total/i, 'total'],
];
const groupOf = (s) => { if (!s) return ''; const g = GROUPS.find(([re]) => re.test(String(s).trim())); return g ? g[1] : ''; };
const addDay = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

exports.main = async (context) => {
  try {
    const dealId = String((context.parameters && context.parameters.dealId) || '');
    if (!/^\d+$/.test(dealId)) return fail(400, 'Missing deal ID');

    const deal = await api('GET', `/crm/v3/objects/deals/${dealId}?properties=dealname,ced_group_date,current_supplier,utility_primary,est_comms_supplier,est_comms_product,est_comms_total,est_comms_calculated_at`);
    if (deal.status !== 200) return fail(deal.status, `Couldn't read the deal (${deal.status})`);
    const dp = deal.body.properties || {};

    const ids = []; let after = null;
    do {
      const a = await api('GET', `/crm/v4/objects/deals/${dealId}/associations/${METER}?limit=500${after ? `&after=${after}` : ''}`);
      if (a.status !== 200) break;
      ids.push(...(a.body.results || []).map((x) => String(x.toObjectId)));
      after = a.body.paging?.next?.after || null;
    } while (after);

    const meters = [];
    for (let i = 0; i < ids.length; i += 100) {
      const b = await api('POST', `/crm/v3/objects/${METER}/batch/read`, {
        properties: ['aq', 'consumption__kwh_', 'utility', 'current_contract_supplier', 'current_supplier'],
        inputs: ids.slice(i, i + 100).map((id) => ({ id })),
      });
      if (b.status === 200) meters.push(...(b.body.results || []).map((m) => m.properties));
    }

    const elec = meters.filter((m) => ELEC.has(m.utility));
    const gas = meters.filter((m) => m.utility === 'Gas');
    const fuel = gas.length > elec.length ? 'G' : elec.length ? 'E' : dp.utility_primary === 'Gas' ? 'G' : 'E';
    const pool = fuel === 'G' ? gas : elec;
    const aqOf = (m) => Number(m.aq) || Number(m.consumption__kwh_) || 0;
    const aq = Math.round(pool.reduce((s, m) => s + aqOf(m), 0));
    const missingAq = pool.filter((m) => !aqOf(m)).length;
    const hh = fuel === 'G' || !pool.length ? 'unsure' : pool.some((m) => HH.has(m.utility)) ? 'yes' : 'no';
    const supplierText = pool.map((m) => m.current_contract_supplier || m.current_supplier).find(Boolean) || dp.current_supplier || '';

    const today = new Date().toISOString().slice(0, 10);
    const ced = dp.ced_group_date ? String(dp.ced_group_date).slice(0, 10) : null;
    const start = ced && addDay(ced) >= today ? addDay(ced) : null;

    const notes = [];
    if (!meters.length) notes.push('No meters are linked to this deal, so consumption and fuel need entering by hand.');
    if (elec.length && gas.length) notes.push(`This deal has ${elec.length} electricity and ${gas.length} gas meters. Showing ${fuel === 'G' ? 'gas' : 'electricity'}; switch fuel to check the other.`);
    if (missingAq) notes.push(`${missingAq} meter${missingAq === 1 ? ' has' : 's have'} no AQ, so the total may be low.`);
    if (ced && !start) notes.push('The CED has passed, so pick a start date.');
    if (supplierText && !groupOf(supplierText)) notes.push(`Current supplier "${supplierText}" isn't on the stipulation sheet, so it's treated as new business.`);

    return ok({
      dealName: dp.dealname || '',
      fuel,
      aq: aq || null,
      start,
      ced,
      hh,
      current: groupOf(supplierText),
      currentSupplierText: supplierText,
      meterCount: { electricity: elec.length, gas: gas.length },
      saved: dp.est_comms_supplier ? { supplier: dp.est_comms_supplier, product: dp.est_comms_product, total: Number(dp.est_comms_total) || null, at: dp.est_comms_calculated_at } : null,
      notes,
    });
  } catch (e) {
    return fail(500, `Couldn't read the deal: ${e.message}`);
  }
};
