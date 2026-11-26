// Test hooks the nibfin-e2e harness sets through repository variables. Each rule applies
// only to the change that touches its own `when` file, so it never reaches other work.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const HOLD_LIMIT_MS = 25 * 60 * 1000;
export const HOLD_POLL_MS = 10 * 1000;

/** Runs git and returns its result; never throws. */
export function realGit(args) {
  try {
    return { code: 0, stdout: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message) };
  }
}

/** The paths the triggering event changed. */
function changedPaths(env, git) {
  let args;
  if (env.E2E_EVENT === 'pull_request') args = ['diff', '--name-only', 'HEAD^1', 'HEAD'];
  else if (env.E2E_EVENT === 'push' && env.E2E_BEFORE && !/^0+$/.test(env.E2E_BEFORE)) args = ['diff', '--name-only', env.E2E_BEFORE, 'HEAD'];
  else throw new Error(`cannot compute the changed paths for event ${env.E2E_EVENT || '(none)'} with before ${env.E2E_BEFORE || '(none)'}`);
  const r = git(args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
}

/**
 * Applies the rules in `env.E2E_RULES` (a JSON array; empty or unset passes) and
 * returns the failures. Rule: `{when, event?, attempt?, require?: {file, contains}, holdTag?}`.
 */
export async function evaluate(env, deps = {}) {
  const git = deps.git ?? realGit;
  const readFile = deps.readFile ?? ((file) => readFileSync(file, 'utf8'));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((m) => console.log(m));
  const raw = (env.E2E_RULES ?? '').trim();
  if (!raw) return [];
  const rules = JSON.parse(raw);
  if (!Array.isArray(rules)) throw new Error('E2E_RULES must be a JSON array');
  if (!rules.length) return [];
  const changed = changedPaths(env, git);
  const failures = [];
  for (const rule of rules) {
    if (!changed.has(rule.when)) continue;
    if (rule.event !== undefined && rule.event !== env.E2E_EVENT) continue;
    if (rule.attempt !== undefined && String(rule.attempt) !== String(env.GITHUB_RUN_ATTEMPT)) continue;
    if (rule.require) {
      const { file, contains } = rule.require;
      let text = '';
      try {
        text = readFile(file);
      } catch {
        text = '';
      }
      if (!text.includes(contains)) failures.push(`${file} must mention ${contains} because ${rule.when} changed`);
    }
    if (rule.holdTag) {
      const end = now() + HOLD_LIMIT_MS;
      log(`holding until tag ${rule.holdTag} exists`);
      for (;;) {
        const r = git(['ls-remote', '--tags', 'origin', `refs/tags/${rule.holdTag}`]);
        if (r.code === 0 && r.stdout.trim()) break;
        if (now() >= end) {
          failures.push(`tag ${rule.holdTag} did not appear within 25 minutes`);
          break;
        }
        await sleep(HOLD_POLL_MS);
      }
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const failures = await evaluate(process.env);
    for (const f of failures) console.error(f);
    process.exitCode = failures.length ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
