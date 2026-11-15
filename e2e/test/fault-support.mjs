import { pairedFixture } from './delivery-pair-support.mjs';

// In-memory owned fixture: deliberately no live provider or Core claim.
export function faultFixture(edit = () => {}) {
  const f = pairedFixture();
  const ledgers = [], operations = [];
  const create = f.caller.createFixture;
  const observe = f.caller.observe;
  let faultActive = false;
  f.caller.createFixture = async definition => {
    const fixture = await create(definition);
    const ledger = {};
    ledgers.push(ledger);
    return { ...fixture, inventory: {
      async exclusive(action) { return action(ledger, async () => {}); },
    } };
  };
  const readConcurrency = f.caller.readConcurrencyEvidence;
  f.caller.readConcurrencyEvidence = async binding => {
    const history = await readConcurrency(binding);
    history.coverage.start = 5;
    history.writers.forEach(w => { w.start = 5; w.activeUntil = 8; });
    history.progress.forEach(p => { p.at = 6; });
    return history;
  };
  f.caller.applyFault = async binding => {
    operations.push('apply');
    faultActive = true;
    return { ...binding, state: 'applied' };
  };
  f.caller.readFaultEvidence = async binding => {
    operations.push(`read:${binding.phase}`);
    const admission = { ...binding.wake, runnerId: 400, memberId: 7 };
    const resumed = { ...f.legs[0].wake.expected, runnerId: 400, memberId: 7 };
    const history = { ...binding, issues: [binding.issue], admissions: [admission],
      coverage: { start: 0, end: binding.phase === 'before' ? 4 : 10,
        writers: true, admissions: true },
      writers: [{ ...admission, executionId: 'fault-writer',
        start: 1, activeUntil: 3, end: 4 }] };
    if (binding.phase !== 'before') {
      history.admissions.push(resumed);
      history.writers.push({ ...resumed, executionId: 'execution-3-0',
        start: 5, activeUntil: 8, end: 9 });
    }
    const e = { ...binding, complete: true, execution: binding.wake,
      history, status: 'observed', fault: binding.case, demonstrated: true,
      termination: binding.case === 'unknown-termination' ? 'unknown' : 'confirmed',
      settledAt: binding.phase === 'before' ? 4 : 9,
      effects: binding.case === 'unknown-write' ? 'unknown' : 'reconciled',
      authority: binding.case === 'revoked-wake' ? 'revoked' : 'continuing',
      dependenciesReady: true, committedEffects: ['candidate-1'],
      completedWorkVerified: true, remainingOnly: true,
      resumedJob: resumed, reason: `${binding.case}:remaining-work`,
      pull: { number: 5, head: 'b'.repeat(40), checkIds: [6] } };
    edit(e, binding.phase);
    return e;
  };
  f.caller.continueFault = async binding => {
    operations.push(binding.phase);
    if (binding.phase === 'recover') {
      const leg = f.legs[0];
      leg.wake = JSON.parse(JSON.stringify(leg.wake)
        .replace(/\b301\b/g, '302').replace(/\b300\b/g, '301')
        .replace(/\b200\b/g, '201'));
    }
    return { wake: f.legs[0].wake.expected };
  };
  f.caller.restoreFault = async binding => {
    operations.push('restore');
    faultActive = false;
    return { ...binding, state: 'restored', ownedOnly: true,
      nativeReadBack: true, localSettled: true };
  };
  f.caller.observe = async target => {
    const base = `https://api.github.com/repos/${target.repository}`;
    if (faultActive && target.kind === 'pull') return { complete: true, target,
      data: { id: target.number, number: target.number,
        url: `${base}/pulls/${target.number}`, merged: false,
        head: { sha: 'b'.repeat(40) } } };
    if (faultActive && target.kind === 'checks') return { complete: true, target,
      data: [{ id: 6, url: `${base}/check-runs/6`, head_sha: target.sha,
        status: 'completed', conclusion: 'failure' }] };
    // Earlier cancellation remains a native historical fact after recovery.
    if (target.kind === 'run' && target.runId === 200 &&
        f.legs[0].wake.expected.runId === 201 &&
        target.repository === f.legs[0].wake.expected.runRepository) {
      const value = structuredClone(f.legs[0].wake.evidence.run);
      value.target = target;
      value.data.id = 200;
      value.data.url = `${base}/actions/runs/200`;
      return value;
    }
    if (target.kind === 'jobs' && target.runId === 200 &&
        f.legs[0].wake.expected.runId === 201 &&
        target.repository === f.legs[0].wake.expected.runRepository) {
      const value = structuredClone(f.legs[0].wake.evidence.jobs);
      value.target = target;
      Object.assign(value.data[0], { id: 300, run_id: 200,
        url: `${base}/actions/jobs/300`, conclusion: 'cancelled' });
      return value;
    }
    const value = await observe(target);
    if (faultActive && target.kind === 'pull') value.data.merged = false;
    if (faultActive && target.kind === 'checks') value.data[0].conclusion = 'failure';
    if (faultActive && target.kind === 'jobs') {
      value.data.forEach(job => { job.conclusion = 'cancelled'; });
    }
    return value;
  };
  return { ...f, ledgers, operations };
}
