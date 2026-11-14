import { matches } from './github-resources.mjs';
import { observed, nativeExecution } from './wake-correlation.mjs';
import { same, validAdmission, identifier } from './delivery-contract.mjs';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Correlate native resources only. Core owns event qualification and admission.
export async function readPauseSnapshot(binding, observe) {
  const { repository, issue: number, issueId } = binding;
  const issueTarget = Object.freeze({ repository, number, kind: 'issue' });
  const eventTarget = Object.freeze({ repository, number, kind: 'issue-events' });
  const issue = await observe(issueTarget);
  const events = await observe(eventTarget);
  if (!observed(issue, issueTarget) || issue.data.id !== issueId ||
      issue.data.state !== 'open' || !Array.isArray(issue.data.labels) ||
      issue.data.labels.some(label => typeof label?.name !== 'string') ||
      events?.complete !== true ||
      !same(events.target, eventTarget, Object.keys(eventTarget)) ||
      !Array.isArray(events.data) || events.data.length > 2000 ||
      !events.data.every(event => matches(event, eventTarget)) ||
      new Set(events.data.map(event => event.id)).size !== events.data.length) {
    return null;
  }
  return { issue: issue.data, events: events.data };
}

export function pauseMutationObserved(before, after, adding) {
  if (!before || !after || before.issue.id !== after.issue.id ||
      before.issue.number !== after.issue.number ||
      after.events.length <= before.events.length ||
      !equal(before.events, after.events.slice(0, before.events.length))) return false;
  const added = after.events.slice(before.events.length).filter(event =>
    event.label?.name === 'pause');
  const last = before.events.at(-1);
  return added.length === 1 && added[0].event === (adding ? 'labeled' : 'unlabeled') &&
    (!last || (added[0].id > last.id &&
      Date.parse(added[0].created_at) >= Date.parse(last.created_at))) &&
    after.issue.labels.some(label => label.name === 'pause') === adding;
}

export async function readPauseAdmission(binding, expected, snapshot, caller, call) {
  const keys = ['requestId', 'repository', 'issue', 'issueId', 'phase'];
  if (!same(expected, binding, keys) || !validAdmission(expected) ||
      !identifier(expected.invocation)) return null;
  const evidence = await call(signal =>
    caller.readPauseEvidence(structuredClone(binding), signal));
  const record = evidence?.admission;
  if (!same(record, expected, keys.concat(['runRepository', 'runId', 'attempt',
    'jobId', 'invocation', 'decision', 'code'])) || record.executed !== true ||
      !equal(evidence.observation, snapshot)) return null;
  const native = {};
  for (const [key, kind] of [['run', 'run'], ['jobs', 'jobs']]) {
    native[key] = await call(signal => caller.observe({ kind,
      repository: expected.runRepository, runId: expected.runId,
      attempt: expected.attempt }, signal));
  }
  if (!nativeExecution(native, expected)) return null;
  if (binding.phase === 'paused') {
    if (record.decision !== 'denied' || record.code !== 'ISSUE_PAUSED' ||
        evidence.pause?.status !== 'paused' || evidence.stageAdmitted !== false) {
      return null;
    }
  } else if (record.decision !== 'allowed' || evidence.pause?.status !== 'clear' ||
      evidence.stageAdmitted !== false) return null;
  // Admission permission is never delivery completion or a completed stage.
  if (!Array.isArray(evidence.createdReceipts) || evidence.createdReceipts.length) {
    return null;
  }
  return { decision: record.decision, code: record.code };
}
