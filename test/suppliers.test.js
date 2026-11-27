// The single supplier list (hubdb/suppliers.csv, the seed and fallback for HubDB supplier_code_map):
// every app's supplier names and codes must resolve through it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { bundledSuppliers, parseCsv } = require('../functions-src/lib/suppliers');
const { FAMILY } = require('../functions-src/lib/families');

const s = bundledSuppliers();

test('the list has unique Utility Click names', () => {
  assert.ok(s.names.length > 100);
  assert.equal(new Set(s.names.map((n) => n.toLowerCase())).size, s.names.length);
});

test('Pricing: every price-book supplier is on the list', () => {
  for (const name of Object.keys(FAMILY)) assert.ok(s.names.includes(name), `${name} (families.js) is not on the supplier list`);
});

test('price-book file codes resolve to a supplier', () => {
  const expect = { YU: 'Yu Energy', BG: 'British Gas', BGL: 'BG Lite', CORONA: 'Corona Energy', COR: 'Corona Energy', EDF: 'EDF Energy', TOTAL: 'TotalEnergies',
    TGP: 'TotalEnergies', VALDA: 'Valda Energy', SMARTEST: 'Smartest Energy Business', SEB: 'Smartest Energy Business', CROWN: 'Crown Gas & Power',
    DRAX: 'Drax', ENGIE: 'Engie', NPOWER: 'Npower', SHELL: 'Shell Energy', SEFE: 'SEFE Energy' };
  for (const [code, name] of Object.entries(expect)) assert.equal((s.fromPricebookCode(code) || {}).name, name, code);
});

test('Revenue calculator: every stipulation supplier resolves to its group', () => {
  const stips = parseCsv(fs.readFileSync(require.resolve('../hubdb/stip_products.csv'), 'utf8'));
  for (const r of stips) assert.equal(s.stipsGroup(r.supplier), r.supplier_group, `${r.supplier} -> ${r.supplier_group}`);
  for (const [text, g] of [['BG', 'bg'], ['BGB', 'bg'], ['BG Lite', 'bg'], ['Smartest', 'smartest'], ['Smartest MM', 'smartest'], ['Total Gas & Power', 'total'], ['Octopus Energy', '']]) {
    assert.equal(s.stipsGroup(text), g, text);
  }
});

test('old deal dropdown values and bill wording resolve to one name', () => {
  const cases = { 'Yu energy': 'Yu Energy', 'YU ENERGY RETAIL LIMITED': 'Yu Energy', BGB: 'British Gas', 'British Gas Business': 'British Gas',
    'EDF Energy Customers Ltd': 'EDF Energy', 'Eon Next': 'E.ON Next', Sefe: 'SEFE Energy', Total: 'TotalEnergies', 'Smartest SME': 'Smartest Energy Business',
    Pozitive: 'Pozitive Energy', 'Avanti Gas': 'AvantiGas', YGP: 'Yorkshire Gas & Power', 'octopus energy limited': 'Octopus Energy' };
  for (const [text, name] of Object.entries(cases)) assert.equal((s.resolve(text) || {}).name, name, text);
  assert.equal(s.resolve('Made Up Power Co'), null);
  assert.equal(s.resolve(''), null);
});

test('suppliers Troo trades with are the ones with stipulations or price books', () => {
  for (const n of ['British Gas', 'EDF Energy', 'Yu Energy', 'Smartest Energy Business']) assert.ok(s.tradesWith.includes(n), n);
  assert.ok(!s.tradesWith.includes('Octopus Energy'));
});
