// The pilot drives a local dev server and nothing else. An APP_URL inherited
// from the shell could otherwise point the agent, the dev logins and the CLI
// at a deployed portal, so anything but a bare http(s) loopback origin stops
// the run when the config loads, before a browser starts.
//
// The errors name the rule that failed and never repeat the value: a refused
// URL may carry credentials or a token in its query, and the message ends up
// in the console and the report.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const EXAMPLE = 'http://127.0.0.1:5195';

function refuse(rule: string): never {
  throw new Error(`APP_URL ${rule}; use a loopback origin such as ${EXAMPLE}. This pilot never runs against a deployed portal.`);
}

export function localOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    refuse('is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') refuse('must use http or https');
  if (url.username !== '' || url.password !== '') refuse('must not carry credentials');
  if (!LOOPBACK_HOSTS.has(url.hostname)) refuse('must name 127.0.0.1, localhost or [::1] as its host');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') refuse('must be an origin with no path, query or fragment');
  return url.origin;
}

export const LOCAL_ORIGIN = localOrigin(process.env.APP_URL ?? EXAMPLE);
