const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../functions-src/lib/meters');

test('MPAN check digit', () => {
  assert.equal(m.mpanCoreValid('1012345678903'), true);
  assert.equal(m.mpanCoreValid('1012345678904'), false);
  assert.equal(m.mpanCoreValid('101234567890'), false);
});

test('meter numbers: core, full 21-digit MPAN, MPRN, bad input', () => {
  assert.deepEqual(m.parseMeterNumber('10 1234 5678 903'), { fuel: 'Elec', number: '1012345678903', valid: true, problem: null });
  const full = m.parseMeterNumber('S 03 801 012 1012345678903');
  assert.equal(full.number, '1012345678903');
  assert.equal(full.profile, '03');
  assert.equal(full.topLine, '03801012');
  assert.equal(full.valid, true);
  assert.equal(m.parseMeterNumber('7465123809').fuel, 'Gas');
  assert.equal(m.parseMeterNumber('7465123809', 'Electricity').valid, false);
  assert.match(m.parseMeterNumber('1012345678904').problem, /check digit/);
  assert.equal(m.parseMeterNumber('').valid, false);
});

test('dates', () => {
  assert.deepEqual(m.parseDate('31/03/2027'), { date: '2027-03-31', dayMissing: false });
  assert.deepEqual(m.parseDate('2027-03-31'), { date: '2027-03-31', dayMissing: false });
  assert.deepEqual(m.parseDate('March 2027'), { date: '2027-03-31', dayMissing: true });
  assert.deepEqual(m.parseDate('02/2028'), { date: '2028-02-29', dayMissing: true });
  assert.deepEqual(m.parseDate('1st April 2027'), { date: '2027-04-01', dayMissing: false });
  assert.deepEqual(m.parseDate(46477), { date: '2027-03-31', dayMissing: false });
  assert.equal(m.parseDate('31/02/2027').date, null);
  assert.equal(m.parseDate('soon').date, null);
});

test('Excel rows: template columns, inferred fuel, problems reported per row', () => {
  const rows = [
    [],
    ['MPAN / MPRN', 'Fuel', 'Contract end date'],
    ['1012345678903', 'Electricity', '31/03/2027'],
    ['7465123809', 'Gas', '30/04/2027'],
    ['1055566677785', '', 46721],
    ['1012345678904', 'Elec', '31/03/2027'],
    ['1012345678903', 'Elec', ''],
    ['', '', ''],
    ['1098765432106', 'Water', 'next year'],
  ];
  const { meters, problems } = m.parseMeterRows(rows);
  assert.equal(meters.length, 5);
  assert.deepEqual(meters.map((x) => x.fuel), ['Elec', 'Gas', 'Elec', 'Elec', 'Elec']);
  assert.equal(meters[2].ced, '2027-11-30');
  assert.equal(meters[3].valid, false);
  assert.ok(problems.some((p) => /Row 6: MPAN check digit/.test(p)));
  assert.ok(problems.some((p) => /Row 7: .* more than once/.test(p)));
  assert.ok(problems.some((p) => /Row 9: fuel "Water"/.test(p)));
  assert.ok(problems.some((p) => /Row 9: contract end date "next year"/.test(p)));
});

test('Excel rows: no meter column', () => {
  assert.match(m.parseMeterRows([['Name', 'Address']]).problems[0], /No MPAN \/ MPRN column/);
});

test('grouping by fuel and CED window', () => {
  const today = '2026-11-26';
  const meters = [
    { number: 'E1', fuel: 'Elec', ced: '2027-03-31' },
    { number: 'E2', fuel: 'Elec', ced: '2027-04-30' },
    { number: 'G1', fuel: 'Gas', ced: '2027-04-30' },
    { number: 'E3', fuel: 'Elec', ced: '2027-11-30' },
    { number: 'E4', fuel: 'Elec', ced: '2028-06-30' },
    { number: 'E5', fuel: 'Elec', ced: null },
    { number: 'E6', fuel: 'Elec', ced: '2026-10-01' },
    { number: 'G2', fuel: 'Gas', ced: '2028-09-30' },
    { number: 'X', fuel: 'Elec', ced: '2027-01-01', included: false },
  ];
  const g = m.groupMeters(meters, today);
  assert.deepEqual(g.map((x) => x.key), ['this', 'gas', 'future-elec-2027', 'future-elec-2028', 'future-gas-2028']);
  assert.deepEqual(g[0].meters.map((x) => x.number), ['E1', 'E2', 'E5', 'E6']);
  assert.equal(g[0].earliestCed, '2026-10-01');
  assert.equal(g[0].flags.length, 2);
  assert.deepEqual(g[2].meters.map((x) => x.number), ['E3']);
  assert.equal(g[4].label, 'Gas · CED 2028');
  // the window boundary itself stays on the deal
  assert.equal(m.groupMeters([{ number: 'B', fuel: 'Elec', ced: '2027-11-26' }], today)[0].kind, 'this');
});

test('site matching and keys', () => {
  const sites = [
    { id: '1', address: '22 Market Street', postcode: 'BD1 1LA' },
    { id: '2', address: 'Unit 4, Mill Lane', postcode: 'LS11 5AB' },
    { id: '3', address: 'Unit 5, Mill Lane', postcode: 'LS11 5AB' },
  ];
  assert.equal(m.matchSite('22 MARKET STREET, BRADFORD', 'bd11la', sites).id, '1');
  assert.equal(m.matchSite('RIVERSIDE BAKERY, UNIT 4, MILL LANE, LEEDS', 'LS11 5AB', sites).id, '2');
  assert.equal(m.matchSite('Unit 9, Mill Lane', 'LS11 5AB', sites), null);
  assert.equal(m.matchSite('anything', '', sites), null);
  assert.equal(m.siteKey('RIVERSIDE BAKERY, UNIT 4, MILL LANE', 'ls11 5ab'), 'LS115AB|UNIT 4');
  assert.equal(m.formatPostcode('ls115ab'), 'LS11 5AB');
});

test('supplier names and rates text', () => {
  const names = ['British Gas', 'EDF Energy', 'Octopus Energy', 'Yu Energy', 'E.ON Next'];
  assert.equal(m.matchSupplier('British Gas Business', names), 'British Gas');
  assert.equal(m.matchSupplier('EDF Energy Customers Ltd', names), 'EDF Energy');
  assert.equal(m.matchSupplier('YU ENERGY RETAIL LIMITED', names), 'Yu Energy');
  assert.equal(m.matchSupplier('Unknown Power Co', names), null);
  assert.equal(m.ratesText({ day: 27.41, night: 19.87 }), 'D 27.41 N 19.87');
  assert.equal(m.ratesText({ unit: 24.5 }), 'U 24.50');
  assert.equal(m.ratesText(null), '');
});

test('bill results to meter rows, then the second check', () => {
  const read = { supplier: 'British Gas Business', meters: [{ fuel: 'Elec', supply_number: '0380101210 12345678903', site_address: 'Unit 4, Mill Lane, Leeds',
    postcode: 'ls115ab', contract_end_text: 'March 2027', contract_end_date: '2027-03-31', annual_kwh: 86120, rates: { day: 27.41, night: 19.87, standing_charge: 64.2 } }] };
  const [row] = m.billMeters(read, ['British Gas', 'EDF Energy'], 'Bill');
  assert.equal(row.number, '1012345678903');
  assert.equal(row.valid, true);
  assert.equal(row.ced, '2027-03-31');
  assert.equal(row.cedDayMissing, true);
  assert.equal(row.postcode, 'LS11 5AB');
  assert.equal(row.billSupplierMatch, 'British Gas');
  const [same] = m.mergeCheck([row], { meters: [{ supply_number: '1012345678903', matches_first_read: true, rates: { day: 27.41 } }] });
  assert.deepEqual(same.toCheck, []);
  const [diff] = m.mergeCheck([row], { meters: [{ supply_number: '1012345678903', matches_first_read: false, contract_end_date: '2027-03-30',
    contract_end_day_printed: true, rates: { day: 27.14 } }] });
  assert.equal(diff.ced, '2027-03-30');
  assert.equal(diff.rates.day, 27.14);
  assert.equal(diff.rates.night, 19.87);
  assert.deepEqual(diff.toCheck, ['contract end date', 'rates']);
  const [missing] = m.mergeCheck([row], { meters: [] });
  assert.deepEqual(missing.toCheck, ['meter number']);
});

test('data completeness: what each meter still needs for pricing', () => {
  const base = { fuel: 'Elec', number: '1012345678903', supplier: 'British Gas', ced: '2027-03-31', annualKwh: 20000 };
  assert.deepEqual(m.missingForPricing({ ...base, profile: '03', rates: { day: 27, night: 19 } }), []);
  assert.deepEqual(m.missingForPricing({ ...base }), ['profile class', 'meter type']);
  assert.deepEqual(m.missingForPricing({ ...base, profileClass: '01', meterType: 'Standard' }), []);
  assert.deepEqual(m.missingForPricing({ ...base, profile: '00' }), ['kVA', 'HH voltage']);
  assert.deepEqual(m.missingForPricing({ ...base, profile: '00', kva: 100, voltage: 'Low voltage' }), []);
  assert.deepEqual(m.missingForPricing({ fuel: 'Gas', number: '7465123809' }), ['current supplier', 'contract end date', 'annual consumption', 'gas zone (LDZ)']);
  assert.deepEqual(m.missingForPricing({ fuel: 'Gas', number: '7465123809', supplier: 'Yu Energy', ced: '2027-04-30', annualKwh: 52000, ldz: 'NE' }), []);
  assert.deepEqual(m.missingForPricing({ ...base, included: false }), []);
  assert.equal(m.meterTypeOf({ rates: { unit: 24 } }), 'Standard');
});
