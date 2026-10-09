/**
 * Runtime validation boundary for Portal RPC payloads.
 *
 * RunSurfaceSnapshot and RunStreamEvent values reach the Discord bot as
 * Portal RPC responses, which is network input: policy, rails, and steps
 * render from them, and before this module nothing checked them at runtime,
 * so malformed JSON degraded or crashed deep inside render functions. Call
 * the parse functions once where a response arrives and pass the parsed
 * value down.
 *
 * Note for the merger: the kit's snapshot-consuming functions should be
 * wired through these parsers at merge time.
 */
import {
  RunStreamEventSchema,
  RunSurfaceSnapshotSchema,
} from "@cogworks/contracts/schema";
import type { RunStreamEvent, RunSurfaceSnapshot } from "@cogworks/contracts/schema";

/** Structural view of a zod issue so this module does not import zod itself. */
interface ContractIssue {
  path: PropertyKey[];
  message: string;
}

/** A malformed payload can produce dozens of issues; three name the shape of the problem without flooding a Discord message. */
const MAX_ISSUES_IN_MESSAGE = 3;

function renderPath(path: readonly PropertyKey[]): string {
  return path.map(String).join(".") || "(root)";
}

function renderIssues(issues: readonly ContractIssue[]): string {
  return issues
    .slice(0, MAX_ISSUES_IN_MESSAGE)
    .map((issue) => `${renderPath(issue.path)}: ${issue.message}`)
    .join("; ");
}

function snapshotMessage(issues: readonly ContractIssue[]): string {
  return `RunSurfaceSnapshot failed contract validation (Portal RPC response): ${renderIssues(issues)}`;
}

function streamEventsMessage(issues: readonly ContractIssue[]): string {
  return `RunStreamEvent[] failed contract validation (Portal RPC response): ${renderIssues(issues)}`;
}

export function parseRunSurfaceSnapshot(value: unknown): RunSurfaceSnapshot {
  const result = RunSurfaceSnapshotSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError(snapshotMessage(result.error.issues), { cause: result.error });
  }
  return result.data;
}

export function safeParseRunSurfaceSnapshot(value: unknown): { ok: true; value: RunSurfaceSnapshot } | { ok: false; message: string } {
  const result = RunSurfaceSnapshotSchema.safeParse(value);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, message: snapshotMessage(result.error.issues) };
}

export function parseRunStreamEvents(value: unknown): RunStreamEvent[] {
  const result = RunStreamEventSchema.array().safeParse(value);
  if (!result.success) {
    throw new TypeError(streamEventsMessage(result.error.issues), { cause: result.error });
  }
  return result.data;
}
