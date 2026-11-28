import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyUpdateMarker,
  commandInputs,
  commandSchemaFrom,
  countNear,
  dateTexts,
  deployProblems,
  fieldProblems,
  fieldsFromAriaSnapshot,
  hasCount,
  intervalMatches,
  issueHeading,
  liveLeaks,
  noTrackIssueMessage,
  localeProblems,
  parseJobStarts,
  parseSessionUrl,
  pickTrackIssue,
  lightProblem,
  stateOf,
  statusValue,
  pauseAppeared,
  pauseMarkers,
  pausePreconditionProblem,
  pauseResumePreconditions,
  describePauseView,
  quietProblems,
  redact,
  sessionFrom,
  shiftedBy,
  snapshotOpenIssues,
  snapshotRepos,
  startsInWindow,
  workflowTriggers,
  TOKEN_PATTERN,
  trackProblem,
  updateMarkerState,
} from '../../scenarios/dashboard/checks.ts';

test('the session URL needs the proof only in the fragment, and reasons never carry it', () => {
  const s = parseSessionUrl('Dashboard at http://127.0.0.1:43210/#proof=abc123 (Ctrl-C to stop)');
  deepEqual(s, {
    sessionUrl: 'http://127.0.0.1:43210/#proof=abc123',
    origin: 'http://127.0.0.1:43210',
    port: 43210,
    proof: 'abc123',
  });
  equal(parseSessionUrl('http://127.0.0.1:1/?proof=abc'), undefined);
  equal(parseSessionUrl('http://127.0.0.1:1/abc#proof=abc'), undefined);
  equal(parseSessionUrl('http://127.0.0.1:1/'), undefined);
  equal(
    redact('go to http://127.0.0.1:1/#proof=abc123 now; session s3cr3t', ['s3cr3t']),
    'go to http://127.0.0.1:1/#proof=<redacted> now; session <redacted>',
  );
});

test('local Job starts come from podman events of the Nibfin image; the window check counts only starts inside it', () => {
  const out = [
    JSON.stringify({
      Status: 'start',
      Type: 'container',
      Image: 'ghcr.io/taco3064/nibfin@sha256:aa',
      Name: 'job1',
      timeNano: 2_000_000_000,
    }),
    JSON.stringify({
      Status: 'start',
      Type: 'container',
      Image: 'docker.io/library/busybox',
      Name: 'helper',
      timeNano: 2_500_000_000,
    }),
    JSON.stringify({
      Status: 'died',
      Type: 'container',
      Image: 'ghcr.io/taco3064/nibfin@sha256:aa',
      Name: 'job1',
      timeNano: 3_000_000_000,
    }),
    'not json',
    JSON.stringify({
      Status: 'start',
      Type: 'container',
      Image: 'ghcr.io/taco3064/nibfin@sha256:aa',
      Name: 'job2',
      time: 9,
    }),
  ].join('\n');
  const starts = parseJobStarts(out);
  deepEqual(
    starts.map((s) => [s.name, s.at]),
    [
      ['job1', 2000],
      ['job2', 9000],
    ],
  );
  deepEqual(
    startsInWindow(starts, 1000, 5000).map((s) => s.name),
    ['job1'],
  );
  deepEqual(startsInWindow(starts, 3000, 5000), []);
});

test('quiet sandboxes: unpaused non-fixture stage Issues, open PRs, active runs and Nibfin containers are named', () => {
  const base = { containers: [], issues: [], pulls: [], runs: [], fixtures: ['[e2e #298] Dashboard fixture E'] };
  deepEqual(quietProblems(base), []);
  deepEqual(
    quietProblems({
      ...base,
      containers: [
        { image: 'ghcr.io/taco3064/nibfin@sha256:aa', name: 'j' },
        { image: 'busybox', name: 'b' },
      ],
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
  const fields = fieldsFromAriaSnapshot(
    '- dialog "Runner add":\n  - combobox "Provider":\n    - option "claude" [selected]\n    - option "codex"\n  - spinbutton "Count"\n  - button "Preview"',
  );
  deepEqual(fields, [
    { role: 'combobox', name: 'Provider', options: ['claude', 'codex'] },
    { role: 'spinbutton', name: 'Count' },
  ]);
  // The required flag comes from the element, as dialogFields reads it.
  deepEqual(
    fieldProblems(
      'runner add',
      schema.get('runner add') ?? [],
      fields.map((f) => ({ ...f, required: f.name === 'Provider' })),
    ),
    [],
  );
  deepEqual(
    fieldProblems(
      'runner add',
      schema.get('runner add') ?? [],
      fields.map((f) => ({ ...f, required: true })),
    ),
    ['runner add: field Count is marked required, the schema says optional'],
  );
  const noChoice = fieldsFromAriaSnapshot('- combobox "Provider"\n- spinbutton "Count"').map((f) => ({
    ...f,
    required: f.name === 'Provider',
  }));
  deepEqual(fieldProblems('runner add', schema.get('runner add') ?? [], noChoice), [
    'runner add: field Provider offers no choice of claude, codex',
  ]);
  deepEqual(
    fieldsFromAriaSnapshot(
      '- radiogroup "Provider":\n  - radio "claude"\n  - radio "codex"\n- checkbox "Delete login"',
    ),
    [
      { role: 'radiogroup', name: 'Provider', options: ['claude', 'codex'] },
      { role: 'checkbox', name: 'Delete login' },
    ],
  );
  deepEqual(
    fieldProblems('runner add', schema.get('runner add') ?? [], [
      { role: 'textbox', name: 'Count' },
      { role: 'textbox', name: 'Model' },
    ]),
    ['runner add: no field for input provider', 'runner add: field Model is not in the parameter schema'],
  );
  deepEqual(
    fieldProblems(
      'x',
      [{ name: 'provider', required: true, values: ['claude', 'codex'] }],
      [{ role: 'combobox', name: 'Provider', required: false, options: ['Claude'] }],
    ),
    ['x: field Provider is not marked required', 'x: field Provider does not offer codex'],
  );
});

test('Live checks find runner names, host-name keys and token patterns, and ignore empty values', () => {
  equal(
    liveLeaks({ result: { repos: [{ runners: [{ state: 'busy' }] }], hostname: '' } }, ['laptop-runner-1']).length,
    0,
  );
  deepEqual(
    liveLeaks({ result: { runners: [{ name: 'r1' }], machine: 'm' }, note: 'laptop-runner-1 is busy' }, [
      'laptop-runner-1',
    ]),
    ['Runner name laptop-runner-1 appears', 'a runner entry has name', 'key machine has a value'],
  );
  ok(TOKEN_PATTERN.test('x ghp_' + 'a'.repeat(36)));
  ok(TOKEN_PATTERN.test('github_pat_' + 'b'.repeat(40)));
  equal(TOKEN_PATTERN.test('ghost_writer'), false);
});

test('snapshot repositories and open Issue numbers are read from the message', () => {
  const snap = {
    type: 'snapshot',
    result: {
      repos: [
        {
          repo: 'taco3064/gh-nibfin',
          issues: [{ number: 3, state: 'OPEN' }, { number: 1 }, { number: 9, state: 'closed' }],
        },
        { repo: 'taco3064/nibfin-core', issues: [] },
      ],
    },
  };
  deepEqual(snapshotRepos(snap), ['gh-nibfin', 'nibfin-core']);
  deepEqual(Object.fromEntries(snapshotOpenIssues(snap, ['gh-nibfin', 'nibfin-core'])), {
    'gh-nibfin': [1, 3],
    'nibfin-core': [],
  });
  const keyed = { result: { repos: { 'nibfin-e2e': { issues: [{ number: 5 }] } } } };
  deepEqual(snapshotRepos(keyed), ['nibfin-e2e']);
  deepEqual(Object.fromEntries(snapshotOpenIssues(keyed, ['nibfin-e2e'])), { 'nibfin-e2e': [5] });
});

test('host-prefixed repository ids are read as repository names and agree with the open Issue reading', () => {
  const names = ['gh-nibfin', 'nibfin-core', 'nibfin-e2e'];
  const snap = {
    type: 'snapshot',
    result: { repos: names.map((n, i) => ({ repo: `github.com/taco3064/${n}`, issues: [{ number: i + 1 }] })) },
  };
  deepEqual(snapshotRepos(snap), names);
  deepEqual([...snapshotOpenIssues(snap, names).keys()].sort(), snapshotRepos(snap));
  const keyed = { result: { repos: { 'github.com/taco3064/nibfin-e2e': { issues: [{ number: 5 }] } } } };
  deepEqual(snapshotRepos(keyed), ['nibfin-e2e']);
  deepEqual([...snapshotOpenIssues(keyed, ['nibfin-e2e']).keys()].sort(), snapshotRepos(keyed));
  const odd = {
    result: {
      repos: [
        { repo: '' },
        { repo: 'github.com/taco3064/nibfin core' },
        { repo: 'github.com/taco3064/' },
        { repo: 'github.com/taco3064/gh-nibfin' },
      ],
    },
  };
  deepEqual(snapshotRepos(odd), ['gh-nibfin']);
  deepEqual(snapshotRepos({ result: { repos: { '': {}, 'a b': {}, 'github.com/': {} } } }), []);
});

test('deploy triggers: push among several passes; manual runs beside a push run pass; a sha with only manual runs fails', () => {
  const yaml =
    'name: Website\non:\n  push:\n    branches: [main]\n    paths:\n      - dashboard/**\n  workflow_dispatch:\njobs:\n  x: {}\n';
  deepEqual(workflowTriggers(yaml), { events: ['push', 'workflow_dispatch'], pushBranches: ['main'] });
  deepEqual(workflowTriggers('on: [push, workflow_dispatch]\n'), { events: ['push', 'workflow_dispatch'] });
  deepEqual(workflowTriggers('on:\n  push:\n    branches:\n      - main\n      - "release/*"\n'), {
    events: ['push'],
    pushBranches: ['main', 'release/*'],
  });
  const run = (event: string, sha: string) => ({ event, head_branch: 'main', head_sha: sha });
  deepEqual(deployProblems('w.yml', yaml, [run('push', 'a'), run('workflow_dispatch', 'a')]), []);
  deepEqual(deployProblems('w.yml', yaml, [run('push', 'a'), run('workflow_dispatch', 'b')]), [
    'w.yml: main commit b has only workflow_dispatch runs',
  ]);
  deepEqual(deployProblems('w.yml', 'on: workflow_dispatch\n', []), [
    'w.yml: push is not among its triggers (workflow_dispatch)',
    'w.yml: no push run on main',
  ]);
  deepEqual(deployProblems('w.yml', 'on:\n  push:\n    branches: [dev]\n', [run('push', 'a')]), [
    'w.yml: push is limited to branches dev, without main',
  ]);
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
  ok(
    localeProblems(['2026年11月26日 10:04'], ['2026年11月26日 10:04']).some((p) =>
      p.includes('not in an English format'),
    ),
  );
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
  deepEqual(pauseResumePreconditions(F, { ...A, state: 'closed', labels: ['delivered'] }, [{ id: 1 }]), [
    'A is closed with [delivered]',
  ]);
  deepEqual(pauseResumePreconditions({ ...F, labels: ['scope', 'shaped', 'pause'] }, A, [{ id: 1 }]), [
    'F has [scope, shaped, pause]',
  ]);
});

test('health lights agree with the state status --json reports', () => {
  const status = { repos: [{ repo: 'o/x', nibfinRun: { ok: true }, imageState: 'outdated', workflows: 'current' }] };
  equal(statusValue(status, /^nibfinRun$/), true);
  equal(stateOf(statusValue(status, /^imageState$/)), 'bad');
  equal(stateOf(statusValue(status, /^workflows$/)), 'good');
  equal(statusValue(status, /^missing$/), undefined);
  equal(lightProblem('Nibfin run', 'Nibfin run: running', 'good'), undefined);
  equal(lightProblem('image', 'Image: upgrade available', 'bad'), undefined);
  ok(lightProblem('image', 'Image: up to date', 'bad'));
  ok(lightProblem('Workflows', 'Workflows: not installed', 'good'));
  ok(lightProblem('Workflows', 'Workflows', undefined)?.includes('no readable state'));
});

test('the session comes from the exchange response body or header', () => {
  equal(sessionFrom({ status: 200, body: '{"session":"s1"}', headers: {} }), 's1');
  equal(sessionFrom({ status: 200, body: '', headers: { 'x-nibfin-session': 's2' } }), 's2');
  equal(sessionFrom({ status: 200, body: '{"ok":true}', headers: {} }), undefined);
});

test('the command schema comes from a 2xx JSON /api/commands reply; anything else fails R9.13 with the cause', () => {
  const command = { name: 'init', flags: [{ name: 'repo', param: 'repo', required: false }] };
  const expected = new Map([['init', [{ name: 'repo', required: false, values: [] }]]]);
  deepEqual(commandSchemaFrom({ status: 200, body: JSON.stringify({ commands: [command] }) }), expected);
  deepEqual(commandSchemaFrom({ status: 200, body: JSON.stringify([command]) }), expected);
  throws(
    () => commandSchemaFrom({ status: 401, body: 'missing session' }),
    /^Error: R9\.13 \(R5\.23\): .*HTTP 401: missing session/,
  );
  throws(() => commandSchemaFrom({ status: 404, body: '' }), /R9\.13.*HTTP 404/);
  throws(() => commandSchemaFrom({ status: 200, body: '<html>Dashboard</html>' }), /R9\.13.*not JSON \(/);
  throws(() => commandSchemaFrom({ status: 200, body: '{"ok":true}' }), /R9\.13.*no commands/);
  throws(
    () => commandSchemaFrom({ status: 500, body: 'x'.repeat(1000) }),
    (e: Error) => /HTTP 500/.test(e.message) && e.message.length < 400,
  );
});

test('a view header marks Live or manual refresh only in the marker wording; controls are neither (R9.8)', () => {
  const controls = ['Me', 'Repo', 'Runner', 'Refresh'];
  equal(classifyUpdateMarker(['Live']), 'live');
  equal(classifyUpdateMarker(['  Live ']), 'live');
  equal(classifyUpdateMarker([...controls, 'Live']), 'live');
  equal(classifyUpdateMarker(['Updates on Refresh']), 'manual');
  equal(classifyUpdateMarker(['Live updates off']), 'manual');
  equal(classifyUpdateMarker([...controls, 'Updates on Refresh']), 'manual');
  equal(classifyUpdateMarker([...controls, 'Live updates off']), 'manual');
  equal(classifyUpdateMarker(['Paused updates']), 'manual');
  equal(classifyUpdateMarker(['Refresh']), 'neither');
  equal(classifyUpdateMarker(['Refreshing…']), 'neither');
  equal(classifyUpdateMarker(controls), 'neither');
  equal(classifyUpdateMarker(['Live … Refresh']), 'neither');
  equal(classifyUpdateMarker([]), 'neither');
  equal(classifyUpdateMarker(['']), 'neither');
  equal(classifyUpdateMarker(['Live', 'Updates on Refresh']), 'both');
});

test('a view still on its first read is loading, not an R9.8 marker failure; once loaded the marker rule applies (R9.8, R9.34)', () => {
  const controls = ['Me', 'Repo', 'Runner'];
  const loaded = 'Me Repo Runner Refresh Open Issues 3 owner/repo#1 Add login';
  // loading
  equal(updateMarkerState(['Refreshing…'], 'No data yet Refreshing…'), 'loading');
  equal(updateMarkerState(['Refreshing...'], ''), 'loading');
  equal(updateMarkerState([...controls, 'Refresh'], 'Me Repo Runner Refresh No data yet'), 'loading');
  equal(updateMarkerState([], 'No data yet'), 'loading');
  equal(updateMarkerState([...controls, 'Refreshing…'], 'Me Repo Runner Refreshing…'), 'loading');
  // loaded-Live, even with a stray "No data yet" somewhere on the page
  equal(updateMarkerState(['Live'], loaded), 'live');
  equal(updateMarkerState([...controls, 'Live'], 'No data yet Live'), 'live');
  equal(updateMarkerState(['Live', 'Refreshing…'], loaded), 'live');
  // loaded-manual
  equal(updateMarkerState(['Updates on Refresh'], loaded), 'manual');
  equal(updateMarkerState(['Live updates off'], loaded), 'manual');
  // both markers
  equal(updateMarkerState(['Live', 'Updates on Refresh'], loaded), 'both');
  equal(updateMarkerState(['Live', 'Updates on Refresh'], 'No data yet'), 'both');
  // neither marker after loading
  equal(updateMarkerState([...controls, 'Refresh'], loaded), 'neither');
  equal(updateMarkerState([], ''), 'neither');
  equal(updateMarkerState(['Refreshing data for owner/repo'], loaded), 'neither');
});

test('a summary count is the standalone number next to its word, never a login or a reference (R9.1)', () => {
  equal(countNear('taco3064 on github.com Open Issues 14', /open(?: issues?)?/), 14);
  equal(
    countNear(
      'Open Issues with scope or request assigned to taco3064 on github.com Open Issues 14',
      /open(?: issues?)?/,
    ),
    14,
  );
  equal(countNear('Open Issues 14', /open(?: issues?)?/), 14);
  equal(countNear('14 open', /open(?: issues?)?/), 14);
  equal(countNear('Shape 3 Deliver 2', /Shape/), 3);
  equal(countNear('Shape 3 Deliver 2', /Deliver/), 2);
  equal(countNear('Open #12', /open/), undefined);
  equal(countNear('Waiting on repo#12', /waiting on/), undefined);
  equal(countNear('Open Issues for taco3064', /open(?: issues?)?/), undefined);
  equal(countNear('', /open/), undefined);
  equal(countNear('Reopened 3', /open/), undefined);
});

test('summary tile layouts give each count its own word (R9.1)', () => {
  const open = 'Open Issues\n14\nIssues\nShape 3\nDeliver 2';
  equal(countNear(open, /open(?: issues?)?/), 14);
  equal(countNear(open, /Shape/), 3);
  equal(countNear(open, /Deliver/), 2);
  const runs = 'Runs\n7 runs\nSucceeded 3\nFailed 1\nRunning 0';
  deepEqual(
    [/succeeded/, /failed/, /running/].map((w) => countNear(runs, w)),
    [3, 1, 0],
  );
  equal(countNear(runs, /skipped or cancell?ed/), undefined);
  const mixed = '7 runs Succeeded 3 Failed 1 Running 0 Skipped or cancelled 3';
  deepEqual(
    [/succeeded/, /failed/, /running/, /skipped or cancell?ed/].map((w) => countNear(mixed, w)),
    [3, 1, 0, 3],
  );
  const runners = 'Runners\n2 online · 0 busy\nMemory 3.1 GiB of 7.6 GiB in use';
  equal(countNear(runners, /online/), 2);
  equal(countNear(runners, /busy/), 0);
  ok(hasCount(runners));
  ok(!hasCount('Reading the host… 3.1 GiB #12 taco3064'));
  ok(!hasCount(''));
});

test('the Live R9.2 check picks a staged Issue that is open on GitHub and in the snapshot', () => {
  const i = (number: number, labels: string[]) => ({ number, title: `Issue ${number}`, labels });
  const repos = [
    { repo: 'nibfin-core', issues: [i(5, ['request']), i(6, [])], live: [5, 6] },
    { repo: 'gh-nibfin', issues: [i(9, ['scope', 'shaped']), i(3, ['scope'])], live: [3, 9] },
    { repo: 'nibfin-e2e', issues: [i(1, ['scope'])], live: [1] },
  ];
  deepEqual(pickTrackIssue(repos), { repo: 'gh-nibfin', issue: i(3, ['scope']), stage: 'Shape' });
  deepEqual(pickTrackIssue(repos, 'nibfin-e2e'), { repo: 'nibfin-e2e', issue: i(1, ['scope']), stage: 'Shape' });
  // A staged Issue beats request and unlabeled ones even in the shown repository.
  equal(pickTrackIssue(repos, 'nibfin-core')?.issue.number, 3);
  // Issues missing from the snapshot are ignored; request beats unlabeled.
  const partial = [
    { repo: 'nibfin-core', issues: [i(6, []), i(5, ['request'])], live: [5, 6] },
    { repo: 'gh-nibfin', issues: [i(3, ['scope'])], live: [] },
  ];
  deepEqual(pickTrackIssue(partial), { repo: 'nibfin-core', issue: i(5, ['request']), stage: undefined });
  equal(pickTrackIssue([{ repo: 'nibfin-core', issues: [i(6, [])], live: [6] }])?.issue.number, 6);
  equal(
    pickTrackIssue([
      { repo: 'nibfin-core', issues: [], live: [] },
      { repo: 'gh-nibfin', issues: [], live: [] },
    ]),
    undefined,
  );
});

test('the no-Issue R9.2 failure names it could not be checked and lists the counts', () => {
  equal(
    noTrackIssueMessage([
      { repo: 'nibfin-core', open: 0 },
      { repo: 'gh-nibfin', open: 0 },
      { repo: 'nibfin-e2e', open: 0 },
    ]),
    'R9.2: could not be checked: no open Issue in nibfin-core, gh-nibfin or nibfin-e2e (open Issues: nibfin-core 0, gh-nibfin 0, nibfin-e2e 0)',
  );
});

test("an Issue heading matches the Issue's own heading only", () => {
  const h = issueHeading(12, 'Fix it');
  ok(h.test('#12 Fix it (opens on GitHub in a new tab)'));
  ok(h.test('#12 Fix it'));
  ok(!h.test('nibfin-e2e#12 Fix it (opens in a new tab)'));
  ok(!h.test('#123 Fix it (opens on GitHub in a new tab)'));
  ok(!h.test('#12 Fix it later (opens on GitHub in a new tab)'));
  ok(!h.test('#12 fix it'));
  const r = issueHeading(7, 'Check (a) [b]+ $x?');
  ok(r.test('#7 Check (a) [b]+ $x? (opens on GitHub in a new tab)'));
  ok(!r.test('#7 Check a b $x'));
  ok(issueHeading(4, 'Two  spaces').test('#4 Two spaces (opens on GitHub in a new tab)'));
});

test('a stage track needs Shape, Deliver and Done and the label-given current step', () => {
  const steps = ['Scope (completed)', 'Shape (current)', 'Deliver', 'Done'];
  equal(trackProblem(steps, 'Shape (current)', 'Shape'), undefined);
  equal(trackProblem(['Shape', 'Deliver', 'Done'], 'Shape', 'Shape'), undefined);
  ok(trackProblem(['Scope', 'Shape', 'Done'], 'Shape', 'Shape')?.includes('no Deliver step'));
  ok(trackProblem(steps, 'Shape (current)', 'Deliver')?.includes('labels give Deliver'));
  ok(trackProblem(steps, undefined, 'Done')?.includes('current step none'));
  equal(trackProblem(steps, undefined, undefined), undefined);
  equal(trackProblem(steps, 'Scope (current)', undefined), undefined);
});

test('pauseAppeared: only a new Resume control or a new pause marker shows the pause', () => {
  const B = { present: true, text: 'D Shape Deliver Done pending Pause', pauseControls: 1, resumeControls: 0 };
  ok(
    pauseAppeared(B, {
      present: true,
      text: 'D Shape Deliver Done pending paused Resume',
      pauseControls: 0,
      resumeControls: 1,
    }),
  );
  equal(pauseAppeared(B, B), false);
  equal(pauseAppeared(B, { ...B, text: `${B.text} e2e-plain` }), false);
  equal(pauseAppeared(B, { present: false, text: '', pauseControls: 0, resumeControls: 0 }), false);
  equal(pauseAppeared(B, { present: true, text: '  ', pauseControls: 0, resumeControls: 1 }), false);
  equal(
    pauseAppeared(B, { present: true, text: 'D Shape Deliver Done pending', pauseControls: 0, resumeControls: 0 }),
    false,
  );
  ok(pauseAppeared(B, { ...B, text: 'D Shape Deliver Done pending paused Pause' }));
  equal(describePauseView({ present: false, text: '', pauseControls: 0, resumeControls: 0 }), 'not listed');
  ok(describePauseView({ ...B, text: `a\n${'x'.repeat(300)}` }).endsWith('…"'));
});

// A pending Issue in Needs your action offers Resume only (R9.52, R9.55); the edit adds a Paused marker.
const ACT = {
  present: true,
  text: '#338 D Scope Shape Deliver Done Needs your action No repair record covers this stop yet; see the pending comment Repair Resume',
  pauseControls: 0,
  resumeControls: 1,
};

test('pauseAppeared: a Resume control D already had does not count, a new pause marker does', () => {
  ok(pauseAppeared(ACT, { ...ACT, text: ACT.text.replace('Repair Resume', 'Paused Repair Resume') }));
  equal(pauseAppeared(ACT, ACT), false);
  equal(pauseAppeared(ACT, { ...ACT, text: `${ACT.text} e2e-plain` }), false);
  const worded = { ...ACT, text: `${ACT.text} paused by owner` };
  equal(pauseAppeared(worded, worded), false);
  const P = { present: true, text: 'D Shape Deliver Done pending Pause', pauseControls: 1, resumeControls: 0 };
  equal(pauseAppeared(P, { ...P, text: 'D Shape Pause Deliver Done pending' }), false);
});

test('pauseMarkers and pausePreconditionProblem: Pause control labels are not markers', () => {
  const P = { present: true, text: 'D Shape Deliver Done pending Pause', pauseControls: 1, resumeControls: 0 };
  equal(pauseMarkers(P), 0);
  equal(pausePreconditionProblem(P), undefined);
  equal(pauseMarkers(ACT), 0);
  equal(pausePreconditionProblem(ACT), undefined);
  const actPaused = { ...ACT, text: `${ACT.text} Paused` };
  equal(pauseMarkers(actPaused), 1);
  equal(pausePreconditionProblem(actPaused), 'already shows a pause marker');
  equal(pausePreconditionProblem({ ...P, text: `${P.text} Paused` }), 'already shows a pause marker');
  equal(pausePreconditionProblem({ present: false, text: '', pauseControls: 0, resumeControls: 0 }), 'not listed');
  equal(pausePreconditionProblem({ present: true, text: '  ', pauseControls: 0, resumeControls: 1 }), 'not listed');
  equal(
    pausePreconditionProblem({ present: true, text: 'D Shape Deliver Done', pauseControls: 0, resumeControls: 0 }),
    'no Pause or Resume control',
  );
});
