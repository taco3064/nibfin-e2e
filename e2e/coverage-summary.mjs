import { safeEvidenceUrl } from './coverage-input.mjs';

// Encode every punctuation character so labels cannot create Markdown or HTML.
const label = value => Array.from(String(value), char =>
  /[a-zA-Z0-9 ]/.test(char) ? char : `&#${char.codePointAt(0)};`).join('');
const percent = value => value === null ? 'unknown' : `${value.toFixed(1)}%`;
function counts(row) {
  return `${row.catalogued} catalogued; ${row.exercised} exercised; ` +
    `${row.passed} passed (${percent(row.passedPercent)})`;
}
export function summarizeCoverage(report) {
  const lines = ['# Behavior coverage', '',
    `Target: current main. Registered scenarios: ${report.registeredScenarios}.`,
    'Local test evidence does not establish live delivery or release success.', ''];
  for (const run of report.environments) {
    lines.push(`## Environment: ${label(run.environment ?? 'unknown')}`, '',
      `Provenance: ${label(run.provenance)}.`,
      `Complete: ${run.complete ? 'yes' : 'no'}; run errors: ${run.errors.length}.`,
      counts(run.totals), '', '| Dimension | Coverage |', '| --- | --- |');
    for (const [dimension, groups] of Object.entries({
      Product: run.byProduct, Category: run.byCategory,
    })) {
      for (const [name, row] of Object.entries(groups)) {
        lines.push(`| ${dimension}: ${label(name)} | ${counts(row)} |`);
      }
    }
    lines.push('', 'Outcomes: ' + Object.entries(run.totals.outcomes).map(
      ([state, count]) => `${label(state)}: ${count}`).join('; '), '');
    for (const behavior of run.behaviors) {
      lines.push(`- ${label(behavior.id)}: ${label(behavior.outcome)}`);
      if (!behavior.scenarios.length) lines.push('  - No mapped scenarios; unverified.');
      for (const scenario of behavior.scenarios) {
        lines.push(`  - ${label(scenario.id)}: ${label(scenario.outcome)}; ` +
          `${scenario.registered ? 'registered' : 'unregistered'}; ` +
          `${scenario.exercised ? 'exercised' : 'exercise unknown'}.`);
        const urls = scenario.evidenceUrls.map(safeEvidenceUrl).filter(Boolean);
        if (!urls.length) lines.push('    - Evidence: unknown.');
        for (const url of urls) lines.push(`    - [GitHub evidence](<${url}>)`);
        if (scenario.rejectedUrls) lines.push('    - Unsafe evidence links filtered.');
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
