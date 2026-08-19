import assert from "node:assert/strict";
import { test } from "node:test";
import { observation } from "../worker/services/team-nudges.ts";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const NOW = 1_760_000_000_000;

function team(overrides: Partial<Parameters<typeof observation>[0]> = {}) {
  return {
    teamId: "team_1",
    teamName: "Team One",
    channelId: "123",
    firstAttemptAt: NOW - 3 * DAY,
    lastScoredAt: null,
    ...overrides,
  } as Parameters<typeof observation>[0];
}

test("a team that has never started a run is left alone", () => {
  // They are still setting up, and the setup flow already tells them what to
  // do. A message here would be the portal talking over another surface.
  assert.equal(observation(team({ firstAttemptAt: null }), NOW), null);
});

test("a team that started this morning is left alone", () => {
  // Not integrating within a few hours is not a finding. Saying so is nagging.
  assert.equal(observation(team({ firstAttemptAt: NOW - 3 * HOUR }), NOW), null);
});

test("a team a day in with nothing scored hears about integration", () => {
  const found = observation(team({ firstAttemptAt: NOW - 2 * DAY }), NOW);
  assert.equal(found?.kind, "no_first_light");
  assert.match(found!.message, /No run has scored yet/);
  assert.match(found!.message, /all the pieces\s+together is the most important part/);
});

test("a team that scored recently hears nothing", () => {
  assert.equal(observation(team({ lastScoredAt: NOW - 6 * HOUR }), NOW), null);
});

test("a team quiet for two days since their last score hears about it", () => {
  const found = observation(team({ lastScoredAt: NOW - 3 * DAY }), NOW);
  assert.equal(found?.kind, "quiet_since_first_light");
  assert.match(found!.message, /3 days ago/);
});

test("one day is singular", () => {
  // Ordinary care, and the kind of thing that reads as carelessness when a
  // student sees "1 days ago" from a tool that is telling them what to do.
  const found = observation(team({ lastScoredAt: NOW - (2 * DAY + HOUR) }), NOW);
  assert.match(found!.message, /2 days ago/);
});

test("no message names a person or counts anything per person", () => {
  // The rule from docs/design/the-instrument-not-the-judge.md. A number
  // attached to a name gets read as a grade regardless of the words around
  // it, and the instructor shut down exactly that framing in class.
  const messages = [
    observation(team({ firstAttemptAt: NOW - 2 * DAY }), NOW)!.message,
    observation(team({ lastScoredAt: NOW - 3 * DAY }), NOW)!.message,
  ];
  for (const message of messages) {
    assert.doesNotMatch(message, /\b(commits?|lines?)\b.*\bby\b/i);
    assert.doesNotMatch(message, /@\w/, "no mentions");
    assert.doesNotMatch(message, /\bwho\b/i);
  }
});

test("no message uses an em dash", () => {
  // Banned in every student-facing string; see CLAUDE.md.
  const messages = [
    observation(team({ firstAttemptAt: NOW - 2 * DAY }), NOW)!.message,
    observation(team({ lastScoredAt: NOW - 3 * DAY }), NOW)!.message,
  ];
  for (const message of messages) assert.doesNotMatch(message, /—/);
});
