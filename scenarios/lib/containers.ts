import { abortError } from '../../src/abort.ts';
import type { Exec } from '../../src/host/exec.ts';
import type { Kit } from './kit.ts';

/** The Podman labels the generated workflow puts on every Job container (Proposal R9.23). */
export const LABEL_REPO = 'io.github.taco3064.nibfin.repo';
export const LABEL_ISSUE = 'io.github.taco3064.nibfin.issue';

export interface ContainerEvent {
  kind: 'start' | 'died';
  id: string;
}

/**
 * What the harness keeps of `podman container inspect`: an allowlisted projection only.
 * The raw JSON holds the Nibfin token in the container environment, so it is dropped.
 */
export interface Projection {
  imageName: string;
  memory: number;
  nanoCpus: number;
  cpuQuota: number;
  pidsLimit: number;
  mounts: { source: string; destination: string }[];
  runId?: string;
  runRepo?: string;
}

/** Parses one `podman events --format json` line; other event kinds give undefined. */
export function parseEvent(line: string): ContainerEvent | undefined {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const status = String(e.Status ?? e.status ?? '');
  const id = String(e.ID ?? e.id ?? '');
  if (!id || (status !== 'start' && status !== 'died')) return undefined;
  return { kind: status, id };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Projects one inspect document; every environment value except the two run ids is dropped. */
export function project(raw: unknown): Projection | undefined {
  const c = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return undefined;
  const host = (c.HostConfig ?? {}) as Record<string, unknown>;
  const config = (c.Config ?? {}) as { Env?: unknown };
  const env = new Map<string, string>();
  for (const kv of Array.isArray(config.Env) ? config.Env : []) {
    const s = String(kv);
    const i = s.indexOf('=');
    const k = i < 0 ? s : s.slice(0, i);
    if (k === 'NIBFIN_RUN_ID' || k === 'NIBFIN_RUN_REPO') env.set(k, s.slice(i + 1));
  }
  const mounts = (Array.isArray(c.Mounts) ? c.Mounts : []) as Record<string, unknown>[];
  return {
    imageName: String(c.ImageName ?? ''),
    memory: num(host.Memory),
    nanoCpus: num(host.NanoCpus),
    cpuQuota: num(host.CpuQuota),
    pidsLimit: num(host.PidsLimit),
    mounts: mounts.map((m) => ({ source: String(m.Source ?? m.Name ?? ''), destination: String(m.Destination ?? '') })),
    runId: env.get('NIBFIN_RUN_ID'),
    runRepo: env.get('NIBFIN_RUN_REPO'),
  };
}

/** Inspects a container; one already gone gives undefined. Its output never reaches a log or an error. */
export async function inspect(exec: Exec, id: string): Promise<Projection | undefined> {
  const r = await exec(['podman', 'container', 'inspect', id]);
  if (r.code !== 0) return undefined;
  try {
    return project(JSON.parse(r.stdout));
  } catch {
    return undefined;
  }
}

export interface Watch {
  readonly events: ContainerEvent[];
  /** The projection taken on each `start`, by container id (undefined when the container was already gone). */
  readonly projections: Map<string, Projection | undefined>;
  /** Waits until `n` `start` events were seen, or fails at the deadline naming `what` (or at once when `kit.signal` aborts). */
  started(n: number, deadlineMs: number, what: string): Promise<ContainerEvent>;
  /** Waits until `n` `died` events were seen, or fails at the deadline naming `what`. */
  died(n: number, deadlineMs: number, what: string): Promise<ContainerEvent>;
  /** Waits until each id has a `died` event. */
  diedAll(ids: string[], deadlineMs: number, what: string): Promise<void>;
  /** Resolves when the projection of the container is taken. */
  projection(id: string): Promise<Projection | undefined>;
  stop(): void;
}

/**
 * Watches the Job containers of a repository (and Issue, when given) on a `podman events`
 * stream; nothing polls. Each `start` is inspected at once and only the projection is kept.
 * `onStart` runs for each start before waiters see it.
 */
export function watchJobContainers(kit: Kit, repo: string, issue?: number, onStart?: (e: ContainerEvent, index: number) => Promise<void> | void): Watch {
  const events: ContainerEvent[] = [];
  const projections = new Map<string, Projection | undefined>();
  const pending = new Map<string, Promise<Projection | undefined>>();
  const waiters = new Set<() => void>();
  let ended: string | undefined;
  const filters = ['--filter', 'type=container', '--filter', `label=${LABEL_REPO}=${repo}`];
  if (issue !== undefined) filters.push('--filter', `label=${LABEL_ISSUE}=${issue}`);
  let chain = Promise.resolve();
  // `--since` replays the last seconds, so an event between starting the stream and a later
  // `podman ps` is not missed; the stream then follows new events.
  const stream = kit.stream(['podman', 'events', '--format', 'json', '--since', '10s', ...filters], (line) => {
    const e = parseEvent(line);
    if (!e) return;
    chain = chain.then(async () => {
      if (e.kind === 'start') {
        const p = inspect(kit.exec, e.id).then((x) => (projections.set(e.id, x), x));
        pending.set(e.id, p);
        await p;
        await onStart?.(e, events.filter((x) => x.kind === 'start').length);
      }
      events.push(e);
      for (const w of [...waiters]) w();
    }).catch((error: unknown) => {
      ended = `handling a container event failed: ${error instanceof Error ? error.message : String(error)}`;
      for (const w of [...waiters]) w();
    });
  });
  stream.closed.then((code) => {
    ended ??= `podman events exited ${code}`;
    for (const w of [...waiters]) w();
  });

  const until = <T>(test: () => T | undefined, deadlineMs: number, what: string) =>
    new Promise<T>((resolve, reject) => {
      const check = () => {
        const got = test();
        if (got !== undefined) return done(() => resolve(got));
        if (ended) return done(() => reject(new Error(`${ended} while waiting for ${what}`)));
      };
      const timer = setTimeout(() => done(() => reject(new Error(`timed out after ${Math.round(deadlineMs / 1000)} s waiting for ${what}`))), deadlineMs);
      const onAbort = () => done(() => reject(abortError(kit.signal)));
      const done = (f: () => void) => {
        clearTimeout(timer);
        kit.signal.removeEventListener('abort', onAbort);
        waiters.delete(check);
        f();
      };
      if (kit.signal.aborted) return onAbort();
      kit.signal.addEventListener('abort', onAbort, { once: true });
      waiters.add(check);
      check();
    });
  const nth = (kind: ContainerEvent['kind'], n: number) => () => events.filter((e) => e.kind === kind)[n - 1];

  return {
    events,
    projections,
    started: (n, ms, what) => until(nth('start', n), ms, what),
    died: (n, ms, what) => until(nth('died', n), ms, what),
    diedAll: async (ids, ms, what) => {
      const left = () => ids.filter((id) => !events.some((e) => e.kind === 'died' && (e.id.startsWith(id) || id.startsWith(e.id))));
      await until(() => (left().length ? undefined : true), ms, `${what} (${ids.length} container(s))`);
    },
    projection: (id) => pending.get(id) ?? Promise.resolve(projections.get(id)),
    stop: () => {
      ended ??= 'the watch was stopped';
      stream.stop();
    },
  };
}

/** Ids of the running Job containers of a repository. */
export async function runningJobContainers(exec: Exec, repo: string): Promise<string[]> {
  const r = await exec(['podman', 'ps', '--quiet', '--no-trunc', '--filter', `label=${LABEL_REPO}=${repo}`]);
  if (r.code !== 0) throw new Error(`podman ps exited ${r.code}: ${r.stderr.trim().slice(-2000)}`);
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}
