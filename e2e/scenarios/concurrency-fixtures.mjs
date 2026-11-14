import { admissionKey } from '../concurrency-assertions.mjs';

export function concurrencyFixture(kind, supplied) {
  const binding = supplied ?? { case: kind, requestId: 'synthetic-request',
    repository: 'example/controlled', memberId: 7,
    issues: kind === 'independent' ? [10, 11] : [10],
    wakes: [{ wakeId: 'one', issue: 10 }, { wakeId: 'two', issue: 10 }] };
  const admission = (issue, index) => ({ issue,
    runRepository: binding.repository, runId: 20 + index, attempt: 1,
    jobId: 30 + index, runnerId: 40 + index, memberId: binding.memberId });
  const admissions = kind === 'offline' ? [] : kind === 'independent'
    ? binding.issues.map(admission) : [admission(binding.issues[0], 0)];
  if (kind === 'interrupted') admissions.push(admission(binding.issues[0], 1));
  const writers = admissions.map((a, i) => ({ ...a, executionId: `writer-${i}`,
    start: kind === 'interrupted' ? 1 + i * 5 : 1,
    activeUntil: kind === 'interrupted' ? 4 + i * 5 : 9,
    end: kind === 'interrupted' ? 4 + i * 5 : 9 }));
  const evidence = { ...structuredClone(binding), admissions, writers,
    coverage: { start: 0, end: 10, admissions: true, writers: true },
    effects: 'reconciled', capacity: 2, independentEligible: true,
    progress: binding.issues.map(issue => ({ issue, at: 3, unfinishedUntil: 8 })),
    wakes: binding.wakes.map(w => ({ ...w,
      admissions: admissions.map(admissionKey) })),
    recovery: { prior: 'writer-0', replacement: 'writer-1',
      termination: 'confirmed', effects: 'reconciled', authorization: 'continuing',
      confirmedAt: 5 },
    route: { offline: true, complete: true, selectedMember: binding.memberId,
      retainedMember: binding.memberId } };
  return { binding, evidence };
}
