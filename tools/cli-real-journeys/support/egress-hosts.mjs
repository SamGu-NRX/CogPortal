// The one egress rule for the public-data journeys, shared by the proxy
// (support/egress.mjs, run by plain `node`) and the journeys that judge its
// log. A CLI command may reach loopback (the local stack) and the documented
// public-asset hosts below. Any other destination is a defect, whether the
// proxy refused it or not.
//
// The documented hosts are the week 2/3 data sources named in
// apps/portal/src/lib/benchmark-packages.ts, README.md and
// docs/design/student-cli-and-onboarding.md.

const DOCUMENTED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "codeload.github.com",
  "huggingface.co",
  "hf.co",
  "cdn-lfs.huggingface.co",
  "cdn-lfs-us-1.huggingface.co",
  "cdn-lfs.hf.co",
  "cdn-lfs-us-1.hf.co",
  "cas-bridge.xethub.hf.co",
  "cas-server.xethub.hf.co",
  "transfer.xethub.hf.co",
  "xet.hf.co",
  "www.dropbox.com",
]);
const DOCUMENTED_SUFFIXES = [".dl.dropboxusercontent.com", ".huggingface.co", ".hf.co"];

/** @param {string} host */
export function isDocumentedHost(host) {
  const name = String(host).toLowerCase().replace(/\.$/, "");
  if (DOCUMENTED_HOSTS.has(name)) return true;
  return DOCUMENTED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** localhost, ::1 (bracketed or not), 127.0.0.0/8 and its IPv4-mapped form.
 * Mirrors support/loopback.ts, which only sees URL hostnames.
 * @param {string} host */
export function isLoopbackEgressHost(host) {
  let name = String(host).toLowerCase().replace(/\.$/, "");
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  if (name === "localhost" || name === "::1") return true;
  const v4 = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    return v4.slice(1).every((o) => Number(o) <= 255) && Number(v4[1]) === 127;
  }
  const mapped = name.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  return mapped !== null && isLoopbackEgressHost(mapped[1]);
}

/** Whether a command may attempt this destination at all.
 * @param {string} host */
export function egressAllowed(host) {
  return isLoopbackEgressHost(host) || isDocumentedHost(host);
}

/**
 * Every request attempt in a window that breaks the rule: a CONNECT or plain
 * HTTP request to a host that is neither loopback nor documented, or any
 * attempt the proxy refused. A refusal forwarded nothing, but the command
 * still tried to reach that host, so it counts.
 * @template {{kind: string, host?: string, allowed?: boolean}} E
 * @param {readonly E[]} events
 * @returns {E[]}
 */
export function egressViolations(events) {
  return events.filter(
    (event) =>
      (event.kind === "connect" || event.kind === "http") &&
      (event.allowed === false || !egressAllowed(event.host ?? "")),
  );
}
