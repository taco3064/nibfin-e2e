// Versioned graph data preserves aliases between phase legs and executions.
// Only finite data, plain records, Maps and Sets are admitted; never capabilities.
const fail = () => { throw new Error('SIM_SESSION_CORRUPT'); };
export function encodeSimulation(value) {
  const nodes = [], seen = new Map();
  const encode = item => {
    if (item === undefined) return { undefined: true };
    if (item === null || ['string', 'boolean'].includes(typeof item)) return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object') return fail();
    if (seen.has(item)) return { ref: seen.get(item) };
    const id = nodes.length;
    seen.set(item, id);
    nodes.push(null);
    let type, entries;
    if (item instanceof Map) {
      type = 'map';
      entries = [...item].map(([k, v]) => [encode(k), encode(v)]);
    } else if (item instanceof Set || Array.isArray(item)) {
      type = item instanceof Set ? 'set' : 'array';
      entries = [...item].map(encode);
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype) return fail();
      type = 'record';
      entries = Object.entries(item).map(([k, v]) => [k, encode(v)]);
    }
    nodes[id] = { type, entries };
    return { ref: id };
  };
  const root = encode(value);
  return { version: 1, root, nodes };
}

export function decodeSimulation(graph) {
  if (graph?.version !== 1 || !Array.isArray(graph.nodes) ||
      graph.nodes.length > 100000) return fail();
  const nodes = graph.nodes.map(node => {
    if (!Array.isArray(node?.entries)) return fail();
    switch (node.type) {
      case 'map': return new Map();
      case 'set': return new Set();
      case 'array': return [];
      case 'record': return {};
      default: return fail();
    }
  });
  const decode = item => {
    if (item === null || ['string', 'boolean'].includes(typeof item)) return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || Object.keys(item).length !== 1) {
      return fail();
    }
    if (item.undefined === true) return undefined;
    if (!Number.isSafeInteger(item.ref) || item.ref < 0 ||
        item.ref >= nodes.length) return fail();
    return nodes[item.ref];
  };
  graph.nodes.forEach((node, index) => {
    const target = nodes[index];
    for (const entry of node.entries) {
      if (node.type === 'array') target.push(decode(entry));
      else if (node.type === 'set') target.add(decode(entry));
      else {
        if (!Array.isArray(entry) || entry.length !== 2) return fail();
        if (node.type === 'map') target.set(decode(entry[0]), decode(entry[1]));
        else {
          const [key, value] = entry;
          if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype']
            .includes(key) || Object.hasOwn(target, key)) return fail();
          target[key] = decode(value);
        }
      }
    }
  });
  return decode(graph.root);
}
