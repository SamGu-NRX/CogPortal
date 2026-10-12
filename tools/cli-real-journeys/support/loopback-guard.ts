import { requireLoopbackOrigin } from "./loopback.ts";

/**
 * Shell guard: `npx tsx support/loopback-guard.ts <origin>` — exits 0 when
 * `<origin>` can only address this machine, or prints a loud refusal to
 * stderr and exits 2. run-all.sh runs it on the origin it is about to pin
 * into every CLI process, before any journey starts.
 */
const origin = process.argv[2] ?? "";
try {
  requireLoopbackOrigin(origin, "the origin run-all.sh will use for every CLI and portal request");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("run-all.sh: refusing to run against a non-loopback origin.");
  process.exit(2);
}
console.log(`loopback guard: ok — ${origin} can only reach this machine`);
