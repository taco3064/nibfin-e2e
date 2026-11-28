// Proposal R9.14–R9.17, R9.19, R9.1–R9.5, R9.7, R9.8: the three views and what each shows.
import type { Locator, Page } from 'playwright-core';
import type { Outcome, RunContext } from '../../src/types.ts';
import { resolutionGate } from '../lib/resolution.ts';
import {
  check,
  countNear,
  needsExpected,
  dateTexts,
  fail,
  hasCount,
  lightProblem,
  localeProblems,
  shiftedBy,
  stageOf,
  stateOf,
  statusValue,
} from './checks.ts';
import { blockedBy, ensureFixtures, me, openIssues, readIssue, sleep, until } from './github.ts';
import type { Fixtures, Issue } from './github.ts';
import {
  bodyText,
  button,
  closeDialog,
  currentStage,
  defineScenario,
  dialog,
  escapeRe,
  gotoView,
  issueElement,
  mustButton,
  openDashboard,
  openPage,
  readAutoShown,
  readUpdateMarker,
  repoOptions,
  selectRepo,
  startDashboard,
  statusJson,
} from './support.ts';
import type { AutoShown, Dashboard, Secrets, View } from './support.ts';
import { READ_ONLY_REPO, REPO_OPERATION, repoOperation } from './operations.ts';

const num = (i: Issue) => `#${i.number}`;
const hasNumber = (text: string, i: Issue) => new RegExp(`#${i.number}\\b`).test(text);

/** How long an Issue element's run strip may take to load, and how often it is read. */
export interface RunStripWait {
  timeoutMs: number;
  everyMs: number;
}

export const RUN_STRIP_WAIT: RunStripWait = { timeoutMs: 30_000, everyMs: 1_000 };

/**
 * An Issue element's run strip after the wait: `shown` when a run control is offered,
 * `loading` when the element still showed its runs loading as the wait ended, `none` when
 * it finished loading without a run control. `strip` is the first run button (the strip).
 */
export interface RunStrip {
  state: 'shown' | 'loading' | 'none';
  waitedMs: number;
  strip?: Locator;
}

// A control named after runs, unless its name itself says the runs are still loading.
const RUN_CONTROL = /^(?!.*\b(?:reading|loading|fetching)\b.*\bruns?\b).*run/is;
// Loading text tied to the word "run", so unrelated loading text does not hold the wait.
const RUNS_LOADING = [/\b(?:reading|loading|fetching)\b[^\n]{0,20}\bruns?\b/i, /\bruns?\b[^\n]{0,20}\bloading\b/i];

/**
 * Waits a bounded time until the element offers a run control or no longer shows its runs
 * loading (an `aria-busy` marker or loading text about runs), so a strip still loading is
 * not mistaken for a missing one. The controls are counted again after the loading reads,
 * so a strip that swaps between loading and its controls within one read is never `none`.
 */
export async function runStrip(el: Locator, wait: RunStripWait = RUN_STRIP_WAIT): Promise<RunStrip> {
  const buttons = el.getByRole('button', { name: RUN_CONTROL });
  const controls = buttons.or(el.getByRole('link', { name: RUN_CONTROL }));
  const start = Date.now();
  const last = await until(
    async () => {
      const count = await controls.count();
      if (count > 0) return { controls: count, loading: false };
      const busy =
        (await el.locator('[aria-busy="true"]').count()) > 0 || (await el.getAttribute('aria-busy')) === 'true';
      const text = await el.innerText();
      // Count again: the strip may have swapped from loading to its controls during the
      // loading reads, which would otherwise read as finished with no control.
      const again = await controls.count();
      if (again > 0) return { controls: again, loading: false };
      return { controls: 0, loading: busy || RUNS_LOADING.some((re) => re.test(text)) };
    },
    (v) => v.controls > 0 || !v.loading,
    wait.timeoutMs,
    wait.everyMs,
  );
  const waitedMs = Date.now() - start;
  if (last.controls > 0)
    return { state: 'shown', waitedMs, strip: (await buttons.count()) ? buttons.first() : undefined };
  return { state: last.loading ? 'loading' : 'none', waitedMs };
}

/** Why an element offers no runs, for the R9.19 failure (R1.14: the lowest-level cause). */
export const runsMissing = (s: RunStrip) =>
  s.state === 'loading'
    ? `run strip still loading after ${Math.round(s.waitedMs / 1000)} s`
    : 'finished loading with no run control';

/**
 * Features every Issue element must offer (Proposal R9.19); compared across views. Every
 * feature is read after the run-strip wait, so each view is compared once it has loaded.
 */
export async function issueFeatures(el: Locator, issue: Issue, strip?: RunStrip): Promise<Record<string, boolean>> {
  const runs = strip ?? (await runStrip(el));
  const text = await el.innerText();
  return {
    track: /shape/i.test(text) && /deliver/i.test(text) && /done/i.test(text),
    runs: runs.state === 'shown',
    toggle: (await el.getByRole('button', { name: /pause|resume/i }).count()) > 0,
    link: (await el.locator(`a[href="${issue.html_url}"]`).count()) > 0,
  };
}

async function mustIssue(page: Page, issue: Issue, rule: string, where: string): Promise<Locator> {
  const el = issueElement(page, issue.title);
  if (!(await el.count())) fail(rule, `${issue.repo}${num(issue)} (${issue.title}) in the ${where}`, 'not listed');
  return el;
}

interface Listed {
  issues: Issue[];
}

/**
 * The Proposal's person-view set: open scope Issues assigned to self (R5.48, R9.14).
 * The search index lags behind new Issues, so it is read until it holds the fixtures.
 */
async function personSet(ctx: RunContext, f: Fixtures): Promise<Listed> {
  const want = [f.A, f.B, f.D, f.F, f.P].map((i) => i.html_url);
  return until(
    () => searchSet(ctx),
    (l) => want.every((u) => l.issues.some((i) => i.html_url === u)),
    120_000,
    5000,
  );
}

async function searchSet(ctx: RunContext): Promise<Listed> {
  const login = await me(ctx.github);
  const q = encodeURIComponent(`is:issue is:open label:scope assignee:${login}`);
  const { data } = await ctx.github.rest<{
    items: {
      number: number;
      title: string;
      html_url: string;
      repository_url: string;
      labels: { name: string }[];
      id: number;
      node_id: string;
      state: string;
    }[];
  }>('GET', `/search/issues?q=${q}&per_page=100`);
  return {
    issues: data.items.map((i) => ({
      id: i.id,
      node_id: i.node_id,
      number: i.number,
      title: i.title,
      state: i.state,
      html_url: i.html_url,
      repo: i.repository_url.replace(/^.*\/repos\//, ''),
      labels: i.labels.map((l) => l.name),
    })),
  };
}

const CONCLUSIONS: [string, RegExp][] = [
  ['success', /\b(success|succeeded|passed)\b/i],
  ['failure', /\b(failure|failed)\b/i],
  ['cancelled', /\b(cancelled|canceled)\b/i],
  ['skipped', /\bskipped\b/i],
  ['in progress', /\b(in progress|running|queued)\b/i],
];

/**
 * The Runs summary tile's legend buckets (Proposal R9.1), each with the strip tally names
 * it sums. The tile shows skipped and cancelled runs as one count.
 */
const RUN_BUCKETS: [string, RegExp, string[]][] = [
  ['succeeded', /succeeded/, ['success']],
  ['failed', /failed/, ['failure']],
  ['running', /running/, ['in progress']],
  ['skipped or cancelled', /skipped or cancell?ed/, ['skipped', 'cancelled']],
];

const quote = (t: string) => `"${t.replace(/\s+/g, ' ').trim().slice(0, 200)}"`;

/**
 * The text of one R9.1 summary tile: the region named by its title. Re-read until it shows
 * a standalone count (the tile may still be loading); never the whole view.
 */
async function summaryTile(page: Page, name: string, title: RegExp): Promise<string> {
  return tileText(await tileRegion(page, name, title));
}

/** The R9.1 summary tile region named by its title; fails R9.1 quoting the summary when absent. */
async function tileRegion(page: Page, name: string, title: RegExp): Promise<Locator> {
  const tile = page.getByRole('region', { name: title }).first();
  if (!(await tile.count())) {
    const group = page.getByRole('group', { name: /summary/i }).first();
    const seen = (await group.count()) ? await group.innerText().catch(() => '') : await bodyText(page);
    fail('R9.1', `a ${name} summary tile`, `none (summary: ${quote(seen)})`);
  }
  return tile;
}

const tileText = (tile: Locator) => until(() => tile.innerText().catch(() => ''), hasCount, 30_000, 1000);

/** The Issue hrefs the page currently shows. */
const visibleHrefs = async (page: Page) =>
  new Set(
    await page
      .locator('a[href*="/issues/"]')
      .filter({ visible: true })
      .evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? '')),
  );

/** Conclusions of the runs an Issue's run strip lists, read from each run row's text or label. */
async function stripConclusions(page: Page, el: Locator): Promise<string[] | undefined> {
  const { strip } = await runStrip(el);
  if (!strip) return undefined;
  await strip.click();
  await sleep(500);
  const rows = await page
    .locator('a[href*="/actions/runs/"]')
    .filter({ visible: true })
    .evaluateAll((els) =>
      els.map(
        (e) =>
          `${e.closest('li, tr, [role="row"], [role="listitem"]')?.textContent ?? e.textContent ?? ''} ${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('href') ?? ''}`,
      ),
    );
  await closeDialog(page);
  await page.keyboard.press('Escape');
  return rows.map((r) => CONCLUSIONS.find(([, re]) => re.test(r))?.[0] ?? `unknown:${r.slice(-80)}`);
}

/**
 * The Issues the person view lists: Issue links on the page whose Issue's title is shown
 * as an Issue element there ("Waiting on" links show only numbers), read back from GitHub.
 */
async function renderedIssues(page: Page, ctx: RunContext): Promise<Issue[]> {
  const hrefs = new Set(
    await page
      .locator('a[href^="https://github.com/"][href*="/issues/"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? '')),
  );
  const out: Issue[] = [];
  for (const href of hrefs) {
    const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/.exec(href);
    if (!m) continue;
    const issue = await readIssue(ctx.github, m[1] as string, Number(m[2]));
    if (await issueElement(page, issue.title).count()) out.push(issue);
  }
  return out;
}

/**
 * R9.1 with R9.52: the expected needs-intervention Issues leave out those the page shows as
 * 自動排除中 that may show it (a Nibfin `pending` with no record older than the Dashboard's lag).
 */
async function expectedNeeds(
  page: Page,
  ctx: RunContext,
  held: Issue[],
): Promise<{ expected: Issue[]; auto: AutoShown<Issue>[] }> {
  const auto = await readAutoShown(
    page,
    ctx.github,
    held.filter((i) => i.labels.includes('pending')),
  );
  return {
    expected: needsExpected(
      held,
      auto.filter((a) => !a.problem).map((a) => a.issue),
    ),
    auto,
  };
}

const describeAuto = (auto: AutoShown<Issue>[]) =>
  auto.length
    ? auto
        .map((a) => `${a.issue.repo}${num(a.issue)} ${a.problem ? `not eligible: ${a.problem}` : 'eligible'}`)
        .join('; ')
    : 'none';

/** `gate` is the resolution Dashboard's delivery gate: while it is set, R9.1 is checked as before R9.52. */
async function personView(page: Page, ctx: RunContext, f: Fixtures, notes: string[], gate: Outcome | undefined) {
  await gotoView(page, 'person');
  for (const k of ['A', 'B', 'D', 'F', 'P'] as const)
    await issueElement(page, f[k].title)
      .waitFor({ state: 'visible', timeout: 90_000 })
      .catch(() => {});
  // R9.14: grouped by repository; Proposal set included, N (no scope) and C (closed) absent.
  const text = await bodyText(page);
  for (const repo of [ctx.sandbox.execution, ctx.sandbox.peer])
    check(text.includes(repo), 'R9.14', `a ${repo} group in the person view`, 'no such group heading');
  for (const k of ['A', 'B', 'D', 'F', 'P'] as const) await mustIssue(page, f[k], 'R9.14', 'person view');
  for (const k of ['N', 'C'] as const)
    check(!text.includes(f[k].title), 'R9.14', `fixture ${k} not in the person view`, 'listed');

  // R9.1: tiles computed from the Issues the page lists, read back from GitHub.
  const listed = await renderedIssues(page, ctx);
  const openTile = await summaryTile(page, 'Open Issues', /^open\b/i);
  const open = countNear(openTile, /open(?: issues?)?/);
  check(
    open === listed.length,
    'R9.1',
    `the open tile to show ${listed.length}`,
    () => `${open} (tile: ${quote(openTile)})`,
  );
  for (const stage of ['Shape', 'Deliver'] as const) {
    const want = listed.filter((i) => stageOf(i.labels) === stage).length;
    const got = countNear(openTile, new RegExp(stage));
    check(got === want, 'R9.1', `the stage stack to show ${stage} ${want}`, () => `${got} (tile: ${quote(openTile)})`);
  }
  const held = listed.filter((i) => i.labels.includes('pause') || i.labels.includes('pending'));
  const needsTile = await tileRegion(page, 'Needs you', /^needs you\b/i);
  let needsText = await tileText(needsTile);
  let needsN = countNear(needsText, /pending or paused/);
  let mustIn = held;
  let autoHeld: Issue[] = [];
  if (gate) {
    check(
      needsN === held.length,
      'R9.1',
      `the needs-intervention count ${held.length}`,
      () => `${needsN} (tile: ${quote(needsText)})`,
    );
  } else {
    // R9.52: 自動排除中 is not counted. The states and the tile are re-read together for up to 60 s (R9.24).
    const end = Date.now() + 60_000;
    let read = await expectedNeeds(page, ctx, held);
    while (needsN !== read.expected.length && Date.now() < end) {
      await sleep(5000);
      read = await expectedNeeds(page, ctx, held);
      needsText = await tileText(needsTile);
      needsN = countNear(needsText, /pending or paused/);
    }
    const { expected, auto } = read;
    check(
      needsN === expected.length,
      'R9.1, R9.52',
      `the needs-intervention count ${expected.length} (${held.length} with pause or pending, less those shown as 自動排除中 and eligible)`,
      () => `${needsN} (tile: ${quote(needsText)}); shown as 自動排除中: ${describeAuto(auto)}`,
    );
    mustIn = expected;
    autoHeld = held.filter((i) => !expected.includes(i));
  }
  const toggle = needsTile.getByRole('button', { name: /show(?:ing)? only these/i }).first();
  check(await toggle.count(), 'R9.1', "the Needs you tile's filter toggle", () => `none (tile: ${quote(needsText)})`);
  const others = listed.filter((x) => !held.includes(x));
  await toggle.click();
  // Issues shown as 自動排除中 (autoHeld) get no assertion either way: no rule says whether the filter shows them.
  const filtered = await until(
    () => visibleHrefs(page),
    (h) => mustIn.every((i) => h.has(i.html_url)) && !others.some((i) => h.has(i.html_url)),
    10_000,
    500,
  );
  for (const i of mustIn)
    check(filtered.has(i.html_url), 'R9.1', `${i.repo}${num(i)} in the needs-intervention filter`, 'missing');
  for (const i of others)
    check(!filtered.has(i.html_url), 'R9.1', `${i.repo}${num(i)} (no pause or pending) filtered out`, 'still listed');
  await toggle.click();
  const restored = await until(
    () => visibleHrefs(page),
    (h) => listed.every((i) => h.has(i.html_url)),
    10_000,
    500,
  );
  for (const i of listed)
    check(
      restored.has(i.html_url),
      'R9.1',
      `${i.repo}${num(i)} listed again after the needs-intervention filter is off`,
      'missing',
    );
  // Run-conclusion statistics equal the listed Issues' run strips.
  const tally = new Map<string, number>();
  for (const i of listed) {
    const el = issueElement(page, i.title);
    if (!(await el.count())) continue;
    for (const c of (await stripConclusions(page, el)) ?? []) tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  const unknown = [...tally.keys()].filter((c) => c.startsWith('unknown:'));
  check(!unknown.length, 'R9.1', 'each listed run to show its conclusion', unknown.join(' | '));
  const runsTile = await summaryTile(page, 'Runs', /^runs?\b/i);
  for (const [name, word, names] of RUN_BUCKETS) {
    const want = names.reduce((n, c) => n + (tally.get(c) ?? 0), 0);
    const got = countNear(runsTile, word);
    if (want || got !== undefined)
      check(
        (got ?? 0) === want,
        'R9.1',
        `the run statistics to show ${want} ${name} (from the listed Issues' run strips)`,
        () => `${got} (tile: ${quote(runsTile)})`,
      );
  }
  const runnersTile = await summaryTile(page, 'Runners', /^runners?\b/i);
  check(
    countNear(runnersTile, /online/) !== undefined && countNear(runnersTile, /busy/) !== undefined,
    'R9.1',
    'local Runner online and busy counts',
    () => `tile: ${quote(runnersTile)}`,
  );
  check(
    /\d+(?:\.\d+)?\s*(?:[KMG]i?B|%)/i.test(runnersTile),
    'R9.1',
    'the podman machine memory use',
    () => `tile: ${quote(runnersTile)}`,
  );
  notes.push(
    `person view: ${listed.length} open, ${mustIn.length} need intervention${autoHeld.length ? ` (${autoHeld.length} more shown as 自動排除中)` : ''}, tiles agree`,
  );

  // R9.2, R9.19 on the fixtures.
  const features: Record<string, boolean> = {};
  for (const [k, stage] of [
    ['A', 'Shape'],
    ['B', 'Deliver'],
    ['D', 'Shape'],
    ['F', 'Shape'],
    ['P', 'Shape'],
  ] as const) {
    const el = await mustIssue(page, f[k], 'R9.19', 'person view');
    const strip = await runStrip(el);
    const feats = await issueFeatures(el, f[k], strip);
    // The element's text is read only for a failure, so a wrong element can be told apart from a missing feature.
    for (const [name, has] of Object.entries(feats))
      if (!has)
        check(
          false,
          'R9.19',
          `fixture ${k} to offer its ${name}`,
          `missing${name === 'runs' ? ` (${runsMissing(strip)})` : ''}; element text: ${quote(await el.innerText())}`,
        );
    Object.assign(features, feats);
    const cur = await currentStage(el);
    check(
      cur && new RegExp(stage, 'i').test(cur),
      'R9.2',
      `fixture ${k}'s track at ${stage} (labels only)`,
      String(cur),
    );
    const t = await el.innerText();
    if (f[k].labels.includes('pause')) check(/\bpaused?\b/i.test(t), 'R9.2', `a pause marker on fixture ${k}`, 'none');
    if (f[k].labels.includes('pending'))
      check(/\bpending\b/i.test(t), 'R9.2', `a pending marker on fixture ${k}`, 'none');
  }
  const waitingB = await (await mustIssue(page, f.B, 'R9.2', 'person view')).innerText();
  check(
    /waiting on/i.test(waitingB) && hasNumber(waitingB, f.A) && hasNumber(waitingB, f.P),
    'R9.2',
    `B "Waiting on" ${num(f.A)} and ${num(f.P)}`,
    waitingB.slice(0, 200),
  );
  check(
    !new RegExp(`waiting on[^\\n]*#${f.C.number}\\b`, 'i').test(waitingB),
    'R9.2',
    'the closed blocker C not as Waiting on',
    waitingB.slice(0, 200),
  );
  const waitingF = await (await mustIssue(page, f.F, 'R9.2', 'person view')).innerText();
  check(
    /waiting on/i.test(waitingF) && hasNumber(waitingF, f.A),
    'R9.2',
    `F "Waiting on" ${num(f.A)}`,
    waitingF.slice(0, 200),
  );

  // The run strip opens the run list with GitHub run links.
  let runLinks = 0;
  for (const k of ['A', 'B', 'D', 'F', 'P'] as const) {
    const { strip } = await runStrip(issueElement(page, f[k].title));
    if (!strip) continue;
    await strip.click();
    await sleep(500);
    const links = await page
      .locator('a[href*="/actions/runs/"]')
      .filter({ visible: true })
      .evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
    for (const l of links)
      check(
        /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/.test(l),
        'R9.2',
        'run links to GitHub run pages',
        l,
      );
    runLinks += links.length;
    await closeDialog(page);
    await page.keyboard.press('Escape');
  }
  check(
    runLinks > 0,
    'R9.2',
    'at least one Nibfin run listed for the fixtures (their label events start route runs)',
    'no run links',
  );
  notes.push('Issue elements show track, markers, Waiting on, runs, pause/resume and link');
  return features;
}

async function repoView(page: Page, ctx: RunContext, f: Fixtures, notes: string[]) {
  const exec = ctx.sandbox.execution;
  await gotoView(page, 'repo');
  // R9.16
  const options = await repoOptions(page);
  for (const r of [exec, ctx.sandbox.peer])
    check(options.includes(r), 'R9.16', `${r} in the repository list`, options.join(', ') || 'empty');
  for (const r of options) {
    const { status } = await ctx.github.rest(
      'GET',
      `/repos/${r}/contents/.github/workflows/nibfin-issue.yml`,
      undefined,
      [404],
    );
    check(status === 200, 'R9.16', `${r} listed only if nibfin-issue.yml is on its default branch`, `HTTP ${status}`);
  }

  await selectRepo(page, exec);
  const text = await bodyText(page);
  // R9.15: image and Nibfin-run state; the graph is the main content.
  const digest = String(ctx.facts('nibfin')?.imageDigest ?? '');
  const hex = digest.replace(/^sha256:/, '');
  check(
    hex && text.includes(hex.slice(0, 12)),
    'R9.15',
    `the image ${digest.slice(0, 19)}… in the repo view`,
    'not shown',
  );
  const statusDoc = await statusJson(ctx, exec);
  check(
    JSON.stringify(statusDoc).includes(hex.slice(0, 12)),
    'R9.15',
    'status --json to report the same image',
    'another image',
  );

  // R9.4: three lights with icon or text, each saying the state status --json reports; R9.15 Nibfin-run state.
  const lights: [string, RegExp, RegExp][] = [
    ['Nibfin run', /nibfin (run|flow)/i, /^(nibfin_?run\w*|nibfinRun\w*|flow\w*|running|ran|run_?(ok|state|status))$/i],
    [
      'image',
      /image/i,
      /^(image_?(state|status|ok|current|latest|up_?to_?date)|imageState|imageStatus|imageCurrent|imageUpToDate)$/i,
    ],
    [
      'Workflows',
      /workflows?/i,
      /^(workflows?_?(state|status|ok|current|up_?to_?date)?|workflowsState|workflowsStatus|workflowsOk)$/i,
    ],
  ];
  const lightProblems: string[] = [];
  for (const [label, name, key] of lights) {
    const light = page
      .getByRole('status', { name })
      .or(page.getByRole('img', { name }))
      .or(
        page
          .locator('li, [role="listitem"], div')
          .filter({ hasText: name })
          .filter({ has: page.locator('svg, [role="img"]') }),
      );
    check(await light.count(), 'R9.4', `a ${label} health light with an icon or text`, 'none');
    const t = `${await light
      .last()
      .innerText()
      .catch(() => '')} ${(await light.last().getAttribute('aria-label')) ?? ''} ${await light
      .last()
      .locator('[aria-label]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')).join(' '))
      .catch(() => '')}`.trim();
    check(t.length > 0, 'R9.4', `the ${label} light to say its state in text or an icon label`, 'colour only');
    const p = lightProblem(label, t, stateOf(statusValue(statusDoc, key)));
    if (p) lightProblems.push(p);
  }
  check(
    !lightProblems.length,
    'R9.4',
    'each light to agree with the state status --json reports (R9.15 for the Nibfin run)',
    lightProblems.join('; '),
  );

  // R9.3: the graph.
  for (const k of ['A', 'B', 'D', 'F', 'N'] as const) {
    const node = page.getByText(new RegExp(`#${f[k].number}\\b|${escapeRe(f[k].title)}`)).first();
    check(await node.count(), 'R9.3', `fixture ${k} as a full node`, 'missing');
  }
  for (const [from, to] of [
    ['B', 'A'],
    ['B', 'P'],
    ['F', 'A'],
  ] as const) {
    const edge = page.locator('[aria-label]').filter({ hasNot: page.locator('[aria-label]') });
    const labels = await edge.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
    const re = new RegExp(
      `#?${f[from].number}\\b.*(?:→|->|to|blocked by|depends on|waits on).*#?${f[to].number}\\b`,
      'i',
    );
    check(
      labels.some((l) => re.test(l)),
      'R9.3',
      `an edge from ${from} (${num(f[from])}) to its blocker ${to} (${num(f[to])})`,
      'no such edge label',
    );
  }
  const bNode = page
    .locator('[role="group"], [role="treeitem"], [role="button"], article, li, g')
    .filter({ hasText: new RegExp(`#${f.B.number}\\b`) })
    .last();
  check(
    !(await page.getByText(f.C.title).filter({ visible: true }).count()),
    'R9.3',
    'the closed blocker C collapsed, not a full node',
    'shown as a node',
  );
  const marker = bNode.getByRole('button', { name: /closed|\+\s*1|1 more|blocker/i }).first();
  check(await marker.count(), 'R9.3', 'a collapsed closed-blocker marker on B', 'none');
  await marker.click();
  await sleep(500);
  check(hasNumber(await bodyText(page), f.C), 'R9.3', `the expanded marker to list C (${num(f.C)})`, 'not listed');
  await page.keyboard.press('Escape');

  const anchor = page.getByText(new RegExp(`#${f.A.number}\\b`)).first();
  const before = await anchor.boundingBox();
  const zoomIn = await button(page, /zoom in|\+/i);
  if (zoomIn) await zoomIn.click();
  else {
    await page.mouse.move(640, 450);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -400);
    await page.keyboard.up('Control');
  }
  await sleep(500);
  const zoomed = await anchor.boundingBox();
  check(
    before && zoomed && Math.abs(zoomed.width - before.width) > 0.5,
    'R9.3',
    'zoom to change the node size',
    JSON.stringify({ before, zoomed }),
  );
  const box = (await page.locator('svg, [role="application"], canvas').first().boundingBox()) ?? {
    x: 100,
    y: 200,
    width: 400,
    height: 300,
  };
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 110, box.y + 80, { steps: 5 });
  await page.mouse.up();
  await sleep(300);
  const panned = await anchor.boundingBox();
  check(
    zoomed && panned && (Math.abs(panned.x - zoomed.x) > 5 || Math.abs(panned.y - zoomed.y) > 5),
    'R9.3',
    'pan to move the graph',
    JSON.stringify({ zoomed, panned }),
  );

  // R9.15: Init and Upgrade open with the repository filled in. Each is looked up where the
  // Dashboard offers it: Upgrade on the execution sandbox, which uses Nibfin (opened first,
  // while it is still selected), and Init on a repository not using Nibfin yet (R9.16).
  const operations: [keyof typeof REPO_OPERATION, string][] = [
    ['upgrade', exec],
    ['init', READ_ONLY_REPO],
  ];
  for (const [op, repo] of operations) {
    await (await repoOperation(page, repo, op, 'R9.15')).click();
    const d = await dialog(page);
    const values = await d
      .getByRole('textbox')
      .or(d.getByRole('combobox'))
      .evaluateAll((els) => els.map((e) => (e as unknown as { value?: string }).value ?? e.textContent ?? ''));
    check(
      values.some((v) => v.includes(repo)),
      'R9.15',
      `${op} to open with ${repo} filled in`,
      values.join(', ') || 'no field',
    );
    await closeDialog(page);
  }

  // R9.16: a not-imported repository typed as OWNER/REPO opens.
  await selectRepo(page, READ_ONLY_REPO);
  check((await bodyText(page)).includes(READ_ONLY_REPO), 'R9.16', 'a typed OWNER/REPO to open', 'not shown');
  await selectRepo(page, exec);
  notes.push('repo view: list, image, lights, graph with edges, collapsed blocker, zoom and pan');
}

async function phoneGraph(ctx: RunContext, dash2: Dashboard, f: Fixtures, notes: string[]) {
  const { page } = await openPage(ctx, { width: 390, height: 844 });
  await openDashboard(page, dash2);
  await gotoView(page, 'repo');
  await selectRepo(page, ctx.sandbox.execution);
  const scroll = await page.evaluate(() => {
    const d = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } })
      .document.documentElement;
    return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth };
  });
  check(scroll.scrollWidth <= scroll.clientWidth, 'R9.3', 'no horizontal scroll at 390 px', JSON.stringify(scroll));
  // Every open Issue of the repository, not only the fixtures.
  for (const i of await openIssues(ctx.github, ctx.sandbox.execution)) {
    const box = await page
      .getByText(new RegExp(`#${i.number}\\b`))
      .first()
      .boundingBox();
    check(
      box && box.x >= 0 && box.x + box.width <= 390,
      'R9.3',
      `the node of open Issue #${i.number} within the 390 px width`,
      JSON.stringify(box),
    );
  }
  const a = await page
    .getByText(new RegExp(`#${f.A.number}\\b`))
    .first()
    .boundingBox();
  const b = await page
    .getByText(new RegExp(`#${f.B.number}\\b`))
    .first()
    .boundingBox();
  check(
    a && b && Math.abs(a.y - b.y) > Math.abs(a.x - b.x),
    'R9.3',
    'B and its blocker A arranged top-down at 390 px',
    JSON.stringify({ a, b }),
  );
  notes.push('390 px: top-down, no horizontal scroll');
}

async function runnerView(page: Page, ctx: RunContext, notes: string[]) {
  await gotoView(page, 'runner');
  const text = await bodyText(page);
  check(/podman/i.test(text), 'R9.17', 'the podman machine or host state', 'not shown');
  const regs = await ctx.github.list<{ name: string; status: string }>(
    `/repos/${ctx.sandbox.execution}/actions/runners`,
    'runners',
  );
  const states = text.match(/\b(idle|busy|offline)\b/gi) ?? [];
  check(
    regs.length > 0 && states.length >= regs.length,
    'R9.5',
    `a state (idle, busy or offline) for each of the ${regs.length} Runners`,
    `${states.length} states shown`,
  );
  check(/\bservice\b/i.test(text), 'R9.17', 'each local Runner service', 'not shown');
  check(
    /claude[^.]{0,40}(logged in|signed in)|(logged in|signed in)[^.]{0,40}claude/i.test(text),
    'R9.17',
    'claude logged in',
    'not shown',
  );
  for (const op of [/(runner )?add/i, /(runner )?remove/i, /log ?in/i])
    await mustButton(page, op, 'R9.17', 'the Runner view');
  const gauge = page
    .getByRole('meter')
    .or(page.getByRole('progressbar'))
    .or(page.getByRole('img', { name: /memory/i }));
  check(await gauge.count(), 'R9.5', 'a memory gauge', 'none');
  const gaugeText = `${(await gauge.first().getAttribute('aria-valuenow')) ?? ''} ${(await gauge.first().getAttribute('aria-label')) ?? ''} ${await gauge
    .first()
    .innerText()
    .catch(() => '')}`;
  check(/\d/.test(gaugeText) || /memory[^.]{0,30}\d/i.test(text), 'R9.5', 'a memory value on the gauge', gaugeText);
  check(/24\s*h|24 hours|last day/i.test(text), 'R9.5', 'a 24-hour busy timeline per Runner', 'none');
  notes.push(`Runner view: ${regs.length} Runners, gauge, timeline area, add/remove/login`);
}

/** Date and time texts in one view of a page. */
async function datesOn(page: Page): Promise<string[]> {
  const times = await page.locator('time').allInnerTexts();
  const titles = await page.locator('[title]').evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
  return dateTexts([...times, ...titles, ...(await page.locator('body').innerText()).split('\n')]);
}

/** Opens one page per context, each on its own server, then reads each view on all pages at the same moment. */
async function datesAtOnce(
  ctx: RunContext,
  secrets: Secrets,
  contexts: { locale: string; timezoneId: string }[],
): Promise<string[][]> {
  const pages: Page[] = [];
  const servers: Dashboard[] = [];
  try {
    for (const c of contexts) {
      const d = await startDashboard(ctx, secrets);
      servers.push(d);
      const { page } = await openPage(ctx, c);
      await openDashboard(page, d);
      pages.push(page);
    }
    const out: string[][] = pages.map(() => []);
    for (const v of ['person', 'runner'] as View[]) {
      await Promise.all(pages.map((p) => gotoView(p, v)));
      await sleep(2000);
      const read = await Promise.all(pages.map(datesOn));
      read.forEach((r, i) => (out[i] as string[]).push(...r));
    }
    return out;
  } finally {
    for (const d of servers) await d.stop();
  }
}

export const dashboardViews = defineScenario({
  id: 'dashboard-views',
  rules: ['R9.14', 'R9.15', 'R9.16', 'R9.17', 'R9.19', 'R9.1', 'R9.2', 'R9.3', 'R9.4', 'R9.5', 'R9.7', 'R9.8'],
  requires: ['nibfin'],
  async run(ctx, secrets) {
    const notes: string[] = [];
    // Until the resolution Dashboard is delivered, R9.1 counts every Issue with pause or pending (R8.20).
    const gate = await resolutionGate(ctx.github, 'dashboard');
    const f = await ensureFixtures(ctx.github, ctx.sandbox);
    for (const [k, b] of [
      ['B', f.A],
      ['F', f.A],
    ] as const) {
      const have = await blockedBy(ctx.github, f[k]);
      check(
        have.some((x) => x.id === b.id),
        'R9.2',
        `fixture ${k} Blocked by A on GitHub`,
        'missing',
      );
    }
    // The person view lists through native search (R5.48), whose index lags behind new Issues.
    await personSet(ctx, f);
    // Every page needs its own server: a session proof is exchanged once (R9.26).
    const dash = await startDashboard(ctx, secrets);
    try {
      const { page } = await openPage(ctx);
      await openDashboard(page, dash);
      const markers: Record<string, string> = {};
      const personFeatures = await personView(page, ctx, f, notes, gate);
      markers.person = await readUpdateMarker(page);
      await repoView(page, ctx, f, notes);
      markers.repo = await readUpdateMarker(page);
      // The Runner view shows an Issue only while a Runner is busy with it; dashboard-updates (also R9.2) compares it there.
      const repoEl = await mustIssue(page, f.A, 'R9.2', 'repo view');
      const repoFeatures = await issueFeatures(repoEl, f.A);
      check(
        JSON.stringify(repoFeatures) === JSON.stringify(personFeatures),
        'R9.2',
        'the same Issue element in the person and repo views',
        JSON.stringify({ personFeatures, repoFeatures }),
      );
      await runnerView(page, ctx, notes);
      markers.runner = await readUpdateMarker(page);
      notes.push(
        `update markers: ${Object.entries(markers)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}`,
      );
    } finally {
      await dash.stop();
    }

    const dash2 = await startDashboard(ctx, secrets);
    try {
      await phoneGraph(ctx, dash2, f, notes);
    } finally {
      await dash2.stop();
    }

    // R9.7: same format under two locales; shifted by the zone difference in a third context.
    const texts = await datesAtOnce(ctx, secrets, [
      { locale: 'zh-TW', timezoneId: 'UTC' },
      { locale: 'de-DE', timezoneId: 'UTC' },
      { locale: 'en-US', timezoneId: 'Asia/Taipei' },
    ]);
    const [zh = [], de = [], tpe = []] = texts;
    const problems = localeProblems(zh, de);
    check(
      !problems.length,
      'R9.7',
      'one English date and time format whatever the browser locale',
      problems.join('; '),
    );
    check(
      shiftedBy(zh, tpe, 8 * 60),
      'R9.7',
      'times shifted by 8 h in Asia/Taipei against UTC',
      `[${zh.slice(0, 3).join(' | ')}] vs [${tpe.slice(0, 3).join(' | ')}]`,
    );
    notes.push(`dates: ${zh.length} texts, same under zh-TW and de-DE, shifted in Asia/Taipei`);
    return notes.join('; ');
  },
});
