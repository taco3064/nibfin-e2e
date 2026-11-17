// Comparison and rendering share this allowlist. Never serialize declaration data.
const fields = Object.freeze({
  core: ['repository', 'commit', 'archiveHash', 'manifestHash'],
  action: ['repository', 'commit'],
});
const patterns = Object.freeze({
  repository: /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/,
  commit: /^[a-f0-9]{40}$/,
  archiveHash: /^[a-f0-9]{64}$/,
  manifestHash: /^[a-f0-9]{64}$/,
});
function valid(field, value) {
  return typeof value === 'string' && value.length <= 140 &&
    patterns[field].test(value);
}
function display(field, value) {
  if (value === undefined) return '<missing>';
  return valid(field, value) ? value : '<invalid>';
}
function identity(source) {
  return `${display('repository', source?.repository)}@` +
    display('commit', source?.commit);
}

export function compareSource(declared, expected, context) {
  const { consumer, producer, declaration, kind = 'core' } = context;
  const mismatches = fields[kind].filter(field =>
    !valid(field, declared?.[field]) || !valid(field, expected?.[field]) ||
    declared[field] !== expected[field],
  );
  if (!mismatches.length) return;
  const details = mismatches.map(field =>
    `${field}: declared=${display(field, declared?.[field])} ` +
    `expected=${display(field, expected?.[field])}`,
  ).join('; ');
  const code = kind === 'core' ? 'INCOMPATIBLE_CORE_SOURCE' :
    'INCOMPATIBLE_ACTION_SOURCE';
  throw Object.assign(new Error(
    `${code}: ${declaration}; consumer=${identity(consumer)}; ` +
    `prepared producer=${identity(producer)}; ${details}`,
  ), { code });
}
