import { repositorySeed } from './repository-definition.mjs';

// Only composed by the protected User adapter; no Installation credentials.
export function repositoryGithub(request) {
  const root = record => `https://api.github.com/repos/${record.repository}`;
  const branch = record => encodeURIComponent(record.native.defaultBranch);
  return {
    async observe(record) {
      const result = await request('GET', root(record), null, true);
      if (result === null) return null;
      if (!result?.data || typeof result.data !== 'object') {
        throw new Error('Repository observation incomplete');
      }
      return result.data;
    },
    async createRepository(record, definition) {
      return (await request('POST', 'https://api.github.com/user/repos', {
        name: record.repository.split('/')[1], description: definition.marker,
        private: true, auto_init: true,
      })).data;
    },
    async seedObserved(record) {
      // Pin all content reads to the same observed commit.
      const ref = await request('GET', `${root(record)}/git/ref/heads/` + branch(record));
      const sha = ref.data?.object?.sha;
      if (!/^[a-f0-9]{40}$/.test(sha ?? '')) return false;
      for (const [path, content] of Object.entries(repositorySeed)) {
        const result = await request('GET', `${root(record)}/contents/${path}` +
          `?ref=${sha}`, null, true);
        if (result?.data?.type !== 'file' || result.data.encoding !== 'base64' ||
            Buffer.from(result.data.content ?? '', 'base64').toString() !== content) {
          return false;
        }
      }
      return true;
    },
    async seedRepository(record) {
      const base = root(record);
      const ref = await request('GET', `${base}/git/ref/heads/${branch(record)}`);
      const parent = ref.data?.object?.sha;
      if (!/^[a-f0-9]{40}$/.test(parent ?? '')) throw new Error('Seed unavailable');
      const commit = await request('GET', `${base}/git/commits/${parent}`);
      const baseTree = commit.data?.tree?.sha;
      if (!/^[a-f0-9]{40}$/.test(baseTree ?? '')) throw new Error('Seed unavailable');
      const tree = await request('POST', `${base}/git/trees`, {
        base_tree: baseTree,
        tree: Object.entries(repositorySeed).map(([path, content]) =>
          ({ path, content, mode: '100644', type: 'blob' })),
      });
      if (!/^[a-f0-9]{40}$/.test(tree.data?.sha ?? '')) {
        throw new Error('Seed unavailable');
      }
      const seeded = await request('POST', `${base}/git/commits`, {
        message: 'Seed disposable Nibfin project', tree: tree.data.sha,
        parents: [parent],
      });
      if (!/^[a-f0-9]{40}$/.test(seeded.data?.sha ?? '')) {
        throw new Error('Seed unavailable');
      }
      await request('PATCH', `${base}/git/refs/heads/${branch(record)}`, {
        sha: seeded.data.sha, force: false,
      });
    },
  };
}
