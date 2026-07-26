from pathlib import Path

from reference_search import ReferenceApp

WEIGHTS = Path(__file__).resolve().parent / "weights.npz"


def create_search_adapter(resources):
    return ReferenceApp.load(WEIGHTS, resources)
