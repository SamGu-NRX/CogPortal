"""Local-truth harness: run the benchmark on reference, inert, and broken
submissions and print what each scores.

Acceptance (plan step B): the reference clears chance decisively on all
three components, the inert variant lands near chance, and the broken
variant produces a named contract report, never a bare traceback.

    python eval_variants.py [test|evaluation]
"""

from __future__ import annotations

import sys
import time

import numpy as np

from benchmark_adapter import create_search_adapter
from language_search_benchmark.plugins import LanguageSearchBenchmark


class InertAdapter:
    def embed_text(self, captions):
        return np.zeros((len(captions), 64))

    def embed_images(self, descriptors):
        return np.zeros((len(descriptors), 64))

    def prepare_database(self, image_ids, descriptors):
        self._ids = list(image_ids)

    def search(self, query, k):
        return self._ids[:k]


class BrokenAdapter:
    def embed_text(self, captions):
        raise ValueError("weights file is missing")

    def embed_images(self, descriptors):
        raise ValueError("weights file is missing")


def run(name, factory, tier):
    benchmark = LanguageSearchBenchmark()
    started = time.time()
    cases = benchmark.load_cases(tier)
    resources = benchmark.model_factory()
    outputs = benchmark.run(factory, resources, cases)
    metrics = benchmark.score(outputs, cases)
    print("\n== {} ({} tier, {:.0f}s) ==".format(name, tier, time.time() - started))
    for key in sorted(metrics):
        print("  {:<24} {:.4f}".format(key, metrics[key]))
    for note in benchmark.last_diagnostics:
        print("  note: {}".format(note))
    return metrics


def main():
    tier = sys.argv[1] if len(sys.argv) > 1 else "test"
    reference = run(
        "reference", lambda resources: create_search_adapter(resources), tier
    )
    inert = run("inert", lambda resources: InertAdapter(), tier)
    run("broken", lambda resources: BrokenAdapter(), tier)

    chance = reference["chance_mrr"]
    assert reference["overall"] > 5 * chance, "reference does not clear chance"
    assert reference["text_mrr"] > 0.3, "reference text component is weak"
    assert inert["overall"] < max(6 * chance, 0.1), (
        "inert is suspiciously far from chance"
    )
    print(
        "\nacceptance: reference clears chance, inert sits at chance, broken reported."
    )


if __name__ == "__main__":
    main()
