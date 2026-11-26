// app function uid: mc_context
// parameters: { dealId, action?: 'get' | 'saveDraft', draft? }
// Everything the Meter Capture card needs to start: the deal and its company, the company's Sites,
// the supplier list, which parts are switched on (bill reading, Electralink, Xoserve), and any
// draft saved earlier so a rep can pick up where they left off.
const { api, ok, fail } = require('./lib/http');
const { objectTypes, associatedIds, batchRead } = require('./lib/crm');
const { supplierMap } = require('./lib/suppliers');
const billreader = require('./lib/billreader');
const registry = require('./lib/registry');

const MAX_DRAFT = 60000;

exports.main = async (context) => {
  try {
    const p = context.parameters || {};
    const dealId = String(p.dealId || '');
    if (!/^\d+$/.test(dealId)) return fail(400, 'Missing deal ID');

    if (p.action === 'saveDraft') {
      const text = p.draft ? JSON.stringify(p.draft) : '';
      if (text.length > MAX_DRAFT) return fail(400, 'Too many meters to keep as a draft; finish the capture in one go');
      const r = await api('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties: { mcap_draft: text, ...(text ? { mcap_status: 'In progress' } : {}) } });
      if (r.status !== 200) return fail(r.status, `Couldn't save the draft (${r.status}): ${r.body.message || ''}`);
      return ok({ saved: true });
    }

    const types = await objectTypes();
    const deal = await api('GET', `/crm/v3/objects/deals/${dealId}?properties=dealname,pipeline,dealstage,hubspot_owner_id,mcap_status,mcap_draft,mcap_split_from_deal,mcap_completed_on`);
    if (deal.status !== 200) return fail(deal.status, `Couldn't read the deal (${deal.status})`);
    const dp = deal.body.properties || {};

    const companyIds = await associatedIds('deals', dealId, 'companies');
    let company = null;
    let sites = [];
    if (companyIds.length) {
      const c = await api('GET', `/crm/v3/objects/companies/${companyIds[0]}?properties=name`);
      company = { id: companyIds[0], name: c.body?.properties?.name || '' };
      const siteIds = await associatedIds('companies', company.id, types.sites);
      sites = (await batchRead(types.sites, siteIds, ['address', 'postal_code', 'site_name']))
        .map((s) => ({ id: s.id, name: s.properties.site_name || '', address: s.properties.address || '', postcode: s.properties.postal_code || '' }));
    }
    const meterIds = await associatedIds('deals', dealId, types.meters);
    const suppliers = await supplierMap(types.meters);

    let draft = null;
    try { draft = dp.mcap_draft ? JSON.parse(dp.mcap_draft) : null; } catch { draft = null; }

    const notes = [];
    if (!company) notes.push('This deal has no company. Link the company first: Sites and Meters are saved to it.');
    if (companyIds.length > 1) notes.push(`This deal has ${companyIds.length} companies; Sites and Meters go to the first one (${company.name}).`);
    if (suppliers.source === 'property') notes.push('The supplier code table (HubDB supplier_code_map) is not set up here yet; the supplier list comes from the Meter dropdown.');

    return ok({
      deal: { id: dealId, name: dp.dealname || '', pipeline: dp.pipeline, stage: dp.dealstage, owner: dp.hubspot_owner_id || null,
        status: dp.mcap_status || 'Not started', splitFrom: dp.mcap_split_from_deal || null, completedOn: dp.mcap_completed_on || null },
      company, sites, meterCount: meterIds.length,
      suppliers: suppliers.names,
      features: { billReading: billreader.configured(), electralink: registry.electralinkConnected(), xoserve: registry.xoserveConnected() },
      draft, notes,
    });
  } catch (e) {
    return fail(500, `Couldn't start Meter Capture: ${e.message}`);
  }
};
