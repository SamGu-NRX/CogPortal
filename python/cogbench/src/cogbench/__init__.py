"""Public CogBench API."""

from importlib.metadata import PackageNotFoundError, version as _installed_version

#: Read from the installed package rather than restated here, because as a
#: literal it drifted from pyproject and `cogworks --version` named a release
#: the student did not have.
#:
#: The fallback is for running out of a source checkout with nothing
#: installed, which is how the tests and the corpus sweeps run. It says so
#: rather than guessing a number.
try:
    __version__ = _installed_version("cogworks-benchmark")
except PackageNotFoundError:  # running from a source tree, not installed
    __version__ = "0+source"
