export interface SourceIdentity {
  repository: string;
  commit: string;
}
export interface TargetIdentity {
  repository: string;
  id: number;
  ownerType: 'User' | 'Organization';
  defaultBranch: string;
  baseCommit: string;
}
export interface ManagedFile {
  path: '.nibfin/producer-pins.json' |
    '.github/workflows/nibfin-wake.yml' |
    '.github/workflows/nibfin-issue.yml' |
    '.github/workflows/nibfin-stage.yml';
  content: string;
}
export type LifecycleLabel = 'scope' | 'shaped' | 'delivered';
export interface Binding {
  scenario: string;
  target: TargetIdentity;
  sources: {
    core: SourceIdentity;
    action: SourceIdentity;
    cli: SourceIdentity;
  };
}
export interface Request extends Binding {
  intent: 'init-preview' | 'init-apply' | 'upgrade-preview' | 'upgrade-apply';
  expected: {
    status: 'preview' | 'proposal' | 'unchanged';
    head: string | null;
    files: ManagedFile[];
    labels: LifecycleLabel[];
  };
}
export interface Observation extends Binding {
  origin: 'synthetic' | 'operator';
  cli: {
    status: 'preview' | 'pending' | 'completed' | 'no_change' | 'error';
    code: string;
    exitCode: number;
    pullRequest: string | null;
    files: ManagedFile[];
    labels: LifecycleLabel[];
  };
  provider: {
    state: 'observed' | 'unavailable';
    mutations: number | null;
    defaultBranchWrites: number | null;
    localEffects: number | null;
    defaultBranchCommit: string | null;
    merged: boolean | null;
    pullRequest: {
      url: string;
      state: 'open' | 'closed';
      base: string;
      head: string;
      headCommit: string;
    } | null;
    files: ManagedFile[];
    labels: LifecycleLabel[];
  };
}
export interface Comparison {
  outcome: 'passed' | 'failing' | 'unverified';
  code: string;
  protectedExecution: 'unverified';
}
export function validateRequest(value: unknown): Request;
export function compareHandoff(
  request: Request, observation?: Observation | null,
): Comparison;
