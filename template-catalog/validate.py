import json
import re
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parent
    catalog = json.loads((root / "catalog.json").read_text(encoding="utf-8"))
    if catalog.get("version") != 1 or not isinstance(catalog.get("templates"), list):
        raise ValueError("catalog.json must contain version 1 and a templates array.")
    # One template repository serves every benchmark: a team keeps all three
    # weeks in one repo, which is what Group 1 did unprompted last year and
    # what the course's own "you will be working on the same code base"
    # advice implies. So (id, benchmarkId) is the unique key, and a repeated
    # sourceRepositoryId across benchmarks is the expected shape rather than
    # a mistake.
    keys = set()
    revisions = {}
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
        key = (template["id"], template["benchmarkId"])
        if key in keys:
            raise ValueError(
                "Duplicate template entry for {} / {}.".format(*key)
            )
        if not re.fullmatch(r"[a-f0-9]{40}", template["revision"]):
            raise ValueError("Template revisions must be immutable 40-character SHAs.")
        if not re.fullmatch(r"[^/\s]+/[^/\s]+", template["fullName"]):
            raise ValueError("Template fullName must use owner/name form.")
        keys.add(key)
        # Every benchmark served by one repository must pin the same commit,
        # or a student forking for Week 2 gets a different starting point than
        # the one who forked for Week 1 from the same template.
        pinned = revisions.setdefault(template["sourceRepositoryId"], template["revision"])
        if pinned != template["revision"]:
            raise ValueError(
                "Repository {} is pinned to two different revisions.".format(
                    template["sourceRepositoryId"]
                )
            )
        repositories = len(revisions)
    print(
        "Validated {} template entr{} across {} repositor{}.".format(
            len(keys),
            "y" if len(keys) == 1 else "ies",
            len(revisions),
            "y" if len(revisions) == 1 else "ies",
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print("template-catalog: {}".format(error), file=sys.stderr)
        raise SystemExit(1)
