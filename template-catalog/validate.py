import json
import re
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parent
    catalog = json.loads((root / "catalog.json").read_text(encoding="utf-8"))
    if catalog.get("version") != 1 or not isinstance(catalog.get("templates"), list):
        raise ValueError("catalog.json must contain version 1 and a templates array.")
    ids = set()
    repository_ids = set()
    for template in catalog["templates"]:
        required = {
            "id",
            "benchmarkId",
            "sourceRepositoryId",
            "fullName",
            "revision",
            "minimumSdkVersion",
        }
        if set(template) != required:
            raise ValueError("Template entries must use exactly: {}".format(sorted(required)))
        if template["id"] in ids or template["sourceRepositoryId"] in repository_ids:
            raise ValueError("Template IDs and sourceRepositoryIds must be unique.")
        if not re.fullmatch(r"[a-f0-9]{40}", template["revision"]):
            raise ValueError("Template revisions must be immutable 40-character SHAs.")
        if not re.fullmatch(r"[^/\s]+/[^/\s]+", template["fullName"]):
            raise ValueError("Template fullName must use owner/name form.")
        ids.add(template["id"])
        repository_ids.add(template["sourceRepositoryId"])
    print("Validated {} canonical template entr{}.".format(len(ids), "y" if len(ids) == 1 else "ies"))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print("template-catalog: {}".format(error), file=sys.stderr)
        raise SystemExit(1)
