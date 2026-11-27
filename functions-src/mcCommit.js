// app function uid: mc_commit
// parameters: { dealId, meters: [...from the card], futureStage?: 'auto' | stageId, by, today?, preview? }
// preview: true returns what would be written (groups, new/matched Sites and Meters) without writing.
// "Add to HubSpot": writes Sites, Meters, links and deals in one go. No Contract records.
//  - Sites: matched to the company's Sites by postcode and address, otherwise created
//  - Meters: matched by meter number (existing ones are updated and linked, never duplicated)
//  - Deals: this deal keeps electricity inside the quoting window; gas and later CEDs go to new
//    deals that copy this deal's details, contacts and notes. Re-running finds the same split
//    deals again (mcap_split_from_deal + mcap_split_group), so nothing is created twice.
//  - Unticked meters are saved to the company and Site but left off every deal.
const { api, ok, fail } = require('./lib/http');
const crm = require('./lib/crm');
const { groupMeters, matchSite, siteKey, formatPostcode, ratesText, missingForPricing, meterTypeOf, isHH, ownerCheckNeeded } = require('./lib/meters');

const MAX = 150;
const SKIP_COPY = /^(hs_|mcap_|num_|days_to_close|dealname$|pipeline$|dealstage$|amount$|amount_in_home_currency$|closedate$|createdate$|ced_group_date$|mp_quote_shortlist$|contract_loss_applied$)/;

const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));

async function existingProps(type) {
  const r = await api('GET', `/crm/v3/properties/${type}?archived=false`);
  return new Set(r.status === 200 ? (r.body.results || []).map((x) => x.name) : []);
}
const only = (props, allowed, dropped) => Object.fromEntries(Object.entries(props).filter(([k]) => {
  if (allowed.has(k)) return true; dropped.add(k); return false;
}));

const lookupResult = (m) => {
  if (!m.registryAddress && !m.registryPostcode) return /no record/.test(m.registryNote || '') ? 'Not found' : 'Not checked';
  if (m.registryCheck === 'match') return 'Matched';
  if (m.registryCheck === 'same area') return 'Same area';
  if (m.registryCheck === 'mismatch') return 'Postcode mismatch, checked by rep';
  if (m.companyCheck === 'match') return "Matched a company address";
  return 'Address not confirmed by registry, checked by rep';
};

function meterProps(m, ctx) {
  const r = m.rates || {};
  const meterType = meterTypeOf(m);
  const missing = missingForPricing({ ...m, included: true });
  const source = m.supplier && m.registrySupplier && m.supplier !== m.registrySupplier ? 'Rep override'
    : m.registrySupplier ? 'Registry' : m.supplier ? 'Rep (no registry)' : null;
  return { ...clean({
    utility: m.fuel === 'Gas' ? 'Gas' : (isHH(m) ? 'HH' : 'NHH'),
    meter_number: m.number,
    bottom_line_meter_number__unique_identifier_: m.number,
    top_line_meter_number: m.topLine,
    contract_end_date: m.ced,
    consumption__kwh_: m.annualKwh,
    aq: m.fuel === 'Gas' ? m.annualKwh : null,
    postcode: m.postcode ? formatPostcode(m.postcode) : null,
    meter_type: m.fuel === 'Gas' || isHH(m) ? null : meterType,
    mp_profile_class: m.fuel === 'Gas' ? null : (m.profile || m.profileClass),
    mp_gas_ldz: m.fuel === 'Gas' ? m.ldz : null,
    kva: isHH(m) ? m.kva : null,
    mp_hh_voltage: isHH(m) ? m.voltage : null,
    mc_current_supplier: m.supplier && ctx.supplierOptions.includes(m.supplier) ? m.supplier : null,
    rates_unitdaynight_pence_per_kwh: ratesText(r) || null,
    rates_standing_charge__pday: r.standing_charge,
    mcap_rates_from: r.rates_from,
    mcap_supplier_source: source,
    mcap_supplier_override_reason: source === 'Rep override' ? m.overrideReason : null,
    mcap_registry_supplier_code: m.registryCode,
    mcap_registry_supplier_since: m.registrySince,
    mcap_lookup_result: lookupResult(m),
    mcap_capture_source: m.source,
    mcap_ced_to_confirm: m.ced ? (m.cedDayMissing ? 'true' : 'false') : 'true',
    mcap_captured_on: ctx.today,
    mcap_captured_by: ctx.by,
    mcap_capture_deal_id: ctx.dealId,
  }), mcap_missing: missing.join(', ') }; // empty clears an old list once the meter is complete
}

exports.main = async (context) => {
  const warnings = [];
  try {
    const p = context.parameters || {};
    const dealId = String(p.dealId || '');
    if (!/^\d+$/.test(dealId)) return fail(400, 'Missing deal ID');
    const all = (Array.isArray(p.meters) ? p.meters : []).filter((m) => m && m.number);
    if (!all.length) return fail(400, 'No meters to add');
    if (all.length > MAX) return fail(400, `Up to ${MAX} meters at a time`);
    const bad = all.filter((m) => m.included !== false && m.valid === false);
    if (bad.length) return fail(400, `Fix or untick these meter numbers first: ${bad.map((m) => m.number).join(', ')}`);
    const noReason = all.filter((m) => m.included !== false && m.registrySupplier && m.supplier !== m.registrySupplier && String(m.overrideReason || '').trim().length < 4);
    if (noReason.length) return fail(400, `Give a reason for changing the registry supplier on ${noReason.map((m) => m.number).join(', ')}`);
    const unchecked = all.filter((m) => ownerCheckNeeded(m) && !m.mismatchChecked);
    if (unchecked.length) return fail(400, `Confirm ${unchecked.map((m) => m.number).join(', ')} belongs to this customer first: the registry address or the meter's current company doesn't match`);

    const today = /^\d{4}-\d{2}-\d{2}$/.test(p.today || '') ? p.today : londonToday();
    const by = String(p.by || '').slice(0, 100);
    const types = await crm.objectTypes();

    // the deal and its company
    const dealProps = await crm.writableDealProperties();
    const [orig] = await crm.batchRead('deals', [dealId], [...new Set([...dealProps, 'dealname', 'pipeline', 'dealstage', 'hubspot_owner_id'])]);
    if (!orig) return fail(404, 'Deal not found');
    const od = orig.properties;
    const companyIds = await crm.associatedIds('deals', dealId, 'companies');
    if (!companyIds.length) return fail(400, 'Link the company to this deal first: Sites and Meters are saved to it');
    const companyId = companyIds[0];
    const company = await api('GET', `/crm/v3/objects/companies/${companyId}?properties=name`);
    const companyName = company.body?.properties?.name || String(od.dealname || '').split(' - ')[0] || 'Company';

    const [meterAllowed, siteAllowed, dealAllowed] = await Promise.all([existingProps(types.meters), existingProps(types.sites), existingProps('deals')]);
    const dropped = new Set();
    const supplierOptions = await crm.propertyOptions(types.meters, 'mc_current_supplier');
    const ctx = { today, by, dealId, supplierOptions };

    // 1. Sites
    const siteIds = await crm.associatedIds('companies', companyId, types.sites);
    const sites = (await crm.batchRead(types.sites, siteIds, ['address', 'postal_code', 'site_name']))
      .map((s) => ({ id: s.id, address: s.properties.address || '', postcode: s.properties.postal_code || '' }));
    const newSites = new Map(); // siteKey -> { address, postcode }
    const siteFor = new Map();  // meter number -> site id or siteKey (resolved after create)
    for (const m of all) {
      if (!m.postcode) continue;
      const hit = matchSite(m.address, m.postcode, sites);
      if (hit) { siteFor.set(m.number, hit.id); continue; }
      const key = siteKey(m.address, m.postcode);
      if (!newSites.has(key)) newSites.set(key, { address: m.address || '', postcode: formatPostcode(m.postcode) });
      siteFor.set(m.number, `key:${key}`);
    }
    const noSite = all.filter((m) => !m.postcode).map((m) => m.number);
    if (noSite.length) warnings.push(`No postcode, so no Site for: ${noSite.join(', ')}`);
    // which meters are already in HubSpot (matched by meter number)
    const numbers = all.map((m) => String(m.number));
    const found = [...await crm.searchIn(types.meters, 'meter_number', numbers, ['meter_number']),
      ...await crm.searchIn(types.meters, 'bottom_line_meter_number__unique_identifier_', numbers, ['bottom_line_meter_number__unique_identifier_'])];
    const idFor = new Map();
    for (const f of found) {
      const n = f.properties.meter_number || f.properties.bottom_line_meter_number__unique_identifier_;
      if (n && !idFor.has(String(n).trim())) idFor.set(String(n).trim(), f.id);
    }
    const groups = groupMeters(all, today);
    if (p.preview) {
      const fut = groups.some((g) => g.kind === 'future') ? await crm.futureStage(od.pipeline, od.dealstage, p.futureStage || 'auto') : null;
      const splits = await crm.searchIn('deals', 'mcap_split_from_deal', [dealId], ['mcap_split_group']).catch(() => []);
      const have = new Set(splits.map((d) => d.properties.mcap_split_group));
      return ok({ preview: true, companyName,
        groups: groups.map((g) => ({ key: g.key, kind: g.kind, label: g.label, meters: g.meters.map((m) => m.number), earliestCed: g.earliestCed, flags: g.flags,
          dealName: g.kind === 'this' ? od.dealname : `${companyName} - ${g.label}`, exists: g.kind === 'this' || have.has(g.key),
          missing: g.meters.map((m) => [m.number, missingForPricing({ ...m, included: true })]).filter(([, x]) => x.length).map(([n, x]) => `${n}: ${x.join(', ')}`),
          stage: g.kind === 'future' ? (fut.parked ? fut.label : `${fut.label} (no Future Opportunity stage yet)`) : null })),
        sites: { new: newSites.size, matched: new Set([...siteFor.values()].filter((v) => !v.startsWith('key:'))).size, newList: [...newSites.values()] },
        meters: { new: all.filter((m) => !idFor.has(String(m.number))).length, existing: all.filter((m) => idFor.has(String(m.number))).length,
          unticked: all.filter((m) => m.included === false).length },
        warnings });
    }

    // writes start here
    if (newSites.size) {
      const inputs = [...newSites.values()].map((s) => ({ properties: only(clean({
        address: s.address, postal_code: s.postcode,
        site_name: (s.address.split(',').find((x) => /\d|unit|plot|flat/i.test(x)) || s.address.split(',')[0] || s.postcode).trim(),
      }), siteAllowed, dropped) }));
      const created = await crm.batch(types.sites, 'create', inputs);
      const keys = [...newSites.keys()];
      created.forEach((s, i) => newSites.get(keys[i]).id = s.id);
      await crm.associate(types.sites, 'companies', created.map((s) => [s.id, companyId]));
    }
    const resolveSite = (n) => { const v = siteFor.get(n); return v && v.startsWith('key:') ? newSites.get(v.slice(4)).id : v || null; };

    // 2. Meters: update the ones already in HubSpot, create the rest
    const updates = all.filter((m) => idFor.has(String(m.number)));
    const creates = all.filter((m) => !idFor.has(String(m.number)));
    if (updates.length) await crm.batch(types.meters, 'update', updates.map((m) => ({ id: idFor.get(String(m.number)), properties: only(meterProps(m, ctx), meterAllowed, dropped) })));
    if (creates.length) {
      const made = await crm.batch(types.meters, 'create', creates.map((m) => ({ properties: only(meterProps(m, ctx), meterAllowed, dropped) })));
      made.forEach((x, i) => idFor.set(String(creates[i].number), x.id));
    }
    const meterSite = all.map((m) => [idFor.get(String(m.number)), resolveSite(m.number)]).filter(([a, b]) => a && b);
    if (meterSite.length) await crm.associate(types.meters, types.sites, meterSite);
    try { await crm.associate(types.meters, 'companies', all.map((m) => [idFor.get(String(m.number)), companyId])); }
    catch { /* no Meter-Company association in this account: the Site links the meter to the company */ }

    // 3. Deals
    const existingSplits = await crm.searchIn('deals', 'mcap_split_from_deal', [dealId], ['mcap_split_group', 'dealname']).catch(() => []);
    const splitByKey = new Map(existingSplits.map((d) => [d.properties.mcap_split_group, d.id]));
    const copy = Object.fromEntries(Object.entries(od).filter(([k, v]) => v !== null && v !== '' && !SKIP_COPY.test(k) && dealProps.includes(k)));
    const contacts = await crm.associatedIds('deals', dealId, 'contacts');
    const notes = await crm.associatedIds('deals', dealId, 'notes');
    const out = [];
    for (const g of groups) {
      let id = dealId;
      let created = false;
      let stageNote = '';
      if (g.kind !== 'this') {
        id = splitByKey.get(g.key);
        let target = { pipeline: od.pipeline, stage: od.dealstage, parked: false };
        if (g.kind === 'future') target = await crm.futureStage(od.pipeline, od.dealstage, p.futureStage || 'auto');
        if (g.kind === 'future' && !target.parked) stageNote = 'No Future Opportunity stage in this pipeline yet, so it was created at the same stage as this deal';
        if (!id) {
          const props = only({ ...copy, dealname: `${companyName} - ${g.label}`, pipeline: target.pipeline, dealstage: target.stage,
            mcap_split_from_deal: dealId, mcap_split_group: g.key }, dealAllowed, dropped);
          if (!props.mcap_split_from_deal) throw new Error('The deal property mcap_split_from_deal is missing; run the Meter Capture setup first');
          const r = await api('POST', '/crm/v3/objects/deals', { properties: props });
          if (r.status !== 201 && r.status !== 200) throw new Error(`Couldn't create the ${g.label} deal (${r.status}): ${r.body.message || ''}`);
          id = r.body.id; created = true;
          await crm.associate('deals', 'companies', [[id, companyId]]);
          if (contacts.length) await crm.associate('deals', 'contacts', contacts.map((c) => [id, c]));
          if (notes.length) await crm.associate('deals', 'notes', notes.map((n) => [id, n]));
        }
      }
      const meterIds = g.meters.map((m) => idFor.get(String(m.number))).filter(Boolean);
      await crm.associate('deals', types.meters, meterIds.map((mid) => [id, mid]));
      const kwh = g.meters.reduce((t, m) => t + (Number(m.annualKwh) || 0), 0);
      const gaps = g.meters.map((m) => [m.number, missingForPricing({ ...m, included: true })]).filter(([, x]) => x.length);
      const roll = only(clean({ mcap_meter_count: g.meters.length, mcap_total_kwh: kwh || null, ced_group_date: g.earliestCed,
        mcap_status: 'Complete', mcap_completed_on: today,
        mcap_data_complete: gaps.length ? 'false' : 'true', mcap_data_missing: gaps.map(([n, x]) => `${n}: ${x.join(', ')}`).join('\n') }), dealAllowed, dropped);
      if (!gaps.length && dealAllowed.has('mcap_data_missing')) roll.mcap_data_missing = '';
      if (id === dealId && dealAllowed.has('mcap_draft')) roll.mcap_draft = '';
      await api('PATCH', `/crm/v3/objects/deals/${id}`, { properties: roll });
      out.push({ key: g.key, kind: g.kind, label: g.label, dealId: id, created, meters: g.meters.map((m) => m.number), earliestCed: g.earliestCed, flags: g.flags, stageNote,
        dataComplete: !gaps.length, missing: gaps.map(([n, x]) => `${n}: ${x.join(', ')}`) });
    }
    if (!groups.some((g) => g.kind === 'this')) {
      await api('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties: only({ mcap_status: 'Complete', mcap_completed_on: today, mcap_draft: '', mcap_meter_count: 0 }, dealAllowed, dropped) });
    }

    // meters that moved to a split deal, or were unticked, come off this deal
    const stay = new Set((groups.find((g) => g.kind === 'this')?.meters || []).map((m) => idFor.get(String(m.number))));
    const onDeal = new Set(await crm.associatedIds('deals', dealId, types.meters));
    const off = all.map((m) => idFor.get(String(m.number))).filter((mid) => mid && onDeal.has(mid) && !stay.has(mid));
    if (off.length) await crm.unassociate('deals', types.meters, off.map((mid) => [dealId, mid]));

    // a note on this deal saying what was written
    const unticked = all.filter((m) => m.included === false).map((m) => m.number);
    const html = [`<p><strong>Meter Capture</strong> by ${by || 'a rep'} on ${today}</p><ul>`,
      ...out.map((d) => `<li>${d.kind === 'this' ? 'This deal' : `${d.created ? 'New' : 'Existing'} deal ${d.label}`}: ${d.meters.join(', ')}${d.earliestCed ? ` (earliest CED ${d.earliestCed})` : ''}</li>`),
      unticked.length ? `<li>Saved to the company only (unticked): ${unticked.join(', ')}</li>` : '',
      `</ul><p>${newSites.size} new Site${newSites.size === 1 ? '' : 's'}, ${creates.length} new Meter${creates.length === 1 ? '' : 's'}, ${updates.length} existing Meter${updates.length === 1 ? '' : 's'} updated. No Contract records were created.</p>`].join('');
    const note = await api('POST', '/crm/v3/objects/notes', { properties: { hs_timestamp: new Date().toISOString(), hs_note_body: html } });
    if (note.status === 201 || note.status === 200) await crm.associate('notes', 'deals', [[note.body.id, dealId]]).catch(() => {});

    if (dropped.size) warnings.push(`Not saved because these properties don't exist here yet (run the Meter Capture setup): ${[...dropped].join(', ')}`);
    return ok({ deals: out, sites: { created: newSites.size, matched: new Set([...siteFor.values()].filter((v) => !v.startsWith('key:'))).size },
      meters: { created: creates.length, updated: updates.length, unticked: unticked.length }, warnings });
  } catch (e) {
    return fail(500, `Add to HubSpot stopped: ${e.message}${warnings.length ? ` (${warnings.join('; ')})` : ''}. It is safe to run again: it picks up what was already written.`);
  }
};
