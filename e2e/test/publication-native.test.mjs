import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationFixture } from './publication-fixture.mjs';
import { createGitHubPublisher } from '../publication-github.mjs';

// Credential-free HTTP fixture implements native objects, not coordinator states.
function nativeFixture() {
  const f = publicationFixture();
  const repositories = new Map();
  const writes = [];
  let nextId = 1;
  let loseResponse = false;
  let corruptUpload = false;
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'release-assets.githubusercontent.com') {
      assert.deepEqual(options.headers, { Accept: 'application/octet-stream' });
      assert.equal(options.redirect, 'error');
      const asset = [...repositories.values()].flatMap(row => row.assets)
        .find(row => row.id === Number(parsed.pathname.slice(1)));
      return asset ? new Response(asset.bytes) : json({}, 404);
    }
    const [, , owner, name, ...parts] = parsed.pathname.split('/');
    const repository = `${owner}/${name}`;
    const path = parts.join('/');
    if (!repositories.has(repository)) repositories.set(repository, {
      tag: null, release: null, assets: [],
    });
    const state = repositories.get(repository);
    if (options.method === 'POST') {
      writes.push(`${repository}/${path}`);
      let object;
      if (path === 'git/refs') {
        const body = JSON.parse(options.body);
        state.tag = { ref: body.ref, object: { type: 'commit', sha: body.sha } };
        object = state.tag;
      } else if (path === 'releases') {
        state.release = { ...JSON.parse(options.body), id: nextId++ };
        object = state.release;
      } else if (path.startsWith('releases/') && path.endsWith('/assets')) {
        assert.equal(parsed.hostname, 'uploads.github.com');
        assert.equal(Number(parts[1]), state.release.id);
        const bytes = corruptUpload ? Buffer.from('corrupt') : options.body;
        object = { id: nextId++, name: parsed.searchParams.get('name'),
          size: bytes.length, state: 'uploaded', bytes };
        state.assets.push(object);
      } else throw Error('unexpected publication path');
      if (loseResponse) throw Error('response lost after native mutation');
      return json(object, 201);
    }
    assert.equal(options.method, 'GET');
    if (path.startsWith('git/ref/')) {
      return state.tag ? json(state.tag) : json({}, 404);
    }
    if (path.startsWith('releases/tags/')) {
      return state.release ? json(state.release) : json({}, 404);
    }
    if (path.startsWith('releases/assets/')) {
      const asset = state.assets.find(row => row.id === Number(parts[2]));
      return asset ? new Response(null, { status: 302, headers: {
        location: `https://release-assets.githubusercontent.com/${asset.id}`,
      } }) : json({}, 404);
    }
    if (path.startsWith('releases/') && path.endsWith('/assets')) {
      return json(state.assets.map(({ bytes, ...metadata }) => metadata));
    }
    throw Error('unexpected native read');
  };
  f.capabilities.native = createGitHubPublisher({ token: 'controlled-token', fetch });
  return { ...f, writes, repositories,
    loseResponse(value) { loseResponse = value; },
    corruptUpload() { corruptUpload = true; } };
}

test('coordinator and HTTP adapter publish and resume verified objects', async () => {
  const f = nativeFixture();
  const first = await f.invoke();
  assert.equal(first.outcome, 'published');
  assert.equal(first.mode, 'contract-test');
  assert.deepEqual(first.completed, ['core', 'action', 'cli']);
  assert.deepEqual([...f.repositories.keys()], ['taco3064/nibfin-core',
    'taco3064/nibfin-act', 'taco3064/gh-nibfin']);
  for (const state of f.repositories.values()) {
    assert.equal(state.tag.object.sha, 'a'.repeat(40));
    assert.equal(state.release.name, '1.2.3');
    assert.equal(state.assets.length, 1);
    assert.deepEqual(state.assets[0].bytes, Buffer.from('validated asset'));
  }
  const count = f.writes.length;
  assert.equal((await f.invoke({ resume: true })).outcome, 'published');
  assert.equal(f.writes.length, count);
});

test('HTTP response loss after mutation resumes through native GET without replay',
  async () => {
    const f = nativeFixture();
    f.loseResponse(true);
    assert.deepEqual((await f.invoke()).unresolved, ['core']);
    assert.equal(f.writes.length, 1);
    f.loseResponse(false);
    assert.equal((await f.invoke({ resume: true })).outcome, 'published');
    assert.equal(f.writes.filter(path => path.endsWith('/git/refs')).length, 3);
  });

test('HTTP upload with wrong native bytes stops dependent products', async () => {
  const f = nativeFixture();
  f.corruptUpload();
  assert.deepEqual((await f.invoke()).unresolved, ['core']);
  assert.equal(f.repositories.size, 1);
  assert.equal(f.writes.length, 3);
  assert.equal((await f.invoke({ resume: true })).outcome, 'blocked');
  assert.equal(f.writes.length, 3);
});
