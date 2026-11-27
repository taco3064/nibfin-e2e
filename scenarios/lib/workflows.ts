/** What the scenarios read from a workflow file, by line; no YAML parser. */
export interface WorkflowRead {
  /** Top-level `name:`, unquoted; undefined when absent. */
  name?: string;
  /** Top-level `run-name:`, unquoted; undefined when absent. */
  runName?: string;
  /** Every `uses:` value. */
  uses: string[];
  /** Every `ghcr.io/taco3064/nibfin…` reference. */
  images: string[];
  /** Every `runs-on:` value, with the lines of a block list or mapping below it joined in. */
  runsOn: string[];
}

const unquote = (v: string) => {
  const t = v.trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
};

const indent = (l: string) => l.length - l.trimStart().length;

export function readWorkflow(text: string): WorkflowRead {
  const lines = text.split(/\r?\n/);
  const out: WorkflowRead = { uses: [], images: [], runsOn: [] };
  lines.forEach((line, i) => {
    let m: RegExpExecArray | null;
    if ((m = /^name:\s*(.*?)\s*$/.exec(line))) out.name ??= unquote(m[1] as string);
    if ((m = /^run-name:\s*(.*?)\s*$/.exec(line))) out.runName ??= unquote(m[1] as string);
    if ((m = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line))) out.uses.push(unquote(m[1] as string));
    if ((m = /^(\s*)(?:-\s+)?runs-on:\s*(.*?)\s*$/.exec(line))) {
      const base = indent(line);
      const parts = [m[2] as string];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] as string;
        if (next.trim() === '' || next.trim().startsWith('#')) continue;
        if (indent(next) <= base) break;
        parts.push(next.trim());
      }
      out.runsOn.push(parts.filter(Boolean).join(' '));
    }
  });
  for (const m of text.matchAll(/ghcr\.io\/taco3064\/nibfin[^\s"'`]*/g)) out.images.push(m[0]);
  return out;
}

/**
 * Replaces each exact `ghcr.io/taco3064/nibfin@<from>` reference with `@<to>` and nothing
 * else (Proposal R5.55: the workflow before an upgrade differs only by its image).
 */
export function repin(text: string, from: string, to: string): { text: string; count: number } {
  const ref = `ghcr.io/taco3064/nibfin@${from}`;
  const parts = text.split(ref);
  return { text: parts.join(`ghcr.io/taco3064/nibfin@${to}`), count: parts.length - 1 };
}
