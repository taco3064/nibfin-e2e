import { prepareSources } from './sources.mjs';
import { run } from './runner.mjs';
import { scenarios, register } from './registry.mjs';
import { catalog, validateCatalog, products } from './coverage-catalog.mjs';
import { calculateCoverage } from './coverage.mjs';
import { sourceTerminationUnknown } from './source-process.mjs';
import {
  validateVersion, validateInvocation, validateConflicts, sourceIdentities,
  validateHandoff, validateRemoteMains,
} from './release-contract.mjs';

function requiredSuite(requirements, entries) {
  const rows = validateCatalog(requirements);
  const registry = register(entries);
  if (!rows.length || products.some(product =>
    !rows.some(row => row.product === product)) ||
    rows.some(row => !row.scenarioIds.length)) {
    throw new Error('COVERAGE: mandatory release requirements are unmapped');
  }
  const ids = [...new Set(rows.flatMap(row => row.scenarioIds))].sort();
  if (ids.some(id => !registry.some(row => row.id === id))) {
    throw new Error('COVERAGE: mandatory scenario is unregistered');
  }
  const selected = registry.filter(row => ids.includes(row.id));
  if (selected.some(row => row.policyReason)) {
    throw new Error('COVERAGE: mandatory scenario is policy-skipped');
  }
  return { rows, selected, ids };
}

function buildGate(capabilities, dependencies, mode) {
  // Composition is privileged: none of these functions come from invocation input.
  const {
    verifyInvocation, observeConflicts, observeMains, expected,
  } = capabilities ?? {};
  if (typeof verifyInvocation !== 'function' || typeof observeConflicts !== 'function' ||
      typeof observeMains !== 'function' ||
      !expected || ['repository', 'workflow', 'environment'].some(key =>
        typeof expected[key] !== 'string' || !expected[key].trim())) {
    throw new Error('CONFIGURATION: trusted capabilities and context required');
  }
  const context = Object.freeze({ ...expected });
  return async function preflight(inputs) {
    let prepared;
    let handoff;
    let reason;
    let unsettled = false;
    try {
      const version = validateVersion(inputs);
      const invocation = validateInvocation(await verifyInvocation(), context);
      validateConflicts(await observeConflicts(version), version);
      const { rows, selected, ids } = requiredSuite(
        dependencies.catalog, dependencies.registry,
      );
      prepared = await dependencies.prepare();
      if (!prepared || prepared.disposed !== false ||
          typeof prepared.dispose !== 'function') {
        throw new Error('SOURCES: invalid ownership');
      }
      const sources = sourceIdentities(prepared.sources);
      validateRemoteMains(await observeMains(), sources);
      const document = await dependencies.run(selected, [], {
        sources: prepared.sources, workerEnv: {},
      });
      unsettled = document?.results?.some(row =>
        row?.reason?.code === 'TERMINATION_ERROR') === true;
      if (unsettled) throw new Error('EXECUTION: worker termination unknown');
      const coverage = calculateCoverage({ catalog: rows, registry: selected,
        runs: [{ document }] }).environments[0];
      if (!coverage.complete || document.results.length !== ids.length) {
        throw new Error('EXECUTION: mandatory scenarios did not all pass');
      }
      if (prepared.disposed || JSON.stringify(sourceIdentities(prepared.sources)) !==
          JSON.stringify(sources)) throw new Error('SOURCES: identities changed');
      validateRemoteMains(await observeMains(), sources);
      validateConflicts(await observeConflicts(version), version);
      const staged = await prepared.preflightRelease(version);
      if (prepared.disposed || JSON.stringify(sourceIdentities(prepared.sources)) !==
          JSON.stringify(sources)) throw new Error('SOURCES: identities changed');
      validateRemoteMains(await observeMains(), sources);
      validateConflicts(await observeConflicts(version), version);
      handoff = { schemaVersion: 1, mode, version, invocation, sources,
        mandatory: { outcome: 'passed', scenarioIds: ids }, resources: 'disposed' };
      if (capabilities.consumeRelease) {
        await capabilities.consumeRelease({
          handoff: structuredClone(handoff), prepared, staged,
        });
      }
    } catch (error) {
      unsettled ||= sourceTerminationUnknown(error);
      reason = String(error) || 'Unknown release preflight failure';
    }
    if (prepared && !unsettled) {
      try {
        await prepared.dispose();
        if (prepared.disposed !== true) throw new Error('disposal not confirmed');
      } catch (error) {
        reason = `${reason ?? ''} CLEANUP: ${error}`.trim();
      }
    }
    if (reason) return { outcome: 'blocked', reason };
    try {
      validateHandoff(handoff);
      // Copy so the capability provider cannot subsequently mutate the output.
      return { outcome: 'ready', handoff: structuredClone(handoff) };
    } catch (error) {
      return { outcome: 'blocked', reason: String(error) };
    }
  };
}

// Production source preparation, runner and requirements cannot be input overrides.
export function createReleaseGate(capabilities) {
  return buildGate(capabilities, {
    prepare: prepareSources, run, catalog, registry: scenarios,
  }, 'production');
}

// Explicit test-only composition; its handoff never authorizes publication.
export function createContractGate(capabilities, dependencies) {
  return buildGate(capabilities, dependencies, 'contract-test');
}
