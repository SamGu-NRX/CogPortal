import assert from "node:assert/strict";
import { test } from "node:test";
// register-env.mjs ships without a .d.mts declaration in this change, so tsc
// cannot type this import; the test run below checks it at runtime.
// @ts-ignore
import { loadRegistrationEnv, RegistrationEnvError } from "../scripts/register-env.mjs";

// Both IDs are documented as public course identifiers in apps/discord-bot/README.md.
const APPLICATION_ID = "1526706029356646460";
const GUILD_ID = "1515858059027550321";
// 60 characters, no whitespace.
const TOKEN = "valid-token-".repeat(5);

function validEnv(): Record<string, string> {
  return {
    DISCORD_APPLICATION_ID: APPLICATION_ID,
    DISCORD_BOT_TOKEN: TOKEN,
    COURSE_GUILD_ID: GUILD_ID,
  };
}

test("returns the three values for a valid environment", () => {
  assert.deepEqual(loadRegistrationEnv(validEnv()), {
    applicationId: APPLICATION_ID,
    botToken: TOKEN,
    guildId: GUILD_ID,
  });
});

test("defaults to process.env when called without an argument", () => {
  process.env.DISCORD_APPLICATION_ID = APPLICATION_ID;
  process.env.DISCORD_BOT_TOKEN = TOKEN;
  process.env.COURSE_GUILD_ID = GUILD_ID;
  try {
    assert.deepEqual(loadRegistrationEnv(), {
      applicationId: APPLICATION_ID,
      botToken: TOKEN,
      guildId: GUILD_ID,
    });
  } finally {
    delete process.env.DISCORD_APPLICATION_ID;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.COURSE_GUILD_ID;
  }
});

test("reports a missing application ID", () => {
  const env = validEnv();
  delete env.DISCORD_APPLICATION_ID;
  assert.throws(() => loadRegistrationEnv(env), (error: unknown) => {
    assert.ok(error instanceof RegistrationEnvError);
    assert.match(
      (error as Error).message,
      /missing required environment variables: DISCORD_APPLICATION_ID\./,
    );
    assert.doesNotMatch((error as Error).message, /DISCORD_BOT_TOKEN/);
    assert.doesNotMatch((error as Error).message, /COURSE_GUILD_ID/);
    return true;
  });
});

test("reports a missing bot token", () => {
  const env = validEnv();
  delete env.DISCORD_BOT_TOKEN;
  assert.throws(() => loadRegistrationEnv(env), (error: unknown) => {
    assert.ok(error instanceof RegistrationEnvError);
    assert.match(
      (error as Error).message,
      /missing required environment variables: DISCORD_BOT_TOKEN\./,
    );
    return true;
  });
});

test("reports a missing guild ID", () => {
  const env = validEnv();
  delete env.COURSE_GUILD_ID;
  assert.throws(() => loadRegistrationEnv(env), (error: unknown) => {
    assert.ok(error instanceof RegistrationEnvError);
    assert.match(
      (error as Error).message,
      /missing required environment variables: COURSE_GUILD_ID\./,
    );
    return true;
  });
});

test("reports all three missing variables in one message", () => {
  assert.throws(() => loadRegistrationEnv({}), (error: unknown) => {
    assert.ok(error instanceof RegistrationEnvError);
    const envError = error as RegistrationEnvError;
    assert.match(
      envError.message,
      /missing required environment variables: DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, COURSE_GUILD_ID\./,
    );
    assert.equal(envError.issues.length, 1);
    return true;
  });
});

test("counts an empty-string value as missing", () => {
  const env = validEnv();
  env.DISCORD_APPLICATION_ID = "";
  assert.throws(() => loadRegistrationEnv(env), (error: unknown) => {
    assert.match(
      (error as Error).message,
      /missing required environment variables: DISCORD_APPLICATION_ID\./,
    );
    return true;
  });
});

test("reports a malformed application ID with the bad value", () => {
  const env = validEnv();
  env.DISCORD_APPLICATION_ID = "abc";
  assert.throws(() => loadRegistrationEnv(env), (error: unknown) => {
    assert.match(
      (error as Error).message,
      /DISCORD_APPLICATION_ID must be a Discord application ID \(a numeric snowflake\), got abc\./,
    );
    return true;
  });
});

test("rejects application IDs outside the 5 to 25 digit range", () => {
  for (const bad of ["1234", "9".repeat(26)]) {
    const env = validEnv();
    env.DISCORD_APPLICATION_ID = bad;
    assert.throws(() => loadRegistrationEnv(env), (error: unknown) => {
      assert.match(
        (error as Error).message,
        /DISCORD_APPLICATION_ID must be a Discord application ID \(a numeric snowflake\)/,
      );
      return true;
    });
  }
});

test("reports a malformed guild ID with the same snowflake rule", () => {
  const env = validEnv();
  env.COURSE_GUILD_ID = "abc";
  assert.throws(() => loadRegistrationEnv(env), (error: unknown) => {
    assert.match(
      (error as Error).message,
      /COURSE_GUILD_ID must be a Discord guild ID \(a numeric snowflake\), got abc\./,
    );
    return true;
  });
});

test("reports a bot token shorter than 50 characters", () => {
  const env = validEnv();
  env.DISCORD_BOT_TOKEN = "x".repeat(49);
  assert.throws(() => loadRegistrationEnv(env), (error: unknown) => {
    assert.match(
      (error as Error).message,
      /DISCORD_BOT_TOKEN must be at least 50 characters, got 49 characters\./,
    );
    return true;
  });
});

test("reports whitespace inside a bot token", () => {
  const env = validEnv();
  env.DISCORD_BOT_TOKEN = `${TOKEN.slice(0, 30)} ${TOKEN.slice(30)}`;
  assert.throws(() => loadRegistrationEnv(env), (error: unknown) => {
    assert.match((error as Error).message, /DISCORD_BOT_TOKEN must not contain whitespace/);
    return true;
  });
});

test("tells the caller to drop a Bot prefix from the token", () => {
  const env = validEnv();
  env.DISCORD_BOT_TOKEN = `Bot ${TOKEN}`;
  assert.throws(() => loadRegistrationEnv(env), (error: unknown) => {
    assert.ok(error instanceof RegistrationEnvError);
    assert.match((error as Error).message, /the Bot prefix is included/);
    assert.match((error as Error).message, /pass the raw token without the Bot prefix/);
    // The prefix is the diagnosis; the generic rules stay out of the message.
    assert.doesNotMatch((error as Error).message, /must not contain whitespace/);
    assert.doesNotMatch((error as Error).message, /must be at least 50 characters/);
    return true;
  });
});

test("reports a whitespace-wrapped value before the format rule", () => {
  const env = validEnv();
  env.DISCORD_APPLICATION_ID = ` ${APPLICATION_ID} `;
  assert.throws(() => loadRegistrationEnv(env), (error: unknown) => {
    assert.match((error as Error).message, /DISCORD_APPLICATION_ID has surrounding whitespace/);
    return true;
  });
});

test("reports a whitespace-only value as present but empty, not missing", () => {
  const env = validEnv();
  env.COURSE_GUILD_ID = "   ";
  assert.throws(() => loadRegistrationEnv(env), (error: unknown) => {
    assert.match(
      (error as Error).message,
      /COURSE_GUILD_ID is present but contains only whitespace/,
    );
    assert.doesNotMatch((error as Error).message, /missing required environment variables/);
    return true;
  });
});

test("collects every problem in one throw", () => {
  const env = validEnv();
  env.DISCORD_APPLICATION_ID = "abc";
  delete env.COURSE_GUILD_ID;
  assert.throws(() => loadRegistrationEnv(env), (error: unknown) => {
    const envError = error as RegistrationEnvError;
    assert.equal(envError.issues.length, 2);
    assert.match(envError.message, /must be a Discord application ID/);
    assert.match(envError.message, /missing required environment variables: COURSE_GUILD_ID/);
    return true;
  });
});

test("lists each problem on its own line", () => {
  const env = validEnv();
  env.DISCORD_APPLICATION_ID = "abc";
  delete env.COURSE_GUILD_ID;
  assert.throws(() => loadRegistrationEnv(env), (error: unknown) => {
    const envError = error as RegistrationEnvError;
    const lines = envError.message.split("\n");
    assert.equal(lines[0], "Invalid registration environment:");
    assert.equal(lines[1], envError.issues[0].message);
    assert.equal(lines[2], envError.issues[1].message);
    return true;
  });
});

test("never echoes token content in any message", () => {
  const secret = "SUPER-SECRET-TOKEN-VALUE";
  const wrapped = `${secret} ${"x".repeat(30)}`;
  assert.throws(
    () => loadRegistrationEnv({ ...validEnv(), DISCORD_BOT_TOKEN: wrapped }),
    (error: unknown) => {
      assert.doesNotMatch((error as Error).message, /SUPER-SECRET/);
      assert.doesNotMatch((error as Error).message, /x{10}/);
      return true;
    },
  );
  const short = "SECRET";
  assert.throws(
    () => loadRegistrationEnv({ ...validEnv(), DISCORD_BOT_TOKEN: short }),
    (error: unknown) => {
      assert.match((error as Error).message, /got 6 characters\./);
      assert.doesNotMatch((error as Error).message, /SECRET/);
      return true;
    },
  );
});

test("ignores unknown extra environment variables", () => {
  const env = { ...validEnv(), PORTAL_ORIGIN: "https://portal.example", RANDOM_EXTRA: "junk" };
  assert.deepEqual(loadRegistrationEnv(env), {
    applicationId: APPLICATION_ID,
    botToken: TOKEN,
    guildId: GUILD_ID,
  });
});

test("issues carry a field and a message", () => {
  assert.throws(() => loadRegistrationEnv({}), (error: unknown) => {
    const envError = error as RegistrationEnvError;
    assert.equal(envError.issues.length, 1);
    assert.equal(
      envError.issues[0].field,
      "DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, COURSE_GUILD_ID",
    );
    assert.equal(typeof envError.issues[0].message, "string");
    return true;
  });
});
