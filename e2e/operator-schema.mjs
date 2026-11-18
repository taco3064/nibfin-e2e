const string = { type: 'string' };
const boolean = { type: 'boolean' };
const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['integer', 'null'] };
const object = properties => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });

export const investigationSchema = object({ findings: { type: 'array', maxItems: 16,
  items: object({ classification: { type: 'string', enum: ['implementation_defect',
    'missing_prerequisite', 'producer_rollout', 'infrastructure_failure',
    'insufficient_evidence'] }, repository: string, behavior: string,
  ownerSource: string, necessaryChange: string, changeIdentity: string,
  title: string, body: string, evidence: { type: 'array', items: string },
  duplicate: string }) } });

export const assessmentSchema = object({ publicSafe: boolean, english: boolean,
  codeBacked: boolean, key: string, duplicate: { type: 'string',
    enum: ['none', 'existing', 'addressed', 'recurrence', 'unresolved'] },
  newMaintainedChange: boolean, number: nullableNumber, existingId: nullableNumber,
  existingTitle: nullableString, existingBody: nullableString });
