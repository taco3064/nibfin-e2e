import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { detectPlatform, run, scenarioGroups } from '../src/run.ts';
import { select } from '../src/select.ts';
import type { MapEntry, Outcome, ProvisioningStep, RunContext, RunTarget, Scenario } from '../src/types.ts';
import { fakeHostContext as host, passed, scenario, step } from './fixtures.ts';

const target: RunTarget = { ghNibfinCommit: 'a'.repeat(40), platform: 'linux' };

function entriesFor(list: Scenario[]): MapEntry[] {
  const rules = [...new Set(list.flatMap((s) => s.rules))].sort();
  return rules.map((id) => ({ id, platforms: ['linux'], scenarios: list.filter((s) => s.rules.includes(id)).map((s) => s.id) }));
}

async function runAll(list: Scenario[], steps: ProvisioningStep[] = [], entries = entriesFor(list)) {
  const { selected } = select(entries, list, { all: true });
  return run({ selection: { all: true }, selected, steps, target, host, log: () => {}, now: () => new Date(0) });
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
  equal(r.meta.imageDigest, null);
  deepEqual(r.teardown, []);
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
  const r = await run({ selection, selected, steps: [], target, host, log: () => {} });
  equal(r.gate, undefined);
  equal(r.meta.mode, 'select');
});

test('requires is transitive; a step behind a failed or waiting prerequisite does not run and reports it', async () => {
  const calls: string[] = [];
  const steps = [
    step('base', new Error('no podman'), calls),
    step('pending', { status: 'waiting', reason: 'not released' }, calls),
    step('login', passed, calls, { requires: ['base'] }),
    step('top', passed, calls, { requires: ['login', 'pending'] }),
  ];
  const r = await runAll([scenario('a', ['R1.1'], ['linux'], passed, ['top'])], steps);
  deepEqual(calls, ['base', 'pending']);
  deepEqual(r.provisioning.map((p) => [p.id, p.status, p.reason]), [
    ['base', 'failed', 'no podman'],
    ['pending', 'waiting', 'not released'],
    ['login', 'failed', 'provisioning step base failed: no podman'],
    ['top', 'failed', 'provisioning step login failed: provisioning step base failed: no podman'],
  ]);
  deepEqual(r.scenarios.map((s) => [s.id, s.status]), [['a', 'failed']]);
});

test('teardowns of the steps that ran run in reverse order after the scenarios, also after failures', async () => {
  const calls: string[] = [];
  const down = (id: string, outcome: Outcome | Error) => async () => {
    calls.push(`down:${id}`);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  const steps = [
    step('one', passed, calls, { teardown: down('one', passed) }),
    step('two', { status: 'failed', reason: 'half done', facts: { imageDigest: 'sha256:' + 'f'.repeat(64) } }, calls, { teardown: down('two', new Error('left a runner')) }),
    step('three', passed, calls, { requires: ['two'], teardown: down('three', passed) }),
    step('unused', passed, calls, { teardown: down('unused', passed) }),
  ];
  const s = { ...scenario('a', ['R1.1'], ['linux'], passed, ['one', 'three']), run: async () => (calls.push('scenario'), passed) };
  const r = await runAll([s], steps);
  deepEqual(calls, ['one', 'two', 'down:two', 'down:one']);
  deepEqual(r.teardown, [
    { id: 'two', status: 'failed', reason: 'left a runner' },
    { id: 'one', status: 'passed', reason: 'ok' },
  ]);
  equal(r.meta.imageDigest, 'sha256:' + 'f'.repeat(64));
  deepEqual(r.provisioning[1]?.facts, { imageDigest: 'sha256:' + 'f'.repeat(64) });
  equal(r.gate?.passed, false);
  equal(r.gate?.reasons.some((x) => x === 'teardown two failed: left a runner'), true);
});

test('scenarios get the facts of the steps that ran', async () => {
  let seen: unknown;
  const s = { ...scenario('a', ['R1.1'], ['linux'], passed, ['one']), run: async (ctx: RunContext) => ((seen = ctx.facts('one')), passed) };
  await runAll([s], [step('one', { ...passed, facts: { n: 1 } })]);
  deepEqual(seen, { n: 1 });
});

test('deferred cleanups run after each scenario in reverse order, also when it throws; a hanging or throwing one is bounded and logged', async () => {
  const order: string[] = [];
  const logs: string[] = [];
  const mk = (id: string, body: (ctx: RunContext) => Promise<Outcome>): Scenario => ({ id, rules: ['R1.1'], platforms: ['linux'], run: body });
  const list = [
    mk('a', async (ctx) => {
      ctx.defer(async () => order.push('a1'));
      ctx.defer(async () => order.push('a2'));
      throw new Error('scenario a broke');
    }),
    mk('b', async (ctx) => {
      order.push('b-run');
      ctx.defer(() => new Promise(() => {}));
      ctx.defer(async () => {
        throw new Error('cleanup broke');
      });
      return passed;
    }),
    mk('c', async () => (order.push('c-run'), passed)),
  ];
  const { selected } = select([{ id: 'R1.1', platforms: ['linux'], scenarios: ['a', 'b', 'c'] }], list, { all: true });
  const r = await run({ selection: { all: true }, selected, steps: [], target, host, log: (m) => logs.push(m), cleanupTimeoutMs: 20 });
  deepEqual(order, ['a2', 'a1', 'b-run', 'c-run']);
  deepEqual(r.scenarios.map((s) => s.status), ['failed', 'passed', 'passed']);
  deepEqual(logs.filter((l) => l.startsWith('cleanup')), ['cleanup of scenario b: cleanup broke', 'cleanup of scenario b: did not finish within 20 ms']);
});

test('children a scenario starts are stopped when it ends', async () => {
  const started: { stops: number }[] = [];
  const counting = {
    ...host,
    start: () => {
      const c = { stops: 0, output: () => '', waitFor: async () => [] as unknown as RegExpExecArray, stop: async () => (c.stops++, { code: 0, stdout: '', stderr: '' }) };
      started.push(c);
      return c;
    },
  };
  const s: Scenario = { id: 's', rules: ['R1.1'], platforms: ['linux'], run: async (ctx) => (ctx.start(['podman', 'events']), passed) };
  const { selected } = select([{ id: 'R1.1', platforms: ['linux'], scenarios: ['s'] }], [s], { all: true });
  await run({ selection: { all: true }, selected, steps: [], target, host: counting, log: () => {} });
  deepEqual(started.map((c) => c.stops), [1]);
});

/** A scenario that records when it starts and ends; it ends after a short delay. */
function timed(id: string, concurrent: boolean, events: string[], outcome: Outcome | Error = passed): Scenario {
  return {
    id,
    rules: [`R1.${id.charCodeAt(0)}`],
    platforms: ['linux'],
    concurrent,
    run: async () => {
      events.push(`start ${id}`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`end ${id}`);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

test('consecutive concurrent scenarios overlap; others run alone; results keep registry order', async () => {
  const events: string[] = [];
  const r = await runAll([
    timed('a', false, events),
    timed('b', true, events),
    timed('c', true, events),
    timed('d', true, events, new Error('group member broke')),
    timed('e', false, events),
  ]);
  deepEqual(events.slice(0, 2), ['start a', 'end a']);
  deepEqual(events.slice(2, 5), ['start b', 'start c', 'start d']);
  deepEqual(events.slice(-2), ['start e', 'end e']);
  deepEqual(r.scenarios.map((s) => [s.id, s.status]), [['a', 'passed'], ['b', 'passed'], ['c', 'passed'], ['d', 'failed'], ['e', 'passed']]);
  equal(r.scenarios[3]?.reason, 'group member broke');
});

test('a non-concurrent scenario between concurrent ones splits them into two groups', () => {
  const s = (id: string, concurrent?: boolean) => ({ ...scenario(id, ['R1.1'], ['linux'], passed), concurrent });
  deepEqual(
    scenarioGroups([s('a', true), s('b'), s('c', true), s('d', true), s('e', false)]).map((g) => g.map((x) => x.id)),
    [['a'], ['b'], ['c', 'd'], ['e']],
  );
});

test('each concurrent scenario runs only its own deferred cleanups, when it ends', async () => {
  const order: string[] = [];
  const mk = (id: string, ms: number): Scenario => ({
    id,
    rules: [`R1.${id.charCodeAt(0)}`],
    platforms: ['linux'],
    concurrent: true,
    run: async (ctx) => {
      ctx.defer(async () => order.push(`cleanup ${id}`));
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end ${id}`);
      return passed;
    },
  });
  await runAll([mk('a', 1), mk('b', 30)]);
  deepEqual(order, ['end a', 'cleanup a', 'end b', 'cleanup b']);
});

test('a scenario whose selected rules are all waiting is reported waiting and not run; its steps do not run', async () => {
  const calls: string[] = [];
  const list = [
    { ...scenario('w', ['R1.1'], ['linux'], passed, ['only-w']), run: async () => (calls.push('w'), passed) },
    { ...scenario('m', ['R1.1', 'R1.2'], ['linux'], passed, ['shared']), run: async () => (calls.push('m'), passed) },
  ];
  const steps = [step('only-w', passed, calls), step('shared', passed, calls)];
  const entries = entriesFor(list);
  const { selected } = select(entries, list, { all: true });
  const waiting = [{ id: 'R1.1', issues: ['https://github.com/taco3064/nibfin-core/issues/9'] }];
  const r = await run({ selection: { all: true }, selected, steps, target, host, log: () => {}, waiting, runner: 'GitHub Actions 7' });
  deepEqual(calls, ['shared', 'm']);
  deepEqual(r.scenarios.map((s) => [s.id, s.status, s.reason]), [
    ['w', 'waiting', 'not run: rule R1.1 is waiting on https://github.com/taco3064/nibfin-core/issues/9'],
    ['m', 'passed', 'ok'],
  ]);
  equal(r.scenarios[0]?.blockedBy, undefined);
  equal(r.meta.runner, 'GitHub Actions 7');
  equal(r.gate?.passed, false);
});

test('a waiting rule outside the selection does not hold back a scenario', async () => {
  const list = [scenario('m', ['R1.1', 'R1.2'], ['linux'], passed)];
  const selection = { all: false as const, rules: ['R1.2'], sections: [] };
  const { selected } = select(entriesFor(list), list, selection);
  const r = await run({ selection, selected, steps: [], target, host, log: () => {}, waiting: [{ id: 'R1.1', issues: ['u'] }] });
  deepEqual(r.scenarios.map((s) => s.status), ['passed']);
  equal(r.meta.runner, null);
});

test('blocked steps and scenarios name the step that blocked them', async () => {
  const steps = [step('base', new Error('no podman')), step('login', passed, undefined, { requires: ['base'] }), step('later', { status: 'waiting', reason: 'x' })];
  const r = await runAll([scenario('a', ['R1.1'], ['linux'], passed, ['login']), scenario('b', ['R1.2'], ['linux'], passed, ['later'])], steps);
  deepEqual(r.provisioning.map((p) => [p.id, p.blockedBy]), [['base', undefined], ['login', 'base'], ['later', undefined]]);
  deepEqual(r.scenarios.map((s) => [s.id, s.blockedBy]), [['a', 'login'], ['b', 'later']]);
});

test('a waiting scenario among concurrent ones is not run; the others still start together and order is kept', async () => {
  const events: string[] = [];
  const list = [timed('a', true, events), timed('b', true, events), timed('c', true, events)];
  const { selected } = select(entriesFor(list), list, { all: true });
  const waiting = [{ id: 'R1.98', issues: ['u'] }];
  const r = await run({ selection: { all: true }, selected, steps: [], target, host, log: () => {}, waiting });
  deepEqual(events.slice(0, 2), ['start a', 'start c']);
  deepEqual(r.scenarios.map((s) => [s.id, s.status]), [['a', 'passed'], ['b', 'waiting'], ['c', 'passed']]);
});
