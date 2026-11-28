import { createHash } from 'node:crypto';
import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CASES, configRejections, names } from '../../scenarios/config-rejections.ts';
import { failureLogs } from '../../scenarios/failure-logs.ts';
import { hostMemoryCheck } from '../../scenarios/host-memory-check.ts';
import { imageProvenance } from '../../scenarios/image-provenance.ts';
import { OVERRIDE_MARKER } from '../../scenarios/lib/files.ts';
import { issueState } from '../../scenarios/lib/fixture.ts';
import { runFirstJob } from '../../scenarios/lib/single.ts';
import { modelChoice } from '../../scenarios/model-choice.ts';
import { skillLimits } from '../../scenarios/skill-limits.ts';
import { createGitHub } from '../../src/host/github.ts';
import { BASE_TREE, EXEC, PEER } from './kit.ts';
import { DIGEST, ctxFor, simulate } from './sim.ts';

const init = (model: string) =>
  `2026-11-26T00:00:01Z {"type":"system","subtype":"init","model":"${model}","mcp_servers":[]}`;
const ALL_NAMES = [...new Set(['.nibfin.json', ...CASES.flatMap((k) => k.names)])].join(', ');

test('config-rejections: every case passes when Nibfin rejects it with pending and a comment naming the item', async () => {
  const sim = simulate(() => ({
    labels: ['pending'],
    comments: [`CONFIG_INVALID: .nibfin.json is not valid: ${ALL_NAMES}. Fix it, then remove pending.`],
    log: '2026-11-26T00:00:00Z CONFIG_INVALID\n',
  }));
  const out = await configRejections(() => sim.kit).run(ctxFor());
  equal(out.status, 'passed', out.reason);
  const writes = sim.fake.writes.filter((w) => w === `POST /repos/${EXEC}/issues`);
  equal(writes.length, CASES.length);
  deepEqual(
    sim.repo(EXEC).issues.map((i) => i.state),
    CASES.map(() => 'closed'),
  );
});

test('config-rejections: items are matched as whole words', () => {
  equal(names('unknown skill "shap"; valid: accept, deliver, scope, shape', 'shap'), true);
  equal(names('valid: accept, deliver, scope, shape', 'shap'), false);
  equal(names('path ../outside.md is outside the workspace', '../outside.md'), true);
  equal(names('see .nibfin.json.bak', '.nibfin.json'), true);
});

test('config-rejections: a comment listing only the valid role names does not name the wrong one', async () => {
  let n = 0;
  const sim = simulate(() =>
    n++ === 1
      ? { labels: ['pending'], comments: ['.nibfin.json: valid skills are accept, deliver, scope, shape'] }
      : { labels: ['pending'], comments: [`.nibfin.json ${ALL_NAMES}`] },
  );
  const out = await configRejections(() => sim.kit).run(ctxFor());
  match(out.reason, /R7\.5: wrong role name: the comment names .* \(observed: missing shap\)/);
});

test('config-rejections: a case whose comment misses an item, or where an agent ran, fails naming the case', async () => {
  let n = 0;
  const sim = simulate(() => {
    const i = n++;
    if (i === 1) return { labels: ['pending'], comments: ['.nibfin.json: unknown skill shap'], log: '' };
    if (i === 5) return { labels: ['shaped'], comments: [`.nibfin.json ${ALL_NAMES}`], log: init('claude-opus-4-5') };
    return { labels: ['pending'], comments: [`.nibfin.json ${ALL_NAMES}`], log: '' };
  });
  const out = await configRejections(() => sim.kit).run(ctxFor());
  equal(out.status, 'failed');
  match(out.reason, /R7\.5: wrong role name: the comment names .* \(observed: missing accept, deliver, scope, shape\)/);
  match(out.reason, /R7\.4: removed allowedDomains: the Issue gets pending \(observed: scope, shaped\)/);
  match(out.reason, /R7\.4: removed allowedDomains: no agent ran \(observed: an agent ran\)/);
  equal(/R7\.10/.test(out.reason), false);
});

const caseIndex = (name: string) => CASES.findIndex((k) => k.name === name);
const R77 = CASES.flatMap((k, i) => (k.rule === 'R7.7' ? [i] : []));

test('config-rejections: an R7.7 case passes when its comment names only the rejected path, not .nibfin.json', async () => {
  equal(R77.length, 3);
  let n = 0;
  const sim = simulate(() => {
    const i = n++;
    if (R77.includes(i))
      return {
        labels: ['pending'],
        comments: [`CONFIG_INVALID: skill path ${CASES[i]?.names.join(', ')} was rejected.`],
        log: '2026-11-26T00:00:00Z CONFIG_INVALID\n',
      };
    return { labels: ['pending'], comments: [`.nibfin.json ${ALL_NAMES}`], log: '' };
  });
  const out = await configRejections(() => sim.kit).run(ctxFor());
  equal(out.status, 'passed', out.reason);
});

test('config-rejections: an R7.7 case whose comment names .nibfin.json but not its path fails naming the path', async () => {
  const target = caseIndex('path outside the workspace');
  let n = 0;
  const sim = simulate(() => {
    const i = n++;
    if (i === target)
      return { labels: ['pending'], comments: ['CONFIG_INVALID: .nibfin.json has an invalid skill path'], log: '' };
    return { labels: ['pending'], comments: [`.nibfin.json ${ALL_NAMES}`], log: '' };
  });
  const out = await configRejections(() => sim.kit).run(ctxFor());
  equal(out.status, 'failed');
  match(
    out.reason,
    /R7\.7: path outside the workspace: the comment names \.\.\/outside\.md \(observed: missing \.\.\/outside\.md\)/,
  );
  equal(/R7\.7: (symlink escape|missing file)/.test(out.reason), false);
});

test('config-rejections: a non-R7.7 case whose comment lacks .nibfin.json still fails', async () => {
  const syntax = caseIndex('JSON syntax error');
  const domains = caseIndex('removed allowedDomains');
  let n = 0;
  const sim = simulate(() => {
    const i = n++;
    if (i === syntax)
      return { labels: ['pending'], comments: ['CONFIG_INVALID: unexpected end of JSON input'], log: '' };
    if (i === domains)
      return { labels: ['pending'], comments: ['CONFIG_INVALID: allowedDomains was removed'], log: '' };
    return { labels: ['pending'], comments: [`.nibfin.json ${ALL_NAMES}`], log: '' };
  });
  const out = await configRejections(() => sim.kit).run(ctxFor());
  equal(out.status, 'failed');
  match(out.reason, /R7\.2: JSON syntax error: the comment names \.nibfin\.json \(observed: missing \.nibfin\.json\)/);
  match(
    out.reason,
    /R7\.4: removed allowedDomains: the comment names \.nibfin\.json, allowedDomains \(observed: missing \.nibfin\.json\)/,
  );
});

const failureLog = (n: number, extra = '') =>
  [
    `2026-11-26T00:00:00Z Nibfin image: ghcr.io/taco3064/nibfin@${DIGEST}`,
    `2026-11-26T00:00:01Z Issue o/exec #${n}: preparing tools`,
    '2026-11-26T00:00:02Z error: No download found for request: cpython-3.99.99-linux-x86_64-gnu',
    `2026-11-26T00:00:03Z TOOL_INSTALL_FAILED: uv python install 3.99.99 exited 2${extra}`,
  ].join('\n');

test('failure-logs: passes on a shared tool cause code, uv output, clear non-secrets and a next step', async () => {
  const sim = simulate((_r, n) => ({
    labels: ['pending'],
    comments: [
      'TOOL_INSTALL_FAILED: python 3.99.99 could not be installed. Fix `.nibfin.json`, then remove `pending`.',
    ],
    log: failureLog(n),
  }));
  sim.kit.workDir = mkdtempSync(join(tmpdir(), 'e2e-failure-logs-'));
  const out = await failureLogs(() => sim.kit).run(ctxFor());
  equal(out.status, 'passed', out.reason);
});

test('failure-logs: a token in the log fails without being printed or saved', async () => {
  const sim = simulate((_r, n) => ({
    labels: ['pending'],
    comments: ['TOOL_INSTALL_FAILED: remove `pending` to retry'],
    log: failureLog(n, ' token claude-token-value'),
  }));
  sim.kit.workDir = mkdtempSync(join(tmpdir(), 'e2e-failure-logs-'));
  const out = await failureLogs(() => sim.kit).run(ctxFor());
  equal(out.status, 'failed');
  match(out.reason, /R1\.14: no credential appears in the log or the comment \(observed: found\)/);
  equal(out.reason.includes('claude-token-value'), false);
  const dir = join(sim.kit.workDir, 'logs');
  for (const f of readdirSync(dir)) equal(readFileSync(join(dir, f), 'utf8').includes('claude-token-value'), false);
});

test('failure-logs: a token in the comment fails and is removed from every printed detail', async () => {
  // No next step, so that check fails and prints the comment excerpt as its detail.
  const comment = 'TOOL_INSTALL_FAILED: python 3.99.99 with token sandbox-token-value';
  const sim = simulate((_r, n) => ({ labels: ['pending'], comments: [comment], log: failureLog(n, '') }));
  sim.kit.workDir = mkdtempSync(join(tmpdir(), 'e2e-failure-logs-'));
  const out = await failureLogs(() => sim.kit).run(ctxFor());
  equal(out.status, 'failed');
  match(out.reason, /R1\.14: no credential appears in the log or the comment \(observed: found\)/);
  equal(out.reason.includes('sandbox-token-value'), false);
  match(
    out.reason,
    /R1\.14: the comment names the next step \(observed: TOOL_INSTALL_FAILED: python 3\.99\.99 with token \[secret value removed by nibfin-e2e\]\)/,
  );
  const n = sim.repo(EXEC).issues[0]?.number as number;
  const state = await issueState(sim.kit, EXEC, n);
  match(state, /latest comment: TOOL_INSTALL_FAILED/);
  equal(state.includes('sandbox-token-value'), false);
});

test('host-memory-check: a token in the comment is not printed in the passed result', async () => {
  const sim = simulate(() => ({
    memory: 0,
    labels: ['pending'],
    comments: ['HOST_MEMORY_INSUFFICIENT: 1024g memory needed; claude-token-value; remove pending.'],
    log: 'checking memory\n',
  }));
  const out = await hostMemoryCheck(() => sim.kit).run(ctxFor());
  equal(out.status, 'passed', out.reason);
  equal(out.reason.includes('claude-token-value'), false);
  match(out.reason, /HOST_MEMORY_INSUFFICIENT: 1024g memory needed; \[secret value removed by nibfin-e2e\]/);
});

test('host-memory-check: limits off, pending and a memory comment pass; an agent run fails', async () => {
  const good = simulate(() => ({
    memory: 0,
    labels: ['pending'],
    comments: [
      'HOST_MEMORY_INSUFFICIENT: the host has 7 GiB free memory, 1024g is needed. Free memory, then remove pending.',
    ],
    log: 'checking memory\n',
  }));
  const out = await hostMemoryCheck(() => good.kit).run(ctxFor());
  equal(out.status, 'passed', out.reason);
  deepEqual(good.repo(EXEC).variables.sort(), ['NIBFIN_CONTAINER_LIMITS', 'NIBFIN_MEMORY']);

  const bad = simulate(() => ({ memory: 3e9, labels: ['shaped'], comments: [], log: init('claude-opus-4-5') }));
  const failed = await hostMemoryCheck(() => bad.kit).run(ctxFor());
  equal(failed.status, 'failed');
  match(failed.reason, /R6\.3: with limits off the container has no memory or CPU limit/);
  match(failed.reason, /R6\.3: the Issue gets pending/);
  match(failed.reason, /R6\.3: no agent ran/);
});

const observed = (finish: unknown) => ({ 'observed-job': { repo: EXEC, finish } });

test('skill-limits: passes when the agent changed nothing and the approval gate held', async () => {
  const sim = simulate(() => ({ labels: ['pending'], comments: ['WORKSPACE_READ_ONLY'] }));
  const out = await skillLimits(() => sim.kit).run(
    ctxFor(observed({ merged: false, approvalComment: 'Waiting for an approving review before merging.' })),
  );
  equal(out.status, 'passed', out.reason);
  ok(sim.repo(EXEC).issues[0]?.labels?.includes('pause'));
});

test('skill-limits: a moved main or a merged PR fails', async () => {
  const sim = simulate(() => ({
    during: () => {
      const r = sim.repo(EXEC);
      r.commits.set('evil', { tree: BASE_TREE, parents: [r.branches.get('main') ?? ''] });
      r.branches.set('main', 'evil');
    },
  }));
  const out = await skillLimits(() => sim.kit).run(ctxFor(observed({ merged: true })));
  equal(out.status, 'failed');
  match(out.reason, /R7\.8: the Shape Skill text could not change main/);
  match(out.reason, /R7\.8: the PR was not merged while one approving review was required \(observed: merged\)/);
  match(out.reason, /R7\.8: Nibfin commented that a review is missing \(observed: no comment\)/);
});

const probe = (...lines: string[]) => '```e2e-probe\n' + lines.join('\n') + '\n```';
const DEFAULT_PROBE = probe('marker=e2e-override-299', 'first_instruction_line=' + OVERRIDE_MARKER);

/**
 * `execComments`: the execution fixture's comments at publish time. `later`: runs on the first
 * job-log fetch of each repo, which comes after runFirstJob captured what it saw at shaped.
 */
function modelSim(
  opts: {
    sameRunner?: boolean;
    failRestore?: boolean;
    peerLabels?: string[];
    execComments?: string[];
    later?: (repo: string) => void;
  } = {},
) {
  const data = mkdtempSync(join(tmpdir(), 'e2e-model-'));
  const dir = join(data, 'nibfin', 'runners', 'claude-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env'), 'LANG=C.UTF-8\n');
  let restarts = 0;
  const envAtStart: string[] = [];
  /** Each fixture's labels while its Shape Job runs, before it publishes. */
  const labelsDuringShape = new Map<string, string[]>();
  const during = (repo: string) => () => labelsDuringShape.set(repo, [...(sim.repo(repo).issues[0]?.labels ?? [])]);
  const sim = simulate(
    (repo) =>
      repo === EXEC
        ? {
            runner: 'myhost-1a2b3c4d-claude-1',
            log: init('claude-sonnet-4-5'),
            comments: opts.execComments ?? [DEFAULT_PROBE],
            labels: ['shaped'],
            during: during(repo),
          }
        : {
            runner: `myhost-1a2b3c4d-claude-${opts.sameRunner ? 1 : 2}`,
            log: init('claude-opus-4-5'),
            labels: opts.peerLabels ?? ['shaped'],
            during: during(repo),
          },
    {
      respond: (argv) => {
        if (argv[0] !== 'systemctl') return undefined;
        envAtStart.push(readFileSync(join(dir, '.env'), 'utf8'));
        return ++restarts === 2 && opts.failRestore ? { code: 1, stderr: 'Unit not found' } : {};
      },
    },
  );
  sim.kit.env = { XDG_DATA_HOME: data };
  if (opts.later) {
    const later = opts.later;
    const inner = sim.kit.fetch;
    const done = new Set<string>();
    const wrapped: typeof fetch = async (input, init) => {
      const m = /\/actions\/jobs\/(\d+)\/logs$/.exec(new URL(String(input)).pathname);
      const repo = m ? sim.runs.get(m[1] as string)?.repo : undefined;
      if (repo && !done.has(repo)) {
        done.add(repo);
        later(repo);
      }
      return inner(input, init);
    };
    sim.kit.fetch = wrapped;
    sim.kit.github = createGitHub(() => 'tok', wrapped);
  }
  return { sim, envFile: join(dir, '.env'), envAtStart, labelsDuringShape };
}

test('model-choice: the Runner .env model applies to that Runner only, the default is Opus, and the Runner is restored', async () => {
  const { sim, envFile, envAtStart, labelsDuringShape } = modelSim();
  const out = await modelChoice(() => sim.kit).run(ctxFor());
  equal(out.status, 'passed', out.reason);
  // No pause while the Shape can still read it; pause only after the Shape was published.
  deepEqual([labelsDuringShape.get(EXEC), labelsDuringShape.get(PEER)], [['scope'], ['scope']]);
  deepEqual(envAtStart, ['LANG=C.UTF-8\nNIBFIN_MODEL=sonnet\n', 'LANG=C.UTF-8\n']);
  equal(readFileSync(envFile, 'utf8'), 'LANG=C.UTF-8\n');
  equal(sim.repo(EXEC).variableValues.get('NIBFIN_MODEL'), 'haiku');
  equal(sim.repo(PEER).variableValues.get('NIBFIN_MODEL'), 'haiku');
  for (const r of [EXEC, PEER]) {
    const issue = sim.repo(r).issues[0];
    deepEqual([issue?.state, issue?.labels?.includes('pause')], ['closed', true]);
  }
  ok(sim.calls.some((c) => c.argv.join(' ') === 'systemctl --user restart nibfin-runner-claude-1.service'));
});

test('model-choice: with no marked Shape comment, R7.6 falls back to the latest probe comment and says so', async () => {
  const { sim } = modelSim();
  const out = await modelChoice(() => sim.kit).run(ctxFor());
  equal(out.status, 'passed', out.reason);
  match(
    out.reason,
    /R7\.6: [^;]*\(no Shape comment; fallback: comment #1 of 1, the latest with an e2e-probe block: first_instruction_line is the override marker\)/,
  );
  match(
    out.reason,
    /R7\.2: [^(]*\(log read; labels when shaped was observed: scope, shaped; labels now: scope, shaped, pause\)/,
  );
});

test('model-choice: R7.2 holds when the peer showed shaped at the wait and lost it before the check', async () => {
  const { sim } = modelSim({
    later: (repo) => {
      const issue = sim.repo(repo).issues[0];
      if (repo === PEER && issue) issue.labels = (issue.labels ?? []).filter((l) => l !== 'shaped');
    },
  });
  const out = await modelChoice(() => sim.kit).run(ctxFor());
  equal(out.status, 'passed', out.reason);
  match(
    out.reason,
    /R7\.2: [^(]*\(log read; labels when shaped was observed: scope, shaped; labels now: scope, pause\)/,
  );
});

const SHAPE = (p: string) => `<!-- nibfin:shape -->\n## Goal\n\n${p}`;

test('model-choice: R7.6 reads the Shape comment captured at shaped, not a later probe comment', async () => {
  const { sim } = modelSim({
    execComments: ['an earlier note', SHAPE(DEFAULT_PROBE)],
    later: (repo) => {
      if (repo === EXEC)
        sim
          .repo(repo)
          .issues[0]?.comments?.push(
            probe('first_instruction_line=other'),
            SHAPE(probe('first_instruction_line=later')),
          );
    },
  });
  const out = await modelChoice(() => sim.kit).run(ctxFor());
  equal(out.status, 'passed', out.reason);
  match(out.reason, /R7\.6: [^;]*\(the Shape comment: first_instruction_line is the override marker\)/);
  equal(sim.repo(EXEC).issues[0]?.comments?.length, 4);
});

for (const [name, execComments, expected] of [
  [
    'no Shape comment and no probe',
    ['just text'],
    /R7\.6: [^;]*\(observed: no Shape comment and no comment with an e2e-probe block \(1 comments\)\)/,
  ],
  [
    'a Shape comment without a probe block',
    [DEFAULT_PROBE, SHAPE('no probe here')],
    /R7\.6: [^;]*\(observed: the Shape comment has no e2e-probe block\)/,
  ],
  [
    'a probe without first_instruction_line',
    [SHAPE(probe('marker=e2e-override-299', 'uid=1000', 'marker=again'))],
    /R7\.6: [^;]*\(observed: the e2e-probe block in the Shape comment has no first_instruction_line; its keys: marker, uid\)/,
  ],
  [
    'a probe without first_instruction_line in the fallback',
    [probe('uid=1000')],
    /R7\.6: [^;]*\(observed: the e2e-probe block in no Shape comment; fallback: comment #1 of 1, the latest with an e2e-probe block has no first_instruction_line; its keys: uid\)/,
  ],
] as const) {
  test(`model-choice: R7.6 fails naming the case: ${name}`, async () => {
    const { sim } = modelSim({ execComments: [...execComments] });
    const out = await modelChoice(() => sim.kit).run(ctxFor());
    equal(out.status, 'failed');
    match(out.reason, expected);
    equal(/R7\.2|R6\.2[678]/.test(out.reason), false, out.reason);
  });
}

test('model-choice: R7.6 quotes a wrong first line up to its bound, with secrets removed', async () => {
  const secret = 'sandbox-token-value';
  const long = `You are ${secret} ${'x'.repeat(300)}`;
  const { sim } = modelSim({ execComments: [SHAPE(probe('first_instruction_line=' + long))] });
  const out = await modelChoice(() => sim.kit).run(ctxFor());
  equal(out.status, 'failed');
  const m = /first_instruction_line in the Shape comment is "([^"]*)"/.exec(out.reason);
  ok(m, out.reason);
  equal((m[1] ?? '').length, 120);
  equal(out.reason.includes(secret), false);
  match(m[1] ?? '', /^You are \[secret value removed by nibfin-e2e\] x+$/);
});

test('model-choice: both Jobs on one Runner fail saying so, and the Runner is still restored', async () => {
  const { sim, envFile } = modelSim({ sameRunner: true });
  const out = await modelChoice(() => sim.kit).run(ctxFor());
  equal(out.status, 'failed');
  match(out.reason, /both Jobs landed on one Runner \(claude-1\)/);
  equal(readFileSync(envFile, 'utf8'), 'LANG=C.UTF-8\n');
});

test('model-choice: a Shape Job that ends without shaped fails fast naming it, and the Runner is still restored', async () => {
  const { sim, envFile } = modelSim({ peerLabels: [] });
  const out = await modelChoice(() => sim.kit).run(ctxFor());
  equal(out.status, 'failed');
  match(
    out.reason,
    /the Shape Job of o\/peer#\d+ ended and no shaped followed within 300 s; o\/peer#\d+ labels \[scope\]; latest comment: none/,
  );
  equal(/timed out/.test(out.reason), false);
  equal(readFileSync(envFile, 'utf8'), 'LANG=C.UTF-8\n');
  equal(sim.repo(PEER).issues[0]?.labels?.includes('pause'), false);
  for (const r of [EXEC, PEER]) equal(sim.repo(r).issues[0]?.state, 'closed');
});

test('model-choice: a Shape that ends with pending fails at once naming it', async () => {
  const { sim, envFile } = modelSim({ peerLabels: ['pending'] });
  const out = await modelChoice(() => sim.kit).run(ctxFor());
  equal(out.status, 'failed');
  match(out.reason, /the Shape of o\/peer#\d+ ended with pending; o\/peer#\d+ labels \[scope, pending\]/);
  equal(readFileSync(envFile, 'utf8'), 'LANG=C.UTF-8\n');
  for (const r of [EXEC, PEER]) equal(sim.repo(r).issues[0]?.state, 'closed');
});

test('model-choice: a failed restore fails the scenario', async () => {
  const { sim } = modelSim({ failRestore: true });
  const out = await modelChoice(() => sim.kit).run(ctxFor());
  equal(out.status, 'failed');
  match(
    out.reason,
    /restoring Runner claude-1 failed: restarting nibfin-runner-claude-1\.service exited 1: Unit not found/,
  );
});

function registry(index: unknown, attestations: unknown[], verify = 0) {
  const bytes = Buffer.from(JSON.stringify(index));
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const sim = simulate(() => ({}), {
    respond: (argv) =>
      argv[0] === 'gh' ? { code: verify, stderr: verify ? 'no matching attestation' : '' } : undefined,
  });
  sim.kit.workDir = mkdtempSync(join(tmpdir(), 'e2e-image-'));
  const auth: (string | null)[] = [];
  sim.kit.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/token') return new Response(JSON.stringify({ token: 'anon' }));
    if (url.pathname === `/v2/taco3064/nibfin/manifests/${digest}`)
      return (auth.push(new Headers(init?.headers).get('authorization')), new Response(bytes));
    return new Response('{}', { status: 404 });
  };
  sim.kit.github = createGitHub(
    () => 'tok',
    async (input) =>
      new URL(String(input)).pathname === `/repos/taco3064/nibfin-core/attestations/${digest}`
        ? new Response(JSON.stringify({ attestations }))
        : new Response('{"message":"Not Found"}', { status: 404 }),
  );
  return { sim, digest, auth };
}

const statement = Buffer.from(JSON.stringify({ predicateType: 'https://slsa.dev/provenance/v1' })).toString('base64');
const multiArch = {
  mediaType: 'application/vnd.oci.image.index.v1+json',
  manifests: [
    { platform: { os: 'linux', architecture: 'amd64' } },
    { platform: { os: 'linux', architecture: 'arm64' } },
    { platform: { os: 'unknown', architecture: 'unknown' } },
  ],
};

test('image-provenance: a multi-arch index with a verified attestation passes; gh gets the sandbox token only as GH_TOKEN', async () => {
  const { sim, digest, auth } = registry(multiArch, [{ bundle: { dsseEnvelope: { payload: statement } } }]);
  const out = await imageProvenance(() => sim.kit).run(ctxFor({ nibfin: { imageDigest: digest } }));
  equal(out.status, 'passed', out.reason);
  deepEqual(auth, ['Bearer anon']);
  const gh = sim.calls.find((c) => c.argv[0] === 'gh');
  deepEqual(gh?.argv.slice(1, 3), ['attestation', 'verify']);
  deepEqual(gh?.argv.slice(-4), [
    '--repo',
    'taco3064/nibfin-core',
    '--predicate-type',
    'https://slsa.dev/provenance/v1',
  ]);
  equal(gh?.options.ghToken, 'sandbox-token-value');
  equal(gh?.argv.includes('sandbox-token-value'), false);
});

test('image-provenance: a single-arch image, no attestation or a failed verify fails', async () => {
  const single = registry({ ...multiArch, manifests: [multiArch.manifests[0]] }, []);
  const out = await imageProvenance(() => single.sim.kit).run(ctxFor({ nibfin: { imageDigest: single.digest } }));
  equal(out.status, 'failed');
  match(out.reason, /R8\.1: the image is an index with linux\/amd64 and linux\/arm64 \(observed: .*linux\/amd64\)/);
  match(out.reason, /R8\.1: nibfin-core lists an attestation for the digest \(observed: 0 attestation/);
  const unverified = registry(multiArch, [{ bundle: { dsseEnvelope: { payload: statement } } }], 1);
  const r = await imageProvenance(() => unverified.sim.kit).run(ctxFor({ nibfin: { imageDigest: unverified.digest } }));
  match(r.reason, /gh attestation verify accepts the index .*no matching attestation/);
});

test('runFirstJob: pauseWhenShaped returns the labels and comments seen at shaped; without it shaped stays undefined', async () => {
  const sim = simulate(() => ({ labels: ['shaped'], comments: ['published'] }));
  const job = await runFirstJob(sim.kit, EXEC, {
    title: 't',
    file: 'f',
    deadlineMs: 60_000,
    stage: 'Shape',
    pauseWhenShaped: true,
  });
  deepEqual(job.shaped?.labels, ['scope', 'shaped']);
  deepEqual(
    job.shaped?.comments?.map((x) => x.body),
    ['published'],
  );
  equal(job.shaped?.commentsError, undefined);
  equal(typeof job.shaped?.at, 'number');
  const plain = await runFirstJob(sim.kit, PEER, { title: 't', file: 'f', deadlineMs: 60_000, stage: 'Shape' });
  equal(plain.shaped, undefined);
});

test('runFirstJob: pause and pauseWhenShaped cannot be combined, and nothing is opened', async () => {
  const sim = simulate(() => ({}));
  await rejects(
    runFirstJob(sim.kit, EXEC, {
      title: 't',
      file: 'f',
      deadlineMs: 1000,
      stage: 'Shape',
      pause: true,
      pauseWhenShaped: true,
    }),
    /pause and pauseWhenShaped cannot be combined/,
  );
  equal(sim.repo(EXEC).issues.length, 0);
});
