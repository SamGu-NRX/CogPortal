from __future__ import annotations

from importlib import metadata
from typing import Any, Iterable, List


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


def load_plugin(group: str, name: str) -> Any:
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
    if isinstance(loaded, type):
        return loaded()
    return loaded


def load_benchmark(name: str) -> Any:
    return load_plugin("cogworks.benchmarks.v1", name)


def load_submission(name: str) -> Any:
    return load_plugin("cogworks.submissions.v1", name)
