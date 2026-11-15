export function safeRunnerInspection(value) {
  return { repository: value.repository, repositoryId: value.repositoryId,
    memberId: value.memberId, runnerId: value.runnerId,
    local: value.local && { agentId: value.local.agentId,
      agentName: value.local.agentName, gitHubUrl: value.local.gitHubUrl },
    native: value.native && { id: value.native.id, name: value.native.name,
      status: value.native.status, busy: value.native.busy,
      labels: value.native.labels?.map(label => ({ name: label.name })) } };
}

// Accept whitespace-separated JSON values, including multiline preflight JSON.
// Do not retain stderr or raw errors, even when a command fails before preview.
export function decodeRunnerCommand({ exitCode, stdout }) {
  if (![0, 1, 2].includes(exitCode) || typeof stdout !== 'string' ||
      stdout.length > 1024 * 1024) throw new Error('RUNNER_OUTPUT_UNAVAILABLE');
  const values = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < stdout.length; i++) {
    const char = stdout[i];
    if (start < 0) {
      if (/\s/.test(char)) continue;
      if (char !== '{') throw new Error('RUNNER_OUTPUT_INVALID');
      start = i;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    if (depth === 0 && !quoted) {
      const value = JSON.parse(stdout.slice(start, i + 1));
      // Only CLI documented bounded outcome fields cross into scenario evidence.
      const safe = {};
      for (const key of ['status', 'command', 'core_binding', 'service_changes',
        'repository', 'protected_execution', 'host_os', 'host_arch', 'code',
        'pull_request', 'shared_host_adoption', 'shared_core_deployment',
        'shared_service_template', 'shared_wake_destination']) {
        if (typeof value[key] === 'string' && value[key].length <= 256) {
          safe[key] = value[key];
        }
      }
      if (Array.isArray(value.shared_runners) && value.shared_runners.length <= 2) {
        safe.shared_runners = value.shared_runners.map(runner => ({
          id: Number.isSafeInteger(runner.id) && runner.id > 0 ? runner.id : null,
          name: typeof runner.name === 'string' && runner.name.length <= 256 ?
            runner.name : null,
          status: ['online', 'offline'].includes(runner.status) ? runner.status : null,
          busy: typeof runner.busy === 'boolean' ? runner.busy : null,
        }));
      }
      if (value.record) safe.record = {
        repository: value.record.repository, repository_id: value.record.repository_id,
        member_id: value.record.member_id, runner_id: value.record.runner_id,
        name: value.record.name, state: value.record.state,
      };
      if (Array.isArray(value.checks)) safe.checks = value.checks.map(check => ({
        name: check.name, status: check.status, code: check.code,
      }));
      if (Array.isArray(value.runners)) safe.runners = value.runners.map(native =>
        safeRunnerInspection({ native }).native);
      values.push(safe);
      start = -1;
    }
  }
  if (start >= 0) throw new Error('RUNNER_OUTPUT_INCOMPLETE');
  return { exit: exitCode, results: values };
}
