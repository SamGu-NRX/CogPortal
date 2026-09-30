"""Staging keeps every object it had; production reaches none of them.

The controller is one module deployed twice. These import it under recording
Modal stand-ins, once per target, and compare what each import declared: the
app, the signing secret, the job dictionary, the dataset mount, the controller
image layers, and which image `_sandbox_image` resolves for each benchmark.

Two things beyond the names. Modal starts a container by importing this module
again, so the production selection is only real if the environment baked into
the controller image reads back as the same deployment; that round trip is
modelled here against the stand-ins, not observed on a deployed function. And
production's controller has to stand on the pinned Week 2 image rather than on
the definition that would rebuild it.
"""

from __future__ import annotations

import os
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "tools"))
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

import image_manifest  # noqa: E402

from cogworks_runner.deployment import (  # noqa: E402
    BENCHMARK_SANDBOX_IMAGE,
    PRODUCTION,
    SANDBOX_IMAGE_IDS_VARIABLE,
    SANDBOX_IMAGE_NAMES,
    STAGING,
    TARGET_VARIABLE,
    WEEK1_SANDBOX_IMAGE,
    WEEK3_SANDBOX_IMAGE,
    DeploymentError,
    parse_image_pairs,
    production,
    select,
    staging,
)

#: The three ids accepted for this release, probed and published under the
#: staging names on 2026-09-14.
ACCEPTED_IDS = {
    BENCHMARK_SANDBOX_IMAGE: "im-ciQ5jwm90ZkTAjiEUTL41E",
    WEEK3_SANDBOX_IMAGE: "im-DBMGbGjq0TFxvHt722tSsQ",
    WEEK1_SANDBOX_IMAGE: "im-qRlwhCwkL50PChqqFCdj4Y",
}


class FakeVolume:
    def __init__(self, name, read_only=False):
        self.name = name
        self.read_only = read_only

    def with_mount_options(self, read_only=False, **_kwargs):
        return FakeVolume(self.name, read_only=read_only)


def _import_controller(environ):
    """Import the controller fresh under this environment, and record it.

    Returns the module and a record of every Modal object it named. The
    module is imported again rather than reloaded because its app, secret,
    dictionary and controller image are all built during import.
    """

    image_manifest._stub_modules()
    modal = sys.modules["modal"]
    record = {"apps": [], "secrets": [], "dicts": [], "volumes": [], "functions": []}

    class FakeApp:
        def __init__(self, name):
            self.name = name
            record["apps"].append(name)

        def function(self, **kwargs):
            record["functions"].append(kwargs)
            return lambda f: f

        def cls(self, *_args, **_kwargs):
            return lambda c: c

        def local_entrypoint(self, *_args, **_kwargs):
            return lambda f: f

    def named_secret(name):
        record["secrets"].append(name)
        return ("secret", name)

    def named_dict(name, **_kwargs):
        record["dicts"].append(name)
        return ("dict", name)

    def named_volume(name, **_kwargs):
        record["volumes"].append(name)
        return FakeVolume(name)

    modal.App = FakeApp
    modal.Secret = types.SimpleNamespace(from_name=named_secret)
    modal.Dict = types.SimpleNamespace(from_name=named_dict)
    modal.Volume = types.SimpleNamespace(from_name=named_volume)
    # Every stand-in image is a recorder, including the two reference forms,
    # because production's controller is built on top of `from_id`.
    modal.Image = types.SimpleNamespace(
        debian_slim=lambda **_kwargs: image_manifest._Recorder(),
        from_name=lambda name: image_manifest._Recorder([("from_name", (name,), {})]),
        from_id=lambda image_id: image_manifest._Recorder([("from_id", (image_id,), {})]),
    )

    for name in (TARGET_VARIABLE, SANDBOX_IMAGE_IDS_VARIABLE):
        os.environ.pop(name, None)
    os.environ.update(environ)
    for name in [m for m in sys.modules if m.startswith("cogworks_runner")]:
        del sys.modules[name]

    from cogworks_runner import modal_app

    return modal_app, record


def _layers(image):
    """An image's builder calls, comparable across two separate imports.

    `run_function` carries a function object, and a fresh import produces a
    different one, so compare by name rather than by identity.
    """

    return [
        (name, tuple(getattr(a, "__name__", repr(a)) for a in args), repr(kwargs))
        for name, args, kwargs in image.history
    ]


def _base(image):
    """What an image is built on: its first recorded builder call."""

    name, args, _kwargs = image.history[0]
    return (name, args[0] if args else None)


class ControllerImport(unittest.TestCase):
    """Both imports, taken once, so every test reads the same two records."""

    @classmethod
    def setUpClass(cls):
        cls.saved_modules = {
            name: module
            for name, module in sys.modules.items()
            if name.startswith("cogworks_runner") or name in ("modal", "fastapi")
        }
        cls.saved_environ = {
            name: os.environ.get(name)
            for name in (TARGET_VARIABLE, SANDBOX_IMAGE_IDS_VARIABLE)
        }
        cls.staging_app, cls.staging_record = _import_controller({})
        cls.production_deployment = production(ACCEPTED_IDS)
        cls.production_app, cls.production_record = _import_controller(
            cls.production_deployment.environment()
        )

    @classmethod
    def tearDownClass(cls):
        for name in [m for m in sys.modules if m.startswith("cogworks_runner")]:
            del sys.modules[name]
        sys.modules.update(cls.saved_modules)
        for name, value in cls.saved_environ.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


class StagingIsUnchanged(ControllerImport):
    def test_names_the_objects_it_has_always_named(self):
        self.assertEqual(self.staging_record["apps"], ["cogworks-runner"])
        self.assertEqual(self.staging_record["secrets"], ["cogworks-runner-signing"])
        self.assertEqual(self.staging_record["dicts"], ["cogworks-runner-jobs"])
        self.assertEqual(self.staging_record["volumes"], ["cogworks-hidden-datasets"])

    def test_mounts_the_dataset_volume_writable_as_before(self):
        self.assertFalse(self.staging_app.hidden_mount.read_only)

    def test_resolves_every_sandbox_image_by_published_name(self):
        for benchmark, name in (
            ("audio-identification", WEEK1_SANDBOX_IMAGE),
            ("language-search", WEEK3_SANDBOX_IMAGE),
            ("vision-recognition", BENCHMARK_SANDBOX_IMAGE),
            ("vision-clustering", BENCHMARK_SANDBOX_IMAGE),
        ):
            self.assertEqual(
                _base(self.staging_app._sandbox_image({"benchmark": {"id": benchmark}})),
                ("from_name", name),
            )

    def test_carries_no_deployment_environment_into_its_controller_image(self):
        for _name, args, kwargs in self.staging_app.controller_image.history:
            self.assertNotIn(TARGET_VARIABLE, repr(args) + repr(kwargs))


class ProductionIsIsolated(ControllerImport):
    def test_names_its_own_app_secret_and_job_dictionary(self):
        self.assertEqual(self.production_record["apps"], ["cogworks-runner-production"])
        self.assertEqual(
            self.production_record["secrets"], ["cogworks-runner-production-signing"]
        )
        self.assertEqual(
            self.production_record["dicts"], ["cogworks-runner-production-jobs"]
        )

    def test_reuses_the_one_dataset_volume_read_only(self):
        # Same volume, so there is still one owner of the private data, and a
        # production controller cannot write over what staging maintains.
        self.assertEqual(self.production_record["volumes"], ["cogworks-hidden-datasets"])
        self.assertTrue(self.production_app.hidden_mount.read_only)

    def test_resolves_every_sandbox_image_by_its_captured_id(self):
        for benchmark, name in (
            ("audio-identification", WEEK1_SANDBOX_IMAGE),
            ("language-search", WEEK3_SANDBOX_IMAGE),
            ("vision-recognition", BENCHMARK_SANDBOX_IMAGE),
            ("vision-clustering", BENCHMARK_SANDBOX_IMAGE),
        ):
            self.assertEqual(
                _base(self.production_app._sandbox_image({"benchmark": {"id": benchmark}})),
                ("from_id", ACCEPTED_IDS[name]),
            )

    def test_a_modelled_container_import_reads_back_the_same_deployment(self):
        # Modal resolves a deployed function by importing this module again in
        # the container, with the image's environment as all it has to go on.
        # This models that import against the stand-ins above; it is not
        # evidence from a deployed container, which only a read of the
        # deployed function's own metadata would be.
        baked = self.production_app.controller_image.history[-1][1][0]
        self.assertEqual(select(baked), self.production_deployment)


class ProductionsControllerRebuildsNoSandboxLayer(ControllerImport):
    """The controller is the one image a production deploy resolves.

    `benchmark_image` copies this checkout's runner source partway down its
    chain, so deriving production's controller from that definition would
    rebuild the Week 2 package install and the facenet checkpoint download
    that sit above the copy, and would leave the controller on layers the
    pinned sandbox images do not share. Production builds on the pinned image
    itself instead. These read the recorded builder calls of both imports.
    """

    def production_layers(self):
        return _layers(self.production_app.controller_image)

    def test_it_starts_from_the_accepted_benchmark_image_id(self):
        self.assertEqual(
            _base(self.production_app.controller_image),
            ("from_id", ACCEPTED_IDS[BENCHMARK_SANDBOX_IMAGE]),
        )

    def test_it_never_reaches_the_layers_that_would_rebuild_week2(self):
        builders = [name for name, _args, _kwargs in self.production_layers()]
        # debian_slim and apt_install open benchmark_image's chain;
        # run_function is the facenet checkpoint download at the end of it.
        for builder in ("debian_slim", "apt_install", "run_function"):
            self.assertNotIn(builder, builders)
        self.assertNotIn(
            "python -m pip install --no-deps /opt/week2",
            [
                argument
                for _name, args, _kwargs in self.production_app.controller_image.history
                for argument in args
            ],
        )

    def test_it_copies_this_checkout_s_runner_source_over_the_pinned_image(self):
        # The controller runs this module, so the pinned image's older copy of
        # /opt/runner has to be overwritten by the source being deployed.
        source = str(ROOT / "apps" / "runner-modal" / "src")
        copies = [
            (args[0], args[1])
            for name, args, _kwargs in self.production_app.controller_image.history
            if name == "add_local_dir"
        ]
        self.assertIn((source, "/opt/runner"), copies)

    def test_both_targets_add_the_same_controller_layers(self):
        # Everything between production's base and its environment layer is
        # what staging adds on top of benchmark_image, so the two controllers
        # differ only in what they stand on and what they carry.
        staging_layers = _layers(self.staging_app.controller_image)
        benchmark_layers = _layers(self.staging_app.benchmark_image)
        self.assertEqual(staging_layers[: len(benchmark_layers)], benchmark_layers)
        self.assertEqual(
            self.production_layers()[2:-1], staging_layers[len(benchmark_layers) :]
        )

    def test_the_selection_is_the_last_layer_and_the_only_extra_one(self):
        self.assertEqual(
            self.production_app.controller_image.history[-1],
            ("env", (self.production_deployment.environment(),), {}),
        )
        self.assertEqual(
            len(self.production_layers()),
            len(_layers(self.staging_app.controller_image))
            - len(_layers(self.staging_app.benchmark_image))
            + 3,  # from_id, the runner copy, and the environment
        )


class EveryControllerFunctionIsSigned(ControllerImport):
    def test_each_function_receives_its_own_environment_signing_secret(self):
        for label, record, expected in (
            ("staging", self.staging_record, "cogworks-runner-signing"),
            ("production", self.production_record, "cogworks-runner-production-signing"),
        ):
            self.assertTrue(record["functions"], label)
            for declared in record["functions"]:
                # A controller function without the secret answers 401 to the
                # portal or cannot sign a weight request, and one holding the
                # other environment's secret is the isolation failure itself.
                self.assertEqual(
                    declared.get("secrets"), [("secret", expected)], label
                )


class SelectionRefusesBeforeAnythingIsBuilt(unittest.TestCase):
    def test_an_unset_environment_is_staging(self):
        self.assertEqual(select({}), staging())

    def test_an_unknown_target_is_refused(self):
        with self.assertRaises(DeploymentError) as caught:
            select({TARGET_VARIABLE: "prod"})
        self.assertIn("not a deployment target", str(caught.exception))

    def test_staging_carrying_image_ids_is_refused(self):
        # One variable set without the other: the container would run staging
        # names while the operator believed it had pinned ids.
        with self.assertRaises(DeploymentError):
            select({TARGET_VARIABLE: STAGING, SANDBOX_IMAGE_IDS_VARIABLE: "{}"})

    def test_production_without_image_ids_is_refused(self):
        with self.assertRaises(DeploymentError) as caught:
            select({TARGET_VARIABLE: PRODUCTION})
        self.assertIn("JSON object", str(caught.exception))

    def test_production_missing_one_image_is_refused_and_names_it(self):
        partial = dict(ACCEPTED_IDS)
        del partial[WEEK3_SANDBOX_IMAGE]
        with self.assertRaises(DeploymentError) as caught:
            production(partial)
        self.assertIn(WEEK3_SANDBOX_IMAGE, str(caught.exception))

    def test_production_given_a_published_name_instead_of_an_id_is_refused(self):
        named = dict(ACCEPTED_IDS, **{WEEK1_SANDBOX_IMAGE: WEEK1_SANDBOX_IMAGE})
        with self.assertRaises(DeploymentError) as caught:
            production(named)
        self.assertIn("immutable image id", str(caught.exception))

    def test_production_given_an_unknown_image_name_is_refused(self):
        with self.assertRaises(DeploymentError):
            production(dict(ACCEPTED_IDS, **{"cogworks-runner-week4": "im-abc123"}))

    def test_malformed_image_json_is_refused(self):
        with self.assertRaises(DeploymentError) as caught:
            select({TARGET_VARIABLE: PRODUCTION, SANDBOX_IMAGE_IDS_VARIABLE: "im-abc"})
        self.assertIn("not JSON", str(caught.exception))

    def test_command_line_pairs_reach_the_same_refusals(self):
        with self.assertRaises(DeploymentError):
            parse_image_pairs(["cogworks-runner-week1"])
        with self.assertRaises(DeploymentError):
            parse_image_pairs(["cogworks-runner-week1=latest"])
        pairs = ["{}={}".format(name, ACCEPTED_IDS[name]) for name in SANDBOX_IMAGE_NAMES]
        self.assertEqual(parse_image_pairs(pairs), ACCEPTED_IDS)


class SelectionTravelsThroughAnEnvironment(unittest.TestCase):
    def test_staging_clears_a_leftover_production_variable(self):
        # An operator with the production variable exported would otherwise
        # get a production controller out of a staging command.
        environ = {TARGET_VARIABLE: PRODUCTION, SANDBOX_IMAGE_IDS_VARIABLE: "{}"}
        staging().apply_to(environ)
        self.assertEqual(environ, {})
        self.assertEqual(select(environ), staging())

    def test_production_writes_both_variables(self):
        environ = {}
        chosen = production(ACCEPTED_IDS)
        chosen.apply_to(environ)
        self.assertEqual(sorted(environ), [SANDBOX_IMAGE_IDS_VARIABLE, TARGET_VARIABLE])
        self.assertEqual(select(environ), chosen)


if __name__ == "__main__":
    unittest.main()
