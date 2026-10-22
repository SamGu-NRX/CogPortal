import assert from "node:assert/strict";
import { test } from "node:test";
import { discordApiRoot } from "../worker/services/discord-api.ts";

// One root for every Discord call, versioned or not. The override replaces
// exactly https://discord.com/api, so /v10 and /oauth2 land on the same host
// whichever client builds them.
test("discordApiRoot is discord.com/api unless the seam replaces it", () => {
  assert.equal(discordApiRoot(undefined), "https://discord.com/api");
  assert.equal(discordApiRoot({ DISCORD_API_BASE_URL: undefined }), "https://discord.com/api");
  assert.equal(discordApiRoot({ DISCORD_API_BASE_URL: "" }), "https://discord.com/api");
  assert.equal(discordApiRoot({ DISCORD_API_BASE_URL: "http://127.0.0.1:8823" }), "http://127.0.0.1:8823");
  assert.equal(discordApiRoot({ DISCORD_API_BASE_URL: "http://127.0.0.1:8823/" }), "http://127.0.0.1:8823");
});
