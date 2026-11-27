import { deepEqual, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { flagDiff, normalDefault } from '../../scenarios/management/dashboard.ts';
import { releaseSteps } from '../../scenarios/management/image-release.ts';
import { checkInitFiles } from '../../scenarios/management/init-files.ts';
import { newEnabledUnits, wslconfigChanges } from '../../scenarios/management/runner-add-setup.ts';
import { newCronEntries, newTimerUnits, newTimers, newVmUnits, periodicTriggers } from '../../scenarios/management/runner-no-periodic.ts';
import { changedKeys, withoutProvider } from '../../scenarios/management/upgrade.ts';
import { poolLines } from '../../scenarios/management/wording.ts';
import { Check } from '../../scenarios/lib/check.ts';

const D = 'sha256:' + 'a'.repeat(64);
const wf = (name: string, extra = '') => `name: Nibfin · ${name}\nrun-name: Nibfin · \${{ inputs.issue }}\non: issues\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: podman run ghcr.io/taco3064/nibfin@${D}\n${extra}`;
const shared = wf('Shared', '  k:\n    runs-on: [self-hosted, nibfin-1]\n');

test('init files: exactly the Issue sets pass', () => {
  const c = new Check();
  checkInitFiles(c, 'o/exec', 'execution', [
    { path: '.github/workflows/nibfin-issue.yml', text: wf('Issue') },
    { path: '.github/workflows/nibfin-shared-runner.yml', text: shared },
  ], D);
  checkInitFiles(c, 'o/peer', 'peer', [{ path: '.github/workflows/nibfin-issue.yml', text: wf('Issue') }], D);
  deepEqual(c.problems, []);
});

test('init files: extra files, other digests, Owner calls and bad names are each reported', () => {
  const c = new Check();
  checkInitFiles(c, 'o/exec', 'execution', [
    { path: '.github/workflows/nibfin-issue.yml', text: wf('Issue', '      - uses: taco3064/nibfin-core/.github/workflows/x.yml@main\n') },
    { path: '.github/workflows/nibfin-shared-runner.yml', text: shared.replace(D, 'sha256:' + 'b'.repeat(64)) },
    { path: '.github/workflows/nibfin-job.yml', text: wf('Job') },
    { path: '.github/workflows/nibfin-runner-request.yml', text: 'name: Runner request\non: issues\n' },
    { path: '.github/producer-pins.json', text: '{}' },
  ], D);
  const all = c.problems.join('\n');
  match(all, /R5.3: o\/exec init PR adds .github\/workflows\/nibfin-job.yml/);
  match(all, /R5.3: o\/exec init PR adds .github\/workflows\/nibfin-runner-request.yml/);
  match(all, /R5.4: o\/exec init PR adds .github\/producer-pins.json/);
  match(all, /R5.5: o\/exec: .github\/producer-pins.json is not named/);
  match(all, /R5.5: o\/exec: .github\/workflows\/nibfin-runner-request.yml name is "Runner request"/);
  match(all, /R5.5: o\/exec: .github\/workflows\/nibfin-runner-request.yml run-name is null/);
  match(all, /R5.7: o\/exec: .github\/workflows\/nibfin-issue.yml uses taco3064\/nibfin-core/);
  match(all, /R5.7: .*nibfin-shared-runner.yml references ghcr.io\/taco3064\/nibfin@sha256:b+, expected/);
  const peer = new Check();
  checkInitFiles(peer, 'o/peer', 'peer', [
    { path: '.github/workflows/nibfin-issue.yml', text: wf('Issue') },
    { path: '.github/workflows/nibfin-shared-runner.yml', text: shared },
  ], D);
  match(peer.problems.join('\n'), /R5.37: o\/peer init PR has nibfin-shared-runner.yml, so it is not the peer version/);
});

test('Dashboard flags compare by name and by the default cobra prints', () => {
  const help = 'Flags:\n      --count int   n (default 2)\n  -h, --help    help\n      --yes     y\n';
  deepEqual(flagDiff(help, { path: 'runner add', flags: [{ name: 'count', default: 2 }, { name: 'yes', default: false }] }), []);
  deepEqual(flagDiff(help, { path: 'runner add', flags: [{ name: 'count', default: '3' }, { name: 'yes' }] }), ['--count default is "2" in --help and "3" in /api/commands']);
  match(flagDiff(help, { path: 'runner add', flags: [{ name: 'count', default: 2 }] }).join(), /flags in --help \[count, yes\] differ from \/api\/commands \[count\]/);
  deepEqual([normalDefault(false), normalDefault(0), normalDefault(''), normalDefault('x'), normalDefault(['a'])], ['', '', '', 'x', '[a]']);
});

test('release publishing in CI is found; release downloads are not', () => {
  deepEqual(releaseSteps('run: gh release create v1\nuses: softprops/action-gh-release@v2\ncurl https://github.com/a/b/releases/download/v1/x\n'), [
    'run: gh release create v1',
    'uses: softprops/action-gh-release@v2',
  ]);
  deepEqual(releaseSteps('run: go build ./...\n'), []);
  deepEqual(releaseSteps('run: gh api repos/o/r/releases -f tag=v1'), ['run: gh api repos/o/r/releases -f tag=v1']);
});

test('host diffs: new enabled units and changed .wslconfig keys', () => {
  const before = { platform: 'linux' as const, units: [{ name: 'a.service', state: 'enabled' }], linger: 'no', systemFiles: [], readAt: 0, pathDirs: [] };
  const now = { ...before, units: [...before.units, { name: 'n-1.service', state: 'enabled' }, { name: 'x.service', state: 'disabled' }] };
  deepEqual(newEnabledUnits(before, now), ['n-1.service']);
  // An image that already enables a global user unit before runner add (read without a manager): it is not new.
  const image = { ...before, units: [{ name: 'gpg-agent.socket', state: 'enabled' }, { name: 'late.service', state: 'disabled' }] };
  const after = { ...image, units: [{ name: 'gpg-agent.socket', state: 'enabled' }, { name: 'late.service', state: 'enabled' }, { name: 'n-1.service', state: 'enabled' }] };
  deepEqual(newEnabledUnits(image, after), ['late.service', 'n-1.service']);
  const w = wslconfigChanges('[wsl2]\nnestedVirtualization=true\nmemory=4GB\n', '[wsl2]\nnestedVirtualization=true\nvmIdleTimeout=-1\n');
  deepEqual([w.changed, w.added, w.now.wsl2?.vmidletimeout], [['[wsl2] memory'], ['[wsl2] vmidletimeout'], '-1']);
});

test('host diffs: a .wslconfig that differs only in formatting is unchanged (Proposal R5.16)', () => {
  const kept = wslconfigChanges('[wsl2]\nnestedVirtualization=true\nvmIdleTimeout=-1\n', '\r\n[WSL2]\r\n  vmidletimeout = -1 \r\n# note\r\nNestedVirtualization=true\r\n');
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
  deepEqual(poolLines('Add Runners\nmanage the Pool\npools of runners\nspool file\n'), ['manage the Pool', 'pools of runners']);
});

// ---- runner-no-periodic (Proposal R5.17) ----------------------------------------

const u = (name: string, state = 'enabled') => ({ name, state });

test('newTimerUnits: new .timer unit files in any state; other new units and old timers are not counted', () => {
  deepEqual(newTimerUnits([u('a.timer', 'static'), u('x.service')], [u('a.timer', 'enabled'), u('b.timer', 'disabled'), u('nibfin-1.service'), u('x.service')]), [u('b.timer', 'disabled')]);
});

test('newTimers: a transient timer is new; an image timer only loaded later is not', () => {
  deepEqual(newTimers({ timers: [], units: [u('logrotate.timer', 'static')] }, ['logrotate.timer', 'run-u7.timer']), ['run-u7.timer']);
  deepEqual(newTimers({ timers: ['run-u1.timer'], units: [] }, ['run-u1.timer']), []);
});

test('newCronEntries: all four availability transitions', () => {
  deepEqual(newCronEntries({ available: true, entries: ['@daily a'] }, { available: true, entries: ['@daily a', '*/5 * * * * b'] }).problems, ['the crontab gained the entry "*/5 * * * * b"']);
  const absent = newCronEntries({ available: false, evidence: 'e1' }, { available: false, evidence: 'e2' });
  deepEqual(absent, { problems: [], evidence: 'cron not installed before (e1) or after (e2)' });
  match(newCronEntries({ available: false, evidence: 'e1' }, { available: true, entries: ['@hourly c'] }).problems.join(), /cron was not installed before runner add \(e1\) and is now, with the entries \["@hourly c"\]/);
  match(newCronEntries({ available: true, entries: [] }, { available: false, evidence: 'e2' }).problems.join(), /readable before runner add but cron now reads as not installed \(e2\); the reads disagree/);
});

test('newVmUnits: the units runner add added in the VM; none is the positive-control failure', () => {
  deepEqual(newVmUnits([u('a.service')], [u('a.service'), u('nibfin-runner-1.service')]), ['nibfin-runner-1.service']);
  deepEqual(newVmUnits([u('a.service')], [u('a.service')]), []);
});

test('periodicTriggers: logon and event triggers without repetition pass; time, daily, idle, unknown and repeating ones are flagged', () => {
  const t = (triggers: string[], repetitions = triggers.map(() => '')) => periodicTriggers({ actions: [], triggers, repetitions });
  deepEqual(t(['MSFT_TaskLogonTrigger', 'MSFT_TaskEventTrigger'], ['', 'PT0S']), []);
  for (const k of ['MSFT_TaskTimeTrigger', 'MSFT_TaskDailyTrigger', 'MSFT_TaskIdleTrigger', 'MSFT_TaskSomethingNew']) {
    deepEqual(t([k]), [`trigger ${k} is neither a logon nor an event trigger`]);
  }
  deepEqual(t(['MSFT_TaskLogonTrigger'], ['PT5M']), ['trigger MSFT_TaskLogonTrigger repeats every PT5M']);
  match(t(['MSFT_TaskLogonTrigger'], []).join(), /trigger repetitions could not be read \(0 for 1 triggers\)/);
});
