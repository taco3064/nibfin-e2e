import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Reuse producer-owned external transport facts, never its test assertions.
export async function coreFixture(root, mode) {
  const load = path => import(pathToFileURL(join(root, path)).href);
  const facts = await load('test/local-work-fixture.mjs');
  const { collectLocalWork } = await load('src/local-work-observation.mjs');
  const { collectDiagnosis } = await load('src/diagnosis-request.mjs');
  const { makeBlockerReport, projectBlockerReport } =
    await load('src/blocker-report.mjs');
  const { digest } = await load('src/identity.mjs');
  const counts = { zero: 0, one: 1, two: 2, four: 4 };
  const f = facts.fixture(counts[mode] ?? 1);
  const { identity, subject, at } = facts;
  const foreign = { repository: 'other/project', repositoryId: 3 };
  const get = f.reader.get;
  if (mode === 'dedup') {
    const { discoverLocalHost } = await load('src/local-work-host.mjs');
    const primary = facts.adopted();
    primary.wakePeerFiles = ['/etc/nibfin/host.project.json'];
    primary.sharedRunner.repositories.push(2);
    const peer = structuredClone(primary);
    peer.repository.approval.repositoryId = 2;
    peer.repository.runner = { ...peer.repository.runner,
      repository: identity.repository, repositoryId: identity.repositoryId };
    const host = await discoverLocalHost(subject, async path => ({
      bytes: JSON.stringify(path.endsWith('host.json') ? primary : peer),
      sourceTime: at,
    }));
    assert.equal(host.bindings.length, 2);
    assert.ok(host.bindings.every(binding => binding.routes.length === 2));
    await host.confirm();
  }
  f.context.runner.repository = 'example/pool';
  if (['busy', 'running', 'stage', 'stale', 'queued', 'collision'].includes(mode)) {
    f.executing();
  }
  if (['running', 'stage', 'stale', 'collision'].includes(mode)) {
    f.local.contexts.push({ context: f.context });
    f.evidenceFactory = () => ({ issue: async id => id.repositoryId === 3
      ? { ...f.local, contexts: [] } : f.local,
    phase: async () => ({ stage: mode === 'stage' ? 'accept' : 'deliver',
      confirm: async () => {} }), confirm: async () => {} });
  }
  if (mode === 'stale') f.context.execution.attempt++;
  if (mode === 'offline') f.offline();
  if (mode === 'queued') {
    f.job.status = 'queued'; f.job.runner_id = 0; f.job.runner_name = null;
    f.local.wake.dispatchRunId = f.run.id;
  }
  if (mode === 'unknown') f.local.journal = null;
  if (mode === 'paused') {
    const event = { id: 1, event: 'labeled', created_at: at,
      label: { name: 'pause' }, actor: subject };
    f.local.wake.decisions.push({ eventHash: digest(event),
      qualification: 'allowed', desired: true, observationHash: 'a'.repeat(64) });
    f.reader.get = async path => {
      if (path.includes('/events?')) return [event];
      const value = await get(path);
      if (path.endsWith('/issues/7')) value.labels.push({ name: 'pause' });
      return value;
    };
  }
  if (mode === 'blocked') f.reader.get = async path =>
    path.includes('/blocked_by?') ? [{ state: 'open', labels: [],
      repository_url: 'https://api.github.com/repos/example/project' }] : get(path);
  if (mode === 'collision') {
    f.host.routes.push(foreign);
    f.host.bindings[0].routes.push(foreign);
    f.reader.get = async path => {
      if (path === '/repos/other/project') return { id: 3,
        full_name: foreign.repository, private: false };
      if (path.startsWith('/repos/other/project/')) {
        const value = await get(path.replace('other/project', 'example/project'));
        const replace = item => ({ ...item, node_id: 'I_foreign',
          url: 'https://api.github.com/repos/other/project/issues/7' });
        if (path.includes('/issues?')) return value.map(replace);
        if (path.endsWith('/issues/7')) return replace(value);
        return value;
      }
      return get(path);
    };
  }
  async function observe() {
    const value = await collectLocalWork('synthetic-dashboard', f);
    // Model repeated registration observations at the consumer's dedup boundary.
    if (mode === 'dedup') value.runners.push(structuredClone(value.runners[0]));
    return value;
  }
  async function diagnose(request) {
    const report = makeBlockerReport(f.context, 'deliver', {
      producer: mode === 'attributed' ? 'agent' : 'core-native', code: 'PROCESS_FAILED',
      result: mode === 'attributed' ? {
        rootCause: 'A required input was unavailable.', failureClass: 'external_failure',
      } : undefined,
      termination: { owner: 'docker-inspect', executionId: f.context.execution.id,
        containerId: 'b'.repeat(64), observedAt: at, running: false,
        exitCode: 137, oomKilled: true },
    });
    const reports = mode === 'missing' ? [] : [{ report,
      projected: projectBlockerReport(report, { issue: identity, subjectId: subject.id })
    }];
    const dependencies = { reader: f.reader, discover: f.discover,
      reportsFactory: () => ({ reports: async () => reports, confirm: async () => {} }) };
    if (mode === 'denied') dependencies.reader = { get: async () => {
      throw new Error('synthetic private failure');
    } };
    if (mode === 'stale-report') dependencies.reader = { get: async path => {
      const value = await get(path);
      if (path.endsWith('/jobs/200')) value.run_attempt++;
      return value;
    } };
    // The real coordinator refuses this fixture host's absent capacity. Never
    // replace its decision with a successful synthetic invocation.
    return collectDiagnosis(request, dependencies);
  }
  return { observe, diagnose, identity, subject, attempt: {
    id: f.context.execution.id, stage: 'deliver',
  } };
}
