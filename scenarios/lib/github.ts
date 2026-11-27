import type { GitHub } from '../../src/host/github.ts';
import type { HostState } from '../../src/host/hoststate.ts';
import type { RunContext } from '../../src/types.ts';

export interface Registration {
  id: number;
  name: string;
  status: string;
  busy: boolean;
  /** The runner's operating system as GitHub reports it (for example `Linux`). */
  os: string;
  labels: { name: string }[];
}

export interface Issue {
  number: number;
  id: number;
  node_id: string;
  created_at: string;
  labels: { name: string }[];
}

export interface NibfinFacts {
  commands: { args: string[]; code: number; stdout: string; stderr: string }[];
  executionPr: number;
  peerPr: number;
  imageDigest: string;
  hostBefore: HostState;
}

/** The facts of the `nibfin` provisioning step; it passed, so they are complete. */
export function nibfinFacts(ctx: RunContext): NibfinFacts {
  const f = ctx.facts('nibfin') as Partial<NibfinFacts> | undefined;
  if (!f || !Array.isArray(f.commands) || typeof f.imageDigest !== 'string' || typeof f.executionPr !== 'number' || typeof f.peerPr !== 'number' || !f.hostBefore) {
    throw new Error('the nibfin provisioning step left no complete facts');
  }
  return f as NibfinFacts;
}

const path = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export async function whoami(gh: GitHub): Promise<{ login: string; id: number }> {
  const { data } = await gh.rest<{ login: string; id: number }>('GET', '/user');
  return { login: data.login, id: data.id };
}

export const registrations = (gh: GitHub, repo: string) => gh.list<Registration>(`/repos/${repo}/actions/runners`, 'runners');

export async function labelsOf(gh: GitHub, repo: string, n: number): Promise<string[]> {
  return (await gh.list<{ name: string }>(`/repos/${repo}/issues/${n}/labels`)).map((l) => l.name).sort();
}

export async function createIssue(gh: GitHub, repo: string, body: { title: string; body?: string; labels?: string[]; assignees?: string[] }): Promise<Issue> {
  const { data } = await gh.rest<Issue>('POST', `/repos/${repo}/issues`, { body: 'nibfin-e2e fixture', ...body });
  return data;
}

export async function readFile(gh: GitHub, repo: string, file: string, ref = 'main'): Promise<{ sha: string; text: string } | undefined> {
  const r = await gh.rest<{ sha: string; content: string }>('GET', `/repos/${repo}/contents/${path(file)}?ref=${encodeURIComponent(ref)}`, undefined, [404]);
  if (r.status === 404) return undefined;
  return { sha: r.data.sha, text: Buffer.from(r.data.content, 'base64').toString('utf8') };
}

/** Creates or replaces a file on main with the Contents API. */
export async function putFile(gh: GitHub, repo: string, file: string, text: string, message: string): Promise<void> {
  const existing = await readFile(gh, repo, file);
  await gh.rest('PUT', `/repos/${repo}/contents/${path(file)}`, {
    message,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch: 'main',
    ...(existing ? { sha: existing.sha } : {}),
  });
}

/** Deletes a file from main; a missing file is already the result. */
export async function deleteFile(gh: GitHub, repo: string, file: string, message: string): Promise<void> {
  const existing = await readFile(gh, repo, file);
  if (!existing) return;
  await gh.rest('DELETE', `/repos/${repo}/contents/${path(file)}`, { message, sha: existing.sha, branch: 'main' });
}

export const openPulls = (gh: GitHub, repo: string) => gh.list<{ number: number; merged_at: string | null; head: { sha: string; ref: string } }>(`/repos/${repo}/pulls?state=open`);

export async function addLabels(gh: GitHub, repo: string, n: number, labels: string[]): Promise<void> {
  await gh.rest('POST', `/repos/${repo}/issues/${n}/labels`, { labels });
}

export async function removeLabel(gh: GitHub, repo: string, n: number, label: string): Promise<void> {
  await gh.rest('DELETE', `/repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`, undefined, [404]);
}

/** Parses a command's JSON stdout or throws with its start. */
export function json<T>(stdout: string, what: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`${what} did not print JSON: ${stdout.trim().slice(0, 200)}`);
  }
}
