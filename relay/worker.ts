import { createGitHub, GitHubError } from '../src/host/github.ts';

/**
 * Relays Notion webhook events for the Nibfin Proposal page to a `repository_dispatch`
 * of type `proposal-updated` (Proposal R8.13; Nibfin's own setup, not product).
 * It carries ids and event times only; the diff is read later from Notion's version history.
 */
export interface Env {
  PROPOSAL_PAGE_ID: string;
  DISPATCH_REPOSITORY: string;
  NOTION_VERIFICATION_TOKEN?: string;
  GITHUB_TOKEN?: string;
}

export interface DispatchBody {
  event_type: 'proposal-updated';
  client_payload: Record<string, unknown>;
}

export interface Deps {
  /** Sends one `repository_dispatch`; throws when GitHub does not accept it. */
  dispatch(repository: string, body: DispatchBody): Promise<void>;
  /** One line to the live log. Never given a secret, a signature or request bytes (bootstrap token aside). */
  log(line: string): void;
}

const FORWARDED = new Set(['page.content_updated', 'page.properties_updated']);
/** GitHub rejects a dispatch payload of 64 KB or more; stay well under it. */
export const MAX_DISPATCH_BYTES = 60_000;

export function createDispatch(token: () => string, fetchFn: typeof fetch): Deps['dispatch'] {
  const gh = createGitHub(token, fetchFn);
  return async (repository, body) => {
    await gh.rest('POST', `/repos/${repository}/dispatches`, body);
  };
}

const reply = (status: number, text?: string) => new Response(text ?? null, { status });
const normalizeId = (id: string) => id.replace(/-/g, '').toLowerCase();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseJson(raw: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return undefined;
  }
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** HMAC-SHA256 of the raw body keyed with the verification token, compared by Web Crypto. */
async function signatureValid(header: string | null, raw: Uint8Array<ArrayBuffer>, secret: string): Promise<boolean> {
  const m = header === null ? null : /^sha256=([0-9a-f]{64})$/.exec(header);
  if (!m?.[1]) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, hexBytes(m[1]), raw);
}

function payloadFor(event: Record<string, unknown>, entity: Record<string, unknown>): DispatchBody {
  const data = isObject(event.data) ? event.data : {};
  const blocks = Array.isArray(data.updated_blocks) ? data.updated_blocks : [];
  const props = Array.isArray(data.updated_properties) ? data.updated_properties : [];
  const client_payload: Record<string, unknown> = {
    event_id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    page_id: entity.id,
    attempt_number: typeof event.attempt_number === 'number' ? event.attempt_number : null,
    block_ids: blocks.flatMap((b) => (isObject(b) && typeof b.id === 'string' ? [b.id] : [])),
    updated_properties: props.filter((p): p is string => typeof p === 'string'),
  };
  const body: DispatchBody = { event_type: 'proposal-updated', client_payload };
  if (new TextEncoder().encode(JSON.stringify(body)).length > MAX_DISPATCH_BYTES) {
    client_payload.block_ids = [];
    client_payload.updated_properties = [];
    client_payload.ids_omitted = true;
  }
  return body;
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (request.method !== 'POST') return reply(405);
  const raw = new Uint8Array(await request.arrayBuffer());
  const secret = env.NOTION_VERIFICATION_TOKEN;

  if (!secret) {
    // Bootstrap: Notion sends the verification token only to the endpoint, so the
    // Owner reads it here with `wrangler tail` and stores it as the secret.
    const body = parseJson(raw);
    if (isObject(body) && Object.keys(body).length === 1 && typeof body.verification_token === 'string' && body.verification_token) {
      deps.log(`verification_token: ${body.verification_token}`);
      return reply(200);
    }
    deps.log('rejected: no verification token set');
    return reply(401);
  }

  if (!(await signatureValid(request.headers.get('x-notion-signature'), raw, secret))) {
    deps.log('rejected: signature');
    return reply(401);
  }

  const event = parseJson(raw);
  if (
    !isObject(event) ||
    typeof event.id !== 'string' ||
    typeof event.type !== 'string' ||
    typeof event.timestamp !== 'string' ||
    !isObject(event.entity)
  ) {
    deps.log('rejected: body');
    return reply(400);
  }
  const entity = event.entity;
  if (
    !FORWARDED.has(event.type) ||
    entity.type !== 'page' ||
    typeof entity.id !== 'string' ||
    normalizeId(entity.id) !== normalizeId(env.PROPOSAL_PAGE_ID)
  ) {
    deps.log('ignored: not a Proposal page update');
    return reply(200);
  }

  try {
    await deps.dispatch(env.DISPATCH_REPOSITORY, payloadFor(event, entity));
  } catch (err) {
    // Only the status: GitHub's message is not logged.
    deps.log(`dispatch failed: ${err instanceof GitHubError ? err.status : 'no response'}`);
    return reply(502);
  }
  return reply(200);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, {
      dispatch: createDispatch(() => env.GITHUB_TOKEN ?? '', (input, init) => fetch(input, init)),
      log: (line) => console.log(line),
    });
  },
};
