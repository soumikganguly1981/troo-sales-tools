// app function uid: mc_read
// parameters: { dealId, fileId, mode: 'file' | 'check', first? }
//  mode 'file':  an Excel/CSV meter list is read directly; a bill (PDF or photo) is read by Haiku
//  mode 'check': Sonnet re-checks a bill's critical fields; first = the raw result of mode 'file'
// One file per call, so each call stays inside HubSpot's function time limit.
const XLSX = require('xlsx');
const { api, ok, fail } = require('./lib/http');
const { objectTypes, downloadFile } = require('./lib/crm');
const { supplierMap } = require('./lib/suppliers');
const billreader = require('./lib/billreader');
const { parseMeterRows, billMeters, mergeCheck } = require('./lib/meters');

const SHEETS = ['xlsx', 'xls', 'csv'];
const MAX_BYTES = 15 * 1024 * 1024;

exports.main = async (context) => {
  try {
    const p = context.parameters || {};
    const dealId = String(p.dealId || '');
    const fileId = String(p.fileId || '');
    if (!/^\d+$/.test(dealId) || !/^\d+$/.test(fileId)) return fail(400, 'Missing deal or file ID');
    const file = await downloadFile(fileId);
    if (file.bytes.length > MAX_BYTES) return fail(400, `${file.name} is over 15 MB`);

    if (p.mode === 'file') {
      // first read moves the capture to In progress (never back from Complete)
      const deal = await api('GET', `/crm/v3/objects/deals/${dealId}?properties=mcap_status`);
      if (deal.status === 200 && deal.body.properties?.mcap_status !== 'Complete') {
        await api('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties: { mcap_status: 'In progress' } });
      }
    }

    if (SHEETS.includes(file.extension)) {
      const wb = XLSX.read(file.bytes, { type: 'buffer', cellDates: false, raw: file.extension === 'csv' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
      const res = parseMeterRows(rows);
      return ok({ kind: 'excel', name: file.name, meters: res.meters, problems: res.problems,
        log: `${file.name}: ${res.meters.length} row${res.meters.length === 1 ? '' : 's'} read${res.problems.length ? `, ${res.problems.length} to fix` : ', all valid'}` });
    }

    if (!billreader.MEDIA[file.extension]) return fail(400, `${file.name}: use PDF or a photo for bills, or the Excel template for a meter list`);
    if (!billreader.configured()) return fail(400, 'Bill reading is not switched on yet (the ANTHROPIC_API_KEY secret is missing). Use the Excel template for now.');
    const types = await objectTypes();
    const { resolve } = await supplierMap();
    const source = file.extension === 'pdf' ? 'Bill' : 'Photo';

    if (p.mode === 'check') {
      if (!p.first || !Array.isArray(p.first.meters)) return fail(400, 'Missing the first read to check');
      const check = await billreader.checkBill(file, p.first);
      const meters = mergeCheck(billMeters(p.first, resolve, source), check.result);
      const changed = meters.filter((m) => m.toCheck.length).length;
      return ok({ kind: 'bill', name: file.name, meters,
        log: `${file.name}: critical fields re-checked (${check.seconds} s)${changed ? `, ${changed} meter${changed > 1 ? 's' : ''} with a field to check` : ', all agree'}` });
    }

    const read = await billreader.readBill(file);
    if (read.result.is_energy_bill === false) return ok({ kind: 'bill', name: file.name, meters: [], raw: read.result, problems: [`${file.name} doesn't look like an energy bill`], log: `${file.name}: not an energy bill` });
    const meters = billMeters(read.result, resolve, source);
    const problems = meters.filter((m) => m.problem).map((m) => `${file.name}: ${m.number || 'a meter'}: ${m.problem}`);
    if (!meters.length) problems.push(`${file.name}: no meter numbers found`);
    return ok({ kind: 'bill', name: file.name, meters, raw: read.result, problems, unclear: read.result.unclear || [],
      log: `${file.name}: read (${read.seconds} s), ${meters.length} meter${meters.length === 1 ? '' : 's'} found` });
  } catch (e) {
    return fail(500, e.message);
  }
};
