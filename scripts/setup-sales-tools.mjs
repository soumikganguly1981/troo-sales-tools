// Sets up what the Troo sales tools need in one HubSpot account (sandbox or live). Safe to run again:
// it only adds what's missing and never deletes or renames anything.
//  - the single supplier list: HubDB table supplier_code_map, seeded from hubdb/suppliers.csv
//    (rows already in HubDB are left as Pricing / Kieran edited them)
//  - supplier dropdowns kept in step with that list: Meter "Incumbent supplier" (every supplier)
//    and Deal "Accepted supplier" (suppliers Troo trades with)
//  - Meter Capture properties (Meter and Deal), including the data completeness fields
//  - Deal "Customer requirements" (RFQ playbook) and "Accepted option" (Customer accepted playbook)
//  - prints the Meter/Site object type IDs and the deal pipelines and stages
// Env: HUBSPOT_ACCOUNT_ID, DRY_RUN=true|false, and either HUBSPOT_SETUP_TOKEN (a private app / service key
// token with write scopes, used when the personal access key can only read) or HUBSPOT_PERSONAL_ACCESS_KEY
import { readFileSync } from 'node:fs';
const BASE = 'https://api.hubapi.com';
const PAK = process.env.HUBSPOT_PERSONAL_ACCESS_KEY;
const SETUP_TOKEN = process.env.HUBSPOT_SETUP_TOKEN;
const ACCOUNT = process.env.HUBSPOT_ACCOUNT_ID;
const DRY = String(process.env.DRY_RUN || 'true') !== 'false';
if ((!PAK && !SETUP_TOKEN) || !ACCOUNT) { console.error('Set HUBSPOT_ACCOUNT_ID and HUBSPOT_SETUP_TOKEN or HUBSPOT_PERSONAL_ACCESS_KEY'); process.exit(1); }

let token = null;
async function auth() {
  if (SETUP_TOKEN) { token = SETUP_TOKEN; console.log(`Account ${ACCOUNT} (setup token)${DRY ? ' (DRY RUN: nothing will be changed)' : ''}`); return; }
  const r = await fetch(`${BASE}/localdevauth/v1/auth/refresh?portalId=${ACCOUNT}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ encodedOAuthRefreshToken: PAK }),
  });
  if (!r.ok) { console.error(`Personal access key exchange failed: ${r.status} ${(await r.text()).slice(0, 300)}`); process.exit(1); }
  const j = await r.json();
  token = j.oauthAccessToken;
  console.log(`Account ${ACCOUNT}${DRY ? ' (DRY RUN: nothing will be changed)' : ''}`);
}
async function call(method, path, body) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1000 * 2 ** i)); continue; }
    const text = await r.text();
    let json = {}; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { status: r.status, body: json };
  }
  return { status: 500, body: { message: 'HubSpot unavailable' } };
}
const write = async (what, method, path, body) => {
  if (DRY) { console.log(`  would ${what}`); return { status: 200, body: {} }; }
  const r = await call(method, path, body);
  if (r.status === 403) throw new Error(`${what} failed: the personal access key is missing a permission (${(r.body.message || '').slice(0, 200)}). Give the key that permission, or add a HUBSPOT_SETUP_TOKEN secret (private app token with write scopes) and re-run.`);
  if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  console.log(`  ${what}: done`);
  return r;
};

const soft = async (what, method, path, body) => { // a failure here is reported, not fatal
  try { return await write(what, method, path, body); } catch (e) { console.log(`  WARNING: ${e.message}`); return null; }
};

const opts = (labels) => labels.map((l, i) => ({ label: l, value: l, displayOrder: i, hidden: false }));
const yesNo = [{ label: 'Yes', value: 'true', displayOrder: 0 }, { label: 'No', value: 'false', displayOrder: 1 }];
const GROUPS = {
  mcap: { name: 'meter_capture', label: 'Meter Capture', displayOrder: -1 },
  req: { name: 'customer_requirements', label: 'Customer requirements', displayOrder: -1 },
  ao: { name: 'accepted_option', label: 'Accepted option', displayOrder: -1 },
  mp: { name: 'matrix_pricing', label: 'Matrix pricing', displayOrder: -1 },
};
const PROFILES = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
const METER_PROPS = [
  { g: 'mcap', name: 'mcap_supplier_source', label: 'Supplier source (Meter Capture)', type: 'enumeration', fieldType: 'select', options: opts(['Registry', 'Rep override', 'Rep (no registry)']),
    description: 'Where the incumbent supplier came from: the Electralink/Xoserve registry, or the rep.' },
  { g: 'mcap', name: 'mcap_supplier_override_reason', label: 'Supplier override reason', type: 'string', fieldType: 'textarea', description: 'Why the rep saved a different supplier from the registry.' },
  { g: 'mcap', name: 'mcap_registry_supplier_code', label: 'Registry supplier code', type: 'string', fieldType: 'text', description: 'Supplier code returned by Electralink or Xoserve.' },
  { g: 'mcap', name: 'mcap_registry_supplier_since', label: 'Registry supplier since', type: 'date', fieldType: 'date', description: 'Date the registry shows the current supplier started.' },
  { g: 'mcap', name: 'mcap_rates_from', label: 'Incumbent rates from', type: 'date', fieldType: 'date', description: 'Date the incumbent rates on the bill apply from.' },
  { g: 'mcap', name: 'mcap_capture_source', label: 'Captured from', type: 'enumeration', fieldType: 'select', options: opts(['Bill', 'Photo', 'Excel', 'Manual']), description: 'How the meter was captured.' },
  { g: 'mcap', name: 'mcap_ced_to_confirm', label: 'CED to confirm', type: 'enumeration', fieldType: 'booleancheckbox', options: yesNo,
    description: 'Yes when the contract end date was missing or printed without a day: confirm on the supplier call.' },
  { g: 'mcap', name: 'mcap_captured_on', label: 'Captured on', type: 'date', fieldType: 'date', description: 'Date Meter Capture last saved this meter.' },
  { g: 'mcap', name: 'mcap_captured_by', label: 'Captured by', type: 'string', fieldType: 'text', description: 'Rep who ran Meter Capture.' },
  { g: 'mcap', name: 'mcap_capture_deal_id', label: 'Captured on deal', type: 'string', fieldType: 'text', description: 'Deal ID Meter Capture was run on.' },
  { g: 'mcap', name: 'mcap_missing', label: 'Data missing for pricing', type: 'string', fieldType: 'textarea',
    description: 'What this meter still needs before it can be priced (set by Meter Capture). Empty when complete.' },
  { g: 'mcap', name: 'mp_profile_class', label: 'Profile class', type: 'enumeration', fieldType: 'select', options: opts(PROFILES),
    description: 'Electricity profile class (00 = half hourly). From the MPAN top line, or entered in Meter Capture when only the profile is known.' },
];
// Meter fields Pricing reads, as defined in the live account (created only where missing, e.g. a sandbox made before they were added)
const PRICING_METER_PROPS = [
  { g: 'mp', name: 'mp_gas_ldz', label: 'Gas zone (LDZ)', type: 'string', fieldType: 'text', description: 'Gas local distribution zone (EA, EM, NE ...). Pricing needs it for gas.' },
  { g: 'mp', name: 'mp_gas_exit_zone', label: 'Gas exit zone', type: 'string', fieldType: 'text', description: 'Gas exit zone, for suppliers that price by exit zone.' },
  { g: 'mp', name: 'mp_day_share_pct', label: 'Day usage share (%)', type: 'number', fieldType: 'number', description: 'Share of usage on the day rate, for day/night meters.' },
  { g: 'mp', name: 'mp_band', label: 'Network charging band', type: 'enumeration', fieldType: 'select', options: opts(['1', '2', '3', '4']), description: 'Electricity network charging band.' },
  { g: 'mp', name: 'mp_hh_voltage', label: 'HH voltage type', type: 'enumeration', fieldType: 'select', options: opts(['Low voltage', 'LV substation', 'LV network non-CT', 'High voltage']), description: 'Half-hourly connection voltage.' },
  { g: 'mp', name: 'mp_metering', label: 'Metering (whole current / CT)', type: 'enumeration', fieldType: 'select', options: opts(['Whole current', 'CT']), description: 'Half-hourly metering type.' },
  { g: 'mp', name: 'kva', label: 'kVA', type: 'number', fieldType: 'number', description: 'Agreed supply capacity (half-hourly).' },
  { g: 'mp', name: 'top_line_meter_number', label: 'Top Line Meter Number', type: 'string', fieldType: 'text', description: 'MPAN top line: profile class, meter time switch code, line loss factor.' },
  { g: 'mp', name: 'latest_end_date', label: 'Latest End Date', type: 'date', fieldType: 'date', description: 'Latest contract end date, including extensions.' },
];
const DEAL_PROPS = [
  // Meter Capture
  { g: 'mcap', name: 'mcap_status', label: 'Meter Capture status', type: 'enumeration', fieldType: 'select', options: opts(['Not started', 'In progress', 'Complete']), description: 'Set by the Meter Capture app.' },
  { g: 'mcap', name: 'mcap_draft', label: 'Meter Capture draft', type: 'string', fieldType: 'textarea', formField: false, description: 'Work in progress kept by the Meter Capture app. Do not edit.' },
  { g: 'mcap', name: 'mcap_meter_count', label: 'Meter count (Meter Capture)', type: 'number', fieldType: 'number', description: 'Meters on this deal after Meter Capture.' },
  { g: 'mcap', name: 'mcap_total_kwh', label: 'Total consumption kWh (Meter Capture)', type: 'number', fieldType: 'number', description: 'Annual consumption of the meters on this deal.' },
  { g: 'mcap', name: 'mcap_completed_on', label: 'Meter Capture completed on', type: 'date', fieldType: 'date', description: 'Date Meter Capture last wrote to this deal.' },
  { g: 'mcap', name: 'mcap_split_from_deal', label: 'Split from deal', type: 'string', fieldType: 'text', description: 'The deal Meter Capture split this deal from.' },
  { g: 'mcap', name: 'mcap_split_group', label: 'Split group', type: 'string', fieldType: 'text', description: 'Which split this deal holds (gas, or future-elec-2028 etc.). Used so re-runs reuse the deal.' },
  { g: 'mcap', name: 'mcap_data_complete', label: 'Meter data complete', type: 'enumeration', fieldType: 'booleancheckbox', options: yesNo,
    description: 'Yes when every meter on the deal has what pricing needs. The check before RFQ uses it.' },
  { g: 'mcap', name: 'mcap_data_missing', label: 'Meter data missing', type: 'string', fieldType: 'textarea', description: 'Which meters still need data for pricing, and what.' },
  // Customer requirements (RFQ playbook)
  { g: 'req', name: 'req_priority', label: 'What matters most to the customer', type: 'enumeration', fieldType: 'select', options: opts(['Fixed price', 'Lowest price', 'Green energy', 'Flexible']), description: 'From the RFQ playbook.' },
  { g: 'req', name: 'req_contract_lengths', label: 'Contract lengths wanted', type: 'enumeration', fieldType: 'checkbox',
    options: [12, 24, 36, 48, 60].map((m, i) => ({ label: `${m} months`, value: String(m), displayOrder: i })), description: 'Contract lengths the customer would consider. Pricing prices these.' },
  { g: 'req', name: 'req_start_type', label: 'New contract starts', type: 'enumeration', fieldType: 'select', options: opts(['Day after current contract ends', 'Change of tenancy']), description: 'From the RFQ playbook.' },
  { g: 'req', name: 'req_start_date', label: 'Requested start date', type: 'date', fieldType: 'date', description: 'Day after the current contract ends, or the move-in date for a change of tenancy. Pricing uses it.' },
  { g: 'req', name: 'req_green', label: 'Green energy', type: 'enumeration', fieldType: 'select', options: opts(['Not needed', 'Green tariff', 'REGO-backed']), description: 'From the RFQ playbook.' },
  { g: 'req', name: 'req_payment_method', label: 'Payment method', type: 'enumeration', fieldType: 'select', options: opts(['Direct Debit', 'Other']), description: 'How the customer will pay. Some prices need Direct Debit.' },
  { g: 'req', name: 'req_partner_deal', label: 'Partner deal', type: 'enumeration', fieldType: 'booleancheckbox', options: yesNo, description: 'Whether the deal came through a partner (sponsorship is set at Customer accepted).' },
  { g: 'req', name: 'req_credit_check_agreed', label: 'Credit check agreed', type: 'enumeration', fieldType: 'booleancheckbox', options: yesNo, description: 'The customer agreed to a credit check.' },
  // Accepted option (Customer accepted playbook) - copied to each meter's Contract record at lock-in
  { g: 'ao', name: 'ao_supplier', label: 'Accepted supplier', type: 'enumeration', fieldType: 'select', options: [], description: 'Supplier of the option the customer accepted. Options come from the supplier list (suppliers Troo trades with).' },
  { g: 'ao', name: 'ao_product', label: 'Accepted product', type: 'string', fieldType: 'text', description: 'Supplier product of the accepted option.' },
  { g: 'ao', name: 'ao_price_route', label: 'Price route', type: 'enumeration', fieldType: 'select', options: opts(['Matrix', 'Bespoke']), description: 'Where the accepted price came from.' },
  { g: 'ao', name: 'ao_contract_length_months', label: 'Accepted contract length (months)', type: 'number', fieldType: 'number', description: 'Length of the accepted contract.' },
  { g: 'ao', name: 'ao_start_date', label: 'Accepted start date', type: 'date', fieldType: 'date', description: 'Start date of the accepted contract.' },
  { g: 'ao', name: 'ao_unit_uplift_p', label: 'Commission (p/kWh)', type: 'number', fieldType: 'number', description: 'Unit rate commission on the accepted option.' },
  { g: 'ao', name: 'ao_sc_uplift_p', label: 'Standing charge commission (p/day)', type: 'number', fieldType: 'number', description: 'Standing charge commission per meter on the accepted option.' },
  { g: 'ao', name: 'ao_partner_sponsorship_pct', label: 'Partner sponsorship (%)', type: 'number', fieldType: 'number', description: '10 to 20 on partner deals, 0 otherwise.' },
  { g: 'ao', name: 'ao_credit_check', label: 'Credit check result', type: 'enumeration', fieldType: 'select', options: opts(['Passed', 'Passed with deposit', 'Failed']), description: 'From the Customer accepted playbook.' },
  { g: 'ao', name: 'ao_accepted_how', label: 'How the customer accepted', type: 'enumeration', fieldType: 'select', options: opts(['Email, logged to the deal', 'Recorded call']), description: 'From the Customer accepted playbook.' },
  { g: 'ao', name: 'ao_commission_disclosed', label: 'Commission disclosed', type: 'enumeration', fieldType: 'booleancheckbox', options: yesNo, description: 'The Closer told the customer the commission over the contract.' },
];
// Worked out by HubSpot from the fields above (soft: reported, not fatal, if the account refuses a formula)
const GROSS = '(mcap_total_kwh * ao_unit_uplift_p / 100 + ao_sc_uplift_p * 3.65 * mcap_meter_count) * ao_contract_length_months / 12';
const DEAL_CALCS = [
  { g: 'ao', name: 'ao_gross_revenue', label: 'Accepted gross revenue (£)', type: 'number', fieldType: 'calculation_equation', calculationFormula: GROSS,
    description: 'Commission over the contract: usage × unit commission plus standing charge commission, for the contract length.' },
  { g: 'ao', name: 'ao_net_revenue', label: 'Accepted net revenue (£)', type: 'number', fieldType: 'calculation_equation', calculationFormula: `${GROSS} * (100 - ao_partner_sponsorship_pct) / 100`,
    description: 'Gross revenue less the partner sponsorship.' },
];
const TABLE = 'supplier_code_map';
const TABLE_COLUMNS = [
  { name: 'name', label: 'Supplier name (Utility Click)', type: 'TEXT' },
  { name: 'trades_with', label: 'Troo trades with', type: 'BOOLEAN' },
  { name: 'stips_group', label: 'Stipulation supplier group', type: 'TEXT' },
  { name: 'pricebook_codes', label: 'Price-book file codes', type: 'TEXT' },
  { name: 'registry_codes', label: 'Registry codes (Electralink / Xoserve)', type: 'TEXT' },
  { name: 'aliases', label: 'Other names it appears as', type: 'TEXT' },
  { name: 'tier', label: 'Payment tier (P, 1-4)', type: 'TEXT' },
  { name: 'notes', label: 'Notes', type: 'TEXT' },
];

function readCsv(path) {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8');
  const [head, ...lines] = text.split(/\r?\n/).filter((l) => l.trim());
  const cols = head.split(',');
  return lines.map((l) => { const v = l.split(','); return Object.fromEntries(cols.map((c, i) => [c, (v[i] || '').trim()])); });
}

async function ensureGroup(type, g) {
  const r = await call('GET', `/crm/v3/properties/${type}/groups/${g.name}`);
  if (r.status === 200) return;
  await write(`create property group "${g.label}" on ${type}`, 'POST', `/crm/v3/properties/${type}/groups`, g);
}
async function ensureProps(type, list, { softly = false } = {}) {
  const r = await call('GET', `/crm/v3/properties/${type}?archived=false`);
  if (r.status !== 200) throw new Error(`Couldn't read ${type} properties (${r.status})`);
  const have = new Set(r.body.results.map((p) => p.name));
  for (const { g, ...p } of list) {
    if (have.has(p.name)) { console.log(`  ${type}.${p.name}: exists`); continue; }
    await (softly ? soft : write)(`create ${type}.${p.name}`, 'POST', `/crm/v3/properties/${type}`, { groupName: GROUPS[g].name, ...p });
  }
  return have;
}
// Keeps a dropdown's options in step with a list of names: adds missing ones, hides ones no longer in
// the list, never deletes (old records keep their value).
async function syncDropdown(type, name, label, names) {
  const prop = await call('GET', `/crm/v3/properties/${type}/${name}`);
  if (prop.status !== 200) { console.log(`  ${label}: property ${name} not found, skipped`); return; }
  const current = prop.body.options || [];
  const values = new Set(current.map((o) => o.value));
  const add = names.filter((n) => !values.has(n));
  const hide = current.filter((o) => !o.hidden && o.value && !names.includes(o.value)).map((o) => o.value);
  const show = current.filter((o) => o.hidden && names.includes(o.value)).map((o) => o.value);
  if (!add.length && !hide.length && !show.length) { console.log(`  ${label}: ${names.length} options, in step with the supplier list`); return; }
  const options = [...current.map((o) => ({ ...o, hidden: names.includes(o.value) ? false : (hide.includes(o.value) ? true : o.hidden) })),
    ...add.map((n, i) => ({ label: n, value: n, displayOrder: current.length + i, hidden: false }))];
  await write(`${label}: add ${add.length}, hide ${hide.length}, show ${show.length}${add.length ? ` (adding ${add.slice(0, 8).join(', ')}${add.length > 8 ? '…' : ''})` : ''}`,
    'PATCH', `/crm/v3/properties/${type}/${name}`, { options });
}

async function supplierList() {
  console.log('\nSupplier list (HubDB supplier_code_map)');
  const seed = readCsv('../hubdb/suppliers.csv');
  const t = await call('GET', `/cms/v3/hubdb/tables/${TABLE}/draft`);
  let rows = [];
  if (t.status === 404) {
    await write(`create HubDB table ${TABLE}`, 'POST', '/cms/v3/hubdb/tables',
      { name: TABLE, label: 'Supplier list (single list for all sales tools)', useForPages: false, allowPublicApiAccess: false, columns: TABLE_COLUMNS });
  } else if (t.status === 200) {
    const have = new Set((t.body.columns || []).map((c) => c.name));
    const missing = TABLE_COLUMNS.filter((c) => !have.has(c.name));
    if (missing.length) {
      await write(`add column(s) ${missing.map((c) => c.name).join(', ')} to ${TABLE}`, 'PATCH', `/cms/v3/hubdb/tables/${TABLE}/draft`,
        { columns: [...t.body.columns, ...missing] });
    }
    let after = null;
    do {
      const r = await call('GET', `/cms/v3/hubdb/tables/${TABLE}/rows/draft?limit=1000${after ? `&after=${after}` : ''}`);
      rows.push(...(r.body.results || []).map((x) => x.values));
      after = r.body.paging?.next?.after || null;
    } while (after);
    console.log(`  ${TABLE}: exists, ${rows.length} rows`);
  } else throw new Error(`Couldn't read HubDB (${t.status}). Give the key the HubDB scope.`);

  const known = new Set(rows.map((r) => String(r.name || '').toLowerCase()));
  const add = seed.filter((r) => r.name && !known.has(r.name.toLowerCase()));
  const inputs = add.map((r) => ({ values: { ...r, trades_with: r.trades_with === 'true' } }));
  for (let i = 0; i < inputs.length; i += 100) {
    await write(`add ${inputs.slice(i, i + 100).length} supplier(s) from suppliers.csv`, 'POST', `/cms/v3/hubdb/tables/${TABLE}/rows/draft/batch/create`, { inputs: inputs.slice(i, i + 100) });
  }
  if (t.status === 404 || inputs.length || (t.status === 200 && TABLE_COLUMNS.some((c) => !(t.body.columns || []).some((x) => x.name === c.name)))) {
    await write(`publish ${TABLE}`, 'POST', `/cms/v3/hubdb/tables/${TABLE}/draft/publish`);
  }
  const all = [...rows, ...inputs.map((x) => x.values)].filter((r) => r.name);
  const truthy = (v) => v === true || v === 1 || String(v).toLowerCase() === 'true';
  return { names: [...new Set(all.map((r) => r.name))].sort(), tradesWith: [...new Set(all.filter((r) => truthy(r.trades_with)).map((r) => r.name))].sort() };
}

async function main() {
  await auth();

  const s = await call('GET', '/crm/v3/schemas?archived=false');
  if (s.status !== 200) throw new Error(`Couldn't read custom objects (${s.status}). Give the key the CRM schema scopes.`);
  const find = (re) => s.body.results.find((x) => re.test(x.name));
  const meter = find(/^meters?$/i); const site = find(/^sites?$/i);
  if (!meter || !site) throw new Error('Meter and Site custom objects not found in this account');
  console.log(`Meter object ${meter.objectTypeId} · Site object ${site.objectTypeId}`);

  const suppliers = await supplierList();

  console.log('\nMeter properties');
  await ensureGroup(meter.objectTypeId, GROUPS.mcap);
  await ensureGroup(meter.objectTypeId, GROUPS.mp);
  const meterHave = await ensureProps(meter.objectTypeId, [...METER_PROPS, ...PRICING_METER_PROPS]);
  for (const n of ['meter_number', 'bottom_line_meter_number__unique_identifier_', 'contract_end_date', 'consumption__kwh_', 'utility', 'postcode', 'rates_unitdaynight_pence_per_kwh', 'rates_standing_charge__pday', 'meter_type', 'aq']) {
    if (!meterHave.has(n)) console.log(`  WARNING: existing Meter property ${n} is missing in this account; the apps skip it`);
  }
  if (!meterHave.has('mc_current_supplier')) {
    await write('create Meter.mc_current_supplier (Incumbent supplier)', 'POST', `/crm/v3/properties/${meter.objectTypeId}`, {
      groupName: GROUPS.mcap.name, name: 'mc_current_supplier', label: 'Incumbent supplier', type: 'enumeration', fieldType: 'select',
      description: 'Current supplier confirmed by the rep in Meter Capture. Options come from the supplier list (HubDB supplier_code_map).', options: opts(suppliers.names) });
  }

  console.log('\nDeal properties');
  for (const g of [GROUPS.mcap, GROUPS.req, GROUPS.ao]) await ensureGroup('deals', g);
  const dealHave = await ensureProps('deals', DEAL_PROPS.map((p) => (p.name === 'ao_supplier' ? { ...p, options: opts(suppliers.tradesWith) } : p)));
  await ensureProps('deals', DEAL_CALCS, { softly: true });
  if (dealHave.has('tier')) {
    const tier = await call('GET', '/crm/v3/properties/deals/tier');
    if (tier.status === 200 && !tier.body.options.some((o) => o.value === '4')) {
      await soft('add payment tier 4 to Deal.tier', 'PATCH', '/crm/v3/properties/deals/tier', { options: [...tier.body.options, { label: '4', value: '4', displayOrder: tier.body.options.length, hidden: false }] });
    }
  }

  console.log('\nSupplier dropdowns');
  await syncDropdown(meter.objectTypeId, 'mc_current_supplier', 'Meter "Incumbent supplier" (every supplier)', suppliers.names);
  await syncDropdown('deals', 'ao_supplier', 'Deal "Accepted supplier" (suppliers Troo trades with)', suppliers.tradesWith);

  console.log('\nDeal pipelines and stages (MC_FUTURE_STAGE in the profile can be set to one of these stage IDs)');
  const p = await call('GET', '/crm/v3/pipelines/deals');
  for (const pl of p.body.results || []) {
    console.log(`  ${pl.label} (${pl.id})`);
    for (const st of pl.stages) console.log(`    ${st.id}  ${st.label}`);
  }
  console.log(DRY ? '\nDry run finished. Run again with dry_run=false to make the changes.' : '\nSetup finished.');
}

main().catch((e) => { console.error(`\nSetup stopped: ${e.message}`); process.exit(1); });
