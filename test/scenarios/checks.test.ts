import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import {
  commandInputs,
  dateTexts,
  deployProblems,
  fieldProblems,
  fieldsFromAriaSnapshot,
  intervalMatches,
  liveLeaks,
  localeProblems,
  parseJobStarts,
  parseSessionUrl,
  pauseResumePreconditions,
  quietProblems,
  redact,
  shiftedBy,
  snapshotOpenIssues,
  snapshotRepos,
  startsInWindow,
  workflowTriggers,
  TOKEN_PATTERN,
} from '../../scenarios/dashboard/checks.ts';

test('the session URL needs the proof only in the fragment, and reasons never carry it', () => {
  const s = parseSessionUrl('Dashboard at http://127.0.0.1:43210/#proof=abc123 (Ctrl-C to stop)');
  deepEqual(s, { sessionUrl: 'http://127.0.0.1:43210/#proof=abc123', origin: 'http://127.0.0.1:43210', port: 43210, proof: 'abc123' });
  equal(parseSessionUrl('http://127.0.0.1:1/?proof=abc'), undefined);
  equal(parseSessionUrl('http://127.0.0.1:1/abc#proof=abc'), undefined);
  equal(parseSessionUrl('http://127.0.0.1:1/'), undefined);
  equal(redact('go to http://127.0.0.1:1/#proof=abc123 now; session s3cr3t', ['s3cr3t']), 'go to http://127.0.0.1:1/#proof=<redacted> now; session <redacted>');
});

test('local Job starts come from podman events of the Nibfin image; the window check counts only starts inside it', () => {
  const out = [
    JSON.stringify({ Status: 'start', Type: 'container', Image: 'ghcr.io/taco3064/nibfin@sha256:aa', Name: 'job1', timeNano: 2_000_000_000 }),
    JSON.stringify({ Status: 'start', Type: 'container', Image: 'docker.io/library/busybox', Name: 'helper', timeNano: 2_500_000_000 }),
    JSON.stringify({ Status: 'died', Type: 'container', Image: 'ghcr.io/taco3064/nibfin@sha256:aa', Name: 'job1', timeNano: 3_000_000_000 }),
    'not json',
    JSON.stringify({ Status: 'start', Type: 'container', Image: 'ghcr.io/taco3064/nibfin@sha256:aa', Name: 'job2', time: 9 }),
  ].join('\n');
  const starts = parseJobStarts(out);
  deepEqual(starts.map((s) => [s.name, s.at]), [['job1', 2000], ['job2', 9000]]);
  deepEqual(startsInWindow(starts, 1000, 5000).map((s) => s.name), ['job1']);
  deepEqual(startsInWindow(starts, 3000, 5000), []);
});

test('quiet sandboxes: unpaused non-fixture stage Issues, open PRs, active runs and Nibfin containers are named', () => {
  const base = { containers: [], issues: [], pulls: [], runs: [], fixtures: ['[e2e #298] Dashboard fixture E'] };
  deepEqual(quietProblems(base), []);
  deepEqual(
    quietProblems({
      ...base,
      containers: [{ image: 'ghcr.io/taco3064/nibfin@sha256:aa', name: 'j' }, { image: 'busybox', name: 'b' }],
      issues: [
        {
          repo: 'o/x',
          issues: [
            { number: 1, title: 'work', labels: ['scope'] },
            { number: 2, title: 'held', labels: ['scope', 'pause'] },
            { number: 3, title: 'waiting', labels: ['request', 'pending'] },
            { number: 4, title: 'plain', labels: ['bug'] },
            { number: 5, title: '[e2e #298] Dashboard fixture E', labels: ['scope'] },
            { number: 6, title: 'asked', labels: ['request'] },
          ],
        },
      ],
      pulls: [7],
      runs: [{ id: 8, name: 'Nibfin · route', status: 'in_progress' }],
    }),
    [
      'Nibfin container j is running',
      'o/x#1 is open with scope and neither pause nor pending',
      'o/x#6 is open with request and neither pause nor pending',
      'pull request #7 is open',
      'workflow run 8 (Nibfin · route) is in_progress',
    ],
  );
});

test('command inputs keep only those with a param; dialog fields are compared by name, required flag and values', () => {
  const schema = commandInputs({
    commands: [
      {
        name: 'runner add',
        flags: [
          { name: 'count', param: 'count', required: false },
          { name: 'yes', param: '' },
        ],
        args: [{ name: 'provider', param: 'provider', required: true, values: ['claude', 'codex'] }],
      },
    ],
  });
  deepEqual(schema.get('runner add'), [
    { name: 'count', required: false, values: [] },
    { name: 'provider', required: true, values: ['claude', 'codex'] },
  ]);
  const fields = fieldsFromAriaSnapshot('- dialog "Runner add":\n  - combobox "Provider"\n  - spinbutton "Count"\n  - button "Preview"');
  deepEqual(fields, [{ role: 'combobox', name: 'Provider' }, { role: 'spinbutton', name: 'Count' }]);
  deepEqual(fieldProblems('runner add', schema.get('runner add') ?? [], fields), []);
  deepEqual(fieldProblems('runner add', schema.get('runner add') ?? [], [{ role: 'textbox', name: 'Count' }, { role: 'textbox', name: 'Model' }]), [
    'runner add: no field for input provider',
    'runner add: field Model is not in the parameter schema',
  ]);
  deepEqual(fieldProblems('x', [{ name: 'provider', required: true, values: ['claude', 'codex'] }], [{ role: 'combobox', name: 'Provider', required: false, options: ['Claude'] }]), [
    'x: field Provider is not marked required',
    'x: field Provider does not offer codex',
  ]);
});

test('Live checks find runner names, host-name keys and token patterns, and ignore empty values', () => {
  equal(liveLeaks({ result: { repos: [{ runners: [{ state: 'busy' }] }], hostname: '' } }, ['laptop-runner-1']).length, 0);
  deepEqual(liveLeaks({ result: { runners: [{ name: 'r1' }], machine: 'm' }, note: 'laptop-runner-1 is busy' }, ['laptop-runner-1']), [
    'Runner name laptop-runner-1 appears',
    'a runner entry has name',
    'key machine has a value',
  ]);
  ok(TOKEN_PATTERN.test('x ghp_' + 'a'.repeat(36)));
  ok(TOKEN_PATTERN.test('github_pat_' + 'b'.repeat(40)));
  equal(TOKEN_PATTERN.test('ghost_writer'), false);
});

test('snapshot repositories and open Issue numbers are read from the message', () => {
  const snap = { type: 'snapshot', result: { repos: [{ repo: 'taco3064/gh-nibfin', issues: [{ number: 3, state: 'OPEN' }, { number: 1 }, { number: 9, state: 'closed' }] }, { repo: 'taco3064/nibfin-core', issues: [] }] } };
  deepEqual(snapshotRepos(snap), ['gh-nibfin', 'nibfin-core']);
  deepEqual(Object.fromEntries(snapshotOpenIssues(snap, ['gh-nibfin', 'nibfin-core'])), { 'gh-nibfin': [1, 3], 'nibfin-core': [] });
  const keyed = { result: { repos: { 'nibfin-e2e': { issues: [{ number: 5 }] } } } };
  deepEqual(snapshotRepos(keyed), ['nibfin-e2e']);
  deepEqual(Object.fromEntries(snapshotOpenIssues(keyed, ['nibfin-e2e'])), { 'nibfin-e2e': [5] });
});

test('deploy triggers: push among several passes; manual runs beside a push run pass; a sha with only manual runs fails', () => {
  const yaml = 'name: Website\non:\n  push:\n    branches: [main]\n    paths:\n      - dashboard/**\n  workflow_dispatch:\njobs:\n  x: {}\n';
  deepEqual(workflowTriggers(yaml), { events: ['push', 'workflow_dispatch'], pushBranches: ['main'] });
  deepEqual(workflowTriggers('on: [push, workflow_dispatch]\n'), { events: ['push', 'workflow_dispatch'] });
  deepEqual(workflowTriggers('on:\n  push:\n    branches:\n      - main\n      - "release/*"\n'), { events: ['push'], pushBranches: ['main', 'release/*'] });
  const run = (event: string, sha: string) => ({ event, head_branch: 'main', head_sha: sha });
  deepEqual(deployProblems('w.yml', yaml, [run('push', 'a'), run('workflow_dispatch', 'a')]), []);
  deepEqual(deployProblems('w.yml', yaml, [run('push', 'a'), run('workflow_dispatch', 'b')]), ['w.yml: main commit b has only workflow_dispatch runs']);
  deepEqual(deployProblems('w.yml', 'on: workflow_dispatch\n', []), ['w.yml: push is not among its triggers (workflow_dispatch)', 'w.yml: no push run on main']);
  deepEqual(deployProblems('w.yml', 'on:\n  push:\n    branches: [dev]\n', [run('push', 'a')]), ['w.yml: push is limited to branches dev, without main']);
});

test('the timeline interval matches the job record within one minute', () => {
  ok(intervalMatches(['Busy 10:04 – 10:09'], '2026-11-26T10:04:40Z', '2026-11-26T10:09:10Z'));
  ok(intervalMatches(['10:04 AM', '10:09 AM'], '2026-11-26T10:04:10Z', '2026-11-26T10:09:10Z'));
  equal(intervalMatches(['Busy 10:04 – 10:09'], '2026-11-26T10:07:00Z', '2026-11-26T10:09:10Z'), false);
  equal(intervalMatches([], '2026-11-26T10:04:00Z', '2026-11-26T10:09:00Z'), false);
});

test('dates are compared across locales and shifted across time zones', () => {
  const utc = dateTexts(['Nov 26, 2026, 10:04', 'Runner 1', '24 hours', 'started 10:15 PM']);
  deepEqual(utc, ['Nov 26, 2026, 10:04', 'started 10:15 PM']);
  deepEqual(localeProblems(utc, [...utc]), []);
  ok(localeProblems(utc, ['26.11.2026, 10:04', 'started 22:15']).some((p) => p.startsWith('texts differ')));
  ok(localeProblems(['2026年11月26日 10:04'], ['2026年11月26日 10:04']).some((p) => p.includes('not in an English format')));
  deepEqual(localeProblems([], []), ['no date or time text on the page']);
  ok(shiftedBy(['Nov 26, 2026, 10:04'], ['Nov 26, 2026, 18:04'], 480));
  ok(shiftedBy(['Nov 26, 2026, 20:00'], ['Nov 27, 2026, 04:00'], 480));
  equal(shiftedBy(['10:04'], ['10:04'], 480), false);
});

test('the R9.20 target F needs scope+pause without shaped and the open, undelivered, paused blocker A', () => {
  const F = { number: 6, title: 'F', labels: ['scope', 'pause'] };
  const A = { id: 1, number: 1, title: 'A', labels: ['scope', 'pause'], state: 'open' };
  deepEqual(pauseResumePreconditions(F, A, [{ id: 1 }]), []);
  deepEqual(pauseResumePreconditions(F, A, []), ['F is not Blocked by A']);
  deepEqual(pauseResumePreconditions(F, { ...A, labels: ['scope'] }, [{ id: 1 }]), ['A is open with [scope]']);
  deepEqual(pauseResumePreconditions(F, { ...A, state: 'closed', labels: ['delivered'] }, [{ id: 1 }]), ['A is closed with [delivered]']);
  deepEqual(pauseResumePreconditions({ ...F, labels: ['scope', 'shaped', 'pause'] }, A, [{ id: 1 }]), ['F has [scope, shaped, pause]']);
});
