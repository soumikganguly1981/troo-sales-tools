// Customer quote: the shortlist kept on the deal and the quote PDF built from it.
// Pure functions (no HubSpot calls) so they can be tested locally.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const MAX_ITEMS = 40;

// One shortlisted option. The key matches the one the cards compute, so a ticked result stays ticked.
function itemKey(meterId, o) {
  return [meterId, o.supplier, (o.products || []).join('/'), o.term, o.endDate || '', o.commission, o.annual].join('|');
}

function parseShortlist(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Zero-width spaces, joiners, byte-order marks and other control characters that sneak in
// from copied text. They're invisible, and the PDF font can't draw them.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;
const tidy = (v) => String(v == null ? '' : v).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();

// Keeps only the fields the quote needs, so the stored JSON stays small.
function cleanItem(meter, option, by) {
  const m = meter || {}; const o = option || {};
  const r = o.rates || {};
  const n = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const meterOut = {
    id: String(m.id || 'manual'), meterNumber: tidy(m.meterNumber).slice(0, 40), fuel: ['E', 'G', 'HH'].includes(m.fuel) ? m.fuel : 'E',
    region: m.region || null, aq: n(m.aq) || 0, start: m.start || null, site: tidy(m.site).slice(0, 200), company: tidy(m.company).slice(0, 200),
  };
  const optOut = {
    supplier: tidy(o.supplier).slice(0, 100), products: (o.products || []).map((x) => tidy(x).slice(0, 100)).slice(0, 4),
    term: n(o.term), endDate: o.endDate || null, green: !!o.green,
    rates: { unit: n(r.unit), day: n(r.day), night: n(r.night), ew: n(r.ew) },
    sc: n(o.sc) || 0, kvaCharge: n(o.kvaCharge), annual: n(o.annual) || 0, commission: n(o.commission) || 0, totalComms: n(o.totalComms) || 0,
    quoteBy: o.quoteBy || null,
  };
  return { key: itemKey(meterOut.id, optOut), addedAt: new Date().toISOString(), by: tidy(by).slice(0, 100), meter: meterOut, option: optOut };
}

// Items grouped by meter, cheapest first within each meter.
function groupByMeter(items) {
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.meter.id)) map.set(it.meter.id, { meter: it.meter, items: [] });
    map.get(it.meter.id).items.push(it);
  }
  const groups = [...map.values()];
  for (const g of groups) g.items.sort((a, b) => a.option.annual - b.option.annual || a.option.term - b.option.term);
  return groups;
}

// The earliest quote-by date across the options: the date the whole quote is valid until.
function validUntil(items) {
  const d = items.map((i) => i.option.quoteBy).filter(Boolean).sort();
  return d[0] || null;
}

const FUEL = { E: 'Electricity', HH: 'Half-hourly electricity', G: 'Gas' };
const uk = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
const gbp = (v) => `£${Math.round(v).toLocaleString('en-GB')}`;
const pence = (v) => (v == null ? '-' : `${Number(v).toFixed(3)}p`);
const lengthText = (o) => (o.endDate ? `Fixed to ${uk(o.endDate)}` : `${o.term} months`);
const productText = (o) => `${(o.products || []).join(' / ')}${o.green ? ' (green)' : ''}`;

// Troo brand colours, from troocost.com
const PURPLE = rgb(46 / 255, 26 / 255, 71 / 255);
const TEAL = rgb(55 / 255, 169 / 255, 135 / 255);
const TEAL_LIGHT = rgb(225 / 255, 245 / 255, 238 / 255);
const TEAL_MID = rgb(190 / 255, 233 / 255, 218 / 255);
const INK = rgb(44 / 255, 44 / 255, 42 / 255);
const GREY = rgb(95 / 255, 94 / 255, 90 / 255);
const LINE = rgb(211 / 255, 209 / 255, 199 / 255);
const WHITE = rgb(1, 1, 1);

// Builds the customer quote PDF (A4 landscape). logo: PNG bytes of the white Troo logo, or null.
async function buildQuotePdf({ items, company, date, logo }) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Your energy prices from Troo - ${company || ''}`.trim());
  doc.setAuthor('Troo');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let logoImg = null;
  if (logo) { try { logoImg = await doc.embedPng(logo); } catch { logoImg = null; } }

  const W = 842; const H = 595; const M = 36;
  const groups = groupByMeter(items);
  const until = validUntil(items);
  let page; let y;

  // Standard PDF fonts only cover WinAnsi (Western European). Anything else is dropped, after
  // swapping in close equivalents, so odd characters in HubSpot data never break the quote.
  const charset = new Set(font.getCharacterSet());
  const safe = (v) => [...tidy(v).normalize('NFC')]
    .map((ch) => (charset.has(ch.codePointAt(0)) ? ch : ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')))
    .filter((ch) => [...ch].every((c) => charset.has(c.codePointAt(0))))
    .join('');
  const text = (s, x, yy, size = 10, f = font, color = INK) => page.drawText(safe(s), { x, y: yy, size, font: f, color });
  const fit = (s, width, size, f = font) => {
    let t = safe(s);
    while (t.length > 1 && f.widthOfTextAtSize(t, size) > width) t = t.slice(0, -1);
    return t.length < safe(s).length ? `${t.slice(0, -1)}…` : t;
  };

  const header = (first) => {
    page = doc.addPage([W, H]);
    page.drawRectangle({ x: 0, y: H - 70, width: W, height: 70, color: PURPLE });
    if (logoImg) {
      const h = 30; const w = (logoImg.width / logoImg.height) * h;
      page.drawImage(logoImg, { x: M, y: H - 50, width: w, height: h });
    } else {
      text('troo', M, H - 46, 26, bold, WHITE);
    }
    text('Your energy prices', W - M - bold.widthOfTextAtSize('Your energy prices', 18), H - 40, 18, bold, WHITE);
    const sub = `Prepared ${uk(date)}${until ? `  ·  Prices valid until ${uk(until)}` : ''}`;
    text(sub, W - M - font.widthOfTextAtSize(sub, 10), H - 56, 10, font, WHITE);
    page.drawRectangle({ x: 0, y: H - 74, width: W, height: 4, color: TEAL });
    y = H - 100;
    if (first) {
      text(company || 'Your business', M, y, 16, bold, PURPLE);
      y -= 16;
      text(`${groups.length} meter${groups.length === 1 ? '' : 's'}  ·  ${items.length} option${items.length === 1 ? '' : 's'}  ·  Prices exclude Climate Change Levy and VAT`, M, y, 10, font, GREY);
      y -= 22;
    }
  };

  const footer = () => {
    const pages = doc.getPages();
    pages.forEach((p, i) => {
      p.drawLine({ start: { x: M, y: 46 }, end: { x: W - M, y: 46 }, thickness: 0.5, color: LINE });
      p.drawText('Troo is paid a commission by the supplier, which is included in the prices above. Prices can change until the contract is agreed.', { x: M, y: 32, size: 8, font, color: GREY });
      p.drawText('Troo · Registered office: 1 Azure Court, Doxford International Business Park, Sunderland SR3 3BE · Company number 10293408, registered in England', { x: M, y: 20, size: 8, font, color: GREY });
      const pg = `Page ${i + 1} of ${pages.length}`;
      p.drawText(pg, { x: W - M - font.widthOfTextAtSize(pg, 8), y: 20, size: 8, font, color: GREY });
    });
  };

  header(true);
  for (const g of groups) {
    const os = g.items.map((i) => i.option);
    const has = { unit: os.some((o) => o.rates.unit != null), day: os.some((o) => o.rates.day != null), night: os.some((o) => o.rates.night != null), ew: os.some((o) => o.rates.ew != null), kva: os.some((o) => o.kvaCharge) };
    const cols = [
      { h: 'Supplier and product', w: 230, v: (o) => `${o.supplier} · ${productText(o)}` },
      { h: 'Contract length', w: 100, v: lengthText },
      ...(has.unit ? [{ h: 'Unit rate', w: 70, v: (o) => pence(o.rates.unit) }] : []),
      ...(has.day ? [{ h: 'Day rate', w: 70, v: (o) => pence(o.rates.day) }] : []),
      ...(has.night ? [{ h: 'Night rate', w: 70, v: (o) => pence(o.rates.night) }] : []),
      ...(has.ew ? [{ h: 'Eve/weekend', w: 75, v: (o) => pence(o.rates.ew) }] : []),
      { h: 'Standing charge', w: 95, v: (o) => (o.sc ? `${o.sc.toFixed(2)}p/day` : 'None') },
      ...(has.kva ? [{ h: 'Capacity', w: 80, v: (o) => (o.kvaCharge ? `${o.kvaCharge}p/kVA/m` : '-') }] : []),
      { h: 'Yearly cost', w: 85, v: (o) => gbp(o.annual) },
    ];
    const total = cols.reduce((s, c) => s + c.w, 0);
    const scale = (W - 2 * M) / total;
    cols.forEach((c) => { c.w *= scale; });
    const rowH = 22;
    const need = 40 + rowH * (g.items.length + 1);
    if (y - need < 60) header(false);

    const m = g.meter;
    const title = `${FUEL[m.fuel] || 'Meter'}${m.meterNumber ? ` · Meter ${m.meterNumber}` : ''}`;
    text(title, M, y, 12, bold, PURPLE);
    const detail = [m.site, `${Math.round(m.aq).toLocaleString('en-GB')} kWh a year`, m.start ? `Starting ${uk(m.start)}` : ''].filter(Boolean).join('  ·  ');
    text(fit(detail, W - 2 * M, 9), M, y - 13, 9, font, GREY);
    y -= 24;

    page.drawRectangle({ x: M, y: y - rowH + 6, width: W - 2 * M, height: rowH, color: PURPLE });
    let x = M + 8;
    for (const c of cols) { text(fit(c.h, c.w - 10, 9, bold), x, y - 9, 9, bold, WHITE); x += c.w; }
    y -= rowH;

    g.items.forEach((it, i) => {
      const o = it.option;
      const best = i === 0;
      const fill = best ? TEAL_MID : i % 2 ? TEAL_LIGHT : WHITE;
      page.drawRectangle({ x: M, y: y - rowH + 6, width: W - 2 * M, height: rowH, color: fill });
      let cx = M + 8;
      cols.forEach((c, ci) => {
        const f = ci === cols.length - 1 || (best && ci === 0) ? bold : font;
        text(fit(c.v(o), c.w - 10, 9.5, f), cx, y - 9, 9.5, f, INK);
        cx += c.w;
      });
      if (best && g.items.length > 1) {
        const tag = 'Best price';
        const tw = bold.widthOfTextAtSize(tag, 7) + 8;
        page.drawRectangle({ x: W - M - tw - 4, y: y - 11, width: tw, height: 11, color: TEAL });
        text(tag, W - M - tw, y - 8.5, 7, bold, WHITE);
      }
      y -= rowH;
    });
    page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.5, color: LINE });
    y -= 18;
  }
  footer();
  return doc.save();
}

// Internal note body (HTML) for the deal timeline: what was quoted, including commission.
function noteBody(items, company, fileName, by) {
  const groups = groupByMeter(items);
  const until = validUntil(items);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = `<p><strong>Customer quote saved</strong> from the Pricing tab${by ? ` by ${esc(by)}` : ''}: ${items.length} option${items.length === 1 ? '' : 's'} across ${groups.length} meter${groups.length === 1 ? '' : 's'} for ${esc(company || 'the customer')}.${until ? ` Prices valid until ${uk(until)}.` : ''} Quote PDF attached: ${esc(fileName)}. Attach it to the "Your energy prices from Troo" email.</p>`;
  for (const g of groups) {
    html += `<p><strong>${esc(g.meter.meterNumber || 'Meter')}</strong> · ${Math.round(g.meter.aq).toLocaleString('en-GB')} kWh · from ${uk(g.meter.start)}</p><ul>`;
    for (const it of g.items) {
      const o = it.option;
      html += `<li>${esc(o.supplier)} ${esc(productText(o))}, ${esc(lengthText(o))}: ${gbp(o.annual)} a year, commission ${o.commission}p/kWh (${gbp(o.totalComms)} over the contract)</li>`;
    }
    html += '</ul>';
  }
  return html;
}

function quoteFileName(company, date) {
  const slug = String(company || 'Customer').replace(/[^A-Za-z0-9]+/g, ' ').trim().slice(0, 60) || 'Customer';
  return `Troo quote - ${slug} - ${String(date).slice(0, 10)}.pdf`;
}

module.exports = { MAX_ITEMS, itemKey, parseShortlist, cleanItem, groupByMeter, validUntil, buildQuotePdf, noteBody, quoteFileName };
