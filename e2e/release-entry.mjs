import { pathToFileURL } from 'node:url';
import {
  createPublicationCoordinator, createContractCoordinator,
} from './publication-coordinator.mjs';
import { validateInvocation, validateVersion } from './release-contract.mjs';
import { releaseObservations } from './release-observations.mjs';

const expected = Object.freeze({
  repository: 'taco3064/nibfin-e2e',
  workflow: '.github/workflows/nibfin-release.yml',
  environment: 'nibfin-release',
});

async function execute(env, request, protectedCapabilities, controlled, dependencies) {
  try {
    const inputs = [env.NIBFIN_RELEASE_VERSION];
    const version = validateVersion(inputs);
    const caps = protectedCapabilities;
    if (!caps || typeof caps.verifyInvocation !== 'function' ||
        typeof caps.observeActivePublications !== 'function' ||
        typeof caps.verifyConditions !== 'function') {
      throw new Error('PROTECTED_CAPABILITIES_UNAVAILABLE');
    }
    // Neither environment claims nor serialized handoffs authenticate invocation.
    const invocation = validateInvocation(await caps.verifyInvocation(), expected);
    const verifyConditions = async handoff => {
      const current = validateInvocation(await caps.verifyInvocation(), expected);
      if (handoff.version !== version ||
          JSON.stringify(current) !== JSON.stringify(invocation) ||
          JSON.stringify(handoff.invocation) !== JSON.stringify(invocation)) {
        return false;
      }
      // The protected verifier reconciles original sources and this run's partial
      // objects against acknowledged evidence and native state, never newer main.
      return await caps.verifyConditions(handoff) === true;
    };
    const capabilities = { expected,
      verifyInvocation: caps.verifyInvocation,
      ...releaseObservations(request, caps.observeActivePublications),
      verifyConditions, native: caps.native, evidence: caps.evidence };
    const coordinator = controlled
      ? createContractCoordinator(capabilities, dependencies)
      : createPublicationCoordinator(capabilities);
    // Recovery selection is a protected capability, never a CLI/env option.
    return await coordinator(inputs, { resume: caps.resume === true });
  } catch {
    return { outcome: 'blocked', reason: 'RELEASE_CAPABILITIES_OR_INPUT_UNAVAILABLE' };
  }
}

// Only a protected in-process host may supply publication and evidence closures.
// There is deliberately no module path, JSON, credential or dependency selector.
export function releaseEntry(env, request, protectedCapabilities) {
  return execute(env, request, protectedCapabilities, false);
}

// Explicit controlled composition; its results can never be production evidence.
export function releaseContractEntry(env, request, capabilities, dependencies) {
  return execute(env, request, capabilities, true, dependencies);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await releaseEntry(process.env);
  console.error(result.reason);
  process.exitCode = 1;
}
