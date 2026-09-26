"""
Face Recognition Application

An implementation of the CogWorks Vision Module Capstone project for
detecting and recognizing faces using FaceNet models.

This module provides:
- FaceRecognitionApp: Single class interface for easy use
- Profile class for storing face descriptors
- Database class for managing profiles
- Whispers algorithm for clustering face images

Quick Start:
    from face_recognition import FaceRecognitionApp
    from facenet_models import FacenetModel
    
    # Initialize
    model = FacenetModel()
    app = FaceRecognitionApp(model)
    
    # Process an image
    results = app.process_image("photo.jpg")
    
    # Use with benchmark
    from facial_recognition_benchmark import run_benchmark
    results = run_benchmark(app, app.get_database_dict(), test_config)
"""

from face_recognition.app import FaceRecognitionApp
from face_recognition.profile import Profile
from face_recognition.database import Database
from face_recognition.node import Node
from face_recognition.whispers import whispers, cosine_distance, create_graph

__version__ = "1.0.0"
__all__ = [
    "FaceRecognitionApp",
    "Profile",
    "Database", 
    "Node",
    "whispers",
    "cosine_distance",
    "create_graph"
]
