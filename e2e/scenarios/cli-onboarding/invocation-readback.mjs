// These are fresh reads by the protected adapters, never stdout or saved receipts.
// Each native channel must identify the same process attempt and prepared entry.
export function invocationReadback(raw, invocation, origin) {
  if (!invocation) return null;
  const channels = ['github', 'host'];
  const matches = channels.every(channel => {
    const read = raw?.invocation?.[channel];
    return read?.origin === (origin === 'operator' ? 'native' : 'synthetic') &&
      read.fresh === true && read.terminated === true &&
      read.effects === 'reconciled' &&
      ['runId', 'attempt', 'id', 'entry'].every(key =>
        read[key] === invocation[key]);
  });
  if (!matches) return null;
  return Object.fromEntries(channels.map(channel => [channel, { ...invocation,
    origin: raw.invocation[channel].origin, fresh: true, terminated: true,
    effects: 'reconciled' }]));
}
