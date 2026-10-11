"""The preflight has to be wrong in the right direction.

It exists to answer "is this environment ready for a real dispatch?" before
anyone spends money finding out. Two ways it could fail at that, and they are
not symmetric. Reporting a problem that is not there costs a few minutes.
Reporting READY over a broken signing boundary sends a job that comes back as
a bare 401 with no diagnostics on either side, which is exactly the failure it
was written to prevent.

So these tests are mostly about the second kind. A missing variable fails and
names itself. A mismatched signer fails and does not round to "probably fine".
A signer that cannot be run at all reports UNKNOWN rather than PASS, and
UNKNOWN keeps the exit status nonzero.
"""

from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "tools"))
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))

from preflight_dispatch import (  # noqa: E402
    FAIL,
    PASS,
    SIGNING_VECTORS,
    UNKNOWN,
    Check,
    check_callback_direction,
    check_callback_origin,
    check_execution_provider,
    check_image_digest,
    check_required_variables,
    check_runtime_floors,
    check_verify_accepts_and_refuses,
    compare_signatures,
    extract_typescript_function,
    load_values,
    one_line,
    parse_env_file,
    python_signer,
    report,
    sandbox_floors,
)

READY = {
    "EXECUTION_PROVIDER": "modal",
    "MODAL_RUNNER_URL": "https://workspace--cogworks-runner-submit-job.modal.run",
    "RUNNER_SIGNING_SECRET": "not-the-real-one",
    "RUNNER_SIGNING_KEY_ID": "runner-v1",
    "PUBLIC_ORIGIN": "https://cogportal-dev.example.app",
    "RUNNER_IMAGE_DIGEST": "cogworks-runner-week3@im-2AbCdEfGhIjK",
}


def status_of(checks, name_starts_with):
    for check in checks:
        if check.name.startswith(name_starts_with):
            return check
    raise AssertionError(
        "no check named {!r} among {}".format(
            name_starts_with, [check.name for check in checks]
        )
    )


class MissingVariables(unittest.TestCase):
    """Every required variable must fail by name when it is absent.

    Written against the tuple rather than a hand-listed set, so a variable
    added to REQUIRED_VARIABLES without a fix message fails this test by
    existing rather than by being forgotten.
    """

    def test_a_full_environment_passes_every_variable(self):
        checks = check_required_variables(READY)
        self.assertTrue(all(check.status == PASS for check in checks), [c.reason for c in checks])

    def test_each_missing_variable_fails_and_says_which(self):
        from preflight_dispatch import REQUIRED_VARIABLES

        for name in REQUIRED_VARIABLES:
            partial = {key: value for key, value in READY.items() if key != name}
            check = status_of(check_required_variables(partial), "variable " + name)
            self.assertEqual(check.status, FAIL, name)
            self.assertIn(name, check.name)
            self.assertTrue(check.fix, "{} failed without saying how to fix it".format(name))

    def test_an_empty_string_counts_as_missing(self):
        """`RUNNER_SIGNING_SECRET=""` is what the example file ships with.

        The Worker treats it as absent too: env.ts parses with
        emptyStringAsUndefined, so a variable set to the empty string is
        undefined by the time assertModalConfigured reads it.
        """

        check = status_of(
            check_required_variables({**READY, "MODAL_RUNNER_URL": "   "}),
            "variable MODAL_RUNNER_URL",
        )
        self.assertEqual(check.status, FAIL)

    def test_the_secret_value_is_never_printed(self):
        checks = check_required_variables(READY)
        rendered = " ".join(check.reason for check in checks)
        self.assertNotIn(READY["RUNNER_SIGNING_SECRET"], rendered)
        self.assertIn("present", status_of(checks, "variable RUNNER_SIGNING_SECRET").reason)


class SigningAgreement(unittest.TestCase):
    """The check this tool exists for, driven with two callables.

    Real node is not involved. The point is the comparison logic: that
    identical output passes, that different output fails loudly, and that a
    signer which cannot run reports UNKNOWN instead of quietly passing.
    """

    def test_two_matching_signers_pass(self):
        check = compare_signatures(python_signer, python_signer)
        self.assertEqual(check.status, PASS, check.reason)

    def test_a_mismatched_signer_fails(self):
        def wrong(vectors):
            return ["0" * 64 for _ in vectors]

        check = compare_signatures(python_signer, wrong)
        self.assertEqual(check.status, FAIL)
        self.assertIn("disagree", check.reason)
        self.assertIn("Do not dispatch", check.fix)

    def test_a_signer_that_disagrees_only_on_non_ascii_still_fails(self):
        """The encoding bug this vector set was chosen to catch.

        A signer that encodes latin-1 instead of utf-8 agrees on every ASCII
        message. If the comparison stopped at the first vector, or if the
        vectors were all ASCII, this would report PASS over a boundary that
        breaks the first time a student's error message carries an accent.
        """

        def ascii_only(vectors):
            results = []
            for secret, timestamp, message in vectors:
                if message.isascii():
                    results.extend(python_signer([(secret, timestamp, message)]))
                else:
                    results.append("f" * 64)
            return results

        self.assertTrue(
            any(not message.isascii() for _s, _t, message in SIGNING_VECTORS),
            "SIGNING_VECTORS must include a non-ASCII body or this check is vacuous",
        )
        check = compare_signatures(python_signer, ascii_only)
        self.assertEqual(check.status, FAIL)

    def test_a_signer_that_cannot_run_is_unknown_not_passing(self):
        def broken(vectors):
            raise RuntimeError("node is not on PATH")

        check = compare_signatures(broken, python_signer)
        self.assertEqual(check.status, UNKNOWN)
        self.assertNotEqual(check.status, PASS)
        self.assertIn("unproven", check.fix)

    def test_a_signer_returning_the_wrong_count_fails(self):
        check = compare_signatures(lambda vectors: ["ab"], python_signer)
        self.assertEqual(check.status, FAIL)


class VerificationBehaviour(unittest.TestCase):
    """Agreement on the raw HMAC does not by itself mean a job is accepted."""

    def test_the_real_verifier_accepts_the_real_signer(self):
        check = check_verify_accepts_and_refuses(python_signer)
        self.assertEqual(check.status, PASS, check.reason)

    def test_a_signer_that_cannot_run_is_unknown(self):
        def broken(vectors):
            raise RuntimeError("no node")

        self.assertEqual(check_verify_accepts_and_refuses(broken).status, UNKNOWN)

    def test_the_callback_direction_agrees_with_canonical_json(self):
        check = check_callback_direction(python_signer)
        self.assertEqual(check.status, PASS, check.reason)

    def test_the_callback_direction_fails_on_a_wrong_signer(self):
        check = check_callback_direction(lambda vectors: ["0" * 64])
        self.assertEqual(check.status, FAIL)


class CallbackOrigin(unittest.TestCase):
    """The finding named this the most likely first-dispatch failure."""

    def test_an_https_public_origin_passes(self):
        check = check_callback_origin(READY)
        self.assertEqual(check.status, PASS)
        self.assertIn("/api/internal/v1/runner/events", check.reason)

    def test_localhost_over_http_fails_before_dispatch(self):
        check = check_callback_origin({"PUBLIC_ORIGIN": "http://localhost:5173"})
        self.assertEqual(check.status, FAIL)
        self.assertIn("501", check.reason)

    def test_https_localhost_still_fails_because_modal_cannot_reach_it(self):
        """A tunnel gives an https URL; https on loopback does not.

        This is the subtle one. `origin()` in runner.ts only checks the
        scheme, so https://localhost:5173 dispatches successfully and then
        strands every callback until the stale reaper clears the run an hour
        later. Passing it here would be worse than useless.
        """

        for origin in ("https://localhost:5173", "https://127.0.0.1:8787", "https://mac.local"):
            check = check_callback_origin({"PUBLIC_ORIGIN": origin})
            self.assertEqual(check.status, FAIL, origin)
            self.assertIn("callback", check.reason.lower() + check.fix.lower())


class ImageDigest(unittest.TestCase):
    def test_the_unpublished_placeholder_fails(self):
        check = check_image_digest({"RUNNER_IMAGE_DIGEST": "cogworks-python-3.11:unpublished"})
        self.assertEqual(check.status, FAIL)
        self.assertIn("deploy.py", check.fix)

    def test_absent_fails_because_the_fallback_is_also_a_placeholder(self):
        self.assertEqual(check_image_digest({}).status, FAIL)

    def test_a_modal_image_id_passes(self):
        self.assertEqual(check_image_digest({"RUNNER_IMAGE_DIGEST": "im-2AbCdEfGhIjK"}).status, PASS)
        self.assertEqual(
            check_image_digest({"RUNNER_IMAGE_DIGEST": "cogworks-runner-week3@im-2AbCdEfGhIjK"}).status,
            PASS,
        )

    def test_an_oci_digest_passes(self):
        digest = "sha256:" + "a" * 64
        self.assertEqual(check_image_digest({"RUNNER_IMAGE_DIGEST": digest}).status, PASS)

    def test_an_arbitrary_word_fails(self):
        self.assertEqual(check_image_digest({"RUNNER_IMAGE_DIGEST": "latest"}).status, FAIL)


class ExecutionProvider(unittest.TestCase):
    def test_fixture_fails_with_the_reason_nothing_would_be_sent(self):
        check = check_execution_provider({"EXECUTION_PROVIDER": "fixture"})
        self.assertEqual(check.status, FAIL)
        self.assertIn("dispatch()", check.reason)

    def test_modal_passes(self):
        self.assertEqual(check_execution_provider({"EXECUTION_PROVIDER": "modal"}).status, PASS)

    def test_an_unknown_value_fails(self):
        self.assertEqual(check_execution_provider({"EXECUTION_PROVIDER": "local"}).status, FAIL)


class SandboxFloors(unittest.TestCase):
    """Neither schema bounds these, so nothing else would catch a job below them."""

    def test_the_floors_are_read_from_the_real_source(self):
        source = (ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py").read_text(
            encoding="utf-8"
        )
        floors = sandbox_floors(source)
        self.assertIn("cpu", floors)
        self.assertIn("memory", floors)
        self.assertGreater(floors["memory"], 0)

    def test_a_job_below_the_memory_floor_fails(self):
        job = {"runtime": {"cpu": 1, "memoryMb": 256}}
        check = check_runtime_floors(job, {"cpu": 0.5, "memory": 512.0})
        self.assertEqual(check.status, FAIL)
        self.assertIn("256", check.reason)

    def test_a_job_above_both_floors_passes(self):
        job = {"runtime": {"cpu": 1, "memoryMb": 2048}}
        self.assertEqual(check_runtime_floors(job, {"cpu": 0.5, "memory": 512.0}).status, PASS)

    def test_no_floors_found_is_unknown_not_passing(self):
        self.assertEqual(check_runtime_floors({"runtime": {"cpu": 1, "memoryMb": 1}}, {}).status, UNKNOWN)


class WorkerSourceExtraction(unittest.TestCase):
    """The signing check is only evidence if it runs the shipped function."""

    def test_the_workers_signer_is_found_in_the_real_file(self):
        source = (ROOT / "apps" / "portal" / "worker" / "execution" / "runner.ts").read_text(
            encoding="utf-8"
        )
        body = extract_typescript_function(source, "hmacSignature")
        self.assertIn("crypto.subtle", body)
        self.assertIn("HMAC", body)
        self.assertEqual(body.count("{"), body.count("}"))

    def test_a_missing_function_raises_rather_than_returning_something(self):
        with self.assertRaises(LookupError):
            extract_typescript_function("export const x = 1;", "hmacSignature")

    def test_nested_braces_do_not_end_the_extraction_early(self):
        source = (
            "export async function f(): Promise<void> {\n"
            "  const o = { a: { b: 1 } };\n"
            "  if (o) { return; }\n"
            "}\n"
            "export const after = 2;\n"
        )
        body = extract_typescript_function(source, "f")
        self.assertNotIn("after", body)
        self.assertEqual(body.count("{"), body.count("}"))


class EnvFileReading(unittest.TestCase):
    def test_quotes_and_comments_are_handled(self):
        parsed = parse_env_file(
            '# a comment\n'
            'EXECUTION_PROVIDER="modal"\n'
            "RUNNER_SIGNING_KEY_ID='runner-v1'\n"
            "PUBLIC_ORIGIN=https://example.org\n"
            "\n"
            "NOT_AN_ASSIGNMENT\n"
        )
        self.assertEqual(parsed["EXECUTION_PROVIDER"], "modal")
        self.assertEqual(parsed["RUNNER_SIGNING_KEY_ID"], "runner-v1")
        self.assertEqual(parsed["PUBLIC_ORIGIN"], "https://example.org")
        self.assertNotIn("NOT_AN_ASSIGNMENT", parsed)

    def test_the_process_environment_wins_over_the_file(self):
        """So the secret can be supplied for one command without being written down."""

        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".dev.vars"
            path.write_text('EXECUTION_PROVIDER="fixture"\n', encoding="utf-8")
            values, found = load_values(path, {"EXECUTION_PROVIDER": "modal"})
            self.assertEqual(found, path)
            self.assertEqual(values["EXECUTION_PROVIDER"], "modal")

    def test_a_missing_file_is_not_an_error(self):
        values, found = load_values(Path("/nonexistent/.dev.vars"), {"EXECUTION_PROVIDER": "modal"})
        self.assertIsNone(found)
        self.assertEqual(values["EXECUTION_PROVIDER"], "modal")


class ReportingContract(unittest.TestCase):
    """UNKNOWN must not be reported as ready, and the summary must say so."""

    def test_all_passing_is_ready_and_exits_zero(self):
        stream = io.StringIO()
        status = report([Check("a", PASS, "fine"), Check("b", PASS, "fine")], stream)
        self.assertEqual(status, 0)
        self.assertIn("READY", stream.getvalue())
        self.assertNotIn("NOT READY", stream.getvalue())

    def test_one_unknown_is_not_ready_and_exits_nonzero(self):
        stream = io.StringIO()
        status = report([Check("a", PASS, "fine"), Check("b", UNKNOWN, "could not run", "fix it")], stream)
        self.assertNotEqual(status, 0)
        self.assertIn("NOT READY", stream.getvalue())
        self.assertIn("is not a check that passed", stream.getvalue())

    def test_a_failure_prints_its_fix(self):
        stream = io.StringIO()
        report([Check("a", FAIL, "broken", "here is the fix")], stream)
        self.assertIn("here is the fix", stream.getvalue())

    def test_a_multiline_reason_stays_on_one_line(self):
        """A node stack trace would otherwise break the aligned columns."""

        check = Check("a", UNKNOWN, "line one\n  line two\n\nline three")
        self.assertNotIn("\n", check.reason)

    def test_one_line_caps_a_long_reason(self):
        self.assertLessEqual(len(one_line("x" * 900)), 200)


if __name__ == "__main__":
    unittest.main()


def _plugins_importable() -> bool:
    """Whether this interpreter can load a benchmark plugin.

    The drift check compares a deployed row against the local plugin, so it
    needs both. `scripts/make_test_env.py` builds an interpreter that has
    them; a bare one does not, and the check correctly says UNKNOWN there.
    """

    try:
        from cogbench.plugins import load_benchmark

        load_benchmark("vision-clustering")
        return True
    except Exception:
        return False


class DeployedDriftIsCaught(unittest.TestCase):
    """The environment a dispatch lands in is not this checkout.

    Every other check reads local files and the local D1. Measured on
    2026-08-24: the deployed portal reported `scorerVersion: 1` and
    `datasetVersion: practice-v1` for all three benchmarks, which are the
    column defaults migration 0005 writes, so that database had never run
    migration 0013 onward. It also offered `audio-recognition`, an id that no
    longer exists. A dispatch would have been refused at contract_check for a
    reason with nothing to do with dispatch.
    """

    def _deployed(self, payload, monkey):
        """Run the check against a canned /api/benchmarks response."""

        import preflight_dispatch as module

        class _Result:
            returncode = 0
            stdout = payload

        original = module.subprocess.run
        module.subprocess.run = lambda *a, **k: _Result()
        try:
            return module.check_deployed_agrees("https://example.invalid")
        finally:
            module.subprocess.run = original

    @unittest.skipUnless(_plugins_importable(), "benchmark plugins not on this path")
    def test_a_stale_row_fails_and_names_both_values(self):
        checks = self._deployed(
            '[{"id":"vision-clustering","version":1,"active":true,'
            '"contractVersion":"cogworks.submissions.v1","pluginVersion":"0.1.0",'
            '"datasetVersion":"practice-v1","scorerVersion":"1"}]',
            None,
        )
        self.assertEqual(len(checks), 1)
        self.assertEqual(checks[0].status, FAIL)
        # Both sides, so a reader can see which way the drift runs without
        # going to look one of them up.
        self.assertIn("deployed=", checks[0].reason)
        self.assertIn("local=", checks[0].reason)

    @unittest.skipUnless(_plugins_importable(), "benchmark plugins not on this path")
    def test_a_benchmark_that_no_longer_exists_fails(self):
        checks = self._deployed(
            '[{"id":"audio-recognition","version":1,"active":true,'
            '"contractVersion":"v1","pluginVersion":"0.1.0",'
            '"datasetVersion":"practice-v1","scorerVersion":"1"}]',
            None,
        )
        self.assertEqual(checks[0].status, FAIL)
        self.assertIn("no longer exists", checks[0].fix)

    def test_a_retired_row_is_not_drift(self):
        """A superseded benchmark stays in the table with active=0 so old runs
        keep resolving their own version. Comparing those against today's
        plugin reports a deliberate record as a problem, and the first version
        of this check called two environments a month stale on exactly that."""

        checks = self._deployed(
            '[{"id":"audio-recognition","version":1,"active":false,'
            '"contractVersion":"v1","pluginVersion":"0.1.0",'
            '"datasetVersion":"practice-v1","scorerVersion":"1"}]',
            None,
        )
        # No check at all for a retired row, whether or not the plugins are
        # importable here: a row nobody can start a run against is not part
        # of the comparison.
        self.assertEqual(checks, [])

    def test_without_the_plugins_it_says_unknown_rather_than_guessing(self):
        """A comparison needs both sides. Missing the local one is a fact
        about this interpreter, not about the deployed environment, and
        reporting it as drift would send someone to redeploy for no reason."""

        import cogbench.plugins as plugins

        original = plugins._entry_points
        plugins._entry_points = lambda group: []
        try:
            checks = self._deployed(
                '[{"id":"vision-clustering","version":1,"active":true,'
                '"contractVersion":"v1","pluginVersion":"0.1.0",'
                '"datasetVersion":"practice-v1","scorerVersion":"1"}]',
                None,
            )
        finally:
            plugins._entry_points = original
        self.assertEqual(checks[0].status, UNKNOWN)

    def test_plugin_discovery_failure_is_unknown(self):
        import cogbench.plugins as plugins

        original = plugins._entry_points

        def fail(_group):
            raise RuntimeError("broken metadata")

        plugins._entry_points = fail
        try:
            checks = self._deployed(
                '[{"id":"vision-clustering","version":1,"active":true, '
                '"contractVersion":"v1","pluginVersion":"0.1.0",'
                '"datasetVersion":"practice-v1","scorerVersion":"1"}]',
                None,
            )
        finally:
            plugins._entry_points = original

        self.assertEqual(checks[0].status, UNKNOWN)
        self.assertIn("broken metadata", checks[0].reason)

    def test_an_unreachable_origin_is_unknown_rather_than_failed(self):
        """Reachability is not the dispatch path. Reporting it as a failure
        would say the platform is broken when the network is."""

        import preflight_dispatch as module

        class _Result:
            returncode = 7
            stdout = ""

        original = module.subprocess.run
        module.subprocess.run = lambda *a, **k: _Result()
        try:
            checks = module.check_deployed_agrees("https://example.invalid")
        finally:
            module.subprocess.run = original
        self.assertEqual(checks[0].status, UNKNOWN)


class TheCallbackRouteProbeReadsTheStatus(unittest.TestCase):
    """401 and 405 mean opposite things and both look like "it didn't work".

    `verifyRunnerEvent` runs before the body is parsed, so an unsigned POST
    to a deployed route is a 401. A 405 means the route is not there at all,
    which is invisible from a GET because the SPA catch-all answers those
    with 200.
    """

    def _status(self, code):
        import preflight_dispatch as module

        class _Result:
            returncode = 0
            stdout = code

        original = module.subprocess.run
        module.subprocess.run = lambda *a, **k: _Result()
        try:
            return module.check_callback_route_is_live("https://example.invalid")
        finally:
            module.subprocess.run = original

    def test_401_is_the_route_working(self):
        check = self._status("401")
        self.assertEqual(check.status, PASS)

    def test_405_is_nothing_handling_the_post(self):
        check = self._status("405")
        self.assertEqual(check.status, FAIL)
        self.assertIn("strands", check.fix)

    def test_501_is_a_live_route_with_no_secret(self):
        """The third state, and the one that cost an hour. `verifyRunnerEvent`
        returns 501 before it looks at a signature when the secret is absent,
        so this is a live route that will refuse every real event."""

        check = self._status("501")
        self.assertEqual(check.status, FAIL)
        self.assertIn("wrangler secret put", check.fix)

    def test_the_probed_path_carries_the_api_prefix(self):
        """The handler registers on the `api` router and index.ts mounts that
        at /api. Probing without the prefix answers 405 from the single-page
        app catch-all, which reads exactly like a missing route. Measured: the
        wrong path said 405 against a local server on the current commit."""

        import preflight_dispatch as module

        self.assertTrue(module.CALLBACK_PATH.startswith("/api/"))

    def test_anything_else_is_unknown(self):
        """A 500 or a 302 is not a yes and not a no, and guessing which
        would be the whole failure this file exists to prevent."""

        for code in ("500", "302", "200", ""):
            self.assertEqual(self._status(code).status, UNKNOWN, code)


class TheCallbackProbeSignsTheWayTheWorkerDoes(unittest.TestCase):
    """The probe's signature has to match the Worker's, or it proves nothing.

    `hmacSignature` in worker/execution/runner.ts signs `${timestamp}.${body}`
    with HMAC-SHA256 and hex-encodes it. The probe reimplements that in eleven
    lines of stdlib, deliberately, because two implementations agreeing is
    evidence and one implementation calling itself is not. This pins the
    reimplementation to the same vectors the preflight already checks the
    Worker against.
    """

    def _sign(self, secret, timestamp, body):
        sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "tools"))
        from probe_callback import signature

        return signature(secret, timestamp, body)

    def test_it_signs_timestamp_dot_body(self):
        import hashlib
        import hmac

        secret, timestamp, body = "s3cret", "1756000000", '{"a":1}'
        expected = hmac.new(
            secret.encode("utf-8"),
            "{}.{}".format(timestamp, body).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(self._sign(secret, timestamp, body), expected)

    def test_non_ascii_bodies_sign_as_utf8(self):
        """A student repository name can carry anything. The Worker encodes
        with TextEncoder, which is utf-8, so this has to agree byte for byte
        rather than by however Python happens to default."""

        import hashlib
        import hmac

        secret, timestamp, body = "s3cret", "1756000000", '{"name":"café ☕"}'
        expected = hmac.new(
            secret.encode("utf-8"),
            "{}.{}".format(timestamp, body).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(self._sign(secret, timestamp, body), expected)

    def test_the_probe_run_id_cannot_be_a_real_run(self):
        """A pass must write nothing. The id is refused at the run lookup,
        before anything is inserted."""

        sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "tools"))
        from probe_callback import PROBE_RUN_ID

        self.assertIn("does_not_exist", PROBE_RUN_ID)
