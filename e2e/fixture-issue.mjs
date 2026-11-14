import { FixtureError } from './fixture-errors.mjs';

export function issueMutation(definition, kind, input) {
  if (kind === 'edit-issue-body' && typeof input === 'string' &&
      input.length <= 60000 && !input.includes('\0')) {
    return { kind, body: `${definition.marker}\n${input}` };
  }
  if (['add-issue-label', 'remove-issue-label'].includes(kind) &&
      typeof input === 'string' && /^[\w .:-]{1,50}$/.test(input)) {
    return { kind, label: input };
  }
  throw new FixtureError('FIXTURE_INVALID_MUTATION');
}

export function mutationObserved(native, mutation) {
  if (!native || native.absent || native.state !== 'open') return false;
  if (mutation.kind === 'add-blocked-by') {
    return Array.isArray(native.dependencies) &&
      native.dependencies.some(item => item.id === mutation.upstream.id &&
        item.number === mutation.upstream.number);
  }
  if (mutation.kind === 'edit-issue-body') return native.body === mutation.body;
  if (!Array.isArray(native.labels) || native.labels.some(label =>
    typeof label?.name !== 'string')) return false;
  const present = native.labels.some(label => label.name === mutation.label);
  return mutation.kind === 'add-issue-label' ? present :
    mutation.kind === 'remove-issue-label' && !present;
}
