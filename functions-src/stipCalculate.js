// app function uid: stip_calculate
// parameters: { deal: { fuel, aq, start, term, current, sector, structure, trading, smart, dd, hh, micro, indep, bgTrial, role } }
const { loadStipulations } = require('./lib/hubdb');
const { rank } = require('./lib/engine');
const { ok, fail } = require('./lib/http');

const FUELS = ['E', 'G'];

exports.main = async (context) => {
  try {
    const d = (context.parameters && context.parameters.deal) || {};
    if (!FUELS.includes(d.fuel)) return fail(400, 'Choose electricity or gas');
    const tables = await loadStipulations();
    const out = rank(
      {
        fuel: d.fuel,
        aq: Number(d.aq),
        start: d.start,
        term: d.term === 'max' || d.term == null ? 'max' : Number(d.term),
        current: d.current || '',
        sector: d.sector || 'general',
        structure: d.structure || 'ltd',
        trading: d.trading == null ? 2 : Number(d.trading),
        smart: d.smart || 'unsure',
        dd: d.dd || 'unsure',
        hh: d.hh || 'unsure',
        micro: !!d.micro,
        indep: !!d.indep,
        bgTrial: d.bgTrial !== false,
        role: d.role === 'tm' ? 'tm' : 'se',
      },
      tables,
    );
    return ok({ ...out, stipMonth: tables.stipMonth });
  } catch (e) {
    return fail(500, `Couldn't calculate: ${e.message}`);
  }
};
