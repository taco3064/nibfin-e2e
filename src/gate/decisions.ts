/** One decision the gate made, with its reason; the run summary lists every one. */
export interface Decision {
  subject: string;
  decision: string;
  reason: string;
}

/** A table cell: one line, pipes and backticks escaped, capped. */
function cell(text: string): string {
  const one = text.replace(/\r?\n/g, ' ⏎ ').replace(/\|/g, '\\|').replace(/`/g, "'");
  return one.length > 500 ? one.slice(0, 500) + ' …' : one;
}

/** The decisions as a Markdown table for `$GITHUB_STEP_SUMMARY`. */
export function decisionTable(title: string, decisions: Decision[]): string {
  const rows = decisions.map((d) => `| ${cell(d.subject)} | ${cell(d.decision)} | ${cell(d.reason)} |`);
  return [`## ${title}`, '', '| Subject | Decision | Reason |', '|---|---|---|', ...rows, ''].join('\n');
}
