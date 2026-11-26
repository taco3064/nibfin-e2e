// Proposal R9.14–R9.17, R9.19, R9.1–R9.5, R9.7, R9.8: the three views and what each shows.
import type { Locator, Page } from 'playwright-core';
import type { RunContext } from '../../src/types.ts';
import { check, dateTexts, fail, lightProblem, localeProblems, shiftedBy, stageOf, stateOf, statusValue } from './checks.ts';
import { blockedBy, ensureFixtures, me, sleep, until } from './github.ts';
import type { Fixtures, Issue } from './github.ts';
import {
  bodyText,
  button,
  closeDialog,
  defineScenario,
  dialog,
  escapeRe,
  gotoView,
  issueElement,
  mustButton,
  openDashboard,
  openPage,
  readUpdateMarker,
  repoOptions,
  selectRepo,
  startDashboard,
  statusJson,
} from './support.ts';
import type { Dashboard, View } from './support.ts';

const num = (i: Issue) => `#${i.number}`;
const hasNumber = (text: string, i: Issue) => new RegExp(`#${i.number}\\b`).test(text);

/** Features every Issue element must offer (Proposal R9.19); compared across views. */
export async function issueFeatures(el: Locator, issue: Issue): Promise<Record<string, boolean>> {
  const text = await el.innerText();
  return {
    track: /shape/i.test(text) && /deliver/i.test(text) && /done/i.test(text),
    runs: (await el.getByRole('button', { name: /run/i }).or(el.getByRole('link', { name: /run/i })).count()) > 0,
    toggle: (await el.getByRole('button', { name: /pause|resume/i }).count()) > 0,
    link: (await el.locator(`a[href="${issue.html_url}"]`).count()) > 0,
  };
}

/** The stage the track marks current: aria-current, or "stage: X" text. */
async function currentStage(el: Locator): Promise<string | undefined> {
  const marked = el.locator('[aria-current="step"], [aria-current="true"], [aria-current="page"]');
  if (await marked.count()) return (await marked.first().innerText()).trim() || ((await marked.first().getAttribute('aria-label')) ?? undefined);
  const m = /\b(?:stage|current)\W+(shape|deliver|done)\b/i.exec(await el.innerText());
  return m?.[1];
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
  return until(() => searchSet(ctx), (l) => want.every((u) => l.issues.some((i) => i.html_url === u)), 120_000, 5000);
}

async function searchSet(ctx: RunContext): Promise<Listed> {
  const login = await me(ctx.github);
  const q = encodeURIComponent(`is:issue is:open label:scope assignee:${login}`);
  const { data } = await ctx.github.rest<{ items: { number: number; title: string; html_url: string; repository_url: string; labels: { name: string }[]; id: number; node_id: string; state: string }[] }>(
    'GET',
    `/search/issues?q=${q}&per_page=100`,
  );
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

/** A number near a word in a text: "Shape 3", "3 Shape", "Shape: 3". */
function numberNear(text: string, word: RegExp): number | undefined {
  const w = word.source;
  const m = new RegExp(`(?:${w})\\D{0,16}?(\\d+)|(\\d+)\\D{0,16}?(?:${w})`, 'i').exec(text);
  return m ? Number(m[1] ?? m[2]) : undefined;
}

const CONCLUSIONS: [string, RegExp][] = [
  ['success', /\b(success|succeeded|passed)\b/i],
  ['failure', /\b(failure|failed)\b/i],
  ['cancelled', /\b(cancelled|canceled)\b/i],
  ['skipped', /\bskipped\b/i],
  ['in progress', /\b(in progress|running|queued)\b/i],
];

/** Conclusions of the runs an Issue's run strip lists, read from each run row's text or label. */
async function stripConclusions(page: Page, el: Locator): Promise<string[] | undefined> {
  const strip = el.getByRole('button', { name: /run/i }).first();
  if (!(await strip.count())) return undefined;
  await strip.click();
  await sleep(500);
  const rows = await page
    .locator('a[href*="/actions/runs/"]')
    .filter({ visible: true })
    .evaluateAll((els) => els.map((e) => `${e.closest('li, tr, [role="row"], [role="listitem"]')?.textContent ?? e.textContent ?? ''} ${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('href') ?? ''}`));
  await closeDialog(page);
  await page.keyboard.press('Escape');
  return rows.map((r) => CONCLUSIONS.find(([, re]) => re.test(r))?.[0] ?? `unknown:${r.slice(-80)}`);
}

async function personView(page: Page, ctx: RunContext, f: Fixtures, listed: Issue[], notes: string[]) {
  await gotoView(page, 'person');
  for (const k of ['A', 'B', 'D', 'F', 'P'] as const) await issueElement(page, f[k].title).waitFor({ state: 'visible', timeout: 90_000 }).catch(() => {});
  // R9.14: grouped by repository; Proposal set included, N (no scope) and C (closed) absent.
  const text = await bodyText(page);
  for (const repo of [ctx.sandbox.execution, ctx.sandbox.peer]) check(text.includes(repo), 'R9.14', `a ${repo} group in the person view`, 'no such group heading');
  for (const k of ['A', 'B', 'D', 'F', 'P'] as const) await mustIssue(page, f[k], 'R9.14', 'person view');
  for (const k of ['N', 'C'] as const) check(!text.includes(f[k].title), 'R9.14', `fixture ${k} not in the person view`, 'listed');

  // R9.1: tiles computed from the listed Issues.
  const tiles = page.locator('section, [role="region"], [role="group"], dl, article').filter({ hasText: /open/i }).first();
  const tileText = (await tiles.innerText().catch(() => '')) || text;
  const open = numberNear(tileText, /open(?: issues?)?/);
  check(open === listed.length, 'R9.1', `the open tile to show ${listed.length}`, String(open));
  for (const stage of ['Shape', 'Deliver'] as const) {
    const want = listed.filter((i) => stageOf(i.labels) === stage).length;
    const got = numberNear(tileText, new RegExp(stage));
    check(got === want, 'R9.1', `the stage stack to show ${stage} ${want}`, String(got));
  }
  const held = listed.filter((i) => i.labels.includes('pause') || i.labels.includes('pending'));
  const needs = page.getByRole('button', { name: /intervention|needs (you|attention)/i }).first();
  check(await needs.count(), 'R9.1', 'a clickable needs-intervention tile', 'none');
  const needsN = numberNear(`${await needs.innerText()} ${(await needs.getAttribute('aria-label')) ?? ''}`, /intervention|attention|needs/);
  check(needsN === held.length, 'R9.1', `the needs-intervention count ${held.length}`, String(needsN));
  await needs.click();
  await sleep(800);
  const hrefs = new Set(await page.locator('a[href*="/issues/"]').filter({ visible: true }).evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? '')));
  for (const i of held) check(hrefs.has(i.html_url), 'R9.1', `${i.repo}${num(i)} in the needs-intervention filter`, 'missing');
  for (const i of listed.filter((x) => !held.includes(x))) check(!hrefs.has(i.html_url), 'R9.1', `${i.repo}${num(i)} (no pause or pending) filtered out`, 'still listed');
  await needs.click();
  // Run-conclusion statistics equal the listed Issues' run strips.
  const tally = new Map<string, number>();
  for (const i of listed) {
    const el = issueElement(page, i.title);
    if (!(await el.count())) continue;
    for (const c of (await stripConclusions(page, el)) ?? []) tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  const unknown = [...tally.keys()].filter((c) => c.startsWith('unknown:'));
  check(!unknown.length, 'R9.1', 'each listed run to show its conclusion', unknown.join(' | '));
  for (const [name, re] of CONCLUSIONS) {
    const want = tally.get(name) ?? 0;
    const got = numberNear(tileText, new RegExp(re.source.replace(/\\b/g, '')));
    if (want || got !== undefined) check((got ?? 0) === want, 'R9.1', `the run statistics to show ${want} ${name} (from the listed Issues' run strips)`, String(got));
  }
  check(numberNear(tileText, /online/) !== undefined && numberNear(tileText, /busy/) !== undefined, 'R9.1', 'local Runner online and busy counts', tileText.slice(0, 200));
  check(/\d+(?:\.\d+)?\s*(?:[KMG]i?B|%)/i.test(tileText), 'R9.1', 'the podman machine memory use', tileText.slice(0, 200));
  notes.push(`person view: ${listed.length} open, ${held.length} need intervention, tiles agree`);

  // R9.2, R9.19 on the fixtures.
  const features: Record<string, boolean> = {};
  for (const [k, stage] of [['A', 'Shape'], ['B', 'Deliver'], ['D', 'Shape'], ['F', 'Shape'], ['P', 'Shape']] as const) {
    const el = await mustIssue(page, f[k], 'R9.19', 'person view');
    const feats = await issueFeatures(el, f[k]);
    for (const [name, has] of Object.entries(feats)) check(has, 'R9.19', `fixture ${k} to offer its ${name}`, 'missing');
    Object.assign(features, feats);
    const cur = await currentStage(el);
    check(cur && new RegExp(stage, 'i').test(cur), 'R9.2', `fixture ${k}'s track at ${stage} (labels only)`, String(cur));
    const t = await el.innerText();
    if (f[k].labels.includes('pause')) check(/\bpaused?\b/i.test(t), 'R9.2', `a pause marker on fixture ${k}`, 'none');
    if (f[k].labels.includes('pending')) check(/\bpending\b/i.test(t), 'R9.2', `a pending marker on fixture ${k}`, 'none');
  }
  const waitingB = await (await mustIssue(page, f.B, 'R9.2', 'person view')).innerText();
  check(/waiting on/i.test(waitingB) && hasNumber(waitingB, f.A) && hasNumber(waitingB, f.P), 'R9.2', `B "Waiting on" ${num(f.A)} and ${num(f.P)}`, waitingB.slice(0, 200));
  check(!new RegExp(`waiting on[^\\n]*#${f.C.number}\\b`, 'i').test(waitingB), 'R9.2', 'the closed blocker C not as Waiting on', waitingB.slice(0, 200));
  const waitingF = await (await mustIssue(page, f.F, 'R9.2', 'person view')).innerText();
  check(/waiting on/i.test(waitingF) && hasNumber(waitingF, f.A), 'R9.2', `F "Waiting on" ${num(f.A)}`, waitingF.slice(0, 200));

  // The run strip opens the run list with GitHub run links.
  let runLinks = 0;
  for (const k of ['A', 'B', 'D', 'F', 'P'] as const) {
    const el = issueElement(page, f[k].title);
    const strip = el.getByRole('button', { name: /run/i }).first();
    if (!(await strip.count())) continue;
    await strip.click();
    await sleep(500);
    const links = await page.locator('a[href*="/actions/runs/"]').filter({ visible: true }).evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
    for (const l of links) check(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/.test(l), 'R9.2', 'run links to GitHub run pages', l);
    runLinks += links.length;
    await closeDialog(page);
    await page.keyboard.press('Escape');
  }
  check(runLinks > 0, 'R9.2', 'at least one Nibfin run listed for the fixtures (their label events start route runs)', 'no run links');
  notes.push('Issue elements show track, markers, Waiting on, runs, pause/resume and link');
  return features;
}

async function repoView(page: Page, ctx: RunContext, f: Fixtures, notes: string[]) {
  const exec = ctx.sandbox.execution;
  await gotoView(page, 'repo');
  // R9.16
  const options = await repoOptions(page);
  for (const r of [exec, ctx.sandbox.peer]) check(options.includes(r), 'R9.16', `${r} in the repository list`, options.join(', ') || 'empty');
  for (const r of options) {
    const { status } = await ctx.github.rest('GET', `/repos/${r}/contents/.github/workflows/nibfin-issue.yml`, undefined, [404]);
    check(status === 200, 'R9.16', `${r} listed only if nibfin-issue.yml is on its default branch`, `HTTP ${status}`);
  }

  await selectRepo(page, exec);
  const text = await bodyText(page);
  // R9.15: image and Nibfin-run state; the graph is the main content.
  const digest = String(ctx.facts('nibfin')?.imageDigest ?? '');
  const hex = digest.replace(/^sha256:/, '');
  check(hex && text.includes(hex.slice(0, 12)), 'R9.15', `the image ${digest.slice(0, 19)}… in the repo view`, 'not shown');
  const statusDoc = await statusJson(ctx, exec);
  check(JSON.stringify(statusDoc).includes(hex.slice(0, 12)), 'R9.15', 'status --json to report the same image', 'another image');

  // R9.4: three lights with icon or text, each saying the state status --json reports; R9.15 Nibfin-run state.
  const lights: [string, RegExp, RegExp][] = [
    ['Nibfin run', /nibfin (run|flow)/i, /^(nibfin_?run\w*|nibfinRun\w*|flow\w*|running|ran|run_?(ok|state|status))$/i],
    ['image', /image/i, /^(image_?(state|status|ok|current|latest|up_?to_?date)|imageState|imageStatus|imageCurrent|imageUpToDate)$/i],
    ['Workflows', /workflows?/i, /^(workflows?_?(state|status|ok|current|up_?to_?date)?|workflowsState|workflowsStatus|workflowsOk)$/i],
  ];
  const lightProblems: string[] = [];
  for (const [label, name, key] of lights) {
    const light = page.getByRole('status', { name }).or(page.getByRole('img', { name })).or(page.locator('li, [role="listitem"], div').filter({ hasText: name }).filter({ has: page.locator('svg, [role="img"]') }));
    check(await light.count(), 'R9.4', `a ${label} health light with an icon or text`, 'none');
    const t = `${await light.last().innerText().catch(() => '')} ${(await light.last().getAttribute('aria-label')) ?? ''} ${(await light.last().locator('[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')).join(' ')).catch(() => ''))}`.trim();
    check(t.length > 0, 'R9.4', `the ${label} light to say its state in text or an icon label`, 'colour only');
    const p = lightProblem(label, t, stateOf(statusValue(statusDoc, key)));
    if (p) lightProblems.push(p);
  }
  check(!lightProblems.length, 'R9.4', 'each light to agree with the state status --json reports (R9.15 for the Nibfin run)', lightProblems.join('; '));

  // R9.3: the graph.
  for (const k of ['A', 'B', 'D', 'F', 'N'] as const) {
    const node = page.getByText(new RegExp(`#${f[k].number}\\b|${escapeRe(f[k].title)}`)).first();
    check(await node.count(), 'R9.3', `fixture ${k} as a full node`, 'missing');
  }
  for (const [from, to] of [['B', 'A'], ['B', 'P'], ['F', 'A']] as const) {
    const edge = page.locator('[aria-label]').filter({ hasNot: page.locator('[aria-label]') });
    const labels = await edge.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
    const re = new RegExp(`#?${f[from].number}\\b.*(?:→|->|to|blocked by|depends on|waits on).*#?${f[to].number}\\b`, 'i');
    check(labels.some((l) => re.test(l)), 'R9.3', `an edge from ${from} (${num(f[from])}) to its blocker ${to} (${num(f[to])})`, 'no such edge label');
  }
  const bNode = page.locator('[role="group"], [role="treeitem"], [role="button"], article, li, g').filter({ hasText: new RegExp(`#${f.B.number}\\b`) }).last();
  check(!(await page.getByText(f.C.title).filter({ visible: true }).count()), 'R9.3', 'the closed blocker C collapsed, not a full node', 'shown as a node');
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
  check(before && zoomed && Math.abs(zoomed.width - before.width) > 0.5, 'R9.3', 'zoom to change the node size', JSON.stringify({ before, zoomed }));
  const box = (await page.locator('svg, [role="application"], canvas').first().boundingBox()) ?? { x: 100, y: 200, width: 400, height: 300 };
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 110, box.y + 80, { steps: 5 });
  await page.mouse.up();
  await sleep(300);
  const panned = await anchor.boundingBox();
  check(zoomed && panned && (Math.abs(panned.x - zoomed.x) > 5 || Math.abs(panned.y - zoomed.y) > 5), 'R9.3', 'pan to move the graph', JSON.stringify({ zoomed, panned }));

  // R9.15: Init and Upgrade open with the repository filled in.
  for (const op of [/^init\b/i, /^upgrade\b/i]) {
    await (await mustButton(page, op, 'R9.15', 'the repo view')).click();
    const d = await dialog(page);
    const values = await d.getByRole('textbox').or(d.getByRole('combobox')).evaluateAll((els) => els.map((e) => (e as unknown as { value?: string }).value ?? e.textContent ?? ''));
    check(values.some((v) => v.includes(exec)), 'R9.15', `${op} to open with ${exec} filled in`, values.join(', ') || 'no field');
    await closeDialog(page);
  }

  // R9.16: a not-imported repository typed as OWNER/REPO opens.
  await selectRepo(page, 'octocat/Hello-World');
  check((await bodyText(page)).includes('octocat/Hello-World'), 'R9.16', 'a typed OWNER/REPO to open', 'not shown');
  await selectRepo(page, exec);
  notes.push('repo view: list, image, lights, graph with edges, collapsed blocker, zoom and pan');
}

async function phoneGraph(ctx: RunContext, dash2: Dashboard, f: Fixtures, notes: string[]) {
  const { page } = await openPage(ctx, { width: 390, height: 844 });
  await openDashboard(page, dash2);
  await gotoView(page, 'repo');
  await selectRepo(page, ctx.sandbox.execution);
  const scroll = await page.evaluate(() => {
    const d = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document.documentElement;
    return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth };
  });
  check(scroll.scrollWidth <= scroll.clientWidth, 'R9.3', 'no horizontal scroll at 390 px', JSON.stringify(scroll));
  const boxes: Record<string, { x: number; y: number; width: number; height: number } | null> = {};
  for (const k of ['A', 'B', 'D', 'F', 'N'] as const) {
    const b = await page.getByText(new RegExp(`#${f[k].number}\\b`)).first().boundingBox();
    boxes[k] = b;
    check(b && b.x >= 0 && b.x + b.width <= 390, 'R9.3', `node ${k} within the 390 px width`, JSON.stringify(b));
  }
  const a = boxes.A;
  const b = boxes.B;
  check(a && b && Math.abs(a.y - b.y) > Math.abs(a.x - b.x), 'R9.3', 'B and its blocker A arranged top-down at 390 px', JSON.stringify({ a, b }));
  notes.push('390 px: top-down, no horizontal scroll');
}

async function runnerView(page: Page, ctx: RunContext, notes: string[]) {
  await gotoView(page, 'runner');
  const text = await bodyText(page);
  check(/podman/i.test(text), 'R9.17', 'the podman machine or host state', 'not shown');
  const regs = await ctx.github.list<{ name: string; status: string }>(`/repos/${ctx.sandbox.execution}/actions/runners`, 'runners');
  const states = text.match(/\b(idle|busy|offline)\b/gi) ?? [];
  check(regs.length > 0 && states.length >= regs.length, 'R9.5', `a state (idle, busy or offline) for each of the ${regs.length} Runners`, `${states.length} states shown`);
  check(/\bservice\b/i.test(text), 'R9.17', 'each local Runner service', 'not shown');
  check(/claude[^.]{0,40}(logged in|signed in)|(logged in|signed in)[^.]{0,40}claude/i.test(text), 'R9.17', 'claude logged in', 'not shown');
  for (const op of [/(runner )?add/i, /(runner )?remove/i, /log ?in/i]) await mustButton(page, op, 'R9.17', 'the Runner view');
  const gauge = page.getByRole('meter').or(page.getByRole('progressbar')).or(page.getByRole('img', { name: /memory/i }));
  check(await gauge.count(), 'R9.5', 'a memory gauge', 'none');
  const gaugeText = `${(await gauge.first().getAttribute('aria-valuenow')) ?? ''} ${(await gauge.first().getAttribute('aria-label')) ?? ''} ${await gauge.first().innerText().catch(() => '')}`;
  check(/\d/.test(gaugeText) || /memory[^.]{0,30}\d/i.test(text), 'R9.5', 'a memory value on the gauge', gaugeText);
  check(/24\s*h|24 hours|last day/i.test(text), 'R9.5', 'a 24-hour busy timeline per Runner', 'none');
  notes.push(`Runner view: ${regs.length} Runners, gauge, timeline area, add/remove/login`);
}

/** Date and time texts in the person and Runner views of one browser context. */
async function datesIn(ctx: RunContext, dash: Dashboard, locale: string, timezoneId: string): Promise<string[]> {
  const { page, close } = await openPage(ctx, { locale, timezoneId });
  try {
    await openDashboard(page, dash);
    const out: string[] = [];
    for (const v of ['person', 'runner'] as View[]) {
      await gotoView(page, v);
      const times = await page.locator('time').allInnerTexts();
      const titles = await page.locator('[title]').evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
      out.push(...dateTexts([...times, ...titles, ...(await page.locator('body').innerText()).split('\n')]));
    }
    return out;
  } finally {
    await close();
  }
}

export const dashboardViews = defineScenario({
  id: 'dashboard-views',
  rules: ['R9.14', 'R9.15', 'R9.16', 'R9.17', 'R9.19', 'R9.1', 'R9.2', 'R9.3', 'R9.4', 'R9.5', 'R9.7', 'R9.8'],
  requires: ['nibfin'],
  async run(ctx, secrets) {
    const notes: string[] = [];
    const f = await ensureFixtures(ctx.github, ctx.sandbox);
    for (const [k, b] of [['B', f.A], ['F', f.A]] as const) {
      const have = await blockedBy(ctx.github, f[k]);
      check(have.some((x) => x.id === b.id), 'R9.2', `fixture ${k} Blocked by A on GitHub`, 'missing');
    }
    // The person view lists through native search, whose index lags behind new Issues.
    const listed = (await personSet(ctx, f)).issues;
    // Every page needs its own server: a session proof is exchanged once (R9.26).
    const dash = await startDashboard(ctx, secrets);
    try {
      const { page } = await openPage(ctx);
      await openDashboard(page, dash);
      const markers: Record<string, string> = {};
      const personFeatures = await personView(page, ctx, f, listed, notes);
      markers.person = await readUpdateMarker(page);
      await repoView(page, ctx, f, notes);
      markers.repo = await readUpdateMarker(page);
      // The Runner view shows an Issue only while a Runner is busy with it; dashboard-updates compares it there.
      const repoEl = await mustIssue(page, f.A, 'R9.2', 'repo view');
      const repoFeatures = await issueFeatures(repoEl, f.A);
      check(JSON.stringify(repoFeatures) === JSON.stringify(personFeatures), 'R9.2', 'the same Issue element in the person and repo views', JSON.stringify({ personFeatures, repoFeatures }));
      await runnerView(page, ctx, notes);
      markers.runner = await readUpdateMarker(page);
      notes.push(`update markers: ${Object.entries(markers).map(([k, v]) => `${k} ${v}`).join(', ')}`);
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
    const texts: string[][] = [];
    for (const [locale, tz] of [['zh-TW', 'UTC'], ['de-DE', 'UTC'], ['en-US', 'Asia/Taipei']] as const) {
      const d = await startDashboard(ctx, secrets);
      try {
        texts.push(await datesIn(ctx, d, locale, tz));
      } finally {
        await d.stop();
      }
    }
    const [zh = [], de = [], tpe = []] = texts;
    const problems = localeProblems(zh, de);
    check(!problems.length, 'R9.7', 'one English date and time format whatever the browser locale', problems.join('; '));
    check(shiftedBy(zh, tpe, 8 * 60), 'R9.7', 'times shifted by 8 h in Asia/Taipei against UTC', `[${zh.slice(0, 3).join(' | ')}] vs [${tpe.slice(0, 3).join(' | ')}]`);
    notes.push(`dates: ${zh.length} texts, same under zh-TW and de-DE, shifted in Asia/Taipei`);
    return notes.join('; ');
  },
});
