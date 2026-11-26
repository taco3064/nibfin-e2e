import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { detectPlatform, run } from '../src/run.ts';
import { select } from '../src/select.ts';
import type { MapEntry, ProvisioningStep, RunTarget, Scenario } from '../src/types.ts';
import { passed, scenario, step } from './fixtures.ts';

const target: RunTarget = { ghNibfinCommit: 'a'.repeat(40), image: 'img@sha256:' + 'b'.repeat(64), imageDigest: 'sha256:' + 'b'.repeat(64), platform: 'linux' };

function entriesFor(list: Scenario[]): MapEntry[] {
  const rules = [...new Set(list.flatMap((s) => s.rules))].sort();
  return rules.map((id) => ({ id, platforms: ['linux'], scenarios: list.filter((s) => s.rules.includes(id)).map((s) => s.id) }));
}

async function runAll(list: Scenario[], steps: ProvisioningStep[] = [], entries = entriesFor(list)) {
  const { selected } = select(entries, list, { all: true });
  return run({ selection: { all: true }, selected, steps, target, log: () => {}, now: () => new Date(0) });
}

test('detectPlatform maps node platforms', () => {
  deepEqual(['linux', 'darwin', 'win32', 'aix'].map(detectPlatform), ['linux', 'macos', 'windows', undefined]);
});

test('scenario outcomes passed, failed, waiting and thrown are reported with reasons', async () => {
  const r = await runAll([
    scenario('p', ['R1.1'], ['linux'], passed),
    scenario('f', ['R1.2'], ['linux'], { status: 'failed', reason: 'boom' }),
    scenario('w', ['R1.3'], ['linux'], { status: 'waiting', reason: 'spec ahead' }),
    scenario('t', ['R1.4'], ['linux'], new Error('thrown')),
  ]);
  deepEqual(r.scenarios, [
    { id: 'p', rules: ['R1.1'], status: 'passed', reason: 'ok' },
    { id: 'f', rules: ['R1.2'], status: 'failed', reason: 'boom' },
    { id: 'w', rules: ['R1.3'], status: 'waiting', reason: 'spec ahead' },
    { id: 't', rules: ['R1.4'], status: 'failed', reason: 'thrown' },
  ]);
  equal(r.gate?.passed, false);
  equal(r.gate?.reasons.length, 3);
  equal(r.meta.mode, 'all');
  equal(r.meta.ghNibfinCommit, target.ghNibfinCommit);
  equal(r.meta.startedAt, new Date(0).toISOString());
});

test('a malformed outcome is failed', async () => {
  const bad = { id: 'x', rules: ['R1.1'], platforms: ['linux'], run: async () => ({ status: 'ok' }) } as unknown as Scenario;
  equal((await runAll([bad])).scenarios[0]?.status, 'failed');
});

test('required provisioning runs once, in registry order; failure and waiting propagate', async () => {
  const calls: string[] = [];
  const steps = [
    step('unused', passed, calls),
    step('ok', passed, calls),
    step('broken', new Error('no podman'), calls),
    step('later', { status: 'waiting', reason: 'not released' }, calls),
  ];
  const r = await runAll(
    [
      scenario('a', ['R1.1'], ['linux'], passed, ['later', 'ok']),
      scenario('b', ['R1.2'], ['linux'], passed, ['ok', 'broken', 'later']),
      scenario('c', ['R1.3'], ['linux'], passed, ['ok']),
    ],
    steps,
  );
  deepEqual(calls, ['ok', 'broken', 'later']);
  deepEqual(r.provisioning.map((p) => [p.id, p.status]), [['ok', 'passed'], ['broken', 'failed'], ['later', 'waiting']]);
  deepEqual(r.scenarios.map((s) => [s.id, s.status, s.reason]), [
    ['a', 'waiting', 'provisioning step later is waiting: not released'],
    ['b', 'failed', 'provisioning step broken failed: no podman'],
    ['c', 'passed', 'ok'],
  ]);
});

test('only scenarios for this platform run; rules without one are listed', async () => {
  const list = [scenario('w', ['R5.13'], ['windows'], passed), scenario('l', ['R5.15'], ['linux'], passed)];
  const entries: MapEntry[] = [
    { id: 'R5.13', platforms: ['windows'], scenarios: ['w'] },
    { id: 'R5.15', platforms: ['linux'], scenarios: ['l'] },
  ];
  const r = await runAll(list, [], entries);
  deepEqual(r.scenarios.map((s) => s.id), ['l']);
  deepEqual(r.rulesWithoutScenarioOnPlatform, ['R5.13']);
  deepEqual(r.gate, { passed: true, reasons: [] });
});

test('the gate fails below 100% coverage', async () => {
  const entries: MapEntry[] = [
    { id: 'R1.1', platforms: ['linux'], scenarios: ['p'] },
    { id: 'R1.2', platforms: ['linux', 'macos'], scenarios: [] },
    { id: 'R1.3', notE2e: '設計原則' },
  ];
  const r = await runAll([scenario('p', ['R1.1'], ['linux'], passed)], [], entries);
  equal(r.gate?.passed, false);
  deepEqual(r.gate?.reasons, ['coverage is 50% (1/2); a release needs 100%']);
});

test('a selection run has no gate', async () => {
  const list = [scenario('p', ['R1.1'], ['linux'], passed)];
  const entries = entriesFor(list);
  const selection = { all: false as const, rules: ['R1.1'], sections: [] };
  const { selected } = select(entries, list, selection);
  const r = await run({ selection, selected, steps: [], target, log: () => {} });
  equal(r.gate, undefined);
  equal(r.meta.mode, 'select');
});
