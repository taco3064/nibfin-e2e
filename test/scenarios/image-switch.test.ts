import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { parseContainerLine, readContainer } from '../../scenarios/lib/containers.ts';
import { mainDigest, oldCandidates, tagDigest } from '../../scenarios/lib/image.ts';
import { stageRunsAround } from '../../scenarios/lib/joblog.ts';
import { imagesNamed } from '../../scenarios/lib/observed.ts';
import { repin } from '../../scenarios/lib/workflows.ts';
import { fakeExec } from '../host/fakes.ts';

const D = (c: string) => 'sha256:' + c.repeat(64);
const NEW = D('a');
const OLD = D('b');
const OLDER = D('c');
const ID = 'f'.repeat(64);

/** GHCR stand-in: each tag maps to a digest; others answer `missing` (404 by default). */
function ghcr(tags: Record<string, string>, seen: string[] = [], missing = 404): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.startsWith('https://ghcr.io/token')) return new Response(JSON.stringify({ token: 'anon' }));
    const tag = decodeURIComponent(url.split('/manifests/')[1] ?? '');
    const d = tags[tag];
    return d ? new Response(null, { status: 200, headers: { 'docker-content-digest': d } }) : new Response(null, { status: missing });
  };
}

test('tagDigest reads a commit tag anonymously; a missing tag is undefined, other errors throw; mainDigest still throws on 404', async () => {
  const seen: string[] = [];
  equal(await tagDigest('4aff19d8e0', ghcr({ '4aff19d8e0': OLD }, seen)), OLD);
  deepEqual(seen, ['GET https://ghcr.io/token?scope=repository:taco3064/nibfin:pull', 'HEAD https://ghcr.io/v2/taco3064/nibfin/manifests/4aff19d8e0']);
  equal(await tagDigest('nothing', ghcr({})), undefined);
  await rejects(tagDigest('x', ghcr({}, [], 500)), /returned 500/);
  await rejects(tagDigest('x', ghcr({ x: 'sha256:short' })), /no valid digest/);
  await rejects(mainDigest(ghcr({})), /main returned 404/);
  equal(await mainDigest(ghcr({ main: NEW })), NEW);
});

test('oldCandidates: starts at the commit with D_new, skips untagged and equal images, keeps each digest once and respects max', () => {
  const chain = [
    { sha: 'n1' },
    { sha: 'n0', digest: NEW },
    { sha: 'o5' },
    { sha: 'o4', digest: NEW },
    { sha: 'o3', digest: OLD },
    { sha: 'o2', digest: OLD },
    { sha: 'o1', digest: OLDER },
    { sha: 'o0', digest: D('d') },
  ];
  deepEqual(oldCandidates(chain, NEW), { current: { sha: 'n0', digest: NEW }, older: [{ sha: 'o3', digest: OLD }, { sha: 'o1', digest: OLDER }, { sha: 'o0', digest: D('d') }] });
  deepEqual(oldCandidates(chain, NEW, 1), { current: { sha: 'n0', digest: NEW }, older: [{ sha: 'o3', digest: OLD }] });
  match((oldCandidates([{ sha: 'x', digest: OLD }], NEW) as { reason: string }).reason, /no nibfin-core main commit tag among the 1 read points at sha256:a/);
  match((oldCandidates([{ sha: 'x', digest: NEW }, { sha: 'y' }, { sha: 'z', digest: NEW }], NEW) as { reason: string }).reason, /no nibfin-core main commit older than x/);
});

test('repin replaces only exact D_new references and counts them', () => {
  const text = `env:\n  IMAGE: ghcr.io/taco3064/nibfin\n  IMAGE_REF: ghcr.io/taco3064/nibfin@${NEW}\n  OTHER: example.com/nibfin@${NEW}\n  B: ghcr.io/taco3064/nibfin@${NEW}\n`;
  deepEqual(repin(text, NEW, OLD), {
    text: `env:\n  IMAGE: ghcr.io/taco3064/nibfin\n  IMAGE_REF: ghcr.io/taco3064/nibfin@${OLD}\n  OTHER: example.com/nibfin@${NEW}\n  B: ghcr.io/taco3064/nibfin@${OLD}\n`,
    count: 2,
  });
  const plain = `IMAGE_REF: ghcr.io/taco3064/nibfin@${OLDER}\n`;
  deepEqual(repin(plain, NEW, OLD), { text: plain, count: 0 });
});

test('parseContainerLine takes the line whose full id matches; none is gone', () => {
  deepEqual(parseContainerLine(`${ID.slice(0, 63)}0 other\n${ID} ghcr.io/taco3064/nibfin@${OLD}\n`, ID), { id: ID, image: `ghcr.io/taco3064/nibfin@${OLD}` });
  equal(parseContainerLine('', ID), 'gone');
  equal(parseContainerLine(`${ID}\n`, ID), 'gone');
});

test('readContainer runs podman ps by id; a failing command throws with its output, empty output is gone', async () => {
  let reply: { code: number; stdout: string; stderr: string } = { code: 0, stdout: `${ID} ghcr.io/taco3064/nibfin@${OLD}\n`, stderr: '' };
  const { exec, calls } = fakeExec(() => reply);
  deepEqual(await readContainer(exec, ID), { id: ID, image: `ghcr.io/taco3064/nibfin@${OLD}` });
  deepEqual(calls[0]?.argv, ['podman', 'ps', '--no-trunc', '--filter', `id=${ID}`, '--format', '{{.ID}} {{.Image}}']);
  reply = { code: 0, stdout: '', stderr: '' };
  equal(await readContainer(exec, ID), 'gone');
  reply = { code: 125, stdout: '', stderr: 'Error: cannot connect to Podman' };
  await rejects(readContainer(exec, ID), /podman ps --no-trunc .* exited 125: Error: cannot connect to Podman/);
});

test('imagesNamed keeps each image id, names and repo digests', async () => {
  const { exec } = fakeExec(() => ({ stdout: JSON.stringify([{ Id: 'i1', Names: ['ghcr.io/taco3064/nibfin:<none>'], RepoDigests: [`ghcr.io/taco3064/nibfin@${NEW}`] }, { Id: 'i2' }]) }));
  deepEqual(await imagesNamed({ exec }), [
    { id: 'i1', names: ['ghcr.io/taco3064/nibfin:<none>'], repoDigests: [`ghcr.io/taco3064/nibfin@${NEW}`] },
    { id: 'i2', names: [], repoDigests: [] },
  ]);
});

test('stageRunsAround: agent stage runs of the Issue only, created_at equal to merged_at is next, ordered by time then id', () => {
  const run = (id: number, title: string, at: string) => ({ id, display_title: title, created_at: at });
  const merged = '2026-11-27T10:00:00Z';
  const runs = [
    run(9, 'Nibfin · o/exec#5 · deliver', '2026-11-27T10:05:00Z'),
    run(8, 'Nibfin · o/exec#5 · deliver', merged),
    run(7, 'Nibfin · o/exec#5 · route', merged),
    run(6, 'Nibfin · o/exec#5 · finish', '2026-11-27T09:59:00Z'),
    run(5, 'Nibfin · o/exec#6 · deliver', merged),
    run(4, 'Nibfin · o/peer#5 · deliver', merged),
    run(3, 'Nibfin · o/exec#5 · shape', '2026-11-27T09:50:00Z'),
    run(2, 'Nibfin · o/exec#5 · shape', '2026-11-27T09:50:00Z'),
    run(1, 'Something else', merged),
  ];
  const got = stageRunsAround(runs, 'o/exec', 5, merged);
  deepEqual(got.before.map((r) => r.id), [2, 3]);
  equal(got.next?.id, 8);
  equal(stageRunsAround(runs.slice(6), 'o/exec', 5, merged).next, undefined);
  equal(stageRunsAround([run(10, 'Nibfin · o/exec#5 · review', merged), run(11, 'Nibfin · o/exec#5 · scope', merged)], 'o/exec', 5, merged).next?.id, 10);
});
