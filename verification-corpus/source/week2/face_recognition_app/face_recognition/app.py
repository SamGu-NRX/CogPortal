"""
Face Recognition Application - Single Class Interface

A unified class that implements the facial recognition application
described in the CogWorks Vision Module Capstone project.

This class can be directly used with the facial_recognition_benchmark.

Usage:
    from face_recognition import FaceRecognitionApp

    # Initialize with a FacenetModel
    from facenet_models import FacenetModel
    model = FacenetModel()
    app = FaceRecognitionApp(model)

    # Or use with custom thresholds
    app = FaceRecognitionApp(
        model,
        detection_threshold=0.9,
        matching_threshold=0.7
    )

    # Process an image
    results = app.process_image("photo.jpg")

    # The app can be used directly with the benchmark
    from facial_recognition_benchmark import run_benchmark
    results = run_benchmark(app, database, test_config)
"""

import numpy as np
from typing import List, Tuple, Optional, Dict, Any
import pickle
import os

from face_recognition.profile import Profile
from face_recognition.database import Database
from face_recognition.whispers import cosine_distance, whispers as whispers_algorithm


class FaceRecognitionApp:
    """
    Unified face recognition application class.

    This class provides a simple interface for face detection, recognition,
    and clustering. It can be used directly with the facial recognition benchmark.

    Attributes
    ----------
    model : FacenetModel
        The underlying face detection/description model.
    database : Database
        Database of face profiles.
    detection_threshold : float
        Minimum probability for face detection.
    matching_threshold : float
        Maximum cosine distance for face matching.
    """

    def __init__(
        self,
        model,
        database: Optional[Database] = None,
        detection_threshold: float = 0.9,
        matching_threshold: float = 0.7
    ):
        """
        Initialize FaceRecognitionApp.

        Parameters
        ----------
        model : FacenetModel
            The face detection model (from facenet_models).
        database : Database, optional
            Database of face profiles. If None, creates empty database.
        detection_threshold : float
            Minimum probability for face detection.
        matching_threshold : float
            Maximum cosine distance for face matching.
        """
        self.model = model
        self.database = database if database is not None else Database()
        self.detection_threshold = detection_threshold
        self.matching_threshold = matching_threshold

    def detect(self, image: np.ndarray) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[np.ndarray]]:
        """
        Detect faces in an image.

        This method provides the same interface as FacenetModel.detect()
        but applies the detection threshold.

        Parameters
        ----------
        image : np.ndarray, shape=(H, W, 3)
            RGB image array.

        Returns
        -------
        Tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[np.ndarray]]
            (boxes, probabilities, landmarks) filtered by detection threshold.
            Returns (None, None, None) if no faces detected above threshold.
        """
        boxes, probabilities, landmarks = self.model.detect(image)

        if boxes is None or len(boxes) == 0:
            return None, None, None

        # Filter by detection threshold
        if probabilities is not None:
            mask = probabilities >= self.detection_threshold
            boxes = boxes[mask]
            probabilities = probabilities[mask]
            if landmarks is not None:
                landmarks = landmarks[mask]

            if len(boxes) == 0:
                return None, None, None

        return boxes, probabilities, landmarks

    def compute_descriptors(self, image: np.ndarray, boxes: np.ndarray) -> Optional[np.ndarray]:
        """
        Compute face descriptors for detected faces.

        This method provides the same interface as FacenetModel.compute_descriptors().

        Parameters
        ----------
        image : np.ndarray, shape=(H, W, 3)
            RGB image array.
        boxes : np.ndarray, shape=(N, 4)
            Bounding boxes containing faces.

        Returns
        -------
        Optional[np.ndarray]
            Shape-(N, 512) descriptor vectors, or None if no faces.
        """
        if boxes is None or len(boxes) == 0:
            return None

        return self.model.compute_descriptors(image, boxes)

    def recognize_face(self, descriptor: np.ndarray) -> Tuple[Optional[str], float]:
        """
        Recognize a face by comparing descriptor to database.

        Parameters
        ----------
        descriptor : np.ndarray, shape=(512,)
            Face descriptor to identify.

        Returns
        -------
        Tuple[Optional[str], float]
            (name, distance) - name is None if no match found within threshold.
        """
        best_match = None
        best_distance = float('inf')

        for name, profile in self.database.profiles.items():
            distance = cosine_distance(descriptor, profile.average_descriptor)
            if distance < best_distance:
                best_distance = distance
                best_match = name

        if best_distance <= self.matching_threshold:
            return best_match, best_distance

        return None, best_distance

    def process_image(self, image_path: str) -> Dict:
        """
        Process an image: detect faces and recognize them.

        Parameters
        ----------
        image_path : str
            Path to image file.

        Returns
        -------
        Dict
            Results containing detected faces with labels.
        """
        import skimage.io as io

        # Load image
        image = io.imread(str(image_path))
        if image.shape[-1] == 4:
            image = image[..., :-1]

        # Detect faces
        boxes, probabilities, landmarks = self.detect(image)

        results = {
            "image_path": image_path,
            "faces": [],
            "num_faces": 0
        }

        if boxes is None:
            return results

        # Compute descriptors
        descriptors = self.compute_descriptors(image, boxes)

        if descriptors is None:
            return results

        results["num_faces"] = len(boxes)

        # Recognize each face
        for i, (box, prob, desc) in enumerate(zip(boxes, probabilities, descriptors)):
            name, distance = self.recognize_face(desc)

            face_result = {
                "box": box.tolist(),
                "probability": float(prob),
                "name": name if name else "Unknown",
                "distance": distance,
                "descriptor": desc
            }
            results["faces"].append(face_result)

        return results

    def add_unknown_face(self, descriptor: np.ndarray, name: str) -> None:
        """
        Add an unknown face to the database.

        Parameters
        ----------
        descriptor : np.ndarray
            Face descriptor.
        name : str
            Name for this person.
        """
        self.database.add_profile(name, [descriptor])

    def add_image_to_database(self, image_path: str, name: str) -> bool:
        """
        Add a face from an image to the database.

        Parameters
        ----------
        image_path : str
            Path to image file.
        name : str
            Name for this person.

        Returns
        -------
        bool
            True if face was added successfully.
        """
        import skimage.io as io

        # Load image
        image = io.imread(str(image_path))
        if image.shape[-1] == 4:
            image = image[..., :-1]

        # Detect faces
        boxes, _, _ = self.detect(image)

        if boxes is None or len(boxes) == 0:
            return False

        # Compute descriptors
        descriptors = self.compute_descriptors(image, boxes)

        if descriptors is None or len(descriptors) == 0:
            return False

        # Add first face descriptor
        self.database.add_profile(name, [descriptors[0]])
        return True

    def add_descriptors_to_database(self, descriptors: List[np.ndarray], name: str) -> None:
        """
        Add multiple descriptors to the database for a person.

        Parameters
        ----------
        descriptors : List[np.ndarray]
            List of face descriptors.
        name : str
            Name for this person.
        """
        self.database.add_profile(name, descriptors)

    def cluster_images(
        self,
        images: List[np.ndarray],
        threshold: float = None,
        weighted: bool = True
    ) -> Dict:
        """
        Cluster images using Whispers algorithm.

        Parameters
        ----------
        images : List[np.ndarray]
            List of RGB images.
        threshold : float, optional
            Maximum cosine distance for edge. Uses matching_threshold if None.
        weighted : bool
            Whether to use weighted edges.

        Returns
        -------
        Dict
            Clustering results.
        """
        if threshold is None:
            threshold = self.matching_threshold

        # Generate descriptors for all images
        descriptors = []
        valid_indices = []

        for i, image in enumerate(images):
            try:
                boxes, _, _ = self.detect(image)
                if boxes is not None and len(boxes) > 0:
                    desc = self.compute_descriptors(image, boxes)
                    if desc is not None and len(desc) > 0:
                        descriptors.append(desc[0])
                        valid_indices.append(i)
            except Exception:
                continue

        if len(descriptors) < 2:
            return {
                "num_clusters": 0,
                "clusters": {},
                "labels": [],
                "converged": False
            }

        # Run Whispers algorithm
        results = whispers_algorithm(
            descriptors,
            threshold=threshold,
            weighted=weighted
        )

        # Map back to original image indices
        results["valid_indices"] = valid_indices

        return results

    def save_database(self, filepath: str) -> None:
        """Save database to file."""
        self.database.save(filepath)

    def load_database(self, filepath: str) -> None:
        """Load database from file."""
        self.database = Database.load(filepath)

    def get_database_dict(self) -> Dict[str, Any]:
        """
        Get database as dictionary for use with benchmark.

        Returns
        -------
        Dict[str, Any]
            Database dictionary mapping names to profiles.
        """
        db_dict = {}
        for name, profile in self.database.profiles.items():
            db_dict[name] = {
                "name": name,
                "descriptors": profile.descriptors,
                "average_descriptor": profile.average_descriptor
            }
        return db_dict

    def __repr__(self) -> str:
        return (
            f"FaceRecognitionApp("
            f"database_profiles={self.database.num_profiles()}, "
            f"detection_threshold={self.detection_threshold}, "
            f"matching_threshold={self.matching_threshold})"
        )
