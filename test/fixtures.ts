import type { MapEntry, Outcome, Platform, ProvisioningStep, Scenario, StepOutcome } from '../src/types.ts';
export { fakeHostContext } from './host/fakes.ts';

export function scenario(id: string, rules: string[], platforms: Platform[], outcome: Outcome | Error, requires?: string[]): Scenario {
  return {
    id,
    rules,
    platforms,
    requires,
    run: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

export function step(id: string, outcome: StepOutcome | Error, calls?: string[], extra: Partial<ProvisioningStep> = {}): ProvisioningStep {
  return {
    id,
    ...extra,
    run: async () => {
      calls?.push(id);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

export const passed: Outcome = { status: 'passed', reason: 'ok' };

export const map: MapEntry[] = [
  { id: 'R0.1', notE2e: '文件定位' },
  { id: 'R3.1', platforms: ['linux'], scenarios: ['a'] },
  { id: 'R3.2', platforms: ['linux', 'windows'], scenarios: ['a', 'b'] },
  { id: 'R5.13', platforms: ['windows'], scenarios: ['b'] },
  { id: 'R5.14', platforms: ['macos'], scenarios: [] },
];

export const scenarioA = scenario('a', ['R3.1', 'R3.2'], ['linux'], passed);
export const scenarioB = scenario('b', ['R3.2', 'R5.13'], ['windows'], passed);
export const scenarios: Scenario[] = [scenarioA, scenarioB];
