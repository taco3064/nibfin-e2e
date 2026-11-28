import { E2E_REPO, PROPOSAL_STATE_END, PROPOSAL_STATE_MARKER, REQUEST_LABEL, runMarker } from '../host/config.ts';
import type { GitHub } from '../host/github.ts';
import { decisionTable } from './decisions.ts';
import type { Decision } from './decisions.ts';
import { commentOnce, fence, fileSubject, filingContext, readBackProblems, readIssue } from './file.ts';
import type { Filed, FilingContext, RequestIssue } from './file.ts';
import type { RunEnv } from './report.ts';

export const PROPOSAL_TITLE = 'Proposal updated';

/** The `client_payload` of a `proposal-updated` dispatch (the contract #287's sender follows). */
export interface ProposalEvent {
  pageId: string;
  blockIds: string[];
  /** The event time, normalized to ISO-8601 UTC. */
  timestamp: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Validates the dispatch event; anything else is an input error (exit 2, no write). */
export function parseProposalEvent(text: string): ProposalEvent | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `event payload is not JSON: ${(error as Error).message}` };
  }
  const event = raw as {
    action?: unknown;
    client_payload?: { page_id?: unknown; block_ids?: unknown; timestamp?: unknown };
  } | null;
  if (event?.action !== 'proposal-updated')
    return { error: `event action must be proposal-updated, not ${JSON.stringify(event?.action)}` };
  const p = event.client_payload;
  if (typeof p?.page_id !== 'string' || p.page_id.trim() === '')
    return { error: 'client_payload.page_id must be a non-empty string' };
  if (!Array.isArray(p.block_ids) || !p.block_ids.every((b) => typeof b === 'string'))
    return { error: 'client_payload.block_ids must be a list of strings' };
  const ts = p.timestamp;
  if (typeof ts !== 'string' || !ISO.test(ts) || !Number.isFinite(Date.parse(ts)))
    return { error: 'client_payload.timestamp must be an ISO-8601 time' };
  return { pageId: p.page_id, blockIds: p.block_ids as string[], timestamp: new Date(ts).toISOString() };
}

export interface ProposalState {
  earliest: string;
  latest: string;
  /** The latest event time of the previous handled update, or 'none recorded'. */
  previous: string;
}

const STATE = new RegExp(`${PROPOSAL_STATE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\{.*?\\}) -->`);

export function readState(body: string): ProposalState | undefined {
  const m = STATE.exec(body);
  if (!m) return undefined;
  try {
    const s = JSON.parse(m[1] as string) as Partial<ProposalState>;
    if (typeof s.earliest === 'string' && typeof s.latest === 'string' && typeof s.previous === 'string') {
      return { earliest: s.earliest, latest: s.latest, previous: s.previous };
    }
  } catch {
    // An unreadable marker is treated as none.
  }
  return undefined;
}

/** The gate-managed block of the body: the hidden state and the three times in English. */
export function stateBlock(state: ProposalState): string {
  return [
    `${PROPOSAL_STATE_MARKER}${JSON.stringify(state)} -->`,
    `- Earliest change event: ${state.earliest}`,
    `- Latest change event: ${state.latest}`,
    `- Previous handled update: ${state.previous}`,
    PROPOSAL_STATE_END,
  ].join('\n');
}

/** Replaces the managed block, or appends it, keeping every other part of the body. */
export function withState(body: string, state: ProposalState): string {
  const start = body.indexOf(PROPOSAL_STATE_MARKER);
  const end = body.indexOf(PROPOSAL_STATE_END);
  if (start >= 0 && end > start)
    return body.slice(0, start) + stateBlock(state) + body.slice(end + PROPOSAL_STATE_END.length);
  return `${body.trimEnd()}\n\n${stateBlock(state)}`;
}

const minIso = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);
const maxIso = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

function eventText(event: ProposalEvent, runLink: string): string {
  return [
    `Event time: ${event.timestamp}`,
    `Run: ${runLink}`,
    '',
    'Page id and changed block ids:',
    '',
    fence([event.pageId, ...event.blockIds].join('\n')),
  ].join('\n');
}

function newBody(event: ProposalEvent, state: ProposalState, runLink: string): string {
  return [
    "The Nibfin Proposal changed. The Scope stage reads the before and after text of each change in Notion's version history (kept 7 days on the Free plan): it compares the page between the previous handled update and the latest change event below. Each changed block starts with its rule's `R` id, so the changed rules are found there; the gate does not map block ids to rules (Proposal R8.13, R8.20).",
    '',
    'Each new or changed rule gets its `coverage-map.json` entry in this repository, either the scenarios that test it or a `notE2e` reason, because the Proposal no longer marks which rules are tested (Proposal R8.15).',
    '',
    stateBlock(state),
    '',
    '## First event',
    '',
    eventText(event, runLink),
  ].join('\n');
}

/** The latest event time recorded on the most recently closed "Proposal updated" request. */
async function previousHandled(gh: GitHub): Promise<string> {
  for (let page = 1; ; page++) {
    const { data } = await gh.rest<RequestIssue[]>(
      'GET',
      `/repos/${E2E_REPO}/issues?state=closed&labels=${REQUEST_LABEL}&sort=updated&direction=desc&per_page=100&page=${page}`,
    );
    if (!Array.isArray(data)) throw new Error('GitHub GET closed requests: expected a list');
    for (const issue of data) {
      if (issue.pull_request || issue.title !== PROPOSAL_TITLE) continue;
      const s = readState(issue.body ?? '');
      if (s) return s.latest;
    }
    if (data.length < 100) return 'none recorded';
  }
}

async function patchState(
  ctx: FilingContext,
  issue: RequestIssue,
  event: ProposalEvent,
): Promise<{ issue: RequestIssue; changed: boolean }> {
  const body = issue.body ?? '';
  const old = readState(body) ?? { earliest: event.timestamp, latest: event.timestamp, previous: 'none recorded' };
  const next = {
    earliest: minIso(old.earliest, event.timestamp),
    latest: maxIso(old.latest, event.timestamp),
    previous: old.previous,
  };
  const updated = withState(body, next);
  if (updated === body) return { issue, changed: false };
  await ctx.gh.rest('PATCH', `/repos/${E2E_REPO}/issues/${issue.number}`, { body: updated });
  return { issue: await readIssue(ctx, issue.number), changed: true };
}

/**
 * Creates the single open "Proposal updated" request, or comments on it once per run and
 * widens its earliest and latest times. Redo-safe through the run marker and min/max.
 */
export async function proposalUpdated(
  gh: GitHub,
  env: RunEnv,
  event: ProposalEvent,
): Promise<{ output: { decisions: Decision[]; filed: Filed[]; summary: string }; failed: boolean }> {
  const runLink = `${env.serverUrl}/${E2E_REPO}/actions/runs/${env.runId}`;
  const { data: run } = await gh.rest<{ created_at?: string }>('GET', `/repos/${E2E_REPO}/actions/runs/${env.runId}`);
  if (typeof run.created_at !== 'string') throw new Error(`GitHub GET run ${env.runId}: no created_at`);
  const ctx = await filingContext(gh, env.runId, run.created_at);
  const decisions: Decision[] = [
    {
      subject: 'event',
      decision: 'received',
      reason: `${event.timestamp}, page ${event.pageId}, ${event.blockIds.length} changed blocks`,
    },
  ];
  let filed: Filed;
  try {
    filed = await fileOrUpdate(ctx, event, runLink);
  } catch (error) {
    filed = {
      title: PROPOSAL_TITLE,
      decision: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  decisions.push({
    subject: PROPOSAL_TITLE,
    decision: filed.decision,
    reason: filed.url ? `${filed.url}: ${filed.reason}` : filed.reason,
  });
  return {
    output: { decisions, filed: [filed], summary: decisionTable('Proposal updated', decisions) },
    failed: filed.decision === 'failed',
  };
}

async function fileOrUpdate(ctx: FilingContext, event: ProposalEvent, runLink: string): Promise<Filed> {
  const open = ctx.open.get(PROPOSAL_TITLE);
  if (open && !(open.body ?? '').includes(runMarker(ctx.runId))) {
    const done = await commentOnce(ctx, open, `## Another event\n\n${eventText(event, runLink)}`);
    if (done.issue.state === 'open') {
      const patched = await patchState(ctx, done.issue, event);
      return check(
        patched.issue,
        ctx,
        done.decision,
        `reused open request #${open.number}${patched.changed ? '; times updated' : ''}`,
      );
    }
    ctx.open.delete(PROPOSAL_TITLE);
  } else if (open) {
    // This run created it: a redo only converges the times.
    const patched = await patchState(ctx, await readIssue(ctx, open.number), event);
    return check(patched.issue, ctx, 'already filed', `this run filed #${open.number}`);
  }
  const previous = await previousHandled(ctx.gh);
  const state = { earliest: event.timestamp, latest: event.timestamp, previous };
  return fileSubject(ctx, { title: PROPOSAL_TITLE, body: newBody(event, state, runLink) });
}

function check(issue: RequestIssue, ctx: FilingContext, decision: Filed['decision'], reason: string): Filed {
  const problems = readBackProblems(issue, PROPOSAL_TITLE, ctx.owner);
  if (problems.length)
    return {
      title: PROPOSAL_TITLE,
      decision: 'failed',
      number: issue.number,
      url: issue.html_url,
      reason: `read-back after "${decision}": ${problems.join('; ')}`,
    };
  return { title: PROPOSAL_TITLE, decision, number: issue.number, url: issue.html_url, reason };
}
