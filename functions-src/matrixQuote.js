// app function uid: matrix_quote
// parameters: { dealId, action: 'preview' | 'save', by? }
// Builds the customer quote PDF from the deal's shortlist.
// preview: uploads it to "Customer quotes/Previews" and returns a link to open it.
// save: uploads it to "Customer quotes", attaches it to the deal in a note, and clears the shortlist.
const { api, ok, fail } = require('./lib/http');
const { parseShortlist, buildQuotePdf, noteBody, quoteFileName, groupByMeter } = require('./lib/quote');

const PROP = 'mp_quote_shortlist';
const LOGO = 'https://www.troocost.com/hubfs/Troo%20Logo%20White@4x.png';
const NOTE_TO_DEAL = 214;

async function logo() {
  try {
    const r = await fetch(LOGO);
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch { return null; }
}

async function upload(bytes, name, folderPath) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
  form.append('fileName', name);
  form.append('folderPath', folderPath);
  form.append('options', JSON.stringify({ access: 'PRIVATE', overwrite: false, duplicateValidationStrategy: 'NONE', duplicateValidationScope: 'EXACT_FOLDER' }));
  const res = await fetch('https://api.hubapi.com/files/v3/files', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.PRIVATE_APP_ACCESS_TOKEN}` }, body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200 && res.status !== 201) throw new Error(`Couldn't upload the quote PDF (${res.status}): ${body.message || ''}`);
  return body;
}

async function signedUrl(fileId) {
  const r = await api('GET', `/files/v3/files/${fileId}/signed-url?expirationSeconds=3600`);
  return r.status === 200 ? r.body.url : null;
}

exports.main = async (context) => {
  try {
    const p = context.parameters || {};
    const dealId = String(p.dealId || '');
    if (!/^\d+$/.test(dealId)) return fail(400, 'Missing deal ID');
    const action = p.action === 'save' ? 'save' : 'preview';

    const d = await api('GET', `/crm/v3/objects/deals/${dealId}?properties=${PROP},dealname`);
    if (d.status !== 200) return fail(d.status, `Couldn't read the deal (${d.status})`);
    let items = parseShortlist(d.body.properties?.[PROP]);
    if (!items.length) return fail(400, 'The shortlist is empty. Shortlist options in Instant Quote first.');
    if (Array.isArray(p.keys) && p.keys.length) items = items.filter((i) => p.keys.includes(i.key));

    const company = items.find((i) => i.meter.company)?.meter.company || String(d.body.properties?.dealname || '').split(' - ')[0];
    const today = new Date().toISOString().slice(0, 10);
    const bytes = await buildQuotePdf({ items, company, date: today, logo: await logo() });
    const name = action === 'save' ? quoteFileName(company, today) : `PREVIEW ${quoteFileName(company, today)}`;
    const file = await upload(bytes, name, action === 'save' ? '/Customer quotes' : '/Customer quotes/Previews');
    const url = await signedUrl(file.id);

    if (action === 'preview') return ok({ preview: true, fileId: file.id, name, url });

    const note = await api('POST', '/crm/v3/objects/notes', {
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: noteBody(items, company, name, p.by), hs_attachment_ids: String(file.id) },
      associations: [{ to: { id: dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_DEAL }] }],
    });
    if (note.status !== 201 && note.status !== 200) {
      return fail(note.status, `The quote PDF was created (${name}) but couldn't be attached to the deal (${note.status}): ${note.body?.message || ''}`);
    }
    // Saved options leave the shortlist; anything not included in this quote stays.
    const all = parseShortlist(d.body.properties?.[PROP]);
    const left = all.filter((i) => !items.some((x) => x.key === i.key));
    await api('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties: { [PROP]: left.length ? JSON.stringify(left) : '' } });
    return ok({ saved: true, fileId: file.id, name, url, noteId: note.body.id, options: items.length, meters: groupByMeter(items).length, left: left.length });
  } catch (e) {
    return fail(500, e.message);
  }
};
