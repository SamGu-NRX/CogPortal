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
