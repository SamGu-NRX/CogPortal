"""
Example script that runs the benchmark with the provided face images.

This script demonstrates how to use the facial recognition benchmark
with real images from the data/faces directory.
"""

import os
import sys
import numpy as np
from pathlib import Path

# Add parent directories to path for imports
sys.path.insert(0, "/face_recognition_app")
sys.path.insert(0, "/facial_recognition_benchmark")

from facenet_models import FacenetModel
from face_recognition import FaceRecognizer, Database, whispers
from facial_recognition_benchmark import run_benchmark


def get_image_paths(data_dir: str) -> dict:
    """
    Get image paths organized by person.
    
    Parameters
    ----------
    data_dir : str
        Path to data/faces directory.
    
    Returns
    -------
    dict
        Dictionary mapping person names to image paths.
    """
    image_paths = {}
    
    for person_dir in os.listdir(data_dir):
        person_path = os.path.join(data_dir, person_dir)
        if os.path.isdir(person_path):
            images = []
            for img_file in os.listdir(person_path):
                if img_file.lower().endswith(('.jpg', '.jpeg', '.png', '.bmp')):
                    images.append(os.path.join(person_path, img_file))
            if images:
                image_paths[person_dir] = images
    
    return image_paths


def build_database(recognizer: FaceRecognizer, image_paths: dict) -> None:
    """
    Build database from image paths.
    
    Parameters
    ----------
    recognizer : FaceRecognizer
        Face recognizer instance.
    image_paths : dict
        Dictionary mapping person names to image paths.
    """
    print("\nBuilding database from images...")
    
    for person_name, paths in image_paths.items():
        print(f"\n  Processing {person_name} ({len(paths)} images)...")
        
        for img_path in paths:
            try:
                success = recognizer.add_image_to_database(img_path, person_name)
                if success:
                    print(f"    Added: {os.path.basename(img_path)}")
                else:
                    print(f"    Skipped (no face detected): {os.path.basename(img_path)}")
            except Exception as e:
                print(f"    Error processing {img_path}: {e}")
    
    print(f"\nDatabase built: {recognizer.database.num_profiles()} profiles")


def run_detection_benchmark(model, image_paths: dict) -> dict:
    """
    Run face detection benchmark.
    
    Parameters
    ----------
    model : FacenetModel
        Face detection model.
    image_paths : dict
        Image paths organized by person.
    
    Returns
    -------
    dict
        Detection benchmark results.
    """
    from facial_recognition_benchmark.detection import benchmark_detection
    
    # Flatten all image paths
    all_images = []
    ground_truth_num_faces = {}
    
    for person, paths in image_paths.items():
        for path in paths:
            all_images.append(path)
            # Each individual photo should have 1 face
            if "group" not in path.lower():
                ground_truth_num_faces[path] = 1
    
    # Get group images (may have multiple faces)
    group_images = image_paths.get("group", [])
    
    print("\nRunning detection benchmark...")
    results = benchmark_detection(
        model,
        face_images=all_images,
        ground_truth_num_faces=ground_truth_num_faces
    )
    
    return results


def run_recognition_benchmark(
    recognizer: FaceRecognizer,
    image_paths: dict
) -> dict:
    """
    Run face recognition benchmark.
    
    Parameters
    ----------
    recognizer : FaceRecognizer
        Face recognizer with built database.
    image_paths : dict
        Image paths organized by person.
    
    Returns
    -------
    dict
        Recognition benchmark results.
    """
    from facial_recognition_benchmark.recognition import benchmark_face_recognition
    
    # Create test set (use some images for testing)
    test_images = []
    ground_truth_labels = []
    
    # Use last image from each person for testing
    for person, paths in image_paths.items():
        if paths and "group" not in person.lower():
            test_images.append(paths[-1])
            ground_truth_labels.append(person)
    
    print("\nRunning recognition benchmark...")
    print(f"  Test images: {len(test_images)}")
    
    # Create database dict for benchmark
    db_dict = {}
    for name, profile in recognizer.database.profiles.items():
        db_dict[name] = {
            "name": name,
            "descriptors": profile.descriptors,
            "average_descriptor": profile.average_descriptor
        }
    
    results = benchmark_face_recognition(
        recognizer.model,
        db_dict,
        test_images,
        ground_truth_labels,
        threshold=recognizer.matching_threshold
    )
    
    return results


def run_clustering_benchmark(model, image_paths: dict) -> dict:
    """
    Run Whispers clustering benchmark.
    
    Parameters
    ----------
    model : FacenetModel
        Face detection model.
    image_paths : dict
        Image paths organized by person.
    
    Returns
    -------
    dict
        Clustering benchmark results.
    """
    from facial_recognition_benchmark.whispers import benchmark_whispers_clustering
    
    # Collect all individual images (not group)
    all_images = []
    all_truths = []
    
    for person, paths in image_paths.items():
        if "group" not in person.lower():
            for path in paths:
                all_images.append(path)
                all_truths.append(person)
    
    # Generate descriptors
    print("\nGenerating descriptors for clustering...")
    descriptors = []
    valid_truths = []
    
    recognizer = FaceRecognizer(model)
    
    for img_path, truth in zip(all_images, all_truths):
        try:
            image = recognizer.load_image(img_path)
            boxes, _, _ = recognizer.detect_faces(image)
            
            if boxes is not None and len(boxes) > 0:
                desc = recognizer.compute_descriptors(image, boxes)
                if desc is not None and len(desc) > 0:
                    descriptors.append(desc[0])
                    valid_truths.append(truth)
        except Exception as e:
            print(f"  Error processing {img_path}: {e}")
    
    print(f"  Generated {len(descriptors)} descriptors")
    
    if len(descriptors) < 2:
        print("  Not enough descriptors for clustering")
        return {}
    
    print("\nRunning clustering benchmark...")
    results = benchmark_whispers_clustering(
        descriptors,
        ground_truth=valid_truths,
        threshold=0.5,
        num_runs=3,
        weighted=True
    )
    
    return results


def main():
    """Run the full benchmark example."""
    print("=" * 70)
    print("FACIAL RECOGNITION BENCHMARK WITH REAL IMAGES")
    print("=" * 70)
    
    # Data directory
    data_dir = "/face_recognition_app/face_recognition_app/data/faces"
    
    # Check if data directory exists
    if not os.path.exists(data_dir):
        print(f"\nError: Data directory not found: {data_dir}")
        return
    
    # Get image paths
    print("\n1. Scanning for images...")
    image_paths = get_image_paths(data_dir)
    
    if not image_paths:
        print("   No images found!")
        return
    
    print("   Found images:")
    for person, paths in image_paths.items():
        print(f"     {person}: {len(paths)} images")
    
    # Initialize model
    print("\n2. Initializing FaceNet model...")
    try:
        model = FacenetModel()
        print("   Model loaded successfully")
    except Exception as e:
        print(f"   Error loading model: {e}")
        return
    
    # Create recognizer
    print("\n3. Creating FaceRecognizer...")
    recognizer = FaceRecognizer(
        model,
        detection_threshold=0.9,
        matching_threshold=0.5
    )
    
    # Build database
    build_database(recognizer, image_paths)
    
    # Run benchmarks
    print("\n" + "=" * 70)
    print("RUNNING BENCHMARKS")
    print("=" * 70)
    
    # Detection benchmark
    print("\n--- Detection Benchmark ---")
    detection_results = run_detection_benchmark(model, image_paths)
    
    if detection_results.get("detection_accuracy") is not None:
        print(f"  Detection Accuracy: {detection_results['detection_accuracy']:.2%}")
    if detection_results.get("avg_detection_time") is not None:
        print(f"  Avg Detection Time: {detection_results['avg_detection_time']*1000:.2f}ms")
    
    # Recognition benchmark
    print("\n--- Recognition Benchmark ---")
    recognition_results = run_recognition_benchmark(recognizer, image_paths)
    
    if recognition_results.get("recognition_accuracy") is not None:
        print(f"  Recognition Accuracy: {recognition_results['recognition_accuracy']:.2%}")
    
    # Clustering benchmark
    print("\n--- Clustering Benchmark ---")
    clustering_results = run_clustering_benchmark(model, image_paths)
    
    if clustering_results.get("avg_num_clusters") is not None:
        print(f"  Avg Clusters Found: {clustering_results['avg_num_clusters']:.1f}")
    if clustering_results.get("avg_purity") is not None:
        print(f"  Avg Purity: {clustering_results['avg_purity']:.2%}")
    
    # Run full benchmark suite
    print("\n" + "=" * 70)
    print("RUNNING FULL BENCHMARK SUITE")
    print("=" * 70)
    
    # Prepare test config
    all_images = []
    for paths in image_paths.values():
        all_images.extend(paths)
    
    test_config = {
        "face_images": all_images,
        "non_face_images": [],
        "ground_truth_num_faces": {img: 1 for img in all_images if "group" not in img.lower()},
        "test_images": all_images,
        "ground_truth_labels": [],
        "cluster_descriptors": clustering_results.get("descriptors", []),
        "cluster_ground_truth": clustering_results.get("ground_truth", []),
        "threshold": 0.5
    }
    
    # Create database dict
    db_dict = {}
    for name, profile in recognizer.database.profiles.items():
        db_dict[name] = {
            "name": name,
            "descriptors": profile.descriptors,
            "average_descriptor": profile.average_descriptor
        }
    
    # Run full benchmark
    full_results = run_benchmark(model, db_dict, test_config)
    
    # Print summary
    print("\n" + full_results.summary())
    
    # Save results
    results_path = "/face_recognition_app/benchmark_results.json"
    full_results.to_json(results_path)
    print(f"\nResults saved to: {results_path}")
    
    print("\n" + "=" * 70)
    print("BENCHMARK COMPLETE")
    print("=" * 70)


if __name__ == "__main__":
    main()
