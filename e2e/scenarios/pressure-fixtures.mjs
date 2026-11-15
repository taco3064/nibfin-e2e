export function pressureFixture(phase = 'healthy') {
  const binding = { requestId: 'synthetic-pressure', experimentId: 'controlled-1',
    clockId: 'synthetic-monotonic-ms',
    repository: 'example/controlled', case: 'pressure', phase, issues: [10, 11],
    memberId: 7 };
  const admission = (issue, i) => ({ issue, runRepository: binding.repository,
    runId: 20 + i, jobId: 30 + i, attempt: 1, runnerId: 40 + i, memberId: 7 });
  const admissions = [admission(10, 0), admission(11, 1)];
  const writer = (a, start, end, i) => ({ ...a, executionId: `writer-${i}`,
    start, end, activeUntil: end });
  let writers = admissions.map((a, i) => writer(a, 1, 4, i));
  if (phase === 'serial') writers[1] = writer(admissions[1], 5, 8, 1);
  if (phase === 'recovered') {
    admissions.push(admission(10, 2));
    writers = [writer(admissions[0], 1, 4, 0),
      writer(admissions[1], 6, 9, 1), writer(admissions[2], 6, 9, 2)];
  }
  const event = (a, at) => ({ clockId: binding.clockId,
    experimentId: binding.experimentId,
    runRepository: a.runRepository, runId: a.runId, attempt: a.attempt,
    jobId: a.jobId, at });
  let samples = writers.map(w => ({ ...event(w, w.start),
    mode: phase === 'serial' && w.jobId === 31 ? 'serial' : 'parallel' }));
  if (phase === 'recovered') samples.push({ ...event(admissions[2], 4),
    mode: 'wait' });
  const diagnostics = [];
  if (phase === 'expired') {
    writers = [];
    admissions.splice(1);
    samples = [0, 15000, 300000].map(at => ({ ...event(admissions[0], at),
      mode: 'wait' }));
    diagnostics.push({ ...event(admissions[0], 300000),
      code: 'JOB_VM_HOST_MEMORY_PRESSURE', executionId: null,
      handshakeAttempt: 0, elapsedMs: 300000 });
  } else {
    for (const [i, code] of ['WSL_CONNECTION_TIMEOUT',
      'JOB_VM_EXEC_INITIALIZE_TIMEOUT'].entries()) {
      diagnostics.push({ ...event(writers[0], 2 + i), code,
        executionId: writers[0].executionId, handshakeAttempt: i + 1,
        elapsedMs: i + 1 });
    }
  }
  if (phase === 'pending') writers[0].end = null;
  const evidence = { ...binding, complete: true, admissions, writers,
    samples, diagnostics, effects: 'reconciled', independentEligible: true,
    waitBoundMs: 300000,
    coverage: { start: 0, end: phase === 'expired' ? 300000 : 10,
      admissions: true, writers: true },
    recovery: { prior: 'writer-0', replacement: 'writer-2',
      termination: 'confirmed', effects: 'reconciled', authorization: 'continuing',
      confirmedAt: 5 } };
  return { binding, evidence };
}
