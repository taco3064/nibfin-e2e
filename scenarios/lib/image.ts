import type { Outcome } from '../../src/types.ts';
import { precondition } from './check.ts';

const REPO = 'taco3064/nibfin';
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The digest a tag of `ghcr.io/taco3064/nibfin` points at, read anonymously: GHCR's own
 * pull token, never a GitHub token. A missing tag (404) gives undefined.
 */
export async function tagDigest(tag: string, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  const t = await fetchFn(`https://ghcr.io/token?scope=repository:${REPO}:pull`);
  if (!t.ok) throw new Error(`GHCR token request returned ${t.status}`);
  const { token } = (await t.json()) as { token?: string };
  if (!token) throw new Error('GHCR returned no anonymous pull token');
  const res = await fetchFn(`https://ghcr.io/v2/${REPO}/manifests/${encodeURIComponent(tag)}`, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json',
    },
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GHCR HEAD ${REPO}:${tag} returned ${res.status}`);
  const digest = res.headers.get('docker-content-digest') ?? '';
  if (!DIGEST.test(digest)) throw new Error(`GHCR returned no valid digest for ${REPO}:${tag}`);
  return digest;
}

/**
 * The digest of `ghcr.io/taco3064/nibfin:main`. nibfin-core moves `main` only after
 * attesting the image, so it is the newest signed main image (Proposal R8.7, before the
 * first release).
 */
export async function mainDigest(fetchFn: typeof fetch = fetch): Promise<string> {
  const digest = await tagDigest('main', fetchFn);
  if (digest === undefined) throw new Error(`GHCR HEAD ${REPO}:main returned 404`);
  return digest;
}

/**
 * Undefined when GHCR `:main` is still the digest `init` resolved; otherwise a
 * "precondition not reached" failure naming both: a newer image makes a PR correct.
 */
export async function requireCurrentImage(imageDigest: string, fetchFn: typeof fetch = fetch): Promise<Outcome | undefined> {
  const current = await mainDigest(fetchFn);
  if (current === imageDigest) return undefined;
  return precondition(`GHCR :main is ${current}, init resolved ${imageDigest}; a newer main image appeared after init`);
}

export interface CommitImage {
  /** A nibfin-core main commit. */
  sha: string;
  /** The digest of the image tagged with that commit; undefined when none was built (Proposal R8.1). */
  digest?: string;
}

export type OldCandidates = { current: CommitImage; older: { sha: string; digest: string }[] } | { reason: string };

/**
 * Earlier images to pin before an upgrade (Proposal R5.55). `chain` is nibfin-core's main
 * commits, newest first, each with its commit-tag digest. Finds the first commit whose
 * image is `dNew` and returns it with up to `max` older commits whose image differs from
 * `dNew` (each digest once), nearest first; otherwise a reason.
 */
export function oldCandidates(chain: CommitImage[], dNew: string, max = 3): OldCandidates {
  const at = chain.findIndex((c) => c.digest === dNew);
  if (at < 0) return { reason: `no nibfin-core main commit tag among the ${chain.length} read points at ${dNew}` };
  const current = chain[at] as CommitImage;
  const older: { sha: string; digest: string }[] = [];
  for (const c of chain.slice(at + 1)) {
    if (older.length >= max) break;
    if (c.digest === undefined || c.digest === dNew || older.some((o) => o.digest === c.digest)) continue;
    older.push({ sha: c.sha, digest: c.digest });
  }
  if (!older.length) return { reason: `no nibfin-core main commit older than ${current.sha} has an image other than ${dNew}` };
  return { current, older };
}
