import test from "node:test";
import assert from "node:assert/strict";
import { pickVenvInterpreter } from "../lib/state-gen.mjs";

// Weeks 2/3 declare requires-python <3.13 and week1's example pins
// scipy<1.13 / numpy<2, so a 3.13 interpreter fails every week for
// environment reasons. The venv must pick the newest interpreter the
// course stack actually supports.
test("prefers the first candidate under 3.13", () => {
  const picked = pickVenvInterpreter({
    candidates: ["python3.12", "python3.11", "python3"],
    probe: (name) => (name === "python3.12" ? "3.12" : name === "python3.11" ? "3.11" : "3.13"),
  });
  assert.equal(picked, "python3.12");
});

test("skips candidates that are missing or too new", () => {
  const picked = pickVenvInterpreter({
    candidates: ["python3.13", "python3.11", "python3"],
    probe: (name) => (name === "python3.13" ? null : name === "python3.11" ? "3.11" : "3.13"),
  });
  assert.equal(picked, "python3.11");
});

test("falls back to python3 when every candidate is 3.13+", () => {
  const picked = pickVenvInterpreter({
    candidates: ["python3.12", "python3.11"],
    probe: () => "3.13",
  });
  assert.equal(picked, "python3");
});
