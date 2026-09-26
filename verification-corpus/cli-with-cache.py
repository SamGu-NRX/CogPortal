"""Invoke the pinned CLI with its existing Vision cache_root API set for this task."""
import functools
import os
import sys
from pathlib import Path

import cogbench.plugins as plugins

if os.environ.get("PYTHONHASHSEED") != "0":
    raise SystemExit("Start this verification command with PYTHONHASHSEED=0.")
vision_cache = Path(sys.argv[1]).resolve()
original_load = plugins.load_benchmark


def load_with_task_cache(name):
    plugin = original_load(name)
    if name in ("vision-clustering", "vision-recognition"):
        # These are existing optional parameters. Only the storage location changes.
        plugin.load_cases = functools.partial(plugin.load_cases, cache_root=vision_cache)
        plugin.cache_status = functools.partial(plugin.cache_status, cache_root=vision_cache)
    return plugin


plugins.load_benchmark = load_with_task_cache
from cogbench.cli import main

raise SystemExit(main(sys.argv[2:]))
