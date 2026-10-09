import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionRow,
  button,
  linkButton,
  section,
  separator,
  surface,
  text,
  thumbnail,
} from "../src/components.ts";
import { chip, elapsed, fitTextBudget, metaLine, metricValue, META_SEP } from "../src/format.ts";
import { emojiFormatter, progressBar, quotaCells, type EmojiManifest } from "../src/emoji.ts";

test("components build the documented Discord shapes", () => {
  assert.deepEqual(text("hello"), { type: 10, content: "hello" });
  assert.equal(text("x".repeat(5_000)).content.length, 4_000);
  assert.deepEqual(separator(), { type: 14, divider: true, spacing: 1 });
  assert.deepEqual(button("cog:home", "Home", 1), {
    type: 2,
    style: 1,
    label: "Home",
    custom_id: "cog:home",
    disabled: undefined,
  });
  assert.deepEqual(linkButton("https://example.com", "Open"), {
    type: 2,
    style: 5,
    label: "Open",
    url: "https://example.com",
  });
  const row = actionRow(...Array.from({ length: 7 }, (_, index) => button(`cog:${index}`, "b")));
  assert.equal(row.components.length, 5);
  const container = surface([text("body")], 0x1c2637);
  assert.equal(container.type, 17);
  assert.equal(container.accent_color, 0x1c2637);
});

test("sections carry at most three text displays and one accessory", () => {
  const accessory = button("cog:surface:s:open_console", "Watch live");
  const built = section([text("a"), text("b"), text("c"), text("d")], accessory);
  assert.equal(built.type, 9);
  assert.equal(built.components.length, 3);
  assert.equal(built.accessory, accessory);
  const withThumb = section(text("only"), thumbnail("attachment://card.png", "score card"));
  assert.equal(withThumb.components.length, 1);
  assert.equal(withThumb.accessory.type, 11);
});

test("format helpers render chips, elapsed time, and metric values", () => {
  assert.equal(chip("89353d0"), "`89353d0`");
  assert.equal(elapsed(0), "0:00");
  assert.equal(elapsed(49_000), "0:49");
  assert.equal(elapsed(94_000), "1:34");
  assert.equal(
    metricValue({ key: "a", label: "Accuracy", value: 0.9126, unit: null, higherIsBetter: true, primary: true, precision: 3 }),
    "0.913",
  );
  assert.equal(metaLine(["a", null, "b", false, undefined, "c"]), `a${META_SEP}b${META_SEP}c`);
});

test("fitTextBudget drops flexible lines before the limit, never fixed ones", () => {
  const fixed = ["#".repeat(3_990)];
  assert.deepEqual(fitTextBudget(fixed, ["12345678", "x"]), ["12345678"]);
  assert.deepEqual(fitTextBudget(["#".repeat(4_000)], ["a"]), []);
  const roomy = fitTextBudget(["head"], ["one", "two"]);
  assert.deepEqual(roomy, ["one", "two"]);
});

test("emoji formatter uses the manifest when present and font glyphs when not", () => {
  const manifest: EmojiManifest = {
    app1: {
      cog_done: { id: "123", animated: false },
      cog_spin: { id: "456", animated: true },
    },
  };
  const withManifest = emojiFormatter("app1", manifest);
  assert.equal(withManifest("cog_done"), "<:cog_done:123>");
  assert.equal(withManifest("cog_spin"), "<a:cog_spin:456>");
  assert.equal(withManifest("cog_fail"), "×");
  const withoutManifest = emojiFormatter(undefined, manifest);
  assert.equal(withoutManifest("cog_done"), "✓");
  assert.equal(withoutManifest("cog_pend"), "○");
});

test("progress bar fills monotonically and only completes at the real total", () => {
  const fmt = emojiFormatter(undefined, {});
  assert.equal(progressBar(0, 40, fmt), "▱▱▱▱▱▱▱▱");
  assert.equal(progressBar(20, 40, fmt), "▰▰▰▰▱▱▱▱");
  assert.equal(progressBar(39, 40, fmt), "▰▰▰▰▰▰▰▱");
  assert.equal(progressBar(40, 40, fmt), "▰▰▰▰▰▰▰▰");
  assert.equal(progressBar(50, 40, fmt), "▰▰▰▰▰▰▰▰");
  assert.equal(progressBar(-1, 40, fmt), "▱▱▱▱▱▱▱▱");
});

test("quota cells mark spent and remaining attempts", () => {
  const fmt = emojiFormatter(undefined, {});
  assert.equal(quotaCells(1, 3, fmt), "▮▯▯");
  assert.equal(quotaCells(3, 3, fmt), "▮▮▮");
  assert.equal(quotaCells(0, 3, fmt), "▯▯▯");
});

test("elapsed renders the minute boundary and unpadded minutes past the hour", () => {
  assert.equal(elapsed(59_999), "0:59");
  assert.equal(elapsed(60_000), "1:00");
  // Minutes print unpadded once the hour overflows, so a full hour is "60:00",
  // not "1:00:00"; seconds stay zero-padded.
  assert.equal(elapsed(3_600_000), "60:00");
});

test("fitTextBudget handles empty regions and exact-fit lines", () => {
  // With nothing fixed the whole budget is flexible.
  assert.deepEqual(fitTextBudget([], ["a", "b"]), ["a", "b"]);
  // Nothing flexible gives an empty result rather than an error.
  assert.deepEqual(fitTextBudget(["head"], []), []);
  // The limit counts the newline after every line, so a 3,999-char line plus
  // its newline fits a 4,000 budget exactly and one more character does not.
  assert.deepEqual(fitTextBudget([], ["x".repeat(3_999)]), ["x".repeat(3_999)]);
  assert.deepEqual(fitTextBudget([], ["x".repeat(4_000)]), []);
  // A fixed line consumes budget with its own newline before flexible ones.
  assert.deepEqual(fitTextBudget(["abcd"], ["y".repeat(3_994)]), ["y".repeat(3_994)]);
  assert.deepEqual(fitTextBudget(["abcd"], ["y".repeat(3_995)]), []);
});

test("text keeps exactly 4,000 characters unchanged", () => {
  const exact = text("y".repeat(4_000));
  assert.equal(exact.content.length, 4_000);
  assert.equal(exact.content, "y".repeat(4_000));
});

test("metaLine with no present parts renders an empty string", () => {
  assert.equal(metaLine([]), "");
  assert.equal(metaLine([null, undefined, false]), "");
});

test("actionRow keeps exactly five buttons", () => {
  const five = Array.from({ length: 5 }, (_, index) => button(`cog:five:${index}`, "b"));
  assert.deepEqual(actionRow(...five).components, five);
});

test("progress bar sweeps monotonically over the whole run", () => {
  const fmt = emojiFormatter(undefined, {});
  let previous = -1;
  for (let current = 0; current <= 40; current += 1) {
    const bar = progressBar(current, 40, fmt);
    const filled = [...bar].filter((glyph) => glyph === "▰").length;
    assert.ok(filled >= previous, `progress bar lost fill at current=${current}`);
    assert.equal(bar.length, 8);
    previous = filled;
  }
  assert.equal(progressBar(0, 40, fmt), "▱▱▱▱▱▱▱▱");
  assert.equal(progressBar(10, 40, fmt), "▰▰▱▱▱▱▱▱");
  assert.equal(progressBar(20, 40, fmt), "▰▰▰▰▱▱▱▱");
  assert.equal(progressBar(40, 40, fmt), "▰▰▰▰▰▰▰▰");
});

test("emojiObject returns the id/name/animated object form for manifest entries", async () => {
  // emojiObject is not imported at the top of this file and this part may only
  // add test blocks, so the import lives inside the test.
  const { emojiObject } = await import("../src/emoji.ts");
  const manifest: EmojiManifest = {
    app1: {
      cog_done: { id: "123", animated: false },
      cog_spin: { id: "456", animated: true },
    },
  };
  assert.deepEqual(emojiObject("cog_done", "app1", manifest), { id: "123", name: "cog_done", animated: false });
  assert.deepEqual(emojiObject("cog_spin", "app1", manifest), { id: "456", name: "cog_spin", animated: true });
});
