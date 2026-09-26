"""
Example usage of the facial recognition benchmark module.

This script demonstrates how to use the benchmark to test your
facial recognition application.
"""

import numpy as np
from typing import List, Dict, Any

from facial_recognition_benchmark import run_benchmark
from facial_recognition_benchmark.utils import generate_random_descriptor, generate_test_database
from facial_recognition_benchmark.distance import cosine_distance


def create_mock_database(num_people: int = 5) -> Dict[str, Any]:
    """
    Create a mock database for testing.
    
    Parameters
    ----------
    num_people : int
        Number of people to include in database.
    
    Returns
    -------
    Dict[str, Any]
        Mock database.
    """
    return generate_test_database(num_people=num_people)


def generate_mock_test_data(
    num_face_images: int = 10,
    num_non_face_images: int = 5,
    num_people: int = 3
) -> Dict[str, Any]:
    """
    Generate mock test data for benchmarking.
    
    Parameters
    ----------
    num_face_images : int
        Number of mock face images to generate.
    num_non_face_images : int
        Number of mock non-face images to generate.
    num_people : int
        Number of different people to simulate.
    
    Returns
    -------
    Dict[str, Any]
        Mock test configuration.
    """
    config = {
        "face_images": [f"mock_face_{i}.jpg" for i in range(num_face_images)],
        "non_face_images": [f"mock_non_face_{i}.jpg" for i in range(num_non_face_images)],
        "ground_truth_num_faces": {},
        "same_person_images": [],
        "different_person_images": [],
        "test_images": [f"mock_test_{i}.jpg" for i in range(num_face_images)],
        "ground_truth_labels": [],
        "unknown_images": [f"mock_unknown_{i}.jpg" for i in range(num_non_face_images)],
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
        num_images_per_person = num_face_images // num_people
        for img_idx in range(num_images_per_person):
            # Add small random noise
            noise = np.random.randn(512) * 0.1
            descriptor = base_descriptor + noise
            descriptor = descriptor / np.linalg.norm(descriptor)
            
            all_descriptors.append(descriptor)
            all_labels.append(f"Person_{person_idx + 1}")
    
    config["cluster_descriptors"] = all_descriptors
    config["cluster_ground_truth"] = all_labels
    config["ground_truth_labels"] = all_labels[:num_face_images]
    
    return config


def demonstrate_distance_calculation():
    """Demonstrate cosine distance calculation."""
    print("\n" + "="*60)
    print("COSINE DISTANCE DEMONSTRATION")
    print("="*60)
    
    # Generate two random descriptors
    desc1 = generate_random_descriptor()
    desc2 = generate_random_descriptor()
    
    # Calculate distance
    distance = cosine_distance(desc1, desc2)
    
    print(f"Descriptor 1 shape: {desc1.shape}")
    print(f"Descriptor 2 shape: {desc2.shape}")
    print(f"Cosine distance: {distance:.4f}")
    
    # Demonstrate that identical vectors have distance 0
    distance_identical = cosine_distance(desc1, desc1)
    print(f"Distance to self: {distance_identical:.6f} (should be ~0)")
    
    return distance


def demonstrate_database_operations():
    """Demonstrate database operations."""
    print("\n" + "="*60)
    print("DATABASE OPERATIONS DEMONSTRATION")
    print("="*60)
    
    # Create mock database
    database = create_mock_database(num_people=3)
    
    print(f"Created database with {len(database)} people")
    for name, profile in database.items():
        print(f"  {name}: {len(profile['descriptors'])} descriptors")
    
    return database


def run_full_demonstration():
    """Run a full demonstration of the benchmark module."""
    print("="*60)
    print("FACIAL RECOGNITION BENCHMARK DEMONSTRATION")
    print("="*60)
    
    # Note: This demonstration uses mock data since we don't have
    # a real FacenetModel instance. In practice, you would:
    #
    # from facenet_models import FacenetModel
    # model = FacenetModel()
    
    print("\nNote: This demonstration uses mock data.")
    print("To run with real data, you need:")
    print("1. Install facenet_models: pip install facenet_models")
    print("2. Create a FacenetModel instance")
    print("3. Provide real image paths")
    
    # Demonstrate distance calculation
    demonstrate_distance_calculation()
    
    # Demonstrate database operations
    database = demonstrate_database_operations()
    
    # Generate mock test data
    print("\n" + "="*60)
    print("GENERATING MOCK TEST DATA")
    print("="*60)
    
    test_config = generate_mock_test_data(
        num_face_images=15,
        num_non_face_images=5,
        num_people=3
    )
    
    print(f"Generated {len(test_config['cluster_descriptors'])} mock descriptors")
    print(f"Generated {len(test_config['cluster_ground_truth'])} ground truth labels")
    
    # Explain how to run the benchmark with real model
    print("\n" + "="*60)
    print("HOW TO RUN THE BENCHMARK")
    print("="*60)
    
    print("""
To run the benchmark with your facial recognition application:

```python
from facenet_models import FacenetModel
from facial_recognition_benchmark import run_benchmark

# Initialize your model
model = FacenetModel()

# Prepare your database
database = {
    "Person1": {
        "name": "Person1",
        "descriptors": [descriptor1, descriptor2, ...],
        "average_descriptor": average_descriptor
    },
    # ... more people
}

# Prepare test configuration
test_config = {
    "face_images": ["path/to/face1.jpg", "path/to/face2.jpg", ...],
    "non_face_images": ["path/to/non_face1.jpg", ...],
    "test_images": ["path/to/test1.jpg", ...],
    "ground_truth_labels": ["Person1", "Person2", ...],
    "cluster_descriptors": [desc1, desc2, ...],
    "cluster_ground_truth": ["Person1", "Person2", ...],
    "threshold": 0.5
}

# Run the benchmark
results = run_benchmark(model, database, test_config)

# Print results
print(results.summary())

# Save results to JSON
results.to_json("benchmark_results.json")
```
""")
    
    print("\n" + "="*60)
    print("BENCHMARK MODULE FEATURES")
    print("="*60)
    
    print("""
The benchmark module tests:

1. FACE DETECTION
   - Detection accuracy on face images
   - False positive rejection on non-face images
   - Detection probability threshold optimization
   - Detection consistency across multiple runs

2. FACE DESCRIPTORS
   - Descriptor generation speed
   - Descriptor consistency (same person)
   - Descriptor discrimination (different people)
   - Descriptor vector properties

3. COSINE DISTANCE
   - Calculation accuracy
   - Performance with large descriptor sets
   - Threshold selection for face matching

4. DATABASE OPERATIONS
   - Profile creation and management
   - Database save/load performance
   - Search performance
   - Scalability with database size

5. FACE RECOGNITION
   - Recognition accuracy
   - Unknown face handling
   - New face addition
   - Recognition speed

6. WHISPERS CLUSTERING
   - Clustering accuracy
   - Convergence behavior
   - Weighted vs. unweighted edges
   - Clustering speed
""")
    
    print("\n" + "="*60)
    print("DEMONSTRATION COMPLETE")
    print("="*60)


if __name__ == "__main__":
    run_full_demonstration()
