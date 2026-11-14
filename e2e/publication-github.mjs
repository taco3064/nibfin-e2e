import { sourceRepositories } from './source-checkout.mjs';
import { digest } from './publication-content.mjs';
import { validateVersion } from './release-contract.mjs';

const unknown = () => ({ state: 'unknown' });
const absent = () => ({ state: 'absent' });
const result = (matches, object) => ({
  state: matches ? 'matching' : 'conflict', object,
});
const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');
const id = value => Number.isSafeInteger(value) && value > 0;
const author = { name: 'Nibfin Release', email: 'release@nibfin.invalid',
  date: '1970-01-01T00:00:00Z' };

// The credential and fetch implementation belong only to protected composition.
// API endpoints are constructed here; asset redirects use a strict host allowlist.
export function createGitHubPublisher({ token, fetch: request = globalThis.fetch }) {
  if (typeof token !== 'string' || !token || typeof request !== 'function') {
    throw new Error('CONFIGURATION: protected GitHub transport required');
  }
  async function call(method, repository, path, body, binary = false, upload = false) {
    try {
      const host = upload ? 'uploads.github.com' : 'api.github.com';
      const download = binary && method === 'GET';
      const signal = AbortSignal.timeout(120000);
      let response = await request(`https://${host}/repos/${repository}/${path}`, {
        method, redirect: download ? 'manual' : 'error', signal,
        headers: { Authorization: `Bearer ${token}`,
          Accept: binary && method === 'GET' ? 'application/octet-stream' :
            'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': binary ?
            'application/octet-stream' : 'application/json' }) },
        ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
      });
      if (download && response.status === 302) {
        const location = new URL(response.headers.get('location'));
        const hosts = ['release-assets.githubusercontent.com',
          'objects.githubusercontent.com'];
        if (location.protocol !== 'https:' || !hosts.includes(location.hostname) ||
            location.username || location.password || location.port ||
            location.hash) return { status: 0 };
        // Signed download URLs need no API credentials. Never follow another hop.
        response = await request(location.href, {
          method: 'GET', redirect: 'error', signal,
          headers: { Accept: 'application/octet-stream' },
        });
        if (response.status !== 200) return { status: 0 };
      }
      if (response.status === 404) return { status: 404 };
      if (!response.ok) return { status: 0 };
      const value = binary && method === 'GET' ?
        Buffer.from(await response.arrayBuffer()) : await response.json();
      return { status: response.status, value };
    } catch { return { status: 0 }; }
  }
  function context(value) {
    const { repository, version, operation } = value;
    validateVersion([version]);
    if (!sourceRepositories.some(row => row.id === repository.id &&
        row.repository === repository.repository) || !sha(repository.target) ||
        !['blob', 'tree', 'commit', 'tag', 'release', 'asset'].includes(operation.kind)) {
      throw new Error('PUBLICATION: invalid native context');
    }
    if (['blob', 'tree', 'commit'].includes(operation.kind) && !sha(operation.sha)) {
      throw new Error('PUBLICATION: invalid Git object identity');
    }
    return { repo: repository.repository, tag: `v${version}`,
      encoded: encodeURIComponent(`v${version}`) };
  }
  async function observe(value) {
    const { repository, operation: op, version, release } = value;
    const { repo, tag, encoded } = context(value);
    if (['blob', 'tree', 'commit'].includes(op.kind)) {
      const plural = { blob: 'blobs', tree: 'trees', commit: 'commits' }[op.kind];
      const response = await call('GET', repo, `git/${plural}/${op.sha}`);
      if (response.status === 404) return absent();
      if (!response.value || !sha(response.value.sha)) return unknown();
      return result(response.value.sha === op.sha, { sha: response.value.sha });
    }
    if (op.kind === 'tag') {
      const response = await call('GET', repo, `git/ref/tags/${encoded}`);
      if (response.status === 404) return absent();
      const object = response.value?.object;
      if (!sha(object?.sha)) return unknown();
      return result(response.value.ref === `refs/tags/${tag}` &&
        object.type === 'commit' && object.sha === repository.target,
      { ref: response.value.ref, sha: object.sha });
    }
    if (op.kind === 'release') {
      const response = await call('GET', repo, `releases/tags/${encoded}`);
      if (response.status === 404) return absent();
      const native = response.value;
      if (!id(native?.id)) return unknown();
      return result(native.tag_name === tag && native.name === version &&
        native.target_commitish === repository.target && native.draft === false &&
        native.prerelease === version.split('+')[0].includes('-'), { id: native.id });
    }
    if (!id(release?.id)) return unknown();
    const candidates = [];
    for (let page = 1; page <= 100; page++) {
      const response = await call('GET', repo,
        `releases/${release.id}/assets?per_page=100&page=${page}`);
      if (!Array.isArray(response.value)) return unknown();
      candidates.push(...response.value.filter(asset => asset.name === op.name));
      if (response.value.length < 100) break;
      if (page === 100) return unknown();
    }
    if (!candidates.length) return absent();
    if (candidates.length !== 1) return result(false, {});
    const asset = candidates[0];
    if (!id(asset.id)) return unknown();
    const response = await call('GET', repo, `releases/assets/${asset.id}`,
      undefined, true);
    if (!Buffer.isBuffer(response.value)) return unknown();
    return result(asset.state === 'uploaded' && asset.size === response.value.length &&
      digest(response.value) === op.sha256, { id: asset.id, sha256: op.sha256 });
  }
  async function write(value) {
    const { operation: op, repository, release, version } = value;
    const { repo, tag } = context(value);
    let path;
    let body;
    if (op.kind === 'blob') {
      path = 'git/blobs';
      body = { content: op.content, encoding: 'base64' };
    } else if (op.kind === 'tree') {
      path = 'git/trees';
      // Complete root entries preserve all original subtrees and consumer pins.
      body = { tree: op.entries };
    } else if (op.kind === 'commit') {
      path = 'git/commits';
      body = { message: op.message, tree: op.tree, parents: [op.parent],
        author, committer: author };
    } else if (op.kind === 'tag') {
      path = 'git/refs';
      body = { ref: `refs/tags/${tag}`, sha: repository.target };
    } else if (op.kind === 'release') {
      path = 'releases';
      body = { tag_name: tag, target_commitish: repository.target, name: version,
        draft: false, prerelease: version.split('+')[0].includes('-') };
    } else {
      if (!id(release?.id)) throw new Error('PUBLICATION_UNKNOWN');
      path = `releases/${release.id}/assets?name=${encodeURIComponent(op.name)}`;
      body = Buffer.from(op.content, 'base64');
    }
    const response = await call('POST', repo, path, body,
      op.kind === 'asset', op.kind === 'asset');
    const native = response.value;
    const valid = ['blob', 'tree', 'commit'].includes(op.kind) ?
      native?.sha === op.sha : op.kind === 'tag' ?
        native?.object?.sha === repository.target : id(native?.id);
    if (response.status !== 201 || !valid) throw new Error('PUBLICATION_UNKNOWN');
  }
  return Object.freeze({ observe, write });
}
