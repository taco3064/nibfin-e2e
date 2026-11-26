import type { Outcome, RuleId } from '../../src/types.ts';

/** Collects checks per rule; the outcome lists every check that did not hold, or what was observed. */
export class Checks {
  private readonly items: { rule: RuleId; what: string; ok: boolean; detail: string }[] = [];

  /** `secrets` are removed from every printed detail and prefix (see `redact`). */
  private readonly secrets: string[];

  constructor(secrets: string[] = []) {
    this.secrets = secrets;
  }

  /** Records a check; `detail` says what was observed. Returns `ok`. */
  hold(rule: RuleId, what: string, ok: boolean, detail = ''): boolean {
    this.items.push({ rule, what, ok, detail });
    return ok;
  }

  get failed(): string[] {
    return this.items.filter((i) => !i.ok).map((i) => redact(`${i.rule}: ${i.what}${i.detail ? ` (observed: ${i.detail})` : ''}`, this.secrets));
  }

  outcome(prefix = ''): Outcome {
    const failed = this.failed;
    const p = redact(prefix, this.secrets);
    if (failed.length) return { status: 'failed', reason: `${p}${failed.join('; ')}` };
    const seen = this.items.map((i) => redact(`${i.rule}: ${i.what}${i.detail ? ` (${i.detail})` : ''}`, this.secrets));
    return { status: 'passed', reason: `${p}${seen.join('; ')}` };
  }
}

/** True when none of the secret values occurs in the text; values are compared in memory and never printed. */
export function freeOfSecrets(text: string, secrets: string[]): boolean {
  return secrets.every((s) => s.length < 8 || !text.includes(s));
}

/** What replaces a secret value in printed text. */
export const REDACTED = '[secret value removed by nibfin-e2e]';

/** The text with every secret value (8 characters or more, as in `freeOfSecrets`) replaced by `REDACTED`. */
export function redact(text: string, secrets: string[]): string {
  return secrets.reduce((t, s) => (s.length < 8 ? t : t.split(s).join(REDACTED)), text);
}

/** At most `max` characters of `text`, redacted before it is cut so no part of a secret is kept. */
export function excerpt(text: string, max: number, secrets: string[]): string {
  return redact(text, secrets).slice(0, max);
}
