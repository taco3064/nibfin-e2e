const producerIds = Object.freeze(['core', 'action', 'cli']);
const commitPattern = /^[a-f0-9]{40}$/;

// Explicit ref namespaces avoid ambiguous branch/tag names and revision expressions.
export function sourceRevision(value) {
  if (typeof value !== 'string') throw new Error('INVALID_SOURCE_REVISION');
  if (value === 'main' || commitPattern.test(value)) return value;
  const prefix = /^(refs\/heads\/|refs\/tags\/)/.exec(value)?.[0];
  const name = prefix && value.slice(prefix.length);
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) ||
      name.split('/').some(part => !part || part.startsWith('.') ||
        part.endsWith('.') || part.endsWith('.lock')) || name.includes('..')) {
    throw new Error('INVALID_SOURCE_REVISION');
  }
  return value;
}

export function sourceSelection(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('INVALID_SOURCE_SELECTION');
  }
  const selection = {};
  for (const [id, revision] of Object.entries(value)) {
    if (!producerIds.includes(id)) throw new Error(`UNKNOWN_SOURCE: ${id}`);
    selection[id] = sourceRevision(revision);
  }
  return Object.freeze(selection);
}

export function groupArguments(args) {
  const groups = [];
  const selections = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[++index];
    if (!['--group', '--source'].includes(flag) || !value ||
        value.startsWith('--')) {
      throw new Error('Usage: --group NAME ... --source ID=REVISION ...');
    }
    if (flag === '--group') { groups.push(value); continue; }
    const match = /^([^=]+)=([^=]+)$/.exec(value);
    if (!match) throw new Error('INVALID_SOURCE_SELECTION');
    const [, id, revision] = match;
    if (Object.hasOwn(selections, id)) throw new Error(`DUPLICATE_SOURCE: ${id}`);
    Object.defineProperty(selections, id, { value: revision, enumerable: true });
  }
  return { groups, selection: sourceSelection(selections) };
}

export function sourceIdentities(sources) {
  return Object.values(sources).map(({ id, repository, revision, commit }) => ({
    id, repository, revision, commit,
  }));
}
