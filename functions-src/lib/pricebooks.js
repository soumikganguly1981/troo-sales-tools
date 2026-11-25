// Reads the live matrix price books: the HubDB index `price_books`, then each book's JSON
// from the HubSpot file manager (private files, read through a short-lived signed URL).
const { api } = require('./http');
const { normaliseRow } = require('./hubdb');

const TABLE = 'price_books';
const INDEX_MS = 2 * 60 * 1000; // index cache: a newly loaded book shows within 2 minutes
const BOOK_MS = 30 * 60 * 1000; // book cache: books never change once published (a new load is a new file)
let index = null;
const books = new Map(); // fileId -> { at, book }

async function liveIndex() {
  if (index && Date.now() - index.at < INDEX_MS) return index.rows;
  const meta = await api('GET', `/cms/v3/hubdb/tables/${TABLE}`);
  if (meta.status !== 200) throw new Error(`HubDB table ${TABLE}: ${meta.status}`);
  const columns = meta.body.columns.map((c) => ({ name: c.name, type: c.type }));
  const rows = []; let after = null;
  do {
    const r = await api('GET', `/cms/v3/hubdb/tables/${TABLE}/rows?limit=1000${after ? `&after=${after}` : ''}`);
    if (r.status !== 200) throw new Error(`HubDB rows ${TABLE}: ${r.status}`);
    rows.push(...r.body.results.map((x) => normaliseRow(x.values, columns)));
    after = r.body.paging?.next?.after || null;
  } while (after);
  const live = rows.filter((r) => String(r.status || '').toLowerCase() === 'live' && r.book_id);
  index = { at: Date.now(), rows: live };
  return live;
}

async function fetchBook(fileId) {
  const hit = books.get(fileId);
  if (hit && Date.now() - hit.at < BOOK_MS) return hit.book;
  const s = await api('GET', `/files/v3/files/${fileId}/signed-url?expirationSeconds=300`);
  if (s.status !== 200 || !s.body.url) throw new Error(`Price book file ${fileId}: ${s.status}`);
  const res = await fetch(s.body.url);
  if (!res.ok) throw new Error(`Price book file ${fileId}: download ${res.status}`);
  const book = await res.json();
  books.set(fileId, { at: Date.now(), book });
  return book;
}

// Books for one fuel ('E' | 'G' | 'HH') and region, fetched in parallel.
async function booksFor(fuel, region) {
  const rows = (await liveIndex()).filter((r) => r.fuel === fuel && String(r.region || '').toUpperCase() === String(region || '').toUpperCase());
  return Promise.all(rows.map((r) => fetchBook(String(r.book_id))));
}

// Which suppliers have live books, per fuel, with the earliest quote-by date.
async function summary() {
  const out = {};
  for (const r of await liveIndex()) {
    const k = `${r.fuel}|${r.supplier}`;
    if (!out[k] || (r.quote_by && r.quote_by < out[k].quoteBy)) out[k] = { fuel: r.fuel, supplier: r.supplier, quoteBy: r.quote_by || null, validFrom: r.valid_from || null };
  }
  return Object.values(out).sort((a, b) => a.fuel.localeCompare(b.fuel) || a.supplier.localeCompare(b.supplier));
}

module.exports = { booksFor, summary, liveIndex };
