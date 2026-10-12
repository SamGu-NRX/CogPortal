/**
 * The live bubble's binding to this run's channel, message and content.
 *
 * Before this fix (c722ed79, journeys/benchmark-real-run.ts:440-449) the
 * journey passed on any channel-message POST plus any channel-message PATCH
 * after the bind. Delivery to the wrong channel, another surface's message,
 * or an unrelated edit all passed. The pre-fix predicate is replayed inline
 * on each counterexample, then bindLiveBubble (which the journey now calls)
 * must reject it. The entries have the shapes the Discord double logs; the
 * bodies carry the fields the portal's runSurfaceMessage writes (heading,
 * commit chip, nonce, surface link).
 *
 * Run: npx tsx tests/live-bubble.ts  (no network, no stack)
 */
import { bindLiveBubble, surfaceNoncePrefix, type DoubleEntry } from "../support/live-bubble.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`[${ok ? "ok" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** The pre-fix predicate. */
function preFix(entries: readonly DoubleEntry[]): boolean {
  const sent = entries.filter((entry) => entry.method === "POST" && /^\/api\/v10\/channels\/[^/]+\/messages$/.test(entry.path ?? ""));
  const edited = entries.filter((entry) => entry.method === "PATCH" && /^\/api\/v10\/channels\/[^/]+\/messages(\/[^/]+)?$/.test(entry.path ?? ""));
  return sent.length > 0 && edited.length > 0;
}

const CHANNEL = "9004000000000000001";
const SURFACE = "surface_430aa50a8d35d26f4a9b";
const SHA = "d5ca692";
const expected = { channelId: CHANNEL, surfaceId: SURFACE, benchmarkTitle: "Language search", shortSha: SHA };

function view(lines: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { flags: 32768, components: [{ type: 17, components: [{ type: 10, content: lines.join("\n") }] }], ...extra };
}
const running = view(["### Language search", `-# local run  \`${SHA}\`  \`0:03\``]);
const finished = view(
  [`### Bench clear  **0.349**`, `-# Language search  \`${SHA}\`  \`0:41\``],
  { link: `http://127.0.0.1:5173/run-surfaces/${SURFACE}` },
);
const create: DoubleEntry = {
  method: "POST",
  path: `/api/v10/channels/${CHANNEL}/messages`,
  body: { ...running, nonce: `${surfaceNoncePrefix(SURFACE)}0`, enforce_nonce: true },
  messageId: "1758000000000000042",
};
const edit = (body: Record<string, unknown>, messageId = "1758000000000000042", channel = CHANNEL): DoubleEntry => ({
  method: "PATCH",
  path: `/api/v10/channels/${channel}/messages/${messageId}`,
  body,
});
// The bot's own interaction edits share the log and are not bubble traffic.
const botViewEdit: DoubleEntry = { method: "PATCH", path: "/api/v10/webhooks/journey-application/tok/messages/@original", body: { content: "home" } };

const good = [botViewEdit, create, edit(running), edit(finished)];
const goodBinding = bindLiveBubble(good, expected);
check("this run's create and its edits, ending finished, bind", goodBinding.ok, goodBinding.problems.join("; "));

const counterexamples: Array<[string, DoubleEntry[]]> = [
  ["the bubble went to another channel", [
    { ...create, path: "/api/v10/channels/1111/messages" },
    edit(running, "1758000000000000042", "1111"),
    edit(finished, "1758000000000000042", "1111"),
  ]],
  ["the create belongs to another surface", [
    { ...create, body: { ...running, nonce: `${surfaceNoncePrefix("surface_ffffffffffffffffffff")}0` } },
    edit(finished),
  ]],
  ["the only edit is to an unrelated message", [create, edit(finished, "1758000000000000999")]],
  ["an extra unrelated edit rides along", [create, edit(finished), edit(running, "1758000000000000999")]],
  ["the newest edit still shows the run in progress", [create, edit(finished), edit(running)]],
  ["the create names another commit", [{ ...create, body: { ...view(["### Language search", "-# local run  `aaaaaaa`"]), nonce: `${surfaceNoncePrefix(SURFACE)}0` } }, edit(finished)]],
  ["a second, unrelated create in the channel", [create, { ...create, body: view(["a team note"]), messageId: "1758000000000000050" }, edit(finished)]],
];
for (const [label, entries] of counterexamples) {
  const binding = bindLiveBubble(entries, expected);
  check(`red: the pre-fix predicate accepted: ${label}`, preFix(entries));
  check(`green: rejected: ${label}`, !binding.ok, binding.problems.join("; "));
}

check("no traffic at all is rejected", !bindLiveBubble([botViewEdit], expected).ok);

if (failures > 0) {
  console.error(`live-bubble: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("live-bubble: all checks passed");
