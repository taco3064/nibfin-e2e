import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { producerFile } from './source-producers.mjs';
import { installationId as id, installationText as text, sameSources,
  sourceIdentities, installationObservation, compareInstallation }
  from './scenarios/cli-onboarding/installation-observations.mjs';

export const same = (a, b, keys) => !!a && !!b && keys.every(k => a[k] === b[k]);
export const bindingKeys = ['owner', 'hostId', 'repository', 'repositoryId',
  'memberId', 'runRepository', 'runRepositoryId'];
const workflowKeys = ['workflowId', 'path', 'sourceCommit', 'ref', 'blob'];
export const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');
export const repositoryName = value => /^[\w.-]+\/[\w.-]+$/.test(value ?? '');
export const blob = body => createHash('sha1').update(
  `blob ${Buffer.byteLength(body)}\0${body}`,
).digest('hex');

// Read recipes from the prepared producer, never from a second version catalog.
export async function peerTemplates(sources) {
  const file = await producerFile(sources.core.checkout, 'src/caller-recipes.mjs');
  const { callerRecipe } = await import(pathToFileURL(file).href);
  const { workflowPath: sharedPath } = JSON.parse(await readFile(
    await producerFile(sources.core.checkout, 'src/shared-runner-contract.json'),
    'utf8'));
  return {
    issue: { path: '.github/workflows/nibfin-issue.yml',
      content: callerRecipe('issue', sources.core.commit) },
    action: { path: '.github/workflows/nibfin-wake.yml',
      content: callerRecipe('action-dispatch', sources.core.commit, {
        actionCommit: sources.action.commit, memberId: sources.memberId,
      }) },
    execution: { path: sharedPath, content: await readFile(
      await producerFile(sources.core.checkout, sharedPath), 'utf8') },
  };
}
export function workflowIdentity(value) {
  if (!id(value?.workflowId) || !text(value.path) || !sha(value.sourceCommit) ||
      !text(value.ref) || !sha(value.blob)) return null;
  return Object.fromEntries(workflowKeys.map(k => [k, value[k]]));
}
export function validPeerBinding(b) {
  return b && ['owner', 'hostId'].every(k => text(b[k])) &&
    ['repository', 'runRepository'].every(k => repositoryName(b[k])) &&
    ['repositoryId', 'runRepositoryId', 'memberId'].every(k => id(b[k])) &&
    b.repository !== b.runRepository && b.repositoryId !== b.runRepositoryId;
}
export function validPool(runners, b) {
  return Array.isArray(runners) && runners.length === 2 &&
    new Set(runners.map(r => r?.id)).size === 2 &&
    new Set(runners.map(r => r?.name)).size === 2 && runners.every(r =>
      id(r?.id) && text(r.name) && r.memberId === b.memberId &&
      r.repositoryId === b.runRepositoryId);
}
export function validEnrollment(e, mode) {
  const b = e?.binding;
  return e?.disposition === 'success' && e.adopted === true &&
    e.recoveryPending !== true && validPeerBinding(b) &&
    (mode !== 'live' || e.origin === 'operator') &&
    ['synthetic', 'operator'].includes(e.origin) &&
    validPool(e.runners, b) && e.registrationsComplete === true &&
    e.targetRunnerCount === 0 && ['issue', 'action', 'execution'].every(k =>
      workflowIdentity(e.callers?.[k])) && Object.values(e.sources ?? {}).length === 3 &&
    ['core', 'action', 'cli'].every(k => repositoryName(e.sources[k]?.repository) &&
      sha(e.sources[k]?.commit));
}

export function installedRecord(record, binding, sources) {
  if (!record || record.pending || !same(record.binding, {
    ...binding, repository: binding.runRepository,
    repositoryId: binding.runRepositoryId,
  }, ['owner', 'hostId', 'repository', 'repositoryId', 'memberId']) ||
      !sameSources(record.sources, sources) ||
      !validPool(record.runners, binding)) return false;
  return compareInstallation(record.binding, sources,
    installationObservation(record.observation), record.runners) === 'installed';
}

// The adapter supplies independent native observations. Only identities survive.
export function peerObservation(raw, binding, sources, templates, previous) {
  if (typeof raw?.adopted !== 'boolean' ||
      !same(raw?.binding, binding, bindingKeys) ||
      !sameSources(sourceIdentities(raw?.sources), sources) ||
      raw.authenticatedMemberId !== binding.memberId ||
      raw.registrations?.complete !== true ||
      raw.registrations.repository !== binding.repository ||
      raw.registrations.repositoryId !== binding.repositoryId ||
      !Array.isArray(raw.registrations.runners) ||
      raw.registrations.runners.length !== 0 ||
      !validPool(raw.executionRunners, binding) ||
      !previous.every(old => raw.executionRunners.some(r =>
        same(r, old, ['id', 'name', 'memberId', 'repositoryId']))) ||
      raw.executionRegistrationsComplete !== true) return null;
  const callers = {};
  for (const key of ['issue', 'action', 'execution']) {
    const w = raw.callers?.[key];
    const identity = workflowIdentity(w);
    const repository = key === 'execution' ? binding.runRepository : binding.repository;
    if (!identity || w.repository !== repository || w.repositoryId !==
        (key === 'execution' ? binding.runRepositoryId : binding.repositoryId) ||
        w.complete !== true || w.active !== true ||
        w.path !== templates[key].path || w.content !== templates[key].content ||
        w.blob !== blob(w.content) ||
        w.ref !== `${repository}/${w.path}@refs/heads/${w.branch}` ||
        !text(w.branch)) return null;
    callers[key] = identity;
  }
  return { binding: structuredClone(binding), sources: structuredClone(sources),
    runners: raw.executionRunners.map(r => Object.fromEntries(
      ['id', 'name', 'memberId', 'repositoryId'].map(k => [k, r[k]]))),
    callers, registrationsComplete: true, targetRunnerCount: 0,
    adopted: raw.adopted === true };
}
