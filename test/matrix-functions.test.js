// matrix_deal_context and matrix_price with the HubSpot API mocked (global fetch).
const test = require('node:test');
const assert = require('node:assert/strict');
const stips = require('./fixtures/stips-2026-11.json');

process.env.PRIVATE_APP_ACCESS_TOKEN = 'test-token';
const routes = {};
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const key = u.host === 'files.example' ? `FILE ${u.pathname}` : `${opts.method || 'GET'} ${u.pathname}`;
  const h = routes[key];
  const [status, body] = h ? h(opts.body ? JSON.parse(opts.body) : null, u) : [404, { message: 'not mocked ' + key }];
  return { status, ok: status < 300, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body };
};
for (const t of stips) {
  routes[`GET /cms/v3/hubdb/tables/${t.name}`] = () => [200, { columns: t.columns.map((c) => ({ name: c.name, type: c.type })) }];
  routes[`GET /cms/v3/hubdb/tables/${t.name}/rows`] = () => [200, { results: t.rows.map((r, i) => ({ id: String(i), values: Object.fromEntries(Object.entries(r).map(([k, v]) => {
    const col = t.columns.find((c) => c.name === k);
    return [k, col.type === 'SELECT' ? { name: v } : col.type === 'BOOLEAN' ? (v ? 1 : 0) : v];
  })) })) }];
}
const COLS = ['book_id', 'supplier', 'fuel', 'region', 'contract_type', 'valid_from', 'quote_by', 'status'];
routes['GET /cms/v3/hubdb/tables/price_books'] = () => [200, { columns: COLS.map((name) => ({ name, type: 'TEXT' })) }];
routes['GET /cms/v3/hubdb/tables/price_books/rows'] = () => [200, { results: [
  { id: '1', values: { book_id: '111', supplier: 'Yu Energy', fuel: 'E', region: '20', contract_type: 'ACQ', quote_by: '2099-12-15', status: 'live' } },
  { id: '2', values: { book_id: '222', supplier: 'Yu Energy', fuel: 'E', region: '20', contract_type: 'ACQ', quote_by: '2099-12-15', status: 'superseded' } },
] }];
routes['GET /files/v3/files/111/signed-url'] = () => [200, { url: 'https://files.example/book111.json' }];
routes['FILE /book111.json'] = () => [200, {
  meta: { supplier: 'Yu Energy', contract_type: 'ACQ', fuel: 'E', region: '20', quote_by: '2099-12-15' },
  cols: ['product', 'rate_type', 'profile', 'band', 'aq_min', 'aq_max', 'term', 'start_from', 'start_to', 'unit', 'sc_p_day'],
  rows: [['Fix Energy Plan', 'single', '03', '1', 10000, 25999, 36, '2099-03-01', '2099-03-31', 23.097, 78.53]],
}];

test('matrix_deal_context returns priceable meters and live books', async () => {
  routes['GET /crm/v3/objects/deals/5'] = () => [200, { properties: { dealname: 'Acme', ced_group_date: '2099-03-09' } }];
  routes['GET /crm/v4/objects/deals/5/associations/2-112673604'] = () => [200, { results: [{ toObjectId: 7 }] }];
  routes['POST /crm/v3/objects/2-112673604/batch/read'] = () => [207, { results: [{ id: '7', properties: { utility: 'NHH', meter_number: '2000012345678', top_line_meter_number: '03 801', meter_type: 'Standard', aq: '16151', mp_band: '1' } }] }];
  const { main } = require('../src/app/functions/matrixDealContext');
  const r = await main({ parameters: { dealId: '5' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.meters[0].region, '20');
  assert.equal(r.body.meters[0].start, '2099-03-10');
  assert.deepEqual(r.body.books.map((b) => b.supplier), ['Yu Energy']);
});

test('matrix_price prices a meter from the live book only', async () => {
  const { main } = require('../src/app/functions/matrixPrice');
  const meter = { id: '7', fuel: 'E', region: '20', profile: '03', rateType: 'single', band: '1', aq: 16151, start: '2099-03-10' };
  const r = await main({ parameters: { meters: [meter], terms: [36], commission: { 'Yu Energy': 1 } } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const o = r.body.results[0].options[0];
  assert.equal(o.supplier, 'Yu Energy');
  assert.equal(Math.round(o.annual), 4179);
});

test('matrix_price asks for missing details instead of guessing', async () => {
  const { main } = require('../src/app/functions/matrixPrice');
  const r = await main({ parameters: { meters: [{ id: '8', fuel: 'G', region: null, aq: 0, start: null }] } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.results[0].errors.length, 3);
});
