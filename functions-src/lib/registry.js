// Registry lookups: Electralink (electricity, by MPAN) and Xoserve (gas, by MPRN).
// Not connected yet: the API details are still to come. Until then each lookup returns
// status 'not_connected' and the card asks the rep to confirm the supplier from the bill.
// When the docs arrive, fill in lookupElectricity / lookupGas so they return:
//   { status: 'ok', supplierCode, supplierSince, address, postcode, annualKwh, profile?, meterType? }
//   { status: 'not_found' } when the registry has no such meter
// Secrets (added to the app, never to code): ELECTRALINK_API_KEY, XOSERVE_API_KEY (+ any endpoint secrets).

const electralinkConnected = () => false; // set to !!process.env.ELECTRALINK_API_KEY once implemented
const xoserveConnected = () => false;     // set to !!process.env.XOSERVE_API_KEY once implemented

async function lookupElectricity(/* mpanCore */) {
  if (!electralinkConnected()) return { status: 'not_connected' };
  throw new Error('Electralink lookup not implemented');
}

async function lookupGas(/* mprn */) {
  if (!xoserveConnected()) return { status: 'not_connected' };
  throw new Error('Xoserve lookup not implemented');
}

async function lookup(meter) {
  try {
    return meter.fuel === 'Gas' ? await lookupGas(meter.number) : await lookupElectricity(meter.number);
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

module.exports = { lookup, electralinkConnected, xoserveConnected };
