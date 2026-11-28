import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { flagDiff, normalDefault } from '../../scenarios/management/dashboard.ts';
import { releaseSteps } from '../../scenarios/management/image-release.ts';
import { checkInitFiles, ownerUse, type ImageTags } from '../../scenarios/management/init-files.ts';
import { namesRebaseOnly } from '../../scenarios/management/init-settings.ts';
import { newEnabledUnits, wslconfigChanges } from '../../scenarios/management/runner-add-setup.ts';
import {
  newCronEntries,
  newTimerUnits,
  newTimers,
  newVmUnits,
  periodicTriggers,
} from '../../scenarios/management/runner-no-periodic.ts';
import { changedKeys, withoutProvider } from '../../scenarios/management/upgrade.ts';
import { poolLines } from '../../scenarios/management/wording.ts';
import { Check } from '../../scenarios/lib/check.ts';

const D = 'sha256:' + 'a'.repeat(64);
const wf = (name: string, extra = '') =>
  `name: Nibfin · ${name}\nrun-name: Nibfin · \${{ inputs.issue }}\non: issues\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: podman run ghcr.io/taco3064/nibfin@${D}\n${extra}`;
const shared = wf('Shared', '  k:\n    runs-on: [self-hosted, nibfin-1]\n');

const WFS = '.github/workflows/';
/** A shared runner shaped like the generated one: a block-scalar expression run-name, no Jobs of its own, a call to nibfin-job.yml. */
const sharedCaller = `name: Nibfin · Shared runner
run-name: >-
  \${{ inputs.issue != ''
  && format('Nibfin · {0}#{1} · {2}', inputs.repo, inputs.issue, inputs.stage)
  || format('Nibfin · {0}@{1} · route', inputs.repo, inputs.ref) }}

on:
  workflow_dispatch:
    inputs:
      issue:
        type: string
jobs:
  job:
    uses: ./.github/workflows/nibfin-job.yml
    with:
      issue: \${{ inputs.issue }}
`;
/** A reusable job shaped like the generated one: the bare name only to find older images, the pinned one to run. */
const job = (o: { run?: string; env?: string; runsOn?: string; on?: string } = {}) => `name: Nibfin · Job
on:
${o.on ?? '  workflow_call:\n    inputs:\n      assignee:\n        type: string\n'}env:
${o.env ?? `  IMAGE: ghcr.io/taco3064/nibfin\n  IMAGE_REF: ghcr.io/taco3064/nibfin@${D}\n`}jobs:
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: podman pull "$IMAGE_REF"
  stage:
    runs-on: ${o.runsOn ?? '[self-hosted, "nibfin-${{ inputs.assignee }}"]'}
    steps:
      - run: |
          podman images | while read -r id repository; do [ "$repository" != "$IMAGE" ] || echo "$id"; done
          podman run --rm \\
            --label x \\
            ${o.run ?? '"$IMAGE_REF"'} nibfin run
`;
const request =
  'name: Nibfin · Runner request\nrun-name: Nibfin · ${{ github.event.issue.number }} · runner request\non:\n  issues:\n    types: [opened]\njobs:\n  r:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo\n';
/** The problems of an execution init PR: the four R5.3 files, with some replaced or added (`over`) or left out (`drop`). */
const execProblems = (over: Record<string, string> = {}, drop: string[] = []) => {
  const files = Object.entries({
    'nibfin-issue.yml': wf('Issue'),
    'nibfin-shared-runner.yml': sharedCaller,
    'nibfin-job.yml': job(),
    'nibfin-runner-request.yml': request,
    ...over,
  })
    .filter(([name]) => !drop.includes(name))
    .map(([name, text]) => ({ path: name.includes('/') ? name : WFS + name, text }));
  const c = new Check();
  checkInitFiles(c, 'o/exec', 'execution', files, D);
  return c.problems.join('\n');
};

test('init files: the four R5.3 execution files with a reusable nibfin-job.yml, and the peer set, pass', () => {
  equal(execProblems(), '');
  const c = new Check();
  checkInitFiles(c, 'o/peer', 'peer', [{ path: WFS + 'nibfin-issue.yml', text: wf('Issue') }], D);
  deepEqual(c.problems, []);
  // A shared runner with a nibfin- Job of its own still passes.
  equal(execProblems({ 'nibfin-shared-runner.yml': shared }), '');
});

test('init files: extra and missing files, Owner calls, other digests and bad names are each reported', () => {
  const all = execProblems({
    'nibfin-issue.yml': wf('Issue', '      - uses: taco3064/nibfin-core/.github/workflows/x.yml@main\n'),
    'nibfin-job.yml': job({ run: `ghcr.io/taco3064/nibfin@sha256:${'b'.repeat(64)}` }),
    'nibfin-runner-request.yml': 'name: Runner request\non: issues\n',
    'nibfin-extra.yml': wf('Extra'),
    'nibfin-wake.yml': wf('Wake'),
    '.github/producer-pins.json': '{}',
  });
  match(
    all,
    /R5.3: o\/exec init PR adds .github\/workflows\/nibfin-extra.yml, which is not in the execution set \(nibfin-issue.yml, nibfin-shared-runner.yml, nibfin-job.yml, nibfin-runner-request.yml\)/,
  );
  match(all, /R5.4: o\/exec init PR adds .github\/workflows\/nibfin-wake.yml/);
  match(all, /R5.4: o\/exec init PR adds .github\/producer-pins.json/);
  equal(/adds .github\/workflows\/nibfin-(job|runner-request).yml/.test(all), false);
  match(all, /R5.5: o\/exec: .github\/producer-pins.json is not named/);
  match(all, /R5.5: o\/exec: .github\/workflows\/nibfin-runner-request.yml name is "Runner request"/);
  match(all, /R5.5: o\/exec: .github\/workflows\/nibfin-runner-request.yml run-name is null/);
  match(all, /R5.7: o\/exec: .github\/workflows\/nibfin-issue.yml uses taco3064\/nibfin-core/);
  match(
    all,
    /R5.7: .*nibfin-job.yml references ghcr.io\/taco3064\/nibfin@sha256:b+, expected ghcr.io\/taco3064\/nibfin@sha256:a+/,
  );
  match(
    execProblems({}, ['nibfin-runner-request.yml']),
    /R5.3: o\/exec init PR lacks .github\/workflows\/nibfin-runner-request.yml/,
  );
  const peer = new Check();
  checkInitFiles(
    peer,
    'o/peer',
    'peer',
    [
      { path: WFS + 'nibfin-issue.yml', text: wf('Issue') },
      { path: WFS + 'nibfin-shared-runner.yml', text: shared },
    ],
    D,
  );
  match(peer.problems.join('\n'), /R5.37: o\/peer init PR has nibfin-shared-runner.yml, so it is not the peer version/);
});

test('init files: only the SHA-pinned nibfin-core Action whose commit tag is the pinned image passes R5.7', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const other = 'sha256:' + 'c'.repeat(64);
  const run = (use: string, tags: ImageTags = new Map([[sha, { digest: D }]])) => {
    const c = new Check();
    checkInitFiles(
      c,
      'o/peer',
      'peer',
      [{ path: WFS + 'nibfin-issue.yml', text: wf('Issue', `      - uses: ${use}\n`) }],
      D,
      tags,
    );
    return c.problems.join('\n');
  };
  equal(run(`taco3064/nibfin-core@${sha}`), '');
  equal(run(`taco3064/nibfin-core/actions/handoff@${sha}`), '');
  for (const ref of ['main', 'v1', sha.slice(0, 7)]) {
    match(
      run(`taco3064/nibfin-core@${ref}`),
      new RegExp(
        `R5.7: o/peer: .github/workflows/nibfin-issue.yml uses taco3064/nibfin-core@${ref}, pinned to ${ref}, not a full 40-character commit SHA`,
      ),
    );
  }
  match(
    run(`taco3064/nibfin-core/.github/workflows/x.yml@${sha}`),
    /R5.7: .*uses taco3064\/nibfin-core\/.github\/workflows\/x.yml@0123\w+, a reusable workflow of nibfin-core, which R5.7 does not allow/,
  );
  match(
    run(`taco3064/other-repo@${sha}`),
    /R5.7: .*uses taco3064\/other-repo@0123\w+, a workflow or action of another Owner repository; R5.7 allows only the taco3064\/nibfin-core Action/,
  );
  match(run(`taco3064/nibfin-core-x@${sha}`), /another Owner repository/);
  const none = new RegExp(
    `R5.7: .*nibfin-issue.yml uses taco3064/nibfin-core@${sha}, whose image tag ghcr.io/taco3064/nibfin:${sha} has no digest \\(none\\), expected sha256:a+`,
  );
  match(run(`taco3064/nibfin-core@${sha}`, new Map()), none);
  match(run(`taco3064/nibfin-core@${sha}`, new Map([[sha, {}]])), none);
  match(
    run(`taco3064/nibfin-core@${sha}`, new Map([[sha, { digest: other }]])),
    new RegExp(`whose image tag ghcr.io/taco3064/nibfin:${sha} is sha256:c+, expected sha256:a+`),
  );
  const failed = run(
    `taco3064/nibfin-core@${sha}`,
    new Map([[sha, { error: `GHCR HEAD taco3064/nibfin:${sha} returned 500` }]]),
  );
  match(
    failed,
    new RegExp(
      `uses taco3064/nibfin-core@${sha}, but ghcr.io/taco3064/nibfin:${sha} could not be read: GHCR HEAD taco3064/nibfin:${sha} returned 500`,
    ),
  );
  equal(/no digest|expected sha256/.test(failed), false);
  // Other Owner forms keep today's reason, and the github.com/taco3064/ text check still reports.
  match(run('docker://ghcr.io/taco3064/x'), /uses docker:\/\/ghcr.io\/taco3064\/x, a workflow or action of the Owner/);
  match(
    run(`taco3064/nibfin-core@${sha} # https://github.com/taco3064/nibfin-core`),
    /nibfin-issue.yml refers to a github.com\/taco3064\/ repository/,
  );
});

test('init files: ownerUse leaves non-Owner values to the other checks and matches the Owner case-insensitively', () => {
  equal(ownerUse('actions/checkout@v4'), undefined);
  equal(ownerUse('./.github/workflows/nibfin-job.yml'), undefined);
  deepEqual(ownerUse('TACO3064/Nibfin-Core@' + 'f'.repeat(40)), { sha: 'f'.repeat(40) });
  equal(execProblems(), '');
});

test('init files: a reusable nibfin-job.yml that runs an unpinned image fails R5.7', () => {
  match(
    execProblems({ 'nibfin-job.yml': job({ run: '"$IMAGE"' }) }),
    /R5.7: o\/exec: .github\/workflows\/nibfin-job.yml references ghcr.io\/taco3064\/nibfin run without a digest, expected/,
  );
  match(
    execProblems({ 'nibfin-job.yml': job({ run: 'ghcr.io/taco3064/nibfin:latest' }) }),
    /R5.7: .*nibfin-job.yml references ghcr.io\/taco3064\/nibfin:latest, expected/,
  );
  match(
    execProblems({ 'nibfin-job.yml': job({ env: '  IMAGE: ghcr.io/taco3064/nibfin\n', run: '"$IMAGE:main"' }) }),
    /R5.7: .*nibfin-job.yml references ghcr.io\/taco3064\/nibfin with no expected digest in the file or its caller/,
  );
});

test('init files: a shared runner and the job it calls with no nibfin- runs-on label fail R5.7', () => {
  match(
    execProblems({ 'nibfin-job.yml': job({ runsOn: 'ubuntu-24.04' }) }),
    /R5.7: o\/exec: no runs-on in nibfin-shared-runner.yml or the local workflows it calls \(nibfin-job.yml\) uses a nibfin- label \(ubuntu-24.04 \| ubuntu-24.04\)/,
  );
});

test('init files: only a workflow-call-only file may leave out its run-name (R5.5)', () => {
  equal(execProblems({ 'nibfin-job.yml': job() }), '');
  match(
    execProblems({ 'nibfin-job.yml': job({ on: '  workflow_call:\n  issues:\n    types: [opened]\n' }) }),
    /R5.5: o\/exec: .github\/workflows\/nibfin-job.yml run-name is null, expected to start with "Nibfin"/,
  );
  match(
    execProblems({
      'nibfin-issue.yml': wf('Issue').replace(
        /run-name: .*\n/,
        "run-name: ${{ github.event.issue && format('Nibfin · {0}', 1) || 'Other' }}\n",
      ),
    }),
    /R5.5: .*nibfin-issue.yml run-name is .*, expected to start with "Nibfin"/,
  );
});

test('Dashboard flags compare by name and by the default cobra prints', () => {
  const help = 'Flags:\n      --count int   n (default 2)\n  -h, --help    help\n      --yes     y\n';
  deepEqual(
    flagDiff(help, {
      path: 'runner add',
      flags: [
        { name: 'count', default: 2 },
        { name: 'yes', default: false },
      ],
    }),
    [],
  );
  deepEqual(flagDiff(help, { path: 'runner add', flags: [{ name: 'count', default: '3' }, { name: 'yes' }] }), [
    '--count default is "2" in --help and "3" in /api/commands',
  ]);
  match(
    flagDiff(help, { path: 'runner add', flags: [{ name: 'count', default: 2 }] }).join(),
    /flags in --help \[count, yes\] differ from \/api\/commands \[count\]/,
  );
  deepEqual(
    [normalDefault(false), normalDefault(0), normalDefault(''), normalDefault('x'), normalDefault(['a'])],
    ['', '', '', 'x', '[a]'],
  );
});

test('release publishing in CI is found; release downloads are not', () => {
  deepEqual(
    releaseSteps(
      'run: gh release create v1\nuses: softprops/action-gh-release@v2\ncurl https://github.com/a/b/releases/download/v1/x\n',
    ),
    ['run: gh release create v1', 'uses: softprops/action-gh-release@v2'],
  );
  deepEqual(releaseSteps('run: go build ./...\n'), []);
  deepEqual(releaseSteps('run: gh api repos/o/r/releases -f tag=v1'), ['run: gh api repos/o/r/releases -f tag=v1']);
});

test('host diffs: new enabled units and changed .wslconfig keys', () => {
  const before = {
    platform: 'linux' as const,
    units: [{ name: 'a.service', state: 'enabled' }],
    linger: 'no',
    systemFiles: [],
    readAt: 0,
    pathDirs: [],
  };
  const now = {
    ...before,
    units: [...before.units, { name: 'n-1.service', state: 'enabled' }, { name: 'x.service', state: 'disabled' }],
  };
  deepEqual(newEnabledUnits(before, now), ['n-1.service']);
  // An image that already enables a global user unit before runner add (read without a manager): it is not new.
  const image = {
    ...before,
    units: [
      { name: 'gpg-agent.socket', state: 'enabled' },
      { name: 'late.service', state: 'disabled' },
    ],
  };
  const after = {
    ...image,
    units: [
      { name: 'gpg-agent.socket', state: 'enabled' },
      { name: 'late.service', state: 'enabled' },
      { name: 'n-1.service', state: 'enabled' },
    ],
  };
  deepEqual(newEnabledUnits(image, after), ['late.service', 'n-1.service']);
  const w = wslconfigChanges(
    '[wsl2]\nnestedVirtualization=true\nmemory=4GB\n',
    '[wsl2]\nnestedVirtualization=true\nvmIdleTimeout=-1\n',
  );
  deepEqual([w.changed, w.added, w.now.wsl2?.vmidletimeout], [['[wsl2] memory'], ['[wsl2] vmidletimeout'], '-1']);
});

test('host diffs: a .wslconfig that differs only in formatting is unchanged (Proposal R5.16)', () => {
  const kept = wslconfigChanges(
    '[wsl2]\nnestedVirtualization=true\nvmIdleTimeout=-1\n',
    '\r\n[WSL2]\r\n  vmidletimeout = -1 \r\n# note\r\nNestedVirtualization=true\r\n',
  );
  deepEqual([kept.changed, kept.added], [[], []]);
  const lost = wslconfigChanges('[wsl2]\nvmIdleTimeout=-1\n', '[wsl2]\n');
  deepEqual([lost.changed, lost.added], [['[wsl2] vmidletimeout'], []]);
});

test('upgrade helpers: the provider line is dropped alone; settings changes name keys only', () => {
  equal(withoutProvider('NIBFIN_PROVIDER=claude\nNIBFIN_MODEL=x\n'), 'NIBFIN_MODEL=x\n');
  deepEqual(changedKeys({ env: { T: 's1' }, a: 1 }, { env: { T: 's2' }, a: 1, b: 2 }), ['b', 'env']);
  deepEqual(changedKeys(undefined, undefined), []);
});

test('wording: Pool as a whole word, any case', () => {
  deepEqual(poolLines('Add Runners\nmanage the Pool\npools of runners\nspool file\n'), [
    'manage the Pool',
    'pools of runners',
  ]);
});

// ---- runner-no-periodic (Proposal R5.17) ----------------------------------------

const u = (name: string, state = 'enabled') => ({ name, state });

test('newTimerUnits: new .timer unit files in any state; other new units and old timers are not counted', () => {
  deepEqual(
    newTimerUnits(
      [u('a.timer', 'static'), u('x.service')],
      [u('a.timer', 'enabled'), u('b.timer', 'disabled'), u('nibfin-1.service'), u('x.service')],
    ),
    [u('b.timer', 'disabled')],
  );
});

test('newTimers: a transient timer is new; an image timer only loaded later is not', () => {
  deepEqual(newTimers({ timers: [], units: [u('logrotate.timer', 'static')] }, ['logrotate.timer', 'run-u7.timer']), [
    'run-u7.timer',
  ]);
  deepEqual(newTimers({ timers: ['run-u1.timer'], units: [] }, ['run-u1.timer']), []);
});

test('newCronEntries: all four availability transitions', () => {
  deepEqual(
    newCronEntries(
      { available: true, entries: ['@daily a'] },
      { available: true, entries: ['@daily a', '*/5 * * * * b'] },
    ).problems,
    ['the crontab gained the entry "*/5 * * * * b"'],
  );
  const absent = newCronEntries({ available: false, evidence: 'e1' }, { available: false, evidence: 'e2' });
  deepEqual(absent, { problems: [], evidence: 'cron not installed before (e1) or after (e2)' });
  match(
    newCronEntries({ available: false, evidence: 'e1' }, { available: true, entries: ['@hourly c'] }).problems.join(),
    /cron was not installed before runner add \(e1\) and is now, with the entries \["@hourly c"\]/,
  );
  match(
    newCronEntries({ available: true, entries: [] }, { available: false, evidence: 'e2' }).problems.join(),
    /readable before runner add but cron now reads as not installed \(e2\); the reads disagree/,
  );
});

test('newVmUnits: the units runner add added in the VM; none is the positive-control failure', () => {
  deepEqual(newVmUnits([u('a.service')], [u('a.service'), u('nibfin-runner-1.service')]), ['nibfin-runner-1.service']);
  deepEqual(newVmUnits([u('a.service')], [u('a.service')]), []);
});

test('periodicTriggers: logon and event triggers without repetition pass; time, daily, idle, unknown and repeating ones are flagged', () => {
  const t = (triggers: string[], repetitions = triggers.map(() => '')) =>
    periodicTriggers({ actions: [], triggers, repetitions });
  deepEqual(t(['MSFT_TaskLogonTrigger', 'MSFT_TaskEventTrigger'], ['', 'PT0S']), []);
  for (const k of ['MSFT_TaskTimeTrigger', 'MSFT_TaskDailyTrigger', 'MSFT_TaskIdleTrigger', 'MSFT_TaskSomethingNew']) {
    deepEqual(t([k]), [`trigger ${k} is neither a logon nor an event trigger`]);
  }
  deepEqual(t(['MSFT_TaskLogonTrigger'], ['PT5M']), ['trigger MSFT_TaskLogonTrigger repeats every PT5M']);
  match(t(['MSFT_TaskLogonTrigger'], []).join(), /trigger repetitions could not be read \(0 for 1 triggers\)/);
});

test("init settings: the merge-method change to rebase only passes in init's own words", () => {
  equal(
    namesRebaseOnly(
      'ruleset e2e-init-settings: turn off require branches to be up to date\nallow merge methods rebase only\nbranch protection on main: strict off\n',
    ),
    true,
  );
  equal(namesRebaseOnly('Merge methods: rebase only'), true);
});

test('init settings: output naming no merge-method change fails the rebase-only check', () => {
  equal(
    namesRebaseOnly(
      'ruleset e2e-init-settings: turn off require branches to be up to date\nbranch protection on main: strict off\n',
    ),
    false,
  );
  equal(namesRebaseOnly(''), false);
  equal(namesRebaseOnly('delete branch on merge: off'), false);
});
