/**
 * The one definition of "loopback only" for every origin this suite dials or
 * pins into a spawned CLI. A test CLI must never be able to send credentials,
 * reports or device links anywhere but the booted local stack: an inherited
 * COGPORTAL_URL (or a hostile STACK_INFO) would otherwise redirect real
 * requests at external or live infrastructure.
 *
 * Consumers: support/cli.ts pins COGPORTAL_URL for every spawned CLI,
 * support/stack-info.ts validates every client-dialed origin it hands out,
 * and support/loopback-guard.ts is the shell guard run-all.sh runs before the
 * journeys.
 */

const LOOPBACK_EXACT = new Set(["localhost", "::1"]);

/** Whether a URL hostname can only address this machine (localhost, 127.0.0.0/8, ::1). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_EXACT.has(host)) return true;
  // The whole 127.0.0.0/8, per the guard's contract — not just 127.0.0.1.
  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!octets) return false;
  return (
    octets.slice(1).every((o) => Number.isInteger(Number(o)) && Number(o) <= 255) &&
    Number(octets[1]) === 127
  );
}

/**
 * `origin` back, or a thrown loud refusal naming what was pointed where.
 * Anything unparseable counts as non-loopback: the suite fails closed.
 */
export function requireLoopbackOrigin(origin: string, what: string): string {
  let hostname: string | undefined;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    hostname = undefined;
  }
  if (!hostname || !isLoopbackHost(hostname)) {
    throw new Error(
      `REFUSING: ${what} is ${origin === "" ? "(empty)" : origin}, whose host is not loopback ` +
        `(localhost, 127.0.0.0/8, ::1). Test CLI and portal requests must never reach ` +
        `external or live infrastructure.`,
    );
  }
  return origin;
}
