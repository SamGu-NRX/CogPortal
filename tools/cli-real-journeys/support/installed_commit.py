"""Print pip's direct-url record for an installed distribution.

Run with the interpreter whose environment holds the install:

    <python> support/installed_commit.py DIST_NAME          # the JSON record
    <python> support/installed_commit.py DIST_NAME --lines  # commit, then url

The record is read through importlib.metadata, the way that interpreter
itself finds distributions, so it works for every site-packages layout:
lib/pythonX.Y/site-packages on POSIX and Lib/site-packages on native Windows.
Exits 2 when the distribution is not installed and 3 when it has no
direct_url.json (it did not come from a URL or VCS reference).
Python 3.8 compatible: the course environments run 3.8.
"""

import json
import sys
from importlib import metadata


def main(argv):
    if len(argv) not in (2, 3) or (len(argv) == 3 and argv[2] != "--lines"):
        print("usage: installed_commit.py DIST_NAME [--lines]", file=sys.stderr)
        return 64
    name = argv[1]
    try:
        distribution = metadata.distribution(name)
    except metadata.PackageNotFoundError:
        print("installed_commit: {} is not installed in {}".format(name, sys.prefix), file=sys.stderr)
        return 2
    text = distribution.read_text("direct_url.json")
    if text is None:
        print("installed_commit: {} has no direct_url.json".format(name), file=sys.stderr)
        return 3
    if len(argv) == 3:
        record = json.loads(text)
        print((record.get("vcs_info") or {}).get("commit_id", ""))
        print(record.get("url", ""))
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
