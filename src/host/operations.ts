import type { HostServices } from './services.ts';

/** Host reads the scenarios share: the secret values for redaction and the sandbox token's owner. */
export interface HostOperations {
  /** The secret values, for in-memory absence checks only. Never print them. */
  secretValues(): string[];
  /** The sandbox token's login and user id (`GET /user`), cached. */
  ownerLogin(): Promise<string>;
  ownerId(): Promise<number>;
}

export function createHostOperations(host: HostServices): HostOperations {
  let user: Promise<{ login: string; id: number }> | undefined;
  const me = () =>
    (user ??= host.github.rest<{ login: string; id: number }>('GET', '/user').then(
      (r) => r.data,
      (error: unknown) => {
        user = undefined;
        throw error;
      },
    ));

  return {
    secretValues() {
      const out: string[] = [];
      for (const name of ['E2E_SANDBOX_TOKEN', 'E2E_CLAUDE_TOKEN'] as const) {
        const v = host.env[name]?.trim();
        if (v) out.push(v);
      }
      return out;
    },

    ownerLogin: async () => (await me()).login,
    ownerId: async () => (await me()).id,
  };
}
