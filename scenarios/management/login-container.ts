// Telling the first-login container apart from Podman's public view (Proposal R6.11):
// an interactive, non-Job container from the Jobs' image running the CLI's own login.
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
const strings = (v: unknown): string[] => (typeof v === 'string' ? (v ? [v] : []) : Array.isArray(v) ? v.map((s) => String(s)) : []);

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
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** A container or image id without the `sha256:` prefix, lower case. */
export const bareImageId = (id: string): string => id.replace(/^sha256:/, '').toLowerCase();
/** The 12-character short form of an id. */
export const shortId = (id: string): string => bareImageId(id).slice(0, 12) || '(none)';

/** One container in `Check` style: id, image, command and the TTY / stdin fields. */
export function describeLogin(c: LoginContainer): string {
  return `container ${shortId(c.id)} image ${c.imageName || '(none)'} (${c.imageDigest || 'no digest'}, id ${shortId(c.imageId)}) command "${c.argv.join(' ')}" Tty=${c.tty} OpenStdin=${c.openStdin}`;
}

/** Why `c` is not the login container, or undefined when it is. */
export function loginMiss(c: LoginContainer, jobImageId: string): string | undefined {
  const misses: string[] = [];
  if (c.job) misses.push(`carries the Job label ${LABEL_REPO}`);
  if (!c.running) misses.push('not running');
  if (!c.openStdin && !c.tty) misses.push('not interactive');
  if (!isCliLogin(c.argv)) misses.push('not the CLI\'s own login (codex login [--device-auth])');
  if (!c.imageId || bareImageId(c.imageId) !== bareImageId(jobImageId)) misses.push(`image id differs from the Jobs' image id ${shortId(jobImageId)}`);
  return misses.length ? misses.join(', ') : undefined;
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
