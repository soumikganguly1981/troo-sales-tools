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
    supply_number: { type: 'string', description: 'MPAN (all digits printed, top line and core) or MPRN, digits only' },
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
      unclear: { type: 'array', items: { type: 'string' }, description: 'Fields that were hard to read or missing' },
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

async function call(model, file, prompt, tool) {
  const media = MEDIA[file.extension];
  if (!media) throw new Error(`Bills must be PDF or a photo (JPG, PNG, WEBP); ${file.name} is .${file.extension}`);
  const block = media === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: media, data: file.bytes.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: media, data: file.bytes.toString('base64') } };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 2000, temperature: 0,
        tools: [tool], tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Bill reading failed (${res.status}): ${body.error?.message || ''}`);
    const used = (body.content || []).find((c) => c.type === 'tool_use');
    if (!used) throw new Error('The bill reader returned no result');
    return { result: used.input, seconds: Math.round((Date.now() - started) / 100) / 10, model };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Reading the bill took too long. Try a smaller file or a clearer photo.');
    throw e;
  } finally { clearTimeout(timer); }
}

const READ_PROMPT = `This is a UK business energy bill (or a photo of one). Record every meter (MPAN for electricity, MPRN for gas) on it.
Use the latest rates shown if they changed during the bill period, and give the date they apply from.
For the contract end date, copy the wording exactly into contract_end_text. If no date is printed, leave it null; never guess.
Units: pence per kWh and pence per day (convert £ to pence). List anything hard to read in "unclear".`;

const readBill = (file) => call(READ_MODEL(), file, READ_PROMPT, READ_TOOL);

function checkBill(file, first) {
  const summary = (first.meters || []).map((m) => `- ${m.fuel} ${m.supply_number}: CED ${m.contract_end_date || 'none'}, rates ${JSON.stringify(m.rates || {})}`).join('\n');
  const prompt = `Another reader extracted these meters from this bill:\n${summary}\n
Check each one against the bill: the meter number digit by digit, the latest unit rates and standing charge (pence), and the contract end date.
Report the values as printed on the bill. Set matches_first_read to false when any of these differ.`;
  return call(CHECK_MODEL(), file, prompt, CHECK_TOOL);
}

module.exports = { configured, readBill, checkBill, MEDIA };
