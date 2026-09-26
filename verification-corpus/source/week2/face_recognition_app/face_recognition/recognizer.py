"""
FaceRecognizer class for detecting and recognizing faces.
"""

import numpy as np
import skimage.io as io
from typing import List, Tuple, Optional, Dict
from face_recognition.database import Database
from face_recognition.whispers import cosine_distance


class FaceRecognizer:
    """
    Main face recognition class that handles detection and recognition.
    
    Attributes
    ----------
    model : FacenetModel
        The face detection/description model.
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
        Initialize FaceRecognizer.
        
        Parameters
        ----------
        model : FacenetModel
            The face detection model from facenet_models.
        database : Database, optional
            Database of face profiles.
        detection_threshold : float
            Minimum probability for face detection.
        matching_threshold : float
            Maximum cosine distance for face matching.
        """
        self.model = model
        self.database = database if database is not None else Database()
        self.detection_threshold = detection_threshold
        self.matching_threshold = matching_threshold
    
    def load_image(self, image_path: str) -> np.ndarray:
        """
        Load an image from file.
        
        Parameters
        ----------
        image_path : str
            Path to image file.
        
        Returns
        -------
        np.ndarray, shape=(H, W, 3)
            RGB image array.
        """
        image = io.imread(str(image_path))
        if image.shape[-1] == 4:
            # Remove alpha channel (RGBA -> RGB)
            image = image[..., :-1]
        return image
    
    def detect_faces(self, image: np.ndarray) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[np.ndarray]]:
        """
        Detect faces in an image.
        
        Parameters
        ----------
        image : np.ndarray
            RGB image array.
        
        Returns
        -------
        Tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[np.ndarray]]
            (boxes, probabilities, landmarks) filtered by detection threshold.
        """
        boxes, probabilities, landmarks = self.model.detect(image)
        
        if boxes is None or len(boxes) == 0:
            return None, None, None
        
        # Filter by detection threshold
        if probabilities is not None:
            mask = probabilities >= self.detection_threshold
            boxes = boxes[mask]
            probabilities = probabilities[mask]
            landmarks = landmarks[mask] if landmarks is not None else None
            
            if len(boxes) == 0:
                return None, None, None
        
        return boxes, probabilities, landmarks
    
    def compute_descriptors(self, image: np.ndarray, boxes: np.ndarray) -> Optional[np.ndarray]:
        """
        Compute face descriptors for detected faces.
        
        Parameters
        ----------
        image : np.ndarray
            RGB image array.
        boxes : np.ndarray
            Bounding boxes.
        
        Returns
        -------
        Optional[np.ndarray]
            Shape-(N, 512) descriptor vectors.
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
            (name, distance) - name is None if no match found.
        """
        best_match = None
        best_distance = float('inf')
        
        for name, profile in self.database.profiles.items():
            distance = cosine_distance(descriptor, profile.average_descriptor)
            if distance < best_distance:
                best_distance = distance
                best_match = name
        
        # Check if within threshold
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
        image = self.load_image(image_path)
        boxes, probabilities, landmarks = self.detect_faces(image)
        
        results = {
            "image_path": image_path,
            "faces": [],
            "num_faces": 0
        }
        
        if boxes is None:
            return results
        
        descriptors = self.compute_descriptors(image, boxes)
        
        if descriptors is None:
            return results
        
        results["num_faces"] = len(boxes)
        
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
    
    def add_unknown_face(
        self,
        descriptor: np.ndarray,
        name: str
    ) -> None:
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
    
    def add_image_to_database(
        self,
        image_path: str,
        name: str
    ) -> bool:
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
        image = self.load_image(image_path)
        boxes, _, _ = self.detect_faces(image)
        
        if boxes is None or len(boxes) == 0:
            return False
        
        descriptors = self.compute_descriptors(image, boxes)
        
        if descriptors is None or len(descriptors) == 0:
            return False
        
        # Add first face descriptor
        self.database.add_profile(name, [descriptors[0]])
        return True
    
    def save_database(self, filepath: str) -> None:
        """Save database to file."""
        self.database.save(filepath)
    
    def load_database(self, filepath: str) -> None:
        """Load database from file."""
        self.database = Database.load(filepath)
