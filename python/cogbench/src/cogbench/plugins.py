from __future__ import annotations

from importlib import metadata
from pathlib import Path
from typing import Any, Iterable, List, Optional, Tuple

from .apploader import SubmissionFileError, SubmissionFileMissing, resolve_submission_file


class PluginError(RuntimeError):
    pass


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
        available = ", ".join(plugin_names(group)) or "none"
        raise PluginError(
            'Entry-point group "{}" has no "{}" registration (available: {}).'.format(
                group, name, available
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
    if name in plugin_names(contract_version):
        return (
            load_plugin(contract_version, name, instantiate_classes=instantiate),
            "entry_point",
            contract_version,
        )
    root = Path.cwd() if repo_root is None else Path(repo_root)
    try:
        found = resolve_submission_file(root, name)
    except SubmissionFileMissing as error:
        # Neither path found anything, and the two have different fixes (install
        # a package, or write the file), so name both rather than guess which
        # one this student meant.
        raise PluginError(
            "{} Nothing is registered as \"{}\" in \"{}\" either (installed: {}), so if you "
            "meant to install your project as a package, reinstall it.".format(
                error,
                name,
                contract_version,
                ", ".join(plugin_names(contract_version)) or "none",
            )
        ) from error
    except SubmissionFileError as error:
        # The file exists and is the submission; its own failure is the whole
        # answer. Prefixing it with the entry-point miss would bury the line
        # number the student needs behind a mechanism they never used.
        raise PluginError(str(error)) from error
    factory = found.factory
    if instantiate and isinstance(factory, type):
        factory = factory()
    return factory, "file", found.describe()
