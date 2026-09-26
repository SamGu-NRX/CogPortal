"""CogBench entry points for Reynaldo's reference application.

The factories deliberately return the complete :class:`FaceRecognitionApp`.
The benchmark's bounded compatibility layer translates its documented,
path-based API into the small behavioral contracts used for scoring.  Keeping
that translation outside the application makes this project useful as both a
normal reference implementation and an end-to-end benchmark fixture.
"""

from typing import Any

from face_recognition import FaceRecognitionApp


def create_recognition_adapter(model: Any) -> FaceRecognitionApp:
    """Create a fresh reference application for a recognition scenario."""

    return FaceRecognitionApp(model)


def create_clustering_adapter(model: Any) -> FaceRecognitionApp:
    """Create a fresh reference application for a clustering scenario."""

    return FaceRecognitionApp(model)
