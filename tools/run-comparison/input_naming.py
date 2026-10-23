"""Give fixture paths stable, distinct names for receipts and rendered views."""

from __future__ import annotations

from pathlib import Path
from typing import List


def input_identities(files: List[Path]) -> List[str]:
    """Return the shortest trailing path that uniquely names each input.

    A repeated resolved path is invalid because it cannot represent two
    reports. Other files may share a basename, so the helper keeps enough
    trailing components to distinguish them.
    """

    resolved = [path.resolve() for path in files]
    if len(set(resolved)) != len(resolved):
        repeated = sorted(
            {path.name for path in resolved if resolved.count(path) > 1}
        )
        raise ValueError(
            "the same fixture file is given more than once: {}".format(
                ", ".join(repeated)
            )
        )

    parts = [path.parts for path in resolved]
    identities: List[str] = []
    for index, path_parts in enumerate(parts):
        depth = 1
        while depth < len(path_parts) and any(
            other[-depth:] == path_parts[-depth:]
            for other_index, other in enumerate(parts)
            if other_index != index
        ):
            depth += 1
        identities.append("/".join(path_parts[-depth:]))
    return identities

