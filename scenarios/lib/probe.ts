/**
 * The in-container probe: a POSIX script the fixture commits as `e2e/probe.sh`. The
 * agent runs it in its own shell and pastes the output; it prints `key=value` lines with
 * names, versions and booleans only, never an environment value other than the
 * auto-memory switch.
 */
export const PROBE_SCRIPT = `#!/bin/sh
# nibfin-e2e probe: prints key=value facts about the Job environment. Never prints secrets.
echo "uid=$(id -u)"
for s in /run/podman/podman.sock /var/run/docker.sock /run/docker.sock "\${XDG_RUNTIME_DIR:-/nonexistent}/podman/podman.sock"; do
  if [ -S "$s" ]; then echo "socket=$s"; fi
done
if [ -n "\${DOCKER_HOST+x}" ]; then echo "env_set=DOCKER_HOST"; fi
if [ -n "\${CONTAINER_HOST+x}" ]; then echo "env_set=CONTAINER_HOST"; fi
echo "auto_memory=\${CLAUDE_CODE_DISABLE_AUTO_MEMORY:-unset}"
pid=$$
while [ -n "$pid" ] && [ "$pid" != 0 ]; do
  echo "ancestor=$(cat /proc/$pid/comm 2>/dev/null)"
  pid=$(sed -n 's/^PPid:[[:space:]]*//p' /proc/$pid/status 2>/dev/null)
done
for f in CLAUDE.md .mcp.json .claude/skills/e2e-probe-skill/SKILL.md; do
  if [ -e "$f" ]; then echo "exists:$f=yes"; else echo "exists:$f=no"; fi
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then echo "tracked:$f=yes"; else echo "tracked:$f=no"; fi
done
if [ -f .claude/settings.json ]; then echo "workspace_settings=$(tr -d '\\n' < .claude/settings.json)"; else echo "workspace_settings=absent"; fi
echo "node=$(node --version 2>&1 | head -n 1)"
echo "python=$(python3 --version 2>&1 | head -n 1)"
echo "go=$(go version 2>&1 | head -n 1)"
`;

export type Probe = Map<string, string[]>;

/** The last fenced `e2e-probe` block in the text, as key → values; undefined when there is none. */
export function parseProbe(text: string): Probe | undefined {
  const blocks = [...text.matchAll(/```e2e-probe[^\n]*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1);
  if (!last) return undefined;
  const out: Probe = new Map();
  for (const raw of (last[1] ?? '').split('\n')) {
    const line = raw.trim();
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i);
    out.set(k, [...(out.get(k) ?? []), line.slice(i + 1)]);
  }
  return out;
}

export const first = (p: Probe | undefined, key: string) => p?.get(key)?.[0];
