import { fixtureInventory } from './fixture-inventory.mjs';
import {
  defectConfiguration, defectKey, defectMarker, issueMatches, validateFinding,
  issueBrowserUrl,
} from './defect-policy.mjs';

const pending = reason => ({ state: 'pending', reason });

// assess is an independent trusted code/Issue assessment, not the model output.
// It approves disclosure and English content, verifies the semantic identity and
// necessary maintained change, and checks all current duplicate observations.
export async function defectPublisher({ configuration, stateDir, modelRoot,
  github, wake, assess, publicationMode = 'direct-wake' }) {
  if (!['direct-wake', 'issue-events'].includes(publicationMode)) {
    throw new Error('DEFECT_PUBLICATION_MODE');
  }
  const config = defectConfiguration(configuration);
  if (!github || typeof assess !== 'function') {
    throw new Error('DEFECT_PUBLISHER_UNAVAILABLE');
  }
  const inventory = await fixtureInventory(stateDir, {
    owner: 'defect-publication', config,
  }, config.assignee.id, modelRoot);
  return async (proposal, evidence, provenance) => {
    let finding;
    try { finding = validateFinding(proposal, evidence, config); }
    catch {
      const classes = ['missing_prerequisite', 'producer_rollout',
        'infrastructure_failure', 'insufficient_evidence'];
      const classification = classes.includes(proposal?.classification) ?
        proposal.classification : 'unsupported';
      return { state: 'not-published', reason: 'UNSUPPORTED_FINDING', classification };
    }
    const key = defectKey(finding);
    const marker = defectMarker(key);
    try {
      return await inventory.exclusive(async (state, save) => {
        const repository = finding.repository;
        if (await github.validate(repository) !== true) {
          return pending('TARGET_IDENTITY_UNVERIFIED');
        }
        const observed = await github.issues(repository);
        if (observed?.complete !== true || !Array.isArray(observed.issues)) {
          return pending('DUPLICATES_UNVERIFIED');
        }
        const decision = await assess({ finding, issues: observed.issues,
          provenance });
        if (decision?.publicSafe !== true || decision?.english !== true ||
            decision?.codeBacked !== true || decision?.key !== key) {
          return { state: 'not-published', reason: 'INDEPENDENT_EVIDENCE_REQUIRED' };
        }
        if (decision.duplicate === 'addressed') {
          return { state: 'not-published', reason: 'ALREADY_ADDRESSED' };
        }
        if (!['none', 'existing', 'recurrence'].includes(decision.duplicate) ||
            decision.duplicate === 'recurrence' && !decision.newMaintainedChange) {
          return pending('DUPLICATE_ASSESSMENT_UNRESOLVED');
        }
        let entry = state.resources.find(row => row.key === key);
        const existing = decision.duplicate === 'existing' ?
          observed.issues.find(row => row.number === decision.number) : null;
        if (decision.duplicate === 'existing' && (!existing ||
            decision.existingId !== existing.id ||
            decision.existingTitle !== existing.title ||
            decision.existingBody !== existing.body ||
            typeof existing.body !== 'string' || existing.body.length > 16000)) {
          return pending('EXISTING_CONTENT_UNVERIFIED');
        }
        const content = { title: finding.title,
          body: `${finding.body}\n\nEvidence provenance: ${provenance}.\n${marker}` };
        const matches = observed.issues.filter(row =>
          typeof row.body === 'string' && row.body.includes(marker));
        if (matches.length > 1) return pending('CONFLICTING_ISSUES');
        if (!entry) {
          entry = { key, content: existing ? { title: existing.title,
            body: existing.body } : content, issue: existing?.number ?? null,
            id: existing?.id ?? null, createIntent: false,
            wakeIntent: false };
          state.resources.push(entry);
          await save();
        }
        // A newly generated wording never rewrites maintained work or its intent.
        const expected = entry.content;
        if (entry.issue && matches[0] && entry.issue !== matches[0].number) {
          return pending('CONFLICTING_ISSUES');
        }
        let number = entry.issue ?? matches[0]?.number;
        if (decision.duplicate === 'existing') {
          if (!Number.isSafeInteger(decision.number) || decision.number <= 0 ||
              number && number !== decision.number) {
            return pending('DUPLICATE_IDENTITY_CONFLICT');
          }
          number = decision.number;
        }
        if (!number) {
          if (entry.createIntent) return pending('CREATE_EFFECT_UNRESOLVED');
          if (await github.validate(repository) !== true) {
            return pending('TARGET_IDENTITY_UNVERIFIED');
          }
          entry.createIntent = true;
          await save();
          // Never repeat an unknown mutation. Next invocation reconciles by marker.
          try { number = await github.create(repository, expected); }
          catch { return pending('CREATE_EFFECT_UNRESOLVED'); }
          if (!number) return pending('CREATE_EFFECT_UNRESOLVED');
        }
        const issue = await github.read(repository, number);
        if (!issueMatches(issue, expected, config, repository)) {
          return pending('ISSUE_READBACK_CONFLICT');
        }
        if (entry.issue && (entry.issue !== issue.number || entry.id !== issue.id)) {
          return pending('ISSUE_IDENTITY_CONFLICT');
        }
        entry.issue = issue.number;
        entry.id = issue.id;
        await save();
        const reference = { repository, number: issue.number };
        if (publicationMode === 'issue-events') {
          const url = issueBrowserUrl(issue, repository);
          if (!url) return pending('ISSUE_URL_UNVERIFIED');
          return { state: 'associated', reason: issue.state === 'closed' ?
            'CLOSED_WORK' : 'VERIFIED_ISSUE',
            issue: { ...reference, url, state: issue.state },
            route: 'issue-events', wake: 'not-requested' };
        }
        if (issue.state === 'closed') {
          return { state: 'associated', reason: 'CLOSED_WORK', issue: reference,
            wake: 'not-requested' };
        }
        if (!wake) return { ...pending('WAKE_CAPABILITY_UNAVAILABLE'),
          issue: reference, wake: 'unavailable' };
        // observe delegates to Core's existing dispatch journal, never a label
        // or a successful HTTP response. Missing observations are unknown.
        const context = { repository, number: issue.number, id: issue.id,
          nodeId: issue.node_id, key };
        let disposition = await wake.observe(context);
        if (disposition?.state === 'absent' && !entry.wakeIntent) {
          entry.wakeIntent = true;
          await save();
          try { await wake.request(context); }
          catch { /* Only readback can settle this operation. */ }
          disposition = await wake.observe(context);
        }
        const settled = ['dispatched', 'denied', 'blocked'].includes(
          disposition?.state);
        if (!settled) return { ...pending('WAKE_EFFECT_UNRESOLVED'),
          issue: reference, wake: 'pending' };
        entry.wake = disposition.state;
        await save();
        return { state: 'associated', reason: 'VERIFIED_ISSUE', issue: reference,
          wake: disposition.state,
          ...(Number.isSafeInteger(disposition.runId) && disposition.runId > 0 ?
            { wakeRunId: disposition.runId } : {}) };
      });
    } catch (error) {
      // The durable intent remains. Ownership is not retired by time or force.
      return pending(error?.code === 'EEXIST' ? 'PUBLICATION_OWNED' :
        'PUBLICATION_UNRESOLVED');
    }
  };
}
