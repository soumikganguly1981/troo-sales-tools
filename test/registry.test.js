// Electralink and Xoserve lookups with fetch mocked. Shapes follow the 20 Nov lookup test
// (meter_lookup_test.py) and Troo's "Testing Meter Data Locally" guide.
const test = require('node:test');
const assert = require('node:assert/strict');

const ENV = { ELECTRALINK_NHH_KEY: 'k', ELECTRALINK_NHH_PASSWORD: 'p', XOSERVE_CLIENT_ID: 'id', XOSERVE_CLIENT_SECRET: 's',
  XOSERVE_SCOPE: 'sc', XOSERVE_TOKEN_URL: 'https://login.example/token', XOSERVE_API_KEY: 'xk' };
const calls = [];
let routes = {};
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  calls.push({ url: u, opts });
  const h = routes[`${opts.method || 'GET'} ${u.host}${u.pathname}`];
  const [status, body] = h ? h(u, opts) : [500, { message: 'not mocked' }];
  return { status, text: async () => (body == null ? '' : JSON.stringify(body)) };
};
const reg = require('../functions-src/lib/registry');
const { postcodeCheck } = require('../functions-src/lib/meters');
const setEnv = (on) => { for (const [k, v] of Object.entries(ENV)) { if (on) process.env[k] = v; else delete process.env[k]; } };

const EL = {
  metering_point_address_line_1: 'UNIT 4', metering_point_address_line_2: 'MILL LANE', metering_point_address_line_3: '',
  metering_point_address_line_4: 'ILKESTON', post_code: 'DE7 5FW', supplier_id: 'kens', supplier_efd: '2026-02-20',
  total_eac: '37918.4', eac_efd: '2025-11-01',
};
const XO = [{ meterPointReferenceNumber: '9217034001', postcode: 'DE7 5FW', postTown: 'ILKESTON', buildingNumber: '4', thoroughfare: 'MILL LANE',
  uprn: '100030001234', mpaq: 64543, currentSupplierId: 'KNP', currentSupplierName: 'YU ENERGY RETAIL LIMITED',
  currentSupplierRegEffectiveDate: '2026-02-20', meterSerialNumber: 'E6S12345671961', ldzId: 'EM' }];

test('not connected until the secrets are added', async () => {
  setEnv(false);
  assert.equal(reg.electralinkConnected(), false);
  assert.equal(reg.xoserveConnected(), false);
  assert.deepEqual(await reg.lookup({ fuel: 'Electricity', number: '1100011559224' }), { status: 'not_connected' });
  assert.deepEqual(await reg.lookup({ fuel: 'Gas', number: '9217034001' }), { status: 'not_connected' });
});

test('Electralink: NHH pair in headers, fields mapped', async () => {
  setEnv(true); calls.length = 0;
  routes = { 'GET api.electralink.co.uk/v1/eac': () => [200, EL] };
  const r = await reg.lookup({ fuel: 'Electricity', number: '1100011559224' });
  assert.equal(calls[0].url.searchParams.get('mpan'), '1100011559224');
  assert.equal(calls[0].opts.headers['api-key'], 'k');
  assert.equal(calls[0].opts.headers['api-password'], 'p');
  assert.deepEqual(r, { status: 'ok', source: 'Electralink', supplierCode: 'KENS', supplierSince: '2026-02-20', address: 'UNIT 4, MILL LANE, ILKESTON',
    postcode: 'DE7 5FW', annualKwh: 37918.4, eacDate: '2025-11-01', profile: null });
});

test('Electralink: profile class when returned', async () => {
  routes = { 'GET api.electralink.co.uk/v1/eac': () => [200, { ...EL, profile_class_id: '3' }] };
  assert.equal((await reg.lookup({ fuel: 'Electricity', number: '1100011559224' })).profile, '03');
});

test('Electralink: blank EAC (HH or new connection) is null, not 0', async () => {
  routes = { 'GET api.electralink.co.uk/v1/eac': () => [200, { ...EL, total_eac: '' }] };
  assert.equal((await reg.lookup({ fuel: 'Electricity', number: '2380000333947' })).annualKwh, null);
});

test('Electralink: 404 is not found, 401 explains the credentials', async () => {
  routes = { 'GET api.electralink.co.uk/v1/eac': () => [404, { message: 'no record' }] };
  assert.deepEqual(await reg.lookup({ fuel: 'Electricity', number: '1100011559224' }), { status: 'not_found' });
  routes = { 'GET api.electralink.co.uk/v1/eac': () => [401, {}] };
  const r = await reg.lookup({ fuel: 'Electricity', number: '1100011559224' });
  assert.equal(r.status, 'error');
  assert.match(r.message, /credentials/);
});

test('Xoserve: token once, reused, then the switch query', async () => {
  reg._resetToken(); calls.length = 0;
  let tokens = 0;
  routes = {
    'POST login.example/token': (u, o) => { tokens++; assert.match(o.body, /grant_type=client_credentials/); assert.match(o.body, /scope=sc/); return [200, { access_token: 'T', expires_in: 3600 }]; },
    'GET desapi-css-prod.xoserveapis.com/query/v1/switch': (u, o) => { assert.equal(o.headers.Authorization, 'Bearer T'); assert.equal(o.headers['x-api-key'], 'xk'); return [200, XO]; },
  };
  const r = await reg.lookup({ fuel: 'Gas', number: '9217034001' });
  await reg.lookup({ fuel: 'Gas', number: '9217034001' });
  assert.equal(tokens, 1);
  assert.equal(calls.find((c) => c.url.pathname === '/query/v1/switch').url.searchParams.get('meterPointReferenceNumber'), '9217034001');
  assert.deepEqual(r, { status: 'ok', source: 'Xoserve', supplierCode: 'KNP', supplierName: 'YU ENERGY RETAIL LIMITED', supplierSince: '2026-02-20',
    address: '4, MILL LANE, ILKESTON', postcode: 'DE7 5FW', annualKwh: 64543, ldz: 'EM', exitZone: null, uprn: '100030001234', meterSerial: 'E6S12345671961' });
});

test('Xoserve: switchGasData wrapper and relAddress postcode', async () => {
  reg._resetToken();
  routes['GET desapi-css-prod.xoserveapis.com/query/v1/switch'] = () => [200, { switchGasData: [{ mpaq: '1200', currentSupplierId: 'BGT', relAddress: [{ postcode: 'PR7 1BN', postTown: 'CHORLEY' }] }] }];
  const r = await reg.lookup({ fuel: 'Gas', number: '9403553406' });
  assert.equal(r.postcode, 'PR7 1BN');
  assert.equal(r.annualKwh, 1200);
});

test('Xoserve: expired token is refreshed once; login refusal is explained', async () => {
  reg._resetToken();
  let n = 0;
  routes['GET desapi-css-prod.xoserveapis.com/query/v1/switch'] = () => (++n === 1 ? [401, {}] : [200, XO]);
  assert.equal((await reg.lookup({ fuel: 'Gas', number: '9217034001' })).status, 'ok');
  reg._resetToken();
  routes['POST login.example/token'] = () => [401, { error: 'invalid_client' }];
  const r = await reg.lookup({ fuel: 'Gas', number: '9217034001' });
  assert.equal(r.status, 'error');
  assert.match(r.message, /client ID, secret and scope/);
});

test('timeouts become an error, never a crash', async () => {
  global.fetch = async (url, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
  const t = setTimeout; global.setTimeout = (fn) => t(fn, 5);
  try {
    const r = await reg.lookup({ fuel: 'Electricity', number: '1100011559224' });
    assert.deepEqual(r, { status: 'error', message: 'timed out' });
  } finally { global.setTimeout = t; }
});

test('postcode check catches a valid-looking misread', () => {
  assert.equal(postcodeCheck('DE7 5FW', 'de75fw'), 'match');
  assert.equal(postcodeCheck('DY12 3LB', 'B98 9HE'), 'mismatch'); // Haiku's Corona misread
  assert.equal(postcodeCheck('B98 9HF', 'B98 9HE'), 'same area');
  assert.equal(postcodeCheck('B98 9HE', ''), 'missing');
});
