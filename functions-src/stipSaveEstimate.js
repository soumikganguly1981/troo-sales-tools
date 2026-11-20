// app function uid: stip_save_estimate
// parameters: { dealId, supplier, product, comms, term, annual, total }
// Writes the chosen option to the est_comms_* Deal properties. Never touches `amount`.
const { api, ok, fail } = require('./lib/http');

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

exports.main = async (context) => {
  try {
    const p = context.parameters || {};
    const dealId = String(p.dealId || '');
    if (!/^\d+$/.test(dealId)) return fail(400, 'Missing deal ID');
    if (!p.supplier) return fail(400, 'Choose a supplier to save');
    const props = {
      est_comms_supplier: String(p.supplier).slice(0, 200),
      est_comms_product: String(p.product || '').slice(0, 200),
      est_comms_p_kwh: num(p.comms),
      est_comms_term_months: num(p.term),
      est_comms_annual: num(p.annual) == null ? null : Math.round(num(p.annual) * 100) / 100,
      est_comms_total: num(p.total) == null ? null : Math.round(num(p.total) * 100) / 100,
      est_comms_calculated_at: new Date().toISOString(),
    };
    const r = await api('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties: props });
    if (r.status !== 200) return fail(r.status, `Couldn't save to the deal (${r.status}): ${r.body?.message || ''}`);
    return ok({ saved: true, properties: props });
  } catch (e) {
    return fail(500, `Couldn't save to the deal: ${e.message}`);
  }
};
