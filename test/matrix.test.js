// Matrix engine tests. The two worked examples are real Utility Click Instant Quotes:
// the engine must reproduce Utility Click's annual cost and total commission exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { priceMeter, groupOptions, splitUsage, meterFromProps } = require('../functions-src/lib/matrix');

const book = (meta, rows) => {
  const cols = Object.keys(rows[0]);
  return { meta: { contract_type: 'ACQ', ...meta }, cols, rows: rows.map((r) => cols.map((c) => r[c])) };
};

test('Economy 7: British Gas Acq DD SC, 36 months, matches Utility Click (IAD348Q)', () => {
  // UC showed 27.55p day / 20.33p night with 3p commission included, 70p/day, 41,796 kWh split 31,347 / 10,449
  const b = book({ supplier: 'British Gas' }, [{
    product: 'Acq DD SC', rate_type: 'daynight', profile: '04', band: null, aq_min: 0, aq_max: 100000, term: 36,
    start_from: '2026-11-01', start_to: '2028-12-31', day: 24.55, night: 17.33, unit: null, ew: null, sc_p_day: 70,
  }]);
  const m = { fuel: 'E', region: '12', profile: '04', rateType: 'daynight', aq: 41796, dayShare: null, start: '2028-02-12' };
  const { options } = priceMeter(m, [b], { commission: { 'British Gas': 3 } });
  assert.equal(options.length, 1);
  assert.equal(Math.round(options[0].annual), 11016);
  assert.equal(Math.round(options[0].totalComms), 3762);
  assert.equal(options[0].rates.day, 27.55);
  assert.equal(options[0].splitAssumed, true);
});

test('Economy 7: Corona standing charge in £/month is converted (loader stores p/day)', () => {
  // UC: 28.177p / 21.523p incl. 4p, £15.044 a month, 48 months -> £11,262, comms £6,687
  const scPerDay = (15.044 * 12 * 100) / 365;
  const b = book({ supplier: 'Corona Energy' }, [{
    product: 'Excl Smart Standard', rate_type: 'daynight', profile: null, band: null, aq_min: 0, aq_max: 200000, term: 48,
    start_from: null, start_to: null, day: 24.177, night: 17.523, unit: null, ew: null, sc_p_day: scPerDay,
  }]);
  const m = { fuel: 'E', region: '12', profile: '04', rateType: 'daynight', aq: 41796, start: '2028-02-12' };
  const { options } = priceMeter(m, [b], { commission: { 'Corona Energy': 4 } });
  assert.equal(Math.round(options[0].annual), 11262);
  assert.equal(Math.round(options[0].totalComms), 6687);
});

test('Half hourly: Smartest SmartFix 24 months matches Utility Click (CLU766Q)', () => {
  // UC: 31.37p / 22.97p incl. 0.4p, 169.38p/day, capacity 0, 25,715 kWh split 19,286 / 6,429 -> £8,145, comms £206
  const b = book({ supplier: 'Smartest Energy Business' }, [{
    product: 'SmartFix', rate_type: 'hh', profile: null, band: null, aq_min: 0, aq_max: 100000, term: 24,
    start_from: null, start_to: null, day: 30.97, night: 22.57, unit: null, ew: null, sc_p_day: 169.38, kva_p_kva_month: 0,
  }]);
  const m = { fuel: 'HH', region: '15', rateType: 'hh', aq: 25715, start: '2026-12-16', kva: null };
  const { options } = priceMeter(m, [b], { commission: { 'Smartest Energy Business': 0.4 } });
  assert.equal(Math.round(options[0].annual), 8145);
  assert.equal(Math.round(options[0].totalComms), 206);
});

test('commission never goes above the stipulated cap', () => {
  const b = book({ supplier: 'British Gas' }, [{ product: 'X', rate_type: 'single', term: 12, unit: 20, sc_p_day: 50, aq_min: 0, aq_max: 1e6 }]);
  const m = { fuel: 'E', rateType: 'single', aq: 10000, start: '2027-01-01' };
  const { options } = priceMeter(m, [b], { commission: { 'British Gas': 5 }, caps: { 'British Gas': { comms: 2.5, fail: [] } } });
  assert.equal(options[0].commission, 2.5);
});

test('a supplier ruled out by the stipulations is listed as missing with the reason', () => {
  const b = book({ supplier: 'British Gas' }, [{ product: 'X', rate_type: 'single', term: 12, unit: 20, sc_p_day: 50 }]);
  const m = { fuel: 'E', rateType: 'single', aq: 10000, start: '2027-01-01' };
  const { options, missing } = priceMeter(m, [b], { caps: { 'British Gas': { comms: 3, fail: ['Start date must be on or before 01/05/2028'] } } });
  assert.equal(options.length, 0);
  assert.match(missing[0].reason, /Start date/);
});

test('quotes missing explains which check ruled the supplier out', () => {
  const b = book({ supplier: 'Yu Energy' }, [
    { product: 'Fix Energy Plan', rate_type: 'single', profile: '03', band: '1', aq_min: 1, aq_max: 15000, term: 12, unit: 22, sc_p_day: 60 },
    { product: 'Fix Energy Plan', rate_type: 'single', profile: '03', band: '1', aq_min: 15001, aq_max: 25000, term: 12, unit: 21, sc_p_day: 60 },
  ]);
  const m = { fuel: 'E', rateType: 'single', profile: '03', band: '1', aq: 90000, start: '2027-01-01' };
  const { missing } = priceMeter(m, [b], {});
  assert.equal(missing[0].supplier, 'Yu Energy');
  assert.match(missing[0].reason, /consumption band/);
});

test('renewal books show only to the supplier\'s own customers', () => {
  const acq = book({ supplier: 'British Gas', contract_type: 'ACQ' }, [{ product: 'Acq', rate_type: 'single', term: 12, unit: 20, sc_p_day: 50 }]);
  const ren = book({ supplier: 'British Gas', contract_type: 'REN' }, [{ product: 'Ren', rate_type: 'single', term: 12, unit: 19, sc_p_day: 50 }]);
  const base = { fuel: 'E', rateType: 'single', aq: 10000, start: '2027-01-01' };
  assert.deepEqual(priceMeter({ ...base, current: 'Shell Energy' }, [acq, ren]).options.map((o) => o.product), ['Acq']);
  assert.deepEqual(priceMeter({ ...base, current: 'British Gas' }, [acq, ren]).options.map((o) => o.product), ['Ren']);
});

test('identical prices collapse into one option listing both products', () => {
  const b = book({ supplier: 'British Gas' }, [
    { product: 'Acq DD SC', rate_type: 'single', term: 36, unit: 20, sc_p_day: 70 },
    { product: 'Acq DD SC (Renewable)', rate_type: 'single', term: 36, unit: 20, sc_p_day: 70 },
  ]);
  const { options } = priceMeter({ fuel: 'E', rateType: 'single', aq: 10000, start: '2027-01-01' }, [b]);
  const g = groupOptions(options);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].products, ['Acq DD SC', 'Acq DD SC (Renewable)']);
});

test('usage split defaults to 75/25 and respects a meter\'s own share', () => {
  assert.deepEqual(splitUsage(1000, 'daynight', null), { day: 750, night: 250, assumed: true });
  assert.deepEqual(splitUsage(1000, 'daynight', 60), { day: 600, night: 400, assumed: false });
});

test('meter facts come from the MPAN, meter type and the new fields', () => {
  const m = meterFromProps('9', { utility: 'NHH', meter_number: '1200012345678', top_line_meter_number: '04 801 123', meter_type: 'Economy 7', aq: '41796', latest_end_date: '2028-02-11' });
  assert.equal(m.fuel, 'E');
  assert.equal(m.region, '12');
  assert.equal(m.profile, '04');
  assert.equal(m.rateType, 'daynight');
  assert.equal(m.start, '2028-02-12');
  assert.match(m.notes.join(' '), /band/);
  const g = meterFromProps('10', { utility: 'Gas', mp_gas_ldz: 'nt', aq: '50000' });
  assert.equal(g.region, 'NT');
  assert.equal(g.fuel, 'G');
  const hh = meterFromProps('11', { utility: 'Half Hourly Electric', meter_number: '1500000000000', aq: '25715' });
  assert.equal(hh.fuel, 'HH');
  assert.equal(hh.rateType, 'hh');
});
