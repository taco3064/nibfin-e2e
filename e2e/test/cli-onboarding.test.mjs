import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareHandoff, validateRequest } from
  '../scenarios/cli-onboarding/handoff.mjs';
import { executeNative, nativeCases } from '../scenarios/cli-onboarding/native.mjs';
import { scenarios, select } from '../registry.mjs';
import { run } from '../runner.mjs';

function request(intent = 'init-apply', ownerType = 'User') {
  return {
    scenario: `cli-onboarding.${ownerType.toLowerCase()}.${intent}`,
    intent,
    target: {
      repository: 'example/project', id: 10, ownerType,
      defaultBranch: 'main', baseCommit: 'a'.repeat(40),
    },
    sources: Object.fromEntries([
      ['core', 'nibfin-core'], ['action', 'nibfin-act'], ['cli', 'gh-nibfin'],
    ].map(([id, name]) => [id, {
      repository: `taco3064/${name}`, commit: 'b'.repeat(40),
    }])),
    expected: {
      status: intent.endsWith('preview') ? 'preview' : 'proposal',
      head: intent.endsWith('preview') ? null : 'nibfin/proposal',
      files: [{ path: '.github/workflows/nibfin-wake.yml', content: 'fixture\n' }],
      labels: ['scope', 'shaped', 'delivered'],
    },
  };
}
function observation(bound = request()) {
  const { scenario, target, sources, expected } = structuredClone(bound);
  const preview = expected.status === 'preview';
  const pull = preview ? null : {
    url: `https://github.com/${target.repository}/pull/8`, state: 'open',
    base: target.defaultBranch, head: expected.head, headCommit: 'c'.repeat(40),
  };
  return {
    scenario, target, sources, origin: 'synthetic',
    cli: {
      status: preview ? 'preview' : 'pending',
      code: preview ? '' : bound.intent.startsWith('init-') ?
        'INSTALLATION_PR_REQUIRES_REVIEW_AND_MERGE' :
        'UPGRADE_PR_REQUIRES_REVIEW_CI_MERGE_AND_SEPARATE_HOST_ADOPTION',
      exitCode: !preview && bound.intent.startsWith('init-') ? 2 : 0,
      pullRequest: pull?.url ?? null,
      files: structuredClone(expected.files), labels: [...expected.labels],
    },
    provider: {
      state: 'observed', mutations: preview ? 0 : 7, defaultBranchWrites: 0,
      localEffects: 0,
      defaultBranchCommit: target.baseCommit, merged: false, pullRequest: pull,
      files: structuredClone(expected.files), labels: [...expected.labels],
    },
  };
}
for (const owner of ['User', 'Organization']) {
  for (const intent of ['init-preview', 'init-apply', 'upgrade-preview',
    'upgrade-apply']) {
    test(`${owner} ${intent}: synthetic matches cannot promote live readiness`, () => {
      const bound = request(intent, owner);
      const actual = observation(bound);
      assert.deepEqual(compareHandoff(bound, actual), {
        outcome: 'unverified', code: 'SYNTHETIC_CONTRACT_MATCHED',
        protectedExecution: 'unverified',
      });
      actual.origin = 'operator';
      const result = compareHandoff(bound, actual);
      assert.equal(result.outcome, 'passed');
      assert.equal(result.protectedExecution, 'unverified');
    });
  }
}

test('missing and unavailable live observations remain unverified', () => {
  const bound = request();
  assert.equal(compareHandoff(bound).code, 'LIVE_OBSERVATION_MISSING');
  const actual = observation(bound);
  actual.provider.state = 'unavailable';
  for (const key of ['mutations', 'defaultBranchWrites', 'localEffects',
    'defaultBranchCommit', 'merged']) {
    actual.provider[key] = null;
  }
  assert.equal(compareHandoff(bound, actual).outcome, 'unverified');
  actual.cli.status = 'error';
  actual.cli.code = 'PERMISSION_DENIED';
  actual.cli.exitCode = 1;
  assert.equal(compareHandoff(bound, actual).code, 'CLI_EXECUTION_FAILED');
});

test('malformed observations and cross-target/source replay fail', () => {
  const bound = request();
  for (const change of [
    actual => { actual.credentials = 'forbidden'; },
    actual => { actual.provider.files[0].path = '../escape'; },
    actual => { actual.target.id = -1; },
    actual => { actual.sources.cli.commit = 'bad'; },
    actual => { actual.provider.mutations = Infinity; },
    actual => { actual.cli.authorization = () => true; },
  ]) {
    const actual = observation(bound);
    change(actual);
    assert.equal(compareHandoff(bound, actual).code, 'MALFORMED_OBSERVATION');
  }
  for (const change of [
    actual => { actual.scenario = 'cli-onboarding.other'; },
    actual => { actual.target.repository = 'example/other'; },
    actual => { actual.target.ownerType = 'Organization'; },
    actual => { actual.sources.core.commit = 'd'.repeat(40); },
  ]) {
    const actual = observation(bound);
    change(actual);
    assert.equal(compareHandoff(bound, actual).code, 'OBSERVATION_BINDING_MISMATCH');
  }
});

test('provider contradictions and false completed installations are failures', () => {
  const bound = request();
  for (const change of [
    actual => { actual.provider.files[0].content = 'unexpected workflow'; },
    actual => { actual.provider.labels.pop(); },
    actual => { actual.provider.pullRequest.head = 'another-branch'; },
    actual => { actual.provider.pullRequest.base = 'another-base'; },
    actual => { actual.provider.pullRequest.headCommit = 'a'.repeat(40); },
    actual => { actual.provider.pullRequest.state = 'closed'; },
    actual => { actual.cli.pullRequest = 'https://github.com/other/repo/pull/8'; },
    actual => { actual.cli.status = 'completed'; },
    actual => { actual.provider.defaultBranchCommit = 'f'.repeat(40); },
    actual => { actual.provider.merged = true; },
    actual => { actual.provider.defaultBranchWrites = 1; },
    actual => { actual.cli.files[0].content = 'different CLI output'; },
  ]) {
    const actual = observation(bound);
    change(actual);
    assert.equal(compareHandoff(bound, actual).outcome, 'failing');
  }
});

test('preview is read-only and unknown effects never become success', () => {
  const bound = request('upgrade-preview');
  for (const field of ['mutations', 'localEffects']) {
    const actual = observation(bound);
    actual.provider[field] = 1;
    assert.equal(compareHandoff(bound, actual).outcome, 'failing');
  }
  const apply = request('upgrade-apply');
  const actual = observation(apply);
  actual.cli.code = 'UPGRADE_PR_UNKNOWN_READ_BACK_BEFORE_RETRY';
  actual.cli.exitCode = 2;
  assert.equal(compareHandoff(apply, actual).code, 'EXTERNAL_EFFECT_UNRESOLVED');
  actual.provider.pullRequest.head = 'contradicted';
  assert.equal(compareHandoff(apply, actual).outcome, 'failing');
  actual.provider.pullRequest.head = apply.expected.head;
  actual.cli.code = 'PERMISSION_DENIED';
  assert.equal(compareHandoff(apply, actual).outcome, 'failing');
});

test('requests reject capabilities, unbounded contents and extra paths', () => {
  for (const change of [
    value => { value.command = ['gh', 'api']; },
    value => { value.fixture = {}; },
    value => { value.expected.files[0].content = 'x'.repeat(65537); },
    value => { value.expected.files[0].path = '.github/workflows/other.yml'; },
    value => { value.target.token = 'forbidden'; },
    value => { value.sources.cli.commit = 'main'; },
    value => { value.expected.labels.push('admin'); },
    value => { value.expected.head = '../bad'; },
  ]) {
    const value = request();
    change(value);
    assert.throws(() => validateRequest(value), /MALFORMED_HANDOFF/);
  }
});

test('native driver requires every assertion and cleans isolated copies on failure',
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'nibfin-native-test-'));
    try {
      const checkout = join(tempDir, 'fixture-source');
      await mkdir(join(checkout, 'internal/cli'), { recursive: true });
      await writeFile(join(checkout, 'go.mod'), 'synthetic source\n');
      const context = { tempDir, sources: { cli: { checkout } } };
      const complete = async () => ({
        stdout: nativeCases.flatMap(name => ['', '/User', '/Organization']
          .map(suffix => JSON.stringify({ Action: 'pass', Test: name + suffix })))
          .join('\n'), stderr: '',
      });
      assert.equal((await executeNative(context, complete)).evidence, 'synthetic');
      assert.deepEqual(await readdir(tempDir), ['fixture-source']);
      await assert.rejects(executeNative(context, async () => ({
        stdout: JSON.stringify({ Action: 'pass', Test: nativeCases[0] }), stderr: '',
      })), /NATIVE_ASSERTIONS_MISSING/);
      await assert.rejects(executeNative(context, async () => {
        throw new Error('actual CLI compile error');
      }), /actual CLI compile error/);
      assert.deepEqual(await readdir(tempDir), ['fixture-source']);
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  });

test('registry contract blocks honestly when prepared sources are missing', async () => {
  const selected = select(scenarios, ['cli-onboarding']);
  assert.equal(selected.length, 1);
  const document = await run(selected);
  assert.equal(document.results[0].outcome, 'blocked');
});

test('unchanged handoffs require no new PR or provider mutation', () => {
  for (const intent of ['init-apply', 'upgrade-apply']) {
    const bound = request(intent);
    bound.expected = { status: 'unchanged', head: null, files: [], labels: [] };
    const actual = observation(bound);
    actual.cli.status = intent === 'init-apply' ? 'completed' : 'no_change';
    actual.cli.exitCode = 0;
    actual.cli.code = intent === 'init-apply' ? 'INITIALIZATION_READ_BACK' :
      'MANAGED_SOURCES_ALREADY_CURRENT';
    actual.cli.pullRequest = null;
    actual.provider.pullRequest = null;
    actual.provider.mutations = 0;
    assert.equal(compareHandoff(bound, actual).code, 'SYNTHETIC_CONTRACT_MATCHED');
    actual.provider.mutations = 1;
    assert.equal(compareHandoff(bound, actual).outcome, 'failing');
  }
});

test('onboarding coexists with current wake and isolation registrations', async () => {
  const wake = select(scenarios, ['wake-contract']);
  assert.deepEqual(wake.map(row => row.id), [
    'wake.action.fixture', 'wake.shared-issue.fixture',
  ]);
  const document = await run(wake);
  assert.deepEqual(document.results.map(row => row.outcome), ['passed', 'passed']);
  assert.equal(select(scenarios, ['isolation.local']).length, 1);
  assert.equal(select(scenarios, ['isolation.host']).length, 4);
  const combined = select(scenarios, ['wake-contract', 'cli-onboarding']);
  assert.equal(combined.length, 3);
  assert.equal(combined[0].id, 'cli-onboarding.contract');
});

for (const state of ['observed', 'unavailable']) {
  test(`${state} partial observations preserve known contradictions`, () => {
    for (const intent of ['init-apply', 'upgrade-apply']) {
      const bound = request(intent);
      for (const change of [
        value => { value.provider.files[0].content = 'contradiction'; },
        value => { value.provider.labels.pop(); },
        value => { value.provider.pullRequest.head = 'wrong'; },
        value => { value.provider.pullRequest.base = 'wrong'; },
        value => { value.provider.pullRequest.state = 'closed'; },
        value => { value.cli.pullRequest += '0'; },
      ]) {
        for (const unknown of [false, true]) {
          const actual = observation(bound);
          actual.provider.state = state;
          if (unknown) {
            actual.cli.code = 'PR_RESULT_UNKNOWN_READ_BACK_BEFORE_RETRY';
            actual.cli.exitCode = 2;
          }
          change(actual);
          assert.equal(compareHandoff(bound, actual).outcome, 'failing');
        }
      }
    }
    for (const status of ['preview', 'unchanged']) {
      const bound = request(status === 'preview' ? 'init-preview' : 'init-apply');
      if (status === 'unchanged') {
        bound.expected = { status, head: null, files: [], labels: [] };
      }
      for (const field of ['pullRequest', 'mutations']) {
        const actual = observation(bound);
        actual.provider.state = state;
        if (status === 'unchanged') {
          actual.cli.status = 'completed';
          actual.cli.code = 'INITIALIZATION_READ_BACK';
          actual.cli.exitCode = 0;
          actual.cli.pullRequest = null;
        }
        actual.provider.pullRequest = null;
        actual.provider.mutations = 0;
        if (field === 'mutations') actual.provider.mutations = 1;
        else actual.provider.pullRequest = observation().provider.pullRequest;
        assert.equal(compareHandoff(bound, actual).outcome, 'failing');
      }
    }
  });
}
