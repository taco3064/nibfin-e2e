import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loginVolume } from '../../scenarios/login-volume.ts';
import { missingApprovalLine, runObservedJob } from '../../scenarios/lib/observed.ts';
import type { ObservedFacts } from '../../scenarios/lib/observed.ts';
import { createGitHub } from '../../src/host/github.ts';
import type { RunContext } from '../../src/types.ts';
import { fakeHostContext } from '../host/fakes.ts';
import { EXEC, setup } from './kit.ts';

const DIGEST = 'sha256:' + 'd'.repeat(64);
const IMAGE = `ghcr.io/taco3064/nibfin@${DIGEST}`;
const TOKEN = 'claude-token-value';

const PROBE = [
  '```e2e-probe',
  'uid=1000',
  'auto_memory=1',
  'home=/home/nibfin',
  'claude_config_dir=unset',
  'ancestor=sh',
  'ancestor=claude',
  'ancestor=node',
  ...['CLAUDE.md', '.mcp.json', '.claude/skills/e2e-probe-skill/SKILL.md'].flatMap((f) => [
    `exists:${f}=yes`,
    `tracked:${f}=no`,
  ]),
  'workspace_settings=absent',
  'node=v22.15.0',
  'python=Python 3.13.7',
  'go=go version go1.24.2 linux/amd64',
  'first_instruction_line=# Shape',
  '```',
].join('\n');

const tick = () => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean) {
  for (let i = 0; i < 2000 && !cond(); i++) await tick();
  if (!cond()) throw new Error('the simulated step did not reach the expected point');
}

const MOUNTPOINT = '/home/u/.local/share/containers/storage/volumes/nibfin-home-claude/_data';
const HOME_MOUNT = {
  Type: 'volume',
  Name: 'nibfin-home-claude',
  Source: MOUNTPOINT,
  Destination: '/home/nibfin/.claude',
};
/** The login volume listing (`stat -c "%s %Y %n"` from its root) before the Jobs and after Shape. */
const BEFORE = '120 1000 ./settings.json\n0 1000 ./e2e-decoy-old\n';
const AFTER_SHAPE =
  '160 2000 ./settings.json\n0 2000 ./e2e-decoy-login\n0 1000 ./e2e-decoy-old\n4096 2001 ./projects/-workspace/s1.jsonl\n';

interface SimOptions {
  /** Mounts of every Job container (by container id), replacing the login volume mount. */
  mounts?: (id: string) => unknown[];
  volumeInspect?: { code: number; stdout?: string; stderr?: string };
}

/** Simulates Nibfin around runObservedJob: three stage containers, a branch, a PR and a review comment. */
async function simulate(probe = PROBE, opts: SimOptions = {}) {
  let settings: Record<string, unknown> = {
    env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
    enableAllProjectMcpServers: true,
    theme: 'dark',
  };
  let files = BEFORE;
  const h = setup({
    respond: (argv, o) => {
      const script = argv.at(-1) ?? '';
      if (script.startsWith('umask')) return ((settings = JSON.parse(o.input ?? '{}')), {});
      if (script.startsWith('stat')) return { stdout: `0 755\n0 600\n${JSON.stringify(settings)}` };
      if (script.startsWith('cd /v')) return { stdout: files };
      if (argv[1] === 'volume' && argv[2] === 'inspect')
        return (
          opts.volumeInspect ?? { stdout: JSON.stringify([{ Name: argv[3], Driver: 'local', Mountpoint: MOUNTPOINT }]) }
        );
      if (argv[1] === 'container' && argv[2] === 'inspect') {
        const id = argv[3] ?? '';
        const mounts = opts.mounts?.(id) ?? [
          HOME_MOUNT,
          { Type: 'bind', Source: '/runner/_work', Destination: '/workspace' },
        ];
        return {
          stdout: JSON.stringify([
            {
              ImageName: IMAGE,
              HostConfig: { Memory: 3e9, NanoCpus: 2e9, PidsLimit: 2048 },
              Config: { Env: [`NIBFIN_RUN_ID=${id.slice(1)}`, `NIBFIN_RUN_REPO=${EXEC}`] },
              Mounts: mounts,
            },
          ]),
        };
      }
      return undefined;
    },
  });
  const original = h.fake.fetch;
  h.kit.github = createGitHub(
    () => 'tok',
    async (input, init) => {
      const url = new URL(String(input));
      let m = /\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname);
      if (m)
        return new Response(
          JSON.stringify({
            total_count: 2,
            jobs: [
              { id: Number(m[1]) * 10, name: 'route', runner_name: 'GitHub Actions 3', status: 'completed' },
              { id: Number(m[1]), name: 'stage', runner_name: 'myhost-1a2b3c4d-claude-1', status: 'completed' },
            ],
          }),
        );
      m = /\/actions\/jobs\/(\d+)\/logs$/.exec(url.pathname);
      if (m) {
        return new Response(
          [
            `2026-11-26T00:00:00Z Nibfin image: ${IMAGE}`,
            '2026-11-26T00:00:01Z {"type":"system","subtype":"init","model":"claude-opus-4-5","mcp_servers":[{"name":"e2e-probe","status":"connected"}]}',
          ].join('\n'),
        );
      }
      return original(input, init);
    },
  );
  h.kit.workDir = mkdtempSync(join(tmpdir(), 'e2e-observed-'));
  const repo = h.repo(EXEC);
  const done = runObservedJob(h.kit);

  await until(() => repo.issues.length > 0 && h.events.open > 0);
  const issue = repo.issues[0] as (typeof repo.issues)[number];
  equal(settings.enableAllProjectMcpServers, undefined);
  h.events.emit('{"ID":"c1","Status":"start"}');
  await tick();
  issue.comments = [`## Shape\n\n${probe}\n`];
  settings = { ...settings, enableAllProjectMcpServers: true };
  files = AFTER_SHAPE;
  issue.labels = ['scope', 'shaped'];
  h.events.emit('{"ID":"c1","Status":"died"}');

  // The login volume is listed again once Shape ended (before the Jobs, then after Shape).
  await until(() => h.calls.filter((c) => c.argv.join(' ').includes('cd /v')).length >= 2);
  const branch = `nibfin/issue-${issue.number}`;
  repo.pulls.push({ number: 77, state: 'open', head: { sha: 'b1', ref: branch } });
  repo.issues.push({
    number: 77,
    node_id: 'PR77',
    state: 'open',
    comments: [
      'Shape review: the change matches the approved Shape.',
      'Waiting for an approving review from a collaborator before merging.',
    ],
  });
  h.events.emit('{"ID":"c2","Status":"start"}');
  h.events.emit('{"ID":"c2","Status":"died"}');
  h.events.emit('{"ID":"c3","Status":"start"}');
  h.events.emit('{"ID":"c3","Status":"died"}');
  return { h, out: await done, issue };
}

function ctxWith(facts: ObservedFacts): RunContext {
  return {
    ...fakeHostContext,
    target: { ghNibfinCommit: 'a'.repeat(40), platform: 'linux' },
    log: () => {},
    defer: () => {},
    upcoming: () => [],
    facts: (id) =>
      id === 'observed-job'
        ? (facts as unknown as Record<string, unknown>)
        : id === 'nibfin'
          ? { imageDigest: DIGEST }
          : undefined,
  };
}

test('observed-job runs one fixture through Shape, Deliver and Review and records only derived facts', async () => {
  const { h, out, issue } = await simulate();
  equal(out.status, 'passed', out.reason);
  const f = out.facts as unknown as ObservedFacts;
  equal(f.issue, issue.number);
  equal(f.projection?.imageName, IMAGE);
  deepEqual(f.jobImages, [IMAGE, IMAGE, IMAGE]);
  deepEqual(f.probe?.node, ['v22.15.0']);
  deepEqual(f.shapeLog?.slot, 'claude-1');
  deepEqual(f.loginAfter?.enableAllProjectMcpServers, true);
  deepEqual(f.finish, {
    merged: false,
    approvalComment: 'Waiting for an approving review from a collaborator before merging.',
  });
  equal(JSON.stringify(out).includes(TOKEN), false);
  // The fixture: tools, the extend Skill, probe, rulesync sources and decoys; the approval ruleset after the content.
  const w = h.fake.writes;
  ok(w.indexOf(`PATCH /repos/${EXEC}/git/refs/heads/main`) < w.indexOf(`POST /repos/${EXEC}/rulesets`));
  deepEqual([issue.state, issue.state_reason], ['closed', 'not_planned']);
  deepEqual(h.repo(EXEC).rulesets, []);
  equal(h.repo(EXEC).variableValues.get('NIBFIN_MODEL'), 'haiku');

  deepEqual(
    f.jobs?.map((j) => [j.stage, j.id, j.projection?.mounts[0]?.name]),
    [
      ['Shape', 'c1', 'nibfin-home-claude'],
      ['Deliver', 'c2', 'nibfin-home-claude'],
      ['Review', 'c3', 'nibfin-home-claude'],
    ],
  );
  deepEqual(f.loginVolume, { name: 'nibfin-home-claude', driver: 'local', mountpoint: MOUNTPOINT });
  equal(f.loginAfterJobs && 'hasToken' in f.loginAfterJobs && f.loginAfterJobs.hasToken, true);
  // The volume is listed after the login key is removed and before the fixture Issue is opened.
  const calls = h.calls.map((c) => c.argv.join(' '));
  ok(calls.findIndex((c) => c.includes('cd /v')) > calls.findIndex((c) => c.includes('umask')));
  ok(calls.filter((c) => c.includes('cd /v')).every((c) => c.includes('nibfin-home-claude:/v:ro')));

  const lv = await loginVolume.run(ctxWith(f));
  equal(lv.status, 'passed', lv.reason);
  match(
    lv.reason,
    /R6\.12: the CLI wrote its own files in its home during Shape \(settings\.json and decoys left out\) \(projects\/-workspace\/s1\.jsonl\)/,
  );
});

test('login-volume fails naming the Job container whose login mount differs, and a volume that cannot be read', async () => {
  const { out } = await simulate(PROBE, {
    mounts: (id) =>
      id === 'c2'
        ? [{ ...HOME_MOUNT, Name: 'other-volume', Source: '/vol/other' }]
        : id === 'c3'
          ? [{ ...HOME_MOUNT, Destination: '/root/.claude' }]
          : [HOME_MOUNT],
    volumeInspect: { code: 125, stderr: 'Error: no such volume nibfin-home-claude' },
  });
  equal(out.status, 'passed', 'the new reads do not fail the observed-job step');
  const r = await loginVolume.run(ctxWith(out.facts as unknown as ObservedFacts));
  equal(r.status, 'failed');
  match(
    r.reason,
    /R6\.12: nibfin-home-claude is a named Podman volume on the host \(observed: podman volume inspect nibfin-home-claude exited 125: Error: no such volume nibfin-home-claude\)/,
  );
  match(
    r.reason,
    /R6\.12: every Job container mounts nibfin-home-claude once at the CLI's home \(\/home\/nibfin\/\.claude\) \(observed: Deliver c2: other-volume:\/home\/nibfin\/\.claude; Review c3: nibfin-home-claude:\/root\/\.claude\)/,
  );
});

test('a Shape container that never starts fails the step naming the Issue state', async () => {
  const h = setup({
    respond: (argv) => (argv.at(-1)?.startsWith('stat') ? { stdout: '0 755\n0 600\n{}' } : undefined),
  });
  const original = h.fake.fetch;
  // The wait fails at once: the events stream ends.
  h.kit.stream = (argv, onLine) => {
    const s = h.events.stream(argv, onLine);
    s.stop();
    return s;
  };
  h.kit.github = createGitHub(() => 'tok', original);
  const out = await runObservedJob(h.kit);
  equal(out.status, 'failed');
  match(
    out.reason,
    /waiting for the Shape Job container of o\/exec#\d+ to start; o\/exec#\d+ labels \[scope\]; latest comment: none/,
  );
});

test('agent-written probe values reach the facts and the scenario reasons only redacted', async () => {
  const SANDBOX = 'sandbox-token-value';
  const leaky = PROBE.replace('workspace_settings=absent', `workspace_settings={"env":{"T":"${SANDBOX}"}}`)
    .replace('first_instruction_line=# Shape', `first_instruction_line=# Shape ${TOKEN}`)
    .replace('uid=1000', `uid=1000\n${TOKEN}=x`);
  const { out } = await simulate(leaky);
  equal(out.status, 'passed', out.reason);
  const stored = JSON.stringify(out.facts);
  ok(!stored.includes(SANDBOX) && !stored.includes(TOKEN), 'a secret value reached the observed-job facts');
  const f = out.facts as unknown as ObservedFacts;
  equal(f.probe?.workspace_settings?.[0], '{"env":{"T":"[secret value removed by nibfin-e2e]"}}');
  equal(f.probe?.first_instruction_line?.[0], '# Shape [secret value removed by nibfin-e2e]');
  const r = await loginVolume.run(ctxWith(f));
  ok(!r.reason.includes(SANDBOX) && !r.reason.includes(TOKEN), `${loginVolume.id} printed a secret value`);
});

test('only a Nibfin comment saying an approving review is missing counts', () => {
  const by = (login: string, body: string) => ({ body, user: { login } });
  equal(
    missingApprovalLine(
      [by('o', 'Review: looks good, merging next.'), by('someone', 'Waiting for approval before merging')],
      'o',
    ),
    undefined,
  );
  equal(
    missingApprovalLine([by('o', 'Deviation from the approved Shape: a test is required before merging.')], 'o'),
    undefined,
  );
  equal(
    missingApprovalLine([by('o', 'Shape review passed.\nMerge is blocked: waiting for 1 approving review.')], 'o'),
    'Merge is blocked: waiting for 1 approving review.',
  );
  equal(
    missingApprovalLine([by('o', 'Merge is blocked: waiting for 1 approving review (sandbox-token-value).')], 'o', [
      'sandbox-token-value',
    ]),
    'Merge is blocked: waiting for 1 approving review ([secret value removed by nibfin-e2e]).',
  );
});
