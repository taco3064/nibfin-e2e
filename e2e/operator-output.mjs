// Enforce the finite schemas owned by operator-schema before normalization.
export function validateResult(value, schema) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' :
    Number.isInteger(value) ? 'integer' : typeof value;
  if (!types.includes(kind) || schema.enum && !schema.enum.includes(value) ||
      Object.hasOwn(schema, 'const') && value !== schema.const) {
    throw new Error('OPERATOR_MODEL_OUTPUT');
  }
  if (kind === 'object') {
    if (schema.required?.some(key => !Object.hasOwn(value, key)) ||
        schema.additionalProperties === false &&
        Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) {
      throw new Error('OPERATOR_MODEL_OUTPUT');
    }
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validateResult(item, schema.properties[key]);
    }
  }
  if (kind === 'array') {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new Error('OPERATOR_MODEL_OUTPUT');
    }
    for (const item of value) validateResult(item, schema.items);
  }
}

// JSON.parse accepts duplicate keys. Provider envelopes must be unambiguous,
// including keys expressed with equivalent JSON escapes.
export function parseProviderJson(text) {
  const value = JSON.parse(text);
  const frames = [];
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,"]+/g);
  for (const token of tokens ?? []) {
    if (token === '{' || token === '[') {
      frames.push({ object: token === '{', key: token === '{', keys: new Set() });
    } else if (token === '}' || token === ']') frames.pop();
    else {
      const frame = frames.at(-1);
      if (!frame?.object) continue;
      if (token === ',') frame.key = true;
      else if (token === ':') frame.key = false;
      else if (frame.key && token.startsWith('"')) {
        const key = JSON.parse(token);
        if (frame.keys.has(key)) throw new Error('OPERATOR_MODEL_OUTPUT');
        frame.keys.add(key);
        frame.key = false;
      }
    }
  }
  return value;
}
