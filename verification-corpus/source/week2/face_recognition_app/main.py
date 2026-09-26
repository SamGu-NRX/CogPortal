"""
Example usage of the face recognition application.

This script demonstrates how to use the face_recognition module
for detecting and recognizing faces.
"""

import numpy as np
from typing import List

from face_recognition import (
    FaceRecognizer,
    Database,
    Profile,
    whispers
)
from face_recognition.whispers import cosine_distance


def demo_database_operations():
    """Demonstrate database operations."""
    print("=" * 60)
    print("DATABASE OPERATIONS DEMO")
    print("=" * 60)
    
    # Create database
    db = Database()
    print(f"Created empty database: {db}")
    
    # Add profiles with descriptors
    print("\nAdding profiles...")
    
    # Create mock descriptors (in real use, these come from face detection)
    base_desc1 = np.random.randn(512)
    base_desc1 = base_desc1 / np.linalg.norm(base_desc1)
    
    base_desc2 = np.random.randn(512)
    base_desc2 = base_desc2 / np.linalg.norm(base_desc2)
    
    # Add Person 1
    descriptors1 = []
    for _ in range(3):
        noise = np.random.randn(512) * 0.1
        desc = base_desc1 + noise
        desc = desc / np.linalg.norm(desc)
        descriptors1.append(desc)
    
    db.add_profile("Alice", descriptors1)
    print(f"  Added Alice with {len(descriptors1)} descriptors")
    
    # Add Person 2
    descriptors2 = []
    for _ in range(3):
        noise = np.random.randn(512) * 0.1
        desc = base_desc2 + noise
        desc = desc / np.linalg.norm(desc)
        descriptors2.append(desc)
    
    db.add_profile("Bob", descriptors2)
    print(f"  Added Bob with {len(descriptors2)} descriptors")
    
    # List profiles
    print(f"\nDatabase now has {db.num_profiles()} profiles:")
    for name in db.get_all_names():
        profile = db.get_profile(name)
        print(f"  - {name}: {profile.num_descriptors()} descriptors")
    
    # Save and load database
    print("\nSaving database...")
    db.save("test_database.pkl")
    print("  Saved to test_database.pkl")
    
    print("Loading database...")
    db_loaded = Database.load("test_database.pkl")
    print(f"  Loaded: {db_loaded}")
    
    return db


def demo_face_recognition():
    """Demonstrate face recognition (with mock model)."""
    print("\n" + "=" * 60)
    print("FACE RECOGNITION DEMO")
    print("=" * 60)
    
    # Create mock model (replace with real FacenetModel)
    class MockModel:
        def detect(self, image):
            # Return mock detection
            boxes = np.array([[10, 10, 100, 100]])
            probs = np.array([0.95])
            landmarks = np.array([[50, 50, 50, 50, 50]])
            return boxes, probs, landmarks
        
        def compute_descriptors(self, image, boxes):
            # Return mock descriptor
            return np.random.randn(len(boxes), 512)
    
    model = MockModel()
    
    # Create recognizer
    recognizer = FaceRecognizer(model)
    print("Created FaceRecognizer with mock model")
    
    # Create and save a database
    print("\nSetting up database...")
    
    # Create mock descriptors for database
    base_desc = np.random.randn(512)
    base_desc = base_desc / np.linalg.norm(base_desc)
    
    for name in ["Alice", "Bob", "Charlie"]:
        descriptors = []
        for _ in range(3):
            noise = np.random.randn(512) * 0.1
            desc = base_desc + noise
            desc = desc / np.linalg.norm(desc)
            descriptors.append(desc)
        
        recognizer.database.add_profile(name, descriptors)
        print(f"  Added {name}")
    
    # Process a mock image
    print("\nProcessing mock image...")
    mock_image = np.random.randint(0, 255, (200, 200, 3), dtype=np.uint8)
    
    # Save mock image temporarily
    import skimage.io as io
    io.imwrite("test_image.jpg", mock_image)
    
    results = recognizer.process_image("test_image.jpg")
    print(f"  Found {results['num_faces']} face(s)")
    
    for i, face in enumerate(results["faces"]):
        print(f"  Face {i+1}:")
        print(f"    Name: {face['name']}")
        print(f"    Probability: {face['probability']:.2%}")
        print(f"    Distance: {face['distance']:.4f}")


def demo_whispers_clustering():
    """Demonstrate Whispers clustering algorithm."""
    print("\n" + "=" * 60)
    print("WHISPERS CLUSTERING DEMO")
    print("=" * 60)
    
    # Generate clustered descriptors
    print("Generating mock face descriptors...")
    
    descriptors = []
    truths = []
    
    # Create 3 clusters of similar descriptors
    for cluster_idx in range(3):
        base = np.random.randn(512)
        base = base / np.linalg.norm(base)
        
        for i in range(4):  # 4 images per cluster
            noise = np.random.randn(512) * 0.05
            desc = base + noise
            desc = desc / np.linalg.norm(desc)
            descriptors.append(desc)
            truths.append(f"Person_{cluster_idx + 1}")
    
    print(f"  Generated {len(descriptors)} descriptors for 3 people")
    
    # Run Whispers algorithm
    print("\nRunning Whispers algorithm...")
    results = whispers(
        descriptors,
        threshold=0.3,
        weighted=True,
        truths=truths
    )
    
    print(f"  Converged: {results['converged']}")
    print(f"  Iterations: {results['iterations']}")
    print(f"  Clusters found: {results['num_clusters']}")
    
    # Show clustering results
    print("\nClustering results:")
    for cluster_label, node_ids in results["clusters"].items():
        print(f"  Cluster {cluster_label}: {len(node_ids)} images")
        
        # Check purity
        cluster_truths = [truths[i] for i in node_ids]
        unique_truths = set(cluster_truths)
        print(f"    True labels: {unique_truths}")


def demo_cosine_distance():
    """Demonstrate cosine distance calculation."""
    print("\n" + "=" * 60)
    print("COSINE DISTANCE DEMO")
    print("=" * 60)
    
    # Create test vectors
    v1 = np.random.randn(512)
    v1 = v1 / np.linalg.norm(v1)
    
    v2 = v1 + np.random.randn(512) * 0.1  # Similar vector
    v2 = v2 / np.linalg.norm(v2)
    
    v3 = np.random.randn(512)  # Different vector
    v3 = v3 / np.linalg.norm(v3)
    
    # Calculate distances
    dist_same = cosine_distance(v1, v1)
    dist_similar = cosine_distance(v1, v2)
    dist_different = cosine_distance(v1, v3)
    
    print(f"Distance to self: {dist_same:.6f} (should be ~0)")
    print(f"Distance to similar: {dist_similar:.4f} (should be small)")
    print(f"Distance to different: {dist_different:.4f} (should be larger)")


def main():
    """Run all demonstrations."""
    print("=" * 60)
    print("FACE RECOGNITION APPLICATION DEMO")
    print("=" * 60)
    
    # Run demos
    demo_cosine_distance()
    demo_database_operations()
    demo_face_recognition()
    demo_whispers_clustering()
    
    print("\n" + "=" * 60)
    print("DEMO COMPLETE")
    print("=" * 60)
    
    # Clean up
    import os
    for f in ["test_database.pkl", "test_image.jpg"]:
        if os.path.exists(f):
            os.remove(f)


if __name__ == "__main__":
    main()
