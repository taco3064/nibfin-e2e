import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubPublisher } from '../publication-github.mjs';
import { digest } from '../publication-content.mjs';

function fixture() {
  const calls = [];
  const responses = [];
  const native = createGitHubPublisher({ token: 'private-token',
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { ok: next.status >= 200 && next.status < 300, status: next.status,
        headers: new Headers(next.headers),
        json: async () => {
          if (next.malformed) throw Error('private-token');
          return next.value;
        }, arrayBuffer: async () => next.value };
    } });
  const context = { repository: { id: 'core', repository: 'taco3064/nibfin-core',
    target: 'a'.repeat(40) }, version: '1.2.3',
    operation: { kind: 'tag' } };
  return { calls, responses, native, context };
}

test('native tag binds the source and reads it independently', async () => {
  const f = fixture();
  const tag = { ref: 'refs/tags/v1.2.3', object: { type: 'commit',
    sha: 'a'.repeat(40) } };
  f.responses.push({ status: 201, value: tag }, { status: 200, value: tag });
  await f.native.write(f.context);
  assert.equal((await f.native.observe(f.context)).state, 'matching');
  assert.equal(f.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].body), { ref: 'refs/tags/v1.2.3',
    sha: 'a'.repeat(40) });
  assert.equal(f.calls[1].method, 'GET');
  assert.match(f.calls[1].url, /git\/ref\/tags\/v1.2.3$/);
  assert.equal(f.calls[0].redirect, 'error');
});

test('tag conflicts and annotated aliases are rejected', async () => {
  for (const object of [{ type: 'commit', sha: 'b'.repeat(40) },
    { type: 'tag', sha: 'a'.repeat(40) }]) {
    const f = fixture();
    f.responses.push({ status: 200, value: { ref: 'refs/tags/v1.2.3', object } });
    assert.equal((await f.native.observe(f.context)).state, 'conflict');
  }
});

test('release readback verifies version, target, and published visibility', async () => {
  for (const patch of [{}, { name: '2.0.0' }, { draft: true },
    { target_commitish: 'main' }, { tag_name: 'v2.0.0' }, { prerelease: true }]) {
    const f = fixture();
    f.context.operation = { kind: 'release' };
    f.responses.push({ status: 200, value: { id: 12, name: '1.2.3',
      tag_name: 'v1.2.3', target_commitish: 'a'.repeat(40), draft: false,
      prerelease: false, ...patch } });
    assert.equal((await f.native.observe(f.context)).state,
      Object.keys(patch).length ? 'conflict' : 'matching');
  }
});

test('asset readback downloads bytes rather than trusting write metadata', async () => {
  for (const content of ['asset', 'corrupted']) {
    const f = fixture();
    f.context.operation = { kind: 'asset', name: 'required.tar.gz',
      sha256: digest(Buffer.from('asset')) };
    f.context.release = { id: 12 };
    f.responses.push({ status: 200, value: [{ id: 13, name: 'required.tar.gz',
      state: 'uploaded', size: content.length,
      browser_download_url: 'https://attacker.invalid' }] },
    { status: 200, value: Buffer.from(content) });
    assert.equal((await f.native.observe(f.context)).state,
      content === 'asset' ? 'matching' : 'conflict');
    assert.match(f.calls[1].url, /api.github.com\/repos\/.*\/releases\/assets\/13$/);
  }
});

test('asset upload uses only the constructed official endpoint', async () => {
  const f = fixture();
  f.context.operation = { kind: 'asset', name: 'test file',
    content: Buffer.from('asset').toString('base64') };
  f.context.release = { id: 12 };
  f.responses.push({ status: 201, value: { id: 13 } });
  await f.native.write(f.context);
  assert.equal(f.calls[0].url, 'https://uploads.github.com/repos/' +
    'taco3064/nibfin-core/releases/12/assets?name=test%20file');
  assert.deepEqual(f.calls[0].body, Buffer.from('asset'));
});

for (const kind of ['blob', 'tree', 'commit']) {
  test(`${kind} creation checks identity and independent native readback`, async () => {
    const f = fixture();
    f.context.operation = { kind, sha: 'b'.repeat(40), content: 'YQ==',
      entries: [], tree: 'c'.repeat(40), parent: 'a'.repeat(40), message: 'Release\n' };
    f.responses.push({ status: 201, value: { sha: 'b'.repeat(40) } },
      { status: 200, value: { sha: 'b'.repeat(40) } });
    await f.native.write(f.context);
    assert.equal((await f.native.observe(f.context)).state, 'matching');
    assert.match(f.calls[0].url, new RegExp(`git/${kind}s$`));
    assert.match(f.calls[1].url, new RegExp(`git/${kind}s/${'b'.repeat(40)}$`));
  });
}

test('timeout, malformed and lost responses are sanitized unknown writes', async () => {
  for (const response of [new Error('private-token'), { status: 201, malformed: true },
    { status: 201, value: {} }, { status: 503 }]) {
    const f = fixture();
    f.responses.push(response);
    await assert.rejects(f.native.write(f.context), /^Error: PUBLICATION_UNKNOWN$/);
    assert.equal(f.calls.length, 1);
  }
});

test('unavailable reads are unknown; only authoritative 404 establishes absence',
  async () => {
    const f = fixture();
    f.responses.push({ status: 503 }, { status: 404 });
    assert.equal((await f.native.observe(f.context)).state, 'unknown');
    assert.equal((await f.native.observe(f.context)).state, 'absent');
  });

test('transport rejects nonofficial repositories before any request', async () => {
  const f = fixture();
  f.context.repository.repository = 'other/repo';
  await assert.rejects(f.native.write(f.context), /invalid native context/);
  assert.equal(f.calls.length, 0);
});

function assetFixture(content = 'asset') {
  const f = fixture();
  f.context.operation = { kind: 'asset', name: 'required.tar.gz',
    sha256: digest(Buffer.from('asset')) };
  f.context.release = { id: 12 };
  f.responses.push({ status: 200, value: [{ id: 13, name: 'required.tar.gz',
    state: 'uploaded', size: content.length }] });
  return f;
}

test('asset redirects download and verify bytes without forwarding credentials',
  async () => {
    for (const host of ['release-assets.githubusercontent.com',
      'objects.githubusercontent.com']) {
      for (const content of ['asset', 'wrong']) {
        const f = assetFixture(content);
        const location = `https://${host}/github-production-release-asset/13?sig=x`;
        f.responses.push({ status: 302, headers: { location } },
          { status: 200, value: Buffer.from(content) });
        assert.equal((await f.native.observe(f.context)).state,
          content === 'asset' ? 'matching' : 'conflict');
        assert.equal(f.calls[1].redirect, 'manual');
        assert.equal(f.calls[2].url, location);
        assert.deepEqual(f.calls[2].headers, { Accept: 'application/octet-stream' });
        assert.equal(f.calls[2].redirect, 'error');
        assert.equal(f.calls[2].signal, f.calls[1].signal);
      }
    }
  });

test('unsafe asset redirects are unknown without contacting their destination',
  async () => {
    for (const location of [undefined, '/relative', 'not a URL',
      'http://release-assets.githubusercontent.com/file',
      'https://attacker.invalid/file',
      'https://release-assets.githubusercontent.com.attacker.invalid/file',
      'https://user:secret@release-assets.githubusercontent.com/file',
      'https://release-assets.githubusercontent.com:444/file',
      'https://release-assets.githubusercontent.com/file#fragment',
      'https://127.0.0.1/file']) {
      const f = assetFixture();
      f.responses.push({ status: 302,
        headers: location === undefined ? {} : { location } });
      assert.equal((await f.native.observe(f.context)).state, 'unknown');
      assert.equal(f.calls.length, 2);
    }
  });

test('failed or repeated download redirects remain unknown', async () => {
  for (const response of [{ status: 302, headers: {
    location: 'https://attacker.invalid/file' } }, { status: 404 },
  { status: 503 }, new Error('private-token')]) {
    const f = assetFixture();
    f.responses.push({ status: 302, headers: {
      location: 'https://release-assets.githubusercontent.com/file' } }, response);
    assert.equal((await f.native.observe(f.context)).state, 'unknown');
    assert.equal(f.calls.length, 3);
  }
});
