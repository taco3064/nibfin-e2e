// Executed against explicitly prepared Core source, without provider or WSL access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { observePressure } from './pressure-observations.mjs';
import { pressureFixture } from './scenarios/pressure-fixtures.mjs';

const root = process.env.E2E_CORE_ROOT;
if (!root) throw new Error('Prepared Core source required');
const { writerCapacity, acquireWriterCapacity, writerPressureWait,
  writerInitializeTimeout } = await import(pathToFileURL(
  resolve(root, 'src/job-vm-pressure.mjs')).href);
const sample = available => writerCapacity(
  `MemAvailable: ${available * 1024} kB\n`, 'full avg10=0\n',
  'Node 0, zone DMA32 10 2 3 4 5 6 7 2 0\n', 640);

async function controlled(use) {
  const pressureRoot = await mkdtemp(join(tmpdir(), 'e2e-pressure-'));
  const releases = new Set();
  const enter = async (read, options = {}) => {
    const release = await acquireWriterCapacity({ pressureRoot, memoryMiB: 640 },
      new AbortController().signal, { read, report: () => {}, ...options });
    const retire = async () => { await release(); releases.delete(retire); };
    releases.add(retire);
    return retire;
  };
  try { await use(enter); }
  finally {
    for (const retire of releases) await retire();
    await rm(pressureRoot, { recursive: true, force: true });
  }
}

test('actual shared locks admit parallel Writers and drain before serial entry',
  async () => controlled(async enter => {
    const { binding, evidence } = pressureFixture('serial');
    evidence.samples = [];
    evidence.writers = [];
    evidence.diagnostics = [];
    let now = 1;
    const add = async (index, metrics, options) => {
      const a = evidence.admissions[index];
      const retire = await enter(async () => {
        const decision = sample(metrics);
        evidence.samples.push({ ...a, clockId: binding.clockId,
          experimentId: binding.experimentId,
          at: now, mode: decision.mode });
        return decision;
      }, options);
      const w = { ...a, executionId: `actual-${index}`, start: now,
        activeUntil: now, end: null };
      evidence.writers.push(w);
      return async () => { await retire(); w.end = now; w.activeUntil = now; };
    };
    const first = await add(0, 2600);
    const extra = { ...evidence.admissions[1], jobId: 99, runId: 99 };
    evidence.admissions.push(extra);
    const second = await add(2, 2600);
    let waits = 0;
    now = 2;
    const serial = await add(1, 1300, { wait: async () => {
      now++;
      await (waits++ === 0 ? first : second)();
    } });
    assert.equal(waits, 2);
    assert.equal(evidence.writers.at(-1).start, 4);
    now = 8;
    await serial();
    assert.equal(observePressure(binding, evidence).state, 'passed');
    // A new shared acquisition succeeds again after exclusive retirement.
    const third = await enter(async () => sample(2600));
    const fourth = await enter(async () => sample(2600));
    await third();
    await fourth();
  }));

test('actual insufficient capacity resamples until the five-minute diagnosis',
  async () => controlled(async enter => {
    const { binding, evidence } = pressureFixture('expired');
    evidence.samples = [];
    evidence.diagnostics = [];
    evidence.waitBoundMs = 300000;
    evidence.coverage.end = 300000;
    let now = 0;
    try {
      await enter(async () => {
        const decision = sample(800);
        evidence.samples.push({ ...evidence.admissions[0],
          clockId: binding.clockId, experimentId: binding.experimentId,
          at: now, mode: decision.mode });
        return decision;
      }, { clock: () => now, wait: async ms => { now += ms; } });
      assert.fail('Expected bounded pressure expiry');
    } catch (error) {
      assert.equal(error.code, writerPressureWait);
      evidence.diagnostics.push({ ...evidence.admissions[0],
        clockId: binding.clockId, experimentId: binding.experimentId,
        at: now, elapsedMs: now,
        handshakeAttempt: 0, executionId: null, code: error.code });
    }
    assert.equal(now, 300000);
    assert.equal(evidence.samples.length, 21);
    assert.equal(observePressure(binding, evidence).state, 'passed');
    assert.notEqual(writerInitializeTimeout, writerPressureWait);
    assert.equal(writerInitializeTimeout, 'JOB_VM_EXEC_INITIALIZE_TIMEOUT');
  }));
