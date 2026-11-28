// Proposal R9.52–R9.56: the Dashboard side of the pending resolution stage (R4.40–R4.52).
// Three fixtures reach real resolution states through public triggers: two product-decision
// fixtures (等你選擇; one decided by option, one in the person's own words, R4.51) and an Issue whose Job Core refuses for an invalid `.nibfin.json`
// (需要你處理, as in failure-pending). 自動排除中 is watched for while each waits for its
// record. Reported `waiting` until the stage and its Dashboard are delivered (R8.20).
import type { Locator, Page } from 'playwright-core';
import type { RunContext } from '../../src/types.ts';
import { deleteFile, putFile, whoami } from '../lib/github.ts';
import {
  briefRecord,
  classIn,
  isFinishedRecord,
  pendingAddedAt,
  resolutionGate,
  resolutionRecord,
  resolutionRecords,
} from '../lib/resolution.ts';
import type { ResolutionRecord } from '../lib/resolution.ts';
import { waitFor } from '../lib/wait.ts';
import type { WaitOptions } from '../lib/wait.ts';
import { Checks, describeComments, markerOf, time } from '../lib/analysis.ts';
import type { Comment } from '../lib/analysis.ts';
import { DEADLINE, kitFor, message } from '../lib/issue-kit.ts';
import type { Kit } from '../lib/issue-kit.ts';
import { PENDING_MARKER } from '../lib/marks.ts';
import { awaitDecisionStop, decisionBody, decisionFixture } from './decision.ts';
import {
  autoProblem,
  buttonNamesFromAriaSnapshot,
  causeShown,
  chooseDialogProblems,
  controlsFromAriaSnapshot,
  decisionOption,
  decisionStopNotExercised,
  elementMissing,
  nextStepLines,
  ownWordsComment,
  ownWordsIndex,
  stateOfRecord,
} from './checks.ts';
import type { ResolutionState } from './checks.ts';
import { sleep, until } from './github.ts';
import { READ_ONLY_REPO, readOnlyPrecondition } from './operations.ts';
import type { Secrets } from './support.ts';
import {
  bodyText,
  button,
  closeDialog,
  defineScenario,
  dialog,
  elementState,
  gotoView,
  issueElement,
  issueHistory,
  mustButton,
  openDashboard,
  openPage,
  readAutoShown,
  readUpdateMarker,
  selectRepo,
  startDashboard,
} from './support.ts';

const MIN = 60_000;
const SCENARIO = 'dashboard-resolution';
/** The 「排除」 control on an Issue element. */
export const REPAIR = /排除|^\s*(repair|resolve)\b/i;
/** The control that submits the chosen option. */
const SUBMIT = /^\s*(submit|apply|decide|choose|confirm|send|送出|確認|確定)/i;
/** The only buttons a next-steps dialog may offer (R9.55): closing it, or resume. */
const HANDLE_BUTTONS = /^\s*(close|cancel|done|dismiss|resume|關閉|取消|完成)\b/i;
/** A control that would handle several Issues at once (R9.54 forbids it). */
const BULK = /\b(all|selected|bulk)\b|全部|批次|多選/i;
const WATCH_MS = 3000;
/** The least time between two clicks of a manual view's Refresh control, bounding the Dashboard's extra GitHub reads. */
const REFRESH_MS = 30_000;
const STATE_NAME: Record<ResolutionState, string> = { auto: '自動排除中', choose: '等你選擇', handle: '需要你處理' };

const iso = (t: number | undefined) => (t === undefined ? 'unknown' : new Date(t).toISOString());
const quote = (t: string, max = 300) => `"${t.replace(/\s+/g, ' ').trim().slice(0, max)}"`;

interface Fixture {
  /** What the fixture is for, in messages. */
  name: string;
  n: number;
  title: string;
  pendingAt?: number;
  record?: ResolutionRecord;
  /** The Issue's comments as read when its finished record was seen. */
  comments?: Comment[];
}

/**
 * Refreshes a view marked as manually refreshed (R9.8) with the page's Refresh control, at most
 * once every 30 s, so that Issues filed after the page loaded are shown. A Live view is never
 * refreshed; a view whose marker cannot be read is refreshed like a manual one. The page itself
 * is never reloaded: that would re-send its spent one-time proof (R9.26).
 */
class ViewRefresh {
  private next = 0;
  private count = 0;
  private lastAt: number | undefined;
  private noControl = false;
  private readonly page: Page;
  private readonly view: string;
  private readonly marker: string;

  private constructor(page: Page, view: string, marker: string) {
    this.page = page;
    this.view = view;
    this.marker = marker;
  }

  static async of(page: Page, view: string): Promise<ViewRefresh> {
    const marker = await readUpdateMarker(page).catch(
      (error: unknown) => `unreadable (${briefRecord(message(error), 120)})`,
    );
    return new ViewRefresh(page, view, marker);
  }

  /** Clicks the Refresh control when the view is not Live and the last attempt is 30 s old. */
  async maybe(): Promise<void> {
    if (this.marker === 'live' || Date.now() < this.next) return;
    // Set before awaiting, so watchers reading at the same time share one click.
    this.next = Date.now() + REFRESH_MS;
    const control = await button(this.page, /refresh/i).catch(() => undefined);
    this.noControl = !control;
    if (!control) return;
    // A failed click is not a refresh; the next attempt comes after the interval, as after a click.
    if (!(await control.click().then(() => true, () => false))) return;
    this.count++;
    this.lastAt = Date.now();
    await sleep(3000);
  }

  /** The view, its update marker and how it was refreshed, for messages. */
  describe(): string {
    const head = `${this.view} view, update marker ${this.marker}`;
    if (this.marker === 'live') return `${head}, so it was not refreshed`;
    if (this.noControl) return `${head}, which has no Refresh control, so it was not refreshed`;
    return `${head}, refreshed ${this.count} time(s) by its Refresh control, last at ${iso(this.lastAt)}`;
  }
}

/**
 * Watches one fixture's element every 3 s, refreshing a manual view first, and records each state it shows, with its time.
 * The first time it shows 自動排除中 the Issue is read from GitHub and judged (R9.52).
 */
class StateWatcher {
  readonly seen: { state: ResolutionState | undefined; at: number }[] = [];
  autoAt: number | undefined;
  private stopped = false;
  private readonly done: Promise<void>;
  private readonly page: Page;
  private readonly k: Kit;
  private readonly c: Checks;
  private readonly f: Fixture;
  private readonly refresh: ViewRefresh;

  constructor(page: Page, k: Kit, c: Checks, f: Fixture, refresh: ViewRefresh) {
    this.page = page;
    this.refresh = refresh;
    this.k = k;
    this.c = c;
    this.f = f;
    this.done = this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.refresh.maybe();
        const at = Date.now();
        const { state } = await elementState(this.page, this.f.title);
        if (this.seen.at(-1)?.state !== state) this.seen.push({ state, at });
        if (state === 'auto' && this.autoAt === undefined) {
          this.autoAt = at;
          const h = await issueHistory(this.k.gh, this.k.exec, this.f.n);
          const problem = autoProblem({ labels: h.labels }, h.events, h.comments, at);
          this.c.check(
            'R9.52',
            !problem,
            `the ${this.f.name} fixture #${this.f.n} showed 自動排除中 at ${iso(at)}, but ${problem}`,
          );
        }
      } catch (error) {
        this.k.ctx.log(`${SCENARIO}: state read of #${this.f.n} failed: ${message(error)}`);
      }
      await sleep(WATCH_MS);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.done;
  }

  /** The first time the element showed any state. */
  firstState(): number | undefined {
    return this.seen.find((s) => s.state !== undefined)?.at;
  }

  transitions(): string {
    return this.seen.map((s) => `${s.state ? STATE_NAME[s.state] : 'no state'} at ${iso(s.at)}`).join(', ') || 'none';
  }
}

export type IssueRead = { state: string; labels: string[]; comments: Comment[]; record: ResolutionRecord | undefined };

/** The Issue's state, labels and comments, and its latest resolution record after `pendingAt`. */
function issueRead(k: Kit, n: number, pendingAt: number): () => Promise<IssueRead> {
  return async () => {
    const { data } = await k.gh.rest<{ state: string; labels: { name: string }[] }>(
      'GET',
      `/repos/${k.exec}/issues/${n}`,
    );
    const comments = await k.gh.list<Comment>(`/repos/${k.exec}/issues/${n}/comments`);
    return {
      state: data.state,
      labels: data.labels.map((l) => l.name),
      comments,
      record: resolutionRecord(comments, pendingAt),
    };
  };
}

/**
 * Waits until the latest resolution record after `pendingAt` is finished: it names one of the
 * R4.41 classes (R4.49). The unfinished record shown as 自動排除中 (R9.52) is waited past, and
 * so are its in-place updates (R3.42), since the latest record is taken by last write. Ends
 * early when `pending` goes first or the Issue closes.
 */
export async function awaitRecord(
  read: () => Promise<IssueRead>,
  n: number,
  pendingAt: number,
  options: WaitOptions,
): Promise<IssueRead & { record: ResolutionRecord }> {
  let last: IssueRead | undefined;
  const mins = Math.round(options.deadlineMs / MIN);
  try {
    last = await waitFor(
      async () => (last = await read()),
      (s) => (s.record !== undefined && isFinishedRecord(s.record)) || s.state !== 'open' || !s.labels.includes('pending'),
      options,
    );
  } catch {
    // waitFor's message quotes raw comment text, so it is not reported.
    options.signal?.throwIfAborted();
    const unfinished = last?.record;
    throw new Error(
      unfinished
        ? `the latest resolution record ${unfinished.url} on #${n} never named one of the six R4.41 classes within ${mins} min after pending was added at ${iso(pendingAt)}: ${briefRecord(unfinished.body)}`
        : `no resolution record on #${n} within ${mins} min after pending was added at ${iso(pendingAt)}`,
    );
  }
  const r = last.record;
  if (r && isFinishedRecord(r)) return { ...last, record: r };
  throw new Error(
    `#${n} ${last.state !== 'open' ? 'closed' : 'lost pending'} before ${r ? `its resolution record ${r.url} named a class` : 'a resolution record appeared'} (pending added at ${iso(pendingAt)}; labels [${last.labels.join(', ')}])`,
  );
}

/** Labels, body and comments (ids and update times): what "changes nothing on GitHub" compares (R9.55). */
async function githubState(k: Kit, n: number): Promise<string> {
  const { data } = await k.gh.rest<{ body?: string | null; labels: { name: string }[] }>(
    'GET',
    `/repos/${k.exec}/issues/${n}`,
  );
  const comments = await k.gh.list<Comment>(`/repos/${k.exec}/issues/${n}/comments`);
  return JSON.stringify({
    labels: data.labels.map((l) => l.name).sort(),
    body: data.body ?? '',
    comments: comments.map((x) => [x.id, x.updated_at]),
  });
}

/**
 * The element's state and cause match its record (R9.52), read for up to 90 s after the record,
 * refreshing a manual view; an element still not found is named with the view it was looked for in.
 */
async function checkShown(
  page: Page,
  c: Checks,
  f: Fixture,
  r: ResolutionRecord,
  refresh: ViewRefresh,
): Promise<void> {
  const want = stateOfRecord(r);
  if (!want) {
    c.fail(
      'R9.52',
      `the ${f.name} fixture #${f.n}'s record ${r.url} gives neither options nor next steps, so it gives no state: ${briefRecord(r.body)}`,
    );
    return;
  }
  const shown = await until(
    async () => {
      await refresh.maybe();
      return elementState(page, f.title);
    },
    (x) => x.state === want && (!r.cause || causeShown(x.text, r.cause)),
    90_000,
    WATCH_MS,
  );
  if (!(await issueElement(page, f.title).count())) {
    c.fail('R9.52', elementMissing(f, refresh.describe()));
    return;
  }
  c.check(
    'R9.52',
    shown.state === want,
    `the ${f.name} fixture #${f.n} shows ${shown.state ? STATE_NAME[shown.state] : 'no single state'}, not ${STATE_NAME[want]} as its record ${r.url} gives; element: ${quote(shown.text)}; record: ${briefRecord(r.body)}`,
  );
  if (!r.cause)
    c.fail(
      'R9.52',
      `the ${f.name} fixture #${f.n}'s record ${r.url} gives no one-sentence cause to show (R4.49): ${briefRecord(r.body)}`,
    );
  else
    c.check(
      'R9.52',
      causeShown(shown.text, r.cause),
      `the ${f.name} fixture #${f.n} does not show its record's cause "${briefRecord(r.cause, 120)}"; element: ${quote(shown.text)}`,
    );
}

/**
 * Opens the fixture's 「排除」 dialog and checks its header (R9.53) and that the control is
 * enabled where pause/resume are (R9.56). Returns the dialog and its text.
 */
async function openRepair(
  page: Page,
  c: Checks,
  f: Fixture,
  r: ResolutionRecord,
): Promise<{ d: Locator; text: string }> {
  const el = issueElement(page, f.title);
  const control = await mustButton(el, REPAIR, 'R9.53', `the ${f.name} fixture #${f.n}`);
  const toggle = el.getByRole('button', { name: /^(pause|resume)\b/i }).first();
  const toggleEnabled = (await toggle.count()) > 0 && !(await toggle.isDisabled());
  const disabled = await control.isDisabled();
  c.check(
    'R9.56',
    !(toggleEnabled && disabled),
    `the 「排除」 control of #${f.n} is disabled while its pause/resume control is enabled`,
  );
  if (disabled) throw new Error(`R9.53: the 「排除」 control of #${f.n} is disabled, so its dialog cannot be opened`);
  await control.click();
  const d = await dialog(page);
  await sleep(1000);
  const text = await d.innerText();
  const brief = briefRecord(r.body);
  if (!r.class) c.fail('R9.53', `the record ${r.url} of #${f.n} names no class of R4.41 to show: ${brief}`);
  else
    c.check(
      'R9.53',
      classIn(text) === r.class,
      `the 「排除」 dialog of #${f.n} shows class ${classIn(text) ?? 'none'}, not the record's ${r.class}; dialog: ${quote(text)}`,
    );
  if (!r.cause) c.fail('R9.53', `the record ${r.url} of #${f.n} gives no cause to show: ${brief}`);
  else
    c.check(
      'R9.53',
      causeShown(text, r.cause),
      `the 「排除」 dialog of #${f.n} does not show the record's cause "${briefRecord(r.cause, 120)}"; dialog: ${quote(text)}`,
    );
  c.check(
    'R9.53',
    (await d.locator('a[href*="/actions/runs/"]').count()) > 0,
    `the 「排除」 dialog of #${f.n} has no link to a run log`,
  );
  c.check(
    'R9.53',
    (await d.locator(`a[href*="issuecomment-${r.id}"]`).count()) > 0,
    `the 「排除」 dialog of #${f.n} has no link to the record comment ${r.url}`,
  );
  return { d, text };
}

/** No control that handles several Issues at once in the element or the dialog (R9.54). */
async function bulkControls(scope: Locator): Promise<string[]> {
  const names = buttonNamesFromAriaSnapshot(await scope.ariaSnapshot().catch(() => ''));
  const out = names.filter((x) => BULK.test(x)).map((x) => `button "${x}"`);
  const boxes = await scope.getByRole('checkbox').count();
  if (boxes) out.push(`${boxes} checkbox(es)`);
  return out;
}

/** 需要你處理 (R9.53, R9.55): next steps only, nothing written, then resume removes `pending`. */
async function handleDialog(page: Page, k: Kit, c: Checks, f: Fixture, r: ResolutionRecord): Promise<void> {
  const before = await githubState(k, f.n);
  const { d, text } = await openRepair(page, c, f, r);
  const steps = nextStepLines(r.body);
  if (!steps.length)
    c.fail('R9.55', `the record ${r.url} of #${f.n} has no next-step lines to list: ${briefRecord(r.body)}`);
  else
    c.check(
      'R9.55',
      steps.some((s) => causeShown(text, s)),
      `the 「排除」 dialog of #${f.n} lists none of the record's next steps (${steps
        .slice(0, 3)
        .map((s) => `"${briefRecord(s, 60)}"`)
        .join(', ')}); dialog: ${quote(text)}`,
    );
  for (const role of ['radio', 'textbox', 'checkbox'] as const) {
    const n = await d.getByRole(role).count();
    c.check('R9.55', n === 0, `the next-steps dialog of #${f.n} offers ${n} ${role} control(s)`);
  }
  const extra = buttonNamesFromAriaSnapshot(await d.ariaSnapshot()).filter((x) => !HANDLE_BUTTONS.test(x));
  c.check(
    'R9.55',
    !extra.length,
    `the next-steps dialog of #${f.n} offers actions: ${extra.map((x) => `"${x}"`).join(', ')}`,
  );
  await closeDialog(page);
  await sleep(10_000);
  const after = await githubState(k, f.n);
  c.check(
    'R9.55',
    before === after,
    `opening and closing the next-steps dialog of #${f.n} changed GitHub: before ${briefRecord(before, 200)}; after ${briefRecord(after, 200)}`,
  );

  const clickAt = Date.now();
  await (await mustButton(issueElement(page, f.title), /^resume\b/i, 'R9.55', `the ${f.name} fixture #${f.n}`)).click();
  // The event, not the label: R4.52's rerun may add pending again.
  const removed = await until(
    () =>
      k.gh.list<{ event: string; created_at: string; label?: { name: string } }>(
        `/repos/${k.exec}/issues/${f.n}/events`,
      ),
    (es) =>
      es.some((e) => e.event === 'unlabeled' && e.label?.name === 'pending' && time(e.created_at) >= clickAt - 10_000),
    60_000,
    3000,
  );
  c.check(
    'R9.55',
    removed.some(
      (e) => e.event === 'unlabeled' && e.label?.name === 'pending' && time(e.created_at) >= clickAt - 10_000,
    ),
    `resume on #${f.n} did not remove pending within 60 s of ${iso(clickAt)}`,
  );
}

/** How `chooseDialog` decides: submit the preselected recommended option, or reply in the person's own words (R4.51). */
type ChooseMode = { kind: 'option' } | { kind: 'words'; reply: string };

/** A choice's accessible name: its aria-label, else its label's, parent's or own text. */
const choiceName = (ch: Locator) =>
  ch.evaluate((el) => {
    const e = el as unknown as {
      closest(s: string): { textContent: string | null } | null;
      getAttribute(n: string): string | null;
      textContent: string | null;
      parentElement: { textContent: string | null } | null;
    };
    return (
      e.getAttribute('aria-label') ??
      e.closest('label')?.textContent ??
      e.parentElement?.textContent ??
      e.textContent ??
      ''
    );
  });

/** The dialog's controls for a failure message; an unreadable snapshot reads as no controls. */
const dialogControls = async (d: Locator) => controlsFromAriaSnapshot(await d.ariaSnapshot().catch(() => ''));

/**
 * 等你選擇 (R9.53, R9.54): the record's options with the recommended one selected and a way
 * to reply in the person's own words (R4.51). In `option` mode the preselected option is
 * submitted; in `words` mode the own-words choice, when listed, is selected and the reply
 * typed into an editable field. Either way the decision comment must appear and `pending` go.
 */
async function chooseDialog(
  page: Page,
  k: Kit,
  c: Checks,
  f: Fixture,
  r: ResolutionRecord,
  me: string,
  mode: ChooseMode,
  refresh: ViewRefresh,
): Promise<void> {
  const { d, text } = await openRepair(page, c, f, r);
  const radios = d.getByRole('radio');
  const choices = (await radios.count()) ? radios : d.getByRole('option');
  const count = await choices.count();
  const shown: { name: string; checked: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const ch = choices.nth(i);
    const checked = (await ch.isChecked().catch(() => false)) || (await ch.getAttribute('aria-selected')) === 'true';
    shown.push({ name: await choiceName(ch), checked });
  }
  const view = { text, choices: shown, textboxes: await d.getByRole('textbox').count(), controls: await dialogControls(d) };
  for (const p of chooseDialogProblems(view, r, f.n)) c.check(p.rule, p.ok, p.message);
  const bulk = [...(await bulkControls(d)), ...(await bulkControls(issueElement(page, f.title)))];
  c.check('R9.54', !bulk.length, `the Dashboard offers bulk handling beside 「排除」 on #${f.n}: ${bulk.join(', ')}`);

  if (mode.kind === 'words') {
    const own = ownWordsIndex(shown, r);
    if (own !== undefined) {
      const ch = choices.nth(own);
      await ch.check({ timeout: 10_000 }).catch(() => ch.click({ timeout: 10_000 }));
    }
    const fields = d.getByRole('textbox');
    const editable = async () => {
      for (let i = 0; i < (await fields.count()); i++) if (await fields.nth(i).isEditable().catch(() => false)) return i;
      return undefined;
    };
    const at = await until(editable, (i) => i !== undefined, 10_000, 500);
    if (at === undefined) {
      c.fail(
        'R9.54',
        `the 「排除」 dialog of #${f.n} shows no editable field for an own-words reply after choosing ${own === undefined ? 'nothing' : `"${briefRecord(shown[own]?.name ?? '', 60)}"`}; controls: ${(await dialogControls(d)).join(', ') || 'none'}; dialog: ${quote(await d.innerText().catch(() => text))}`,
      );
      await closeDialog(page);
      return;
    }
    await fields.nth(at).fill(mode.reply);
  }

  const submitAt = Date.now();
  await (await mustButton(d, SUBMIT, 'R9.54', `the 「排除」 dialog of #${f.n}`)).click();
  const isDecision = (x: Comment, records: Comment[]) =>
    x.user?.login === me &&
    time(x.created_at) >= submitAt - 10_000 &&
    !records.some((rc) => rc.id === x.id) &&
    (mode.kind === 'words'
      ? ownWordsComment(x.body ?? '', mode.reply)
      : markerOf(x.body) !== undefined && !PENDING_MARKER.test(markerOf(x.body) ?? ''));
  const read = async () => {
    const h = await issueHistory(k.gh, k.exec, f.n);
    const records = resolutionRecords(h.comments, 0);
    return {
      labels: h.labels,
      comments: h.comments,
      decision: h.comments.find((x) => isDecision(x, records)),
    };
  };
  const got = await until(read, (s) => s.decision !== undefined && !s.labels.includes('pending'), 120_000, 3000);
  // Paused once pending is gone, so the next Shape (R4.51) does not carry the fixture further.
  if (!got.labels.includes('pending')) await k.addLabels(k.exec, f.n, ['pause']);
  if (!got.decision)
    c.fail(
      'R9.54',
      mode.kind === 'words'
        ? `no new comment by ${me} on #${f.n} holding the own-words reply verbatim within 120 s after submitting at ${iso(submitAt)}; comments since: ${describeComments(got.comments.filter((x) => time(x.created_at) >= submitAt - 10_000))}`
        : `no new marked decision comment by ${me} on #${f.n} within 120 s after submitting at ${iso(submitAt)}`,
    );
  else if (mode.kind === 'option') {
    const n = decisionOption(got.decision.body ?? '');
    c.check(
      'R9.54',
      n === undefined || n === r.recommended,
      `the decision comment ${got.decision.html_url} names option ${n}, not the submitted recommended option ${r.recommended}`,
    );
  }
  c.check(
    'R9.54',
    !got.labels.includes('pending'),
    `#${f.n} still has pending 120 s after submitting the decision at ${iso(submitAt)}`,
  );
  const final = await d.innerText().catch(() => '');
  c.check(
    'R9.54',
    !/not confirmed|unconfirmed/i.test(final),
    `the 「排除」 dialog of #${f.n} reports the decision unconfirmed: ${quote(final)}`,
  );
  await closeDialog(page);
  const after = await until(
    async () => {
      await refresh.maybe();
      return issueElement(page, f.title)
        .innerText()
        .catch(() => '');
    },
    (t) => !/\bpending\b/i.test(t),
    90_000,
    WATCH_MS,
  );
  c.check(
    'R9.54',
    !/\bpending\b/i.test(after),
    `the Dashboard still shows #${f.n} with pending 90 s after the decision: ${quote(after)}`,
  );
}

/** R9.56 below triage: every 「排除」 control on the read-only repository is disabled with a reason. */
async function readOnlyRepair(page: Page, ctx: RunContext, c: Checks): Promise<void> {
  try {
    await readOnlyPrecondition(ctx);
  } catch (error) {
    c.fail('R9.56', message(error));
    return;
  }
  await gotoView(page, 'repo');
  await selectRepo(page, READ_ONLY_REPO);
  await page
    .getByRole('button', { name: /^(pause|resume)\b/i })
    .first()
    .waitFor({ state: 'attached', timeout: 60_000 })
    .catch(() => {});
  const controls = page.getByRole('button', { name: REPAIR });
  const n = await controls.count();
  if (!n) {
    c.notExercised(
      'R9.56',
      `no Issue on ${READ_ONLY_REPO} shows a 「排除」 control (none has a resolution state), so the below-triage rule was not seen`,
    );
    return;
  }
  for (let i = 0; i < n; i++)
    c.check(
      'R9.56',
      await controls.nth(i).isDisabled(),
      `a 「排除」 control on ${READ_ONLY_REPO} is enabled below triage`,
    );
  const first = controls.first();
  const why = `${await bodyText(page)} ${(await first.getAttribute('title')) ?? ''} ${(await first.getAttribute('aria-description')) ?? ''}`;
  c.check(
    'R9.56',
    /triage|permission/i.test(why),
    `the disabled 「排除」 on ${READ_ONLY_REPO} gives no reason naming triage or permission`,
  );
}

/** R9.52's 自動排除中 part: reported not exercised when neither fixture was seen in it. */
function autoSeen(c: Checks, watchers: { f: Fixture; w: StateWatcher }[]): void {
  if (watchers.some(({ w }) => w.autoAt !== undefined)) return;
  const times = watchers.map(
    ({ f, w }) =>
      `#${f.n}: pending added ${iso(f.pendingAt)}, record ${iso(f.record?.at)}, first state shown ${iso(w.firstState())} (${w.transitions()})`,
  );
  c.notExercised(
    'R9.52',
    `neither fixture was seen as 自動排除中 while its record was pending, read every ${WATCH_MS / 1000} s: ${times.join('; ')}`,
  );
}

async function run(ctx: RunContext, secrets: Secrets): Promise<string> {
  const c = new Checks();
  const k = kitFor(ctx);
  const exec = k.exec;
  const me = (await whoami(k.gh)).login;
  const notes: string[] = [];
  const watchers: { f: Fixture; w: StateWatcher }[] = [];
  let decision: Fixture | undefined;
  let words: Fixture | undefined;
  let config: Fixture | undefined;
  let filePut = false;
  const dash = await startDashboard(ctx, secrets);
  try {
    const { page } = await openPage(ctx);
    await openDashboard(page, dash);
    // The repo view reads open Issues directly; the person view waits on the search index.
    await gotoView(page, 'repo');
    await selectRepo(page, exec);
    const refresh = await ViewRefresh.of(page, 'repo');

    // 等你選擇: the product-decision fixture.
    const issueD = await k.file(exec, await decisionFixture(k, SCENARIO));
    decision = { name: 'product-decision', n: issueD.number, title: issueD.title };
    const wD = new StateWatcher(page, k, c, decision, refresh);
    watchers.push({ f: decision, w: wD });
    // 等你選擇 decided in the person's own words (R4.51): its own title and code file, so its
    // Issue element and Shape are told apart from the first fixture's. Filed now so both Shapes run together.
    const issueW = await k.file(exec, {
      ...(await decisionFixture(k, SCENARIO)),
      title: 'Add roundHalf in own words',
      body: decisionBody(k.slug('round-words')),
    });
    words = { name: 'own-words decision', n: issueW.number, title: issueW.title };
    const wW = new StateWatcher(page, k, c, words, refresh);
    watchers.push({ f: words, w: wW });
    try {
      await awaitDecisionStop(k, decision.n, k.show(exec, decision.n));
      decision.pendingAt = await pendingAddedAt(k.gh, exec, decision.n);
      const got = await awaitRecord(issueRead(k, decision.n, decision.pendingAt), decision.n, decision.pendingAt, {
        what: `a finished resolution record on #${decision.n}`,
        deadlineMs: DEADLINE.stage,
        intervalMs: 20_000,
        signal: ctx.signal,
      });
      decision.record = got.record;
      decision.comments = got.comments;
    } catch (error) {
      c.fail('R9.52', `the product-decision fixture #${decision.n} reached no finished resolution record: ${message(error)}`);
      await k.pauseOpen(exec, [decision.n]);
    } finally {
      await wD.stop();
    }
    try {
      await awaitDecisionStop(k, words.n, k.show(exec, words.n));
      words.pendingAt = await pendingAddedAt(k.gh, exec, words.n);
      const got = await awaitRecord(issueRead(k, words.n, words.pendingAt), words.n, words.pendingAt, {
        what: `a finished resolution record on #${words.n}`,
        deadlineMs: DEADLINE.stage,
        intervalMs: 20_000,
        signal: ctx.signal,
      });
      words.record = got.record;
      words.comments = got.comments;
    } catch (error) {
      c.fail('R9.52', `the own-words decision fixture #${words.n} reached no finished resolution record: ${message(error)}`);
      await k.pauseOpen(exec, [words.n]);
    } finally {
      await wW.stop();
    }

    // 需要你處理: Core refuses the Job for an invalid .nibfin.json (R7.2), as in failure-pending.
    await putFile(k.gh, exec, '.nibfin.json', '{"tools": 1}\n', `nibfin-e2e ${SCENARIO}: add an invalid .nibfin.json`);
    filePut = true;
    const issueC = await k.file(exec, {
      scenario: SCENARIO,
      title: 'Refused for an invalid .nibfin.json',
      body: 'Fixture for the nibfin-e2e Dashboard resolution scenario. Its Job is refused for an invalid `.nibfin.json`; nothing is to be implemented.',
      labels: ['scope'],
      assignees: [me],
    });
    config = { name: 'invalid-config', n: issueC.number, title: issueC.title };
    const wC = new StateWatcher(page, k, c, config, refresh);
    watchers.push({ f: config, w: wC });
    try {
      const n = config.n;
      await waitFor(
        async () => ({
          labels: (await issueHistory(k.gh, exec, n)).labels,
          comments: await k.gh.list<Comment>(`/repos/${exec}/issues/${n}/comments`),
        }),
        (s) => s.labels.includes('pending') && s.comments.length > 0,
        {
          what: `#${n} to get pending and a comment after its Job was refused`,
          deadlineMs: 15 * MIN,
          intervalMs: 20_000,
          signal: ctx.signal,
        },
      ).catch((error: unknown) => {
        ctx.signal.throwIfAborted();
        throw new Error(`#${n} got no pending with a comment within 15 min: ${message(error).slice(0, 200)}`, {
          cause: error,
        });
      });
      config.pendingAt = await pendingAddedAt(k.gh, exec, n);
      const got = await awaitRecord(issueRead(k, n, config.pendingAt), n, config.pendingAt, {
        what: `a finished resolution record on #${n}`,
        deadlineMs: 15 * MIN,
        intervalMs: 20_000,
        signal: ctx.signal,
      });
      config.record = got.record;
      config.comments = got.comments;
    } catch (error) {
      c.fail('R9.52', `the invalid-config fixture #${config.n} reached no finished resolution record: ${message(error)}`);
    } finally {
      await wC.stop();
    }

    // R9.52: each fixture shows its record's state and cause; every Issue shown as 自動排除中 may be.
    for (const f of [decision, words, config]) if (f.record) await checkShown(page, c, f, f.record, refresh);
    autoSeen(c, watchers);
    const open = await k.gh.list<{ number: number; title: string; pull_request?: unknown }>(
      `/repos/${exec}/issues?state=open`,
    );
    const shownAuto = await readAutoShown(
      page,
      k.gh,
      open.filter((i) => i.pull_request === undefined).map((i) => ({ repo: exec, number: i.number, title: i.title })),
    );
    for (const a of shownAuto)
      c.check(
        'R9.52',
        !a.problem,
        `${exec}#${a.issue.number} is shown as 自動排除中 at ${iso(a.readAt)}, but ${a.problem}`,
      );

    // R9.53, R9.55 on 需要你處理, then the fixture is paused before the configuration is valid again.
    if (config.record) {
      try {
        await handleDialog(page, k, c, config, config.record);
      } catch (error) {
        c.fail('R9.55', message(error));
      }
    }
    await k.pauseOpen(exec, [config.n]);
    await deleteFile(k.gh, exec, '.nibfin.json', `nibfin-e2e ${SCENARIO}: remove the invalid .nibfin.json`);
    filePut = false;

    // R9.53, R9.54 on 等你選擇. A finished record without options is another kind of stop than
    // the product decision the fixture was filed for, so the dialog is not run and its cause is named.
    const tag = k.tag;
    const modes: [Fixture, ChooseMode][] = [
      [decision, { kind: 'option' }],
      // R9.54 with R4.51: a unique reply with no option number (the tag is r plus hex) and no secret.
      [
        words,
        { kind: 'words', reply: `nibfin-e2e ${tag}: decided in my own words, round exact halves to the nearest even integer.` },
      ],
    ];
    for (const [f, mode] of modes) {
      if (!f.record) continue;
      if (!f.record.options.length) {
        c.notExercised('R9.54', decisionStopNotExercised(f, f.record, f.comments ?? []));
        continue;
      }
      try {
        await chooseDialog(page, k, c, f, f.record, me, mode, refresh);
      } catch (error) {
        c.fail('R9.54', message(error));
      }
    }

    // R9.56: the sandbox half ran in openRepair; the below-triage half here.
    await readOnlyRepair(page, ctx, c);
    const reached = (f: Fixture) => {
      if (!f.record) return 'reached no finished record';
      const st = stateOfRecord(f.record);
      return `reached ${st ? STATE_NAME[st] : 'no state'}`;
    };
    notes.push(
      `#${decision.n} ${reached(decision)}, #${words.n} (own words) ${reached(words)}, #${config.n} ${reached(config)}; states seen: ${watchers.map(({ f, w }) => `#${f.n} ${w.transitions()}`).join('; ')}`,
    );
  } finally {
    for (const { w } of watchers) await w.stop();
    await k.pauseOpen(exec, [decision?.n, words?.n, config?.n]);
    if (filePut) {
      try {
        await deleteFile(k.gh, exec, '.nibfin.json', `nibfin-e2e ${SCENARIO}: remove the invalid .nibfin.json`);
      } catch (error) {
        ctx.log(`${SCENARIO}: could not remove the invalid .nibfin.json: ${message(error)}`);
      }
    }
    await dash.stop();
  }
  const out = c.outcome(notes.join('; '));
  if (out.status === 'failed') throw new Error(out.reason);
  return out.reason;
}

export const dashboardResolution = defineScenario({
  id: 'dashboard-resolution',
  rules: ['R9.52', 'R9.53', 'R9.54', 'R9.55', 'R9.56'],
  requires: ['nibfin'],
  gate: (ctx) => resolutionGate(ctx.github, 'dashboard'),
  run,
});
