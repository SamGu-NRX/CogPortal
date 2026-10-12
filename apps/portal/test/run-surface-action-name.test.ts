import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ApiHttpError, publicApiError } from "../worker/http/errors.ts";
import { RUN_SURFACE_MUTATIONS, runSurfaceMutation } from "../worker/services/run-actions.ts";

/**
 * The action segment of `/run-surfaces/:id/actions/:action` (portal and
 * Activity). The real-journeys route matrix found that an unknown name
 * answered 500 "The request could not be completed by the configured
 * backend": the routes parsed it with `z.enum(...).parse`, and a ZodError is
 * not a public error, so the handler reported a backend fault.
 */

test("every action the console offers is accepted as itself", () => {
  for (const name of RUN_SURFACE_MUTATIONS) assert.equal(runSurfaceMutation(name), name);
});

test("an unknown action is the API's own 404, not a server fault", () => {
  for (const name of ["rj_not_an_action", "", "VERIFY_HOSTED", "retry ", "__proto__", "constructor", "toString"]) {
    assert.throws(
      () => runSurfaceMutation(name),
      (error: unknown) => {
        const known = publicApiError(error);
        assert.ok(known instanceof ApiHttpError, `${JSON.stringify(name)} must raise a public error`);
        assert.deepEqual([known.status, known.code, known.message], [404, "not_found", "API route not found."]);
        return true;
      },
    );
  }
});

test("both action routes read the name through the one parser", () => {
  const routes = join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "routes");
  for (const file of ["run-surfaces.ts", "activity.ts"]) {
    const source = readFileSync(join(routes, file), "utf8");
    assert.match(source, /runSurfaceMutation\(c\.req\.param\("action"\)\)/, file);
    assert.doesNotMatch(source, /Mutation\w*Schema\.parse\(/, file);
  }
});
