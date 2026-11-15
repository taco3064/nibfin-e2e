const clone = value => structuredClone(value);

// The same provider owns failed checks, restoration and continuation. Observation
// cannot create a fault or recover one; those changes happen only in operations.
export function simulatedFault(provider, pair) {
  const { caller, issueLeg, persistWake, persistDelivery } = pair;
  let active = null;
  let restored = false;
  let recovered = false;
  let originalWake;
  const historyRead = caller.readConcurrencyEvidence;
  caller.readConcurrencyEvidence = async binding => {
    const history = await historyRead(binding);
    history.coverage.start = 5;
    history.writers.forEach(writer => { writer.start = 5; writer.activeUntil = 8; });
    history.progress.forEach(progress => { progress.at = 6; });
    return history;
  };
  caller.applyFault = async binding => provider.perform('fault',
    binding.repository, () => {
      const leg = issueLeg(binding);
      if (active || binding.case !== 'failed-ci') throw new Error('SIM_FAULT_DENIED');
      active = clone(binding);
      originalWake = clone(leg.wake.expected);
      const target = { kind: 'pull', repository: binding.repository,
        number: leg.evidence.pull.number };
      const pull = provider.observe(target).data;
      provider.store(target, { ...pull, merged: false });
      const checks = { kind: 'checks', repository: binding.repository,
        sha: leg.evidence.pull.head };
      provider.store(checks, provider.observe(checks).data.map(check =>
        ({ ...check, conclusion: 'failure' })));
      return { ...binding, state: 'applied' };
    });
  caller.restoreFault = async binding => provider.perform('restore',
    binding.repository, () => {
      if (!active || active.operationId !== binding.operationId ||
          !provider.settled) throw new Error('SIM_FAULT_UNSETTLED');
      persistDelivery(issueLeg(binding));
      restored = true;
      return { ...binding, state: 'restored', ownedOnly: true,
        nativeReadBack: true, localSettled: true };
    });
  caller.continueFault = async binding => provider.perform(binding.phase,
    binding.repository, () => {
      if (!restored || !provider.settled ||
          active?.operationId !== binding.operationId) {
        throw new Error('SIM_RECOVERY_DENIED');
      }
      const leg = issueLeg(binding);
      if (binding.phase === 'recover' && !recovered) {
        const before = leg.wake.expected;
        const replacements = new Map([[before.runId, before.runId + 1],
          [before.jobId, before.jobId + 1], [before.checkRunId, before.checkRunId + 1]]);
        // Replace in one pass so adjacent IDs cannot cascade.
        leg.wake = JSON.parse(JSON.stringify(leg.wake).replace(/\b\d+\b/g,
          value => String(replacements.get(Number(value)) ?? value)));
        persistWake(leg);
        persistDelivery(leg);
        leg.evidence.admissions[0] = { ...leg.evidence.admissions[0],
          ...leg.wake.expected };
        for (const stage of leg.evidence.stages) {
          stage.wake = clone(leg.wake.expected);
          stage.admission = clone(leg.evidence.admissions[0]);
        }
        recovered = true;
      }
      return { wake: clone(leg.wake.expected) };
    });
  caller.readFaultEvidence = async binding => {
    const leg = issueLeg(binding);
    if (!active || active.operationId !== binding.operationId ||
        (binding.phase !== 'before' && !recovered)) {
      throw new Error('SIM_FAULT_OBSERVATION_UNAVAILABLE');
    }
    const admission = { ...originalWake, memberId: provider.definition.account.id };
    const resumed = { ...leg.wake.expected, memberId: provider.definition.account.id };
    const history = { ...binding, issues: [binding.issue], admissions: [admission],
      coverage: { start: 0, end: binding.phase === 'before' ? 4 : 10,
        writers: true, admissions: true },
      writers: [{ ...admission, executionId: 'fault-writer',
        start: 1, activeUntil: 3, end: 4 }] };
    if (binding.phase !== 'before') {
      history.admissions.push(resumed);
      history.writers.push({ ...resumed,
        executionId: leg.evidence.stages[3].execution.id,
        start: 5, activeUntil: 8, end: 9 });
    }
    return { ...binding, complete: true, execution: originalWake, history,
      status: 'observed', fault: active.case, demonstrated: true,
      termination: provider.settled ? 'confirmed' : 'unknown',
      settledAt: binding.phase === 'before' ? 4 : 9, effects: provider.effects,
      authority: provider.excluded ? 'revoked' : 'continuing',
      dependenciesReady: provider.repository(binding.repository).installed,
      committedEffects: [leg.evidence.candidate.id], completedWorkVerified: true,
      remainingOnly: true, resumedJob: resumed, reason: 'failed-ci:remaining-work',
      pull: clone(leg.evidence.pull) };
  };
  return pair;
}
