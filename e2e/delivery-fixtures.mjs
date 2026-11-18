export const javascriptRequests = Object.freeze([
  Object.freeze({ path: 'ready.mjs', stdout: 'NIBFIN_E2E_READY\n' }),
  Object.freeze({ path: 'ready-b.mjs', stdout: 'NIBFIN_E2E_READY_B\n' }),
].map(item => Object.freeze({ ...item,
  content: `process.stdout.write(${JSON.stringify(item.stdout)});\n` })));
// Individual observations never inherit an aggregate phase's pass.
export function fixtureResults(state = 'unobserved', code = 'NOT_OBSERVED') {
  return javascriptRequests.map(program => ({ id: program.path,
    scenario: 'javascript-delivery', state, code }));
}

export function observeFixture(result) {
  return { state: ['passed', 'failed'].includes(result.state) ? result.state :
    'unresolved', code: result.code };
}
