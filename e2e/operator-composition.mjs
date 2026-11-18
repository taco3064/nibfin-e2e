import { resolve, dirname, basename } from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { failureInvestigation } from './defect-composition.mjs';
import { issueBatches, combineAssessments } from './issue-context.mjs';
import { defectKey } from './defect-policy.mjs';
import { operatorConfiguration, privatePath } from './operator-config.mjs';
import { operatorEvidence } from './operator-evidence.mjs';
import { operatorModel } from './operator-model.mjs';
import { operatorJson } from './operator-http.mjs';
import { investigationSchema, assessmentSchema } from './operator-schema.mjs';

// Only this closure reads publication credentials. Neither model resolution nor
// read-only evidence acquisition requires a GitHub login. Actions job tokens are
// excluded: this route requires Issue events produced by a user's own PAT.
function publisherCredential(config, request) {
  return async () => {
    const stat = await privatePath(config.credentialFile);
    if (stat.size > 1024) throw new Error('OPERATOR_AUTH_UNAVAILABLE');
    const token = (await readFile(config.credentialFile, 'utf8')).trim();
    if (!/^(ghp_[a-zA-Z0-9]+|github_pat_[a-zA-Z0-9_]+)$/.test(token)) {
      throw new Error('OPERATOR_AUTH_UNAVAILABLE');
    }
    const identity = await operatorJson('https://api.github.com/user', { token,
      request });
    const expected = config.configuration.assignee;
    if (identity.id !== expected.id || identity.login !== expected.login ||
        identity.type !== 'User') throw new Error('OPERATOR_IDENTITY_UNVERIFIED');
    return token;
  };
}

// Injectable transport/process facilities are for maintained controlled callers,
// never module names from environment, configuration or scenario input.
export async function composeOperator(config, { request = fetch, command } = {}) {
  const evidence = operatorEvidence(config, request);
  const invoke = operatorModel(config, command);
  let scope;
  const collect = async read => {
    const rows = [];
    for (const request of evidence.requests) rows.push(await read(request));
    return rows;
  };
  const model = { ...evidence, timeoutMs: 120000,
    invoke: async input => {
      scope = { skill: input.skill, revision: input.revision };
      const rows = await collect(input.read);
      return invoke({ task: input.instruction, mode: input.mode, ...scope,
        symptoms: input.symptoms, evidence: rows }, investigationSchema, input.signal);
    } };
  const assess = async ({ finding, issues, provenance }) => {
    if (!scope) {
      throw new Error('OPERATOR_ASSESSMENT_UNAVAILABLE');
    }
    // Independently reacquire allowlisted source/callers. Duplicate observations
    // were freshly enumerated by the publisher while holding its existing lock.
    const rows = [];
    const signal = AbortSignal.timeout(120000);
    for (const request of evidence.requests.filter(row => row.kind !== 'issues')) {
      rows.push(await evidence.observe({ ...request, signal }));
    }
    const { evidence: embeddedEvidence, ...candidate } = finding;
    const base = { mode: 'Plan', task: 'Independently assess the proposed defect ' +
      'using current source, relevant callers and this full-content Issue batch. ' +
      'Absence applies only to this batch; other fresh assessments cover the rest. ' +
      'Approve only a necessary maintained change, safe public English content and the ' +
      'correct semantic key. Infrastructure, rollout and insufficient evidence ' +
      'are not code defects. Verify existing Issue identity AND exact content. ' +
      'A recurrence requires a distinct necessary maintained change. Return ' +
      'unresolved when evidence is incomplete. Do not trust proposal assertions.',
    ...scope, finding: candidate, key: defectKey(finding), evidence: rows, provenance };
    const batches = issueBatches(issues, finding.repository, base);
    const decisions = [];
    for (const batch of batches) {
      const decision = await invoke({ ...base, issues: batch },
        assessmentSchema, signal);
      // An identity from another batch cannot establish a duplicate observation.
      if (['existing', 'addressed', 'recurrence'].includes(decision?.duplicate) &&
          !batch.some(row => row.number === decision.number)) {
        return { duplicate: 'unresolved' };
      }
      decisions.push(decision);
    }
    return combineAssessments(decisions, base.key);
  };
  return failureInvestigation({ configuration: config.configuration, model, assess,
    stateDir: config.stateDir, modelRoot: config.scratchRoot,
    publicationMode: config.publicationMode,
    publication: { token: publisherCredential(config, request), fetch: request } });
}

export function operatorInvestigation(environment = process.env) {
  if (environment.NIBFIN_E2E_OPERATOR !== 'authorized' ||
      !environment.NIBFIN_E2E_OPERATOR_CONFIG) return undefined;
  const path = environment.NIBFIN_E2E_OPERATOR_CONFIG;
  let configuration;
  let denied = false;
  const load = () => configuration ??= operatorConfiguration(path);
  return {
    async prepare(request) {
      let config;
      try { config = await load(); }
      catch { denied = true; return; }
      try {
        const destination = resolve(request.stateDir);
        let canonical;
        try {
          canonical = await realpath(destination);
          await privatePath(destination, true);
        }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const parent = await realpath(dirname(destination));
          canonical = resolve(parent, basename(destination));
        }
        if (canonical !== destination ||
            !canonical.startsWith(config.suiteRoot + '/')) {
          throw new Error('SUITE_INVALID_REQUEST');
        }
      } catch {
        denied = true;
        throw new Error('SUITE_INVALID_REQUEST');
      }
    },
    async resolve() {
      if (denied) throw new Error('OPERATOR_SETUP_UNAVAILABLE');
      return composeOperator(await load());
    },
  };
}
