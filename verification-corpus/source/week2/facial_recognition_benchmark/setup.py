"""Compatibility installer for the original benchmark-project directory.

The repository root ``pyproject.toml`` is authoritative.  This file preserves
the original ``cd facial_recognition_benchmark && pip install -e .`` workflow
by discovering the package from its parent directory.
"""

from setuptools import find_packages, setup

setup(
    name="cogworks-week2-vision-benchmark",
    version="0.1.0",
    description="Behavioral and diagnostic benchmarks for CogWorks Week 2 vision",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    author="CogWorks",
    author_email="cogworks@example.com",
    url="https://github.com/CogWorksBWSI/facial_recognition_benchmark",
    packages=find_packages(
        where="..",
        include=["facial_recognition_benchmark*"],
    ),
    package_dir={"": ".."},
    package_data={
        "facial_recognition_benchmark": [
            "descriptor.json",
            "model-lock.json",
            "manifests/*.json",
            "py.typed",
        ]
    },
    install_requires=[
        "numpy>=1.24,<2",
        "Pillow>=10.2,<11",
        "platformdirs>=4,<5",
    ],
    extras_require={
        "data": ["datasets>=2.20,<4"],
        "dev": ["pytest>=8,<8.4", "ruff>=0.12,<1"],
        "full": [
            "datasets>=2.20,<4",
            "scikit-image>=0.21,<0.25",
            "networkx>=3.1,<4",
            "matplotlib>=3.7,<4",
        ],
    },
    entry_points={
        "cogworks.benchmarks.v2": [
            "vision-recognition=facial_recognition_benchmark.plugins:RecognitionBenchmark",
            "vision-clustering=facial_recognition_benchmark.plugins:ClusteringBenchmark",
        ]
    },
    python_requires=">=3.8,<3.13",
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "Intended Audience :: Science/Research",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Topic :: Scientific/Engineering :: Artificial Intelligence",
        "Topic :: Scientific/Engineering :: Image Recognition",
    ],
)
