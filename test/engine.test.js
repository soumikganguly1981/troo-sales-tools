// Engine tests against the November 2026 stipulations (test/fixtures/stips-2026-11.json,
// the same rows loaded into HubDB). Expected figures were cross-checked with an
// independent Python evaluation of the same tables.
const test = require('node:test');
const assert = require('node:assert/strict');
const { rank, wholeMonthsBetween, addMonths, monthsFit } = require('../functions-src/lib/engine');
const { normaliseRow } = require('../functions-src/lib/hubdb');
const payload = require('./fixtures/stips-2026-11.json');

const toTable = (t) => t.rows.map((r) => normaliseRow(r, t.columns));
const tables = { products: toTable(payload[0]), bands: toTable(payload[1]), rules: toTable(payload[2]) };
const TODAY = '2026-11-19';
const deal = (o = {}) => ({ fuel: 'E', aq: 85000, start: '2026-12-01', term: 'max', current: '', sector: 'general', structure: 'ltd', trading: 2,
  smart: 'unsure', dd: 'unsure', hh: 'unsure', micro: false, indep: false, bgTrial: true, role: 'se', ...o });
const byKey = (res) => Object.fromEntries(res.available.map((r) => [r.key, r]));
const outKeys = (res) => res.ruledOut.map((r) => r.key).sort();

test('date helpers', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(monthsFit('2026-12-01', '2030-03-31'), 40);
  assert.equal(wholeMonthsBetween('2026-11-19', '2027-05-19'), 6);
  assert.equal(wholeMonthsBetween('2026-11-19', '2027-05-18'), 5);
});

test('85,000 kWh electricity, general ltd, trial on', () => {
  const res = rank(deal(), tables, TODAY);
  const k = byKey(res);
  const expect = { engie_e: [4, 88, 24933], npower_mp_full_pt_e: [4, 88, 24933], corona_e: [4, 71, 20117], total_matrix_e: [4, 60, 17000],
    npower_pt_e: [4, 52, 14733], npower_fixed_e: [4, 40, 11333], smartest_sme_e: [3, 48, 10200], bg_matrix_e: [3, 47, 9988],
    bg_lite_e: [2.5, 47, 8323], edf_matrix_e: [2, 53, 7508], crown_e_e: [2, 40, 5667], drax_e: [2, 40, 5667] };
  for (const [key, [comms, term, total]] of Object.entries(expect)) {
    assert.ok(k[key], `${key} should be available`);
    assert.equal(k[key].comms, comms, `${key} comms`);
    assert.equal(k[key].term, term, `${key} term`);
    assert.equal(Math.round(k[key].total), total, `${key} total`);
  }
  assert.deepEqual(outKeys(res), ['bg_bespoke_e', 'shell_pt_e', 'shell_standard_e', 'smartest_mm_e']);
  assert.equal(res.available[0].total >= res.available[1].total, true);
});

test('pubs are ruled out at Corona, Engie and TotalEnergies', () => {
  const out = outKeys(rank(deal({ sector: 'pub' }), tables, TODAY));
  for (const k of ['corona_e', 'engie_e', 'total_matrix_e', 'total_bespoke_e']) assert.ok(out.includes(k), k);
});

test('2 GWh gas, start 01/03/2029, TM/BDM: Npower post-MTP tier', () => {
  const k = byKey(rank(deal({ fuel: 'G', aq: 2e6, start: '2029-03-01', role: 'tm' }), tables, TODAY));
  assert.equal(k.npower_mp_full_pt_g.comms, 3.5);
  assert.equal(Math.round(k.npower_mp_full_pt_g.total), 355833);
  assert.equal(k.bg_bespoke_g.comms, 3);
  assert.equal(k.engie_g.comms, 1.5);
});

test('Npower Sales Exec rate after MTP is lower', () => {
  const k = byKey(rank(deal({ fuel: 'G', aq: 2e6, start: '2029-03-01', role: 'se' }), tables, TODAY));
  assert.equal(k.npower_fixed_g.comms, 2);
});

test('Smartest SME drops to 2.5p when start is more than 6 months out', () => {
  assert.equal(byKey(rank(deal(), tables, TODAY)).smartest_sme_e.comms, 3);
  assert.equal(byKey(rank(deal({ start: '2027-07-01' }), tables, TODAY)).smartest_sme_e.comms, 2.5);
});

test('Corona sole traders capped at 36 months', () => {
  const k = byKey(rank(deal({ structure: 'sole' }), tables, TODAY));
  assert.equal(k.corona_e.term, 36);
});

test('BG trial off gives 2.5p elec', () => {
  assert.equal(byKey(rank(deal({ bgTrial: false }), tables, TODAY)).bg_matrix_e.comms, 2.5);
});

test('Engie charity rate and EDF DD fail', () => {
  const res = rank(deal({ sector: 'charity', dd: 'no' }), tables, TODAY);
  assert.equal(byKey(res).engie_e.comms, 0.5);
  assert.ok(outKeys(res).includes('edf_matrix_e'));
});

test('renewal uses the longer TotalEnergies window', () => {
  const nb = rank(deal({ start: '2028-06-01' }), tables, TODAY);
  const rn = rank(deal({ start: '2028-06-01', current: 'total' }), tables, TODAY);
  assert.ok(outKeys(nb).includes('total_matrix_e'));
  assert.ok(byKey(rn).total_matrix_e && byKey(rn).total_matrix_e.renewal);
});

test('fixed term longer than the curve fails with a reason', () => {
  const res = rank(deal({ term: 72 }), tables, TODAY);
  const drax = res.ruledOut.find((r) => r.key === 'drax_e');
  assert.match(drax.fail.join(' '), /Longest term available is 40 months/);
});

test('input errors', () => {
  assert.deepEqual(rank(deal({ aq: 0 }), tables, TODAY).errors, ['Add the annual consumption']);
  assert.match(rank(deal({ start: '2026-01-01' }), tables, TODAY).errors[0], /in the past/);
});
