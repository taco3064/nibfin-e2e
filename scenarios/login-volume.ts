import type { Scenario } from '../src/types.ts';
import { Checks } from './lib/checks.ts';
import type { Projection } from './lib/containers.ts';
import type { ObservedJob, ReadError } from './lib/observed.ts';
import { observedFacts } from './lib/observed-facts.ts';
import { CLAUDE_VOLUME, changedFiles } from './lib/volume.ts';
import type { VolumeFile, VolumeInfo } from './lib/volume.ts';

const failedRead = (v: unknown): v is ReadError => typeof v === 'object' && v !== null && 'error' in v;
const ok = <T>(v: T | ReadError | undefined): T | undefined => (v === undefined || failedRead(v) ? undefined : v);
const why = (v: unknown, what: string) => (v === undefined ? `${what} not read` : failedRead(v) ? v.error : '');
const label = (j: ObservedJob) => `${j.stage} ${j.id.slice(0, 12)}`;
const show = (p: Projection) => p.mounts.map((m) => `${m.name ?? m.source}:${m.destination}`).join(', ') || 'no mounts';

/** The CLI's own home: CLAUDE_CONFIG_DIR when set, else ~/.claude (Claude Code settings and env-vars docs). */
export function cliHome(probe: Record<string, string[]> | undefined): string | undefined {
  const dir = probe?.claude_config_dir?.[0];
  if (dir !== undefined && dir !== '' && dir !== 'unset') return dir.replace(/\/+$/, '') || '/';
  const home = probe?.home?.[0];
  return home ? `${home.replace(/\/+$/, '')}/.claude` : undefined;
}

/** The mounts of the login volume: by name, or by the volume's mountpoint as source when Podman shows no name. */
export function loginMounts(p: Projection, volume: VolumeInfo | undefined): Projection['mounts'] {
  return p.mounts.filter((m) =>
    m.name !== undefined
      ? m.name === CLAUDE_VOLUME
      : volume !== undefined && volume.mountpoint !== '' && m.source === volume.mountpoint,
  );
}

/** Proposal R6.12: the CLI's login lives in its own home on the nibfin-home-claude Podman volume, which every Job mounts. */
export const loginVolume: Scenario = {
  id: 'login-volume',
  rules: ['R6.12'],
  platforms: ['linux'],
  requires: ['observed-job'],
  // Reads only the observed-job provisioning facts and makes no GitHub, host or sandbox call, so it runs alongside its neighbours.
  concurrent: true,
  async run(ctx) {
    const f = observedFacts(ctx);
    const c = new Checks();
    const volume = ok(f.loginVolume);
    c.hold(
      'R6.12',
      `${CLAUDE_VOLUME} is a named Podman volume on the host`,
      volume?.name === CLAUDE_VOLUME,
      volume
        ? `name ${volume.name}, driver ${volume.driver}, mountpoint ${volume.mountpoint}`
        : why(f.loginVolume, 'podman volume inspect'),
    );

    const home = cliHome(f.probe);
    c.hold(
      'R6.12',
      "the CLI's home is known from the probe",
      home !== undefined,
      home ??
        `no probe line (home=${f.probe?.home?.[0] ?? 'missing'}, claude_config_dir=${f.probe?.claude_config_dir?.[0] ?? 'missing'})`,
    );

    const jobs = f.jobs ?? [];
    c.hold(
      'R6.12',
      'the Shape, Deliver and Review Job containers were recorded',
      jobs.length >= 3,
      jobs.map(label).join(', ') || 'no Job container recorded',
    );
    const missing = jobs.filter((j) => j.projection === undefined);
    c.hold(
      'R6.12',
      'every Job container was inspected',
      jobs.length > 0 && missing.length === 0,
      missing.map((j) => `${label(j)}: container ended before it was inspected`).join('; ') || 'all inspected',
    );
    const seen = jobs.filter((j): j is ObservedJob & { projection: Projection } => j.projection !== undefined);
    const shape = seen.find((j) => j.stage === 'Shape');
    const otherImage = seen.filter((j) => j.projection.imageName !== shape?.projection.imageName);
    c.hold(
      'R6.12',
      'every Job container runs the same image as Shape, so the probed home applies to all',
      shape !== undefined && otherImage.length === 0,
      otherImage.map((j) => `${label(j)}: ${j.projection.imageName}`).join('; ') ||
        shape?.projection.imageName ||
        'no Shape projection',
    );

    const mounted = seen.map((j) => ({ job: j, mounts: loginMounts(j.projection, volume) }));
    const wrong = mounted.filter(
      ({ mounts }) => mounts.length !== 1 || home === undefined || mounts[0]?.destination !== home,
    );
    c.hold(
      'R6.12',
      `every Job container mounts ${CLAUDE_VOLUME} once at the CLI's home${home ? ` (${home})` : ''}`,
      seen.length > 0 && home !== undefined && wrong.length === 0,
      wrong.map(({ job }) => `${label(job)}: ${show(job.projection)}`).join('; ') ||
        mounted
          .map(({ job, mounts }) => `${label(job)}: ${mounts[0]?.name ?? CLAUDE_VOLUME} → ${mounts[0]?.destination}`)
          .join('; ') ||
        'no projection',
    );

    const first = mounted.map(({ mounts }) => mounts[0]).filter((m) => m !== undefined);
    const names = [...new Set(first.map((m) => m.name).filter((n) => n !== undefined))];
    const sources = [...new Set(first.map((m) => m.source))];
    const sameSource =
      sources.length === 1 && (volume === undefined || volume.mountpoint === '' || sources[0] === volume.mountpoint);
    c.hold(
      'R6.12',
      'every Job container mounts the same volume (same name and host source)',
      first.length > 0 &&
        first.length === seen.length &&
        names.length <= 1 &&
        (names[0] ?? CLAUDE_VOLUME) === CLAUDE_VOLUME &&
        sameSource,
      `names ${names.join(', ') || 'none shown'}; sources ${sources.join(', ') || 'none'}; mountpoint ${volume?.mountpoint ?? 'unknown'}`,
    );

    const withEnv = seen.filter((j) => j.projection.credentialEnv.length > 0);
    c.hold(
      'R6.12',
      'no Job container gets a Claude credential through its environment',
      seen.length > 0 && withEnv.length === 0,
      withEnv.map((j) => `${label(j)}: ${j.projection.credentialEnv.join(', ')}`).join('; ') || 'none',
    );
    const afterJobs = ok(f.loginAfterJobs);
    c.hold(
      'R6.12',
      'the login token stays in the volume after Shape and after all Jobs',
      f.loginAfter?.hasToken === true && afterJobs?.hasToken === true,
      `after Shape ${String(f.loginAfter?.hasToken)}, after all Jobs ${afterJobs ? String(afterJobs.hasToken) : why(f.loginAfterJobs, 'settings.json')}`,
    );

    const files = f.volumeFiles;
    const before = ok<VolumeFile[]>(files?.beforeJobs);
    const afterShape = ok<VolumeFile[]>(files?.afterShape);
    const end = ok<VolumeFile[]>(files?.afterJobs);
    const written = before && afterShape ? changedFiles(before, afterShape) : undefined;
    c.hold(
      'R6.12',
      'the CLI wrote its own files in its home during Shape (settings.json and decoys left out)',
      written !== undefined && written.length > 0,
      written
        ? written.slice(0, 20).join(', ') || 'no file changed'
        : [why(files?.beforeJobs, 'the listing before the Jobs'), why(files?.afterShape, 'the listing after Shape')]
            .filter(Boolean)
            .join('; '),
    );
    const kept = written && end ? written.filter((p) => end.some((x) => x.path === p)) : undefined;
    c.hold(
      'R6.12',
      'files written during Shape are still in the volume after Review',
      kept !== undefined && kept.length > 0,
      kept
        ? kept.slice(0, 20).join(', ') || `none of ${written?.join(', ') || 'no written file'}`
        : why(files?.afterJobs, 'the listing after the Jobs') || 'no file written during Shape',
    );
    return c.outcome();
  },
};
