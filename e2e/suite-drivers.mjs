import { repositoryLifecycle } from './repository-lifecycle.mjs';
import { protectedSharedInstallation }
  from './scenarios/cli-onboarding/installation.mjs';
import { protectedRunTeardown } from './run-teardown.mjs';
import { verifyCompatibility } from './source-producers.mjs';
import { protectedSuite } from './suite.mjs';

const observation = (passed, code, resources = []) => ({
  state: passed ? 'passed' : 'unresolved', code, resources,
});

// Existing provisioning, installation and teardown are resumable drivers. Their
// own ledgers remain authoritative; the suite stores only phase coordination.
// Delivery/failure composition supplies execute and independent reconcile using
// the predecessor producers and their retained native execution records. Neither
// callback may acquire sources or choose executable modules from run requests.
export function createSuite({ inventory, prepared, repository, installation,
  teardown, delivery, failure, verifyOwnership, provenance, binding, bounds }) {
  if (provenance === 'native' && (installation?.context?.origin !== 'operator' ||
      delivery?.provenance !== 'native' || failure?.provenance !== 'native')) {
    throw new Error('SUITE_NATIVE_COMPOSITION_REQUIRED');
  }
  return protectedSuite({ inventory, prepared, provenance, binding, bounds,
    async verifyOwnership(owner, identities, options) {
      if (await verifyOwnership(owner, identities, options) !== true) return false;
      await verifyCompatibility(owner.sources, owner.sources.core.output);
      return true;
    },
    compose({ inventory: scoped, sources }) {
      const provisionPhase = async () => {
        const result = await repositoryLifecycle({ ...repository,
          inventory: scoped }).provision();
        return observation(result.state === 'ready', result.state === 'ready'
          ? 'PROVISION_OBSERVED' : 'PROVISION_UNRESOLVED',
          result.repositories.map(row => row.repository));
      };
      const installPhase = async () => {
        const result = await protectedSharedInstallation({ ...installation,
          inventory: scoped, sources }).install();
        return observation(result.disposition === 'success',
          result.disposition === 'success' ? 'INSTALL_OBSERVED' : 'INSTALL_UNRESOLVED');
      };
      const cleanupPhase = async () => {
        const result = await protectedRunTeardown({ ...teardown,
          inventory: scoped }).teardown();
        return observation(result.state === 'complete', result.state === 'complete'
          ? 'CLEANUP_OBSERVED' : `CLEANUP_UNRESOLVED_${result.phase}`,
          result.operations.filter(row => row.disposition !== 'verified')
            .map(row => row.key));
      };
      return {
        provision: { execute: provisionPhase, reconcile: provisionPhase },
        install: { execute: installPhase, reconcile: installPhase },
        delivery, failure,
        cleanup: { execute: cleanupPhase, reconcile: cleanupPhase },
      };
    },
  });
}
