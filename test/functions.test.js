// App function tests with the HubSpot API mocked (global fetch), in HubDB v3 / CRM v3-v4 response shapes.
const test = require('node:test');
const assert = require('node:assert/strict');
const payload = require('./fixtures/stips-2026-11.json');

process.env.PRIVATE_APP_ACCESS_TOKEN = 'test-token';
const calls = [];
let routes = {};
global.fetch = async (url, opts = {}) => {
  const u = new URL(url); const key = `${opts.method || 'GET'} ${u.pathname}`;
  calls.push({ key, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.Authorization });
  const h = routes[key];
  const [status, body] = h ? h(opts.body ? JSON.parse(opts.body) : null, u) : [404, { message: 'not mocked ' + key }];
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
};
// HubDB v3 shapes: SELECT -> {id,name,type}, BOOLEAN -> 1/0, DATE -> epoch ms
for (const t of payload) {
  routes[`GET /cms/v3/hubdb/tables/${t.name}`] = () => [200, { name: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type })) }];
  routes[`GET /cms/v3/hubdb/tables/${t.name}/rows`] = () => [200, { results: t.rows.map((r, i) => ({ id: String(i + 1), values: Object.fromEntries(Object.entries(r).map(([k, v]) => {
    const col = t.columns.find((c) => c.name === k);
    if (col.type === 'SELECT') return [k, { id: 1, name: v, type: 'option' }];
    if (col.type === 'BOOLEAN') return [k, v ? 1 : 0];
    return [k, v];
  })) })) }];
}

test('stip_calculate reads HubDB and ranks', async () => {
  const { main } = require('../src/app/functions/stipCalculate');
  const start = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
  const r = await main({ parameters: { deal: { fuel: 'E', aq: 85000, start, term: 'max' } } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.stipMonth, '2026-11-01');
  assert.equal(r.body.considered, 18);
  assert.ok(r.body.available.length >= 10);
  assert.ok(r.body.available.every((x, i, a) => i === 0 || a[i - 1].total >= x.total));
  assert.ok(calls.every((c) => c.auth === 'Bearer test-token'));
});

test('stip_calculate rejects a missing fuel', async () => {
  const { main } = require('../src/app/functions/stipCalculate');
  assert.equal((await main({ parameters: { deal: {} } })).statusCode, 400);
});

test('stip_deal_context prefills from meters and CED', async () => {
  routes['GET /crm/v3/schemas'] = () => [200, { results: [{ name: 'meters', objectTypeId: '2-112673604' }, { name: 'sites', objectTypeId: '2-112673583' }] }];
  routes['GET /crm/v3/objects/deals/123'] = () => [200, { id: '123', properties: { dealname: 'Acme', ced_group_date: '2030-01-31', current_supplier: '' } }];
  routes['GET /crm/v4/objects/deals/123/associations/2-112673604'] = () => [200, { results: [{ toObjectId: 1 }, { toObjectId: 2 }, { toObjectId: 3 }] }];
  routes['POST /crm/v3/objects/2-112673604/batch/read'] = (b) => [207, { results: b.inputs.map(({ id }) => ({ id, properties: {
    1: { aq: '40000', utility: 'NHH', current_contract_supplier: 'Shell Energy' }, 2: { aq: '60000', utility: 'HH', current_contract_supplier: 'Shell Energy' }, 3: { aq: '10000', utility: 'Gas' } }[id] })) }];
  const { main } = require('../src/app/functions/stipDealContext');
  const r = await main({ parameters: { dealId: '123' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.fuel, 'E');
  assert.equal(r.body.aq, 100000);
  assert.equal(r.body.hh, 'yes');
  assert.equal(r.body.current, 'shell');
  assert.equal(r.body.start, '2030-02-01');
  assert.match(r.body.notes.join(' '), /2 electricity and 1 gas/);
});

test('stip_save_estimate patches only est_comms properties', async () => {
  let sent = null;
  routes['PATCH /crm/v3/objects/deals/123'] = (b) => { sent = b; return [200, { id: '123' }]; };
  const { main } = require('../src/app/functions/stipSaveEstimate');
  const r = await main({ parameters: { dealId: '123', supplier: 'Engie', product: '', comms: 4, term: 88, annual: 3400, total: 24933.333 } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(Object.keys(sent.properties).sort(), ['est_comms_annual', 'est_comms_calculated_at', 'est_comms_p_kwh', 'est_comms_product', 'est_comms_supplier', 'est_comms_term_months', 'est_comms_total']);
  assert.equal(sent.properties.est_comms_total, 24933.33);
  assert.equal((await main({ parameters: { dealId: 'abc', supplier: 'x' } })).statusCode, 400);
});

test('function bundles are self-contained (no relative requires)', () => {
  const fs = require('node:fs');
  for (const f of ['stipCalculate', 'stipDealContext', 'stipSaveEstimate']) {
    const code = fs.readFileSync(`${__dirname}/../src/app/functions/${f}.js`, 'utf8');
    assert.doesNotMatch(code, /require\(["']\.\.?\//, `${f}.js still requires a local file`);
  }
});
