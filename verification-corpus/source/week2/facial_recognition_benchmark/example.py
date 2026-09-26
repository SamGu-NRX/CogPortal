"""
Example script that runs the facial recognition benchmark.

This script demonstrates how to use the benchmark module to test
a facial recognition application.
"""

import numpy as np
from typing import List, Dict, Any

from facial_recognition_benchmark import run_benchmark
from facial_recognition_benchmark.utils import generate_random_descriptor


def create_mock_database(num_people: int = 5, descriptors_per_person: int = 5) -> Dict[str, Any]:
    """
    Create a mock database for testing.
    
    Parameters
    ----------
    num_people : int
        Number of people to include in database.
    descriptors_per_person : int
        Number of descriptors per person.
    
    Returns
    -------
    Dict[str, Any]
        Mock database.
    """
    database = {}
    
    for i in range(num_people):
        name = f"Person_{i+1}"
        descriptors = []
        
        # Generate base descriptor for this person
        base_descriptor = generate_random_descriptor()
        
        # Generate similar descriptors (same person, different images)
        for _ in range(descriptors_per_person):
            noise = np.random.randn(512) * 0.1
            descriptor = base_descriptor + noise
            descriptor = descriptor / np.linalg.norm(descriptor)
            descriptors.append(descriptor)
        
        database[name] = {
            "name": name,
            "descriptors": descriptors,
            "average_descriptor": np.mean(descriptors, axis=0)
        }
    
    return database


def generate_mock_test_config(
    num_people: int = 3,
    images_per_person: int = 5
) -> Dict[str, Any]:
    """
    Generate mock test configuration.
    
    Parameters
    ----------
    num_people : int
        Number of different people to simulate.
    images_per_person : int
        Number of images per person.
    
    Returns
    -------
    Dict[str, Any]
        Mock test configuration.
    """
    config = {
        "face_images": [],
        "non_face_images": [],
        "ground_truth_num_faces": {},
        "same_person_images": [],
        "different_person_images": [],
        "test_images": [],
        "ground_truth_labels": [],
        "unknown_images": [],
        "cluster_descriptors": [],
        "cluster_ground_truth": [],
        "threshold": 0.5
    }
    
    # Generate mock descriptors for clustering
    all_descriptors = []
    all_labels = []
    
    for person_idx in range(num_people):
        # Generate base descriptor for this person
        base_descriptor = generate_random_descriptor()
        
        # Generate multiple similar descriptors for this person
        for img_idx in range(images_per_person):
            # Add small random noise
            noise = np.random.randn(512) * 0.1
            descriptor = base_descriptor + noise
            descriptor = descriptor / np.linalg.norm(descriptor)
            
            all_descriptors.append(descriptor)
            all_labels.append(f"Person_{person_idx + 1}")
            
            # Add to face images list
            config["face_images"].append(f"mock_face_p{person_idx}_i{img_idx}.jpg")
            config["test_images"].append(f"mock_test_p{person_idx}_i{img_idx}.jpg")
    
    config["cluster_descriptors"] = all_descriptors
    config["cluster_ground_truth"] = all_labels
    config["ground_truth_labels"] = all_labels
    
    # Generate non-face images
    for i in range(num_people):
        config["non_face_images"].append(f"mock_non_face_{i}.jpg")
    
    # Generate unknown images
    for i in range(num_people):
        config["unknown_images"].append(f"mock_unknown_{i}.jpg")
    
    return config


class MockFacenetModel:
    """
    Mock FacenetModel for demonstration purposes.
    
    In real usage, you would use:
        from facenet_models import FacenetModel
        model = FacenetModel()
    """
    
    def detect(self, image: np.ndarray):
        """
        Mock detection method.
        
        Parameters
        ----------
        image : np.ndarray
            Input image.
        
        Returns
        -------
        tuple
            (boxes, probabilities, landmarks)
        """
        # Generate random detection results
        num_faces = np.random.randint(0, 3)  # 0-2 faces
        
        if num_faces == 0:
            return None, None, None
        
        # Random bounding boxes
        boxes = np.random.randint(0, 100, size=(num_faces, 4))
        boxes[:, 2:] += boxes[:, :2]  # Make sure width/height are positive
        
        # Random probabilities
        probabilities = np.random.uniform(0.7, 0.99, size=num_faces)
        
        # Random landmarks
        landmarks = np.random.randint(0, 100, size=(num_faces, 5))
        
        return boxes, probabilities, landmarks
    
    def compute_descriptors(self, image: np.ndarray, boxes: np.ndarray):
        """
        Mock descriptor computation method.
        
        Parameters
        ----------
        image : np.ndarray
            Input image.
        boxes : np.ndarray
            Bounding boxes.
        
        Returns
        -------
        np.ndarray
            Descriptor vectors.
        """
        if boxes is None:
            return None
        
        num_faces = len(boxes)
        return np.random.randn(num_faces, 512)


def main():
    """Main function to run the benchmark example."""
    print("=" * 60)
    print("FACIAL RECOGNITION BENCHMARK EXAMPLE")
    print("=" * 60)
    
    # Initialize mock model (replace with real FacenetModel in production)
    print("\n1. Initializing model...")
    model = MockFacenetModel()
    print("   Using mock model for demonstration")
    
    # Create mock database
    print("\n2. Creating mock database...")
    database = create_mock_database(num_people=3, descriptors_per_person=5)
    print(f"   Created database with {len(database)} people")
    
    # Generate test configuration
    print("\n3. Generating test configuration...")
    test_config = generate_mock_test_config(num_people=3, images_per_person=5)
    print(f"   Generated {len(test_config['cluster_descriptors'])} mock descriptors")
    
    # Run benchmark
    print("\n4. Running benchmark...")
    print("   (This may take a moment)")
    
    try:
        results = run_benchmark(model, database, test_config)
        
        # Print results
        print("\n5. Benchmark Results:")
        print(results.summary())
        
        # Save results to JSON
        print("\n6. Saving results to benchmark_results.json...")
        results.to_json("benchmark_results.json")
        print("   Results saved successfully!")
        
    except Exception as e:
        print(f"\nError running benchmark: {e}")
        import traceback
        traceback.print_exc()
    
    print("\n" + "=" * 60)
    print("EXAMPLE COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    main()
