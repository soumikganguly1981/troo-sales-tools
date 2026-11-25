// app function uid: matrix_shortlist
// parameters: { dealId, action: 'get' | 'add' | 'remove' | 'clear', meter?, option?, key?, by? }
// The customer quote shortlist, kept on the deal in mp_quote_shortlist (JSON).
const { api, ok, fail } = require('./lib/http');
const { MAX_ITEMS, parseShortlist, cleanItem } = require('./lib/quote');

const PROP = 'mp_quote_shortlist';

async function read(dealId) {
  const r = await api('GET', `/crm/v3/objects/deals/${dealId}?properties=${PROP}`);
  if (r.status !== 200) throw new Error(`Couldn't read the deal (${r.status})`);
  return parseShortlist(r.body.properties?.[PROP]);
}

async function write(dealId, items) {
  const r = await api('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties: { [PROP]: items.length ? JSON.stringify(items) : '' } });
  if (r.status !== 200) throw new Error(`Couldn't save the shortlist (${r.status}): ${r.body?.message || ''}`);
}

exports.main = async (context) => {
  try {
    const p = context.parameters || {};
    const dealId = String(p.dealId || '');
    if (!/^\d+$/.test(dealId)) return fail(400, 'Missing deal ID');
    let items = await read(dealId);
    const action = p.action || 'get';

    if (action === 'add') {
      if (!p.option || !p.option.supplier) return fail(400, 'Choose an option to shortlist');
      const it = cleanItem(p.meter, p.option, p.by);
      if (!items.some((x) => x.key === it.key)) {
        if (items.length >= MAX_ITEMS) return fail(400, `The shortlist holds up to ${MAX_ITEMS} options. Save the quote or remove some first.`);
        items = [...items, it];
        await write(dealId, items);
      }
    } else if (action === 'remove') {
      const next = items.filter((x) => x.key !== p.key);
      if (next.length !== items.length) { items = next; await write(dealId, items); }
    } else if (action === 'clear') {
      if (items.length) { items = []; await write(dealId, items); }
    } else if (action !== 'get') {
      return fail(400, `Unknown action ${action}`);
    }
    return ok({ items });
  } catch (e) {
    return fail(500, e.message);
  }
};
