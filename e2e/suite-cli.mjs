import { investigateFailure } from './defect-investigation.mjs';
import { runSuite } from './runner.mjs';
import { createSimulatedSuite } from './simulated-suite.mjs';
import { suiteId, suitePhases, unobservedPhases } from './suite-result.mjs';

export function parseSuiteArguments(args) {
  const result = { phase: 'complete', resume: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (seen.has(option)) throw new Error('SUITE_INVALID_REQUEST');
    seen.add(option);
    if (option === '--suite') continue;
    if (option === '--resume') { result.resume = true; continue; }
    const key = new Map([['--run-id', 'runId'], ['--state-dir', 'stateDir'],
      ['--phase', 'phase'], ['--agent', 'agent']]).get(option);
    const value = args[++index];
    if (!key || !value || value.startsWith('--') || value.includes('\0')) {
      throw new Error('SUITE_INVALID_REQUEST');
    }
    result[key] = value;
  }
  if (!seen.has('--suite') || !suiteId(result.runId) || !result.stateDir ||
      ![...suitePhases, 'complete'].includes(result.phase)) {
    throw new Error('SUITE_INVALID_REQUEST');
  }
  return result;
}

const errorCodes = new Set(['SIM_SESSION_REQUEST', 'SIM_SESSION_CORRUPT',
  'OPERATOR_AGENT_REQUIRED', 'OPERATOR_AGENT_UNSUPPORTED',
  'OPERATOR_AGENT_UNCONFIGURED', 'OPERATOR_AGENT_UNAVAILABLE',
  'OPERATOR_AGENT_INCOMPATIBLE', 'OPERATOR_AGENT_AUTHENTICATION',
  'OPERATOR_SETUP_UNAVAILABLE', 'SIM_SESSION_BINDING_CONFLICT',
  'SIM_SESSION_EXISTS', 'SIM_SESSION_NOT_FOUND',
  'SIM_SESSION_EXECUTION_UNRESOLVED', 'SIM_SESSION_OWNERSHIP_UNRESOLVED',
  'SIM_SESSION_PATH_UNSAFE', 'SUITE_INVALID_REQUEST', 'SUITE_BINDING_CONFLICT',
  'SUITE_RUN_NOT_FOUND', 'SIM_SUITE_UNAVAILABLE', 'SIM_DISPOSAL_UNSAFE']);

export function suiteExitCode(document) {
  const phase = document.requested?.phase;
  if (document.reason || !phase) return 1;
  if (phase === 'complete') return document.outcome === 'passed' ? 0 : 1;
  return document.phases?.[phase]?.state === 'passed' ? 0 : 1;
}

function failure(request, error) {
  const code = error instanceof SyntaxError ? 'SIM_SESSION_CORRUPT' :
    errorCodes.has(error.message) ? error.message :
      error.code === 'ENOENT' ? 'ORIGINAL_SOURCES_UNAVAILABLE' :
        'SIM_SESSION_UNAVAILABLE';
  return { schemaVersion: 1, kind: 'suite', provenance: 'controlled',
    runId: request?.runId ?? null, requested: { mode: request?.phase === 'complete'
      ? 'complete' : 'phase', phase: request?.phase ?? null },
    phases: unobservedPhases(), pending: [], cleanup: 'pending',
    outcome: 'non-passing', reason: code };
}

export async function suiteCommand(args, investigation) {
  let request, session, result;
  try {
    request = parseSuiteArguments(args);
    await investigation?.prepare?.(request);
    session = await createSimulatedSuite(request);
    const document = await runSuite(session, { runId: request.runId,
      phase: request.phase, resume: request.resume });
    result = { ...document,
      outcome: request.phase !== 'complete' && !document.reason &&
        document.phases[request.phase].state === 'passed' ? 'passed' :
          document.outcome,
      requested: { mode: request.phase === 'complete'
        ? 'complete' : 'phase', phase: request.phase } };
  } catch (error) { result = failure(request, error); }
  finally {
    try { await session?.close(); }
    catch (error) { result = failure(request, error); }
  }
  result.investigation = await investigateFailure(result, investigation);
  return result;
}
