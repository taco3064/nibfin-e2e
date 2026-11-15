import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installationFixture } from './installation-fixture.mjs';
import { disposableSentinels } from '../isolation-sentinels.mjs';
import { observeIsolation } from '../isolation-protected.mjs';

export async function isolationFixture(t) {
  const installer = await installationFixture(t);
  const installation = await installer.driver().install();
  const root = await mkdtemp(join(tmpdir(), 'isolation90-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assignment = runId => ({ repository: installation.binding.repository,
    runId, attempt: 2, jobId: runId + 1000, runnerId: 41, runnerName: 'shared-41',
    workflowId: 55, workflowPath: '.github/workflows/negative.yml',
    sha: 'a'.repeat(40), event: 'workflow_dispatch',
    headRepository: installation.binding.repository });
  const expected = { case: 'unauthorized-workflow', applicable: true,
    negative: assignment(101), eligible: assignment(102),
    slot: { hostId: installation.binding.hostId, slotId: 'slot-1', runnerId: 41,
      memberId: 9, repositoryId: 7 } };
  const snapshot = (a, negative) => {
    const base = `https://api.github.com/repos/${a.repository}`;
    const job = { id: a.jobId, url: `${base}/actions/jobs/${a.jobId}`,
      run_id: a.runId, run_attempt: a.attempt, runner_id: a.runnerId,
      runner_name: a.runnerName, head_sha: a.sha, status: 'completed',
      conclusion: negative ? 'failure' : 'success',
      started_at: '2026-11-15T01:02:00Z', steps: negative ? [] : [{
        status: 'completed', conclusion: 'success',
        started_at: '2026-11-15T01:02:01Z',
      }] };
    const run = { id: a.runId, url: `${base}/actions/runs/${a.runId}`,
      run_attempt: a.attempt, head_sha: a.sha,
      repository: { full_name: a.repository }, workflow_id: a.workflowId,
      path: a.workflowPath, event: a.event,
      head_repository: { full_name: a.headRepository }, status: 'completed',
      conclusion: job.conclusion };
    const target = { repository: a.repository, runId: a.runId, attempt: a.attempt,
      sha: a.sha };
    return { run: { target: { ...target, kind: 'run' }, complete: true, data: run },
      jobs: { target: { ...target, kind: 'jobs' }, complete: true, data: [job] } };
  };
  const negativeSentinel = { run: 'negative', nonce: 'negative-nonce' };
  const eligibleSentinel = { run: 'eligible', nonce: 'eligible-nonce' };
  const observed = { negative: snapshot(expected.negative, true),
    eligible: snapshot(expected.eligible, false),
    rejection: { verified: true, category: expected.case,
      assignment: structuredClone(expected.negative),
      rejectedAt: '2026-11-15T01:01:00Z', reference: 'core/rejection/101' },
    negativeSlot: { ...expected.slot }, eligibleSlot: { ...expected.slot },
    negativeSentinel: { ...negativeSentinel, state: 'absent' },
    eligibleSentinel: { ...eligibleSentinel, state: 'present' },
    terminated: true, cleaned: true };
  Object.assign(expected, { negativeSentinel, eligibleSentinel });
  const events = [];
  let surface;
  const caller = {
    authorize: async () => { events.push('authorize'); return true; },
    openSurface: async () => {
      events.push('open');
      surface = await disposableSentinels(root);
      return surface;
    },
    executeNegative: async () => { events.push('negative'); },
    executeEligible: async ({ sentinel }) => {
      events.push('eligible');
      await surface.write(sentinel);
    },
    readRejection: async () => structuredClone(observed.rejection),
    readSlot: async ({ assignment: a }) => structuredClone(
      a.runId === 101 ? observed.negativeSlot : observed.eligibleSlot),
    provider: async url => {
      const leg = url.includes('/runs/101') ? observed.negative : observed.eligible;
      return { status: 200, data: url.includes('/jobs?') ?
        { total_count: leg.jobs.data.length, jobs: leg.jobs.data } : leg.run.data };
    },
    terminate: async () => { events.push('terminate'); return true; },
  };
  return { installation, expected, observed, events, caller,
    run: (options = {}) => observeIsolation({ installation, expected, caller,
      ...options }) };
}
