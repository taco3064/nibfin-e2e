import { generatedPath } from './fixture-definition.mjs';

// Narrow REST adapter for the protected runner. The observation transport stays GET-only.
// No environment, credential discovery, CLI, workflow or worker entry point is provided.
export function fixtureGithub({ token, fetcher = fetch }) {
  if (typeof token !== 'string' || !token) throw new Error('Explicit token required');
  return function session(budget, definition) {
    const root = `https://api.github.com/repos/${definition.repository}`;
    async function request(method, url, body, missing = false) {
      const response = await budget.call(signal => fetcher(url, {
        method, signal, redirect: 'error',
        headers: { accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }).then(async response => ({ status: response.status,
        link: response.headers.get('link'),
        data: response.status === 204 ? null : await response.json() })));
      if (missing && response.status === 404) return null;
      if (response.status < 200 || response.status >= 300) {
        throw new Error('Fixture GitHub request unavailable');
      }
      return response;
    }
    async function collection(path) {
      const items = [];
      for (let page = 1; page <= 20; page++) {
        const separator = path.includes('?') ? '&' : '?';
        const result = await request('GET',
          `${root}/${path}${separator}per_page=100&page=${page}`);
        if (!Array.isArray(result.data)) throw new Error('Incomplete collection');
        items.push(...result.data);
        if (!result.link?.includes('rel="next"')) return items;
      }
      throw new Error('Fixture collection budget exhausted');
    }
    const resourcePath = record => record.kind === 'branch' ?
      `git/ref/heads/${definition.name}` :
      `${record.kind === 'issue' ? 'issues' : 'pulls'}/${record.native.number}`;
    return {
      async preflight() {
        const actor = await request('GET', 'https://api.github.com/user');
        const repository = await request('GET', root);
        if (repository.data.full_name !== definition.repository ||
            repository.data.archived !== false || repository.data.disabled !== false) {
          throw new Error('Fixture target mismatch');
        }
        return actor.data.id;
      },
      async beforeCreate(record) {
        if (record.kind === 'branch') {
          const existing = await request('GET',
            `${root}/git/ref/heads/${definition.name}`, null, true);
          if (existing) throw new Error('Fixture branch already exists');
          const base = await request('GET', `${root}/git/commits/${record.payload.sha}`);
          if (base.data.sha !== record.payload.sha) throw new Error('Base mismatch');
        }
        if (record.kind === 'pull') {
          const branch = await request('GET',
            `${root}/git/ref/heads/${definition.name}`);
          if (branch.data.ref !== `refs/heads/${definition.name}`) {
            throw new Error('Head mismatch');
          }
          const compare = await request('GET', `${root}/compare/` +
            `${encodeURIComponent(record.payload.base)}...` +
            encodeURIComponent(definition.name));
          const files = compare.data.files;
          if (!Array.isArray(files) || files.length === 0 || files.length >= 300 ||
              !Number.isSafeInteger(compare.data.total_commits) ||
              compare.data.total_commits < 1 || compare.data.total_commits > 100 ||
              !files.every(file => generatedPath(definition, file.filename) &&
                (!file.previous_filename ||
                  generatedPath(definition, file.previous_filename)))) {
            throw new Error('Generated file boundary exceeded or incomplete');
          }
        }
      },
      async create(record) {
        const paths = { issue: 'issues', branch: 'git/refs', pull: 'pulls' };
        return (await request('POST', `${root}/${paths[record.kind]}`,
          record.payload)).data;
      },
      async read(record) {
        const result = await request('GET', `${root}/${resourcePath(record)}`,
          null, true);
        if (!result) return { absent: true };
        if (record.kind !== 'branch') return result.data;
        const pulls = await collection('pulls?state=all');
        // Validate association before filtering: missing head data cannot prove
        // that a PR is unrelated to this branch.
        if (pulls.some(pull => typeof pull?.head?.ref !== 'string' ||
            !pull.head.ref || typeof pull.head.repo?.full_name !== 'string' ||
            !/^[\w.-]+\/[\w.-]+$/.test(pull.head.repo.full_name))) {
          throw new Error('Incomplete PR association observation');
        }
        const linked = pulls.filter(pull => pull.head.ref === definition.name &&
          pull.head.repo.full_name === definition.repository);
        // Only explicit null or a native timestamp establishes merge status.
        if (linked.some(pull => pull.merged_at !== null &&
            (typeof pull.merged_at !== 'string' ||
              !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(pull.merged_at) ||
              !Number.isFinite(Date.parse(pull.merged_at))))) {
          throw new Error('Incomplete merge observation');
        }
        return { ...result.data, merged: linked.some(pull => !!pull.merged_at) };
      },
      async dependencies(record) {
        return collection(`issues/${record.native.number}/` +
          'dependencies/blocked_by');
      },
      async mutateIssue(record) {
        const { kind, body, label } = record.mutation;
        const path = `${root}/issues/${record.native.number}`;
        if (kind === 'add-blocked-by') {
          await request('POST', `${path}/dependencies/blocked_by`,
            { issue_id: record.mutation.upstream.id });
        } else if (kind === 'edit-issue-body') {
          await request('PATCH', path, { body });
        } else if (kind === 'add-issue-label') {
          await request('POST', `${path}/labels`, { labels: [label] });
        } else if (kind === 'remove-issue-label') {
          await request('DELETE', `${path}/labels/${encodeURIComponent(label)}`);
        } else throw new Error('Unsupported Issue mutation');
      },
      async cleanup(record) {
        if (record.kind === 'branch') {
          await request('DELETE', `${root}/git/refs/heads/${definition.name}`);
        } else {
          await request('PATCH', `${root}/${resourcePath(record)}`, { state: 'closed' });
        }
      },
    };
  };
}
