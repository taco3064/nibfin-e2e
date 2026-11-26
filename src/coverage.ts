import { readFileSync } from 'node:fs';
import { PLATFORMS, isExcluded } from './types.ts';
import type { CoveredEntry, MapEntry, Platform, ProvisioningStep, RuleId, Scenario } from './types.ts';

const RULE_ID = /^R(0|[1-9]\d*)\.([1-9]\d*)$/;

export function parseRuleId(id: unknown): { section: number; n: number } | undefined {
  if (typeof id !== 'string') return undefined;
  const m = RULE_ID.exec(id);
  return m ? { section: Number(m[1]), n: Number(m[2]) } : undefined;
}

function isPlatform(value: unknown): value is Platform {
  return (PLATFORMS as readonly unknown[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Validates the parsed coverage map. Entries are returned only when there are no errors. */
export function validateMap(raw: unknown): { entries: MapEntry[]; errors: string[] } {
  if (!Array.isArray(raw)) return { entries: [], errors: ['coverage map: must be an array of entries'] };
  const errors: string[] = [];
  const seen = new Set<string>();
  raw.forEach((item: unknown, i) => {
    const at = `coverage map entry ${i}`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const e = item as Record<string, unknown>;
    const where = typeof e.id === 'string' ? `${at} (${e.id})` : at;
    if (!parseRuleId(e.id)) errors.push(`${where}: id must match R<section>.<n>`);
    else if (seen.has(e.id as string)) errors.push(`${where}: duplicate id`);
    else seen.add(e.id as string);

    const keys = Object.keys(e);
    const allowed = 'notE2e' in e ? ['id', 'notE2e'] : ['id', 'platforms', 'scenarios'];
    for (const k of keys) if (!allowed.includes(k)) errors.push(`${where}: unexpected key "${k}"`);

    if ('notE2e' in e) {
      if (typeof e.notE2e !== 'string' || e.notE2e.trim() === '') {
        errors.push(`${where}: notE2e must be the non-empty reason from the rule's 〔不測：…〕 mark`);
      }
      return;
    }
    if (!('scenarios' in e)) errors.push(`${where}: needs exactly one of "scenarios" or "notE2e"`);
    else if (!isStringArray(e.scenarios)) errors.push(`${where}: scenarios must be an array of scenario ids`);
    else if (new Set(e.scenarios).size !== e.scenarios.length) errors.push(`${where}: duplicate scenario id`);
    if (!Array.isArray(e.platforms) || e.platforms.length === 0) {
      errors.push(`${where}: platforms must be a non-empty array`);
    } else {
      for (const p of e.platforms) if (!isPlatform(p)) errors.push(`${where}: unknown platform ${JSON.stringify(p)}`);
      if (new Set(e.platforms).size !== e.platforms.length) errors.push(`${where}: duplicate platform`);
    }
  });
  return { entries: errors.length ? [] : (raw as MapEntry[]), errors };
}

export function loadMap(path: string | URL): { entries: MapEntry[]; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { entries: [], errors: [`coverage map: cannot read ${String(path)}: ${(error as Error).message}`] };
  }
  return validateMap(raw);
}

export function validateRegistry(scenarios: Scenario[], steps: ProvisioningStep[]): string[] {
  const errors: string[] = [];
  const stepIds = new Set<string>();
  for (const s of steps) {
    if (typeof s.id !== 'string' || s.id === '') errors.push('provisioning step: id must be a non-empty string');
    else if (stepIds.has(s.id)) errors.push(`provisioning step ${s.id}: duplicate id`);
    else stepIds.add(s.id);
  }
  const scenarioIds = new Set<string>();
  for (const s of scenarios) {
    const at = `scenario ${s.id}`;
    if (typeof s.id !== 'string' || s.id === '') errors.push('scenario: id must be a non-empty string');
    else if (scenarioIds.has(s.id)) errors.push(`${at}: duplicate id`);
    else scenarioIds.add(s.id);
    if (s.rules.length === 0) errors.push(`${at}: must declare at least one rule id`);
    for (const r of s.rules) if (!parseRuleId(r)) errors.push(`${at}: malformed rule id ${JSON.stringify(r)}`);
    if (s.platforms.length === 0) errors.push(`${at}: must declare at least one platform`);
    for (const p of s.platforms) if (!isPlatform(p)) errors.push(`${at}: unknown platform ${JSON.stringify(p)}`);
    for (const r of s.requires ?? []) if (!stepIds.has(r)) errors.push(`${at}: requires unknown provisioning step ${r}`);
  }
  return errors;
}

/** Checks that the map and the registry point at each other consistently. */
export function crossCheck(entries: MapEntry[], scenarios: Scenario[]): string[] {
  const errors: string[] = [];
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const entryById = new Map(entries.map((e) => [e.id, e]));
  for (const e of entries) {
    if (isExcluded(e)) continue;
    for (const sid of e.scenarios) {
      const s = byId.get(sid);
      if (!s) errors.push(`coverage map ${e.id}: lists unknown scenario ${sid}`);
      else if (!s.rules.includes(e.id)) errors.push(`coverage map ${e.id}: scenario ${sid} does not declare ${e.id}`);
    }
  }
  for (const s of scenarios) {
    for (const r of s.rules) {
      const e = entryById.get(r);
      if (!e) errors.push(`scenario ${s.id}: declares ${r}, which is not in the coverage map`);
      else if (isExcluded(e)) errors.push(`scenario ${s.id}: declares ${r}, which the Proposal marks 不測`);
      else if (!e.scenarios.includes(s.id)) errors.push(`scenario ${s.id}: declares ${r}, but the map does not list it`);
    }
  }
  return errors;
}

export interface Coverage {
  covered: number;
  total: number;
  percent: number;
  uncovered: { id: RuleId; missingPlatforms: Platform[] }[];
}

/**
 * A non-excluded rule is covered when every platform it requires appears among the
 * platforms of its scenarios. Coverage counts only the given entries.
 */
export function computeCoverage(entries: MapEntry[], scenarios: Scenario[]): Coverage {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const live = entries.filter((e): e is CoveredEntry => !isExcluded(e));
  const uncovered: Coverage['uncovered'] = [];
  for (const e of live) {
    const have = new Set(e.scenarios.flatMap((sid) => byId.get(sid)?.platforms ?? []));
    const missingPlatforms = e.platforms.filter((p) => !have.has(p));
    if (missingPlatforms.length) uncovered.push({ id: e.id, missingPlatforms });
  }
  const total = live.length;
  const covered = total - uncovered.length;
  const percent = total === 0 ? 100 : Math.floor((covered / total) * 10000) / 100;
  return { covered, total, percent, uncovered };
}
