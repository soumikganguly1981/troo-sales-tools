// Meter Capture: pure rules with no HubSpot calls, so they can be tested on their own.
// - meter numbers: MPAN (13-digit core or 21-digit full) and MPRN, with the MPAN check digit
// - Excel/CSV rows: MPAN/MPRN, Fuel, Contract end date (the only three template columns)
// - dates: DD/MM/YYYY, "March 2027", ISO, Excel serial numbers
// - grouping: which meters stay on this deal and which go to new gas / Future Opportunity deals
// - site keys: meters at the same address and postcode share one Site

const MPAN_WEIGHTS = [3, 5, 7, 13, 17, 19, 23, 29, 31, 37, 41, 43];
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');

function mpanCoreValid(core) {
  if (!/^\d{13}$/.test(core)) return false;
  const sum = MPAN_WEIGHTS.reduce((t, w, i) => t + w * Number(core[i]), 0);
  return (sum % 11) % 10 === Number(core[12]);
}

// Reads anything a rep or a bill might give: "S 03 801 012 / 12 3456 7890 123", a bare core, an MPRN.
// Returns { fuel, number, valid, profile?, topLine?, problem? }.
function parseMeterNumber(raw, fuelHint) {
  const d = digits(raw);
  const hint = normaliseFuel(fuelHint);
  if (!d) return { fuel: hint, number: '', valid: false, problem: 'No meter number' };
  if (d.length === 21 && hint !== 'Gas') {
    const core = d.slice(8);
    return { fuel: 'Elec', number: core, topLine: d.slice(0, 8), profile: d.slice(0, 2), valid: mpanCoreValid(core),
      problem: mpanCoreValid(core) ? null : 'MPAN check digit does not match' };
  }
  if (d.length === 13 && hint !== 'Gas') {
    return { fuel: 'Elec', number: d, valid: mpanCoreValid(d), problem: mpanCoreValid(d) ? null : 'MPAN check digit does not match' };
  }
  if (d.length >= 6 && d.length <= 10 && hint !== 'Elec') return { fuel: 'Gas', number: d, valid: true, problem: null };
  // A misjoined number (top line glued on, a stray digit): keep it only if exactly one 13-digit run passes the check digit
  if (d.length > 13 && hint !== 'Gas') {
    const runs = [...new Set(Array.from({ length: d.length - 12 }, (_, i) => d.slice(i, i + 13)).filter(mpanCoreValid))];
    if (runs.length === 1) return { fuel: 'Elec', number: runs[0], valid: true, problem: null, recoveredFrom: d };
  }
  return { fuel: hint, number: d, valid: false,
    problem: hint === 'Gas' ? 'An MPRN has 6 to 10 digits' : hint === 'Elec' ? 'An MPAN has 13 digits (or 21 with the top line)' : 'Not a recognisable MPAN or MPRN' };
}

function normaliseFuel(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return null;
  if (/^(e|elec|electric|electricity|power|hh|nhh|half hourly.*|non half hourly.*)$/.test(s)) return 'Elec';
  if (/^(g|gas|natural gas)$/.test(s)) return 'Gas';
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function realDate(y, m, d) {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= lastDay(y, m))) return null;
  return iso(y, m, d);
}

// Returns { date: 'YYYY-MM-DD' | null, dayMissing: boolean }. A month with no day ("March 2027")
// uses the last day of the month and is flagged so the rep confirms it on the supplier call.
function parseDate(v) {
  if (v === null || v === undefined || v === '') return { date: null, dayMissing: false };
  if (v instanceof Date && !isNaN(v)) return { date: iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()), dayMissing: false };
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) { // Excel serial day number (1900 date system)
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return { date: iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), dayMissing: false };
    }
    return { date: null, dayMissing: false };
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { date: realDate(+m[1], +m[2], +m[3]), dayMissing: false };
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return { date: realDate(y, +m[2], +m[1]), dayMissing: false }; }
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4})$/i);
  if (m && MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) >= 0) return { date: realDate(+m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1]), dayMissing: false };
  m = s.match(/^([a-z]+)\.?\s+(\d{4})$/i) || s.match(/^(\d{1,2})[/.\-](\d{4})$/);
  if (m) {
    const mon = /^\d+$/.test(m[1]) ? +m[1] : MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    const y = +m[2];
    if (mon >= 1 && mon <= 12) return { date: realDate(y, mon, lastDay(y, mon)), dayMissing: true };
  }
  return { date: null, dayMissing: false };
}

// rows: array of arrays (first non-empty row is the header) as SheetJS gives with header:1.
const HEADERS = {
  number: /mpan|mprn|meter\s*(number|no|id)?|supply\s*number/i,
  fuel: /fuel|utility|type/i,
  ced: /contract\s*end|end\s*date|\bced\b|expiry/i,
};
function parseMeterRows(rows) {
  const out = []; const problems = [];
  const start = rows.findIndex((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim()));
  if (start < 0) return { meters: out, problems: ['The file is empty'] };
  const head = rows[start].map((c) => String(c ?? '').trim());
  const col = {};
  for (const [k, re] of Object.entries(HEADERS)) {
    // the CED pattern is the most specific; check it first so "Contract end date" isn't read as a meter column
    col[k] = head.findIndex((h, i) => re.test(h) && !(k !== 'ced' && HEADERS.ced.test(h)) && !Object.values(col).includes(i));
  }
  if (col.number < 0) return { meters: out, problems: ['No MPAN / MPRN column found. The template has three columns: MPAN / MPRN, Fuel, Contract end date.'] };
  const seen = new Set();
  for (let i = start + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some((c) => String(c ?? '').trim())) continue;
    const line = i + 1;
    const fuelRaw = col.fuel >= 0 ? r[col.fuel] : null;
    const meter = parseMeterNumber(r[col.number], fuelRaw);
    if (fuelRaw && !normaliseFuel(fuelRaw)) problems.push(`Row ${line}: fuel "${fuelRaw}" should be Electricity or Gas`);
    const ced = col.ced >= 0 ? parseDate(r[col.ced]) : { date: null, dayMissing: false };
    if (col.ced >= 0 && String(r[col.ced] ?? '').trim() && !ced.date) problems.push(`Row ${line}: contract end date "${r[col.ced]}" isn't a date (use DD/MM/YYYY)`);
    if (meter.problem) problems.push(`Row ${line}: ${meter.problem}`);
    if (meter.number && seen.has(meter.number)) { problems.push(`Row ${line}: ${meter.number} appears more than once; kept the first`); continue; }
    if (meter.number) seen.add(meter.number);
    out.push({ ...meter, ced: ced.date, cedDayMissing: ced.dayMissing, source: 'Excel', row: line });
  }
  if (!out.length && !problems.length) problems.push('No meter rows found under the header');
  return { meters: out, problems };
}

const addMonths = (isoDate, n) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, Math.min(d, lastDay(t.getUTCFullYear(), t.getUTCMonth() + 1)));
};

// Splits the ticked meters into deals.
//  - electricity with a CED within the quoting window (12 months), already passed, or missing: this deal
//  - gas within the window or with no CED: one new gas deal
//  - anything with a CED beyond the window: one Future Opportunity deal per fuel and CED year
// Unticked meters go nowhere (they're saved to the company only).
// Returns [{ key, kind: 'this'|'gas'|'future', fuel, year?, label, meters, earliestCed, flags }].
function groupMeters(meters, today, windowMonths = 12) {
  const limit = addMonths(today, windowMonths);
  const groups = new Map();
  const put = (key, base, m) => {
    if (!groups.has(key)) groups.set(key, { key, ...base, meters: [], earliestCed: null, flags: [] });
    const g = groups.get(key);
    g.meters.push(m);
    if (m.ced && (!g.earliestCed || m.ced < g.earliestCed)) g.earliestCed = m.ced;
  };
  for (const m of meters.filter((x) => x.included !== false)) {
    const beyond = m.ced && m.ced > limit;
    if (beyond) {
      const year = m.ced.slice(0, 4);
      put(`future-${m.fuel === 'Gas' ? 'gas' : 'elec'}-${year}`, { kind: 'future', fuel: m.fuel, year,
        label: `${m.fuel === 'Gas' ? 'Gas' : 'Electricity'} · CED ${year}` }, m);
    } else if (m.fuel === 'Gas') {
      put('gas', { kind: 'gas', fuel: 'Gas', label: 'Gas' }, m);
    } else {
      put('this', { kind: 'this', fuel: 'Elec', label: 'Electricity' }, m);
    }
  }
  for (const g of groups.values()) {
    const noCed = g.meters.filter((m) => !m.ced).length;
    const passed = g.meters.filter((m) => m.ced && m.ced < today).length;
    if (noCed) g.flags.push(`${noCed} meter${noCed > 1 ? 's have' : ' has'} no contract end date`);
    if (passed) g.flags.push(`${passed} contract end date${passed > 1 ? 's have' : ' has'} passed (possibly out of contract)`);
  }
  // this deal first, then gas, then future deals by year
  const order = { this: 0, gas: 1, future: 2 };
  return [...groups.values()].sort((a, b) => order[a.kind] - order[b.kind] || String(a.year).localeCompare(String(b.year)) || a.fuel.localeCompare(b.fuel));
}

// Address key for grouping meters into Sites: postcode plus the first meaningful address line.
const normPostcode = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const formatPostcode = (p) => { const n = normPostcode(p); return n.length > 3 ? `${n.slice(0, -3)} ${n.slice(-3)}` : n; };
function firstLine(address) {
  const parts = String(address || '').toUpperCase().split(/[,\n]/).map((s) => s.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  // skip a leading business name when the next part starts with a number or UNIT/FLAT/PLOT
  const i = parts.findIndex((p) => /^(\d|UNIT|FLAT|PLOT|SUITE|BLOCK|STAND)/.test(p));
  return parts[i >= 0 ? i : 0] || '';
}
const siteKey = (address, postcode) => `${normPostcode(postcode)}|${firstLine(address)}`;

// Matches a meter's address to one of the company's existing Sites. Postcode must match;
// when several Sites share the postcode, the first address line must match too.
function matchSite(address, postcode, sites) {
  const pc = normPostcode(postcode);
  if (!pc) return null;
  const same = sites.filter((s) => normPostcode(s.postcode) === pc);
  if (same.length === 1) return same[0];
  const line = firstLine(address);
  return same.find((s) => firstLine(s.address) === line) || null;
}

// Supplier name matching: bill text ("British Gas Business", "EDF Energy Customers Ltd") to a canonical name.
const supKey = (s) => String(s || '').toLowerCase().replace(/\b(ltd|limited|plc|uk|business|customers|trading|retail|supply|the)\b/g, '').replace(/[^a-z0-9]/g, '');
function matchSupplier(text, names) {
  const k = supKey(text);
  if (!k) return null;
  return names.find((n) => supKey(n) === k)
    || names.find((n) => supKey(n) && (k.startsWith(supKey(n)) || supKey(n).startsWith(k)))
    || null;
}

// Rates as written into the existing Meter text field "Rates (D 123.45 N 123.45) - Format p/kWh".
function ratesText(r) {
  if (!r) return '';
  const f = (x) => (x === null || x === undefined || x === '' ? null : Number(x).toFixed(2));
  if (f(r.day) && f(r.night)) return `D ${f(r.day)} N ${f(r.night)}`;
  if (f(r.unit)) return `U ${f(r.unit)}`;
  if (f(r.day)) return `D ${f(r.day)}`;
  return '';
}


// Turns the bill reader's result into meter rows the card shows (same shape as Excel rows).
// suppliers: the single list's resolve(text) -> row, or a plain list of names
function billMeters(result, suppliers, source) {
  const supplier = !result.supplier ? null : typeof suppliers === 'function'
    ? ((suppliers(result.supplier) || {}).name || null) : (matchSupplier(result.supplier, suppliers || []) || null);
  return (result.meters || []).map((x) => {
    const meter = parseMeterNumber(x.supply_number, x.fuel);
    const printed = parseDate(x.contract_end_text);
    const ced = printed.date ? printed : parseDate(x.contract_end_date);
    return {
      ...meter, source,
      ced: ced.date, cedDayMissing: ced.dayMissing, cedText: x.contract_end_text || null,
      address: x.site_address || null, postcode: x.postcode ? formatPostcode(x.postcode) : null,
      annualKwh: x.annual_kwh ?? null, rates: x.rates || null,
      billSupplier: result.supplier || null, billSupplierMatch: supplier,
    };
  });
}

// Applies the second reader's check. Where it disagrees, its value is used and the field is
// listed in toCheck so the rep looks at it before saving.
function mergeCheck(meters, check) {
  const byNumber = new Map((check.meters || []).map((c) => [digits(c.supply_number).slice(-13), c]));
  return meters.map((orig) => {
    let m = orig;
    let c = byNumber.get(String(m.number).slice(-13)) || byNumber.get(String(m.number));
    const toCheck = [...(m.toCheck || [])];
    if (!c && !m.valid) {
      // first read got the number wrong: take the second reader's number when it is a valid one of the same fuel
      const fixes = (check.meters || []).map((x) => ({ x, p: parseMeterNumber(x.supply_number, m.fuel) }))
        .filter(({ p }) => p.valid && p.fuel === m.fuel && !meters.some((o) => o.number === p.number));
      if (fixes.length === 1) {
        c = fixes[0].x;
        m = { ...m, number: fixes[0].p.number, valid: true, problem: null, recoveredFrom: m.number };
        toCheck.push('meter number');
      }
    }
    if (!c) return { ...m, checked: false, toCheck: [...toCheck, 'meter number'] };
    const out = { ...m, checked: true };
    if (c.contract_end_date && c.contract_end_date !== m.ced) {
      const d = parseDate(c.contract_end_date);
      if (d.date) { out.ced = d.date; toCheck.push('contract end date'); }
    }
    if (c.contract_end_day_printed === false) out.cedDayMissing = true;
    const r = c.rates || {};
    const before = m.rates || {};
    const changed = ['day', 'night', 'unit', 'standing_charge'].filter((k) => r[k] != null && Number(r[k]) !== Number(before[k]));
    if (changed.length) { out.rates = { ...before, ...Object.fromEntries(changed.map((k) => [k, r[k]])) }; toCheck.push('rates'); }
    if (r.rates_from && !before.rates_from) out.rates = { ...out.rates, rates_from: r.rates_from };
    if (c.notes) out.checkNotes = c.notes;
    out.toCheck = [...new Set(toCheck)];
    return out;
  });
}

// What a meter still needs before Pricing can price it. Region comes from the MPAN itself; the rest
// comes from the bill, the registry, a meter already in HubSpot, or the rep.
// Returns a list of plain names, empty when complete.
const isHH = (m) => (m.profile || m.profileClass) === '00';
function meterTypeOf(m) {
  if (m.meterType) return m.meterType;
  const r = m.rates || {};
  if (r.day != null && r.night != null) return 'Economy 7';
  if (r.unit != null) return 'Standard';
  return null;
}
function missingForPricing(m) {
  if (m.included === false) return [];
  const out = [];
  if (!m.supplier) out.push('current supplier');
  if (!m.ced) out.push('contract end date');
  if (!(Number(m.annualKwh) > 0)) out.push('annual consumption');
  if (m.fuel === 'Gas') {
    if (!m.ldz) out.push('gas zone (LDZ)');
  } else {
    if (!(m.profile || m.profileClass)) out.push('profile class');
    if (isHH(m)) {
      if (!(Number(m.kva) > 0)) out.push('kVA');
      if (!m.voltage) out.push('HH voltage');
    } else if (!meterTypeOf(m)) out.push('meter type');
  }
  return out;
}

// Registry postcode vs the postcode on the bill or Excel. A wrong but check-digit-valid meter number
// comes back from the registry at a different address, so 'mismatch' means: check the meter number.
function postcodeCheck(registry, given) {
  const a = normPostcode(registry), b = normPostcode(given);
  if (!a || !b) return 'missing';
  if (a === b) return 'match';
  if (a.length > 3 && b.length > 3 && a.slice(0, -3) === b.slice(0, -3)) return 'same area';
  return 'mismatch';
}

// Does this meter need the rep to confirm it belongs to the deal's customer? Yes when the registry found it but
// nothing ties its address to this customer (bill postcode, company postcode or one of the company's Sites),
// or when the meter is already in HubSpot under a different company. Same rule in the card.
function ownerCheckNeeded(m) {
  if (!m || m.included === false) return false;
  if (m.otherCompanies && m.otherCompanies.length) return true;
  if (!m.registryAddress && !m.registryPostcode) return false; // registry not used: the rep typed the address
  if (m.registryCheck === 'mismatch') return true;
  if (m.registryCheck === 'match' || m.registryCheck === 'same area') return false;
  return m.companyCheck !== 'match';
}

module.exports = { ownerCheckNeeded, postcodeCheck, missingForPricing, meterTypeOf, isHH, billMeters, mergeCheck, mpanCoreValid, parseMeterNumber, normaliseFuel, parseDate, parseMeterRows, addMonths, groupMeters,
  normPostcode, formatPostcode, siteKey, matchSite, matchSupplier, ratesText };
