// app function uid: matrix_price
// parameters: { meters: [meter as returned by matrix_deal_context, possibly edited], terms: [12,24,...],
//               commission: { [supplier]: p/kWh }, scCommission: { [supplier]: p/day }, dd, amr, credit }
// Prices every meter from the live price books. Commission caps and supplier eligibility come from
// the stipulation tables (the same rules as the revenue calculator); suppliers without a
// stipulation can still quote, at the commission the Closer enters.
const { ok, fail } = require('./lib/http');
const { loadStipulations } = require('./lib/hubdb');
const { evaluate, todayInLondon } = require('./lib/engine');
const { booksFor } = require('./lib/pricebooks');
const { priceMeter, groupOptions } = require('./lib/matrix');

const { FAMILY, GROUP } = require('./lib/families');
const MAX_OPTIONS = 150;

function capsFor(m, suppliers, tables, opts, today) {
  const fuel = m.fuel === 'G' ? 'G' : 'E';
  const currentFamily = FAMILY[m.current];
  const current = currentFamily ? GROUP[typeof currentFamily === 'string' ? currentFamily : currentFamily[fuel]] : '';
  const caps = {};
  for (const s of suppliers) {
    const f = FAMILY[s];
    const family = f && (typeof f === 'string' ? f : f[fuel]);
    const p = family && tables.products.find((x) => x.product_family === family && x.fuel === fuel && x.active !== false);
    if (!p) continue; // no stipulation: no cap, no rules
    const r = evaluate(p, {
      fuel, aq: m.aq, start: m.start, term: 'max', current, sector: 'general', structure: 'ltd', trading: 2,
      smart: opts.amr == null ? 'unsure' : opts.amr ? 'yes' : 'no', dd: opts.dd == null ? 'unsure' : opts.dd ? 'yes' : 'no',
      hh: m.fuel === 'HH' ? 'yes' : 'no', micro: false, indep: false, bgTrial: true, role: 'se', today,
    }, tables);
    caps[s] = { comms: r.comms, fail: r.fail.filter((x) => !/^Longest term/.test(x)), warn: r.warn };
  }
  return caps;
}

exports.main = async (context) => {
  try {
    const p = context.parameters || {};
    const meters = Array.isArray(p.meters) ? p.meters : [];
    if (!meters.length) return fail(400, 'Choose at least one meter to price');
    const today = todayInLondon();
    const terms = Array.isArray(p.terms) ? p.terms.map(Number).filter(Boolean) : null;
    const opts = { terms, commission: p.commission || {}, scCommission: p.scCommission || {}, today, dd: p.dd ?? null, amr: p.amr ?? null };
    const tables = await loadStipulations();

    const results = [];
    for (const raw of meters) {
      const m = { ...raw, aq: Number(raw.aq) || 0, dd: opts.dd, amr: opts.amr, credit: p.credit == null ? null : Number(p.credit) };
      const errors = [];
      if (!(m.aq > 0)) errors.push('Add the usage (AQ)');
      if (!m.region) errors.push(m.fuel === 'G' ? 'Add the gas zone (LDZ)' : 'Add the region');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m.start || '')) errors.push('Add the start date');
      else if (m.start < today) errors.push('Start date is in the past');
      if (errors.length) { results.push({ meterId: m.id, errors, options: [], missing: [] }); continue; }

      const books = await booksFor(m.fuel, m.region);
      const suppliers = [...new Set(books.map((b) => b.meta.supplier))];
      const caps = capsFor(m, suppliers, tables, opts, today);
      const { options, missing } = priceMeter(m, books, { ...opts, caps });
      const grouped = groupOptions(options);
      results.push({
        meterId: m.id,
        errors: [],
        options: grouped.slice(0, MAX_OPTIONS),
        truncated: grouped.length > MAX_OPTIONS,
        missing,
        caps: Object.fromEntries(Object.entries(caps).map(([s, c]) => [s, c.comms])),
        booksUsed: books.length,
      });
    }
    return ok({ today, stipMonth: tables.stipMonth, results });
  } catch (e) {
    return fail(500, `Couldn't price: ${e.message}`);
  }
};
