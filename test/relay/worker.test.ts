import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { parseProposalEvent } from '../../src/gate/proposal.ts';
import { createDispatch, handle, MAX_DISPATCH_BYTES, type DispatchBody, type Env } from '../../relay/worker.ts';

const PAGE = '40006b64-4a20-80da-b1a8-c2e562f95373';
const SECRET = 'secret_fake-verification-token';
const env: Env = { PROPOSAL_PAGE_ID: PAGE, DISPATCH_REPOSITORY: 'o/r', NOTION_VERIFICATION_TOKEN: SECRET, GITHUB_TOKEN: 'ghp_fake' };
const unset: Env = { PROPOSAL_PAGE_ID: PAGE, DISPATCH_REPOSITORY: 'o/r' };

async function sign(body: string, key = SECRET) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body)));
  return `sha256=${Buffer.from(mac).toString('hex')}`;
}

function event(over: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    timestamp: '2026-11-27T01:02:03.000Z',
    workspace_id: 'ws',
    subscription_id: 'sub',
    integration_id: 'int',
    type: 'page.content_updated',
    authors: [{ id: 'u1', type: 'person' }],
    attempt_number: 1,
    entity: { id: PAGE, type: 'page' },
    data: { parent: { id: 'p', type: 'space' }, updated_blocks: [{ id: 'b1', type: 'block' }, { id: 'b2', type: 'block' }] },
    ...over,
  };
}

/** Every log line and dispatch seen, plus every request body, for the leak check. */
const seenLogs: string[] = [];
const secretsAndBodies = new Set<string>([SECRET]);

async function run(e: Env, body: string, signature?: string | null, opts: { method?: string; fail?: unknown } = {}) {
  const dispatched: { repository: string; body: DispatchBody }[] = [];
  const logs: string[] = [];
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (signature) headers.set('X-Notion-Signature', signature);
  if (signature) secretsAndBodies.add(signature);
  if (e.NOTION_VERIFICATION_TOKEN && body) secretsAndBodies.add(body);
  const res = await handle(new Request('https://relay.example/', { method: opts.method ?? 'POST', headers, body: opts.method === 'GET' ? undefined : body }), e, {
    dispatch: async (repository, b) => {
      if (opts.fail) throw opts.fail;
      dispatched.push({ repository, body: b });
    },
    log: (l) => logs.push(l),
  });
  seenLogs.push(...logs);
  return { status: res.status, text: await res.text(), dispatched, logs };
}

test('bootstrap: with the secret unset, the verification token is logged once and nothing else passes', async () => {
  const v = await run(unset, JSON.stringify({ verification_token: 'secret_from_notion' }));
  equal(v.status, 200);
  deepEqual(v.logs, ['verification_token: secret_from_notion']);
  equal(v.text, '');

  const other = await run(unset, JSON.stringify(event()), await sign(JSON.stringify(event())));
  equal(other.status, 401);
  equal(other.dispatched.length, 0);
  equal(other.logs.some((l) => l.includes('secret_')), false);
  equal((await run(unset, JSON.stringify({ verification_token: 'x', extra: 1 }))).status, 401);
  equal((await run({ ...unset, NOTION_VERIFICATION_TOKEN: '' }, JSON.stringify({ verification_token: 'y' }))).status, 200);
});

test('with the secret set, a verification body is an unsigned request', async () => {
  const body = JSON.stringify({ verification_token: 'secret_resent' });
  const r = await run(env, body);
  equal(r.status, 401);
  equal(r.logs.some((l) => l.includes('secret_resent')), false);
  secretsAndBodies.add('secret_resent');
});

test('signatures: missing, malformed or wrong signatures are rejected; raw bytes are signed', async () => {
  const body = JSON.stringify(event());
  equal((await run(env, body)).status, 401);
  equal((await run(env, body, 'sha256=xyz')).status, 401);
  equal((await run(env, body, (await sign(body)).toUpperCase())).status, 401);
  equal((await run(env, body, (await sign(body)).slice('sha256='.length))).status, 401);
  equal((await run(env, body, await sign(body, 'secret_other'))).status, 401);
  equal((await run(env, body + ' ', await sign(body))).status, 401);
  equal((await run(env, body)).dispatched.length, 0);

  // Pretty-printed bytes differ from the minified re-serialization; only the raw bytes verify.
  const pretty = JSON.stringify(event(), null, 2);
  const ok200 = await run(env, pretty, await sign(pretty));
  equal(ok200.status, 200);
  equal(ok200.dispatched.length, 1);
  equal((await run(env, pretty, await sign(JSON.stringify(JSON.parse(pretty))))).status, 401);
});

test('filtering: only Proposal page content and property updates are forwarded', async () => {
  const signed = async (e: unknown) => {
    const b = JSON.stringify(e);
    return run(env, b, await sign(b));
  };
  const otherPage = await signed(event({ entity: { id: '11111111-2222-3333-4444-555555555555', type: 'page' } }));
  deepEqual([otherPage.status, otherPage.dispatched.length], [200, 0]);
  const otherType = await signed(event({ type: 'page.created' }));
  deepEqual([otherType.status, otherType.dispatched.length], [200, 0]);
  const block = await signed(event({ entity: { id: PAGE, type: 'block' } }));
  deepEqual([block.status, block.dispatched.length], [200, 0]);
  const dashless = await signed(event({ entity: { id: PAGE.replace(/-/g, '').toUpperCase(), type: 'page' } }));
  deepEqual([dashless.status, dashless.dispatched.length], [200, 1]);
  const props = await signed(event({ type: 'page.properties_updated', data: { updated_properties: ['title', 7] } }));
  equal(props.status, 200);
  deepEqual(props.dispatched[0]?.body.client_payload.updated_properties, ['title']);
  deepEqual(props.dispatched[0]?.body.client_payload.block_ids, []);
  equal((await signed({ id: 'x', type: 'page.content_updated' })).status, 400);
  equal((await signed([1, 2])).status, 400);
  const notJson = 'not json';
  equal((await run(env, notJson, await sign(notJson))).status, 400);
  equal((await run(env, '', null, { method: 'GET' })).status, 405);
});

test('dispatch payload carries the event ids and time, and drops the id lists when oversize', async () => {
  const body = JSON.stringify(event());
  const r = await run(env, body, await sign(body));
  equal(r.status, 200);
  deepEqual(r.dispatched, [{
    repository: 'o/r',
    body: {
      event_type: 'proposal-updated',
      client_payload: {
        event_id: 'evt-1',
        type: 'page.content_updated',
        timestamp: '2026-11-27T01:02:03.000Z',
        page_id: PAGE,
        attempt_number: 1,
        block_ids: ['b1', 'b2'],
        updated_properties: [],
      },
    },
  }]);

  const many = Array.from({ length: 2000 }, (_, i) => ({ id: `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`, type: 'block' }));
  const big = JSON.stringify(event({ data: { updated_blocks: many } }));
  const o = await run(env, big, await sign(big));
  equal(o.status, 200);
  const p = o.dispatched[0]?.body.client_payload;
  deepEqual([p?.block_ids, p?.updated_properties, p?.ids_omitted, p?.timestamp], [[], [], true, '2026-11-27T01:02:03.000Z']);
  ok(JSON.stringify(o.dispatched[0]?.body).length < MAX_DISPATCH_BYTES);
  ok(Object.keys(p ?? {}).length <= 10);
});

test("contract: every relay dispatch passes the gate's own parser", async () => {
  // The event as GitHub delivers the dispatch to the proposal-updated job (GITHUB_EVENT_PATH).
  const gateReads = async (e: unknown) => {
    const b = JSON.stringify(e);
    const r = await run(env, b, await sign(b));
    equal(r.status, 200);
    equal(r.dispatched.length, 1);
    const sent = r.dispatched[0]?.body as DispatchBody;
    return parseProposalEvent(JSON.stringify({ action: sent.event_type, client_payload: sent.client_payload }));
  };
  const time = '2026-11-27T01:02:03.000Z';

  deepEqual(await gateReads(event()), { pageId: PAGE, blockIds: ['b1', 'b2'], timestamp: time });
  deepEqual(await gateReads(event({ type: 'page.properties_updated', data: { updated_properties: ['title'] } })), { pageId: PAGE, blockIds: [], timestamp: time });
  deepEqual(await gateReads(event({ data: { parent: { id: 'p', type: 'space' } } })), { pageId: PAGE, blockIds: [], timestamp: time });
  const many = Array.from({ length: 2000 }, (_, i) => ({ id: `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`, type: 'block' }));
  deepEqual(await gateReads(event({ data: { updated_blocks: many } })), { pageId: PAGE, blockIds: [], timestamp: time });
});

test('a failed dispatch returns 502 and logs only the status', async () => {
  const body = JSON.stringify(event());
  const dispatch = createDispatch(() => 'ghp_fake', async () => new Response('{"message":"Bad credentials ghp_echo"}', { status: 401 }));
  const r = await run(env, body, await sign(body), { fail: await dispatch('o/r', { event_type: 'proposal-updated', client_payload: {} }).then(() => undefined, (e: unknown) => e) });
  equal(r.status, 502);
  deepEqual(r.logs, ['dispatch failed: 401']);
  const n = await run(env, body, await sign(body), { fail: new TypeError('network down') });
  deepEqual([n.status, n.logs], [502, ['dispatch failed: no response']]);
});

test('the default dispatch posts the repository_dispatch through the GitHub client', async () => {
  const seen: { url: string; method?: string; auth: string | null; body: unknown }[] = [];
  const dispatch = createDispatch(() => 'ghp_fake', async (input, init) => {
    seen.push({ url: String(input), method: init?.method, auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 204 });
  });
  await dispatch('taco3064/nibfin-e2e', { event_type: 'proposal-updated', client_payload: { event_id: 'e' } });
  deepEqual(seen, [{
    url: 'https://api.github.com/repos/taco3064/nibfin-e2e/dispatches',
    method: 'POST',
    auth: 'Bearer ghp_fake',
    body: { event_type: 'proposal-updated', client_payload: { event_id: 'e' } },
  }]);
});

test('no log line carries the secret, a signature or a signed request body', () => {
  ok(seenLogs.length > 0);
  for (const line of seenLogs) {
    if (line === 'verification_token: secret_from_notion' || line === 'verification_token: y') continue;
    for (const s of secretsAndBodies) equal(line.includes(s), false, `log line leaks: ${line}`);
    equal(line.includes('sha256='), false);
    equal(line.includes('ghp_'), false);
  }
});
