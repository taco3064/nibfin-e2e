import type { HostServices } from '../src/host/services.ts';
import type { Scenario } from '../src/types.ts';
import { agentSetup } from './agent-setup.ts';
import { codexJobs } from './codex-jobs.ts';
import { configRejections } from './config-rejections.ts';
import { failureLogs } from './failure-logs.ts';
import { hostMemoryCheck } from './host-memory-check.ts';
import { imageProvenance } from './image-provenance.ts';
import { jobContainer } from './job-container.ts';
import { modelChoice } from './model-choice.ts';
import { projectTools } from './project-tools.ts';
import { roleSkills } from './role-skills.ts';
import { skillLimits } from './skill-limits.ts';

/** Issue #299: Job isolation, Agent setup, model choice, `.nibfin.json`, logs and the image. */
export function createScenarios(host: HostServices): Scenario[] {
  return [
    jobContainer,
    agentSetup,
    projectTools,
    roleSkills,
    modelChoice(host),
    configRejections(host),
    skillLimits(host),
    failureLogs(host),
    hostMemoryCheck(host),
    imageProvenance(host),
    codexJobs,
  ];
}
