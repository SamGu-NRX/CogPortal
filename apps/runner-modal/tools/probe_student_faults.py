"""What do ordinary student mistakes do to the platform?

Not cheating. These are the things a high-schooler writes by accident on a
Tuesday. For each one we ask the question that decides whether the platform is
reliable: does the benchmark return a scored result with a readable diagnostic,
or does the mistake propagate and take the scorer down with it?

Every variant here should end in "scored". A row reading "RUN RAISED" or
"SCORER RAISED" is a platform bug, not a student bug.

Needs the Week 3 artifact cache, so it lives here rather than in tests/. Run it
under the Week 3 environment after changing anything in the evaluation path:

    python apps/runner-modal/tools/probe_student_faults.py

Read-only. Touches nothing in the repository.
"""

import io
import contextlib
import traceback

import numpy as np
from cogbench.plugins import load_benchmark

TIER = "test"
D = 32


def _ok_vecs(n, d=D):
    rng = np.random.RandomState(0)
    v = rng.randn(n, d).astype(np.float32)
    return v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)


class Base:
    """A minimally working adapter; each variant breaks one thing."""

    def __init__(self, resources):
        self.pool = []

    def embed_text(self, captions):
        return _ok_vecs(len(captions))

    def embed_images(self, descriptors):
        return _ok_vecs(np.asarray(descriptors).shape[0])

    def prepare_database(self, image_ids, descriptors):
        self.pool = list(image_ids)

    def search(self, query, k):
        return self.pool[:k]


class WrongRank(Base):
    def embed_text(self, captions):
        return _ok_vecs(len(captions))[:, 0]  # (N,) not (N,D)


class PythonLists(Base):
    def embed_text(self, captions):
        return _ok_vecs(len(captions)).tolist()  # list, not ndarray


class NaNs(Base):
    def embed_text(self, captions):
        v = _ok_vecs(len(captions))
        v[0] = np.nan
        return v


class WrongRowCount(Base):
    def embed_images(self, descriptors):
        return _ok_vecs(max(1, np.asarray(descriptors).shape[0] - 1))


class MismatchedWidths(Base):
    def embed_images(self, descriptors):
        return _ok_vecs(np.asarray(descriptors).shape[0], d=D + 7)


class RaisesInEmbed(Base):
    def embed_text(self, captions):
        raise ValueError("forgot to normalise")  # ordinary bug


class SearchReturnsTuples(Base):
    def search(self, query, k):
        return [(i, 0.5) for i in self.pool[:k]]  # (id, score) pairs


class SearchReturnsStrings(Base):
    def search(self, query, k):
        return [str(i) for i in self.pool[:k]]


class SearchTooMany(Base):
    def search(self, query, k):
        return self.pool  # ignores k


class SearchOutOfPool(Base):
    def search(self, query, k):
        return [999999999] * k


class NoPrepareMethod:
    """Deliberately does NOT inherit Base: it must not expose prepare_database.

    Subclassing Base kept inheriting the documented name, so this variant used
    to behave exactly like the baseline and never exercised the case it is
    named after.
    """

    def __init__(self, resources):
        self.pool = []

    def embed_text(self, captions):
        return _ok_vecs(len(captions))

    def embed_images(self, descriptors):
        return _ok_vecs(np.asarray(descriptors).shape[0])

    def build_index(self, image_ids, descriptors):  # plausible other name
        self.pool = list(image_ids)

    def search(self, query, k):
        return self.pool[:k]


class MutatesInputs(Base):
    def embed_images(self, descriptors):
        arr = np.asarray(descriptors)
        arr *= 0.0  # in-place on our array
        return _ok_vecs(arr.shape[0])


class Chatty(Base):
    def embed_text(self, captions):
        for i in range(3000):
            print("debug: step {} of the training loop".format(i))
        return _ok_vecs(len(captions))


class ReturnsNone(Base):
    def embed_text(self, captions):
        return None


VARIANTS = [
    ("baseline (works)", Base),
    ("embed_text returns (N,) not (N,D)", WrongRank),
    ("returns python lists", PythonLists),
    ("NaN in embeddings", NaNs),
    ("embed_images wrong row count", WrongRowCount),
    ("text/image widths differ", MismatchedWidths),
    ("raises inside embed_text", RaisesInEmbed),
    ("search returns (id, score)", SearchReturnsTuples),
    ("search returns str ids", SearchReturnsStrings),
    ("search ignores k", SearchTooMany),
    ("search returns ids outside pool", SearchOutOfPool),
    ("prepare method named build_index", NoPrepareMethod),
    ("mutates the descriptors in place", MutatesInputs),
    ("prints 3000 lines", Chatty),
    ("embed_text returns None", ReturnsNone),
]


def main():
    bench = load_benchmark("language-search")
    cases = list(bench.load_cases(TIER))
    resources = bench.model_factory()

    print("{:<38} {:<28} {}".format("VARIANT", "OUTCOME", "overall / detail"))
    print("-" * 100)
    for name, cls in VARIANTS:
        # Fresh cases each time: if a variant corrupts them, the next variant
        # must not inherit the damage (that is itself what we are testing).
        cases = list(bench.load_cases(TIER))
        sink = io.StringIO()
        try:
            with contextlib.redirect_stdout(sink):
                outputs = bench.run(lambda r, c=cls: c(r), resources, cases)
            outcome, detail = "ran", ""
        except Exception as error:
            print(
                "{:<38} {:<28} {}".format(
                    name, "RUN RAISED", type(error).__name__ + ": " + str(error)[:40]
                )
            )
            continue
        try:
            scores = bench.score(outputs, cases)
            detail = "overall={:.4f}".format(float(scores["overall"]))
            outcome = "scored"
        except Exception as error:
            outcome = "SCORER RAISED"
            detail = type(error).__name__ + ": " + str(error)[:60]
            traceback.clear_frames(error.__traceback__)
        print("{:<38} {:<28} {}".format(name, outcome, detail))


if __name__ == "__main__":
    main()
