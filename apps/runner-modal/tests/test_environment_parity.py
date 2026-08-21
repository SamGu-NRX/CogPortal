"""The stub list must not claim a package the graded run installs.

A stub stands in for a package the scoring environment does not have, so a
module that mentions it at import scope still yields its functions. That is
only honest while the package really is absent. Stub a package the image
installs and the effect inverts: working code is replaced by a stand-in, the
student's own module fails, and the failure is reported as theirs.

That is not a hypothetical. `networkx` was on the stub list while the Week 2
image installed `networkx==3.1`, which sits directly on the Whispers
clustering path the Week 2 capstone teaches. Measured on a repository whose
module does `import networkx as nx`: `nx` resolved to a `_Stub` with no
`__file__`, and the clustering call raised "networkx.Graph is not available
here". The same code with the real package returns the right clusters.

Nobody could have caught that by reading. The stub list is four names in
cogbench and the image contents were a chain of Modal builder calls in a
different app, so checking one against the other meant holding two files in
your head and knowing that `scikit-image` silently brings `networkx`. This
test does that comparison on every run instead.

What it can prove and what it cannot: `cogbench.environment` records the
packages each image installs directly, not the dependencies pip resolves
underneath them. So a stub for a directly-installed package fails here, and a
stub for a transitively-installed one does not. `cogbench.discover` covers the
second case at run time by checking whether a package is importable before
standing in for it. Both exist because either alone leaves a real gap.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "tools"))

from cogbench import environment  # noqa: E402
from cogbench.discover import STUBBED_MODULES  # noqa: E402


def _why_this_is_wrong(package: str, tracks) -> str:
    """The failure message, written for whoever hits this without the context.

    A test that fails with "AssertionError: False is not true" costs the
    reader the whole investigation again. This says which package, which
    image, what it breaks, and what the two ways out are.
    """

    where = ", ".join(sorted(tracks))
    return (
        "\n"
        "{package} is on cogbench.discover.STUBBED_MODULES, which is the list of\n"
        "packages the scoring environment does NOT have. But the {where} image\n"
        "installs it (see cogbench.environment).\n"
        "\n"
        "Why that is a bug, not a redundancy: a stub replaces the real package.\n"
        "Student code that imports {package} gets a stand-in whose every call\n"
        "returns a placeholder, so a module that works in the graded environment\n"
        "is reported as the student's failure. That happened with networkx in\n"
        "August 2026, on the Week 2 clustering path.\n"
        "\n"
        "Two ways to fix it, and which one depends on what you just changed:\n"
        "  - If you added {package} to an image, remove it from STUBBED_MODULES.\n"
        "    The image is the source of truth for what a graded run provides.\n"
        "  - If you added {package} to STUBBED_MODULES because a repository\n"
        "    could not import it, that is a different problem: the package is\n"
        "    installed, so the import failed for another reason. Read the actual\n"
        "    error before standing in for a package that is present.\n"
    ).format(package=package, where=where)


class TheStubListDescribesARealAbsence(unittest.TestCase):
    def test_no_stubbed_package_is_installed_by_any_image(self):
        """The invariant, stated once: stubs and installs are disjoint."""

        for package in STUBBED_MODULES:
            tracks = [
                track
                for track in environment.TRACKS
                if package in environment.student_modules(track)
            ]
            self.assertEqual(tracks, [], _why_this_is_wrong(package, tracks))

    def test_networkx_specifically_is_not_stubbed(self):
        """The one that actually happened, pinned by name.

        The general test above would catch a reintroduction, but only while
        the Week 2 image still lists networkx. Someone removing it from the
        image and re-adding the stub would satisfy the general test and
        recreate the original bug for any repository that pip-installs
        scikit-image, which pulls networkx in regardless. Naming it here keeps
        the specific history attached to the specific package.
        """

        self.assertNotIn(
            "networkx",
            STUBBED_MODULES,
            "networkx is a scikit-image runtime dependency and the Week 2 "
            "capstone's Whispers code imports it. Stubbing it made real "
            "clustering code fail and blamed the student.",
        )

    def test_week2_installs_networkx_so_the_removal_stays_justified(self):
        """The reason the stub was removed has to remain true.

        If networkx ever leaves the Week 2 image, the note in STUBBED_MODULES
        explaining its removal stops being accurate, and a Week 2 repository
        importing it starts being skipped with no stub and no explanation.
        Fail here so that removal is a decision rather than a side effect.
        """

        self.assertIn(
            "networkx",
            environment.student_modules("week2"),
            "The Week 2 image no longer installs networkx. Decide deliberately "
            "what a Week 2 repository importing it should now do, and update "
            "the note in cogbench.discover.STUBBED_MODULES either way.",
        )


class TheManifestMatchesTheImages(unittest.TestCase):
    """The manifest is only a source of truth while the images are built from
    it. These read the real builder chain, so a hand-edited image that stops
    consuming the manifest is caught rather than silently believed."""

    def _built(self):
        import image_manifest

        return image_manifest.manifest()

    def test_every_track_manifest_reaches_its_image(self):
        built = self._built()
        for track, image in (
            ("week1", "week1_image"),
            ("week2", "benchmark_image"),
            ("week3", "week3_image"),
        ):
            declared = set(environment.requirement_strings(track))
            installed = set(built[image])
            self.assertTrue(
                declared <= installed,
                "{} declares {} which {} does not install. The image should be "
                "built from cogbench.environment, not from a separate list."
                .format(track, sorted(declared - installed), image),
            )

    def test_the_images_install_nothing_the_manifest_does_not_declare(self):
        """The other direction, which is the one that lets a stub go stale.

        A package installed straight into an image and never recorded in the
        manifest is invisible to the parity test above, so it could be stubbed
        without anything noticing. `uv` is the one deliberate exception: it is
        build machinery for creating the 3.8 venv, not a package student code
        can import.
        """

        build_only = {"uv>=0.5"}
        built = self._built()
        for track, image in (
            ("week1", "week1_image"),
            ("week2", "benchmark_image"),
            ("week3", "week3_image"),
        ):
            declared = set(environment.requirement_strings(track))
            extra = set(built[image]) - declared - build_only
            self.assertEqual(
                extra,
                set(),
                "{} installs {} which cogbench.environment does not declare. "
                "Add it to the manifest so the stub-parity check can see it."
                .format(image, sorted(extra)),
            )


class TheStudentPythonPathsComeFromOnePlace(unittest.TestCase):
    """Week 1 and Week 3 exec student code through a pinned 3.8.20 venv, and
    the path to it is used both to build the venv and to run against it. Two
    copies of that string is one rename away from an image that installs into
    a venv nothing runs."""

    def test_both_tracks_use_the_manifest_path(self):
        import image_manifest

        image_manifest._stub_modules()
        sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))
        from cogworks_runner import modal_app

        self.assertEqual(modal_app.WEEK1_STUDENT_PYTHON, environment.PY38_VENV)
        self.assertEqual(modal_app.WEEK3_STUDENT_PYTHON, environment.PY38_VENV)


if __name__ == "__main__":
    unittest.main()
