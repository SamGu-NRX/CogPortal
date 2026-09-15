"""Verify build-only and exact-ID publication without cloud calls.

Recorders replace Modal operations. Invalid or incomplete publication inputs
must fail before any recorded operation; build-only must never publish.
"""

from __future__ import annotations

import io
import sys
import types
import unittest
from contextlib import contextmanager, redirect_stdout, redirect_stderr
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "tools"))
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))

import image_manifest  # noqa: E402

#: What the recorder saw, reset per test.
CALLS: list = []


def _install_modal_stubs() -> None:
    """Make `modal_app` importable, then add the surface deploy.py uses.

    `image_manifest._stub_modules` already covers what importing modal_app
    needs. Deploy additionally reaches App.lookup, enable_output, Image.from_id
    and modal.runner.deploy_app, and `import modal.runner` needs a real entry in
    sys.modules to resolve.
    """

    image_manifest._stub_modules()
    modal = sys.modules["modal"]

    @contextmanager
    def enable_output():
        yield

    class Published:
        def __init__(self, image_id):
            self.object_id = image_id

        def publish(self, name):
            CALLS.append(("publish", name, self.object_id))

    modal.enable_output = enable_output
    modal.App.lookup = lambda name, create_if_missing=False: CALLS.append(("lookup", name)) or object()
    modal.Image.from_id = lambda image_id: CALLS.append(("from_id", image_id)) or Published(image_id)

    runner = types.ModuleType("modal.runner")
    runner.deploy_app = lambda application: CALLS.append(("deploy_app",))
    modal.runner = runner
    sys.modules["modal.runner"] = runner


_install_modal_stubs()

import deploy  # noqa: E402
from deploy import DeploymentError, parse_publish  # noqa: E402

NAMES = deploy.SANDBOX_IMAGE_NAMES
IDS = {
    "cogworks-runner-benchmark": "im-KzwdUha0Yz2PFEidTSPE9z",
    "cogworks-runner-week3": "im-gqD7XowpsRYsWtN1C0cd7y",
    "cogworks-runner-week1": "im-Tpq3fjbNvymPQUJ7SWkCYp",
}


class FakeImage:
    """Stands in for a sandbox image definition, recording build and publish."""

    def __init__(self, name):
        self.name = name

    def build(self, _context):
        CALLS.append(("build", self.name))
        return _Built(self.name)


class _Built:
    def __init__(self, name):
        self.name = name
        self.object_id = IDS[name]

    def publish(self, name):
        CALLS.append(("publish", name, self.object_id))


class DeployPhases(unittest.TestCase):
    def setUp(self):
        del CALLS[:]
        self.original_load = deploy.load_app
        self.original_stale = deploy.stale_build_trees

        def load_app(deployment):
            """Stand in for importing the controller, recording the target.

            Which deployment reaches this call is what decides the app,
            signing secret and job dictionary the real import would build.
            """

            CALLS.append(("load_app", deployment.target))
            return object(), tuple((FakeImage(name), name) for name in NAMES)

        deploy.load_app = load_app
        deploy.stale_build_trees = lambda: []
        self.addCleanup(setattr, deploy, "load_app", self.original_load)
        self.addCleanup(setattr, deploy, "stale_build_trees", self.original_stale)

    def run_main(self, argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = deploy.main(argv)
        return code, out.getvalue()

    def kinds(self):
        return [call[0] for call in CALLS]


class BuildOnly(DeployPhases):
    def test_builds_every_image_and_publishes_nothing(self):
        code, output = self.run_main(["--build-only"])

        self.assertEqual(code, 0)
        self.assertEqual([c for c in CALLS if c[0] == "build"], [("build", n) for n in NAMES])
        self.assertNotIn("publish", self.kinds())
        self.assertNotIn("deploy_app", self.kinds())

    def test_prints_all_three_immutable_ids(self):
        _code, output = self.run_main(["--build-only"])

        for name in NAMES:
            self.assertIn("built {} -> {}".format(name, IDS[name]), output)
        # The ids come back as the exact command that publishes them, so the
        # operator does not retype an id between the two phases.
        for name in NAMES:
            self.assertIn("--publish {}={}".format(name, IDS[name]), output)

    def test_still_refuses_a_stale_build_tree_before_building(self):
        deploy.stale_build_trees = lambda: [ROOT / "benchmarks" / "week3" / "build"]

        code, output = self.run_main(["--build-only"])

        self.assertEqual(code, 1)
        self.assertIn("stale build trees", output)
        self.assertEqual(CALLS, [])


class PublishExactIds(DeployPhases):
    def full_set(self):
        return [
            argument
            for name in NAMES
            for argument in ("--publish", "{}={}".format(name, IDS[name]))
        ]

    def test_publishes_the_given_ids_without_building(self):
        code, output = self.run_main(self.full_set())

        self.assertEqual(code, 0)
        self.assertNotIn("build", self.kinds())
        self.assertEqual(
            [c for c in CALLS if c[0] == "from_id"],
            [("from_id", IDS[name]) for name in NAMES],
        )
        self.assertEqual(
            [c for c in CALLS if c[0] == "publish"],
            [("publish", name, IDS[name]) for name in NAMES],
        )

    def test_deploys_the_app_after_publishing(self):
        self.run_main(self.full_set())

        kinds = self.kinds()
        self.assertEqual(kinds.count("deploy_app"), 1)
        self.assertGreater(kinds.index("deploy_app"), max(
            index for index, kind in enumerate(kinds) if kind == "publish"
        ))

    def test_a_stale_build_tree_blocks_publication_before_any_cloud_call(self):
        # App deployment still builds the controller from benchmark source.
        deploy.stale_build_trees = lambda: [ROOT / "benchmarks" / "week3" / "build"]

        code, output = self.run_main(self.full_set())

        self.assertEqual(code, 1)
        self.assertIn("stale build trees", output)
        self.assertEqual(CALLS, [])


class PublishInputIsCheckedBeforeAnythingIsSent(DeployPhases):
    def refuse(self, argv):
        err = io.StringIO()
        with redirect_stderr(err), self.assertRaises(SystemExit) as caught:
            deploy.main(argv)
        self.assertEqual(caught.exception.code, 2)
        self.assertEqual(CALLS, [], "refused input still reached Modal")
        return err.getvalue()

    def pairs(self, **overrides):
        chosen = dict(IDS)
        chosen.update(overrides)
        return [
            argument
            for name in NAMES
            for argument in ("--publish", "{}={}".format(name, chosen[name]))
        ]

    def test_an_incomplete_set_is_refused(self):
        # The case that matters: two of three would deploy the app while the
        # third name still pointed at whatever was there before.
        for dropped in NAMES:
            del CALLS[:]
            argv = [
                argument
                for name in NAMES
                if name != dropped
                for argument in ("--publish", "{}={}".format(name, IDS[name]))
            ]
            message = self.refuse(argv)
            self.assertIn(dropped, message)

    def test_an_unknown_name_is_refused(self):
        message = self.refuse(["--publish", "cogworks-runner-week4=im-abc123"])
        self.assertIn("not a sandbox image name", message)

    def test_a_repeated_name_is_refused(self):
        argv = self.pairs() + ["--publish", "{}={}".format(NAMES[0], IDS[NAMES[0]])]
        self.assertIn("given twice", self.refuse(argv))

    def test_a_malformed_id_is_refused(self):
        for bad in ("cogworks-runner-week1", "", "im-", "IM-ABC", "im-abc/def"):
            del CALLS[:]
            message = self.refuse(self.pairs(**{NAMES[0]: bad}))
            self.assertIn("immutable image id", message)

    def test_a_pair_without_a_separator_is_refused(self):
        self.assertIn("NAME=IMAGE_ID", self.refuse(["--publish", "cogworks-runner-week1"]))

    def test_build_only_and_publish_together_are_refused(self):
        self.refuse(["--build-only"] + self.pairs())


class DefaultBehaviourIsUnchanged(DeployPhases):
    def test_no_flags_still_builds_publishes_and_deploys(self):
        code, output = self.run_main([])

        self.assertEqual(code, 0)
        self.assertEqual(
            self.kinds(),
            ["load_app", "lookup"]
            + [k for name in NAMES for k in ("build", "publish")]
            + ["deploy_app"],
        )
        self.assertEqual(CALLS[0], ("load_app", "staging"))
        self.assertIn("deployed; sandbox images published as", output)

    def test_no_flags_still_refuses_a_stale_build_tree(self):
        deploy.stale_build_trees = lambda: [ROOT / "benchmarks" / "week1" / "build"]

        code, _output = self.run_main([])

        self.assertEqual(code, 1)
        self.assertEqual(CALLS, [])


class ProductionDeploysTheControllerOnly(DeployPhases):
    """`--target production` must not touch a staging name or image."""

    def pins(self):
        return [
            argument
            for name in NAMES
            for argument in ("--sandbox-image", "{}={}".format(name, IDS[name]))
        ]

    def test_deploys_without_building_or_publishing_anything(self):
        code, output = self.run_main(["--target", "production"] + self.pins())

        self.assertEqual(code, 0)
        self.assertEqual(self.kinds(), ["load_app", "deploy_app"])
        self.assertEqual(CALLS[0], ("load_app", "production"))
        self.assertIn("deployed cogworks-runner-production", output)
        for name in NAMES:
            self.assertIn("{}={}".format(name, IDS[name]), output)

    def test_refuses_to_publish_a_name(self):
        argv = ["--target", "production"] + self.pins()
        for flag in (
            ["--build-only"],
            ["--publish", "{}={}".format(NAMES[0], IDS[NAMES[0]])],
        ):
            del CALLS[:]
            err = io.StringIO()
            with redirect_stderr(err), self.assertRaises(SystemExit):
                deploy.main(argv + flag)
            self.assertIn("staging release step", err.getvalue())
            self.assertEqual(CALLS, [])

    def test_refuses_an_incomplete_pin_before_importing_the_controller(self):
        argv = ["--target", "production"] + self.pins()[:4]
        err = io.StringIO()
        with redirect_stderr(err), self.assertRaises(SystemExit):
            deploy.main(argv)
        self.assertIn(NAMES[2], err.getvalue())
        self.assertEqual(CALLS, [])

    def test_staging_refuses_a_pinned_image(self):
        err = io.StringIO()
        with redirect_stderr(err), self.assertRaises(SystemExit):
            deploy.main(self.pins())
        self.assertIn("--target production", err.getvalue())
        self.assertEqual(CALLS, [])


class PublishParsing(unittest.TestCase):
    """The parser alone, without the command around it."""

    def test_accepts_a_complete_set_in_any_order(self):
        values = ["{}={}".format(name, IDS[name]) for name in reversed(NAMES)]
        self.assertEqual(parse_publish(values), IDS)

    def test_names_every_missing_image_at_once(self):
        with self.assertRaises(DeploymentError) as caught:
            parse_publish(["{}={}".format(NAMES[0], IDS[NAMES[0]])])
        message = str(caught.exception)
        for missing in NAMES[1:]:
            self.assertIn(missing, message)

    def test_refuses_an_empty_set(self):
        with self.assertRaises(DeploymentError):
            parse_publish([])


if __name__ == "__main__":
    unittest.main()
