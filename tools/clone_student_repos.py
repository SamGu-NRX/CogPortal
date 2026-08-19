"""Clone this cohort's capstone repositories for local benchmark testing.

The benchmarks have to be developed against the code students actually wrote,
not against a reference implementation that happens to match our contract, so
these are cloned rather than described. They are all public.

    python tools/clone_student_repos.py            # clone or report
    python tools/clone_student_repos.py --week 1   # just one week

Shallow clones into `.cache/student-repos/<owner>__<name>`, which is
git-ignored: it is over 3 GB, mostly committed audio and `.npy` arrays, and
none of it belongs to us.

Nothing here writes to a student repository. `--pull` fast-forwards an existing
clone; there is no push path and no credential use.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DESTINATION = REPO_ROOT / ".cache" / "student-repos"

#: (week, group, owner/name). Week 0 means the repository holds several weeks
#: in subdirectories rather than one week at its root.
REPOSITORIES = [
    (0, 1, "rutvim2009/BWSI_CogWorks_Team_1"),
    (1, 2, "CogWorks-2026-Team-Asterisk/Week1-Capstone-Shazam"),
    (2, 2, "CogWorks-2026-Team-Asterisk/Week2-Capstone"),
    (3, 2, "CogWorks-2026-Team-Asterisk/Week3-Capstone"),
    (1, 3, "Cog-gurts/Shazam-Project"),
    (2, 3, "Cog-gurts/CoggurtFilter"),
    (3, 3, "Cog-gurts/CogFinder"),
    (1, 4, "KrazeeCoder/week1-capstone-team4"),
    (2, 4, "LashikaKapoor28/Vision_Module_Capstone"),
    (3, 4, "LashikaKapoor28/Language_Module_Capstone"),
    (1, 5, "carti4ce/week1_capstone"),
    (2, 5, "BagelBreaker/week2_capstone"),
    (3, 5, "BagelBreaker/week3_capstone"),
]


def slug(full_name: str) -> str:
    """`owner/name` to the directory name the runner's adapter lookup uses."""

    return full_name.replace("/", "__")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--week", type=int, choices=(1, 2, 3),
                        help="only repositories for this week (plus the multi-week one)")
    parser.add_argument("--pull", action="store_true",
                        help="fast-forward clones that already exist")
    arguments = parser.parse_args()

    DESTINATION.mkdir(parents=True, exist_ok=True)
    selected = [
        row for row in REPOSITORIES
        if arguments.week is None or row[0] in (arguments.week, 0)
    ]

    failures = []
    for week, group, full_name in selected:
        target = DESTINATION / slug(full_name)
        label = "week {}".format(week) if week else "weeks 1-3"
        if (target / ".git").is_dir():
            if not arguments.pull:
                print("have    group {} {:<10} {}".format(group, label, full_name))
                continue
            command = ["git", "-C", str(target), "pull", "--ff-only", "--quiet"]
            action = "pulled"
        else:
            command = ["git", "clone", "--depth", "1", "--quiet",
                       "https://github.com/{}.git".format(full_name), str(target)]
            action = "cloned"
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            failures.append((full_name, result.stderr.strip()[-200:]))
            print("FAILED  group {} {:<10} {}".format(group, label, full_name))
        else:
            print("{:<7} group {} {:<10} {}".format(action, group, label, full_name))

    if failures:
        print("\n{} repository/repositories could not be fetched:".format(len(failures)))
        for full_name, error in failures:
            print("  {}: {}".format(full_name, error))
        # A repository can go private or be renamed between cohorts; that is
        # information, not a crash.
        return 1
    print("\n{} repositories in {}".format(len(selected), DESTINATION))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
