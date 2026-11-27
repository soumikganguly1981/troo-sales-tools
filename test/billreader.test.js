// The bill reader's calls to the Anthropic API, mocked: forced tool use first, falling back to
// auto when a model refuses it (the Colab proof test found Sonnet 5.5 does).
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.ANTHROPIC_API_KEY = 'test-key';
const sent = [];
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body); sent.push(body);
  const forced = body.tool_choice.type === 'tool';
  if (body.model === 'claude-sonnet-5-5' && forced) {
    return { ok: false, status: 400, json: async () => ({ error: { message: "tool_choice: forcing a tool isn't supported with this model" } }) };
  }
  const input = body.tools[0].name === 'record_check'
    ? { meters: [{ supply_number: '1012345678903', matches_first_read: true }] }
    : { is_energy_bill: true, supplier: 'British Gas', meters: [{ fuel: 'Elec', supply_number: '1012345678903' }] };
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'tool_use', name: body.tools[0].name, input }] }) };
};
const reader = require('../functions-src/lib/billreader');
const file = { bytes: Buffer.from('%PDF-1.4'), name: 'bill.pdf', extension: 'pdf' };

test('Haiku reads with forced tool use and the tested system prompt', async () => {
  const r = await reader.readBill(file);
  assert.equal(r.result.meters[0].supply_number, '1012345678903');
  const b = sent.at(-1);
  assert.equal(b.model, 'claude-haiku-5-5');
  assert.equal(b.tool_choice.type, 'tool');
  assert.match(b.system, /LATEST period/);
  assert.equal(b.temperature, undefined);
});

test('Sonnet check falls back to auto tool use, then remembers', async () => {
  sent.length = 0;
  const r = await reader.checkBill(file, { meters: [{ fuel: 'Elec', supply_number: '1012345678903' }] });
  assert.equal(r.result.meters[0].matches_first_read, true);
  assert.deepEqual(sent.map((b) => b.tool_choice.type), ['tool', 'auto']);
  assert.match(sent[1].messages[0].content[1].text, /Answer by calling record_check/);
  sent.length = 0;
  await reader.checkBill(file, { meters: [] });
  assert.deepEqual(sent.map((b) => b.tool_choice.type), ['auto']);
});
