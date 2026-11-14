// Controlled source execution only; these readers are not GitHub observations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = process.env.E2E_CORE_ROOT;
if (!root) throw new Error('Prepared Core source required');
const load = path => import(pathToFileURL(resolve(root, path)).href);
const { pauseFixture, people, pauseIdentity } = await load('test/pause-fixture.mjs');
const { stageFixture } = await load('test/stage-fixture.mjs');
const { now } = await load('test/approval-fixture.mjs');
const { decideStage, stages } = await load('src/stages.mjs');
const { observePause } = await load('src/pause.mjs');
const { continueStages } = await load('src/stage-continuation.mjs');
const { stageSuccess } = await load('src/stage-runtime.mjs');
const { digest } = await load('src/identity.mjs');
const { githubReadWaiting } = await load('src/observation-failure.mjs');

async function observation(f) {
  return observePause(f.reader, pauseIdentity,
    (await f.journal.pauseEvidence()).decisions);
}

test('pause refuses every stage; lawful resume preserves ordinary gates', async t => {
  const f = await pauseFixture(t);
  assert.equal((await f.reconcile(f.emit(people.owner, 'labeled'))).status, 'paused');
  const paused = await observation(f);
  for (const stage of Object.keys(stages)) {
    const context = stageFixture(stage);
    const receipts = structuredClone(context.receipts);
    assert.equal(decideStage(stage, { ...context, pause: paused }, now).status,
      'denied');
    assert.deepEqual(context.receipts, receipts);
  }
  assert.equal((await f.reconcile(f.emit(people.owner, 'unlabeled'))).status, 'clear');
  const clear = await observation(f);
  const context = stageFixture();
  context.pause = clear;
  assert.equal(decideStage('shape', context, now).status, 'allowed');
  for (const mutate of [
    c => { c.approval.record.operations = []; },
    c => { c.dependencies.ready = false; },
    c => { c.isolation.writerStatus = 'unknown'; },
    c => { c.runner.memberId = 999; },
  ]) {
    const denied = structuredClone(context);
    mutate(denied);
    assert.equal(decideStage('shape', denied, now).status, 'denied');
  }
});

test('absent label with unqualified removal or unresolved history is not clear',
  async t => {
    const f = await pauseFixture(t);
    await f.reconcile(f.emit(people.owner, 'labeled'));
    // Observe before repair; label absence must not override event qualification.
    f.emit(people.stranger, 'unlabeled');
    assert.equal((await observation(f)).status, 'pending');
    f.fault('history');
    assert.equal((await observation(f)).status, 'pending');
  });

test('lost repair response remains unknown and is never blindly repeated', async t => {
  const f = await pauseFixture(t);
  await f.reconcile(f.emit(people.owner, 'labeled'));
  f.fault('lost');
  const removal = f.emit(people.stranger, 'unlabeled');
  assert.equal((await f.reconcile(removal)).status, 'pending');
  const count = f.writes();
  assert.equal(count, 1);
  assert.equal((await f.reconcile(removal)).status, 'pending');
  assert.equal(f.writes(), count);
  // A lawful resume cannot erase an unresolved journal write.
  const resume = f.emit(people.owner, 'unlabeled');
  assert.equal((await f.reconcile(resume)).status, 'pending');
  assert.equal(f.writes(), count);
  assert.equal((await f.journal.pauseEvidence()).pending, true);
});

function continuation() {
  const receipts = { shape: { stage: 'shape', outcome: 'ready' } };
  const objects = {};
  const calls = [];
  let time = 0;
  const options = {
    store: { load: async () => structuredClone(receipts),
      get: async key => objects[key] },
    inspect: async () => {}, clock: () => time,
    wait: async delay => { time += delay; }, ciTimeout: 20000,
    execute: async stage => {
      calls.push(stage);
      const receipt = { stage, outcome: stageSuccess[stage] };
      const receiptHash = digest(receipt);
      receipts[stage] = receipt;
      objects[receiptHash] = receipt;
      return { stage, status: 'completed', receiptHash };
    },
  };
  return { options, calls, receipts };
}

test('bounded read continuation preserves completed stages and exhausts safely',
  async () => {
    for (const recover of [true, false]) {
      const f = continuation();
      const execute = f.options.execute;
      let reads = 0;
      f.options.execute = async stage => {
        if (stage === 'accept' && (++reads <= 2 || !recover)) {
          return { stage, status: 'pending', code: githubReadWaiting };
        }
        return execute(stage);
      };
      const result = await continueStages(f.options);
      assert.equal(result.status, recover ? 'completed' : 'pending');
      assert.equal(reads, 3);
      assert.equal(f.calls.includes('shape'), false);
      assert.equal(f.calls.filter(s => s === 'deliver').length, 1);
      assert.equal(Boolean(f.receipts.close), recover);
    }
  });

test('unknown writes and unresolved Writer termination never start another Writer',
  async () => {
    for (const code of ['EXTERNAL_EFFECT_UNKNOWN', 'PROCESS_TERMINATION_UNKNOWN']) {
      const f = continuation();
      let calls = 0;
      f.options.execute = async stage => {
        calls++;
        return { stage, status: 'pending', code };
      };
      assert.equal((await continueStages(f.options)).code, code);
      assert.equal(calls, 1);
      assert.equal(f.calls.length, 0);
      assert.equal(f.receipts.deliver, undefined);
    }
    // A remote Job's terminal state is not a Core termination receipt.
    for (const conclusion of ['success', 'cancelled']) {
      const f = continuation();
      delete f.receipts.shape;
      f.receipts.shape = { stage: 'shape', outcome: 'blocked',
        execution: { id: 'original-writer' },
        references: [`https://github.com/example/core/actions/jobs/${conclusion}`] };
      assert.equal((await continueStages(f.options)).status, 'denied');
      assert.deepEqual(f.calls, []);
    }
  });

test('an owned live child keeps Writer admission denied until independent proof',
  async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore', shell: false });
    const closed = once(child, 'close');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await once(child, 'spawn');
      assert.equal(child.exitCode, null);
      const context = stageFixture('deliver');
      context.isolation.writerStatus = 'unknown';
      assert.equal(decideStage('deliver', context, now).status, 'denied');
      // Finishing this child says nothing about a distinct original Writer.
      child.kill('SIGTERM');
      await closed;
      assert.equal(decideStage('deliver', context, now).status, 'denied');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      clearTimeout(timer);
    }
  });

test('actual transient GitHub read exceptions are bounded before any stage effect',
  async () => {
    for (const recover of [true, false]) {
      const f = continuation();
      let reads = 0;
      f.options.inspect = async () => {
        if (++reads <= 2 || !recover) throw Object.assign(new Error('fixture read'),
          { transientGitHubRead: true });
      };
      if (recover) {
        assert.equal((await continueStages(f.options)).status, 'completed');
        assert.equal(f.calls.filter(stage => stage === 'deliver').length, 1);
      } else {
        await assert.rejects(continueStages(f.options), /fixture read/);
        assert.equal(reads, 3);
        assert.deepEqual(f.calls, []);
      }
    }
  });
