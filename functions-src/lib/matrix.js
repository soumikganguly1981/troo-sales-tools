// Matrix pricing engine. Pure functions: no HubSpot calls.
// A price book (one supplier, fuel, contract type and region) is published by the loader
// (hubdb/load_price_books.py) as compact JSON: { meta, cols, rows }.
// Book rates are the supplier's base rates. The engine adds Troo's commission, works out the
// annual cost the way Utility Click shows it (CCL and VAT excluded) and ranks the options.

const DEFAULT_DAY_SHARE = 75; // Utility Click's day/night split in both examples we checked

// Meter type (HubSpot meter_type) -> rate type used in the price books
const RATE_TYPES = {
  Standard: 'single',
  'Economy 7': 'daynight',
  'Off Peak': 'daynight',
  'Evening/Weekend': 'ew',
  'Evening/Weekend/Night': 'ewn',
};

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;

// kWh at each rate. dayShare is the % used in the day (blank = 75).
function splitUsage(aq, rateType, dayShare) {
  const share = Math.min(100, Math.max(0, dayShare == null || dayShare === '' ? DEFAULT_DAY_SHARE : Number(dayShare))) / 100;
  const assumed = dayShare == null || dayShare === '';
  switch (rateType) {
    case 'single': return { unit: aq, assumed: false };
    case 'daynight':
    case 'hh': return { day: aq * share, night: aq * (1 - share), assumed };
    case 'ew': return { day: aq * share, ew: aq * (1 - share), assumed };
    case 'ewn': return { day: aq * share, ew: (aq * (1 - share)) / 2, night: (aq * (1 - share)) / 2, assumed };
    default: return { unit: aq, assumed: false };
  }
}

// Turns a compact book into row objects (cached on the book object).
function rowsOf(book) {
  if (!book._rows) book._rows = book.rows.map((r) => Object.fromEntries(book.cols.map((c, i) => [c, r[i]])));
  return book._rows;
}

const inRange = (v, lo, hi) => (lo == null || v >= lo) && (hi == null || v <= hi);

// Does this row fit the meter? Returns null if it fits, else the reason it doesn't.
function mismatches(row, m) {
  const out = [];
  if (row.rate_type && row.rate_type !== m.rateType) out.push('rate type');
  if (row.profile && m.profile && String(row.profile) !== String(m.profile)) out.push('profile class');
  if (row.band && String(row.band) !== String(m.band || '1')) out.push('band');
  if (row.voltage && m.voltage && row.voltage !== m.voltage) out.push('voltage');
  if (row.exit_zone && m.exitZone && row.exit_zone !== m.exitZone) out.push('exit zone');
  if (!inRange(m.aq, row.aq_min, row.aq_max)) out.push('consumption band');
  if (!inRange(m.start, row.start_from, row.start_to)) out.push('start date');
  if (row.dd != null && m.dd != null && Boolean(row.dd) !== Boolean(m.dd)) out.push('payment method');
  if (row.amr != null && m.amr != null && Boolean(row.amr) !== Boolean(m.amr)) out.push('smart meter');
  if (m.credit != null && !inRange(m.credit, row.credit_min, row.credit_max)) out.push('credit score');
  return out;
}

function mismatch(row, m) {
  return mismatches(row, m)[0] || null;
}

const ukDate = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');

// Why a supplier has no price: the check that alone blocks the most rows (rows that pass every
// other check), so the rep sees the real blocker, not just the most common difference.
function noPriceReason(near, reasons, starts, m) {
  const pick = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0];
  const top = pick(near) || pick(reasons);
  if (!top) return 'Price book has no rows';
  if (top[0] === 'start date' && starts.min && starts.max) {
    if (m.start && m.start > starts.max) return `Start date ${ukDate(m.start)} is after the latest start this book quotes (${ukDate(starts.max)})`;
    if (m.start && m.start < starts.min) return `Start date ${ukDate(m.start)} is before the earliest start this book quotes (${ukDate(starts.min)})`;
  }
  return `No price for this meter's ${top[0]}`;
}

// One priced option. comm = p/kWh added to every unit rate; scComm = p/day added to the standing charge.
function priceRow(row, m, comm, scComm, today) {
  const use = splitUsage(m.aq, m.rateType, m.dayShare);
  const rate = (base) => (base == null ? null : r4(Number(base) + comm));
  const rates = { unit: rate(row.unit), day: rate(row.day), night: rate(row.night), ew: rate(row.ew) };
  let energy = 0;
  for (const k of ['unit', 'day', 'night', 'ew']) {
    if (!use[k]) continue;
    const pr = rates[k] ?? rates.unit ?? rates.day; // a single-rate row prices every kWh at the unit rate
    if (pr == null) return null;
    energy += (use[k] * pr) / 100;
  }
  const sc = row.sc_p_day == null ? 0 : Number(row.sc_p_day) + scComm;
  const capacity = row.kva_p_kva_month && m.kva ? (Number(m.kva) * Number(row.kva_p_kva_month) * 12) / 100 : 0;
  const annual = energy + (sc * 365) / 100 + capacity;
  // fixed-end products (e.g. Yu "EOC Price"): the term runs from the start date to the end date
  const term = row.end_date ? monthsTo(m.start, row.end_date) : Number(row.term);
  const years = term / 12;
  const totalComms = ((m.aq * comm) / 100 + (scComm * 365) / 100) * years;
  return {
    supplier: row.supplier,
    product: row.product,
    term,
    endDate: row.end_date || null,
    green: !!row.green,
    rates,
    sc: r4(sc),
    kvaCharge: row.kva_p_kva_month == null ? null : Number(row.kva_p_kva_month),
    capacityMissingKva: !!row.kva_p_kva_month && !m.kva,
    annual: r2(annual),
    commission: comm,
    scCommission: scComm,
    totalComms: r2(totalComms),
    quoteBy: row.quote_by || null,
    expired: !!(row.quote_by && today && row.quote_by < today),
    splitAssumed: use.assumed,
  };
}

// meter: { id, fuel:'E'|'G'|'HH', region, profile, rateType, band, aq, dayShare, kva, voltage, exitZone, start, current, dd, amr, credit }
// books: published books for this meter's fuel and region
// opts: { terms:[12,24,...] | null, commission:{ [supplier]: p/kWh }, scCommission:{ [supplier]: p/day }, caps:{ [supplier]: {comms, fail:[]} }, today }
function priceMeter(m, books, opts = {}) {
  const today = opts.today || null;
  const options = [];
  const missing = []; // { supplier, reason }
  const bySupplier = new Map();
  for (const b of books) {
    // acquisition books for new customers, renewal books for the supplier's own customers, ANY for both
    const own = m.current && b.meta.supplier && m.current.toLowerCase() === b.meta.supplier.toLowerCase();
    if (b.meta.contract_type === 'REN' && !own) continue;
    if (b.meta.contract_type === 'ACQ' && own && books.some((x) => x.meta.supplier === b.meta.supplier && x.meta.contract_type === 'REN')) continue;
    if (!bySupplier.has(b.meta.supplier)) bySupplier.set(b.meta.supplier, []);
    bySupplier.get(b.meta.supplier).push(b);
  }
  for (const [supplier, sBooks] of bySupplier) {
    const cap = opts.caps && opts.caps[supplier];
    if (cap && cap.fail && cap.fail.length) { missing.push({ supplier, reason: cap.fail.join('; ') }); continue; }
    let comm = Number(opts.commission?.[supplier] ?? (cap ? cap.comms : 0)) || 0;
    if (cap && cap.comms != null && comm > cap.comms) comm = cap.comms; // never above the stipulated cap
    const scComm = Number(opts.scCommission?.[supplier] || 0);
    const reasons = {};
    const near = {};
    const starts = { min: null, max: null };
    let found = 0;
    for (const b of sBooks) {
      for (const row of rowsOf(b)) {
        if (row.start_from && (!starts.min || row.start_from < starts.min)) starts.min = row.start_from;
        if (row.start_to && (!starts.max || row.start_to > starts.max)) starts.max = row.start_to;
        const all = mismatches(row, m);
        if (all.length) {
          reasons[all[0]] = (reasons[all[0]] || 0) + 1;
          if (all.length === 1) near[all[0]] = (near[all[0]] || 0) + 1;
          continue;
        }
        if (!row.end_date && opts.terms && opts.terms.length && !opts.terms.includes(Number(row.term))) { reasons.term = (reasons.term || 0) + 1; continue; }
        const o = priceRow({ ...row, supplier, quote_by: row.quote_by || b.meta.quote_by }, m, comm, scComm, today);
        if (o) { found++; options.push(o); }
      }
    }
    if (!found) {
      missing.push({ supplier, reason: noPriceReason(near, reasons, starts, m) });
    }
  }
  options.sort((a, b) => a.annual - b.annual || b.term - a.term);
  return { options, missing };
}

// Collapses options with identical prices (e.g. "Renewable" twins) into one, listing the products.
function groupOptions(options) {
  const map = new Map();
  for (const o of options) {
    const key = [o.supplier, o.term, o.endDate, o.annual, o.sc, o.rates.unit, o.rates.day, o.rates.night, o.rates.ew].join('|');
    if (map.has(key)) map.get(key).products.push(o.product);
    else map.set(key, { ...o, products: [o.product] });
  }
  return [...map.values()];
}

// Meter facts from HubSpot properties.
// bottom line (meter_number) digits 1-2 = distributor (region); top line digits 1-2 = profile class.
function meterFromProps(id, p, fallbackStart) {
  const util = String(p.utility || '');
  const fuel = util === 'Gas' ? 'G' : /half hourly electric|^hh$/i.test(util) && !/non/i.test(util) ? 'HH' : 'E';
  const bottom = String(p.meter_number || p.bottom_line_meter_number__unique_identifier_ || '').replace(/\D/g, '');
  const top = String(p.top_line_meter_number || '').replace(/\D/g, '');
  const region = fuel === 'G' ? (p.mp_gas_ldz || '').toUpperCase() || null : bottom.length >= 2 ? bottom.slice(0, 2) : null;
  const profile = fuel === 'E' ? (top.length >= 2 ? top.slice(0, 2) : (p.mp_profile_class || null)) : null; // profile class entered in Meter Capture when the top line isn't known
  const rateType = fuel === 'HH' ? 'hh' : fuel === 'G' ? 'single' : RATE_TYPES[p.meter_type] || 'single';
  const aq = Number(p.aq) || Number(p.consumption__kwh_) || 0;
  const led = p.latest_end_date ? String(p.latest_end_date).slice(0, 10) : null;
  const start = led ? addDay(led) : fallbackStart || null;
  const notes = [];
  if (!aq) notes.push('No usage (AQ)');
  if (!region) notes.push(fuel === 'G' ? 'No gas zone (LDZ)' : 'No region (MPAN bottom line missing)');
  if (fuel === 'E' && !profile) notes.push('No profile class (MPAN top line missing)');
  if (fuel === 'E' && !p.meter_type) notes.push('No meter type, priced as single rate');
  if (fuel === 'E' && !p.mp_band) notes.push('No network charging band, using band 1');
  if (fuel === 'HH' && !p.kva) notes.push('No kVA, capacity charge left out');
  if (fuel === 'HH' && !p.mp_hh_voltage) notes.push('No HH voltage type');
  return {
    id: String(id),
    meterNumber: p.meter_number || p.bottom_line_meter_number__unique_identifier_ || '',
    fuel, region, profile, rateType,
    band: p.mp_band || null,
    aq,
    dayShare: p.mp_day_share_pct == null || p.mp_day_share_pct === '' ? null : Number(p.mp_day_share_pct),
    kva: p.kva ? Number(p.kva) : null,
    voltage: p.mp_hh_voltage || null,
    exitZone: p.mp_gas_exit_zone || null,
    start,
    current: p.mc_current_supplier || p.current_contract_supplier || null,
    notes,
  };
}
function monthsTo(start, end) { // whole months from start to the day after end
  const a = new Date(`${start}T00:00:00Z`); const b = new Date(`${end}T00:00:00Z`); b.setUTCDate(b.getUTCDate() + 1);
  let n = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) n--;
  return Math.max(0, n);
}
const addDay = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

module.exports = { priceMeter, priceRow, groupOptions, splitUsage, meterFromProps, mismatch, rowsOf, RATE_TYPES, DEFAULT_DAY_SHARE };
