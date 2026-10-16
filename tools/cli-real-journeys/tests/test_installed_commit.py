"""support/installed_commit.py reads pip's direct-url record on every layout.

Before this fix (c722ed79, support/install-pinned.sh:35-36 and
support/installed-commit.ts:37-38) both helpers globbed
<prefix>/lib/pythonX.Y/site-packages, which native Windows does not have (it
installs under <prefix>/Lib/site-packages), so a correct pinned install read
as "recorded no vcs commit".

  - A Windows-layout fixture: the pre-fix glob, replayed with sys.prefix set
    to the fixture, finds nothing; the reader finds the commit.
  - A real pip install from a local git repository into a fresh venv, on
    whatever OS runs the test (CI runs it on windows-latest with Python 3.8):
    the reader reports the commit pip recorded.

Run: python -m unittest discover -s tools/cli-real-journeys/tests -p 'test_*.py'
Python 3.8 compatible. The second test needs git and PyPI (for setuptools).
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

READER = Path(__file__).resolve().parents[1] / "support" / "installed_commit.py"
COMMIT = "4e516f39ffbeefe579e093260b2865eb354c17a7"

# The pre-fix lookup (install-pinned.sh at c722ed79), with sys.prefix taken
# from argv[2] so it can be pointed at the fixture.
PRE_FIX = """
import glob, json, os, sys
sys.prefix = sys.argv[2]
names = glob.glob(os.path.join(sys.prefix, "lib", "python{}.{}".format(sys.version_info[0], sys.version_info[1]), "site-packages", "*.dist-info", "direct_url.json"))
for path in names:
    if sys.argv[1] in path:
        record = json.load(open(path))
        print((record.get("vcs_info") or {}).get("commit_id", ""))
        break
"""


def run(args, **kwargs):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, **kwargs)


class WindowsLayoutTests(unittest.TestCase):
    def test_reader_finds_a_record_under_Lib_site_packages(self):
        with tempfile.TemporaryDirectory() as prefix:
            site = Path(prefix, "Lib", "site-packages")
            info = site / "cogworks_benchmark-0.2.0.dist-info"
            info.mkdir(parents=True)
            (info / "METADATA").write_text("Metadata-Version: 2.1\nName: cogworks-benchmark\nVersion: 0.2.0\n")
            (info / "direct_url.json").write_text(json.dumps({
                "url": "https://github.com/SamGu-NRX/CogPortal.git",
                "vcs_info": {"vcs": "git", "commit_id": COMMIT},
            }))

            red = run([sys.executable, "-c", PRE_FIX, "cogworks_benchmark", prefix])
            self.assertEqual(red.stdout.strip(), "", "the pre-fix glob unexpectedly found the Windows-layout record")

            env = dict(os.environ, PYTHONPATH=str(site))
            green = run([sys.executable, str(READER), "cogworks_benchmark", "--lines"], env=env)
            self.assertEqual(green.returncode, 0, green.stderr)
            self.assertEqual(green.stdout.splitlines(), [COMMIT, "https://github.com/SamGu-NRX/CogPortal.git"])

    def test_missing_distribution_and_missing_record_exit_distinctly(self):
        with tempfile.TemporaryDirectory() as site:
            info = Path(site, "plain_dist-1.0.dist-info")
            info.mkdir()
            (info / "METADATA").write_text("Metadata-Version: 2.1\nName: plain-dist\nVersion: 1.0\n")
            env = dict(os.environ, PYTHONPATH=site)
            self.assertEqual(run([sys.executable, str(READER), "no_such_dist_here"], env=env).returncode, 2)
            self.assertEqual(run([sys.executable, str(READER), "plain_dist"], env=env).returncode, 3)


class RealInstallTests(unittest.TestCase):
    def test_reader_reports_the_commit_pip_recorded(self):
        with tempfile.TemporaryDirectory() as work:
            repo = Path(work, "repo")
            (repo / "journey_probe_dist").mkdir(parents=True)
            (repo / "journey_probe_dist" / "__init__.py").write_text("")
            (repo / "pyproject.toml").write_text(
                '[build-system]\nrequires = ["setuptools>=61"]\nbuild-backend = "setuptools.build_meta"\n'
                '[project]\nname = "journey-probe-dist"\nversion = "0.0.1"\n'
            )
            git = ["git", "-C", str(repo), "-c", "user.name=probe", "-c", "user.email=probe@example.invalid"]
            for args in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "probe"]):
                self.assertEqual(run(git + args).returncode, 0)
            commit = run(git + ["rev-parse", "HEAD"]).stdout.strip()

            env_dir = Path(work, "venv")
            created = run([sys.executable, "-m", "venv", str(env_dir)])
            self.assertEqual(created.returncode, 0, created.stderr)
            python = env_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            # The bare VCS URL form: pip 23 (the 3.8 default) rejects a named
            # PEP 508 reference to a file:/// URL.
            spec = "git+{}@{}".format(repo.as_uri(), commit)
            install = run([str(python), "-m", "pip", "install", "--quiet", spec])
            self.assertEqual(install.returncode, 0, install.stderr[-2000:])

            result = run([str(python), str(READER), "journey_probe_dist", "--lines"])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines()[0], commit)


if __name__ == "__main__":
    unittest.main()
