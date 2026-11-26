import type { Outcome } from '../../src/types.ts';
import { precondition } from './check.ts';

const REPO = 'taco3064/nibfin';
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The digest of `ghcr.io/taco3064/nibfin:main`, read anonymously: GHCR's own pull token,
 * never a GitHub token. nibfin-core moves `main` only after attesting the image, so it is
 * the newest signed main image (Proposal R8.7, before the first release).
 */
export async function mainDigest(fetchFn: typeof fetch = fetch): Promise<string> {
  const t = await fetchFn(`https://ghcr.io/token?scope=repository:${REPO}:pull`);
  if (!t.ok) throw new Error(`GHCR token request returned ${t.status}`);
  const { token } = (await t.json()) as { token?: string };
  if (!token) throw new Error('GHCR returned no anonymous pull token');
  const res = await fetchFn(`https://ghcr.io/v2/${REPO}/manifests/main`, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json',
    },
  });
  if (!res.ok) throw new Error(`GHCR HEAD ${REPO}:main returned ${res.status}`);
  const digest = res.headers.get('docker-content-digest') ?? '';
  if (!DIGEST.test(digest)) throw new Error(`GHCR returned no valid digest for ${REPO}:main`);
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
