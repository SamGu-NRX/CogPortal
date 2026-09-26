"""
Example script that runs the benchmark with the CelebA dataset.

This script demonstrates how to use the facial recognition benchmark
with the CelebA dataset from HuggingFace Datasets.

Requirements:
    pip install datasets scikit-image
"""

import sys
import numpy as np

from facenet_models import FacenetModel

# Add paths for imports
sys.path.insert(0, "/facial_recognition_benchmark")

from facial_recognition_benchmark import run_celeba_benchmark


class MockFacenetModel:
    """
    Mock FacenetModel for demonstration purposes.
    
    In real usage, replace with:
        from facenet_models import FacenetModel
        model = FacenetModel()
    """
    
    def detect(self, image: np.ndarray):
        """
        Mock detection method.
        
        Parameters
        ----------
        image : np.ndarray
            Input image (H, W, 3).
        
        Returns
        -------
        tuple
            (boxes, probabilities, landmarks)
        """
        # Always detect one face in center of image
        h, w = image.shape[:2]
        
        # Box around center (assuming face is centered)
        box = [
            w // 4,      # x1
            h // 4,      # y1
            3 * w // 4,  # x2
            3 * h // 4   # y2
        ]
        
        boxes = np.array([box])
        probabilities = np.array([0.95])  # High confidence
        landmarks = np.array([[w//2, h//3, w//3, 2*h//3, 2*w//3, 2*h//3, w//2, 5*h//6, w//2, h//4]])
        
        return boxes, probabilities, landmarks
    
    def compute_descriptors(self, image: np.ndarray, boxes: np.ndarray):
        """
        Mock descriptor computation.
        
        Parameters
        ----------
        image : np.ndarray
            Input image.
        boxes : np.ndarray
            Bounding boxes.
        
        Returns
        -------
        np.ndarray
            Shape-(N, 512) descriptor vectors.
        """
        if boxes is None:
            return None
        
        num_faces = len(boxes)
        
        # Generate deterministic descriptor based on image content
        # This creates consistent descriptors for the same image
        img_hash = hash(image.tobytes()) % (2**31)
        rng = np.random.RandomState(img_hash)
        
        descriptors = rng.randn(num_faces, 512)
        # Normalize
        norms = np.linalg.norm(descriptors, axis=1, keepdims=True)
        descriptors = descriptors / norms
        
        return descriptors


def main():
    """Run the CelebA benchmark example."""
    print("=" * 70)
    print("FACIAL RECOGNITION BENCHMARK WITH CELEBA DATASET")
    print("=" * 70)
    
    print("""
This benchmark uses the CelebA dataset from HuggingFace Datasets.

The CelebA dataset contains:
- 202,599 face images of 10,177 celebrities
- 40 binary attribute annotations per image
- 5 facial landmark locations

Requirements:
    pip install datasets scikit-image
""")
    
    # Ask user for configuration
    print("\nConfiguration:")
    print("  - Using mock model (replace with FacenetModel for real benchmark)")
    print("  - Default: 500 images, 25 people")
    
    # Initialize model
    print("\n1. Initializing model...")
    # model = MockFacenetModel()
    model = FacenetModel()
    print("   Using mock model for demonstration")
    
    # Run benchmark with CelebA
    print("\n2. Running CelebA benchmark...")
    print("   This may take a few minutes on first run (downloading dataset)")
    
    try:
        results = run_celeba_benchmark(
            model=model,
            num_images=500,       # Number of images to use
            num_people=25,        # Number of celebrities
            images_per_person=20, # Images per celebrity
            detection_threshold=0.9,
            matching_threshold=0.5,
            celeba_cache_dir=None  # Use default HuggingFace cache
        )
        
        # Print results
        print("\n3. Benchmark Results:")
        print(results.summary())
        
        # Save results
        results_path = "/facial_recognition_benchmark/celeba_benchmark_results.json"
        results.to_json(results_path)
        print(f"\n4. Results saved to: {results_path}")
        
    except ImportError as e:
        print(f"\nError: {e}")
        print("\nPlease install required packages:")
        print("  pip install datasets scikit-image")
        return
    except Exception as e:
        print(f"\nError running benchmark: {e}")
        import traceback
        traceback.print_exc()
        return
    
    print("\n" + "=" * 70)
    print("BENCHMARK COMPLETE")
    print("=" * 70)


if __name__ == "__main__":
    main()
