// Account-independent HubSpot lookups for Meter Capture. Nothing here is hard-coded to one
// account: custom object type IDs, pipelines and stages are looked up by name at run time, so
// the same code runs in the sandbox and in the live account (their IDs differ).
const { api } = require('./http');

const CACHE_MS = 10 * 60 * 1000;
const LIVE_FALLBACK = { meters: '2-112673604', sites: '2-112673583' }; // live account 26661912 only
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// { meters: '2-…', sites: '2-…' } from the custom object schemas (matched on the object's name).
async function objectTypes() {
  return cached('schemas', async () => {
    const r = await api('GET', '/crm/v3/schemas?archived=false');
    // Until the live app is reinstalled with crm.schemas.custom.read, fall back to the live account's IDs.
    if (r.status === 403) return LIVE_FALLBACK;
    if (r.status !== 200) throw new Error(`Couldn't read the custom object schemas (${r.status})`);
    const find = (re) => (r.body.results || []).find((s) => re.test(s.name) || re.test(s.labels?.plural || ''));
    const meters = find(/^meters?$/i); const sites = find(/^sites?$/i);
    if (!meters || !sites) throw new Error('The Meter and Site custom objects were not found in this account');
    return { meters: meters.objectTypeId, sites: sites.objectTypeId };
  });
}

// All deal pipelines with their stages.
async function pipelines() {
  return cached('pipelines', async () => {
    const r = await api('GET', '/crm/v3/pipelines/deals');
    if (r.status !== 200) throw new Error(`Couldn't read the deal pipelines (${r.status})`);
    return (r.body.results || []).map((p) => ({ id: p.id, label: p.label, stages: (p.stages || []).map((s) => ({ id: s.id, label: s.label })) }));
  });
}

// Where a Future Opportunity deal goes. setting: a stage ID, or 'auto' = a stage in the deal's
// pipeline whose name contains "future"; otherwise it stays at the original deal's stage.
async function futureStage(pipelineId, currentStage, setting) {
  const all = await pipelines();
  if (setting && setting !== 'auto') {
    for (const p of all) { const s = p.stages.find((x) => x.id === String(setting)); if (s) return { pipeline: p.id, stage: s.id, label: s.label, parked: true }; }
  }
  const p = all.find((x) => x.id === String(pipelineId));
  const s = p && p.stages.find((x) => /future/i.test(x.label));
  if (s) return { pipeline: p.id, stage: s.id, label: s.label, parked: true };
  const cur = p && p.stages.find((x) => x.id === String(currentStage));
  return { pipeline: String(pipelineId), stage: String(currentStage), label: cur ? cur.label : '', parked: false };
}

// Every associated record ID, paged.
async function associatedIds(fromType, fromId, toType) {
  const ids = []; let after = null;
  do {
    const r = await api('GET', `/crm/v4/objects/${fromType}/${fromId}/associations/${toType}?limit=500${after ? `&after=${after}` : ''}`);
    if (r.status !== 200) break;
    ids.push(...(r.body.results || []).map((x) => String(x.toObjectId)));
    after = r.body.paging?.next?.after || null;
  } while (after);
  return ids;
}

async function batchRead(type, ids, properties) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await api('POST', `/crm/v3/objects/${type}/batch/read`, { properties, inputs: ids.slice(i, i + 100).map((id) => ({ id })) });
    if (r.status !== 200) throw new Error(`Couldn't read ${type} records (${r.status}): ${r.body.message || ''}`);
    out.push(...(r.body.results || []));
  }
  return out;
}

// Records whose property is one of values (searches 100 values at a time).
async function searchIn(type, property, values, properties) {
  const out = [];
  const uniq = [...new Set(values.filter(Boolean).map(String))];
  for (let i = 0; i < uniq.length; i += 100) {
    let after;
    do {
      const r = await api('POST', `/crm/v3/objects/${type}/search`, {
        filterGroups: [{ filters: [{ propertyName: property, operator: 'IN', values: uniq.slice(i, i + 100) }] }],
        properties, limit: 100, ...(after ? { after } : {}),
      });
      if (r.status !== 200) throw new Error(`Couldn't search ${type} by ${property} (${r.status}): ${r.body.message || ''}`);
      out.push(...(r.body.results || []));
      after = r.body.paging?.next?.after;
    } while (after);
  }
  return out;
}

async function batch(type, verb, inputs) {
  const out = [];
  for (let i = 0; i < inputs.length; i += 100) {
    const r = await api('POST', `/crm/v3/objects/${type}/batch/${verb}`, { inputs: inputs.slice(i, i + 100) });
    if (r.status !== 200 && r.status !== 201) throw new Error(`Couldn't ${verb} ${type} records (${r.status}): ${r.body.message || JSON.stringify(r.body).slice(0, 200)}`);
    out.push(...(r.body.results || []));
  }
  return out;
}

// Links pairs with each object pair's default (unlabelled) association, so no association type
// IDs are needed. pairs: [[fromId, toId], ...]
async function associate(fromType, toType, pairs) {
  for (let i = 0; i < pairs.length; i += 100) {
    const r = await api('POST', `/crm/v4/associations/${fromType}/${toType}/batch/associate/default`,
      { inputs: pairs.slice(i, i + 100).map(([a, b]) => ({ from: { id: String(a) }, to: { id: String(b) } })) });
    if (r.status !== 200 && r.status !== 201) throw new Error(`Couldn't link ${fromType} to ${toType} (${r.status}): ${r.body.message || ''}`);
  }
}

async function unassociate(fromType, toType, pairs) {
  for (let i = 0; i < pairs.length; i += 100) {
    const r = await api('POST', `/crm/v4/associations/${fromType}/${toType}/batch/archive`,
      { inputs: pairs.slice(i, i + 100).map(([a, b]) => ({ from: { id: String(a) }, to: [{ id: String(b) }] })) });
    if (r.status !== 200 && r.status !== 204) throw new Error(`Couldn't unlink ${fromType} from ${toType} (${r.status})`);
  }
}

// Options of a dropdown property (e.g. the Meter's "Incumbent supplier").
async function propertyOptions(type, name) {
  return cached(`opts:${type}:${name}`, async () => {
    const r = await api('GET', `/crm/v3/properties/${type}/${name}`);
    return r.status === 200 ? (r.body.options || []).filter((o) => !o.hidden && o.value).map((o) => o.value) : [];
  });
}

// Writable deal property names (used to copy a deal into the split deals).
async function writableDealProperties() {
  return cached('dealprops', async () => {
    const r = await api('GET', '/crm/v3/properties/deals?archived=false');
    if (r.status !== 200) return [];
    return (r.body.results || []).filter((p) => !p.modificationMetadata?.readOnlyValue && !p.calculated && !p.hidden).map((p) => p.name);
  });
}

// A HubSpot file's bytes (files uploaded through the card are private; read them via a signed URL).
async function downloadFile(fileId) {
  const r = await api('GET', `/files/v3/files/${fileId}/signed-url?expirationSeconds=600`);
  if (r.status !== 200) throw new Error(`Couldn't open the file (${r.status}): ${r.body.message || ''}`);
  const res = await fetch(r.body.url);
  if (!res.ok) throw new Error(`Couldn't download the file (${res.status})`);
  return { bytes: Buffer.from(await res.arrayBuffer()), name: r.body.name, extension: String(r.body.extension || '').toLowerCase(), size: r.body.size };
}

module.exports = { objectTypes, pipelines, futureStage, associatedIds, batchRead, searchIn, batch, associate, unassociate,
  propertyOptions, writableDealProperties, downloadFile };
