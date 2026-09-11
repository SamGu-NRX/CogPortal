from __future__ import annotations

from importlib import metadata
from pathlib import Path
from typing import Any, Dict, Iterable, List, NamedTuple, Optional, Tuple

from .apploader import SubmissionFileError, SubmissionFileMissing, resolve_submission_file


class PluginError(RuntimeError):
    pass


class BenchmarkInstall(NamedTuple):
    distribution: str
    source: str


# The URL is the one in .gitmodules and the commit is the gitlink beside it,
# restated here because the CLI is installed as a package and cannot read the
# parent checkout. test_plugins.py reads both back out of the repository, so a
# submodule bump that misses this table breaks CI rather than a student's
# install.
BENCHMARK_INSTALLS: Dict[str, BenchmarkInstall] = {
    "audio-identification": BenchmarkInstall(
        "cogworks-week1-audio-benchmark",
        "git+https://github.com/SamGu-NRX/cogworks-week1-audio-benchmark.git"
        "@61ef56ebb14a47419ad9b27c79dfdd82aca798f2",
    ),
    "vision-recognition": BenchmarkInstall(
        "cogworks-week2-vision-benchmark",
        "git+https://github.com/SamGu-NRX/cogworks-week2-vision-benchmark.git"
        "@65200e909264414761a55c670a3c323b5122c7fb",
    ),
    "vision-clustering": BenchmarkInstall(
        "cogworks-week2-vision-benchmark",
        "git+https://github.com/SamGu-NRX/cogworks-week2-vision-benchmark.git"
        "@65200e909264414761a55c670a3c323b5122c7fb",
    ),
    "language-search": BenchmarkInstall(
        "cogworks-week3-language-benchmark",
        "git+https://github.com/SamGu-NRX/cogworks-week3-language-benchmark.git"
        "@abdce758b85c347bc7ac0c15e31c5bc015ca5803",
    ),
}


def benchmark_install_command(name: str) -> Optional[str]:
    install = BENCHMARK_INSTALLS.get(name)
    if install is None:
        return None
    return 'python -m pip install "{} @ {}"'.format(
        install.distribution, install.source
    )


def _entry_points(group: str) -> Iterable[Any]:
    discovered = metadata.entry_points()
    if hasattr(discovered, "select"):
        return discovered.select(group=group)
    return discovered.get(group, [])  # type: ignore[no-any-return,union-attr]


def _unique_entry_points(group: str) -> List[Any]:
    """Collapse duplicate metadata views of the same installed entry point.

    Python 3.8 can expose both an editable install's ``.dist-info`` metadata and
    its source-tree ``.egg-info`` metadata when the editable source directory is
    also on ``sys.path``. Those records describe one plugin, not two competing
    implementations. Different object references remain ambiguous and fail
    closed in ``load_plugin``.
    """

    unique = {}
    for point in _entry_points(group):
        unique.setdefault((point.name, point.value), point)
    return list(unique.values())


def plugin_names(group: str) -> List[str]:
    return sorted({point.name for point in _unique_entry_points(group)})


def load_plugin(group: str, name: str, instantiate_classes: bool = True) -> Any:
    matches = [point for point in _unique_entry_points(group) if point.name == name]
    if not matches:
        installed = plugin_names(group)
        if not group.startswith("cogworks.benchmarks."):
            raise PluginError(
                '"{}" is not installed in "{}" (available: {}). Install the '
                "package that provides it and run this again.".format(
                    name, group, ", ".join(installed) or "none"
                )
            )
        # Two readers, two sentences. A benchmark that is simply not
        # installed is the ordinary case and the student's next step is one
        # command, so say that and nothing else. `cogworks check` has always
        # said it plainly ("Nothing was searched for, because X is not
        # installed here"), and `cogworks run` answered the same situation
        # with 'Entry-point group "cogworks.benchmarks.v1" has no
        # "audio-identification" registration (available: none)', which names
        # a Python packaging concept and no next step. Same cause, and the
        # worse sentence was the one a student reaches after doing more work.
        #
        # The group and what is installed still matter when something IS
        # installed, because then the likely fault is a name or a version
        # rather than an absence, and the reader is more often us.
        if not installed:
            command = benchmark_install_command(name)
            if command:
                raise PluginError(
                    "{} is not installed here, so there is nothing to run. "
                    "Install it with `{}`, then run this again.".format(name, command)
                )
            raise PluginError(
                "{} is not installed here, so there is nothing to run. Install "
                "the benchmark package for this week and run this again.".format(name)
            )
        raise PluginError(
            '"{}" is not among the benchmarks installed here ({}). Check the '
            "spelling, or install the package that provides it.".format(
                name, ", ".join(installed)
            )
        )
    if len(matches) > 1:
        raise PluginError('More than one "{}" plugin is installed in "{}".'.format(name, group))
    loaded = matches[0].load()
    if instantiate_classes and isinstance(loaded, type):
        return loaded()
    return loaded


def load_benchmark(name: str) -> Any:
    if name in plugin_names("cogworks.benchmarks.v2"):
        return load_plugin("cogworks.benchmarks.v2", name)
    return load_plugin("cogworks.benchmarks.v1", name)


def load_submission(
    name: str,
    contract_version: str = "cogworks.submissions.v1",
    repo_root: Optional[Path] = None,
) -> Any:
    """The student's submission factory, by entry point or by file.

    Entry points are tried first because the two reference repositories in
    ``examples/`` register that way and their behavior must not change. The
    file fallback is what actually serves student repositories, none of which
    carry packaging metadata.
    """

    return resolve_submission(name, contract_version, repo_root)[0]


def resolve_submission(
    name: str,
    contract_version: str = "cogworks.submissions.v1",
    repo_root: Optional[Path] = None,
) -> Tuple[Any, str, str]:
    """``(factory, source, detail)`` where source is "entry_point" or "file".

    ``detail`` is what to show a student: the entry-point group, or the
    ``submission.py:create_submission`` that resolved. Separate from
    ``load_submission`` so the loading signature stays what callers expect.
    """

    instantiate = contract_version != "cogworks.submissions.v2"
    root = Path.cwd() if repo_root is None else Path(repo_root)

    # The file wins over an installed entry point when both exist. A student
    # who wrote a submission.py in this directory meant that file, and an
    # entry point can arrive from anywhere in the environment: a reference
    # submission someone pip-installed once, a sibling week left over from a
    # previous `pip install -e`. Checking entry points first meant `cogworks
    # run` in a directory containing the student's own work could score
    # somebody else's code and report success, which is the worst failure
    # this tool has because it looks exactly like a pass.
    #
    # A file that exists but is broken is also final. Falling through to an
    # entry point there would hide their syntax error behind someone else's
    # working code, which is the same failure wearing a different hat.
    try:
        found = resolve_submission_file(root, name)
    except SubmissionFileMissing as error:
        missing = error
    except SubmissionFileError as error:
        # The file is the submission; its own failure is the whole answer.
        # Prefixing it with an entry-point miss would bury the line number
        # the student needs behind a mechanism they never used.
        raise PluginError(str(error)) from error
    else:
        factory = found.factory
        if instantiate and isinstance(factory, type):
            factory = factory()
        return factory, "file", found.describe()

    if name in plugin_names(contract_version):
        return (
            load_plugin(contract_version, name, instantiate_classes=instantiate),
            "entry_point",
            contract_version,
        )

    # Neither path found anything, and the two have different fixes (install a
    # package, or write the file), so name both rather than guess which one
    # this student meant.
    raise PluginError(
        "{} Nothing is registered as \"{}\" in \"{}\" either (installed: {}), so if you "
        "meant to install your project as a package, reinstall it.".format(
            missing,
            name,
            contract_version,
            ", ".join(plugin_names(contract_version)) or "none",
        )
    ) from missing
