import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldRevalidateRestoredDocument } from "../src/lib/queries.ts";

/**
 * Which page loads have to throw away what they are holding.
 *
 * A document restored from the browser's back/forward cache still shows the
 * account that was signed in when it was frozen: signing out invalidated the
 * cache of the document that signed out, not that one. Reproduced twice in
 * Helium on a shared browser.
 *
 * The condition has to be exactly the restore. An ordinary load already
 * fetches the session on mount, so firing there would put a second request on
 * every page view for no gain.
 */

test("a page restored from the back/forward cache is revalidated", () => {
  assert.equal(shouldRevalidateRestoredDocument({ persisted: true }), true);
});

test("an ordinary load is not, because mounting already fetched", () => {
  assert.equal(shouldRevalidateRestoredDocument({ persisted: false }), false);
});
