"""Public CogBench API."""

from importlib.metadata import PackageNotFoundError, version as _installed_version

#: Read from the installed package rather than restated here.
#:
#: This was a literal, and it drifted: pyproject said one version and this
#: file said another, so `cogworks --version` and the report's `cliVersion`
#: both named a release that was not what the student had. A student
#: comparing their output against a runbook has no way to tell which number
#: lied.
#:
#: The fallback is for running out of a source checkout with nothing
#: installed, which is how the tests and the corpus sweeps run. It says so
#: rather than guessing a number, because a wrong version is worse than an
#: obviously absent one.
try:
    __version__ = _installed_version("cogworks-benchmark")
except PackageNotFoundError:  # running from a source tree, not installed
    __version__ = "0+source"
