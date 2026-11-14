import test from 'node:test';
import assert from 'node:assert/strict';
import { githubObserver } from '../github-observer.mjs';
import { resource } from '../github-resources.mjs';
import { assertObservation, confirmed } from '../github-assertions.mjs';

const base = 'https://api.github.com/repos/owner/repo';
const target = { repository: 'owner/repo', kind: 'issue-events', number: 33 };
const endpoint = `${base}/issues/33/events?per_page=100`;
const event = (id, name = 'labeled') => ({
  id, url: `${base}/issues/events/${id}`, event: name,
  created_at: '2026-11-14T07:00:00Z',
  actor: { id: 12, login: 'owner' }, label: { name: 'pause' },
});
const ok = (data, headers = {}) => ({ status: 200, data, headers });
const next = `${endpoint}&page=2`;
const first = values => ok(values, { link: `<${next}>; rel="next"` });
function observer(responses, options = {}) {
  const urls = [];
  const observe = githubObserver(async url => {
    urls.push(url);
    return responses[urls.length - 1];
  }, { maxRequests: 3, maxPages: 3, timeoutMs: 1000, ...options });
  return { observe, urls };
}

test('Issue event history uses the exact Issue endpoint and bounded pagination',
  async () => {
    assert.deepEqual(resource(target), { url: endpoint, collection: 'array' });
    const added = event(100);
    const removed = event(101, 'unlabeled');
    const { observe, urls } = observer([first([added]), ok([removed])]);
    const result = await observe(target);
    assert.equal(result.complete, true);
    assert.deepEqual(result.target, target);
    assert.deepEqual(result.data, [added, removed]);
    assert.deepEqual(urls, [endpoint, next]);
    // Native history is evidence for Core, never a pause/admission decision.
    assert.equal(confirmed(assertObservation(result, { paused: false })), false);
    assert.equal(confirmed(assertObservation(result,
      { ids: [101], conclusion: 'success' })), false);
  });

test('unrelated native events and an empty complete history are preserved', async () => {
  const assigned = { ...event(99, 'assigned'), label: undefined };
  for (const data of [[], [assigned]]) {
    const result = await observer([ok(data)]).observe(target);
    assert.equal(result.complete, true);
    assert.deepEqual(result.data, data);
    assert.equal(confirmed(assertObservation(result, { paused: false })), false);
  }
});

test('foreign, mismatched and malformed event identities remain unresolved', async () => {
  for (const data of [
    [{ ...event(100), url: 'https://api.github.com/repos/other/repo/issues/events/100' }],
    [{ ...event(100), url: `${base}/issues/events/101` }],
    [{ ...event(100), url: `${base}/issues/34/events/100` }],
    [{ ...event(100), id: 0 }],
    [{ ...event(100), event: null }],
    [{ ...event(100), created_at: 'unknown' }],
    [{ ...event(100), created_at: null }],
  ]) {
    const result = await observer([ok(data)]).observe(target);
    assert.equal(result.complete, false);
    assert.equal(result.reason, 'identity-mismatch');
  }
  for (const number of [0, -1, '33', NaN]) {
    assert.throws(() => resource({ ...target, number }));
  }
});

test('partial history, duplicates and unsafe pagination cannot establish coverage',
  async () => {
    const cases = [
      [[first([event(100)])], { maxPages: 1 }, 'page-budget-exhausted'],
      [[first([event(100)]), { status: 503 }], {}, 'unavailable'],
      [[first([event(100)]), ok([event(100)])], {}, 'duplicate-object'],
      [[ok({}, {})], {}, 'malformed'],
      [[ok([event(100)], { link:
        `<${base}/issues/34/events?page=2>; rel="next"` })], {},
      'invalid-pagination'],
      [[first([event(100)]), first([event(101)])], {}, 'pagination-cycle'],
    ];
    for (const [responses, bounds, reason] of cases) {
      const result = await observer(responses, bounds).observe(target);
      assert.equal(result.complete, false);
      assert.equal(result.reason, reason);
      assert.equal(result.data, undefined);
    }
  });

test('missing and denied Issue histories never become empty successful histories',
  async () => {
    for (const [status, reason] of [[404, 'missing'], [403, 'denied']]) {
      const result = await observer([{ status }]).observe(target);
      assert.equal(result.complete, false);
      assert.equal(result.reason, reason);
      assert.equal(result.data, undefined);
    }
  });
