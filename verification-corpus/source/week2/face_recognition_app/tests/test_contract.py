from __future__ import annotations

from benchmark_adapter import create_clustering_adapter, create_recognition_adapter

from facial_recognition_benchmark.adapters import adapt_clustering, adapt_recognition


def test_recognition_factory_exposes_contract(fake_model):
    application = create_recognition_adapter(fake_model)
    adapter = adapt_recognition(application)
    assert callable(adapter.enroll)
    assert callable(adapter.recognize)


def test_clustering_factory_exposes_contract(fake_model):
    application = create_clustering_adapter(fake_model)
    adapter = adapt_clustering(application)
    assert callable(adapter.cluster)
