// Telling the first-login container apart from Podman's public view (Proposal R6.11):
// an interactive, non-Job container from the Jobs' image running the CLI's own login.
import { precondition } from '../lib/check.ts';
import { LABEL_REPO } from '../lib/containers.ts';

/**
 * What the scenario keeps of one `podman container inspect` document: an allowlisted
 * projection only. `Config.Env` and everything else are dropped.
 */
export interface LoginContainer {
  id: string;
  imageName: string;
  imageId: string;
  imageDigest: string;
  /** `Config.Entrypoint` followed by `Config.Cmd`. */
  argv: string[];
  tty: boolean;
  openStdin: boolean;
  running: boolean;
  /** Carries the Job repository label (Proposal R9.23). */
  job: boolean;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] =>
  typeof v === 'string' ? (v ? [v] : []) : Array.isArray(v) ? v.map((s) => String(s)) : [];

export function projectLogin(raw: unknown): LoginContainer | undefined {
  const c = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return undefined;
  const config = (c.Config && typeof c.Config === 'object' ? c.Config : {}) as Record<string, unknown>;
  const state = (c.State && typeof c.State === 'object' ? c.State : {}) as Record<string, unknown>;
  const labels = (config.Labels && typeof config.Labels === 'object' ? config.Labels : {}) as Record<string, unknown>;
  return {
    id: str(c.Id),
    imageName: str(c.ImageName),
    imageId: str(c.Image),
    imageDigest: str(c.ImageDigest),
    argv: [...strings(config.Entrypoint), ...strings(config.Cmd)],
    tty: config.Tty === true,
    openStdin: config.OpenStdin === true,
    running: state.Running === true,
    job: Object.prototype.hasOwnProperty.call(labels, LABEL_REPO),
  };
}

/** The Codex CLI's own interactive login: `codex login` or `codex login --device-auth`. */
export function isCliLogin(argv: string[]): boolean {
  for (let i = 0; i + 1 < argv.length; i++) {
    const bin = argv[i] ?? '';
    if ((bin === 'codex' || bin.endsWith('/codex')) && argv[i + 1] === 'login') {
      const rest = argv.slice(i + 2);
      return rest.length === 0 || (rest.length === 1 && rest[0] === '--device-auth');
    }
  }
  return false;
}

/** IDs from `podman ps --format {{.ID}}` output. */
export function parseIds(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A container or image id without the `sha256:` prefix, lower case. */
export const bareImageId = (id: string): string => id.replace(/^sha256:/, '').toLowerCase();
/** The 12-character short form of an id. */
export const shortId = (id: string): string => bareImageId(id).slice(0, 12) || '(none)';

/** One container in `Check` style: id, image, command and the TTY / stdin fields. */
export function describeLogin(c: LoginContainer): string {
  return `container ${shortId(c.id)} image ${c.imageName || '(none)'} (${c.imageDigest || 'no digest'}, id ${shortId(c.imageId)}) command "${c.argv.join(' ')}" Tty=${c.tty} OpenStdin=${c.openStdin}`;
}

function shapeMisses(c: LoginContainer): string[] {
  const misses: string[] = [];
  if (c.job) misses.push(`carries the Job label ${LABEL_REPO}`);
  if (!c.running) misses.push('not running');
  if (!c.openStdin && !c.tty) misses.push('not interactive');
  if (!isCliLogin(c.argv)) misses.push("not the CLI's own login (codex login [--device-auth])");
  return misses;
}

/**
 * Why `c` is not shaped like the login container (Job label, running, interactive, the
 * CLI's own login), whatever its image; undefined when it is.
 */
export function shapeMiss(c: LoginContainer): string | undefined {
  const misses = shapeMisses(c);
  return misses.length ? misses.join(', ') : undefined;
}

/** Why `c` is not the login container, or undefined when it is. */
export function loginMiss(c: LoginContainer, jobImageId: string): string | undefined {
  const misses = shapeMisses(c);
  if (!c.imageId || bareImageId(c.imageId) !== bareImageId(jobImageId))
    misses.push(`image id differs from the Jobs' image id ${shortId(jobImageId)}`);
  return misses.length ? misses.join(', ') : undefined;
}

/** Login-shaped, but from an image id other than the Jobs' (a candidate for a newer `:main`). */
export function otherImageLogin(c: LoginContainer, jobImageId: string): boolean {
  return shapeMiss(c) === undefined && bareImageId(c.imageId) !== bareImageId(jobImageId);
}

/** The first container that is the login container, and why each other one is not. */
export function pickLogin(list: LoginContainer[], jobImageId: string): { match?: LoginContainer; problems: string[] } {
  const problems: string[] = [];
  for (const c of list) {
    const miss = loginMiss(c, jobImageId);
    if (miss === undefined) return { match: c, problems };
    problems.push(`${describeLogin(c)}: ${miss}`);
  }
  return { problems };
}

/** The GHCR `:main` image read after the sample: its digest and, when present locally, its image id; or the read error. */
export type CurrentMain = { digest: string; imageId?: string } | { error: string };

export interface LoginVerdictInput {
  seen: LoginContainer[];
  /** The Jobs' `IMAGE@digest`. */
  ref: string;
  jobImageId: string;
  /** The digest `init` resolved. */
  initDigest: string;
  /** Undefined when GHCR was not read. */
  current?: CurrentMain;
  volume: string;
  /** How the sample ended, as text (for example "within 60 s"). */
  waitText: string;
}

/**
 * The R6.11 failure when no sampled container is the login container (Proposal R6.11,
 * R1.14). Run state only when `:main` moved since init and a login-shaped candidate is
 * proven to be from the current `:main` image (its digest, or its image id equal to the
 * local id of the current digest); the observation stays in every reason.
 */
export function loginVerdict(input: LoginVerdictInput): { failure: string } {
  const { seen, ref, jobImageId, initDigest, current, volume, waitText } = input;
  const problems = pickLogin(seen, jobImageId).problems;
  const observed = problems.length ? problems.join('; ') : `no running container mounting ${volume}`;
  const r611 = `R6.11: expected an interactive container from the Jobs' image ${ref} running the CLI's own login (codex login [--device-auth]) while the guide was shown; observed: ${observed} ${waitText}`;
  if (!current) return { failure: r611 };
  if ('error' in current)
    return { failure: `${r611} (GHCR :main could not be read to rule out a newer image: ${current.error})` };
  if (current.digest === initDigest) return { failure: r611 };
  const fromCurrent = (c: LoginContainer) =>
    (!!c.imageDigest && c.imageDigest === current.digest) ||
    (!!current.imageId && !!c.imageId && bareImageId(c.imageId) === bareImageId(current.imageId));
  const proven = seen.find((c) => otherImageLogin(c, jobImageId) && fromCurrent(c));
  if (!proven)
    return {
      failure: `${r611} (GHCR :main is ${current.digest}, init resolved ${initDigest}; no login candidate is from it)`,
    };
  const why = `GHCR :main is ${current.digest}, init resolved ${initDigest}; a newer main image appeared after init and login candidate ${describeLogin(proven)} is from it, not from the Jobs' image ${ref}; observed: ${observed} ${waitText}`;
  return { failure: `run state: ${precondition(why).reason}` };
}
