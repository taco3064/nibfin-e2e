import type { ExecResult } from '../../src/host/exec.ts';
import type { Outcome } from '../../src/types.ts';

/** Hides values that must never reach a reason or a log. */
export function redact(text: string): string {
  return text
    .replace(/#proof=[^\s"'&]+/g, '#proof=<hidden>')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '<token>')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '<token>');
}

/** The end of a command's output, for a reason; never the whole output. */
export function tail(r: Pick<ExecResult, 'stdout' | 'stderr'>, max = 600): string {
  const text = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join(' | ');
  return redact(text.length > max ? '…' + text.slice(-max) : text);
}

export const message = (e: unknown): string => redact(e instanceof Error ? e.message : String(e));

/** Collects every mismatch so one run reports all of them. */
export class Check {
  readonly problems: string[] = [];

  /** Records `problem` (prefixed with the rule) when `ok` is false; returns `ok`. */
  that(ok: boolean, rule: string, problem: string): boolean {
    if (!ok) this.problems.push(`${rule}: ${redact(problem)}`);
    return ok;
  }

  fail(rule: string, problem: string): void {
    this.problems.push(`${rule}: ${redact(problem)}`);
  }

  /** Runs a part; a throw becomes a problem of that rule and the remaining parts still run. */
  async part(rule: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.fail(rule, message(error));
    }
  }

  outcome(summary: string): Outcome {
    if (this.problems.length) return { status: 'failed', reason: this.problems.join('; ') };
    return { status: 'passed', reason: summary };
  }
}

/** `failed` with "precondition not reached": the scenario asserts nothing about the product. */
export function precondition(reason: string): Outcome {
  return { status: 'failed', reason: `precondition not reached: ${redact(reason)}` };
}
