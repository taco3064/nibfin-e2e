import { createGitHub } from '../../src/host/github.ts';
import type { ExecOptions, ExecResult, Stream } from '../../src/host/exec.ts';
import type { Kit } from '../../scenarios/lib/kit.ts';
import { FakeGitHub, cleanRepo, fakeExec } from '../host/fakes.ts';

export const EXEC = 'o/exec';
export const PEER = 'o/peer';
export const BASE_TREE = 'base-tree';

/** A `podman events` stand-in: `emit` sends a line to every open stream. */
export function fakeStream() {
  const open = new Set<{ argv: string[]; onLine: (l: string) => void; close: () => void }>();
  const argvs: string[][] = [];
  const stream: Stream = (argv, onLine) => {
    argvs.push(argv);
    let close = () => {};
    const closed = new Promise<number>((r) => (close = () => r(0)));
    const entry = { argv, onLine, close };
    open.add(entry);
    return {
      stop: () => {
        open.delete(entry);
        close();
      },
      closed,
    };
  };
  /** Streams whose filters select this repository and Issue. */
  const watching = (repo: string, issue: number) =>
    [...open].filter((e) => e.argv.includes(`label=io.github.taco3064.nibfin.repo=${repo}`) && e.argv.includes(`label=io.github.taco3064.nibfin.issue=${issue}`));
  return {
    stream,
    argvs,
    emit: (line: string) => [...open].forEach((e) => e.onLine(line)),
    emitFor: (repo: string, issue: number, line: string) => watching(repo, issue).forEach((e) => e.onLine(line)),
    watching,
    get open() {
      return open.size;
    },
  };
}

export const runner = (id: number, slot: string, extra: { status?: string; busy?: boolean } = {}) => ({ id, name: `myhost-1a2b3c4d-${slot}`, status: extra.status ?? 'online', busy: extra.busy ?? false });

/** Two clean sandboxes whose main is the baseline tree, two idle Runners, and a kit over them. */
export function setup(opts: { respond?: (argv: string[], o: ExecOptions) => Partial<ExecResult> | undefined; peerRulesets?: 'upgrade' } = {}) {
  const fake = new FakeGitHub();
  fake.trees.set(BASE_TREE, new Map([['README.md', { mode: '100644', content: 'sandbox\n' }], ['.github/workflows/nibfin-issue.yml', { mode: '100644', content: 'on: issues\n' }]]));
  for (const name of [EXEC, PEER]) {
    const repo = cleanRepo(name === EXEC ? 'public' : 'private', BASE_TREE);
    repo.commits.set('c0', { tree: BASE_TREE, parents: [] });
    fake.repos.set(name, repo);
  }
  const peer = fake.repos.get(PEER) as ReturnType<typeof cleanRepo>;
  if (opts.peerRulesets) peer.rulesets = opts.peerRulesets;
  const exec = fakeExec(opts.respond ?? (() => undefined));
  const events = fakeStream();
  const logs: string[] = [];
  let clock = 0;
  const kit: Kit = {
    github: createGitHub(() => 'tok', fake.fetch),
    exec: exec.exec,
    stream: events.stream,
    fetch: fake.fetch,
    sandbox: { execution: EXEC, peer: PEER },
    workDir: '/tmp/nibfin-e2e-test-work',
    env: { HOME: '/tmp/none' },
    log: (m) => logs.push(m),
    facts: (id) => (id === 'nibfin' ? { executionBaseline: { commit: 'c0', tree: BASE_TREE }, peerBaseline: { commit: 'c0', tree: BASE_TREE }, imageDigest: 'sha256:' + 'd'.repeat(64) } : undefined),
    secrets: () => ['sandbox-token-value', 'claude-token-value'],
    ghToken: () => 'sandbox-token-value',
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const repo = (name: string) => fake.repos.get(name) as ReturnType<typeof cleanRepo>;
  repo(EXEC).runners.push(runner(1, 'claude-1'), runner(2, 'claude-2'));
  return { fake, kit, calls: exec.calls, events, logs, repo };
}

/** main's files in the fake, by path. */
export function mainFiles(h: ReturnType<typeof setup>, name: string): Map<string, { mode: string; content: string }> | undefined {
  const r = h.repo(name);
  const tree = r.commits.get(r.branches.get('main') ?? '')?.tree ?? '';
  return h.fake.trees.get(tree);
}
