"""What the graded run installs, per week, as data rather than as build steps.

The hosted images are defined in
``apps/runner-modal/src/cogworks_runner/modal_app.py`` as chained Modal builder
calls. Those calls are the thing that is actually true about a scoring
environment, and until now they were the only place that truth existed: a
sequence of method calls that no test and no other module could read. Anything
else that needed to know what the graded run has (which packages a stub may
stand in for, which ones a laptop is missing) kept its own separate list, and
those lists drifted.

One measured consequence, which is why this file exists. ``networkx`` was on
``cogbench.discover.STUBBED_MODULES``, the list of packages the sandbox does
not have. The Week 2 image installs ``networkx==3.1`` (it is a scikit-image
runtime dependency, pinned there so a scikit-image bump cannot drop it). So
discovery replaced a working package with a stand-in, and a team whose
clustering module imported networkx at module scope had that module turned
into a failure and were told it was theirs.

So the requirement strings live here, the image builders are built from them,
and a test compares this list against the stub list. Two rules follow from
that arrangement:

**This file is the source, and the images are derived.** Editing a version
here changes what the graded run installs. There is no second place to update.

**Only direct installs are listed.** A pip install pulls in dependencies of
its own (``sklearn`` brings ``scipy`` and ``joblib``, ``skimage`` brings
``tifffile`` and ``lazy_loader``), and the resolved set is only knowable by
building the image. Those packages are present in the graded run and are not
named here. A test built on this data can therefore prove that a declared
package is not also declared absent; it cannot prove the same about a
transitive one. ``cogbench.discover`` covers that case at run time instead, by
checking whether a package is importable before standing in for it.

Distribution names and import names are both recorded because they differ
often enough to have caused their own bug: an earlier list mixed
``scikit-learn`` (what you pip install) with ``sklearn`` (what you import) and
``opencv`` (neither), so entries silently matched nothing.
"""

from __future__ import annotations

import importlib.util
from typing import Dict, FrozenSet, NamedTuple, Sequence, Tuple

__all__ = [
    "Package",
    "WEEK1_TRACK",
    "WEEK2_TRACK",
    "WEEK3_TRACK",
    "TRACKS",
    "BENCHMARK_TRACKS",
    "PY38_VENV",
    "requirement_strings",
    "student_modules",
    "track_for",
    "all_student_modules",
    "missing_here",
    "local_gap",
    "gap_note",
    "venv_install_command",
]


class Package(NamedTuple):
    """One package a hosted image installs.

    ``requirement`` is the string handed to pip, pin and all. ``module`` is the
    name student code writes after ``import``. They are frequently different
    and the difference is load-bearing: a check that compares an import against
    a list of distribution names finds nothing and reports that as absence.
    """

    requirement: str
    module: str


#: The pinned interpreter Week 1 and Week 3 student code runs under. Modal's
#: 2025.06 image builder dropped Python 3.8 and its runtime needs 3.10+, so
#: those two images carry a CPython 3.8.20 venv built with uv and exec student
#: code through it. The path is repeated in modal_app as
#: WEEK1_STUDENT_PYTHON / WEEK3_STUDENT_PYTHON, which are what the run steps
#: use; this constant exists so the install command can be built from data.
PY38_VENV = "/opt/cogworks-py38/bin/python"


#: Week 1, audio identification. Installed into the 3.8.20 venv, which is the
#: environment student code sees. The 3.11 layer around it holds only the
#: control-plane packages and is not what a submission imports.
#:
#: This set is the course's own Week 1 conda line
#: (docs/capstones/environment.md:86, 90): numpy, scipy, matplotlib, numba,
#: librosa, ffmpeg. Order is the order pip receives them and is preserved so
#: the generated command stays byte-identical to the one that built the
#: current image; Modal keys its layer cache on that string.
WEEK1_TRACK: Tuple[Package, ...] = (
    Package("numpy==1.24.4", "numpy"),
    Package("scipy==1.10.1", "scipy"),
    Package("matplotlib==3.7.5", "matplotlib"),
    Package("numba==0.58.1", "numba"),
    Package("llvmlite==0.41.1", "llvmlite"),
    Package("soundfile==0.12.1", "soundfile"),
    Package("librosa==0.11.0", "librosa"),
    Package("platformdirs>=4,<5", "platformdirs"),
    Package("ipython==8.12.3", "IPython"),
)

#: Week 2, vision. Installed into the 3.11 interpreter directly: this track has
#: no 3.8 venv, so student code runs on 3.11 and imports these.
#:
#: The course's Week 2 conda line (docs/capstones/environment.md:146) plus the
#: pip line under it (line 168). imageio and networkx are scikit-image's own
#: runtime dependencies, named explicitly so a scikit-image pin change cannot
#: silently drop them. mygrad is held at 2.2.0 because 2.3.0 requires Python
#: 3.9 and the student contract is 3.8.
WEEK2_TRACK: Tuple[Package, ...] = (
    Package("numpy==1.24.4", "numpy"),
    Package("Pillow==10.2.0", "PIL"),
    Package("torch==2.2.2", "torch"),
    Package("torchvision==0.17.2", "torchvision"),
    Package("facenet-pytorch==2.6.0", "facenet_pytorch"),
    Package("opencv-python-headless==4.10.0.84", "cv2"),
    Package("platformdirs>=4,<5", "platformdirs"),
    Package("datasets>=2.20,<4", "datasets"),
    Package(
        "facenet_models @ git+https://github.com/CogWorksBWSI/facenet_models.git"
        "@96b9599b03f26910b66f61ce725a8660e0ba654c",
        "facenet_models",
    ),
    Package("scikit-learn==1.3.2", "sklearn"),
    Package("scikit-image==0.21.0", "skimage"),
    Package("matplotlib==3.7.5", "matplotlib"),
    Package("imageio==2.35.1", "imageio"),
    Package("networkx==3.1", "networkx"),
    Package("mygrad==2.2.0", "mygrad"),
    Package("mynn==0.9.4", "mynn"),
    Package("noggin==0.10.1", "noggin"),
    Package("cogworks-data==0.2.0", "cogworks_data"),
)

#: Week 3, language search. Installed into the 3.8.20 venv, as Week 1 is.
#:
#: The course's Week 3 conda line (docs/capstones/environment.md:218) plus the
#: pip line under it (line 244).
#:
#: Two packages the course prescribes for Week 3 are deliberately not here and
#: are not installed by any image: nltk and python-graphviz. Saying so in the
#: file that defines the environment is the point of having one. A module that
#: imports nltk is skipped in the graded run, and the report says the package
#: is not installed rather than claiming we have it.
WEEK3_TRACK: Tuple[Package, ...] = (
    Package("numpy==1.24.4", "numpy"),
    Package("gensim>=4.3,<4.4", "gensim"),
    Package("platformdirs>=4,<5", "platformdirs"),
    Package("mygrad==2.2.0", "mygrad"),
    Package("mynn==0.9.4", "mynn"),
    Package("noggin==0.10.1", "noggin"),
    Package("cogworks-data==0.2.0", "cogworks_data"),
    Package("matplotlib==3.7.5", "matplotlib"),
    Package("scikit-learn==1.3.2", "sklearn"),
    Package("numba==0.58.1", "numba"),
    Package("llvmlite==0.41.1", "llvmlite"),
)

#: Every track by short name.
TRACKS: Dict[str, Tuple[Package, ...]] = {
    "week1": WEEK1_TRACK,
    "week2": WEEK2_TRACK,
    "week3": WEEK3_TRACK,
}

#: Which track scores a benchmark id. Week 2 ships two benchmark ids
#: (recognition and clustering) out of one image, so this maps ids rather than
#: assuming one benchmark per week. The ids are the entry-point names in each
#: benchmark's pyproject, and `modal_app._sandbox_image` dispatches on the same
#: strings; a name that disagrees with those sends every caller here to the
#: wrong week's package list.
BENCHMARK_TRACKS: Dict[str, str] = {
    "audio-identification": "week1",
    "vision-recognition": "week2",
    "vision-clustering": "week2",
    "language-search": "week3",
}


def track_for(benchmark: str) -> str:
    """Which week's image scores this benchmark, or "" when we do not know.

    An unknown benchmark returns "" rather than guessing a track. Guessing
    would make every caller here report a package set for the wrong week,
    which is the failure this module was written to remove.
    """

    return BENCHMARK_TRACKS.get(benchmark, "")


def requirement_strings(track: str) -> Tuple[str, ...]:
    """Exactly what pip is handed for one track, in order.

    Order is preserved because Modal caches an image layer against the command
    string, so reordering forces every student's next run to wait on a rebuild.
    """

    return tuple(package.requirement for package in TRACKS[track])


def student_modules(track: str) -> FrozenSet[str]:
    """Import names one track's graded environment provides.

    Direct installs only; see the module docstring for why the transitive set
    is not knowable here.
    """

    return frozenset(package.module for package in TRACKS[track])


def all_student_modules() -> FrozenSet[str]:
    """Every import name any graded environment provides.

    Used where a track is not known, and where the honest question is "could
    any graded run import this", not "does this one".
    """

    return frozenset(
        package.module for packages in TRACKS.values() for package in packages
    )


def venv_install_command(track: str, python: str = PY38_VENV) -> str:
    """The uv command that fills a 3.8 venv for Week 1 or Week 3.

    pip itself is in the command rather than in the package data because it is
    build machinery: the next build step runs `python -m pip install --no-deps
    /opt/weekN`, which needs pip present. It is not part of the course stack
    and does not belong in a list describing what a submission may import.
    """

    if track not in ("week1", "week3"):
        raise KeyError(
            "{} does not use a 3.8 venv; its student code runs on the image "
            "interpreter directly.".format(track)
        )
    quoted = " ".join("'{}'".format(text) for text in requirement_strings(track))
    return "uv pip install --python {} pip {}".format(python, quoted)


def local_gap(benchmark: str) -> Tuple[str, ...]:
    """Which of this benchmark's graded packages this machine cannot import.

    The point is not to get a laptop to match the image; that is neither
    achievable nor desirable (torch alone is a multi-gigabyte install for a
    check that takes two seconds). The point is that a local dry run and the
    graded run read different amounts of a repository, and until now nothing
    said so.

    Measured on a developer machine against `benchmark_image`: cv2,
    facenet_models, torch, sklearn, matplotlib, datasets, mygrad, mynn, noggin
    were absent locally and present in the image. A module importing any of
    them is skipped here and read there, so `cogworks check` reported a smaller
    repository than the graded run sees, with no indication that it had.

    An unknown benchmark returns nothing rather than a guess, since a package
    list for the wrong week is worse than no list.
    """

    track = track_for(benchmark)
    if not track:
        return ()
    return missing_here(sorted(student_modules(track)))


def gap_note(benchmark: str, missing: Sequence[str]) -> str:
    """One paragraph for a student whose machine is missing graded packages.

    Written to docs/design/voice.md: the reason comes before the fact, the
    difficulty is stated plainly, and there is no reassurance behind it.

    It leads with the consequence, because that is the part that changes what
    they do: a module whose imports do not resolve here is skipped, so this
    report describes less of their repository than the graded run will read.
    Then it names the packages, since a student cannot check a claim about
    "some packages".

    Every package on this list is one the course's own setup instructions
    install (docs/capstones/environment.md), so "install these" is honest
    advice rather than a demand that they reproduce our image. It is not
    phrased as a fix, because nothing is broken: their repository is fine and
    the graded run is unaffected.

    Returns "" when nothing is missing, so a caller can print it
    unconditionally.
    """

    if not missing:
        return ""
    names = ", ".join(missing)
    if len(missing) == 1:
        return (
            "One package the graded run installs is missing here, so this "
            "report may have read less of your repository than the graded run "
            "will. If a module is listed above under 'could not read' because "
            "it needs {}, this machine skipped it. The hosted run has the "
            "package and will read that module. It is part of the environment "
            "the course has you set up, so installing it here makes this check "
            "match the graded run more closely."
        ).format(names)
    return (
        "{} packages the graded run installs are missing here, so this report "
        "may have read less of your repository than the graded run will. If a "
        "module is listed above under 'could not read' because it needs one of "
        "these packages, this machine skipped it. The hosted run has the "
        "packages and will read those modules. They are part of the environment "
        "the course has you set up, so installing them here makes this check "
        "match the graded run more closely. Missing: {}."
    ).format(len(missing), names)


def missing_here(modules: Sequence[str]) -> Tuple[str, ...]:
    """Which of these import names this interpreter cannot provide, in order.

    Uses ``find_spec``, which locates a module without running it. Importing to
    find out would execute package initialisation for every heavy package on
    the list, and on a laptop with torch installed that alone costs seconds.

    A name already in ``sys.modules`` with no spec raises ValueError rather
    than answering, and a broken installation can raise almost anything from
    its finder. Either way the honest answer is that we could not confirm the
    package is here, so it is reported as missing rather than assumed present.
    """

    absent = []
    for name in modules:
        try:
            found = importlib.util.find_spec(name)
        except (ImportError, ValueError, AttributeError, TypeError):
            found = None
        if found is None:
            absent.append(name)
    return tuple(absent)
