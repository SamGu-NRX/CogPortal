/**
 * Whether the Discord double's log shows THIS live run's progress bubble in
 * the team's bound channel.
 *
 * The portal creates one message per run surface
 * (POST /api/v10/channels/<channel>/messages, with a nonce built from the
 * surface id) and edits that same message as the run moves
 * (PATCH /api/v10/channels/<channel>/messages/<message id>). See
 * apps/portal/worker/services/discord-messages.ts, syncBoundSurfaceMessage.
 * The double answers a create with a message id and records it on the log
 * entry as `messageId`.
 *
 * A window passes only when:
 *   - every channel-message create or edit in it targets the bound channel;
 *   - exactly one create carries this run's surface nonce, and its body names
 *     the benchmark and the run's short commit;
 *   - no other create appears in that channel;
 *   - every edit targets the message that create returned, and there is at
 *     least one;
 *   - the newest edit shows the finished run: "Bench clear", the short
 *     commit, and a link to this surface's page.
 */

export interface DoubleEntry {
  method?: string;
  path?: string;
  body?: unknown;
  /** The id the double answered a channel-message create with. */
  messageId?: string;
}

export interface BubbleExpectation {
  channelId: string;
  surfaceId: string;
  benchmarkTitle: string;
  shortSha: string;
}

export interface BubbleBinding {
  ok: boolean;
  problems: string[];
  create?: DoubleEntry;
  edits: DoubleEntry[];
}

const CHANNEL_MESSAGE = /^\/api\/v10\/channels\/([^/]+)\/messages(?:\/([^/?]+))?$/;

/** The nonce prefix the portal derives from a surface id (`nonce()` in
 * discord-messages.ts: the surface id's last 18 characters, then the
 * generation). */
export function surfaceNoncePrefix(surfaceId: string): string {
  return surfaceId.slice(-18);
}

function bodyText(entry: DoubleEntry): string {
  return JSON.stringify(entry.body ?? {});
}

export function bindLiveBubble(window: readonly DoubleEntry[], expected: BubbleExpectation): BubbleBinding {
  const problems: string[] = [];
  const messages = window
    .map((entry) => ({ entry, match: (entry.path ?? "").match(CHANNEL_MESSAGE) }))
    .filter(({ entry, match }) => match !== null && match[2] !== "@original" && (entry.method === "POST" || entry.method === "PATCH"));

  for (const { entry, match } of messages) {
    const channel = decodeURIComponent(match![1]);
    if (channel !== expected.channelId) {
      problems.push(`${entry.method} ${entry.path} went to channel ${channel}, not the bound channel ${expected.channelId}`);
    }
  }

  const creates = messages.filter(({ entry, match }) => entry.method === "POST" && match![2] === undefined).map(({ entry }) => entry);
  const nonce = surfaceNoncePrefix(expected.surfaceId);
  const ours = creates.filter((entry) => {
    const sent = (entry.body ?? {}) as { nonce?: unknown };
    return typeof sent.nonce === "string" && sent.nonce.startsWith(nonce);
  });
  if (ours.length !== 1) {
    problems.push(`${ours.length} message create(s) carry this surface's nonce prefix ${nonce}; expected exactly one`);
  }
  for (const other of creates.filter((entry) => !ours.includes(entry))) {
    problems.push(`an unrelated message create in the window: ${other.path} ${bodyText(other).slice(0, 120)}`);
  }
  const create = ours.length === 1 ? ours[0] : undefined;
  if (create) {
    const text = bodyText(create);
    if (!text.includes(expected.benchmarkTitle)) problems.push(`the created bubble does not name ${expected.benchmarkTitle}`);
    if (!text.includes(expected.shortSha)) problems.push(`the created bubble does not carry the run's commit ${expected.shortSha}`);
    if (!create.messageId) problems.push("the double recorded no message id for the create");
  }

  const edits = messages.filter(({ entry, match }) => entry.method === "PATCH" && match![2] !== undefined);
  for (const { entry, match } of edits) {
    if (create?.messageId && decodeURIComponent(match![2]!) !== create.messageId) {
      problems.push(`an edit to another message: ${entry.path} (this run's bubble is ${create.messageId})`);
    }
  }
  if (edits.length === 0) problems.push("no edit of the bubble");
  const last = edits.at(-1)?.entry;
  if (last) {
    const text = bodyText(last);
    if (!text.includes("Bench clear")) problems.push(`the newest edit does not show the finished run: ${text.slice(0, 160)}`);
    if (!text.includes(expected.shortSha)) problems.push(`the newest edit does not carry the run's commit ${expected.shortSha}`);
    if (!text.includes(`/run-surfaces/${expected.surfaceId}`)) problems.push(`the newest edit does not link /run-surfaces/${expected.surfaceId}`);
  }

  return { ok: problems.length === 0, problems, create, edits: edits.map(({ entry }) => entry) };
}
