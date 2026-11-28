import type { HostServices } from '../src/host/services.ts';
import { createKit } from './lib/kit.ts';
import type { Scenario } from '../src/types.ts';
import { collaboratorScenarios } from './collaborator/index.ts';
import { configRejections } from './config-rejections.ts';
import { hostMemoryCheck } from './host-memory-check.ts';
import { imageProvenance } from './image-provenance.ts';
import { loginVolume } from './login-volume.ts';
import { modelChoice } from './model-choice.ts';

/** The login volume, model choice, `.nibfin.json`, host memory and image scenarios, then the collaborator Runners (Issues #299 and #300). */
export function createScenarios(host: HostServices): Scenario[] {
  const kitFor = (ctx: Parameters<typeof createKit>[1]) => createKit(host, ctx);
  return [
    loginVolume,
    modelChoice(kitFor),
    configRejections(kitFor),
    hostMemoryCheck(kitFor),
    imageProvenance(kitFor),
    // Collaborator Runners, after the others here since they register the peer's Runners and change the
    // execution sandbox's visibility; they delete the peer's registrations before the Dashboard scenarios run (Issue #300).
    ...collaboratorScenarios,
  ];
}
