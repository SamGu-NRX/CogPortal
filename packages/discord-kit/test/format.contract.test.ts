import assert from "node:assert/strict";
import { test } from "node:test";
import type { Metric } from "@cogworks/contracts/schema";
import { chip, elapsed, fitTextBudget, metaLine, metricValue, META_SEP } from "../src/format.ts";

// Contract tests for src/format.ts: exact rendered output for valid and
// boundary inputs, exact TypeError messages for invalid ones. The error
// regexes match the full rendered error (name + message), not a substring.

function metric(overrides: Partial<Metric> = {}): Metric {
  return {
    key: "accuracy",
    label: "Accuracy",
    value: 0.9126,
    unit: null,
    higherIsBetter: true,
    primary: true,
    precision: 3,
    ...overrides,
  };
}

test("elapsed renders minutes:seconds with seconds padded and minutes unpadded", () => {
  assert.equal(elapsed(0), "0:00");
  assert.equal(elapsed(49_000), "0:49");
  assert.equal(elapsed(94_000), "1:34");
  assert.equal(elapsed(59_999), "0:59");
  assert.equal(elapsed(60_000), "1:00");
  // Minutes over 59 print unpadded ("60:00", not "1:00:00"): the m:ss shape
  // holds for the benchmark durations seen in practice.
  assert.equal(elapsed(3_600_000), "60:00");
});

test("elapsed rejects non-finite input instead of printing NaN:NaN", () => {
  assert.throws(
    () => elapsed(NaN),
    /^TypeError: elapsed: expected a finite number of milliseconds, got NaN$/,
  );
  assert.throws(
    () => elapsed(Infinity),
    /^TypeError: elapsed: expected a finite number of milliseconds, got Infinity$/,
  );
  assert.throws(
    () => elapsed(-Infinity),
    /^TypeError: elapsed: expected a finite number of milliseconds, got -Infinity$/,
  );
});

test("chip wraps the value in a code span", () => {
  assert.equal(chip("89353d0"), "`89353d0`");
  assert.equal(chip("a b/c"), "`a b/c`");
});

test("chip rejects backticks that would close the code span early", () => {
  assert.throws(
    () => chip("has`tick"),
    /^TypeError: chip: value must be a single line without backticks, got "has`tick"$/,
  );
});

test("chip rejects newlines that would break the code span", () => {
  assert.throws(
    () => chip("two\nlines"),
    /^TypeError: chip: value must be a single line without backticks, got "two\nlines"$/,
  );
});

test("chip echoes invalid values truncated at 40 characters", () => {
  assert.throws(
    () => chip("`".repeat(50)),
    /^TypeError: chip: value must be a single line without backticks, got "`{40}\.\.\."$/,
  );
  // Exactly 40 characters is echoed in full, no ellipsis.
  assert.throws(
    () => chip("a".repeat(39) + "`"),
    /^TypeError: chip: value must be a single line without backticks, got "a{39}`"$/,
  );
});

test("metaLine joins the present parts with META_SEP and drops the rest", () => {
  assert.equal(metaLine(["a", null, "b", false, undefined, "c"]), `a${META_SEP}b${META_SEP}c`);
  assert.equal(metaLine(["only"]), "only");
  // All-empty input joins to an empty string, never a stray separator.
  assert.equal(metaLine([null, undefined, false]), "");
  assert.equal(metaLine([]), "");
});

test("metaLine accepts readonly arrays", () => {
  const parts: ReadonlyArray<string | null | undefined | false> = ["x", null, "y"];
  assert.equal(metaLine(parts), `x${META_SEP}y`);
});

test("metricValue renders the unit when present and a bare value otherwise", () => {
  assert.equal(metricValue(metric()), "0.913");
  // Both null and "" mean no unit; "" renders bare like null does.
  assert.equal(metricValue(metric({ unit: "" })), "0.913");
  assert.equal(metricValue(metric({ unit: "%" })), "0.913 %");
});

test("metricValue honors precision at the schema bounds", () => {
  // MetricSchema bounds precision 0..6; toFixed covers the range.
  assert.equal(metricValue(metric({ value: 2.4, precision: 0 })), "2");
  assert.equal(metricValue(metric({ value: 0.9126457, precision: 6 })), "0.912646");
});

test("metricValue rejects non-finite values, naming the metric key", () => {
  assert.throws(
    () => metricValue(metric({ value: NaN })),
    /^TypeError: metricValue: metric "accuracy" must have a finite value, got NaN$/,
  );
  assert.throws(
    () => metricValue(metric({ key: "latency", value: Infinity })),
    /^TypeError: metricValue: metric "latency" must have a finite value, got Infinity$/,
  );
});

test("fitTextBudget keeps a lone flexible line that exactly fits the limit", () => {
  // A lone line joins with no newline, so it costs exactly its own length.
  assert.deepEqual(fitTextBudget([], ["x".repeat(4_000)]), ["x".repeat(4_000)]);
  // One character over is still dropped.
  assert.deepEqual(fitTextBudget([], ["x".repeat(4_001)]), []);
});

test("fitTextBudget charges one newline between kept lines, never a trailing one", () => {
  // 3998 + "\n" + "b" = exactly 4000 characters.
  assert.deepEqual(fitTextBudget([], ["a".repeat(3_998), "b"]), ["a".repeat(3_998), "b"]);
  // 3999 + "\n" + "b" = 4001 characters, one over.
  assert.deepEqual(fitTextBudget([], ["a".repeat(3_999), "b"]), ["a".repeat(3_999)]);
});

test("fitTextBudget keeps the pinned conservative boundary with a fixed block", () => {
  // 3990 + "\n" + "12345678" leaves one spare character under the fixed
  // block's per-line accounting; "x" would need two and is dropped.
  assert.deepEqual(fitTextBudget(["#".repeat(3_990)], ["12345678", "x"]), ["12345678"]);
  assert.deepEqual(fitTextBudget(["head"], ["one", "two"]), ["one", "two"]);
});

test("fitTextBudget validates the limit", () => {
  assert.throws(
    () => fitTextBudget([], [], NaN),
    /^TypeError: fitTextBudget: limit must be a finite number >= 0, got NaN$/,
  );
  assert.throws(
    () => fitTextBudget([], [], Infinity),
    /^TypeError: fitTextBudget: limit must be a finite number >= 0, got Infinity$/,
  );
  assert.throws(
    () => fitTextBudget([], [], -1),
    /^TypeError: fitTextBudget: limit must be a finite number >= 0, got -1$/,
  );
  // Zero is a valid limit: nothing nonempty fits.
  assert.deepEqual(fitTextBudget([], ["x"], 0), []);
});

test("fitTextBudget accepts readonly line arrays", () => {
  const fixed: ReadonlyArray<string> = ["head"];
  const flexible: ReadonlyArray<string> = ["one", "two"];
  assert.deepEqual(fitTextBudget(fixed, flexible), ["one", "two"]);
});
