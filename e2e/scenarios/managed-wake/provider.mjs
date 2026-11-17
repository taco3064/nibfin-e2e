import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { producerFile } from '../../source-producers.mjs';

export function loader(core) {
  return async path => import(pathToFileURL(await producerFile(core.checkout, path)));
}

// Provider state is separate from mutation replies, activation receipts and selection.
export async function provider(context, activation, name) {
  const load = loader(context.sources.core);
  const { gitBlob, sha256 } = await load('src/identity.mjs');
  const { callerRecipe } = await load('src/caller-recipes.mjs');
  const { produceManagedWake } = await load('src/managed-wake-producer.mjs');
  const { zip } = await load('test/relay-fixture.mjs');
  const { RelayReader } = await load('src/relay-http.mjs');
  const { RelayJournal, writeRelayState } = await load('src/relay-state.mjs');
  const { NotificationRelay } = await load('src/notification-relay.mjs');
  const root = join(context.tempDir, name);
  await mkdir(root, { mode: 0o700 });
  const [origin] = activation.config.origins;
  const memberId = activation.memberId, coreCommit = activation.pin.commit;
  const head = origin.workflow.commit;
  const actor = { id: memberId, login: 'operator', type: 'User' };
  const event = { action: 'opened', sender: actor,
    repository: { id: origin.repositoryId, full_name: origin.repository },
    issue: { id: 2, node_id: 'I_managed', number: 3, state: 'open',
      updated_at: '2026-11-16T00:00:00Z', assignees: [actor], labels: [] } };
  const eventPath = join(root, 'event.json');
  await writeFile(eventPath, JSON.stringify(event));
  const produced = await produceManagedWake({ RUNNER_TEMP: root,
    GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'issues',
    GITHUB_REPOSITORY: origin.repository, GITHUB_RUN_ID: '30',
    GITHUB_RUN_ATTEMPT: '1' });
  const archive = zip(await readFile(produced.path));
  const sharedPath = '.github/workflows/shared-runner.yml';
  const shared = await readFile(await producerFile(context.sources.core.checkout,
    sharedPath), 'utf8');
  const source = callerRecipe('issue-managed', coreCommit);
  assert.equal(gitBlob(source), origin.workflow.blob);
  const dest = activation.destination;
  const runner = { ...activation.runner,
    sharedAdmission: { kind: 'repository-admission-v1', ...dest,
      memberId, ownerId: memberId } };
  assert.equal(runner.workflowBlob, gitBlob(shared));
  const original = { id: 30, run_attempt: 1, event: 'issues', status: 'completed',
    conclusion: 'success', workflow_id: origin.workflow.id, path: origin.workflow.path,
    head_sha: head, head_branch: origin.ref, repository: event.repository,
    head_repository: { id: origin.repositoryId }, actor, triggering_actor: actor,
    referenced_workflows: [{ path:
      `taco3064/nibfin-core/.github/workflows/issue.yml@${coreCommit}`,
      sha: coreCommit }],
    run_started_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:01:00Z' };
  const artifact = { id: 40, name: produced.artifactName, expired: false,
    size_in_bytes: archive.length, digest: `sha256:${sha256(archive)}`,
    workflow_run: { id: 30, repository_id: origin.repositoryId,
      head_repository_id: origin.repositoryId, head_branch: origin.ref, head_sha: head },
    created_at: '2026-11-16T00:00:20Z', updated_at: '2026-11-16T00:00:30Z' };
  const issue = { ...event.issue, body: 'Implement a controlled regression',
    labels: [{ name: 'scope' }], url:
      `https://api.github.com/repos/${origin.repository}/issues/3` };
  const run = { id: 60,
    url: `https://api.github.com/repos/${dest.repository}/actions/runs/60`,
    run_attempt: 1, event: 'workflow_dispatch',
    workflow_id: runner.workflowId, path: sharedPath, head_sha: head, head_branch: 'main',
    repository: { id: dest.repositoryId, full_name: dest.repository },
    head_repository: { id: dest.repositoryId }, actor, triggering_actor: actor,
    display_title: `Nibfin ${origin.repositoryId} #3 wake`,
    created_at: '2026-11-16T00:02:01Z', status: 'in_progress' };
  const jobs = [{ id: 70, run_id: 60, run_attempt: 1, status: 'in_progress',
    url: `https://api.github.com/repos/${dest.repository}/actions/jobs/70`,
    runner_id: 400, runner_name: 'simulation-slot-1', labels: ['nibfin-user-7'] }];
  const state = { destinationId: dest.repositoryId, posts: 0,
    now: Date.parse('2026-11-16T00:02:00Z'), offline: false,
    lost: false, readbackLost: false, permission: 'write', dependencies: [],
    adoptionChanged: false, artifact, original, issue, run, jobs, reads: [] };
  const token = 'synthetic-managed-controller';
  const journalRoot = join(root, 'journal');
  await mkdir(journalRoot, { mode: 0o700 });
  await writeRelayState(journalRoot, 'control.json', { schemaVersion: 1, paused: false });
  const journal = () => new RelayJournal(journalRoot);
  const key = { repositoryId: origin.repositoryId, runId: 30, attempt: 1 };
  const json = value => new Response(JSON.stringify(value));
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url), path = parsed.pathname;
    if (parsed.hostname === 'fixture.blob.core.windows.net') {
      assert.equal(init.headers.Authorization, undefined);
      state.afterArtifact?.(state);
      return new Response(archive);
    }
    assert.equal(parsed.hostname, 'api.github.com');
    assert.equal(init.headers?.Authorization, `Bearer ${token}`);
    if (init.method === 'POST') {
      assert.equal(path, `/repos/${dest.repository}/actions/workflows/42/dispatches`);
      assert.equal((await journal().read(key)).status, 'pending');
      state.posts++;
      state.sent = JSON.parse(init.body);
      if (state.lost) throw new Error('simulated reply lost after commit');
      return json({ workflow_run_id: run.id,
        html_url: `https://github.com/${dest.repository}/actions/runs/${run.id}` });
    }
    if (state.offline) throw new Error('simulated provider offline');
    let value;
    const isDest = path.startsWith(`/repos/${dest.repository}`);
    if (path === '/user') value = actor;
    else if (path === `/repos/${origin.repository}` ||
      path === `/repos/${dest.repository}`) value = {
      id: isDest ? state.destinationId : origin.repositoryId,
      full_name: isDest ? dest.repository : origin.repository, private: false,
      archived: false, disabled: false, default_branch: 'main', owner: { id: memberId },
    };
    else if (path.endsWith('/branches/main'))
      value = { name: 'main', protected: true, commit: { sha: head } };
    else if (path.endsWith('/actions/workflows/42'))
      value = { id: 42, path: sharedPath, state: 'active' };
    else if (path.endsWith(`/actions/workflows/${origin.workflow.id}`))
      value = { id: origin.workflow.id, path: origin.workflow.path,
        state: state.workflowChanged ? 'disabled_manually' : 'active' };
    else if (path.includes('/contents/')) {
      const text = path.endsWith(sharedPath) ? shared : source;
      value = { type: 'file', path: path.split('/contents/')[1], sha: gitBlob(text),
        encoding: 'base64', size: Buffer.byteLength(text),
        content: Buffer.from(text).toString('base64') };
    } else if (path.endsWith('/actions/runs/30/attempts/1')) value = state.original;
    else if (path.endsWith('/actions/runs/30'))
      value = { ...state.original, run_attempt: 2 };
    else if (path.endsWith('/actions/runs/30/artifacts')) {
      if (state.artifactUnavailable) return new Response(null, { status: 403 });
      value = { artifacts: [state.artifact], total_count: 1 };
    } else if (path.endsWith('/actions/artifacts/40')) value = state.artifact;
    else if (path.endsWith('/actions/artifacts/40/zip'))
      return new Response(null, { status: 302,
        headers: { location: 'https://fixture.blob.core.windows.net/wake' } });
    else if (path.endsWith('/collaborators/operator/permission'))
      value = { user: actor, permission: state.permission };
    else if (path.endsWith('/issues/3')) value = state.issue;
    else if (path.endsWith('/dependencies/blocked_by')) value = state.dependencies;
    else if (path.endsWith('/issues/3/events')) value = [];
    else if (path.endsWith('/actions/runs/60')) {
      if (state.readbackLost) throw new Error('simulated exact readback offline');
      value = state.run;
    } else if (path.endsWith('/actions/runs/60/attempts/1/jobs')) value = {
      jobs: state.jobs, total_count: state.jobs.length };
    else if (path.endsWith(`/actions/workflows/${origin.workflow.id}/runs`))
      value = { workflow_runs: [{ ...state.original, run_attempt: 2 }], total_count: 1 };
    else throw new Error(`Unexpected controlled read: ${path}`);
    state.reads.push({ path, data: structuredClone(value) });
    return json(value);
  };
  const reader = () => new RelayReader(token, fetcher);
  const configuration = { origins: activation.config.origins, coreCommit, runner,
    memberId };
  const relay = () => new NotificationRelay({ reader: reader(), token,
    journal: journal(), configuration, fetcher, now: () => state.now,
    inspect: async () => {
      if (state.adoptionChanged) throw new Error('simulated adoption changed');
    } });
  return { state, origin, configuration, actor, key, journal, reader, relay,
    process: () => relay().process(origin, 30), root, event, produced };
}
