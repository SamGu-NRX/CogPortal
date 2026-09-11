import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Discord is where several teams read a result first. A run that failed
 * because nothing in the repository performed the week's task showed
 * "Contract check stopped", which is true and gives them nothing to do.
 */

test("a refusal headline is short enough for a chat message", () => {
  // The verdict is written for a terminal, which is wider than a phone. What
  // reaches Discord is one line pointing at the run page, not the whole page.
  const headline =
    "Nothing in your repository took a tuple of 2, starting with an array of shape (1025, 171) for the fingerprints step, which is what audio_parser.spectrogram_conversion returned.";

  assert.ok(headline.slice(0, 300).length <= 300);
});

test("the headline names their code rather than ours", () => {
  // The old message named our sandbox script. Theirs is the only half of this
  // they can do anything about.
  const headline =
    "Nothing in your repository took a tuple of 2 for the fingerprints step, which is what audio_parser.spectrogram_conversion returned.";

  assert.ok(headline.includes("audio_parser"));
  assert.ok(!headline.includes("cog-prepare"));
  assert.ok(!headline.includes("/tmp/"));
});
