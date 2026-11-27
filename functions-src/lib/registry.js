// Registry lookups: Electralink (electricity, by MPAN core) and Xoserve (gas, by MPRN).
//
// Electralink  GET https://api.electralink.co.uk/v1/eac?mpan=<13 digits>
//              headers api-key / api-password (the NHH pair; the HH pair gives 401 here)
//              returns address lines 1-9, post_code, supplier_id (4 letters), supplier_efd,
//              total_eac (blank on HH meters and some new connections), eac_efd
// Xoserve      POST <token url> (client_credentials: client id, secret, scope) -> access_token
//              GET  https://desapi-css-prod.xoserveapis.com/query/v1/switch?meterPointReferenceNumber=<mprn>
//              headers Authorization: Bearer <token>, x-api-key
//              returns a list (or { switchGasData: [...] }) with postcode, postTown, uprn, mpaq,
//              currentSupplierId (3 letters) and name, currentSupplierRegEffectiveDate, meterSerialNumber
//
// Secrets (HubSpot app secrets, never in code or GitHub):
//   ELECTRALINK_NHH_KEY, ELECTRALINK_NHH_PASSWORD
//   XOSERVE_CLIENT_ID, XOSERVE_CLIENT_SECRET, XOSERVE_SCOPE, XOSERVE_TOKEN_URL, XOSERVE_API_KEY
//
// Each lookup returns one of:
//   { status: 'ok', source, supplierCode, supplierName?, supplierSince, address, postcode, annualKwh,
//     eacDate?, profile?, ldz?, exitZone?, uprn?, meterSerial? }
//   { status: 'not_found' }        the registry has no such meter
//   { status: 'not_connected' }    secrets not added yet
//   { status: 'error', message }   anything else (bad credentials, timeout, outage)

const EL_BASE = 'https://api.electralink.co.uk/v1';
const XO_SWITCH = 'https://desapi-css-prod.xoserveapis.com/query/v1/switch';
const TIMEOUT_MS = 6000; // a lookup is ~0.5 s; the whole function must stay under 15 s

const env = (k) => String(process.env[k] || '').trim();
const electralinkConnected = () => !!(env('ELECTRALINK_NHH_KEY') && env('ELECTRALINK_NHH_PASSWORD'));
const xoserveConnected = () => ['XOSERVE_CLIENT_ID', 'XOSERVE_CLIENT_SECRET', 'XOSERVE_SCOPE', 'XOSERVE_TOKEN_URL', 'XOSERVE_API_KEY'].every((k) => !!env(k));

class RegistryError extends Error {}

async function request(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: r.status, body, text };
  } catch (e) {
    throw new RegistryError(e.name === 'AbortError' ? 'timed out' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

const str = (v) => (v == null ? '' : String(v).trim());
const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
// Registry dates come as YYYY-MM-DD, sometimes with a time, sometimes YYYYMMDD
function isoDate(v) {
  const s = str(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
// First value whose key matches, searching one level of nested objects/arrays too
function pick(rec, re) {
  const seen = [rec];
  for (const o of seen) {
    if (!o || typeof o !== 'object') continue;
    for (const [k, v] of Object.entries(o)) {
      if (re.test(k) && v != null && typeof v !== 'object' && str(v)) return v;
    }
    if (seen.length < 20) for (const v of Object.values(o)) if (v && typeof v === 'object') seen.push(...(Array.isArray(v) ? v : [v]));
  }
  return null;
}
const firstRecord = (body) => {
  if (Array.isArray(body)) return body[0] || null;
  if (body && Array.isArray(body.switchGasData)) return body.switchGasData[0] || null;
  if (body && Array.isArray(body.data)) return body.data[0] || null;
  return body && typeof body === 'object' && Object.keys(body).length ? body : null;
};
function failure(service, r) {
  if (r.status === 401 || r.status === 403) return new RegistryError(`${service} rejected the app's credentials (HTTP ${r.status})`);
  if (r.status === 429) return new RegistryError(`${service} is busy, try again in a minute`);
  return new RegistryError(`${service} returned HTTP ${r.status}`);
}

// ---------- Electralink ----------
function parseElectralink(rec) {
  const lines = [];
  for (let i = 1; i <= 9; i++) { const l = str(rec[`metering_point_address_line_${i}`]); if (l) lines.push(l); }
  const postcode = str(rec.post_code || rec.postcode) || null;
  const pcRaw = str(pick(rec, /^(profile_class(_id)?|pc)$/i));
  const profile = /^\d{1,2}$/.test(pcRaw) ? pcRaw.padStart(2, '0') : ''; // blank must never become '00' (half hourly)
  return {
    status: 'ok', source: 'Electralink',
    supplierCode: str(rec.supplier_id).toUpperCase() || null,
    supplierSince: isoDate(rec.supplier_efd),
    address: lines.filter((l) => l.replace(/\s/g, '').toUpperCase() !== (postcode || '').replace(/\s/g, '').toUpperCase()).join(', ') || null,
    postcode,
    annualKwh: num(rec.total_eac),
    eacDate: isoDate(rec.eac_efd),
    profile: /^0[0-8]$/.test(profile) ? profile : null,
  };
}

async function lookupElectricity(mpan) {
  if (!electralinkConnected()) return { status: 'not_connected' };
  const core = String(mpan || '').replace(/\D/g, '');
  if (core.length !== 13) return { status: 'error', message: 'An MPAN core has 13 digits' };
  const r = await request(`${EL_BASE}/eac?mpan=${core}`, {
    headers: { 'api-key': env('ELECTRALINK_NHH_KEY'), 'api-password': env('ELECTRALINK_NHH_PASSWORD'), Accept: 'application/json' },
  });
  if (r.status === 404 || r.status === 204) return { status: 'not_found' };
  if (r.status !== 200) throw failure('Electralink', r);
  const rec = firstRecord(r.body);
  if (!rec || !(rec.post_code || rec.supplier_id || rec.metering_point_address_line_1)) return { status: 'not_found' };
  return parseElectralink(rec);
}

// ---------- Xoserve ----------
let token = null; // { value, expires } reused while the function instance is warm

async function xoserveToken() {
  if (token && token.expires > Date.now() + 30000) return token.value;
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: env('XOSERVE_CLIENT_ID'),
    client_secret: env('XOSERVE_CLIENT_SECRET'), scope: env('XOSERVE_SCOPE') });
  const r = await request(env('XOSERVE_TOKEN_URL'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  if (r.status !== 200 || !r.body?.access_token) {
    throw new RegistryError(r.status === 400 || r.status === 401 ? `Xoserve login was refused (HTTP ${r.status}): check the client ID, secret and scope` : `Xoserve login failed (HTTP ${r.status})`);
  }
  token = { value: r.body.access_token, expires: Date.now() + (Number(r.body.expires_in) || 300) * 1000 };
  return token.value;
}

const ADDRESS_KEYS = [/^(sub)?building(name|number)?$/i, /^(premises|property)(name|number)?$/i, /^organisation(name)?$/i,
  /^(dependent)?thoroughfare(name)?$/i, /^street(name)?\d?$/i, /^(double)?(dependent)?locality$/i, /^addressLine\d$/i, /^postTown$/i, /^county$/i];
function xoserveAddress(rec) {
  const src = (Array.isArray(rec.relAddress) && rec.relAddress[0]) || rec;
  const parts = [];
  for (const re of ADDRESS_KEYS) {
    for (const [k, v] of Object.entries(src)) {
      if (re.test(k) && typeof v !== 'object' && str(v) && !parts.includes(str(v))) parts.push(str(v));
    }
  }
  return parts.join(', ') || null;
}

function parseXoserve(rec) {
  const addr = (Array.isArray(rec.relAddress) && rec.relAddress[0]) || {};
  const ldz = str(pick(rec, /^ldz(id|identifier|code)?$/i)).toUpperCase();
  return {
    status: 'ok', source: 'Xoserve',
    supplierCode: str(rec.currentSupplierId || pick(rec, /^currentSupplier(Id|ShortCode|Code)$/i)).toUpperCase() || null,
    supplierName: str(pick(rec, /^currentSupplier(Name)?$/i)) || null,
    supplierSince: isoDate(rec.currentSupplierRegEffectiveDate || pick(rec, /^currentSupplier.*Effective/i)),
    address: xoserveAddress(rec),
    postcode: str(rec.postcode || addr.postcode) || null,
    annualKwh: num(rec.mpaq),
    ldz: /^[A-Z]{2}$/.test(ldz) ? ldz : null,
    exitZone: str(pick(rec, /^exitZone(Id|Code)?$/i)).toUpperCase() || null,
    uprn: str(rec.uprn || addr.uprn) || null,
    meterSerial: str(rec.meterSerialNumber || pick(rec, /^meterSerialNumber$/i)) || null,
  };
}

async function lookupGas(mprn) {
  if (!xoserveConnected()) return { status: 'not_connected' };
  const n = String(mprn || '').replace(/\D/g, '');
  if (n.length < 6 || n.length > 10) return { status: 'error', message: 'An MPRN has 6 to 10 digits' };
  const call = async () => request(`${XO_SWITCH}?meterPointReferenceNumber=${n}`, {
    headers: { Authorization: `Bearer ${await xoserveToken()}`, 'x-api-key': env('XOSERVE_API_KEY'), Accept: 'application/json' },
  });
  let r = await call();
  if (r.status === 401) { token = null; r = await call(); } // token expired early: log in once more
  if (r.status === 404 || r.status === 204) return { status: 'not_found' };
  if (r.status !== 200) throw failure('Xoserve', r);
  const rec = firstRecord(r.body);
  if (!rec) return { status: 'not_found' };
  return parseXoserve(rec);
}

async function lookup(meter) {
  try {
    return meter.fuel === 'Gas' ? await lookupGas(meter.number) : await lookupElectricity(meter.number);
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

module.exports = { lookup, lookupElectricity, lookupGas, electralinkConnected, xoserveConnected, parseElectralink, parseXoserve,
  _resetToken: () => { token = null; } };
