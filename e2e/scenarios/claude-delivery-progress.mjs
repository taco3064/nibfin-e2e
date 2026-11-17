import { randomUUID } from 'node:crypto';
import { coreModule } from './isolation-common.mjs';
import { readDeliveryApplicability } from '../delivery-applicability.mjs';
import { stages as observedStages } from '../delivery-contract.mjs';

const agentStages = ['shape', 'validate-shape', 'deliver', 'accept', 'review-pr'];
const outcomes = { shape: 'ready', 'validate-shape': 'approved',
  'publish-shape': 'published', deliver: 'ready', 'pre-accept-hooks': 'passed',
  accept: 'accepted', 'post-accept-hooks': 'passed', 'commit-pr': 'published',
  'review-pr': 'approved', merge: 'merged', close: 'closed' };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function progressDriver(context, executor, agent, controls) {
  const { stageFixture } = await coreModule(context, 'test/stage-fixture.mjs');
  const { digest } = await coreModule(context, 'src/identity.mjs');
  const { decideStage, stages, evidenceBinding } =
    await coreModule(context, 'src/stages.mjs');
  function initialize(leg, provider) {
    const binding = leg.binding;
    const c = stageFixture();
    const record = c.approval.record;
    delete record.validFrom;
    delete record.expiresAt;
    record.issue = { id: `I_fixture_${leg.issueId}`, number: leg.issue,
      repository: binding.repository, repositoryId: leg.wake.expected.repositoryId };
    record.roles = Object.fromEntries(Object.keys(record.roles).map(key =>
      [key, provider.definition.account.id]));
    record.scope = { body: leg.requirements, hash: digest(leg.requirements) };
    record.source = { ...record.source, repository: context.sources.core.repository,
      commit: context.sources.core.commit };
    c.source = record.source;
    c.approval.scopeBinding = digest(record.issue);
    c.pause.issue = record.issue;
    c.issue = { ...c.issue, node_id: record.issue.id, number: leg.issue,
      body: leg.requirements,
      url: `https://api.github.com/repos/${binding.repository}/issues/${leg.issue}` };
    c.shape.body = `Controlled ${binding.requestId}\n` +
      '```kairo-candidate\n{"artifacts":[],"hooks":[]}\n```\n';
    c.shape.hash = digest(c.shape.body);
    c.receipts = {};
    Object.assign(c.runner, leg.wake.expected, { memberId: record.roles.writer,
      repositoryId: record.issue.repositoryId });
    c.runner.target = { repositoryId: record.issue.repositoryId };
    c.route.userId = record.roles.writer;
    c.main.repositoryId = record.issue.repositoryId;
    Object.assign(c.candidate, { repositoryId: record.issue.repositoryId,
      repository: binding.repository, issueId: record.issue.id,
      paths: [binding.path], diffHash: digest(binding.content) });
    Object.assign(c.pr, { id: `PR_${leg.issue}`, number: leg.issue,
      repositoryId: record.issue.repositoryId,
      head: digest(binding.requestId).slice(0, 40) });
    Object.assign(c.ci, { prId: c.pr.id, head: c.pr.head, testedSha: c.pr.head });
    c.ci.checks = c.ci.checks.map(check => ({ ...check, id: leg.issue,
      testedSha: c.pr.head }));
    c.agent = structuredClone(agent);
    leg.progress = { agent: c.agent, context: c,
      completed: [], attempts: [], pending: null };
  }
  return {
    async advance(leg, provider, continuing = false) {
      provider.authorize('deliver', leg.binding.repository);
      const slots = provider.sharedRegistrations(leg.binding.repository);
      if (slots.length !== 2 || slots.some(slot => !same(slot.agent, agent))) {
        throw new Error('CLAUDE_POOL_BINDING_CONFLICT');
      }
      if (!leg.progress) initialize(leg, provider);
      const p = leg.progress;
      if (!same(p.agent, agent)) throw new Error('CLAUDE_RESUMED_BINDING_CONFLICT');
      if (p.pending) {
        if (!continuing || !controls.authorizeContinuation?.(leg.binding) ||
            !provider.settled) throw new Error('CLAUDE_CONTINUATION_PENDING');
        if (p.pending === 'unknown') {
          if (!controls.settlementConfirmed?.(leg.binding)) {
            throw new Error('CLAUDE_EFFECTS_PENDING');
          }
          await executor.settle();
        } else if (p.pending !== 'interrupted') {
          throw new Error('CLAUDE_FAILED_EXECUTION_FENCED');
        }
        p.pending = null;
      }
      const c = p.context;
      for (const stage of Object.keys(stages)) {
        if (p.completed.includes(stage)) continue;
        const role = stages[stage].role;
        c.execution = { id: randomUUID(), sessionId: randomUUID(), role,
          actorId: c.approval.record.roles[role], runId: c.runner.runId,
          attempt: c.runner.attempt, jobId: c.runner.jobId };
        c.isolation.executionId = c.execution.id;
        const decision = decideStage(stage, c);
        if (decision.status !== 'allowed') throw new Error(decision.code);
        if (agentStages.includes(stage)) {
          const attempt = { stage, execution: structuredClone(c.execution),
            agent: structuredClone(agent), status: 'pending' };
          p.attempts.push(attempt);
          try {
            const result = await executor.run(stage, c, agent,
              controls.variant?.(stage, leg.binding, p.attempts) ?? 'success');
            if (result.status === 'interrupted') {
              attempt.status = p.pending = 'interrupted';
              throw new Error('CLAUDE_INTERRUPTED');
            }
            attempt.status = 'success';
          } catch (error) {
            p.pending ??= executor.pending ? 'unknown' : 'failed';
            attempt.status = p.pending;
            throw error;
          }
        }
        const artifacts = { ...decision.artifacts, shapeHash: c.shape.hash };
        if (!['shape', 'validate-shape', 'publish-shape'].includes(stage)) {
          artifacts.candidateHash = digest(c.candidate);
        }
        if (stage === 'commit-pr') Object.assign(artifacts, {
          prId: c.pr.id, prNumber: c.pr.number, head: c.pr.head, base: c.pr.base });
        if (stage === 'merge') artifacts.mergeCommit =
          digest({ issue: leg.issue, head: c.pr.head }).slice(0, 40);
        c.receipts[stage] = { schemaVersion: 1, stage, binding: evidenceBinding(c),
          execution: structuredClone(c.execution), artifacts,
          outcome: outcomes[stage], findings: [], references: ['controlled'] };
        p.completed.push(stage);
        if (stage === 'publish-shape') {
          c.issue.body = c.shape.body;
          c.issue.labels.push({ name: 'shaped' });
        }
        if (stage === 'merge') Object.assign(c.pr, { state: 'closed', merged: true,
          mergeCommit: digest({ issue: leg.issue, head: c.pr.head }).slice(0, 40) });
      }
      const candidate = { ...leg.binding, id: digest(c.candidate), shape: c.shape.hash,
        paths: c.candidate.paths, substantive: true, hooks: [], artifacts: [] };
      const admission = { ...leg.wake.expected, requestId: leg.binding.requestId };
      const names = { 'pre-accept': 'pre-accept-hooks',
        'post-accept': 'post-accept-hooks' };
      const evidence = { candidate, admissions: [admission],
        pull: { number: c.pr.number, head: c.pr.head, mergeCommit: c.pr.mergeCommit,
          checkIds: c.ci.checks.map(check => check.id) },
        stages: observedStages.map(stage => ({ ...leg.binding, stage,
          outcome: 'success', execution: c.receipts[names[stage] ?? stage].execution,
          admission, shape: candidate.shape, candidate: candidate.id,
          head: c.pr.head, pull: c.pr.number, hooks: [],
          agentExecuted: agentStages.includes(stage),
          runnerExecuted: agentStages.includes(stage) })) };
      evidence.applicability = await readDeliveryApplicability(context.sources.core,
        c, leg.binding, evidence);
      if (evidence.applicability.state !== 'satisfied') {
        throw new Error('CLAUDE_APPLICABILITY_UNPROVEN');
      }
      return evidence;
    },
  };
}
