// The pilot drives a local dev server and nothing else. An APP_URL inherited
// from the shell could otherwise point the agent, the dev logins and the CLI
// at a deployed portal, so anything but a bare http(s) loopback origin stops
// the run when the config loads, before a browser starts.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const DEFAULT_ORIGIN = 'http://127.0.0.1:5195';

export function localOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`APP_URL must be a URL such as ${DEFAULT_ORIGIN}; got ${JSON.stringify(raw)}.`);
  }
  const bareOrigin =
    url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === '';
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !LOOPBACK_HOSTS.has(url.hostname) || !bareOrigin) {
    throw new Error(
      `APP_URL must be a bare loopback origin such as ${DEFAULT_ORIGIN}; got ${JSON.stringify(raw)}. ` +
        'This pilot never runs against a deployed portal.',
    );
  }
  return url.origin;
}

export const LOCAL_ORIGIN = localOrigin(process.env.APP_URL ?? DEFAULT_ORIGIN);
