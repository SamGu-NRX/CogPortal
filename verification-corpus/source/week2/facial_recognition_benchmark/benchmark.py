"""
Main Benchmark Runner Module

Provides the main benchmark runner that orchestrates all benchmark tests
and generates comprehensive reports.
"""
import traceback
import numpy as np
import time
import json
from typing import List, Dict, Any, Optional, Callable
from dataclasses import dataclass, asdict
from datetime import datetime

from facial_recognition_benchmark.detection import (
    benchmark_detection,
    benchmark_detection_probability_threshold,
    benchmark_detection_consistency
)
from facial_recognition_benchmark.descriptors import (
    benchmark_descriptor_generation,
    benchmark_descriptor_consistency,
    benchmark_descriptor_properties
)
from facial_recognition_benchmark.distance import (
    benchmark_cosine_distance_accuracy,
    benchmark_cosine_distance_performance,
    benchmark_cosine_distance_threshold
)
from facial_recognition_benchmark.database import (
    benchmark_database_operations,
    benchmark_database_search,
    benchmark_database_scalability
)
from facial_recognition_benchmark.recognition import (
    benchmark_face_recognition,
    benchmark_unknown_handling,
    benchmark_new_face_addition
)
from facial_recognition_benchmark.whispers import (
    benchmark_whispers_clustering,
    whispers
)


@dataclass
class BenchmarkResult:
    """Container for benchmark results."""
    timestamp: str
    model_info: Dict[str, Any]
    detection_results: Dict[str, Any]
    descriptor_results: Dict[str, Any]
    distance_results: Dict[str, Any]
    database_results: Dict[str, Any]
    recognition_results: Dict[str, Any]
    whispers_results: Dict[str, Any]
    overall_score: float
    recommendations: List[str]
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)
    
    def to_json(self, filepath: str) -> None:
        """Save results to JSON file."""
        with open(filepath, 'w') as f:
            json.dump(self.to_dict(), f, indent=2, default=str)
    
    def summary(self) -> str:
        """Generate human-readable summary."""
        lines = [
            "=" * 60,
            "FACIAL RECOGNITION BENCHMARK RESULTS",
            "=" * 60,
            f"Timestamp: {self.timestamp}",
            "",
            "DETECTION PERFORMANCE",
            "-" * 40,
        ]
        
        if self.detection_results.get("detection_accuracy") is not None:
            lines.append(f"  Detection Accuracy: {self.detection_results['detection_accuracy']:.2%}")
        
        if self.detection_results.get("false_positive_rate") is not None:
            lines.append(f"  False Positive Rate: {self.detection_results['false_positive_rate']:.2%}")
        
        if self.detection_results.get("avg_detection_time") is not None:
            lines.append(f"  Avg Detection Time: {self.detection_results['avg_detection_time']*1000:.2f}ms")
        
        lines.extend([
            "",
            "DESCRIPTOR PERFORMANCE",
            "-" * 40,
        ])
        
        if self.descriptor_results.get("avg_generation_time") is not None:
            lines.append(f"  Avg Generation Time: {self.descriptor_results['avg_generation_time']*1000:.2f}ms")
        
        if self.descriptor_results.get("descriptors_generated") is not None:
            lines.append(f"  Descriptors Generated: {self.descriptor_results['descriptors_generated']}")
        
        lines.extend([
            "",
            "DISTANCE CALCULATION",
            "-" * 40,
        ])
        
        if self.distance_results.get("max_error") is not None:
            lines.append(f"  Max Calculation Error: {self.distance_results['max_error']:.6f}")
        
        if self.distance_results.get("all_passed") is not None:
            lines.append(f"  All Tests Passed: {'Yes' if self.distance_results['all_passed'] else 'No'}")
        
        lines.extend([
            "",
            "DATABASE OPERATIONS",
            "-" * 40,
        ])
        
        if self.database_results.get("database_save_time") is not None:
            lines.append(f"  Database Save Time: {self.database_results['database_save_time']*1000:.2f}ms")
        
        if self.database_results.get("database_load_time") is not None:
            lines.append(f"  Database Load Time: {self.database_results['database_load_time']*1000:.2f}ms")
        
        lines.extend([
            "",
            "FACE RECOGNITION",
            "-" * 40,
        ])
        
        if self.recognition_results.get("recognition_accuracy") is not None:
            lines.append(f"  Recognition Accuracy: {self.recognition_results['recognition_accuracy']:.2%}")
        
        if self.recognition_results.get("unknown_detection_rate") is not None:
            lines.append(f"  Unknown Detection Rate: {self.recognition_results['unknown_detection_rate']:.2%}")
        
        lines.extend([
            "",
            "WHISPERS CLUSTERING",
            "-" * 40,
        ])
        
        if self.whispers_results.get("avg_num_clusters") is not None:
            lines.append(f"  Avg Clusters Found: {self.whispers_results['avg_num_clusters']:.1f}")
        
        if self.whispers_results.get("convergence_rate") is not None:
            lines.append(f"  Convergence Rate: {self.whispers_results['convergence_rate']:.2%}")
        
        if self.whispers_results.get("avg_purity") is not None:
            lines.append(f"  Avg Purity: {self.whispers_results['avg_purity']:.2%}")
        
        lines.extend([
            "",
            "OVERALL SCORE",
            "-" * 40,
            f"  Score: {self.overall_score:.2%}",
            "",
            "RECOMMENDATIONS",
            "-" * 40,
        ])
        
        for i, rec in enumerate(self.recommendations, 1):
            lines.append(f"  {i}. {rec}")
        
        lines.extend([
            "",
            "=" * 60,
        ])
        
        return "\n".join(lines)


def run_benchmark(
    model,
    database: Optional[Dict[str, Any]] = None,
    test_config: Optional[Dict[str, Any]] = None
) -> BenchmarkResult:
    """
    Run comprehensive benchmark suite.
    
    Parameters
    ----------
    model : FacenetModel
        The face detection model to benchmark.
    database : Dict[str, Any], optional
        Database of face profiles for recognition testing.
    test_config : Dict[str, Any], optional
        Configuration for benchmark tests.
    
    Returns
    -------
    BenchmarkResult
        Comprehensive benchmark results.
    """
    # Default test configuration
    if test_config is None:
        test_config = {
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
    
    # Initialize results
    results = {
        "timestamp": datetime.now().isoformat(),
        "model_info": {"model_type": type(model).__name__},
        "detection_results": {},
        "descriptor_results": {},
        "distance_results": {},
        "database_results": {},
        "recognition_results": {},
        "whispers_results": {}
    }
    
    recommendations = []
    
    # 1. Detection Benchmark
    print("Running detection benchmark...")
    if test_config.get("face_images"):
        results["detection_results"] = benchmark_detection(
            model,
            test_config["face_images"],
            test_config.get("non_face_images"),
            # Keyword is required: the 4th positional slot used to be the unused
            # ground_truth_boxes, which silently left detection_accuracy None.
            ground_truth_num_faces=test_config.get("ground_truth_num_faces")
        )
        
        # Check detection accuracy
        if results["detection_results"].get("detection_accuracy") is not None:
            if results["detection_results"]["detection_accuracy"] < 0.9:
                recommendations.append(
                    "Detection accuracy is below 90%. Consider adjusting detection parameters."
                )
        
        # Check false positive rate
        if results["detection_results"].get("false_positive_rate") is not None:
            if results["detection_results"]["false_positive_rate"] > 0.1:
                recommendations.append(
                    "False positive rate is above 10%. Consider increasing detection threshold."
                )
    
    # 2. Descriptor Benchmark
    print("Running descriptor benchmark...")
    if test_config.get("face_images"):
        results["descriptor_results"] = benchmark_descriptor_generation(
            model,
            test_config["face_images"]
        )
        
        # Check descriptor generation time
        if results["descriptor_results"].get("avg_generation_time") is not None:
            if results["descriptor_results"]["avg_generation_time"] > 0.1:  # 100ms
                recommendations.append(
                    "Descriptor generation is slow. Consider using GPU acceleration."
                )
    
    # 3. Distance Benchmark
    print("Running distance benchmark...")
    results["distance_results"] = benchmark_cosine_distance_accuracy()
    
    if not results["distance_results"].get("all_passed"):
        recommendations.append(
            "Cosine distance calculation has accuracy issues. Check implementation."
        )
    
    # 4. Database Benchmark
    print("Running database benchmark...")
    results["database_results"] = benchmark_database_operations()
    
    if results["database_results"].get("database_save_time") is not None:
        if results["database_results"]["database_save_time"] > 0.1:  # 100ms
            recommendations.append(
                "Database save is slow. Consider optimizing serialization."
            )
    
    # 5. Recognition Benchmark
    print("Running recognition benchmark...")
    if database and test_config.get("test_images"):
        results["recognition_results"] = benchmark_face_recognition(
            model,
            database,
            test_config["test_images"],
            test_config.get("ground_truth_labels"),
            test_config.get("threshold", 0.5)
        )
        
        if results["recognition_results"].get("recognition_accuracy") is not None:
            if results["recognition_results"]["recognition_accuracy"] < 0.85:
                recommendations.append(
                    "Recognition accuracy is below 85%. Consider adjusting threshold or improving database."
                )
    
    # 6. Whispers Benchmark
    print("Running whispers benchmark...")
    if test_config.get("cluster_descriptors"):
        results["whispers_results"] = benchmark_whispers_clustering(
            test_config["cluster_descriptors"],
            test_config.get("cluster_ground_truth"),
            test_config.get("threshold", 0.5),
            num_runs=3
        )
        
        if results["whispers_results"].get("convergence_rate") is not None:
            if results["whispers_results"]["convergence_rate"] < 0.8:
                recommendations.append(
                    "Whispers algorithm convergence rate is low. Consider adjusting threshold."
                )
    
    # Calculate overall score
    overall_score = calculate_overall_score(results)
    
    if not recommendations:
        recommendations.append("All benchmarks passed. System is performing well.")
    
    return BenchmarkResult(
        timestamp=results["timestamp"],
        model_info=results["model_info"],
        detection_results=results["detection_results"],
        descriptor_results=results["descriptor_results"],
        distance_results=results["distance_results"],
        database_results=results["database_results"],
        recognition_results=results["recognition_results"],
        whispers_results=results["whispers_results"],
        overall_score=overall_score,
        recommendations=recommendations
    )


def run_celeba_benchmark(
    model,
    num_images: int = 1000,
    num_people: int = 50,
    images_per_person: int = 20,
    detection_threshold: float = 0.9,
    matching_threshold: float = 0.5,
    celeba_cache_dir: str = None
) -> BenchmarkResult:
    """
    Run benchmark using CelebA dataset from HuggingFace.
    
    Parameters
    ----------
    model : FacenetModel
        The face detection model to benchmark.
    num_images : int
        Total number of images to load from CelebA.
    num_people : int
        Number of distinct celebrities to use.
    images_per_person : int
        Target number of images per person.
    detection_threshold : float
        Minimum probability for face detection.
    matching_threshold : float
        Maximum cosine distance for face matching.
    celeba_cache_dir : str, optional
        Directory to cache HuggingFace dataset.
    
    Returns
    -------
    BenchmarkResult
        Comprehensive benchmark results using CelebA dataset.
    """
    from facial_recognition_benchmark.celeba_dataset import (
        load_celeba_dataset,
        prepare_benchmark_data,
        sample_images_for_detection,
        sample_images_for_clustering
    )
    from facial_recognition_benchmark.utils import cosine_distance
    
    print("=" * 60)
    print("CELEBA DATASET BENCHMARK")
    print("=" * 60)
    
    # Load CelebA dataset from HuggingFace
    print("\n1. Loading CelebA dataset from HuggingFace...")
    celeba_data = load_celeba_dataset(
        num_images=num_images,
        num_people=num_people,
        images_per_person=images_per_person,
        cache_dir=celeba_cache_dir
    )
    
    # Prepare benchmark data
    print("\n2. Preparing benchmark data...")
    benchmark_data = prepare_benchmark_data(
        celeba_data,
        num_test_images_per_person=3,
        num_database_images_per_person=5
    )
    
    # Build database from CelebA images
    print("\n3. Building database from CelebA images...")
    database = {}
    
    # Group database images by identity
    db_by_identity = {}
    for img, identity in zip(benchmark_data["database_images"], 
                             benchmark_data["database_identities"]):
        if identity not in db_by_identity:
            db_by_identity[identity] = []
        db_by_identity[identity].append(img)
    
    # Generate descriptors for database
    for identity, images in db_by_identity.items():
        descriptors = []
        for img in images[:5]:  # Limit to 5 images per person
            try:
                boxes, probs, _ = model.detect(img)
                if boxes is not None and len(boxes) > 0:
                    # Use highest probability face
                    best_idx = np.argmax(probs)
                    desc = model.compute_descriptors(img, boxes[best_idx:best_idx+1])
                    if desc is not None and len(desc) > 0:
                        descriptors.append(desc[0])
            except Exception as e:
                print(e)
                print(traceback.format_exc())
                exit(1)
        
        if descriptors:
            name = benchmark_data["identity_names"].get(identity, f"Person_{identity}")
            database[name] = {
                "name": name,
                "descriptors": descriptors,
                "average_descriptor": np.mean(descriptors, axis=0)
            }
    
    print(f"   Built database with {len(database)} profiles")
    
    # Run detection benchmark
    print("\n4. Running detection benchmark...")
    detection_images = sample_images_for_detection(celeba_data, num_samples=100)
    
    # Save images temporarily for detection benchmark
    import tempfile
    import os
    from skimage.io import imsave
    
    temp_dir = tempfile.mkdtemp()
    temp_paths = []
    
    for i, img in enumerate(detection_images[:50]):  # Limit for speed
        path = os.path.join(temp_dir, f"face_{i}.jpg")
        imsave(path, img)
        temp_paths.append(path)
    
    try:
        from facial_recognition_benchmark.detection import benchmark_detection
        
        detection_results = benchmark_detection(
            model,
            face_images=temp_paths,
            ground_truth_num_faces={p: 1 for p in temp_paths}
        )
    finally:
        # Clean up temp files
        for path in temp_paths:
            if os.path.exists(path):
                os.remove(path)
        if os.path.exists(temp_dir):
            os.rmdir(temp_dir)
    
    # Run distance benchmark
    print("\n5. Running distance benchmark...")
    from facial_recognition_benchmark.distance import benchmark_cosine_distance_accuracy
    distance_results = benchmark_cosine_distance_accuracy()
    
    # Run database benchmark
    print("\n6. Running database benchmark...")
    from facial_recognition_benchmark.database import benchmark_database_operations
    database_results = benchmark_database_operations()
    
    # Run recognition benchmark
    print("\n7. Running recognition benchmark...")
    
    # Generate descriptors for test images
    test_descriptors = []
    test_labels = []
    
    for img, identity in zip(benchmark_data["test_images"][:30],  # Limit for speed
                             benchmark_data["test_identities"][:30]):
        try:
            boxes, probs, _ = model.detect(img)
            if boxes is not None and len(boxes) > 0:
                best_idx = np.argmax(probs)
                desc = model.compute_descriptors(img, boxes[best_idx:best_idx+1])
                if desc is not None and len(desc) > 0:
                    test_descriptors.append(desc[0])
                    name = benchmark_data["identity_names"].get(identity, f"Person_{identity}")
                    test_labels.append(name)
        except Exception as error:
            print(error)
            print(traceback.format_exc())
            exit(1)
    
    # Calculate recognition accuracy
    correct = 0
    total = 0
    
    for desc, true_label in zip(test_descriptors, test_labels):
        best_match = None
        best_distance = float('inf')
        
        for name, profile in database.items():
            distance = cosine_distance(desc, profile["average_descriptor"])
            if distance < best_distance:
                best_distance = distance
                best_match = name
        
        if best_distance <= matching_threshold:
            predicted = best_match
        else:
            predicted = "Unknown"
        
        if predicted == true_label:
            correct += 1
        total += 1
    
    recognition_accuracy = correct / total if total > 0 else 0.0
    
    recognition_results = {
        "recognition_accuracy": recognition_accuracy,
        "true_positives": correct,
        "total_tested": total,
        "matching_threshold": matching_threshold
    }
    
    print(f"   Recognition accuracy: {recognition_accuracy:.2%}")
    
    # Run clustering benchmark
    print("\n8. Running clustering benchmark...")
    cluster_images, cluster_labels = sample_images_for_clustering(
        celeba_data,
        num_people=min(10, num_people),
        images_per_person=min(5, images_per_person)
    )
    
    # Generate descriptors for clustering
    cluster_descriptors = []
    cluster_true_labels = []
    
    for img, label in zip(cluster_images, cluster_labels):
        try:
            boxes, probs, _ = model.detect(img)
            if boxes is not None and len(boxes) > 0:
                best_idx = np.argmax(probs)
                desc = model.compute_descriptors(img, boxes[best_idx:best_idx+1])
                if desc is not None and len(desc) > 0:
                    cluster_descriptors.append(desc[0])
                    cluster_true_labels.append(label)
        except Exception as error:
            print(error)
            print(traceback.format_exc())
            exit(1)
    
    if len(cluster_descriptors) >= 2:
        from facial_recognition_benchmark.whispers import benchmark_whispers_clustering
        
        whispers_results = benchmark_whispers_clustering(
            cluster_descriptors,
            ground_truth=cluster_true_labels,
            threshold=matching_threshold,
            num_runs=3,
            weighted=True
        )
    else:
        whispers_results = {"avg_num_clusters": 0, "convergence_rate": 0}
    
    # Compile all results
    print("\n9. Compiling results...")
    
    results = {
        "timestamp": datetime.now().isoformat(),
        "model_info": {"model_type": type(model).__name__},
        "dataset_info": {
            "name": "CelebA",
            "num_images": celeba_data["num_images"],
            "num_identities": celeba_data["num_identities"]
        },
        "detection_results": detection_results,
        "descriptor_results": {
            "descriptors_generated": len(cluster_descriptors),
            "avg_generation_time": None  # Would need timing
        },
        "distance_results": distance_results,
        "database_results": database_results,
        "recognition_results": recognition_results,
        "whispers_results": whispers_results
    }
    
    # Calculate overall score
    overall_score = calculate_overall_score(results)
    
    recommendations = []
    
    if detection_results.get("detection_accuracy") is not None:
        if detection_results["detection_accuracy"] < 0.9:
            recommendations.append("Detection accuracy is below 90%.")
    
    if recognition_accuracy < 0.85:
        recommendations.append("Recognition accuracy is below 85%.")
    
    if whispers_results.get("convergence_rate") is not None:
        if whispers_results["convergence_rate"] < 0.8:
            recommendations.append("Whispers convergence rate is low.")
    
    if not recommendations:
        recommendations.append("All benchmarks passed. System is performing well.")
    
    return BenchmarkResult(
        timestamp=results["timestamp"],
        model_info=results["model_info"],
        detection_results=results["detection_results"],
        descriptor_results=results["descriptor_results"],
        distance_results=results["distance_results"],
        database_results=results["database_results"],
        recognition_results=results["recognition_results"],
        whispers_results=results["whispers_results"],
        overall_score=overall_score,
        recommendations=recommendations
    )


def calculate_overall_score(results: Dict[str, Any]) -> float:
    """
    Calculate overall benchmark score.
    
    Parameters
    ----------
    results : Dict[str, Any]
        Benchmark results.
    
    Returns
    -------
    float
        Overall score between 0 and 1.
    """
    scores = []
    weights = []
    
    # Detection score (weight: 0.2)
    if results["detection_results"].get("detection_accuracy") is not None:
        scores.append(results["detection_results"]["detection_accuracy"])
        weights.append(0.2)
    
    # Descriptor score (weight: 0.15)
    if results["descriptor_results"].get("avg_generation_time") is not None:
        # Normalize: 0-100ms -> 1.0, >200ms -> 0.0
        gen_time = results["descriptor_results"]["avg_generation_time"]
        # Clamp both ends: the docstring promises a 0..1 score, and a very fast
        # generation time (< 50ms) made this exceed 1 and print overall > 100%.
        desc_score = min(1, max(0, 1 - (gen_time - 0.05) / 0.15))
        scores.append(desc_score)
        weights.append(0.15)
    
    # Distance score (weight: 0.15)
    if results["distance_results"].get("all_passed") is not None:
        dist_score = 1.0 if results["distance_results"]["all_passed"] else 0.0
        scores.append(dist_score)
        weights.append(0.15)
    
    # Database score (weight: 0.15)
    if results["database_results"].get("operations_successful") is not None:
        db_score = 1.0 if results["database_results"]["operations_successful"] else 0.0
        scores.append(db_score)
        weights.append(0.15)
    
    # Recognition score (weight: 0.2)
    if results["recognition_results"].get("recognition_accuracy") is not None:
        scores.append(results["recognition_results"]["recognition_accuracy"])
        weights.append(0.2)
    
    # Whispers score (weight: 0.15)
    if results["whispers_results"].get("convergence_rate") is not None:
        whispers_score = results["whispers_results"]["convergence_rate"]
        scores.append(whispers_score)
        weights.append(0.15)
    
    # Calculate weighted average
    if scores and weights:
        return np.average(scores, weights=weights)
    
    return 0.0
