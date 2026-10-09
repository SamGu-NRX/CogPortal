/**
 * Client-side input rules for the access and admin surfaces. Each schema
 * mirrors the rule the Worker actually enforces (JoinCohortRequestSchema,
 * DevLoginRequestSchema, AdminAddMemberRequestSchema, and
 * ApproveDeviceRequestSchema in @cogworks/contracts), so an input that
 * passes here cannot fail the server's body schema either. The Worker stays
 * authoritative; these only short-circuit a request that could not succeed,
 * with a message that says what was wrong.
 */
import { z } from "zod";
import { ApiRequestError } from "./api";

/** A checked field: either a cleaned value ready to send, or one specific
 *  reason the input cannot be sent. */
export type ValidatedInput =
  | { valid: true; value: string }
  | { valid: false; message: string };

/** True only for a real ApiRequestError from the typed API client, the cases
 *  where the error message is the server's and worth showing verbatim. */
export function isApiRequestError(value: unknown): value is ApiRequestError {
  return value instanceof ApiRequestError;
}

/** Same rule as JoinCohortRequestSchema: 4 to 32 characters. The Worker
 *  uppercases before the lookup, so the cleaned value is trimmed and
 *  uppercased here too. */
const joinCodeSchema = z
  .string()
  .transform((code) => code.trim().toUpperCase())
  .pipe(
    z
      .string()
      .min(4, "A join code is at least 4 characters.")
      .max(32, "A join code is at most 32 characters."),
  );

export function validateJoinCode(input: string): ValidatedInput {
  const result = joinCodeSchema.safeParse(input);
  if (result.success) return { valid: true, value: result.data };
  return { valid: false, message: firstIssueMessage(result.error) };
}

/** Same rule as DevLoginRequestSchema.login and
 *  AdminAddMemberRequestSchema.login: 1 to 39 characters, letters, digits,
 *  and hyphens. Case is preserved; the Worker matches it exactly. */
const GITHUB_LOGIN_PATTERN = /^[a-zA-Z0-9-]+$/;

const githubLoginSchema = z
  .string()
  .transform((login) => login.trim())
  .pipe(
    z
      .string()
      .min(1, "Enter a GitHub login.")
      .max(39, "A GitHub login is at most 39 characters.")
      .regex(
        GITHUB_LOGIN_PATTERN,
        "A GitHub login uses only letters, numbers, and hyphens.",
      ),
  );

export function validateGithubLogin(input: string): ValidatedInput {
  const result = githubLoginSchema.safeParse(input);
  if (result.success) return { valid: true, value: result.data };
  return { valid: false, message: firstIssueMessage(result.error) };
}

/** Same rule as ApproveDeviceRequestSchema.deviceName: trimmed by the
 *  Worker, then 1 to 80 characters. */
const deviceNameSchema = z
  .string()
  .transform((name) => name.trim())
  .pipe(
    z
      .string()
      .min(1, "Give the device a name so you can recognize it later.")
      .max(80, "A device name is at most 80 characters."),
  );

export function validateDeviceName(input: string): ValidatedInput {
  const result = deviceNameSchema.safeParse(input);
  if (result.success) return { valid: true, value: result.data };
  return { valid: false, message: firstIssueMessage(result.error) };
}

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That input can't be used.";
}
