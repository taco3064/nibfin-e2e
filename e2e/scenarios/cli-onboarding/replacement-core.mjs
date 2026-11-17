import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { producerFile } from '../../source-producers.mjs';

export const replacementCases = ['drain-arrival', 'writer', 'relay', 'partial',
  'unknown-removal', 'permission-recheck', 'cleanup', 'provider',
  'lost-effect', 'activation'];

// Run only in the bounded source child. Ports provide fixture observations;
// retirement and admission decisions remain entirely in the prepared producer.
export async function replacementCore(core) {
  const load = async path => import(pathToFileURL(
    await producerFile(core.checkout, `src/${path}.mjs`)).href);
  const { retireManagedPool, requireRetiredReplacement } =
    await load('managed-retirement');
  const { poolAdmission, requirePoolOpen, requirePoolConsumersSettled, withPoolGate } =
    await load('retirement-admission');
  const { commitReplacementAdmission } = await load('retirement-rebind');
  const { verifyReplacementRunners } = await load('retirement-activate');
  const root = await mkdtemp(join(tmpdir(), 'e2e-replacement-'));
  const marker = join(root, 'drain');
  const old = { repository: 'fixture/primary', repositoryId: 10, memberId: 7,
    runners: [{ id: 25, name: 'old-one' }, { id: 26, name: 'old-two' }] };
  const binding = { pool: old, provider: 'codex', slots: [1, 2],
    repositories: [10, 11] };
  const host = { stateRoot: root, uid: process.getuid() };
  const passed = [];
  try {
    for (const kind of replacementCases) {
      await rm(marker, { force: true });
      const statePath = join(root, 'retirement.json');
      await rm(statePath, { force: true });
      const effects = new Set(), counts = new Map();
      let unknown = null, failure = null, unsettled = null;
      let arrival;
      let native = ['present', 'present'];
      const ports = {
        read: async () => {
          try { return JSON.parse(await readFile(statePath, 'utf8')); }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
        },
        write: value => writeFile(statePath, JSON.stringify(value)),
        inspectBinding: async () => {},
        observeEffect: async name => unknown === name ? 'unknown' :
          effects.has(name) ? 'done' : 'absent',
        performEffect: async name => {
          counts.set(name, (counts.get(name) ?? 0) + 1);
          if (name === 'close-admission') await withPoolGate(host, async () => {
            await writeFile(marker, 'closed');
            if (kind === 'drain-arrival') {
              arrival = assert.rejects(poolAdmission(host, async () => {
                assert.fail('concurrent arrival admitted at drain boundary');
              }, marker), { code: 'MANAGED_POOL_RETIRING' });
            }
          });
          effects.add(name);
          if ((kind === 'provider' && name === 'provider') ||
              (kind === 'cleanup' && name === 'services')) unknown = name;
          if (failure === name) throw new Error('fixture lost effect response');
        },
        assertClosed: () => assert.rejects(requirePoolOpen(marker),
          { code: 'MANAGED_POOL_RETIRING' }),
        settle: async () => {
          await requirePoolConsumersSettled(host);
          if (unsettled) throw Object.assign(new Error(), { code: unsettled });
        },
        registrations: async () => native,
        cleanupEffects: ['services', 'provider'],
      };
      const run = () => retireManagedPool(binding, ports);
      let release, entered;
      const started = new Promise(resolve => { entered = resolve; });
      let admitted;
      if (kind === 'drain-arrival') {
        admitted = poolAdmission(host, async () => {
          entered();
          await new Promise(resolve => { release = resolve; });
        }, marker);
        await started;
      }
      if (kind === 'writer') unsettled = 'RETIREMENT_WRITER_UNKNOWN';
      if (kind === 'relay') unsettled = 'RETIREMENT_RELAY_UNKNOWN';
      if (kind === 'lost-effect') failure = 'relay-pause';
      const first = await run();
      if (kind === 'drain-arrival') {
        assert.equal(first.removal.permitted, false);
        assert.equal(first.code, 'RETIREMENT_CONSUMER_PENDING');
        await assert.rejects(poolAdmission(host, async () => {
          assert.fail('arrival admitted after drain');
        }, marker), { code: 'MANAGED_POOL_RETIRING' });
        await arrival;
        release();
        await admitted;
      }
      if (['writer', 'relay'].includes(kind)) {
        assert.equal(first.removal.permitted, false);
        assert.equal((await run()).retirementId, first.retirementId);
        unsettled = null;
      }
      const removal = await run();
      assert.equal(removal.phase, 'removal');
      assert.equal(removal.removal.permitted, true);
      assert.deepEqual(removal.removal.runners, old.runners);
      if (kind === 'permission-recheck') {
        // A persisted removal phase does not bypass current settlement.
        unsettled = 'RETIREMENT_WRITER_UNKNOWN';
        const revoked = await run();
        assert.equal(revoked.phase, 'removal');
        assert.equal(revoked.retirementId, first.retirementId);
        assert.equal(revoked.removal.permitted, false);
        assert.equal(counts.has('services'), false);
        unsettled = null;
        assert.equal((await run()).removal.permitted, true);
      }
      if (kind === 'partial' || kind === 'unknown-removal') {
        native = ['absent', kind === 'partial' ? 'present' : 'unknown'];
        const partial = await run();
        assert.equal(partial.status, 'pending');
        assert.equal(counts.has('services'), false);
        if (kind === 'unknown-removal') assert.equal(partial.removal.permitted, false);
      }
      native = ['absent', 'absent'];
      if (kind === 'cleanup' || kind === 'provider') {
        const effect = kind === 'cleanup' ? 'services' : 'provider';
        assert.equal((await run()).code, 'CLEANUP_EFFECT_UNKNOWN');
        assert.equal((await run()).status, 'pending');
        assert.equal(counts.get(effect), 1);
        unknown = null;
      }
      const retired = await run();
      assert.equal(retired.status, 'retired');
      assert.equal(retired.retirementId, first.retirementId);
      assert.deepEqual(await run(), retired);
      for (const name of ['close-admission', 'relay-pause', 'services', 'provider'])
        assert.equal(counts.get(name), 1, name);
      const pool = { ...old,
        runners: [{ id: 31, name: 'fresh-one' }, { id: 32, name: 'fresh-two' }] };
      let state = await ports.read();
      requireRetiredReplacement(state, pool);
      assert.throws(() => requireRetiredReplacement(state, old));
      const registrations = pool.runners.map(r => ({ ...r, os: 'Linux', busy: false,
        status: 'online', labels: [{ name: 'nibfin-shared' },
          { name: 'nibfin-user-7' }] }));
      verifyReplacementRunners(pool, old, registrations);
      for (const invalid of [registrations.slice(0, 1),
        [...registrations, { id: 25 }],
        [registrations[0], { ...registrations[1], busy: true }]])
        assert.throws(() => verifyReplacementRunners(pool, old, invalid));
      if (kind === 'activation') {
        state.replacement = { phase: 'prepared', pool };
        let drain = { schemaVersion: 1, retirementId: state.id, pool: old };
        let verified = false, interrupt = true, opens = 0;
        const activation = {
          readDrain: async () => drain,
          verify: async () => { assert(verified, 'wake/adoption readback missing'); },
          write: async value => { state = structuredClone(value); },
          open: async () => {
            if (interrupt) throw new Error('fixture activation interrupted');
            opens++;
            drain = null;
          },
        };
        await assert.rejects(commitReplacementAdmission(state, activation));
        assert.equal(state.replacement.phase, 'prepared');
        verified = true;
        await assert.rejects(commitReplacementAdmission(state, activation));
        assert.equal(state.replacement.phase, 'released');
        assert.ok(drain);
        interrupt = false;
        assert.deepEqual(await commitReplacementAdmission(state, activation),
          { released: true });
        await commitReplacementAdmission(state, activation);
        assert.equal(opens, 1);
      }
      passed.push(kind);
    }
    return { evidence: 'synthetic', passed };
  } finally { await rm(root, { recursive: true, force: true }); }
}
