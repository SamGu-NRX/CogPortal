/**
 * How the public-data journeys judge a window of the egress witness's log.
 * Pure functions over the witness's event shapes, so tests drive the same
 * judgments the journeys make.
 *
 * Two rules, both from support/egress-hosts.mjs:
 *   - a window that claims zero requests must see no events at all;
 *   - an online window may attempt only loopback and the documented
 *     public-asset hosts. Any other attempt fails the case, refused or not.
 */
import { egressViolations, isDocumentedHost } from "./egress-hosts.mjs";
import type { EgressEvent } from "./egress.ts";

export { egressViolations, isDocumentedHost };

/** The subset of a journey Case these judgments write to. */
interface Judged {
  expect(condition: boolean, claim: string, evidence: string): void;
  claim(claim: string, evidence: string): void;
}

/** The receipt line for a window of witnessed traffic: per-host request counts
 * and bytes (tunnel totals where the CLI used https, response bytes for http). */
export function trafficSummary(events: readonly EgressEvent[]): string {
  if (events.length === 0) return "no network requests";
  const hosts = new Map<string, { requests: number; bytes: number; refused: number }>();
  for (const event of events) {
    const host = event.host ?? "(unknown)";
    const entry = hosts.get(host) ?? { requests: 0, bytes: 0, refused: 0 };
    if (event.kind === "connect" || event.kind === "http") entry.requests += 1;
    if (event.kind === "tunnel-bytes" && typeof event.received === "number") entry.bytes += event.received;
    if (event.kind === "http-response-final" && typeof event.bytes === "number") entry.bytes += event.bytes;
    if (event.allowed === false) entry.refused += 1;
    hosts.set(host, entry);
  }
  return [...hosts.entries()]
    .map(([host, s]) => `${host}: ${s.requests} requests, ${s.bytes} bytes received${s.refused ? `, ${s.refused} REFUSED` : ""}`)
    .join("; ");
}

/** Hosts in the window the documented asset list does not cover. Blind to a
 * request to a documented host, which is why a zero-request claim uses
 * zeroRequestViolation instead; kept for the week 2 witness case, which
 * shows that blindness live. */
export function undocumentedHosts(events: readonly EgressEvent[]): string[] {
  const offenders = new Set<string>();
  for (const event of events) {
    if (event.host && !isDocumentedHost(event.host)) offenders.add(event.host);
  }
  return [...offenders].sort();
}

/** The zero-request claim's detector: any event in the window, allowed or
 * refused, makes the claim false. Returns the violation text for the
 * receipt, or null when the window is empty. */
export function zeroRequestViolation(events: readonly EgressEvent[]): string | null {
  if (events.length === 0) return null;
  const requests = events.filter((event) => event.kind === "connect" || event.kind === "http");
  const refused = events.filter((event) => event.allowed === false);
  const parts = [`${events.length} witnessed event(s)`, `${requests.length} request(s)`];
  if (refused.length > 0) parts.push(`${refused.length} refused (nothing forwarded)`);
  return `${parts.join(", ")} — ${trafficSummary(events)}`;
}

/**
 * The online window's assertion. Every attempt must target loopback or a
 * documented public-asset host; a refused attempt fails the case the same as
 * an allowed one. The datasets library's download-count HEAD to
 * s3.amazonaws.com is one such attempt and is not exempt: no student
 * document names that host.
 */
export function assertOnlineEgress(case_: Judged, events: readonly EgressEvent[], what: string): void {
  const violations = egressViolations(events);
  case_.expect(
    violations.length === 0,
    `${what} attempted only loopback and documented public-asset hosts (a refused attempt still fails)`,
    violations.length === 0
      ? trafficSummary(events)
      : `${violations.length} forbidden attempt(s): ${violations
          .map((event) => `${event.method ?? event.kind} ${event.host ?? "(unknown)"}${event.allowed === false ? " (refused)" : " (ALLOWED)"}`)
          .join(", ")} — window: ${trafficSummary(events)}`,
  );
  case_.claim(
    "witnessed downloads",
    trafficSummary(events.filter((event) => event.kind === "tunnel-bytes" || event.kind === "http-response-final")),
  );
}
