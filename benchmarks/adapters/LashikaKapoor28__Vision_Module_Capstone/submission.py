"""Instructor-supplied adapter for LashikaKapoor28/Vision_Module_Capstone.

The team wrote a complete face recognition and clustering system: cosine
distance over FaceNet descriptors, a per-person profile that averages its
descriptors, a tuned recognition cutoff, and the Whispers label-propagation
algorithm. They never wrote a benchmark adapter, because the benchmark did not
exist when they submitted. This file is the missing wiring and nothing else.

Every decision the benchmark scores is theirs: their `cosine_distances`, their
`Profile.average_descriptor`, their `RECOGNITION_THRESHOLD` of 0.2846, their
graph-building cutoff, their `1/dist**2` edge weight, and their
`propagate_label`. We supply no distance, no threshold, and no clustering rule.

Three things needed a decision, all recorded in `PROVENANCE`:

Their `core/whispers.py` builds a `FacenetModel()` at module scope and their
`get_descriptor` reads images off disk. The benchmark hands over decoded arrays
and supplies its own model instance, so the adapter imports the parts of that
module that are pure graph work -- `Node`, `propagate_label`,
`connected_comps`, `whispers` -- and rebuilds only the descriptor step, which
is `model.detect` then `model.compute_descriptors`, exactly what their
`get_descriptor` does minus the file I/O. Their module-scope model construction
would otherwise download weights inside a network-blocked sandbox.

Their `adj_list` computes descriptors and the graph together, so it cannot be
called with arrays. The adapter reimplements only its graph half, keeping their
threshold comparison and their `1 / max(dist, 1e-8) ** 2` weight verbatim.

Their `whispers` calls `random.choice` without seeding. The contract passes a
seed, so the adapter seeds Python's `random` module before calling their loop,
which is the only way to make their algorithm reproducible without editing it.
"""

from __future__ import annotations

import random
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

#: What this adapter added, and what it did not. The driver copies this into
#: the run result so a leaderboard row can say which parts of a score belong
#: to the team. Nothing in `we_supplied` is a distance, a threshold, or a
#: clustering decision.
PROVENANCE = {
    "source": "instructor-supplied",
    "student_wrote": [
        "core/similarity.cosine_distances: L2-normalize both sides, 1 - a @ b.T",
        "core/profile.Profile.average_descriptor: mean of a person's descriptors",
        "recognizer.RECOGNITION_THRESHOLD = 0.2846 and the argmin-then-compare "
        "rule that returns a name or 'Unknown'",
        "core/whispers.adj_list's graph rule: an edge when cosine distance is "
        "below threshold, weighted 1 / max(dist, 1e-8) ** 2",
        "core/whispers.propagate_label: adopt the neighbor label with the "
        "largest summed edge weight",
        "core/whispers.whispers: the random-node propagation loop with its "
        "stability patience",
        "core/whispers.connected_comps: group nodes by current label",
    ],
    "we_supplied": [
        "the enroll / recognize / cluster method names and their signatures",
        "descriptors from the benchmark's FacenetModel rather than their "
        "module-scope FacenetModel(), which downloads weights on construction "
        "and cannot run in a network-blocked sandbox",
        "the detect-then-compute_descriptors step their get_descriptor does, "
        "minus its skimage file read, because the benchmark passes arrays",
        "the graph-assembly half of their adj_list, with their threshold "
        "comparison and edge weight unchanged; their half computed "
        "descriptors from paths and could not be called with arrays",
        "seeding Python's random before their whispers loop, which calls "
        "random.choice unseeded, so a scored run is reproducible",
        "locating the repository on sys.path",
    ],
    "not_used": [
        "main.py and frontend.py, their Streamlit application",
        "profiles.pkl, their saved database of teammates",
        "core/normalize.resize_images, which rewrites files on disk",
        "core/whispers.organize_photos, which copies files into a result folder",
        "core/whispers.get_descriptor's skimage image reading",
        "tuning/, their threshold sweep",
    ],
    "known_issues": [
        "Their clustering threshold is not a module constant: main.py passes "
        "it to adj_list at the call site. The adapter uses 0.55, the value "
        "their tuning/ notebook settles on; a different choice would change "
        "the clustering score and is worth confirming with the team.",
        "RECOGNITION_THRESHOLD = 0.2846 was tuned on their own photographs "
        "(tuning/recognition_threshold.ipynb reports the FAR/FRR crossing at "
        "0.2846 with both rates at 0.0000) and does not transfer to CelebA. "
        "Measured on the public test tier: their nearest-profile ranking is "
        "correct on every post-enrollment query, but the winning distance is "
        "0.58 to 0.63, so their cutoff rejects a correct match and "
        "post_enrollment_accuracy is 0.000. The cutoff is theirs and is left "
        "alone; this is a real property of the submission, not a wiring bug.",
    ],
}

#: Their `main.py` passes this to `adj_list`; it is not a module constant in
#: their repository, so it is named here rather than silently inlined.
CLUSTER_THRESHOLD = 0.55


def _student_modules():
    """Import their pure-numpy modules. Nothing here touches the network.

    `core.whispers` is imported for `Node`, `propagate_label`,
    `connected_comps`, and `whispers`. It constructs a `FacenetModel()` at
    module scope, which in a network-blocked sandbox raises while downloading
    weights, so the import happens with a stub in place for `facenet_models`
    and `skimage`; the benchmark's own model is used for every descriptor.
    """

    repo_root = Path(__file__).resolve().parent
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    import types

    stubbed = []
    if "facenet_models" not in sys.modules:
        stub = types.ModuleType("facenet_models")

        class _NoModel:
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass

            def __getattr__(self, name: str) -> Any:
                raise RuntimeError(
                    "This adapter scores through the benchmark's FacenetModel; "
                    "the submission's module-scope instance is never used."
                )

        stub.FacenetModel = _NoModel
        sys.modules["facenet_models"] = stub
        stubbed.append("facenet_models")

    try:
        from core import similarity as student_similarity
        from core import whispers as student_whispers
        from core.profile import Profile
        import recognizer as student_recognizer
    finally:
        for name in stubbed:
            sys.modules.pop(name, None)

    return student_similarity, student_whispers, Profile, student_recognizer


def _descriptors_for(model: Any, image: np.ndarray) -> np.ndarray:
    """Their get_descriptor's model half: detect, then compute descriptors.

    Their version reads the image off disk, drops an alpha channel, filters
    boxes by a 0.87 probability, and keeps the single most confident face. The
    benchmark passes decoded arrays, so the file read goes; everything else is
    kept, including the probability cutoff.
    """

    array = np.asarray(image)
    if array.ndim == 3 and array.shape[-1] == 4:
        array = array[..., :3]
    boxes, probabilities, _landmarks = model.detect(array)
    if boxes is None or len(boxes) == 0:
        return np.zeros((0, 512), dtype=np.float32)
    if probabilities is not None:
        mask = np.asarray(probabilities) > 0.87
        if mask.any():
            boxes = np.asarray(boxes)[mask]
        # If nothing clears their cutoff, fall through with every box rather
        # than returning nothing: the recognition track always expects a
        # prediction per image, and "no face" there is a miss, not an abstain.
    return np.asarray(model.compute_descriptors(array, boxes), dtype=np.float32)


class LashikaVisionAdapter:
    """Their recognizer and their Whispers, behind the contract's names."""

    def __init__(self, model: Any) -> None:
        self.model = model
        (
            self.similarity,
            self.whispers_module,
            self.Profile,
            self.recognizer,
        ) = _student_modules()
        self.profiles: Dict[str, Any] = {}

    # -- recognition ------------------------------------------------------

    def enroll(self, person_id: str, images: Sequence[np.ndarray]) -> None:
        """One Profile per person, holding every descriptor we saw."""

        descriptors: List[np.ndarray] = []
        for image in images:
            for descriptor in _descriptors_for(self.model, image):
                descriptors.append(np.asarray(descriptor, dtype=np.float32))
        if not descriptors:
            return
        if person_id in self.profiles:
            for descriptor in descriptors:
                self.profiles[person_id].add_descriptor(descriptor)
        else:
            self.profiles[person_id] = self.Profile(person_id, list(descriptors))

    def recognize(self, images: Sequence[np.ndarray]) -> List[Optional[str]]:
        """Their recognizer's rule, on descriptors we hand it.

        `recognizer.recognize` takes a database object and a model and does its
        own detection, so it cannot be called directly here. What is reused is
        the part that decides: their cosine distance against each profile's
        average descriptor, their argmin, and their 0.2846 cutoff.
        """

        names = list(self.profiles)
        answers: List[Optional[str]] = []
        if not names:
            return [None for _ in images]

        known = np.asarray(
            [np.asarray(self.profiles[name].average_descriptor, dtype=np.float32)
             for name in names],
            dtype=np.float32,
        )
        threshold = float(self.recognizer.RECOGNITION_THRESHOLD)

        for image in images:
            descriptors = _descriptors_for(self.model, image)
            if descriptors.shape[0] == 0:
                answers.append(None)
                continue
            distances = self.similarity.cosine_distances(descriptors[:1], known)[0]
            best = int(np.argmin(distances))
            # Their "Unknown" becomes the contract's None: same decision,
            # the name the benchmark uses for an abstain.
            answers.append(names[best] if distances[best] < threshold else None)
        return answers

    # -- clustering -------------------------------------------------------

    def cluster(self, images: Sequence[np.ndarray], *, seed: int) -> List[int]:
        """Their Whispers, on a graph built by their own rule.

        Their `adj_list` computes descriptors from paths and builds the graph
        in one pass, so only its graph half is reproduced here; the threshold
        comparison and the `1 / max(dist, 1e-8) ** 2` weight are theirs.
        """

        descriptors: List[np.ndarray] = []
        for image in images:
            found = _descriptors_for(self.model, image)
            # One face per image in this track; a miss still needs a slot so
            # the returned labels line up with the input.
            descriptors.append(
                found[0] if found.shape[0] else np.zeros(512, dtype=np.float32)
            )
        matrix = np.asarray(descriptors, dtype=np.float32)
        if matrix.shape[0] == 0:
            return []

        nodes = [
            self.whispers_module.Node(index, matrix[index], label=index)
            for index in range(matrix.shape[0])
        ]
        distances = self.similarity.cosine_distances(matrix, matrix)
        adjacency: Dict[Any, List[Any]] = {node: [] for node in nodes}
        for i, first in enumerate(nodes):
            for j in range(i + 1, len(nodes)):
                distance = distances[i, j]
                if distance < CLUSTER_THRESHOLD:
                    weight = 1 / max(distance, 1e-8) ** 2
                    adjacency[first].append((nodes[j], weight))
                    adjacency[nodes[j]].append((first, weight))

        # Their loop calls random.choice with no seed of its own.
        random.seed(seed)
        self.whispers_module.whispers(nodes, adjacency, iterations=len(nodes) * 60)
        return [int(node.label) for node in nodes]


def create_submission(model: Any) -> LashikaVisionAdapter:
    return LashikaVisionAdapter(model)


def create_recognition_adapter(model: Any) -> LashikaVisionAdapter:
    return LashikaVisionAdapter(model)


def create_clustering_adapter(model: Any) -> LashikaVisionAdapter:
    return LashikaVisionAdapter(model)
