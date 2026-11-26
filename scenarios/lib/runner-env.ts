import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../../src/host/exec.ts';

/** A Runner slot's directory (gh-nibfin docs: `${XDG_DATA_HOME:-~/.local/share}/nibfin/runners/<provider>-<n>`). */
export function runnerDir(env: Env, slot: string): string {
  const data = env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.local', 'share');
  return join(data, 'nibfin', 'runners', slot);
}

/** Sets (or, with undefined, removes) `KEY=value` in a `.env` text, keeping every other line. Idempotent. */
export function withEnvLine(text: string, key: string, value: string | undefined): string {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const kept = lines.filter((l) => !l.startsWith(`${key}=`));
  if (value !== undefined) kept.push(`${key}=${value}`);
  return kept.length ? kept.join('\n') + '\n' : '';
}

export function editRunnerEnv(env: Env, slot: string, key: string, value: string | undefined): void {
  const file = join(runnerDir(env, slot), '.env');
  writeFileSync(file, withEnvLine(readFileSync(file, 'utf8'), key, value));
}
