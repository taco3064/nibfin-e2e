// Authentication is supplied by the caller; no discovery or write API exists.
export function githubTransport({ token, fetcher = fetch } = {}) {
  return async (url, { signal }) => {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://api.github.com' || parsed.username ||
        parsed.password) throw new Error('Invalid API origin');
    const headers = { accept: 'application/vnd.github+json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetcher(parsed, {
      method: 'GET', headers, signal, redirect: 'error',
    });
    const data = response.ok ? await response.json() : null;
    return { status: response.status, headers: response.headers, data };
  };
}
