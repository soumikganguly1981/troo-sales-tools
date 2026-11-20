// Minimal HubSpot API client for app functions: retries 429/5xx, honours Retry-After,
// and treats 207 Multi-Status as success (batch reads return 207 when some inputs have no result).
const BASE = 'https://api.hubapi.com';

async function api(method, path, body, tries = 4) {
  const token = process.env.PRIVATE_APP_ACCESS_TOKEN;
  let last;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 500 * 2 ** i;
      last = res.status;
      await new Promise((r) => setTimeout(r, Math.min(wait, 4000)));
      continue;
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { status: res.status === 207 ? 200 : res.status, body: json };
  }
  return { status: last || 500, body: { message: 'HubSpot API unavailable after retries' } };
}

const ok = (body) => ({ statusCode: 200, body });
const fail = (statusCode, error) => ({ statusCode, body: { error } });

module.exports = { api, ok, fail };
