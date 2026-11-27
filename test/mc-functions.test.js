// Meter Capture functions with the HubSpot API mocked (global fetch). Object type IDs are
// deliberately not the live ones, to prove nothing is hard-coded to one account.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

process.env.PRIVATE_APP_ACCESS_TOKEN = 'test-token';
delete process.env.ANTHROPIC_API_KEY;
const METER = '2-900'; const SITE = '2-901';
const routes = {}; const calls = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const key = u.host === 'files.example' ? `FILE ${u.pathname}` : `${opts.method || 'GET'} ${u.pathname}`;
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ key, body });
  const h = routes[key];
  const [status, out, raw] = h ? h(body, u) : [404, { message: 'not mocked ' + key }];
  return { status, ok: status < 300, headers: { get: () => null }, text: async () => JSON.stringify(out),
    json: async () => out, arrayBuffer: async () => raw };
};
const sent = (key) => calls.filter((c) => c.key === key);

routes['GET /crm/v3/schemas'] = () => [200, { results: [{ name: 'meters', objectTypeId: METER, labels: {} }, { name: 'sites', objectTypeId: SITE, labels: {} }] }];
routes['GET /cms/v3/hubdb/tables/supplier_code_map'] = () => [404, {}];
routes[`GET /crm/v3/properties/${METER}/mc_current_supplier`] = () => [200, { options: ['British Gas', 'EDF Energy', 'Octopus Energy', 'Yu Energy'].map((v) => ({ value: v, label: v })) }];
const names = (list) => [200, { results: list.map((name) => ({ name })) }];
routes[`GET /crm/v3/properties/${METER}`] = () => names(['meter_number', 'bottom_line_meter_number__unique_identifier_', 'top_line_meter_number', 'utility', 'contract_end_date',
  'consumption__kwh_', 'aq', 'postcode', 'meter_type', 'mc_current_supplier', 'rates_unitdaynight_pence_per_kwh', 'rates_standing_charge__pday',
  'mcap_supplier_source', 'mcap_supplier_override_reason', 'mcap_capture_source', 'mcap_ced_to_confirm', 'mcap_captured_on', 'mcap_captured_by', 'mcap_capture_deal_id', 'mcap_rates_from',
  'mcap_missing', 'mp_profile_class', 'mp_gas_ldz', 'kva', 'mp_hh_voltage']);
routes[`GET /crm/v3/properties/${SITE}`] = () => names(['address', 'postal_code', 'site_name']);
routes['GET /crm/v3/properties/deals'] = () => [200, { results: ['dealname', 'pipeline', 'dealstage', 'hubspot_owner_id', 'lead_source', 'amount', 'ced_group_date',
  'mcap_status', 'mcap_draft', 'mcap_meter_count', 'mcap_total_kwh', 'mcap_completed_on', 'mcap_split_from_deal', 'mcap_split_group', 'mcap_data_complete', 'mcap_data_missing'].map((name) => ({ name, modificationMetadata: { readOnlyValue: false } })) }];
routes['GET /crm/v3/pipelines/deals'] = () => [200, { results: [{ id: 'default', label: 'Pre-Sales', stages: [{ id: 's1', label: 'LOA Signed' }, { id: 's9', label: 'Future Opportunity' }] }] }];
routes['GET /crm/v3/objects/deals/10'] = () => [200, { properties: { dealname: 'Riverside Bakery Ltd - LOA', pipeline: 'default', dealstage: 's1', mcap_status: 'Not started' } }];
routes['PATCH /crm/v3/objects/deals/10'] = () => [200, {}];
routes['POST /crm/v3/objects/deals/batch/read'] = () => [200, { results: [{ id: '10', properties: { dealname: 'Riverside Bakery Ltd - LOA', pipeline: 'default', dealstage: 's1',
  hubspot_owner_id: '77', lead_source: 'Web', amount: '5000', mcap_status: 'In progress' } }] }];
routes['GET /crm/v4/objects/deals/10/associations/companies'] = () => [200, { results: [{ toObjectId: 20 }] }];
routes['GET /crm/v4/objects/deals/10/associations/contacts'] = () => [200, { results: [{ toObjectId: 30 }] }];
routes['GET /crm/v4/objects/deals/10/associations/notes'] = () => [200, { results: [{ toObjectId: 40 }] }];
routes[`GET /crm/v4/objects/deals/10/associations/${METER}`] = () => [200, { results: [{ toObjectId: 501 }] }];
routes['GET /crm/v3/objects/companies/20'] = () => [200, { properties: { name: 'Riverside Bakery Ltd' } }];
routes[`GET /crm/v4/objects/companies/20/associations/${SITE}`] = () => [200, { results: [{ toObjectId: 601 }] }];
routes[`POST /crm/v3/objects/${SITE}/batch/read`] = () => [200, { results: [{ id: '601', properties: { address: '22 Market Street, Bradford', postal_code: 'BD1 1LA' } }] }];
// meter 1055566677785 is already in HubSpot (id 501) and on this deal
routes[`POST /crm/v3/objects/${METER}/search`] = (b) => [200, { results: b.filterGroups[0].filters[0].propertyName === 'meter_number' && b.filterGroups[0].filters[0].values.includes('1055566677785')
  ? [{ id: '501', properties: { meter_number: '1055566677785' } }] : [] }];
routes['POST /crm/v3/objects/deals/search'] = () => [200, { results: [] }];

const meters = [
  { number: '1012345678903', fuel: 'Elec', valid: true, ced: '2027-03-31', address: 'Riverside Bakery, Unit 4, Mill Lane, Leeds', postcode: 'LS11 5AB', annualKwh: 86120,
    rates: { day: 27.41, night: 19.87, standing_charge: 64.2 }, source: 'Bill', supplier: 'British Gas', included: true, profile: '03' },
  { number: '1098765432106', fuel: 'Elec', valid: true, ced: '2027-04-30', address: '22 Market Street, Bradford', postcode: 'BD1 1LA', annualKwh: 31400, source: 'Bill', profileClass: '00', kva: 80, voltage: 'Low voltage',
    supplier: 'Yu Energy', registrySupplier: 'Octopus Energy', overrideReason: 'Customer confirmed switch back', included: true },
  { number: '7465123809', fuel: 'Gas', valid: true, ced: '2027-04-30', address: '22 Market Street, Bradford', postcode: 'BD1 1LA', annualKwh: 52000, source: 'Photo', supplier: 'Yu Energy', included: true },
  { number: '1055566677785', fuel: 'Elec', valid: true, ced: '2027-11-30', address: 'Plot 9, Calder Park, Wakefield', postcode: 'WF2 7AA', annualKwh: 120300, source: 'Excel', supplier: 'E.ON Next', included: true },
];

test('mc_read reads the Excel template', async () => {
  const ws = XLSX.utils.aoa_to_sheet([['MPAN / MPRN', 'Fuel', 'Contract end date'], ['1012345678903', 'Electricity', '31/03/2027'], ['7465123809', 'Gas', '30/04/2027'], ['123', 'Gas', '']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Meters');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  routes['GET /files/v3/files/900/signed-url'] = () => [200, { url: 'https://files.example/m.xlsx', name: 'Riverside_meters', extension: 'xlsx', size: buf.length }];
  routes['FILE /m.xlsx'] = () => [200, {}, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)];
  const { main } = require('../src/app/functions/mcRead');
  const r = await main({ parameters: { dealId: '10', fileId: '900', mode: 'file' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.meters.map((m) => [m.number, m.fuel, m.ced]), [['1012345678903', 'Elec', '2027-03-31'], ['7465123809', 'Gas', '2027-04-30'], ['123', 'Gas', null]]);
  assert.ok(r.body.problems.some((p) => /Row 4/.test(p)));
  assert.equal(sent('PATCH /crm/v3/objects/deals/10')[0].body.properties.mcap_status, 'In progress');
});

test('mc_read explains bill reading is off without the key', async () => {
  routes['GET /files/v3/files/901/signed-url'] = () => [200, { url: 'https://files.example/b.pdf', name: 'bill', extension: 'pdf', size: 3 }];
  routes['FILE /b.pdf'] = () => [200, {}, new ArrayBuffer(3)];
  const { main } = require('../src/app/functions/mcRead');
  const r = await main({ parameters: { dealId: '10', fileId: '901', mode: 'file' } });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /ANTHROPIC_API_KEY/);
});

test('mc_context finds the deal, company, sites and suppliers without hard-coded IDs', async () => {
  const { main } = require('../src/app/functions/mcContext');
  const r = await main({ parameters: { dealId: '10' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.company.name, 'Riverside Bakery Ltd');
  assert.equal(r.body.sites[0].postcode, 'BD1 1LA');
  // the single supplier list (HubDB not set up in this mock, so the bundled copy)
  assert.ok(r.body.suppliers.length > 100 && r.body.suppliers.includes('Yu Energy'));
  assert.match(r.body.notes.join(' '), /built into the app/);
  assert.equal(r.body.features.billReading, false);
});

test('mc_commit preview shows the split without writing', async () => {
  calls.length = 0;
  const { main } = require('../src/app/functions/mcCommit');
  const r = await main({ parameters: { dealId: '10', meters, preview: true, today: '2026-11-26', by: 'J. Patel' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.groups.map((g) => [g.key, g.meters.length]), [['this', 2], ['gas', 1], ['future-elec-2027', 1]]);
  assert.equal(r.body.groups[2].stage, 'Future Opportunity');
  assert.equal(r.body.groups[1].dealName, 'Riverside Bakery Ltd - Gas');
  assert.deepEqual(r.body.sites, { new: 2, matched: 1, newList: r.body.sites.newList });
  assert.deepEqual(r.body.meters, { new: 3, existing: 1, unticked: 0 });
  assert.equal(calls.filter((c) => !c.key.startsWith('GET') && !/search|batch\/read/.test(c.key)).length, 0, 'preview must not write');
});

test('mc_commit refuses a changed registry supplier without a reason', async () => {
  const { main } = require('../src/app/functions/mcCommit');
  const r = await main({ parameters: { dealId: '10', meters: meters.map((m) => ({ ...m, overrideReason: '' })), today: '2026-11-26' } });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /reason/);
});

test('mc_commit writes Sites, Meters, split deals and links', async () => {
  calls.length = 0;
  let n = 700;
  routes[`POST /crm/v3/objects/${SITE}/batch/create`] = (b) => [201, { results: b.inputs.map(() => ({ id: String(n++) })) }];
  routes[`POST /crm/v3/objects/${METER}/batch/create`] = (b) => [201, { results: b.inputs.map(() => ({ id: String(n++) })) }];
  routes[`POST /crm/v3/objects/${METER}/batch/update`] = (b) => [200, { results: b.inputs }];
  routes['POST /crm/v3/objects/deals'] = () => [201, { id: String(n++) }];
  routes['POST /crm/v3/objects/notes'] = () => [201, { id: '999' }];
  for (const k of [`${SITE}/companies`, `${METER}/${SITE}`, `${METER}/companies`, 'deals/companies', 'deals/contacts', 'deals/notes', `deals/${METER}`, 'notes/deals']) {
    routes[`POST /crm/v4/associations/${k}/batch/associate/default`] = () => [200, {}];
  }
  routes[`POST /crm/v4/associations/deals/${METER}/batch/archive`] = () => [204, {}];
  for (let i = 700; i < 720; i++) routes[`PATCH /crm/v3/objects/deals/${i}`] = () => [200, {}];

  const { main } = require('../src/app/functions/mcCommit');
  const r = await main({ parameters: { dealId: '10', meters, today: '2026-11-26', by: 'J. Patel' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.meters, { created: 3, updated: 1, unticked: 0 });
  assert.equal(r.body.sites.created, 2);

  const siteCreate = sent(`POST /crm/v3/objects/${SITE}/batch/create`)[0].body.inputs;
  assert.deepEqual(siteCreate.map((s) => s.properties.postal_code).sort(), ['LS11 5AB', 'WF2 7AA']);
  const created = sent(`POST /crm/v3/objects/${METER}/batch/create`)[0].body.inputs.map((x) => x.properties);
  const leeds = created.find((p) => p.meter_number === '1012345678903');
  assert.equal(leeds.utility, 'NHH');
  assert.equal(leeds.meter_type, 'Economy 7');
  assert.equal(leeds.rates_unitdaynight_pence_per_kwh, 'D 27.41 N 19.87');
  assert.equal(leeds.mc_current_supplier, 'British Gas');
  assert.equal(leeds.mcap_ced_to_confirm, 'false');
  const bradford = created.find((p) => p.meter_number === '1098765432106');
  assert.equal(bradford.mcap_supplier_source, 'Rep override');
  assert.equal(bradford.mcap_supplier_override_reason, 'Customer confirmed switch back');
  assert.equal(created.find((p) => p.meter_number === '7465123809').utility, 'Gas');
  // E.ON Next isn't a dropdown option, so it isn't written to the dropdown
  assert.equal(sent(`POST /crm/v3/objects/${METER}/batch/update`)[0].body.inputs[0].properties.mc_current_supplier, undefined);

  const newDeals = sent('POST /crm/v3/objects/deals').map((c) => c.body.properties);
  assert.deepEqual(newDeals.map((d) => [d.dealname, d.dealstage, d.mcap_split_group]),
    [['Riverside Bakery Ltd - Gas', 's1', 'gas'], ['Riverside Bakery Ltd - Electricity · CED 2027', 's9', 'future-elec-2027']]);
  assert.equal(newDeals[0].lead_source, 'Web');
  assert.equal(newDeals[0].hubspot_owner_id, '77');
  assert.equal(newDeals[0].amount, undefined, 'amount is not copied');
  assert.equal(sent('POST /crm/v4/associations/deals/notes/batch/associate/default').length, 2, 'notes copied to both split deals');

  assert.equal(leeds.mp_profile_class, '03');
  assert.equal(leeds.mcap_missing, '');
  assert.equal(bradford.utility, 'HH');
  assert.equal(bradford.kva, 80);
  assert.equal(bradford.meter_type, undefined);
  assert.equal(created.find((p) => p.meter_number === '7465123809').mcap_missing, 'gas zone (LDZ)');
  assert.deepEqual(r.body.deals.map((d) => d.dataComplete), [true, false, false]);
  const roll = sent('PATCH /crm/v3/objects/deals/10').pop().body.properties;
  assert.equal(roll.mcap_meter_count, 2);
  assert.equal(roll.mcap_total_kwh, 117520);
  assert.equal(roll.ced_group_date, '2027-03-31');
  assert.equal(roll.mcap_status, 'Complete');
  assert.equal(roll.mcap_data_complete, 'true');
  assert.equal(roll.mcap_data_missing, '');
  // the Wakefield meter was on this deal and moved to the future deal
  assert.deepEqual(sent(`POST /crm/v4/associations/deals/${METER}/batch/archive`)[0].body.inputs, [{ from: { id: '10' }, to: [{ id: '501' }] }]);
  assert.match(sent('POST /crm/v3/objects/notes')[0].body.properties.hs_note_body, /No Contract records/);
});

test('lookup: registry address checked against the customer; meter owned elsewhere is flagged', async () => {
  const env = { ELECTRALINK_NHH_KEY: 'k', ELECTRALINK_NHH_PASSWORD: 'p' };
  Object.assign(process.env, env);
  const saved = { ...routes };
  routes['GET /crm/v3/objects/companies/20'] = () => [200, { properties: { name: 'Riverside Bakery Ltd', zip: 'LS11 5AB' } }];
  routes[`POST /crm/v4/associations/${METER}/companies/batch/read`] = () => [200, { results: [{ from: { id: '501' }, to: [{ toObjectId: 77 }] }] }];
  routes['POST /crm/v3/objects/companies/batch/read'] = () => [200, { results: [{ id: '77', properties: { name: 'Other Farm Ltd' } }] }];
  const where = { '1411333991005': 'B98 9HE', '1100011559224': 'BD1 1LA', '1055566677785': 'LS11 5AB' };
  routes['GET /v1/eac'] = (b, u) => [200, { post_code: where[u.searchParams.get('mpan')], supplier_id: 'KENS', metering_point_address_line_1: 'X' }];
  try {
    const { main } = require('../src/app/functions/mcLookup');
    const r = await main({ parameters: { dealId: '10', meters: [
      { number: '1411333991005', fuel: 'Electricity' },            // Corona site, nothing to do with this customer
      { number: '1100011559224', fuel: 'Electricity' },            // at the company's Bradford Site
      { number: '1055566677785', fuel: 'Electricity' },            // at the company postcode, but owned by another company
    ] } });
    const by = Object.fromEntries(r.body.results.map((x) => [x.number, x]));
    assert.equal(by['1411333991005'].registry.companyCheck, 'elsewhere');
    assert.equal(by['1100011559224'].registry.companyCheck, 'match');
    assert.equal(by['1055566677785'].registry.companyCheck, 'match');
    assert.deepEqual(by['1055566677785'].existing.otherCompanies, ['Other Farm Ltd']);
    const { ownerCheckNeeded } = require('../functions-src/lib/meters');
    const asMeter = (x) => ({ registryPostcode: x.registry.postcode, registryCheck: x.registry.postcodeCheck, companyCheck: x.registry.companyCheck, otherCompanies: x.existing?.otherCompanies || [] });
    assert.equal(ownerCheckNeeded(asMeter(by['1411333991005'])), true);
    assert.equal(ownerCheckNeeded(asMeter(by['1100011559224'])), false);
    assert.equal(ownerCheckNeeded(asMeter(by['1055566677785'])), true);
    assert.equal(ownerCheckNeeded({ registryPostcode: 'B98 9HE', registryCheck: 'match' }), false, 'bill postcode matching the registry is enough');
    assert.equal(ownerCheckNeeded({ number: '1', companyCheck: null }), false, 'no registry: the rep typed the address');
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    for (const k of Object.keys(routes)) if (!(k in saved)) delete routes[k];
    Object.assign(routes, saved);
  }
});

test('commit refuses a meter that needs the ownership tick', async () => {
  const { main } = require('../src/app/functions/mcCommit');
  const r = await main({ parameters: { dealId: '10', meters: [{ number: '1411333991005', fuel: 'Electricity', valid: true, supplier: 'EDF Energy', ced: '2027-03-31',
    registryPostcode: 'B98 9HE', registryCheck: 'missing', companyCheck: 'elsewhere' }] } });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message || r.body.error || JSON.stringify(r.body), /belongs to this customer/);
});
