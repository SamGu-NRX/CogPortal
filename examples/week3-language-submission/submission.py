"""Repository-root submission fixture for the Week 3 language benchmark."""

from benchmark_adapter import create_search_adapter


def create_submission(resources):
    return create_search_adapter(resources)
