import type { RunContext } from '../../src/types.ts';
import type { ObservedFacts } from './observed.ts';

/** The observed-job step's facts; the scenario requires the step, so they exist when it runs. */
export function observedFacts(ctx: RunContext): ObservedFacts {
  const f = ctx.facts('observed-job') as ObservedFacts | undefined;
  if (!f) throw new Error('the observed-job step recorded no facts');
  return f;
}

export function imageDigest(ctx: RunContext): string {
  const d = ctx.facts('nibfin')?.imageDigest;
  if (typeof d !== 'string') throw new Error('the nibfin step recorded no image digest');
  return d;
}

export const IMAGE = 'ghcr.io/taco3064/nibfin';
