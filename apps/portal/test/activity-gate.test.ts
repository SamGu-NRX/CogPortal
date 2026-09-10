import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ActivityRequestError,
  gateOutcome,
  isExpiredActivitySession,
  openedExternally,
  phaseAfterOpen,
} from "../src/lib/activity-gate.ts";

/**
 * What the Activity does when a student comes back from the browser.
 *
 * The Activity read its session once at mount, so a student who linked their
 * account in the browser came back to the same "Link Cog*Portal" card and read
 * it as a failure. Reproduced against the real client with a fixture session:
 * only closing and reopening showed the console.
 *
 * These cover the decisions the card makes, not the rendering around them,
 * which needs a DOM.
 */

test("a student who backed out of Discord's leave prompt has not gone anywhere", () => {
  assert.equal(openedExternally({ opened: false }), false);
});

test("a student who accepted it has", () => {
  assert.equal(openedExternally({ opened: true }), true);
});

test("a client too old to report a result is treated as having opened it", () => {
  // Discord clients before December 2024 answer `null` whatever happened.
  // Refusing to advance would strand every one of those students on a card
  // whose button they had already pressed.
  assert.equal(openedExternally({ opened: null }), true);
});

test("finishing the link is the outcome that leaves the gate", () => {
  assert.equal(gateOutcome(false, true), "linked");
  assert.equal(gateOutcome("no_team", true), "linked");
});

test("linking without a team advances to the other card rather than repeating", () => {
  assert.equal(gateOutcome(false, "no_team"), "advanced");
});

test("a check that finds the same state owes the student a sentence", () => {
  assert.equal(gateOutcome(false, false), "unchanged");
  assert.equal(gateOutcome("no_team", "no_team"), "unchanged");
});

test("an expired Activity session belongs on the entry screen", () => {
  assert.equal(isExpiredActivitySession(new ActivityRequestError(401, "expired")), true);
});

test("a single request that did not land leaves the card where it is", () => {
  // 403 and 500 are answerable by pressing the button again; 401 is not,
  // because the cookie the request needs is gone for the rest of the hour.
  assert.equal(isExpiredActivitySession(new ActivityRequestError(403, "no team")), false);
  assert.equal(isExpiredActivitySession(new ActivityRequestError(500, "upstream")), false);
  assert.equal(isExpiredActivitySession(new Error("offline")), false);
  assert.equal(isExpiredActivitySession("offline"), false);
});

test("reopening the link while a check is running does not move the card", () => {
  // The reopen link stays pressable during a check. Letting its resolution set
  // "away" cleared the guard on the check, so a second one could start and an
  // older answer could land after a newer one, putting a linked student back on
  // the gate. Found in review; this is the sequence.
  assert.equal(phaseAfterOpen("checking"), "checking");
});

test("reopening it at rest moves the card to the check", () => {
  assert.equal(phaseAfterOpen("idle"), "away");
  assert.equal(phaseAfterOpen("away"), "away");
});
