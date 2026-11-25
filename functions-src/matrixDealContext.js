// app function uid: matrix_deal_context
// parameters: { dealId }
// The deal's meters with what the matrix engine needs (region, profile class, rate type, usage,
// band, start date), what's missing for each, and which suppliers have live price books.
const { api, ok, fail } = require('./lib/http');
const { meterFromProps } = require('./lib/matrix');
const { summary } = require('./lib/pricebooks');
const { FAMILY } = require('./lib/families');

const METER = '2-112673604';
const PROPS = ['utility', 'meter_number', 'bottom_line_meter_number__unique_identifier_', 'top_line_meter_number', 'meter_type', 'aq',
  'consumption__kwh_', 'latest_end_date', 'kva', 'mc_current_supplier', 'current_contract_supplier',
  'mp_band', 'mp_day_share_pct', 'mp_hh_voltage', 'mp_metering', 'mp_gas_ldz', 'mp_gas_exit_zone'];
const addDay = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

exports.main = async (context) => {
  try {
    const dealId = String((context.parameters && context.parameters.dealId) || '');
    if (!/^\d+$/.test(dealId)) return fail(400, 'Missing deal ID');
    const deal = await api('GET', `/crm/v3/objects/deals/${dealId}?properties=dealname,ced_group_date`);
    if (deal.status !== 200) return fail(deal.status, `Couldn't read the deal (${deal.status})`);
    const dp = deal.body.properties || {};
    const ced = dp.ced_group_date ? String(dp.ced_group_date).slice(0, 10) : null;

    const ids = []; let after = null;
    do {
      const a = await api('GET', `/crm/v4/objects/deals/${dealId}/associations/${METER}?limit=500${after ? `&after=${after}` : ''}`);
      if (a.status !== 200) break;
      ids.push(...(a.body.results || []).map((x) => String(x.toObjectId)));
      after = a.body.paging?.next?.after || null;
    } while (after);

    const meters = [];
    for (let i = 0; i < ids.length; i += 100) {
      const b = await api('POST', `/crm/v3/objects/${METER}/batch/read`, { properties: PROPS, inputs: ids.slice(i, i + 100).map((id) => ({ id })) });
      if (b.status === 200) meters.push(...(b.body.results || []).map((m) => meterFromProps(m.id, m.properties, ced ? addDay(ced) : null)));
    }
    const priceable = meters.filter((m) => ['E', 'G', 'HH'].includes(m.fuel));

    let books = [];
    let booksError = null;
    try { books = await summary(); } catch (e) { booksError = `Couldn't read the price book index: ${e.message}`; }

    const notes = [];
    if (!priceable.length) notes.push('No electricity or gas meters are linked to this deal.');
    if (!books.length && !booksError) notes.push('No price books are loaded yet. The Pricing team adds them to the Price books folder.');
    // suppliers with a stipulation get the maximum commission when the field is left blank
    const stipulated = [...new Set(books.map((b) => b.supplier))].filter((s) => FAMILY[s]);
    return ok({ dealName: dp.dealname || '', ced, meters: priceable, books, stipulated, booksError, notes });
  } catch (e) {
    return fail(500, `Couldn't read the deal: ${e.message}`);
  }
};
