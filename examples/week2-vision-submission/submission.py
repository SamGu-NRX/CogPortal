"""Repository-root submission fixture for both Week 2 vision benchmarks."""

from face_recognition import FaceRecognitionApp


def create_submission(model):
    return FaceRecognitionApp(model)
