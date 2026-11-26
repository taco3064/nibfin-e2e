import type { Outcome, RuleId } from '../../src/types.ts';

/** Collects checks per rule; the outcome lists every check that did not hold, or what was observed. */
export class Checks {
  private readonly items: { rule: RuleId; what: string; ok: boolean; detail: string }[] = [];

  /** Records a check; `detail` says what was observed. Returns `ok`. */
  hold(rule: RuleId, what: string, ok: boolean, detail = ''): boolean {
    this.items.push({ rule, what, ok, detail });
    return ok;
  }

  get failed(): string[] {
    return this.items.filter((i) => !i.ok).map((i) => `${i.rule}: ${i.what}${i.detail ? ` (observed: ${i.detail})` : ''}`);
  }

  outcome(prefix = ''): Outcome {
    const failed = this.failed;
    if (failed.length) return { status: 'failed', reason: `${prefix}${failed.join('; ')}` };
    const seen = this.items.map((i) => `${i.rule}: ${i.what}${i.detail ? ` (${i.detail})` : ''}`);
    return { status: 'passed', reason: `${prefix}${seen.join('; ')}` };
  }
}

/** True when none of the secret values occurs in the text; values are compared in memory and never printed. */
export function freeOfSecrets(text: string, secrets: string[]): boolean {
  return secrets.every((s) => s.length < 8 || !text.includes(s));
}
