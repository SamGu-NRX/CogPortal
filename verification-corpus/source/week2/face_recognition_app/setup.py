"""Compatibility shim for tools that still invoke ``setup.py`` directly.

Package metadata lives in :mod:`pyproject.toml`; keeping this small shim
preserves the original project's familiar entry point without maintaining two
copies of its dependency and version declarations.
"""

from setuptools import setup

setup()
