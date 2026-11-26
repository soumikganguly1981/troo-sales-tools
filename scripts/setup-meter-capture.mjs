// Sets up what Meter Capture needs in one HubSpot account (sandbox or live). Safe to run again:
// it only adds what's missing and never deletes or renames anything.
//  - Meter and Deal properties (group "Meter Capture")
//  - the "Incumbent supplier" dropdown on Meter (mc_current_supplier)
//  - the HubDB table supplier_code_map (registry code -> Utility Click supplier name), seeded from
//    the dropdown's options when the table is empty, then published
//  - adds any supplier in the table that's missing from the dropdown
//  - prints the Meter/Site object type IDs and the deal pipelines and stages
// Env: HUBSPOT_PERSONAL_ACCESS_KEY, HUBSPOT_ACCOUNT_ID, DRY_RUN=true|false
const BASE = 'https://api.hubapi.com';
const PAK = process.env.HUBSPOT_PERSONAL_ACCESS_KEY;
const ACCOUNT = process.env.HUBSPOT_ACCOUNT_ID;
const DRY = String(process.env.DRY_RUN || 'true') !== 'false';
if (!PAK || !ACCOUNT) { console.error('Set HUBSPOT_PERSONAL_ACCESS_KEY and HUBSPOT_ACCOUNT_ID'); process.exit(1); }

let token = null;
async function auth() {
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
  if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  console.log(`  ${what}: done`);
  return r;
};

const opts = (labels) => labels.map((l, i) => ({ label: l, value: l, displayOrder: i, hidden: false }));
const GROUP = { name: 'meter_capture', label: 'Meter Capture', displayOrder: -1 };
const METER_PROPS = [
  { name: 'mcap_supplier_source', label: 'Supplier source (Meter Capture)', type: 'enumeration', fieldType: 'select', options: opts(['Registry', 'Rep override', 'Rep (no registry)']),
    description: 'Where the incumbent supplier came from: the Electralink/Xoserve registry, or the rep.' },
  { name: 'mcap_supplier_override_reason', label: 'Supplier override reason', type: 'string', fieldType: 'textarea',
    description: 'Why the rep saved a different supplier from the registry.' },
  { name: 'mcap_registry_supplier_code', label: 'Registry supplier code', type: 'string', fieldType: 'text', description: 'Supplier code returned by Electralink or Xoserve.' },
  { name: 'mcap_registry_supplier_since', label: 'Registry supplier since', type: 'date', fieldType: 'date', description: 'Date the registry shows the current supplier started.' },
  { name: 'mcap_rates_from', label: 'Incumbent rates from', type: 'date', fieldType: 'date', description: 'Date the incumbent rates on the bill apply from.' },
  { name: 'mcap_capture_source', label: 'Captured from', type: 'enumeration', fieldType: 'select', options: opts(['Bill', 'Photo', 'Excel', 'Manual']), description: 'How the meter was captured.' },
  { name: 'mcap_ced_to_confirm', label: 'CED to confirm', type: 'enumeration', fieldType: 'booleancheckbox',
    options: [{ label: 'Yes', value: 'true', displayOrder: 0 }, { label: 'No', value: 'false', displayOrder: 1 }],
    description: 'Yes when the contract end date was missing or printed without a day: confirm on the supplier call.' },
  { name: 'mcap_captured_on', label: 'Captured on', type: 'date', fieldType: 'date', description: 'Date Meter Capture last saved this meter.' },
  { name: 'mcap_captured_by', label: 'Captured by', type: 'string', fieldType: 'text', description: 'Rep who ran Meter Capture.' },
  { name: 'mcap_capture_deal_id', label: 'Captured on deal', type: 'string', fieldType: 'text', description: 'Deal ID Meter Capture was run on.' },
];
const DEAL_PROPS = [
  { name: 'mcap_status', label: 'Meter Capture status', type: 'enumeration', fieldType: 'select', options: opts(['Not started', 'In progress', 'Complete']), description: 'Set by the Meter Capture app.' },
  { name: 'mcap_draft', label: 'Meter Capture draft', type: 'string', fieldType: 'textarea', formField: false, description: 'Work in progress kept by the Meter Capture app. Do not edit.' },
  { name: 'mcap_meter_count', label: 'Meter count (Meter Capture)', type: 'number', fieldType: 'number', description: 'Meters on this deal after Meter Capture.' },
  { name: 'mcap_total_kwh', label: 'Total consumption kWh (Meter Capture)', type: 'number', fieldType: 'number', description: 'Annual consumption of the meters on this deal.' },
  { name: 'mcap_completed_on', label: 'Meter Capture completed on', type: 'date', fieldType: 'date', description: 'Date Meter Capture last wrote to this deal.' },
  { name: 'mcap_split_from_deal', label: 'Split from deal', type: 'string', fieldType: 'text', description: 'The deal Meter Capture split this deal from.' },
  { name: 'mcap_split_group', label: 'Split group', type: 'string', fieldType: 'text', description: 'Which split this deal holds (gas, or future-elec-2028 etc.). Used so re-runs reuse the deal.' },
];

async function ensureGroup(type) {
  const r = await call('GET', `/crm/v3/properties/${type}/groups/${GROUP.name}`);
  if (r.status === 200) return;
  await write(`create property group "${GROUP.label}" on ${type}`, 'POST', `/crm/v3/properties/${type}/groups`, GROUP);
}
async function ensureProps(type, list) {
  const r = await call('GET', `/crm/v3/properties/${type}?archived=false`);
  if (r.status !== 200) throw new Error(`Couldn't read ${type} properties (${r.status})`);
  const have = new Set(r.body.results.map((p) => p.name));
  for (const p of list) {
    if (have.has(p.name)) { console.log(`  ${type}.${p.name}: exists`); continue; }
    await write(`create ${type}.${p.name}`, 'POST', `/crm/v3/properties/${type}`, { groupName: GROUP.name, ...p });
  }
  return have;
}

async function main() {
  await auth();

  // object types
  const s = await call('GET', '/crm/v3/schemas?archived=false');
  if (s.status !== 200) throw new Error(`Couldn't read custom objects (${s.status}). Give the key the CRM schema scopes.`);
  const find = (re) => s.body.results.find((x) => re.test(x.name));
  const meter = find(/^meters?$/i); const site = find(/^sites?$/i);
  if (!meter || !site) throw new Error('Meter and Site custom objects not found in this account');
  console.log(`Meter object ${meter.objectTypeId} · Site object ${site.objectTypeId}`);

  console.log('\nMeter properties');
  await ensureGroup(meter.objectTypeId);
  const meterHave = await ensureProps(meter.objectTypeId, METER_PROPS);
  for (const n of ['meter_number', 'bottom_line_meter_number__unique_identifier_', 'contract_end_date', 'consumption__kwh_', 'utility', 'postcode', 'rates_unitdaynight_pence_per_kwh', 'rates_standing_charge__pday']) {
    if (!meterHave.has(n)) console.log(`  WARNING: existing Meter property ${n} is missing in this account; Meter Capture skips it`);
  }

  console.log('\nDeal properties');
  await ensureGroup('deals');
  await ensureProps('deals', DEAL_PROPS);

  // supplier dropdown and the HubDB code map
  console.log('\nSupplier list');
  let prop = await call('GET', `/crm/v3/properties/${meter.objectTypeId}/mc_current_supplier`);
  let options = prop.status === 200 ? prop.body.options.filter((o) => !o.hidden).map((o) => o.value) : [];
  const t = await call('GET', '/cms/v3/hubdb/tables/supplier_code_map');
  let rows = [];
  if (t.status === 404) {
    await write('create HubDB table supplier_code_map', 'POST', '/cms/v3/hubdb/tables', {
      name: 'supplier_code_map', label: 'Supplier code map (Meter Capture)', useForPages: false, allowPublicApiAccess: false,
      columns: [
        { name: 'code', label: 'Registry codes (comma separated)', type: 'TEXT' },
        { name: 'name', label: 'Supplier name (Utility Click)', type: 'TEXT' },
        { name: 'fuel', label: 'Fuel (Elec, Gas or Both)', type: 'TEXT' },
        { name: 'trades_with', label: 'Troo trades with', type: 'BOOLEAN' },
        { name: 'notes', label: 'Notes', type: 'TEXT' },
      ],
    });
  } else if (t.status === 200) {
    const r = await call('GET', '/cms/v3/hubdb/tables/supplier_code_map/rows/draft?limit=1000');
    rows = (r.body.results || []).map((x) => x.values);
    console.log(`  supplier_code_map: exists, ${rows.length} rows`);
  } else throw new Error(`Couldn't read HubDB (${t.status}). Give the key the HubDB scope.`);

  if (!rows.length && options.length) {
    const inputs = options.map((name) => ({ values: { name, code: '', fuel: 'Both', trades_with: true, notes: 'Seeded from the Incumbent supplier dropdown: add registry codes' } }));
    for (let i = 0; i < inputs.length; i += 100) await write(`seed ${inputs.slice(i, i + 100).length} suppliers into supplier_code_map`, 'POST', '/cms/v3/hubdb/tables/supplier_code_map/rows/draft/batch/create', { inputs: inputs.slice(i, i + 100) });
    rows = inputs.map((x) => x.values);
  }
  if (t.status === 404 || rows.length) await write('publish supplier_code_map', 'POST', '/cms/v3/hubdb/tables/supplier_code_map/draft/publish');

  const names = [...new Set(rows.map((r) => r.name).filter(Boolean))];
  if (prop.status === 404) {
    await write('create Meter.mc_current_supplier (Incumbent supplier)', 'POST', `/crm/v3/properties/${meter.objectTypeId}`, {
      groupName: GROUP.name, name: 'mc_current_supplier', label: 'Incumbent supplier', type: 'enumeration', fieldType: 'select',
      description: 'Current supplier confirmed by the rep in the Meter Capture app. Options synced from HubDB supplier_code_map.', options: opts(names.sort()),
    });
  } else {
    const missing = names.filter((n) => !options.includes(n));
    if (missing.length) {
      const all = [...prop.body.options, ...missing.map((n, i) => ({ label: n, value: n, displayOrder: prop.body.options.length + i, hidden: false }))];
      await write(`add ${missing.length} supplier(s) to the Incumbent supplier dropdown: ${missing.join(', ')}`, 'PATCH', `/crm/v3/properties/${meter.objectTypeId}/mc_current_supplier`, { options: all });
    } else console.log(`  Incumbent supplier dropdown: ${options.length} options, in step with the table`);
  }

  // pipelines, for choosing the Future Opportunity stage
  console.log('\nDeal pipelines and stages (MC_FUTURE_STAGE in the profile can be set to one of these stage IDs)');
  const p = await call('GET', '/crm/v3/pipelines/deals');
  for (const pl of p.body.results || []) {
    console.log(`  ${pl.label} (${pl.id})`);
    for (const st of pl.stages) console.log(`    ${st.id}  ${st.label}`);
  }
  console.log(DRY ? '\nDry run finished. Run again with dry_run=false to make the changes.' : '\nSetup finished.');
}

main().catch((e) => { console.error(`\nSetup stopped: ${e.message}`); process.exit(1); });
