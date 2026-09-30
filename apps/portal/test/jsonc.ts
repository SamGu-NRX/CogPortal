/**
 * Read a Wrangler `.jsonc` file the way Wrangler does, for tests only.
 *
 * Node has no JSONC parser and the workspace has no dependency that exposes
 * one, so this is the smallest thing that reads these two configuration files
 * correctly. It lives under `test/` rather than in a package because nothing
 * in the product parses configuration; only the tests that assert on it do.
 * The bot's config test imports it from here so there is one copy.
 *
 * Character by character rather than by regex, and not out of caution for its
 * own sake. Every origin in these files contains a double slash, and the cron
 * schedule in `triggers` is a string whose first two characters are a star and
 * a slash, which is a block-comment terminator. A regex that ignored string
 * state would cut the configuration in half and the tests would still report
 * something.
 */
export function parseJsonc<T>(text: string): T {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (inLineComment) {
      if (character === "\n") {
        inLineComment = false;
        out += character;
      }
      continue;
    }
    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += character;
      if (character === "\\") {
        out += next ?? "";
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      out += character;
      continue;
    }
    if (character === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    out += character;
  }
  // Wrangler accepts trailing commas and JSON.parse does not. Safe on the
  // comment-stripped text because no string value in these files ends in a
  // comma before a closing brace.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as T;
}
