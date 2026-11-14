import test from 'node:test';
import assert from 'node:assert/strict';
import { githubObserver } from '../github-observer.mjs';
import { githubTransport } from '../github-transport.mjs';
import { assertObservation, confirmed } from '../github-assertions.mjs';

const base = 'https://api.github.com/repos/owner/repo';
const issue = { repository: 'owner/repo', kind: 'issue', number: 24 };
const pull = { ...issue, kind: 'pull' };
const sha = 'a'.repeat(40);
const jobs = {
  repository: 'owner/repo', kind: 'jobs', runId: 10, attempt: 2, sha,
};
const checks = { repository: 'owner/repo', kind: 'checks', sha };
const run = { ...jobs, kind: 'run' };
const ok = data => ({ status: 200, data });
const nativeIssue = {
  id: 1, number: 24, url: `${base}/issues/24`, state: 'closed',
  state_reason: 'completed',
};
const job = {
  id: 3, url: `${base}/actions/jobs/3`, run_id: 10, run_attempt: 2,
  head_sha: sha, status: 'completed', conclusion: 'success',
};
const check = { ...job, url: `${base}/check-runs/3` };
const nativeRun = {
  ...job, id: 10, url: `${base}/actions/runs/10`,
  repository: { full_name: 'owner/repo' },
};
function fake(responses) {
  let calls = 0;
  const provider = async () => responses[Math.min(calls++, responses.length - 1)];
  provider.calls = () => calls;
  return provider;
}
const bounds = { maxRequests: 3, intervalMs: 1, timeoutMs: 200 };
const observe = provider => githubObserver(provider, bounds);
const success = { ids: [3], conclusion: 'success' };

test('native closure and reason are explicit, independent of CI and merge', async () => {
  const closed = await observe(fake([ok(nativeIssue)]))(issue);
  assert.equal(confirmed(assertObservation(closed,
    { closed: true, stateReason: 'completed' })), true);
  assert.equal(assertObservation(closed, { merged: true }).state, 'unknown');
  assert.equal(assertObservation(closed,
    { closed: true, stateReason: 'not_planned' }).state, 'contradicted');
  const green = await observe(fake([ok(nativeRun)]))(run);
  assert.equal(assertObservation(green, { conclusion: 'success' }).state, 'satisfied');
  assert.equal(confirmed(assertObservation(green, { merged: true })), false);
  assert.equal(confirmed(assertObservation(green, { closed: true })), false);
  const pr = await observe(fake([ok({ ...nativeIssue,
    url: `${base}/pulls/24`, merged: false })]))(pull);
  assert.equal(assertObservation(pr, { merged: true }).state, 'contradicted');
  const merged = await observe(fake([ok({ ...pr.data, merged: true })]))(pull);
  assert.equal(assertObservation(merged, { merged: true }).state, 'satisfied');
});

test('delayed jobs and terminal runs can eventually satisfy expectations', async () => {
  const provider = fake([
    ok({ total_count: 0, jobs: [] }),
    ok({ total_count: 1, jobs: [{ ...job, status: 'in_progress' }] }),
    ok({ total_count: 1, jobs: [job] }),
  ]);
  const result = await observe(provider)(jobs, success);
  assert.equal(result.assertion.state, 'satisfied');
  assert.equal(provider.calls(), 3);
  const pending = { ...nativeRun, status: 'queued', conclusion: null };
  const terminal = await observe(fake([ok(pending), ok(nativeRun)]))(
    run, { conclusion: 'success' });
  assert.equal(terminal.assertion.state, 'satisfied');
  const failed = await observe(fake([ok({ ...nativeRun, conclusion: 'failure' })]))(
    run, { conclusion: 'success' });
  assert.equal(failed.assertion.state, 'contradicted');
});

test('pagination completes or reports incomplete coverage', async () => {
  const second = { ...job, id: 4, url: `${base}/actions/jobs/4` };
  const first = { ...ok({ total_count: 2, jobs: [job] }),
    headers: { link: `<${base}/actions/runs/10/attempts/2/jobs?page=2>; rel="next"` } };
  const result = await observe(fake([first,
    ok({ total_count: 2, jobs: [second] })]))(jobs);
  assert.equal(result.complete, true);
  for (const response of [
    ok({ total_count: 2, jobs: [job] }),
    { ...first, headers: { link: '<https://evil.test/jobs>; rel="next"' } },
  ]) {
    const result = await observe(fake([response]))(jobs);
    assert.equal(result.complete, false);
    assert.equal(confirmed(assertObservation(result, success)), false);
  }
  const limited = await githubObserver(fake([first]), { maxPages: 1 })(jobs);
  assert.equal(limited.reason, 'page-budget-exhausted');
  const failed = await observe(fake([first, { status: 503 }]))(jobs);
  assert.equal(failed.complete, false);
});

test('missing checks and exhausted pending results never confirm success', async () => {
  const absent = await observe(fake([ok({ total_count: 0, check_runs: [] })]))(
    checks, success);
  assert.equal(absent.assertion.state, 'unknown');
  assert.equal(absent.requests, 3);
  const present = await observe(fake([ok({ total_count: 1, check_runs: [check] })]))(
    checks, success);
  assert.equal(present.assertion.state, 'satisfied');
});

test('wrong repository, number, run, attempt and commit are rejected', async () => {
  const cases = [
    [issue, { ...nativeIssue, number: 25 }],
    [pull, { ...nativeIssue, url: `${base}/pulls/25`, merged: true }],
    [run, { ...nativeRun, repository: { full_name: 'other/repo' } }],
    [run, { ...nativeRun, run_attempt: 1 }],
    [run, { ...nativeRun, url: `${base}/actions/runs/11` }],
    [jobs, { total_count: 1, jobs: [{ ...job, run_id: 11 }] }],
    [jobs, { total_count: 1, jobs: [{ ...job, run_attempt: 1 }] }],
    [checks, { total_count: 1, check_runs: [{ ...check, head_sha: 'b'.repeat(40) }] }],
  ];
  for (const [target, data] of cases) {
    assert.equal((await observe(fake([ok(data)]))(target)).reason,
      'identity-mismatch');
  }
});

test('denied, missing, malformed and unavailable diagnostics are sanitized', async () => {
  for (const [response, reason] of [
    [{ status: 403, data: 'SECRET' }, 'denied'],
    [{ status: 404 }, 'missing'], [{ status: 503 }, 'unavailable'],
    [{ data: 'SECRET' }, 'malformed'],
  ]) {
    const result = await observe(fake([response]))(issue);
    assert.equal(result.reason, reason);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
  }
  const result = await observe(async () => { throw new Error('SECRET'); })(issue);
  assert.equal(result.reason, 'unavailable');
});

test('rate limits retry within budget and honor retry information', async () => {
  const provider = fake([
    { status: 429, headers: { 'retry-after': '0.01' } }, ok(nativeIssue),
  ]);
  const start = performance.now();
  const recovered = await observe(provider)(issue, { closed: true });
  assert.equal(recovered.assertion.state, 'satisfied');
  assert.equal(provider.calls(), 2);
  assert.ok(performance.now() - start >= 9);
  const exhausted = await observe(fake([
    { status: 403, headers: {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 60),
    } },
  ]))(issue);
  assert.equal(exhausted.reason, 'rate-limited');
});

test('individual hung providers are bounded even when they ignore abort', async () => {
  const result = await githubObserver(() => new Promise(() => {}), {
    requestTimeoutMs: 10, timeoutMs: 30,
  })(issue);
  assert.equal(result.reason, 'unavailable');
});

test('expectation polling stops when a provider retry wait exceeds its budget',
  async () => {
    const reset = String(Math.ceil(Date.now() / 1000) + 60);
    for (const response of [
      { status: 429, headers: { 'retry-after': '60' } },
      { status: 403, headers: {
        'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset,
      } },
    ]) {
      const provider = fake([response, ok(nativeIssue)]);
      const result = await observe(provider)(issue, { closed: true });
      assert.equal(provider.calls(), 1);
      assert.equal(result.requests, 1);
      assert.equal(result.complete, false);
      assert.equal(result.reason, 'rate-limited');
      assert.equal(result.assertion.state, 'unknown');
      assert.equal(confirmed(result.assertion), false);
    }
  });

test('transport only GETs and rejects unsafe origins and redirects', async () => {
  let calls = 0;
  const provider = githubTransport({ token: 'SECRET', fetcher: async (url, init) => {
    calls++;
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer SECRET');
    return { ok: true, status: 200, json: async () => nativeIssue };
  } });
  assert.equal((await observe(provider)(issue)).complete, true);
  await assert.rejects(provider('https://evil.test/', { signal: undefined }));
  assert.equal(calls, 1);
});

test('pagination rejects changing totals, duplicates, cycles and malformed data',
  async () => {
    const next = `${base}/actions/runs/10/attempts/2/jobs?page=2`;
    const first = { ...ok({ total_count: 2, jobs: [job] }),
      headers: { link: `<${next}>; rel="next"` } };
    for (const second of [
      ok({ total_count: 3, jobs: [] }),
      ok({ total_count: 2, jobs: [job] }),
      { ...ok({ total_count: 2, jobs: [] }),
        headers: { link: `<${next}>; rel="next"` } },
      ok({ total_count: 2 }),
    ]) {
      const result = await observe(fake([first, second]))(jobs);
      assert.equal(result.complete, false);
      assert.equal(confirmed(assertObservation(result, success)), false);
    }
  });

test('elapsed and request limits stop polling without fabricating terminal evidence',
  async () => {
    const provider = fake([ok({ total_count: 0, jobs: [] })]);
    const result = await githubObserver(provider, {
      timeoutMs: 10, intervalMs: 20, maxRequests: 100,
    })(jobs, success);
    assert.equal(result.assertion.state, 'unknown');
    assert.equal(provider.calls(), 1);
    const limited = fake([ok({ total_count: 0, jobs: [] })]);
    await observe(limited)(jobs, success);
    assert.equal(limited.calls(), bounds.maxRequests);
    for (const value of [0, Infinity, NaN, -1]) {
      assert.throws(() => githubObserver(limited, { maxRequests: value }));
    }
  });

test('missing native fields and mixed expectations cannot be confirmed', async () => {
  const pr = await observe(fake([ok({ id: 1, number: 24,
    url: `${base}/pulls/24` })]))(pull);
  assert.equal(assertObservation(pr, { merged: true }).state, 'unknown');
  const closed = await observe(fake([ok(nativeIssue)]))(issue);
  assert.equal(assertObservation(closed, { closed: 'yes' }).state, 'unknown');
  assert.equal(assertObservation(closed,
    { closed: true, merged: true }).state, 'unknown');
  const collection = await observe(fake([ok({ total_count: 1, jobs: [job] })]))(jobs);
  assert.equal(assertObservation(collection,
    { conclusion: 'success' }).state, 'unknown');
});
