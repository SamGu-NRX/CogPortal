"""
Facial Recognition Application Benchmark

A comprehensive benchmark suite for testing the CogWorks Vision Module Capstone
facial recognition application. This module tests:

1. Face Detection (MTCNN) - accuracy and false positive filtering
2. Face Descriptor Generation (InceptionResnetV1) - consistency and discrimination
3. Cosine Distance Calculation - correctness
4. Database Operations - profile management
5. Face Recognition Matching - identification accuracy
6. Whispers Algorithm - clustering accuracy

Usage:
    from facial_recognition_benchmark import run_benchmark

    # Run all benchmarks. The third argument is a test_config dict, not a
    # whispers function; database and test_config are both optional.
    results = run_benchmark(
        model,
        database={"Alice": {"name": "Alice", "descriptors": [...],
                            "average_descriptor": ...}},
        test_config={"face_images": ["img1.jpg"],
                     "ground_truth_num_faces": {"img1.jpg": 1}},
    )
    print(results.summary())

    # Or run specific benchmarks
    from facial_recognition_benchmark.detection import benchmark_detection
    results = benchmark_detection(model, test_images)
"""

from facial_recognition_benchmark.benchmark import (
    BenchmarkResult,
    run_benchmark,
    run_celeba_benchmark,
)
from facial_recognition_benchmark.celeba_dataset import load_celeba_dataset, prepare_benchmark_data
from facial_recognition_benchmark.plugins import (
    ClusteringBenchmark,
    RecognitionBenchmark,
)

__version__ = "1.0.0"
__all__ = [
    "run_benchmark",
    "run_celeba_benchmark",
    "BenchmarkResult",
    "load_celeba_dataset",
    "prepare_benchmark_data",
    "RecognitionBenchmark",
    "ClusteringBenchmark",
]
