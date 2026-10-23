import assert from "node:assert/strict";
import { test } from "node:test";
import * as schemas from "../src/schema.ts";

test("device hold accepts only a bounded user code and normalizes it like approval", () => {
  const schema = schemas.HoldDeviceRequestSchema;
  assert.ok(schema, "the hold endpoint needs its own request contract");
  assert.deepEqual(schema.parse({ userCode: " abcd-1234-ef56 " }), { userCode: "ABCD-1234-EF56" });
  assert.equal(schema.safeParse({ userCode: "UNKNOWN" }).success, true);
  for (const body of [
    {}, { userCode: 123 }, { userCode: "" }, { userCode: " " }, { userCode: "a".repeat(65) },
    { userCode: "ABCD-1234-EF56", userId: "user_1" },
    { userCode: "ABCD-1234-EF56", deviceName: "Laptop" },
  ]) {
    assert.equal(schema.safeParse(body).success, false, JSON.stringify(body));
  }
});
