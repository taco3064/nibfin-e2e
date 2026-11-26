import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import type { GitHub } from '../../src/host/github.ts';
import { FIXTURES, fixtureTitle } from '../../scenarios/dashboard/checks.ts';
import { assertQuietSandboxes, ensureFixtures } from '../../scenarios/dashboard/github.ts';
import { sessionFrom } from '../../scenarios/dashboard/serving.ts';

interface FakeIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  state: string;
  html_url: string;
  labels: { name: string }[];
  blockedBy: number[];
}

/** Just the GitHub calls the fixtures and the quiet check make, with every call recorded. */
function fakeGitHub(seed: Record<string, FakeIssue[]> = {}) {
  const repos = new Map<string, FakeIssue[]>(Object.entries(seed));
  const calls: string[] = [];
  let n = 100;
  const extra = { pulls: [] as { number: number }[], runs: [] as { id: number; name: string; status: string }[] };
  const all = () => [...repos.values()].flat();
  const route = (method: string, path: string, body?: Record<string, unknown>): unknown => {
    if (path === '/user') return { login: 'owner' };
    const m = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(path.split('?')[0] as string);
    if (!m) throw new Error(`no route ${path}`);
    const repo = m[1] as string;
    const rest = m[2] as string;
    const list = repos.get(repo) ?? (repos.set(repo, []), repos.get(repo) as FakeIssue[]);
    const q = new URLSearchParams(path.split('?')[1] ?? '');
    if (rest === 'issues' && method === 'GET') return list.filter((i) => q.get('state') === 'all' || i.state === q.get('state'));
    if (rest === 'issues' && method === 'POST') {
      const number = ++n;
      const issue = { id: number * 10, node_id: `I${number}`, number, title: String(body?.title), state: 'open', html_url: `https://github.com/${repo}/issues/${number}`, labels: (body?.labels as string[]).map((name) => ({ name })), blockedBy: [] };
      list.push(issue);
      return issue;
    }
    let x: RegExpExecArray | null;
    if ((x = /^issues\/(\d+)$/.exec(rest))) {
      const i = list.find((y) => y.number === Number(x?.[1])) as FakeIssue;
      if (method === 'PATCH') i.state = String(body?.state);
      return i;
    }
    if ((x = /^issues\/(\d+)\/dependencies\/blocked_by$/.exec(rest))) {
      const i = list.find((y) => y.number === Number(x?.[1])) as FakeIssue;
      if (method === 'POST') i.blockedBy.push(Number(body?.issue_id));
      return i.blockedBy.map((id) => all().find((y) => y.id === id));
    }
    if (rest === 'pulls') return extra.pulls;
    if (rest === 'actions/runs') return { workflow_runs: extra.runs.filter((r) => r.status === q.get('status')) };
    throw new Error(`no route ${method} ${path}`);
  };
  const gh: GitHub = {
    rest: async <T>(method: string, path: string, body?: unknown) => {
      calls.push(`${method} ${path}`);
      return { status: 200, data: route(method, path, body as Record<string, unknown>) as T };
    },
    list: async <T>(path: string, key?: string) => {
      calls.push(`GET ${path}`);
      const data = route('GET', path) as Record<string, unknown> | unknown[];
      return (key ? (data as Record<string, unknown>)[key] : data) as T[];
    },
    graphql: async () => {
      throw new Error('no GraphQL');
    },
    download: async () => {
      throw new Error('no download');
    },
  };
  return { gh, calls, repos, extra };
}

const sandboxes = { execution: 'o/exec', peer: 'o/peer' };

test('fixtures are created with labels and Assignee in the create call, and their Blocked by edges read back', async () => {
  const f = fakeGitHub();
  const got = await ensureFixtures(f.gh, sandboxes);
  const creates = f.calls.filter((c) => /^POST \/repos\/[^/]+\/[^/]+\/issues$/.test(c));
  equal(creates.length, FIXTURES.length);
  equal(f.calls.some((c) => /\/labels/.test(c)), false);
  deepEqual(got.B.labels, ['scope', 'shaped', 'pause']);
  equal(got.C.state, 'closed');
  equal(got.P.repo, 'o/peer');
  const b = f.repos.get('o/exec')?.find((i) => i.title === fixtureTitle('B'));
  deepEqual(b?.blockedBy.sort(), [got.A.id, got.C.id, got.P.id].sort());

  const again = f.calls.length;
  await ensureFixtures(f.gh, sandboxes);
  equal(f.calls.slice(again).some((c) => c.startsWith('POST')), false, 'a second call reuses every fixture by title');
});

test('a found fixture with other Nibfin labels fails and is not re-labelled', async () => {
  const f = fakeGitHub({
    'o/exec': [{ id: 1, node_id: 'I1', number: 1, title: fixtureTitle('A'), state: 'open', html_url: 'u', labels: [{ name: 'scope' }], blockedBy: [] }],
  });
  await rejects(ensureFixtures(f.gh, sandboxes), /fixture A \(o\/exec#1\) has Nibfin labels \[scope\], expected \[pause, scope\]; it was not changed/);
  equal(f.calls.some((c) => c.startsWith('POST') || c.startsWith('PATCH')), false);
});

test('the quiet check reads only and names what is still active', async () => {
  const f = fakeGitHub({
    'o/exec': [{ id: 1, node_id: 'I1', number: 1, title: 'other work', state: 'open', html_url: 'u', labels: [{ name: 'scope' }], blockedBy: [] }],
    'o/peer': [{ id: 2, node_id: 'I2', number: 2, title: 'held', state: 'open', html_url: 'u', labels: [{ name: 'scope' }, { name: 'pending' }], blockedBy: [] }],
  });
  f.extra.pulls.push({ number: 9 });
  const ps = async () => ({ code: 0, stdout: JSON.stringify([{ Image: 'ghcr.io/taco3064/nibfin@sha256:aa', Names: ['job'] }]), stderr: '' });
  const err = await assertQuietSandboxes({ github: f.gh, sandboxes, podmanPs: ps, runsTimeoutMs: 0 }).catch((e: Error) => e.message);
  match(String(err), /^precondition: earlier work in the sandboxes is still active/);
  match(String(err), /Nibfin container job is running; o\/exec#1 is open with scope and neither pause nor pending; pull request #9 is open/);
  equal(String(err).includes('o/peer#2'), false);
  equal(f.calls.every((c) => c.startsWith('GET ')), true);

  const quiet = fakeGitHub();
  await assertQuietSandboxes({ github: quiet.gh, sandboxes, podmanPs: async () => ({ code: 0, stdout: '[]', stderr: '' }), runsTimeoutMs: 0 });
});

test('the quiet check reports a run that stays active', async () => {
  const f = fakeGitHub();
  f.extra.runs.push({ id: 5, name: 'Nibfin · route', status: 'in_progress' });
  await rejects(assertQuietSandboxes({ github: f.gh, sandboxes, podmanPs: async () => ({ code: 0, stdout: '[]', stderr: '' }), runsTimeoutMs: 0 }), /workflow run 5 \(Nibfin · route\) is in_progress/);
});

test('the session comes from the exchange response body or header', () => {
  equal(sessionFrom({ status: 200, body: '{"session":"s1"}', headers: {} }), 's1');
  equal(sessionFrom({ status: 200, body: '', headers: { 'x-nibfin-session': 's2' } }), 's2');
  equal(sessionFrom({ status: 200, body: '{"ok":true}', headers: {} }), undefined);
});
