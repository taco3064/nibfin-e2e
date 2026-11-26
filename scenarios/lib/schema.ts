import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';

/**
 * Validates against a JSON Schema draft 2020-12 file in strict mode, so a keyword this
 * validator does not know fails instead of passing silently.
 */
export function schemaValidator(schema: unknown): (value: unknown) => string[] {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  const validate: ValidateFunction = ajv.compile(schema as object);
  return (value) => {
    if (validate(value)) return [];
    return (validate.errors ?? []).slice(0, 10).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
  };
}

/** gh-nibfin's `schema/status.schema.json` at the commit under test (Proposal R5.47's fixed path). */
export function statusValidator(ghNibfinClone: string): (value: unknown) => string[] {
  return schemaValidator(JSON.parse(readFileSync(`${ghNibfinClone}/schema/status.schema.json`, 'utf8')));
}
