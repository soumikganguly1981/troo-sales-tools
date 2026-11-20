// Supplier revenue engine. Pure functions: no HubSpot calls.
// Rules come from the three HubDB tables (see hubdb/hubdb_stip_schema.json),
// already normalised by hubdb.js into plain objects (selects as names, dates as YYYY-MM-DD).

const GWH = 1e6;

// ---------- dates (all YYYY-MM-DD strings, UTC arithmetic) ----------
const parse = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmt = (dt) => dt.toISOString().slice(0, 10);
const ukDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
function addMonths(iso, n) {
  const d = parse(iso);
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()));
  if (out.getUTCDate() !== d.getUTCDate()) out.setUTCDate(0); // clamp to month end, as the HTML did
  return fmt(out);
}
const addDays = (iso, n) => { const d = parse(iso); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
const monthStart = (iso) => iso.slice(0, 8) + '01';
function monthsFit(start, eoc) {
  const lim = addDays(eoc, 1); let n = 0;
  while (n < 300 && addMonths(start, n + 1) <= lim) n++;
  return n;
}
function wholeMonthsBetween(a, b) { // like dateutil relativedelta(b, a) in months
  const A = parse(a), B = parse(b);
  let m = (B.getUTCFullYear() - A.getUTCFullYear()) * 12 + (B.getUTCMonth() - A.getUTCMonth());
  if (B.getUTCDate() < A.getUTCDate()) m--;
  return m;
}
function todayInLondon(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

// ---------- formatting ----------
const fmtKwh = (v) => v >= GWH ? `${(v / GWH).toLocaleString('en-GB', { maximumFractionDigits: 2 })} GWh` : `${Math.round(v).toLocaleString('en-GB')} kWh`;

// ---------- matching ----------
const applies = (row, p) => (row.applies_to === p.product_family || row.applies_to === p.supplier_group) && (row.fuel === 'any' || row.fuel === p.fuel);
const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function fieldValue(field, c) {
  switch (field) {
    case 'aq_kwh': return c.aq;
    case 'start_date': return c.start;
    case 'trading_years': return c.trading;
    case 'bg_trial': return c.bgTrial ? 'on' : 'off';
    default: return c[field];
  }
}
function test(field, op, value, c) {
  if (!op || op === 'always' || field === 'always') return true;
  const x = fieldValue(field, c);
  if (op === 'is_true') return !!x;
  if (op === 'is_false') return !x;
  const v = typeof x === 'number' ? Number(value) : String(value ?? '');
  switch (op) {
    case 'eq': return x === v;
    case 'neq': return x !== v;
    case 'in': return String(value).split(',').map((s) => s.trim()).includes(String(x));
    case 'lt': return x < v;
    case 'lte': return x <= v;
    case 'gt': return x > v;
    case 'gte': return x >= v;
    default: throw new Error(`Unknown operator ${op}`);
  }
}

function commsFor(p, c, bands) {
  const list = bands.filter((b) => applies(b, p)).sort((a, b) => a.priority - b.priority);
  const mts = wholeMonthsBetween(c.today, c.start);
  for (const b of list) {
    if (b.aq_min_kwh != null && c.aq < b.aq_min_kwh) continue;
    if (b.aq_max_kwh != null && c.aq > b.aq_max_kwh) continue;
    if (b.sectors && !b.sectors.split(',').map((s) => s.trim()).includes(c.sector)) continue;
    if (b.start_on_or_before && c.start > b.start_on_or_before) continue;
    if (b.start_after && c.start <= b.start_after) continue;
    if (b.months_to_start_gt != null && !(mts > b.months_to_start_gt)) continue;
    if (b.role && b.role !== 'any' && b.role !== c.role) continue;
    if (b.bg_trial && b.bg_trial !== 'any' && b.bg_trial !== (c.bgTrial ? 'on' : 'off')) continue;
    return { comms: b.comms_p_per_kwh, note: b.note || '' };
  }
  return null;
}

function endOfCurve(p, c) {
  switch (p.eoc_mode) {
    case 'fixed_date': return p.eoc_date;
    case 'months_from_today': return addMonths(c.today, n(p.eoc_months));
    case 'months_from_month_start': return addMonths(monthStart(c.today), n(p.eoc_months));
    default: return null;
  }
}
function latestStart(p, c, eoc) {
  const months = c.renewal && p.latest_start_months_renewal != null ? p.latest_start_months_renewal : p.latest_start_months;
  switch (p.latest_start_mode) {
    case 'fixed_date': return p.latest_start_date;
    case 'months_from_today': return addMonths(c.today, n(months));
    case 'months_from_month_start': return addMonths(monthStart(c.today), n(months));
    case 'months_before_eoc': return eoc ? addMonths(eoc, -n(months)) : null;
    default: return null;
  }
}

function evaluate(p, c, { bands, rules }) {
  const r = { key: p.product_key, supplier: p.supplier, product: p.product || '', group: p.supplier_group, fail: [], warn: [] };
  c = { ...c, renewal: c.current === p.supplier_group };
  r.renewal = c.renewal;

  const min = c.renewal && p.min_aq_renewal_kwh != null ? p.min_aq_renewal_kwh : p.min_aq_kwh;
  const max = p.max_aq_kwh;
  if (min != null && c.aq < min) r.fail.push(`Below the minimum consumption of ${fmtKwh(min)}`);
  if (max != null && (p.max_aq_exclusive ? c.aq >= max : c.aq > max)) r.fail.push(p.max_aq_exclusive ? `Must be under ${fmtKwh(max)}` : `Above the maximum of ${fmtKwh(max)}`);

  const eoc = endOfCurve(p, c);
  const latest = latestStart(p, c, eoc);
  if (latest && c.start > latest) r.fail.push(`Start date must be on or before ${ukDate(latest)}${p.latest_start_note ? ` (${p.latest_start_note})` : ''}`);

  let ruleCap = null;
  for (const rule of rules.filter((x) => applies(x, p)).sort((a, b) => a.sort_order - b.sort_order)) {
    if (!test(rule.field1, rule.op1, rule.value1, c)) continue;
    if (rule.field2 && !test(rule.field2, rule.op2, rule.value2, c)) continue;
    if (rule.outcome === 'fail') r.fail.push(rule.message);
    else if (rule.outcome === 'warn') r.warn.push(rule.message);
    else if (rule.outcome === 'term_cap') { ruleCap = ruleCap == null ? rule.cap_months : Math.min(ruleCap, rule.cap_months); r.warn.push(rule.message); }
  }

  const caps = [p.max_term_months, ruleCap].filter((x) => x != null);
  const capTerm = caps.length ? Math.min(...caps) : Infinity;
  const maxTerm = Math.min(eoc ? monthsFit(c.start, eoc) : Infinity, capTerm);
  const minTerm = p.min_term_months || 1;
  let term;
  if (c.term === 'max') term = maxTerm;
  else {
    term = Number(c.term);
    if (term > maxTerm) r.fail.push(`Longest term available is ${maxTerm} months${eoc && maxTerm < capTerm ? ` (curve ends ${ukDate(eoc)})` : ''}`);
  }
  if (!(maxTerm > 0)) r.fail.push('Curve ends before this start date');
  else if (term < minTerm) r.fail.push(`Contract must be at least ${minTerm} months`);

  const band = commsFor(p, c, bands);
  if (!band) r.fail.push('No commission rate set for this deal in the stipulations');
  r.comms = band ? band.comms : 0;
  r.commsNote = band ? band.note : '';
  r.term = Number.isFinite(term) ? term : null;
  r.end = r.term ? addDays(addMonths(c.start, r.term), -1) : null;
  r.annual = (c.aq * r.comms) / 100;
  r.total = r.term ? (r.annual * r.term) / 12 : 0;
  return r;
}

// deal: { fuel:'E'|'G', aq, start:'YYYY-MM-DD', term:'max'|number, current, sector, structure, trading, smart, dd, hh, micro, indep, bgTrial, role }
function rank(deal, tables, today = todayInLondon()) {
  const c = { ...deal, aq: Number(deal.aq), trading: Number(deal.trading), today };
  const errors = [];
  if (!(c.aq > 0)) errors.push('Add the annual consumption');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.start || '')) errors.push('Add the contract start date');
  else if (c.start < today) errors.push(`Start date is in the past. Choose ${ukDate(today)} or later`);
  if (errors.length) return { errors, available: [], ruledOut: [], today };

  const products = tables.products.filter((p) => p.active !== false && p.fuel === c.fuel).sort((a, b) => a.sort_order - b.sort_order);
  const res = products.map((p) => evaluate(p, c, tables));
  const available = res.filter((r) => !r.fail.length).sort((a, b) => b.total - a.total || b.annual - a.annual);
  const ruledOut = res.filter((r) => r.fail.length);
  return { errors: [], available, ruledOut, today, considered: products.length };
}

module.exports = { rank, evaluate, todayInLondon, addMonths, monthsFit, wholeMonthsBetween, ukDate };
