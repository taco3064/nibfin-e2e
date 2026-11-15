import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runDeliveryPairPrepared } from './delivery-pair.mjs';
import { observeLiveWake } from './wake-protected.mjs';
import { protectedCliInvocation } from './cli-invocation.mjs';
import { capabilityNames } from './delivery-contract.mjs';
import { sourceIdentities } from './release-contract.mjs';
import { releaseProducerMonitor } from './release-producer-monitor.mjs';
import { releaseProducerIds } from './coverage-catalog.mjs';
import { report, result } from './schema.mjs';

export const nativeScenarioIds = Object.freeze(
  Object.values(releaseProducerIds).sort(),
);
const deliveryReads = ['readWakeEvidence', 'readDeliveryEvidence', 'observe',
  'assertSource', 'readConcurrencyEvidence', 'readIsolationEvidence'];
const functions = (value, keys) => keys.every(key =>
  typeof value?.[key] === 'function');
const fail = message => { throw new Error(`NATIVE_COVERAGE: ${message}`); };
const unresolved = () => {
  throw Object.assign(new Error('NATIVE_COVERAGE: producer effects unresolved'),
    { terminationUnknown: true });
};

// Only a protected in-process capability can open these adapters. Its readers
// must independently extract release bindings from native records, not echo the
// challenge below. URLs, worker results and serialized success are never read.
// Every read returns { release: binding, value: nativeObservation }. A fresh
// challenge binds child delivery/Action executions to this exact gate attempt.
export function requireReleaseCoverage(coverage) {
  if (!functions(coverage, ['open'])) fail('protected capabilities unavailable');
}

export async function runReleaseCoverage(coverage, prepared, invocation, selected,
  mode) {
  requireReleaseCoverage(coverage);
  if (!isDeepStrictEqual(selected.map(row => row.id).sort(), nativeScenarioIds)) {
    fail('mandatory native producer map mismatch');
  }
  const binding = { invocation: structuredClone(invocation),
    sources: sourceIdentities(prepared.sources), challenge: randomUUID() };
  // Source ownership is lent, never transferred. open constructs capabilities;
  // it must not dispatch work or acquire a second source set.
  const adapters = await coverage.open({ prepared,
    release: structuredClone(binding) });
  const { delivery, action, cli } = adapters ?? {};
  if (!functions(delivery?.caller, [...capabilityNames, ...deliveryReads]) ||
      !functions(action, ['observe', 'readEvidence']) ||
      !functions(cli?.context, ['authorize', 'observe', 'command', 'reconcile']) ||
      !functions(cli?.context?.credentials, ['capabilities']) ||
      !functions(cli?.inventory, ['exclusive'])) fail('native adapters unavailable');
  const production = mode === 'production';
  if (delivery.caller.mode !== (production ? 'live' : 'fixture') ||
      cli.context.origin !== (production ? 'operator' : 'synthetic')) {
    fail('producer provenance mismatch');
  }
  const monitor = releaseProducerMonitor();
  const read = callback => monitor.wrap(async (...args) => {
    const envelope = await callback(...args);
    if (!isDeepStrictEqual(envelope?.release, binding)) {
      fail('missing or stale release binding');
    }
    return envelope.value;
  });
  return monitor.run(async () => {
    const caller = { ...delivery.caller,
      trigger: monitor.wrap(delivery.caller.trigger),
      createFixture: monitor.wrap(async (...args) => {
        const fixture = await delivery.caller.createFixture(...args);
        if (!fixture?.lifecycle) return fixture;
        const lifecycle = { ...fixture.lifecycle };
        for (const key of ['setup', 'prepareDelivery', 'teardown']) {
          if (typeof fixture.lifecycle[key] === 'function') {
            const call = monitor.wrap(fixture.lifecycle[key].bind(fixture.lifecycle));
            lifecycle[key] = (...args) => {
              if (key === 'teardown') monitor.assertSettled();
              return call(...args);
            };
          }
        }
        return { ...fixture, lifecycle };
      }),
    };
    for (const key of deliveryReads) caller[key] = read(delivery.caller[key]);
    const paired = await runDeliveryPairPrepared(delivery.request, caller, prepared,
      delivery.bounds);
    if (paired.cleanup === 'unresolved' || paired.sourceCleanup) unresolved();
    if (paired.state !== 'passed' || paired.liveVerified !== production) {
      fail(`paired delivery ${paired.code}`);
    }
    const expected = action.expected;
    const source = prepared.sources.action;
    if (expected?.actionRef !== `${source.repository}@${source.commit}` ||
        expected.status !== 'completed') fail('Action expectation mismatch');
    const wake = await observeLiveWake({ ...action, expected, leg: 'action',
      mode: production ? 'live' : 'fixture', observe: read(action.observe),
      readEvidence: read(action.readEvidence) });
    if (wake.state !== 'passed') fail(`Action ${wake.code}`);
    const installation = await protectedCliInvocation({ ...cli,
      sources: prepared.sources,
      context: { ...cli.context, observe: read(cli.context.observe),
        authorize: monitor.wrap(cli.context.authorize),
        command: monitor.wrap(cli.context.command),
        reconcile: monitor.wrap(cli.context.reconcile),
        credentials: { capabilities: monitor.wrap(
          cli.context.credentials.capabilities.bind(cli.context.credentials),
        ) } },
      run: { runId: invocation.runId, attempt: Number(invocation.attempt) },
    }).run();
    if (installation.inventory?.pending ||
        (installation.invocation?.invoked && !installation.invocation.terminated)) {
      unresolved();
    }
    if (installation.disposition !== 'success' ||
        installation.invocation?.confirmed !== true ||
        installation.invocation.evidence !== (production ? 'native' : 'controlled')) {
      fail('CLI current-attempt native readbacks required');
    }
    return report(selected.map(row => result(row, 'passed',
      production ? 'NATIVE_RELEASE_OBSERVED' : 'CONTROLLED_RELEASE_CONTRACT',
      production ? 'Protected native producer passed' : 'Contract-test evidence only')));
  });
}
