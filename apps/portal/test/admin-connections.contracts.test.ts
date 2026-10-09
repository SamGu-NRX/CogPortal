import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { ApiRequestError } from "../src/lib/api.ts";
import {
  isApiRequestError,
  validateDeviceName,
  validateGithubLogin,
  validateJoinCode,
  type ValidatedInput,
} from "../src/lib/access-validators.ts";

function valid(input: ValidatedInput): string {
  assert.equal(input.valid, true, `expected valid, got: ${JSON.stringify(input)}`);
  return input.value;
}

function invalid(input: ValidatedInput): string {
  assert.equal(input.valid, false, `expected invalid, got: ${JSON.stringify(input)}`);
  return input.message;
}

test("isApiRequestError accepts a real ApiRequestError and narrows to code and status", () => {
  const error = new ApiRequestError("cohort_code_invalid", "The cohort join code is invalid.", 403);
  assert.equal(isApiRequestError(error), true);
  // The predicate must let TypeScript see the fields the UI reads.
  assert.equal(error.code, "cohort_code_invalid");
  assert.equal(error.status, 403);
});

test("isApiRequestError rejects a plain Error, a ZodError, and junk values", () => {
  let zodError: z.ZodError;
  try {
    z.string().parse(5);
    assert.fail("expected z.string().parse(5) to throw a ZodError");
  } catch (thrown) {
    if (!(thrown instanceof z.ZodError)) throw thrown;
    zodError = thrown;
  }
  const junk: unknown[] = [
    new Error("ordinary"),
    zodError,
    null,
    undefined,
    42,
    "ApiRequestError",
    { code: "network", message: "shaped like one", status: 0 },
    [],
  ];
  for (const value of junk) {
    assert.equal(isApiRequestError(value), false, `expected false for: ${String(value)}`);
  }
});

test("validateJoinCode trims and uppercases a valid code", () => {
  assert.deepEqual(validateJoinCode("  vision26  "), {
    valid: true,
    value: "VISION26",
  });
});

test("validateJoinCode accepts the 4 and 32 character boundaries", () => {
  assert.equal(valid(validateJoinCode("ab12")), "AB12");
  assert.equal(valid(validateJoinCode("a".repeat(32))), "A".repeat(32));
});

test("validateJoinCode rejects codes shorter than 4 with the exact message", () => {
  assert.equal(
    invalid(validateJoinCode("ab1")),
    "A join code is at least 4 characters.",
  );
  assert.equal(
    invalid(validateJoinCode("   ")),
    "A join code is at least 4 characters.",
  );
  assert.equal(invalid(validateJoinCode("")), "A join code is at least 4 characters.");
});

test("validateJoinCode rejects codes longer than 32 with the exact message", () => {
  assert.equal(
    invalid(validateJoinCode("a".repeat(33))),
    "A join code is at most 32 characters.",
  );
});

test("validateGithubLogin trims but preserves case of a valid login", () => {
  assert.deepEqual(validateGithubLogin("  Ada-L  "), { valid: true, value: "Ada-L" });
});

test("validateGithubLogin accepts the 1 and 39 character boundaries", () => {
  assert.equal(valid(validateGithubLogin("a")), "a");
  assert.equal(valid(validateGithubLogin("a".repeat(39))), "a".repeat(39));
});

test("validateGithubLogin rejects empty and whitespace-only input with the exact message", () => {
  assert.equal(invalid(validateGithubLogin("")), "Enter a GitHub login.");
  assert.equal(invalid(validateGithubLogin("   ")), "Enter a GitHub login.");
});

test("validateGithubLogin rejects logins longer than 39 with the exact message", () => {
  assert.equal(
    invalid(validateGithubLogin("a".repeat(40))),
    "A GitHub login is at most 39 characters.",
  );
});

test("validateGithubLogin rejects characters outside the Worker's pattern", () => {
  assert.equal(
    invalid(validateGithubLogin("sam gui")),
    "A GitHub login uses only letters, numbers, and hyphens.",
  );
  assert.equal(
    invalid(validateGithubLogin("sam_gui")),
    "A GitHub login uses only letters, numbers, and hyphens.",
  );
  assert.equal(
    invalid(validateGithubLogin("sam@ui")),
    "A GitHub login uses only letters, numbers, and hyphens.",
  );
});

test("validateDeviceName trims inner-kept spacing of a valid name", () => {
  assert.deepEqual(validateDeviceName("  Lab laptop 12  "), {
    valid: true,
    value: "Lab laptop 12",
  });
});

test("validateDeviceName accepts the 80 character boundary and rejects 81", () => {
  assert.equal(valid(validateDeviceName("a".repeat(80))), "a".repeat(80));
  assert.equal(
    invalid(validateDeviceName("a".repeat(81))),
    "A device name is at most 80 characters.",
  );
});

test("validateDeviceName rejects empty and whitespace-only names with the exact message", () => {
  assert.equal(
    invalid(validateDeviceName("")),
    "Give the device a name so you can recognize it later.",
  );
  assert.equal(
    invalid(validateDeviceName("   ")),
    "Give the device a name so you can recognize it later.",
  );
});
