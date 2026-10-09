import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SessionSchema,
  activityApiPrefix,
  describeActivityFailure,
  describeActivityParseFailure,
  isEmbeddedActivity,
  pickEntryModule,
} from "../src/lib/activity-runtime.ts";

// A ZodError typed through the module's own schema (safeParse failure branch),
// so the test file never imports zod directly.
function sessionSchemaRejection(value: unknown) {
  const result = SessionSchema.safeParse(value);
  if (result.success) {
    throw new Error(`expected SessionSchema to reject ${JSON.stringify(value)}`);
  }
  return result.error;
}

const linkedSession = {
  linked: true,
  githubLogin: "samgu",
  team: { id: "t1", name: "Team Cog", discordChannelId: null },
};

test("activity session accepts both linked states", () => {
  const unlinked = SessionSchema.parse({
    linked: false,
    linkUrl: "https://cogportal-dev.sillion.app/connect/discord?token=t",
  });
  assert.deepEqual(unlinked, {
    linked: false,
    linkUrl: "https://cogportal-dev.sillion.app/connect/discord?token=t",
  });
  assert.deepEqual(SessionSchema.parse(linkedSession), linkedSession);
});

test("activity session accepts a non-null discord channel id", () => {
  const withChannel = SessionSchema.parse({
    ...linkedSession,
    team: { id: "t1", name: "Team Cog", discordChannelId: "1234567890" },
  });
  assert.equal(withChannel.linked, true);
});

test("activity session rejects missing and malformed fields at the exact paths", () => {
  const cases: Array<{ value: unknown; paths: string[] }> = [
    { value: { linked: false }, paths: ["linkUrl"] },
    { value: { linked: false, linkUrl: "not a url" }, paths: ["linkUrl"] },
    { value: { linked: true, githubLogin: "samgu" }, paths: ["team"] },
    {
      value: { linked: true, team: { id: "t1", name: "Team Cog", discordChannelId: null } },
      paths: ["githubLogin"],
    },
    {
      value: { linked: true, githubLogin: "samgu", team: { id: "t1", name: "Team Cog" } },
      paths: ["team.discordChannelId"],
    },
    {
      value: { linked: true, team: { id: "t1", name: "Team Cog" } },
      paths: ["githubLogin", "team.discordChannelId"],
    },
  ];
  for (const { value, paths } of cases) {
    const error = sessionSchemaRejection(value);
    assert.deepEqual(
      error.issues.map((issue) => issue.path.map(String).join(".")),
      paths,
      `unexpected issues for ${JSON.stringify(value)}`,
    );
  }
});

test("activity session rejects a wrong discriminator", () => {
  const error = sessionSchemaRejection({ linked: "yes", linkUrl: "https://example.test" });
  assert.equal(error.name, "ZodError");
});

test("isEmbeddedActivity matches Discord hosts and the frame_id flag only", () => {
  assert.equal(isEmbeddedActivity("vehicles.discordsays.com", ""), true);
  assert.equal(isEmbeddedActivity("localhost", "?frame_id="), true);
  assert.equal(isEmbeddedActivity("localhost", "?a=1&frame_id=abc"), true);
  assert.equal(isEmbeddedActivity("evil-discordsays.com", ""), false);
  assert.equal(isEmbeddedActivity("discordsays.com", ""), false);
  assert.equal(isEmbeddedActivity("vishny.discordsays.com.attacker.io", ""), false);
  assert.equal(isEmbeddedActivity("example.com", ""), false);
  assert.equal(isEmbeddedActivity("localhost", ""), false);
  assert.equal(isEmbeddedActivity("localhost", "?frame_idX=1"), false);
});

test("activityApiPrefix picks the proxy path only when embedded", () => {
  assert.equal(activityApiPrefix(true), "/.proxy/api");
  assert.equal(activityApiPrefix(false), "/api");
});

test("pickEntryModule routes the dev activity host, Discord hosts, and frame_id to the Activity", () => {
  assert.equal(pickEntryModule("cogactivity-dev.sillion.app", ""), "activity");
  assert.equal(pickEntryModule("vehicles.discordsays.com", ""), "activity");
  assert.equal(pickEntryModule("localhost", "?frame_id="), "activity");
});

test("pickEntryModule keeps lookalike hosts and bare hosts on the main bundle", () => {
  assert.equal(pickEntryModule("evil-discordsays.com", ""), "main");
  assert.equal(pickEntryModule("cogactivity-dev.sillion.app.attacker.io", ""), "main");
  assert.equal(pickEntryModule("example.com", ""), "main");
  assert.equal(pickEntryModule("localhost", ""), "main");
});

test("describeActivityFailure keeps written error messages", () => {
  assert.equal(
    describeActivityFailure(new Error("The live bench could not be reached."), "fallback"),
    "The live bench could not be reached.",
  );
  assert.equal(describeActivityFailure(new Error(""), "fallback"), "");
});

test("describeActivityFailure shortens ZodErrors instead of dumping JSON", () => {
  const error = sessionSchemaRejection({ linked: false, linkUrl: "not a url" });
  assert.equal(
    describeActivityFailure(error, "The Activity could not open."),
    'The live bench sent an unexpected response shape at "linkUrl".',
  );
});

test("describeActivityFailure uses the fallback for anything that is not an Error", () => {
  assert.equal(describeActivityFailure("kaboom", "fallback"), "fallback");
  assert.equal(describeActivityFailure(42, "fallback"), "fallback");
  assert.equal(describeActivityFailure(undefined, "fallback"), "fallback");
  assert.equal(describeActivityFailure(null, "fallback"), "fallback");
  assert.equal(describeActivityFailure({ message: "not an error" }, "fallback"), "fallback");
});

test("describeActivityParseFailure names the endpoint and first failing field", () => {
  const error = sessionSchemaRejection({ linked: false, linkUrl: "not a url" });
  assert.equal(
    describeActivityParseFailure("/activity/session", error),
    'The live bench response for /activity/session did not match the expected shape at "linkUrl".',
  );
});

test("describeActivityParseFailure names nested fields and top-level failures", () => {
  const nested = sessionSchemaRejection({
    linked: true,
    githubLogin: "samgu",
    team: { id: "t1", name: "Team Cog" },
  });
  assert.equal(
    describeActivityParseFailure("/activity/session", nested),
    'The live bench response for /activity/session did not match the expected shape at "team.discordChannelId".',
  );

  const topLevel = sessionSchemaRejection(42);
  assert.equal(
    describeActivityParseFailure("/activity/run-surfaces", topLevel),
    "The live bench response for /activity/run-surfaces did not match the expected shape at the top level.",
  );
});
