import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KitFor } from './lib/kit.ts';
import type { Scenario } from '../src/types.ts';
import { Checks } from './lib/checks.ts';
import { imageDigest } from './lib/observed-facts.ts';

const INDEX_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
];

/** The platforms of an image index, without attestation entries such as `unknown/unknown`. */
export function indexPlatforms(index: unknown): string[] {
  const m = (index as { manifests?: { platform?: { os?: string; architecture?: string } }[] }).manifests ?? [];
  return m
    .map((x) => `${x.platform?.os ?? 'unknown'}/${x.platform?.architecture ?? 'unknown'}`)
    .filter((p) => p !== 'unknown/unknown');
}

/** Predicate types of a repository attestation listing (from each DSSE payload's in-toto statement). */
export function predicateTypes(listing: unknown): string[] {
  const out = new Set<string>();
  for (const a of (listing as { attestations?: { bundle?: { dsseEnvelope?: { payload?: string } } }[] }).attestations ??
    []) {
    const payload = a.bundle?.dsseEnvelope?.payload;
    if (!payload) continue;
    try {
      const t = (JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { predicateType?: string })
        .predicateType;
      if (t) out.add(t);
    } catch {
      // not an in-toto statement
    }
  }
  return [...out];
}

/** Proposal R8.1: the image in use is a signed multi-arch build from nibfin-core's CD. */
export function imageProvenance(kitFor: KitFor): Scenario {
  return {
    id: 'image-provenance',
    rules: ['R8.1'],
    platforms: ['linux'],
    requires: ['nibfin'],
    async run(ctx) {
      const kit = kitFor(ctx);
      const digest = imageDigest(ctx);
      const c = new Checks(kit.secrets());
      const tokenRes = await kit.fetch('https://ghcr.io/token?scope=repository:taco3064/nibfin:pull&service=ghcr.io');
      if (!tokenRes.ok)
        return { status: 'failed', reason: `R8.1: GHCR gave no anonymous pull token (${tokenRes.status})` };
      const { token } = (await tokenRes.json()) as { token: string };
      const res = await kit.fetch(`https://ghcr.io/v2/taco3064/nibfin/manifests/${digest}`, {
        headers: { Accept: INDEX_TYPES.join(', '), Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { status: 'failed', reason: `R8.1: GHCR answered ${res.status} for the manifest ${digest}` };
      const bytes = Buffer.from(await res.arrayBuffer());
      const file = join(kit.workDir, 'image-index.json');
      writeFileSync(file, bytes);
      const sum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      c.hold('R8.1', 'the manifest fetched by digest hashes to that digest', sum === digest, sum);
      let index: unknown = {};
      try {
        index = JSON.parse(bytes.toString('utf8'));
      } catch {
        // checked below
      }
      const type = String((index as { mediaType?: string }).mediaType ?? res.headers.get('content-type') ?? '');
      const platforms = indexPlatforms(index);
      c.hold(
        'R8.1',
        'the image is an index with linux/amd64 and linux/arm64',
        INDEX_TYPES.includes(type) && platforms.includes('linux/amd64') && platforms.includes('linux/arm64'),
        `${type}: ${platforms.join(', ')}`,
      );

      const { data } = await kit.github.rest(
        'GET',
        `/repos/taco3064/nibfin-core/attestations/${digest}`,
        undefined,
        [404],
      );
      const types = predicateTypes(data);
      const count = ((data as { attestations?: unknown[] } | undefined)?.attestations ?? []).length;
      c.hold(
        'R8.1',
        'nibfin-core lists an attestation for the digest',
        count > 0,
        `${count} attestation(s), predicate types ${types.join(', ') || 'none'}`,
      );
      const [predicate] = types;
      if (predicate) {
        const r = await kit.exec(
          ['gh', 'attestation', 'verify', file, '--repo', 'taco3064/nibfin-core', '--predicate-type', predicate],
          { ghToken: kit.ghToken() },
        );
        c.hold(
          'R8.1',
          `gh attestation verify accepts the index (${predicate})`,
          r.code === 0,
          r.code === 0 ? 'verified' : (r.stderr.trim() || r.stdout.trim()).slice(-1000),
        );
      } else c.hold('R8.1', 'gh attestation verify accepts the index', false, 'no predicate type to verify against');
      return c.outcome();
    },
  };
}
