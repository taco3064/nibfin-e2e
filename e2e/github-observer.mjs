import { resource, matches } from './github-resources.mjs';
import { assertObservation, unknown } from './github-assertions.mjs';

const defaults = {
  maxRequests: 50, maxPages: 10, timeoutMs: 30000,
  requestTimeoutMs: 5000, intervalMs: 250,
};
const header = (headers, key) => headers?.get?.(key) ?? headers?.[key];
function retryDelay(response) {
  const retry = header(response.headers, 'retry-after');
  const reset = header(response.headers, 'x-ratelimit-reset');
  if (retry !== undefined && retry !== null) {
    const seconds = Number(retry);
    const delay = Number.isFinite(seconds) ? seconds * 1000 :
      Date.parse(retry) - Date.now();
    if (Number.isFinite(delay)) return Math.max(0, delay);
  }
  if (reset) {
    const delay = Number(reset) * 1000 - Date.now();
    if (Number.isFinite(delay)) return Math.max(0, delay);
  }
  return 1000;
}
function nextPage(headers, current) {
  const link = header(headers, 'link');
  if (!link) return null;
  const parts = link.split(',');
  for (const part of parts) {
    if (!/rel="next"/.test(part)) continue;
    const match = part.match(/<([^>]+)>/);
    if (!match) throw new Error('Malformed pagination');
    const next = new URL(match[1], current);
    const previous = new URL(current);
    if (next.origin !== previous.origin || next.pathname !== previous.pathname ||
        next.username || next.password) throw new Error('Unsafe pagination');
    return next.href;
  }
  return null;
}
export function githubObserver(provider, options = {}) {
  const config = { ...defaults, ...options };
  for (const value of Object.values(config)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
      throw new Error('Positive finite bounds required');
    }
  }
  return async function observe(input, expected) {
    const target = Object.freeze({ ...input });
    const descriptor = resource(target);
    const deadline = performance.now() + config.timeoutMs;
    let requests = 0;
    const unresolved = reason => ({ target, complete: false, reason });
    async function wait(delay) {
      if (delay >= deadline - performance.now()) return false;
      await new Promise(resolve => setTimeout(resolve, delay));
      return performance.now() < deadline;
    }
    async function request(url) {
      while (requests < config.maxRequests && performance.now() < deadline) {
        requests++;
        const controller = new AbortController();
        const duration = Math.min(config.requestTimeoutMs,
          deadline - performance.now());
        let timer;
        let response;
        try {
          response = await Promise.race([
            Promise.resolve().then(() => provider(url, { signal: controller.signal })),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new Error('Timeout'));
              }, duration);
            }),
          ]);
        } catch { return { reason: 'unavailable' }; }
        finally { clearTimeout(timer); }
        if (!Number.isInteger(response?.status)) return { reason: 'malformed' };
        if (response.status === 429 || (response.status === 403 &&
            (header(response.headers, 'x-ratelimit-remaining') === '0' ||
             header(response.headers, 'retry-after') != null))) {
          if (!await wait(retryDelay(response))) return { reason: 'rate-limited' };
          continue;
        }
        if ([401, 403].includes(response.status)) return { reason: 'denied' };
        if (response.status === 404) return { reason: 'missing' };
        if (response.status !== 200) return { reason: 'unavailable' };
        return response;
      }
      return { reason: 'budget-exhausted' };
    }
    async function snapshot() {
      let url = descriptor.url;
      const visited = new Set();
      const items = [];
      let total;
      for (let page = 0; page < config.maxPages; page++) {
        if (visited.has(url)) return unresolved('pagination-cycle');
        visited.add(url);
        const response = await request(url);
        if (response.reason) return unresolved(response.reason);
        const data = response.data;
        if (!descriptor.collection) {
          if (!matches(data, target)) return unresolved('identity-mismatch');
          return { target, complete: true, data };
        }
        const array = descriptor.collection === 'array';
        const values = array ? data : data?.[descriptor.collection];
        if (!Array.isArray(values) || (!array &&
            (!Number.isSafeInteger(data.total_count) || data.total_count < 0))) {
          return unresolved('malformed');
        }
        if (total !== undefined && total !== data.total_count) {
          return unresolved('collection-changed');
        }
        total = data.total_count;
        if (!values.every(item => matches(item, target))) {
          return unresolved('identity-mismatch');
        }
        items.push(...values);
        if (new Set(items.map(item => item.id)).size !== items.length) {
          return unresolved('duplicate-object');
        }
        try { url = nextPage(response.headers, url); }
        catch { return unresolved('invalid-pagination'); }
        if (!url) {
          if (!array && items.length !== total) return unresolved('truncated');
          return { target, complete: true, data: items };
        }
      }
      return unresolved('page-budget-exhausted');
    }
    let last;
    while (requests < config.maxRequests && performance.now() < deadline) {
      last = await snapshot();
      if (expected === undefined) return { ...last, requests };
      const assertion = assertObservation(last, expected);
      if (assertion.state !== 'unknown') return { ...last, assertion, requests };
      // A provider retry wait that cannot fit ends this observation's budget.
      if (last.reason === 'rate-limited') break;
      if (!await wait(config.intervalMs)) break;
    }
    return { ...unresolved(last?.reason ?? 'budget-exhausted'), requests,
      assertion: unknown(last?.reason ?? 'budget-exhausted') };
  };
}
