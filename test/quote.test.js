const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../functions-src/lib/quote');

const meter = { id: '1', meterNumber: '1012648213139', fuel: 'E', aq: 8000, start: '2027-03-01', company: 'Acme Ltd' };
const opt = (term, annual, quoteBy = '2026-12-15') => ({ supplier: 'Yu Energy', products: ['Fix'], term, endDate: null, green: false, rates: { unit: 25 }, sc: 60, annual, commission: 1, totalComms: 80 * term / 12, quoteBy });

test('item keys match for the same option and differ across terms', () => {
  const a = q.cleanItem(meter, opt(24, 2000)); const b = q.cleanItem(meter, opt(24, 2000)); const c = q.cleanItem(meter, opt(36, 2000));
  assert.equal(a.key, b.key); assert.notEqual(a.key, c.key);
  assert.equal(a.key, q.itemKey('1', opt(24, 2000)));
});

test('groups by meter, cheapest first, and the quote is valid until the earliest quote-by date', () => {
  const items = [q.cleanItem(meter, opt(12, 2300, '2026-12-20')), q.cleanItem(meter, opt(24, 2000, '2026-12-15')), q.cleanItem({ ...meter, id: '2' }, opt(36, 900))];
  const g = q.groupByMeter(items);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].items.map((i) => i.option.annual), [2000, 2300]);
  assert.equal(q.validUntil(items), '2026-12-15');
});

test('bad stored JSON reads as an empty shortlist', () => {
  assert.deepEqual(q.parseShortlist('not json'), []);
  assert.deepEqual(q.parseShortlist(''), []);
});

test('builds a PDF and a note naming the commission', async () => {
  const items = [q.cleanItem(meter, opt(24, 2000)), q.cleanItem(meter, opt(36, 1950))];
  const pdf = await q.buildQuotePdf({ items, company: 'Acme Ltd', date: '2026-11-25', logo: null });
  assert.equal(Buffer.from(pdf.slice(0, 4)).toString(), '%PDF');
  const note = q.noteBody(items, 'Acme Ltd', 'Troo quote.pdf', 'Sam');
  assert.match(note, /2 options across 1 meter/);
  assert.match(note, /commission 1p\/kWh/);
  assert.equal(q.quoteFileName('Acme & Co. Ltd', '2026-11-25'), 'Troo quote - Acme Co Ltd - 2026-11-25.pdf');
});

test('PDF copes with characters the font cannot draw (zero-width spaces, emoji, non-Latin text)', async () => {
  const odd = { ...meter, company: 'Acme​ Ltd — Café ☕ 北京', site: '1​ High St﻿', meterNumber: '1012​648213139' };
  const items = [q.cleanItem(odd, { ...opt(24, 2000), products: ['Fix​ Plan ✓'] })];
  assert.equal(items[0].meter.company.includes('​'), false);
  const pdf = await q.buildQuotePdf({ items, company: 'Acme​ Ltd ☕', date: '2026-11-25', logo: null });
  assert.equal(Buffer.from(pdf.slice(0, 4)).toString(), '%PDF');
  // Raw stored data with a zero-width space (saved before this fix) still builds
  const raw = [{ ...items[0], meter: { ...items[0].meter, company: 'Black​ Orange' } }];
  const pdf2 = await q.buildQuotePdf({ items: raw, company: 'Black​ Orange', date: '2026-11-25', logo: null });
  assert.equal(Buffer.from(pdf2.slice(0, 4)).toString(), '%PDF');
});
