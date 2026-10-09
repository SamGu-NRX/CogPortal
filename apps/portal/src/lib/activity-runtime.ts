// Runtime decisions and error wording for the Discord Activity entry, kept
// pure so node tests can load them: no JSX, no CSS imports, no window access
// at module top level.
import { z } from "zod";

// The Activity session response. This is not the portal-wide SessionSchema in
// @cogworks/contracts; this one discriminates on the Discord link state.
export const SessionSchema = z.discriminatedUnion("linked", [
  z.object({ linked: z.literal(false), linkUrl: z.string().url() }),
  z.object({
    linked: z.literal(true),
    githubLogin: z.string(),
    team: z.object({ id: z.string(), name: z.string(), discordChannelId: z.string().nullable() }),
  }),
]);
export type ActivitySession = z.infer<typeof SessionSchema>;

// Inside Discord the Activity is served under a *.discordsays.com iframe and
// reaches the Worker through the /.proxy path. In development the same bundle
// runs beside the portal, where frame_id in the query string marks the embed.
export function isEmbeddedActivity(hostname: string, search: string): boolean {
  if (hostname.endsWith(".discordsays.com")) return true;
  return new URLSearchParams(search).has("frame_id");
}

export function activityApiPrefix(embedded: boolean): string {
  return embedded ? "/.proxy/api" : "/api";
}

// Which bundle bootstrap.ts should load. The dev activity host routes to the
// Activity bundle even without frame_id; the embedded check above still
// decides the API prefix inside it.
export function pickEntryModule(hostname: string, search: string): "activity" | "main" {
  if (hostname === "cogactivity-dev.sillion.app") return "activity";
  return isEmbeddedActivity(hostname, search) ? "activity" : "main";
}

// First failing field of a parse failure, for a one-line message. Top-level
// failures (the whole body was the wrong type) read as plain prose.
function firstIssueLocation(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue || issue.path.length === 0) return "the top level";
  return `"${issue.path.map(String).join(".")}"`;
}

// Message for a 200 response whose body failed the schema. Names the endpoint
// and the first failing field so the console shows the drift, not a Zod dump.
export function describeActivityParseFailure(path: string, caught: unknown): string {
  if (caught instanceof z.ZodError) {
    return `The live bench response for ${path} did not match the expected shape at ${firstIssueLocation(caught)}.`;
  }
  if (caught instanceof Error) return caught.message;
  return `The live bench response for ${path} could not be read.`;
}

// Last stop before the UI shows a message: keep errors this file wrote, and
// replace everything else (a leaked ZodError, a thrown non-Error) with a
// short line instead of a JSON dump or "[object Object]".
export function describeActivityFailure(caught: unknown, fallback: string): string {
  if (caught instanceof z.ZodError) {
    return `The live bench sent an unexpected response shape at ${firstIssueLocation(caught)}.`;
  }
  if (caught instanceof Error) return caught.message;
  return fallback;
}
