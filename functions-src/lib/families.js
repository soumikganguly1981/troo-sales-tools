// Price book supplier name -> stipulation product family (shared by the matrix functions)
const FAMILY = {
  'British Gas': 'bg_matrix', 'BG Lite': 'bg_lite', 'BG Plus': 'bg_matrix', 'Corona Energy': 'corona',
  'Crown Gas & Power': { E: 'crown_e', G: 'crown_g' }, Drax: 'drax', 'EDF Energy': 'edf_matrix', Engie: 'engie',
  Npower: 'npower_fixed', 'Shell Energy': 'shell_standard', 'Smartest Energy Business': 'smartest_sme', 'Smartest Energy': 'smartest_sme',
  TotalEnergies: 'total_matrix',
};
const GROUP = { bg_matrix: 'bg', bg_lite: 'bg', corona: 'corona', crown_e: 'crown', crown_g: 'crown', drax: 'drax', edf_matrix: 'edf', engie: 'engie', npower_fixed: 'npower', shell_standard: 'shell', smartest_sme: 'smartest', total_matrix: 'total' };

module.exports = { FAMILY, GROUP };
