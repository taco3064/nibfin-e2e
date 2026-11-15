import { FixtureError } from './fixture-errors.mjs';

export function issueMutation(definition, kind, input) {
  if (kind === 'edit-issue-body' && typeof input === 'string' &&
      input.length <= 60000 && !input.includes('\0')) {
    return { kind, body: `${definition.marker}\n${input}` };
  }
  if (kind === 'assign-issue' && validAssignee(input)) {
    return { kind, assignee: { id: input.id, login: input.login } };
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
  if (mutation.kind === 'assign-issue') {
    return Array.isArray(native.assignees) && native.assignees.length === 1 &&
      native.assignees[0].id === mutation.assignee.id &&
      native.assignees[0].login === mutation.assignee.login;
  }
  if (mutation.kind === 'edit-issue-body') return native.body === mutation.body;
  if (!Array.isArray(native.labels) || native.labels.some(label =>
    typeof label?.name !== 'string')) return false;
  const present = native.labels.some(label => label.name === mutation.label);
  return mutation.kind === 'add-issue-label' ? present :
    mutation.kind === 'remove-issue-label' && !present;
}

export function validAssignee(value) {
  return Number.isSafeInteger(value?.id) && value.id > 0 &&
    typeof value.login === 'string' && /^[a-zA-Z0-9-]{1,39}$/.test(value.login);
}

export function preparationObserved(native, preparation) {
  return mutationObserved(native, { kind: 'edit-issue-body',
    body: preparation.body }) && mutationObserved(native, { kind: 'assign-issue',
    assignee: preparation.assignee }) && Array.isArray(native.labels) &&
    !native.labels.some(label => label?.name === 'scope');
}
