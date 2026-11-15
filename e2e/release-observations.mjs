import { sourceRepositories } from './source-checkout.mjs';

// The protected caller supplies observation credentials, never scenario input.
export function releaseObservations(request, observeActivePublications) {
  const read = async path => {
    const result = await request(new URL(path, 'https://api.github.com'), {
      signal: AbortSignal.timeout(15_000),
    });
    if (result.status !== 200 || result.data === null) {
      throw new Error('OBSERVATION_UNAVAILABLE');
    }
    return result.data;
  };
  const enumerate = async path => {
    const rows = [];
    // Bound pathological/unstable pagination; reaching the bound proves nothing.
    for (let page = 1; page <= 1000; page++) {
      const batch = await read(`${path}?per_page=100&page=${page}`);
      if (!Array.isArray(batch) || batch.length > 100) {
        throw new Error('OBSERVATION_INCOMPLETE');
      }
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
    throw new Error('OBSERVATION_INCOMPLETE');
  };
  return {
    observeMains: () => Promise.all(sourceRepositories.map(async source => {
      const branch = await read(`/repos/${source.repository}/git/ref/heads/main`);
      return { repository: source.repository, complete: true,
        ref: branch.ref, commit: branch.object?.sha };
    })),
    observeConflicts: version => Promise.all(sourceRepositories.map(async source => {
      const root = `/repos/${source.repository}`;
      const tags = await enumerate(`${root}/tags`);
      // Unlike releases/tags, this authenticated list includes draft Releases.
      const releases = await enumerate(`${root}/releases`);
      if (tags.some(row => typeof row?.name !== 'string') ||
          releases.some(row => typeof row?.tag_name !== 'string')) {
        throw new Error('OBSERVATION_INCOMPLETE');
      }
      const activity = await observeActivePublications(source.repository);
      if (!Array.isArray(activity) || activity.some(value =>
        typeof value !== 'string' || !value.trim())) {
        throw new Error('OBSERVATION_INCOMPLETE');
      }
      const aliases = [version, `v${version}`];
      return { repository: source.repository, version, complete: true,
        tags: tags.map(row => row.name).filter(name => aliases.includes(name)),
        releases: releases.map(row => row.tag_name)
          .filter(name => aliases.includes(name)),
        activePublications: activity };
    })),
  };
}
