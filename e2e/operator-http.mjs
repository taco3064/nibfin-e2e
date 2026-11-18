// Only callers with code-owned endpoints use this bounded transport. Redirects
// cannot turn a public read or private authentication into another destination.
export async function operatorJson(url, { token, signal, request = fetch } = {}) {
  if (!url.startsWith('https://api.github.com/')) throw new Error('OPERATOR_ENDPOINT');
  const response = await request(url, { redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) :
      AbortSignal.timeout(30000),
    headers: { Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok || !response.body) throw new Error('OPERATOR_READ_UNAVAILABLE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error('OPERATOR_READ_LIMIT');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
