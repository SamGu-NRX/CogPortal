"""
Example script showing how to use FaceRecognitionApp with the benchmark.
"""

import sys
import numpy as np

# Add paths for imports
sys.path.insert(0, "/face_recognition_app")
sys.path.insert(0, "/facial_recognition_benchmark")

from face_recognition import FaceRecognitionApp
from facenet_models import FacenetModel
from facial_recognition_benchmark import run_celeba_benchmark


class MockFacenetModel:
    """
    Mock FacenetModel for demonstration.
    
    Replace with real FacenetModel for actual use:
        from facenet_models import FacenetModel
        model = FacenetModel()
    """
    
    def detect(self, image: np.ndarray):
        """Mock detection - always finds one face in center."""
        h, w = image.shape[:2]
        box = [w // 4, h // 4, 3 * w // 4, 3 * h // 4]
        boxes = np.array([box])
        probabilities = np.array([0.95])
        landmarks = np.array([[w//2, h//3, w//3, 2*h//3, 2*w//3, 2*h//3, w//2, 5*h//6, w//2, h//4]])
        return boxes, probabilities, landmarks
    
    def compute_descriptors(self, image: np.ndarray, boxes: np.ndarray):
        """Mock descriptor computation."""
        if boxes is None:
            return None
        num_faces = len(boxes)
        img_hash = hash(image.tobytes()) % (2**31)
        rng = np.random.RandomState(img_hash)
        descriptors = rng.randn(num_faces, 512)
        norms = np.linalg.norm(descriptors, axis=1, keepdims=True)
        return descriptors / norms


def main():
    """Demonstrate FaceRecognitionApp usage with benchmark."""
    print("=" * 70)
    print("FACE RECOGNITION APP WITH BENCHMARK")
    print("=" * 70)
    
    # Initialize
    print("\n1. Initializing FaceRecognitionApp...")
    model = FacenetModel()
    app = FaceRecognitionApp(
        model,
        detection_threshold=0.9,
        matching_threshold=0.7
    )
    print(f"   {app}")

    # Run benchmark - pass app as the model (it has detect/compute_descriptors)
    results = run_celeba_benchmark(
        app,  # App has detect() and compute_descriptors() methods
    )

    print(results.summary())
    
    # # Create some test data
    # print("\n2. Creating test database...")
    
    # # Generate mock descriptors for different people
    # for person_name in ["Alice", "Bob", "Charlie"]:
    #     descriptors = []
    #     base_desc = np.random.randn(512)
    #     base_desc = base_desc / np.linalg.norm(base_desc)
        
    #     for _ in range(3):
    #         noise = np.random.randn(512) * 0.1
    #         desc = base_desc + noise
    #         desc = desc / np.linalg.norm(desc)
    #         descriptors.append(desc)
        
    #     app.add_descriptors_to_database(descriptors, person_name)
    #     print(f"   Added {person_name} with {len(descriptors)} descriptors")
    
    # print(f"\n   Database: {app.database.num_profiles()} profiles")
    
    # # Get database dict for benchmark
    # print("\n3. Preparing for benchmark...")
    # db_dict = app.get_database_dict()
    # print(f"   Database dict ready with {len(db_dict)} entries")
    
    # # Show how to use with benchmark
    # print("\n4. Example benchmark usage:")
    # print("""
    # from facenet_models import FacenetModel
    # from face_recognition import FaceRecognitionApp
    # from facial_recognition_benchmark import run_benchmark, run_celeba_benchmark
    
    # # Initialize
    # model = FacenetModel()
    # app = FaceRecognitionApp(model)
    
    # # Build your database
    # app.add_image_to_database("photo1.jpg", "Person1")
    # app.add_image_to_database("photo2.jpg", "Person2")
    
    # # Option 1: Run custom benchmark
    # test_config = {
    #     "face_images": ["test1.jpg", "test2.jpg"],
    #     "test_images": ["test1.jpg"],
    #     "ground_truth_labels": ["Person1"],
    #     "threshold": 0.5
    # }
    # results = run_benchmark(app, app.get_database_dict(), test_config)
    # print(results.summary())
    
    # # Option 2: Run CelebA benchmark
    # results = run_celeba_benchmark(
    #     model=app,
    #     num_images=1000,
    #     num_people=50
    # )
    # print(results.summary())
    # """)
    
    # # Demonstrate process_image (with mock)
    # print("\n5. Demonstrating process_image with mock data...")
    # mock_image = np.random.randint(0, 255, (200, 200, 3), dtype=np.uint8)
    
    # # Save mock image
    # import skimage.io as io
    # io.imwrite("test_image.jpg", mock_image)
    
    # # Process it
    # results = app.process_image("test_image.jpg")
    # print(f"   Detected {results['num_faces']} face(s)")
    # for face in results["faces"]:
    #     print(f"     Name: {face['name']}, Distance: {face['distance']:.4f}")
    
    # # Clean up
    # import os
    # if os.path.exists("test_image.jpg"):
    #     os.remove("test_image.jpg")
    
    # print("\n" + "=" * 70)
    # print("DEMONSTRATION COMPLETE")
    # print("=" * 70)


if __name__ == "__main__":
    main()
