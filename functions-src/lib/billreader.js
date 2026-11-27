// Reads energy bills with Claude. Each bill is two short calls (each inside HubSpot's function time limit):
//  1. read: Haiku reads the whole bill and returns the meters, supplier, CED and current rates
//  2. check: Sonnet looks at the same bill again and re-checks only the critical fields
//     (meter numbers, latest rates and standing charge, contract end date)
// The key is the app secret ANTHROPIC_API_KEY. Models can be changed with the secrets
// BILL_READ_MODEL / BILL_CHECK_MODEL without a code change.
const READ_MODEL = () => process.env.BILL_READ_MODEL || 'claude-haiku-5-5';
const CHECK_MODEL = () => process.env.BILL_CHECK_MODEL || 'claude-sonnet-5-5';
const TIMEOUT_MS = 13000;

const MEDIA = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const configured = () => !!process.env.ANTHROPIC_API_KEY;

// From the Colab proof test v3 ("Meter number lookup from bill"), which scored Haiku + Sonnet check on 8 real bills.
const SYSTEM = 'You read UK business gas and electricity bills for an energy broker. '
  + 'Extract only what is printed. Never guess: use null when a value is not on the bill. '
  + 'Digits only for MPAN, MPRN and account numbers. Dates as YYYY-MM-DD. Rates in pence. '
  + "If a date is printed without a day (e.g. 'March 2027'), use the last day of that month and list it in unclear. "
  + 'One meters[] entry per supply point. '
  + "MPAN: read the 'S' supply number box. The top line is 8 digits; the bottom line is the 13-digit core, starting with a 2-digit distributor ID. Copy every digit exactly. supply_number is the 13-digit core only: never join the top line onto it. "
  + 'RATES: if the bill shows more than one rate period (for example a price change part-way through), report ONLY the rates for the LATEST period and give that period\'s start date in rates_from. '
  + 'Unit rates are energy unit rates only (Day, Night, Single, etc.). Never include levies, CCL, pass-through or non-commodity charges as unit rates. '
  + 'If consumption for the period is zero and no unit rate is printed, leave the unit rates null.';

const RATES = {
  type: 'object',
  properties: {
    day: { type: ['number', 'null'], description: 'Day unit rate, pence per kWh' },
    night: { type: ['number', 'null'], description: 'Night unit rate, pence per kWh' },
    unit: { type: ['number', 'null'], description: 'Single unit rate, pence per kWh (standard meters and gas)' },
    standing_charge: { type: ['number', 'null'], description: 'Standing charge, pence per day' },
    rates_from: { type: ['string', 'null'], description: 'Date the latest rates apply from, YYYY-MM-DD' },
  },
};
const METER = {
  type: 'object',
  properties: {
    fuel: { type: 'string', enum: ['Elec', 'Gas'] },
    supply_number: { type: 'string', description: 'Electricity: the 13-digit MPAN core (bottom line of the S box). Gas: the MPRN. Digits only, never letters' },
    mpan_top_line: { type: ['string', 'null'], description: 'Electricity only: the top line of the S box as printed (profile, MTC, LLF); may contain letters' },
    site_address: { type: ['string', 'null'], description: 'Supply address as printed, without the postcode' },
    postcode: { type: ['string', 'null'] },
    contract_end_text: { type: ['string', 'null'], description: 'Contract end date exactly as printed' },
    contract_end_date: { type: ['string', 'null'], description: 'Contract end date YYYY-MM-DD; if only a month is printed, the last day of that month' },
    annual_kwh: { type: ['number', 'null'], description: 'Estimated annual consumption (EAC or AQ) in kWh' },
    rates: RATES,
  },
  required: ['fuel', 'supply_number'],
};
const READ_TOOL = {
  name: 'record_bill',
  description: 'Record what the energy bill says.',
  input_schema: {
    type: 'object',
    properties: {
      is_energy_bill: { type: 'boolean' },
      supplier: { type: ['string', 'null'], description: 'Supplier trading name as printed' },
      customer_name: { type: ['string', 'null'] },
      bill_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      meters: { type: 'array', items: METER },
      unclear: { type: 'array', items: { type: 'string' }, description: 'Names of fields that were hard to read or missing, a few words each (e.g. "contract end date"). No explanations' },
    },
    required: ['is_energy_bill', 'meters'],
  },
};
const CHECK_TOOL = {
  name: 'record_check',
  description: 'Record the checked values for each meter.',
  input_schema: {
    type: 'object',
    properties: {
      meters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            supply_number: { type: 'string', description: 'The meter number as printed on the bill (digits only)' },
            matches_first_read: { type: 'boolean' },
            contract_end_date: { type: ['string', 'null'] },
            contract_end_day_printed: { type: 'boolean', description: 'False when the bill gives only a month' },
            rates: RATES,
            notes: { type: ['string', 'null'] },
          },
          required: ['supply_number', 'matches_first_read'],
        },
      },
    },
    required: ['meters'],
  },
};

const refusesForced = new Set(); // models that answered 400 to a forced tool_choice
function fromText(content) { // a JSON object in a text answer, when the model didn't call the tool
  const txt = (content || []).map((c) => c.text || '').join('');
  const m = txt.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

async function call(model, file, prompt, tool) {
  const media = MEDIA[file.extension];
  if (!media) throw new Error(`Bills must be PDF or a photo (JPG, PNG, WEBP); ${file.name} is .${file.extension}`);
  const block = media === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: media, data: file.bytes.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: media, data: file.bytes.toString('base64') } };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = Date.now();
  const send = (forced) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: ctl.signal,
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 2000, system: SYSTEM,
      tools: [tool], tool_choice: forced ? { type: 'tool', name: tool.name } : { type: 'auto' },
      messages: [{ role: 'user', content: [block, { type: 'text', text: forced ? prompt : `${prompt} Answer by calling ${tool.name}.` }] }],
    }),
  });
  try {
    let forced = !refusesForced.has(model);
    let res = await send(forced);
    let body = await res.json().catch(() => ({}));
    if (res.status === 400 && forced && /tool_choice/i.test(body.error?.message || '')) {
      refusesForced.add(model); forced = false;
      res = await send(false);
      body = await res.json().catch(() => ({}));
    }
    if (!res.ok) throw new Error(`Bill reading failed (${res.status}): ${body.error?.message || ''}`);
    const used = (body.content || []).find((c) => c.type === 'tool_use');
    const result = used ? used.input : fromText(body.content);
    if (!result) throw new Error('The bill reader returned no result');
    return { result, seconds: Math.round((Date.now() - started) / 100) / 10, model };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Reading the bill took too long. Try a smaller file or a clearer photo.');
    throw e;
  } finally { clearTimeout(timer); }
}

const READ_PROMPT = `Extract this bill: every meter (MPAN for electricity, MPRN for gas).
For the contract end date, copy the wording exactly into contract_end_text. If no date is printed, leave it null.
Units: pence per kWh and pence per day (convert £ to pence). List anything hard to read in "unclear".`;

const readBill = (file) => call(READ_MODEL(), file, READ_PROMPT, READ_TOOL);

function checkBill(file, first) {
  const summary = (first.meters || []).map((m) => `- ${m.fuel} ${m.supply_number}: CED ${m.contract_end_date || 'none'}, rates ${JSON.stringify(m.rates || {})}`).join('\n');
  const prompt = `Another reader extracted these meters from this bill:\n${summary}\n
Re-read ONLY these fields for each supply point: the MPAN bottom-line core (13 digits) or the MPRN, the LATEST period's
standing charge and energy unit rates (pence), and the contract end date. Copy every digit exactly.
Report the values as printed. Set matches_first_read to false when any of these differ.`;
  return call(CHECK_MODEL(), file, prompt, CHECK_TOOL);
}

module.exports = { configured, readBill, checkBill, MEDIA };
