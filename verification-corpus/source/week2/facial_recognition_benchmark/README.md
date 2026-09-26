# Facial Recognition Benchmark Module

A comprehensive benchmark suite for testing facial recognition applications based on the CogWorks Vision Module Capstone project.

## Overview

This benchmark module tests all core components of the facial recognition application described in the [CogWorks Facial Recognition](https://rsokl.github.io/CogWeb/Video/FacialRecognition.html) project:

1. **Face Detection** (MTCNN) - accuracy and false positive filtering
2. **Face Descriptor Generation** (InceptionResnetV1) - consistency and discrimination
3. **Cosine Distance Calculation** - correctness
4. **Database Operations** - profile management
5. **Face Recognition Matching** - identification accuracy
6. **Whispers Algorithm** - clustering accuracy

## Installation

### Prerequisites

- Python 3.8+
- The following packages:
  - `facenet_models` (or `facenet-pytorch`)
  - `numpy`
  - `scikit-image` (for image loading)
  - `networkx` (for Whispers algorithm visualization)

### Install Dependencies

```bash
# Install facenet_models
git clone https://github.com/CogWorksBWSI/facenet_models.git
cd facenet_models
git checkout 96b9599b03f26910b66f61ce725a8660e0ba654c
pip install -e .

# Install other dependencies
conda install -c conda-forge numpy scikit-image networkx opencv-python
```

### Install Benchmark Module

```bash
# Clone or download this repository
cd facial_recognition_benchmark
pip install -e .
```

## Quick Start

### Basic Usage

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

### Using CelebA Dataset

The benchmark includes support for the CelebA dataset from HuggingFace Datasets:

```python
from facenet_models import FacenetModel
from facial_recognition_benchmark import run_celeba_benchmark

# Initialize your model
model = FacenetModel()

# Run benchmark with CelebA dataset
results = run_celeba_benchmark(
    model=model,
    num_images=1000,        # Number of images to use
    num_people=50,          # Number of celebrities
    images_per_person=20,   # Images per celebrity
    detection_threshold=0.9,
    matching_threshold=0.5
)

# Print results
print(results.summary())
```

**CelebA Dataset Info:**
- 202,599 face images of 10,177 celebrities
- 40 binary attribute annotations per image
- Dataset source: https://huggingface.co/datasets/flwrlabs/celeba

**Requirements:**
```bash
pip install datasets scikit-image opencv-python
```

### Running Individual Benchmarks

```python
from facial_recognition_benchmark.detection import benchmark_detection
from facial_recognition_benchmark.descriptors import benchmark_descriptor_generation
from facial_recognition_benchmark.distance import benchmark_cosine_distance_accuracy
from facial_recognition_benchmark.database import benchmark_database_operations
from facial_recognition_benchmark.recognition import benchmark_face_recognition
from facial_recognition_benchmark.whispers import benchmark_whispers_clustering

# Run specific benchmark
```

### Using the Example Script

```bash
# Run the example demonstration
python -m facial_recognition_benchmark.example_usage
```

## Benchmark Components

### 1. Face Detection Benchmark

Tests the MTCNN face detection capabilities:

- **Detection Accuracy**: How well faces are detected in images
- **False Positive Rate**: How often non-faces are incorrectly detected
- **Detection Probability Threshold**: Optimal threshold for filtering false positives
- **Detection Consistency**: Stability of detection across multiple runs

```python
from facial_recognition_benchmark.detection import (
    benchmark_detection,
    benchmark_detection_probability_threshold,
    benchmark_detection_consistency
)

# Run detection benchmark
results = benchmark_detection(
    model,
    face_images=["face1.jpg", "face2.jpg"],
    non_face_images=["basketball.jpg", "circle.jpg"],
    ground_truth_num_faces={"face1.jpg": 1, "face2.jpg": 2}
)

# Find optimal threshold
threshold_results = benchmark_detection_probability_threshold(
    model,
    face_images,
    non_face_images
)
print(f"Optimal threshold: {threshold_results['optimal_threshold']}")
```

### 2. Face Descriptor Benchmark

Tests the InceptionResnetV1 descriptor generation:

- **Generation Speed**: Time to generate descriptor vectors
- **Consistency**: Similarity of descriptors for the same person
- **Discrimination**: Difference between descriptors of different people

```python
from facial_recognition_benchmark.descriptors import (
    benchmark_descriptor_generation,
    benchmark_descriptor_consistency
)

# Test descriptor generation
results = benchmark_descriptor_generation(model, image_paths)

# Test consistency and discrimination
consistency_results = benchmark_descriptor_consistency(
    model,
    same_person_images=[["person1_img1.jpg", "person1_img2.jpg"]],
    different_person_images=[["person1_img1.jpg"], ["person2_img1.jpg"]]
)
print(f"Discrimination ratio: {consistency_results['discrimination_ratio']}")
```

### 3. Cosine Distance Benchmark

Tests the correctness and performance of distance calculations:

- **Accuracy**: Correctness of distance calculations
- **Performance**: Speed with large descriptor sets
- **Threshold Selection**: Optimal threshold for face matching

```python
from facial_recognition_benchmark.distance import (
    benchmark_cosine_distance_accuracy,
    benchmark_cosine_distance_performance,
    benchmark_cosine_distance_threshold
)

# Test accuracy
accuracy_results = benchmark_cosine_distance_accuracy()
print(f"All tests passed: {accuracy_results['all_passed']}")

# Find optimal threshold
threshold_results = benchmark_cosine_distance_threshold(
    same_person_distances=[0.1, 0.2, 0.15],
    different_person_distances=[0.5, 0.6, 0.55]
)
print(f"Optimal threshold: {threshold_results['optimal_threshold']}")
```

### 4. Database Operations Benchmark

Tests database management capabilities:

- **Profile Creation**: Speed of creating new profiles
- **Save/Load**: Database serialization performance
- **Search**: Speed of finding matches in database

```python
from facial_recognition_benchmark.database import benchmark_database_operations

# Test database operations
results = benchmark_database_operations(num_people=10, descriptors_per_person=5)
print(f"Save time: {results['database_save_time']*1000:.2f}ms")
print(f"Load time: {results['database_load_time']*1000:.2f}ms")
```

### 5. Face Recognition Benchmark

Tests the complete recognition pipeline:

- **Recognition Accuracy**: Correct identification of known faces
- **Unknown Detection**: Proper handling of unknown faces
- **New Face Addition**: Adding new people to database

```python
from facial_recognition_benchmark.recognition import (
    benchmark_face_recognition,
    benchmark_unknown_handling
)

# Test recognition
results = benchmark_face_recognition(
    model,
    database,
    test_images=["test1.jpg", "test2.jpg"],
    ground_truth_labels=["Person1", "Person2"]
)
print(f"Recognition accuracy: {results['recognition_accuracy']:.2%}")

# Test unknown handling
unknown_results = benchmark_unknown_handling(
    model,
    database,
    unknown_images=["unknown1.jpg"]
)
print(f"Unknown detection rate: {unknown_results['unknown_detection_rate']:.2%}")
```

### 6. Whispers Algorithm Benchmark

Tests the clustering algorithm:

- **Clustering Accuracy**: Correct grouping of images
- **Convergence**: Speed of algorithm convergence
- **Purity**: Quality of clusters

```python
from facial_recognition_benchmark.whispers import benchmark_whispers_clustering

# Test clustering
results = benchmark_whispers_clustering(
    descriptors,
    ground_truth=labels,
    threshold=0.5,
    num_runs=5
)
print(f"Average purity: {results['avg_purity']:.2%}")
print(f"Convergence rate: {results['convergence_rate']:.2%}")
```

## Test Configuration

The `test_config` dictionary should contain:

```python
test_config = {
    # Face detection testing
    "face_images": ["path/to/face1.jpg", ...],  # Images with faces
    "non_face_images": ["path/to/non_face.jpg", ...],  # Images without faces
    "ground_truth_num_faces": {"face1.jpg": 1, ...},  # Expected face counts
    
    # Descriptor testing
    "same_person_images": [["person1_img1.jpg", "person1_img2.jpg"], ...],
    "different_person_images": [["person1_img1.jpg"], ["person2_img1.jpg"], ...],
    
    # Recognition testing
    "test_images": ["path/to/test1.jpg", ...],
    "ground_truth_labels": ["Person1", ...],
    "unknown_images": ["path/to/unknown.jpg", ...],
    
    # Whispers clustering testing
    "cluster_descriptors": [desc1, desc2, ...],  # Descriptor vectors
    "cluster_ground_truth": ["Person1", ...],  # True labels
    
    # Matching threshold
    "threshold": 0.5  # Maximum cosine distance for a match
}
```

## Output Format

The benchmark returns a `BenchmarkResult` object with:

- **Timestamp**: When the benchmark was run
- **Model Information**: Details about the model tested
- **Detection Results**: Face detection metrics
- **Descriptor Results**: Descriptor generation metrics
- **Distance Results**: Cosine distance calculation metrics
- **Database Results**: Database operation metrics
- **Recognition Results**: Face recognition metrics
- **Whispers Results**: Clustering algorithm metrics
- **Overall Score**: Weighted score (0-100%)
- **Recommendations**: Suggestions for improvement

### Sample Output

```
============================================================
FACIAL RECOGNITION BENCHMARK RESULTS
============================================================
Timestamp: 2024-01-15T10:30:00

DETECTION PERFORMANCE
----------------------------------------
  Detection Accuracy: 95.00%
  False Positive Rate: 5.00%
  Avg Detection Time: 45.23ms

DESCRIPTOR PERFORMANCE
----------------------------------------
  Avg Generation Time: 32.15ms
  Descriptors Generated: 150

DISTANCE CALCULATION
----------------------------------------
  Max Calculation Error: 0.000001
  All Tests Passed: Yes

DATABASE OPERATIONS
----------------------------------------
  Database Save Time: 12.45ms
  Database Load Time: 8.92ms

FACE RECOGNITION
----------------------------------------
  Recognition Accuracy: 88.33%
  Unknown Detection Rate: 92.00%

WHISPERS CLUSTERING
----------------------------------------
  Avg Clusters Found: 5.0
  Convergence Rate: 93.33%
  Avg Purity: 91.67%

OVERALL SCORE
----------------------------------------
  Score: 89.50%

RECOMMENDATIONS
----------------------------------------
  1. Recognition accuracy is below 90%. Consider adjusting threshold.
  2. All other benchmarks passed. System is performing well.
============================================================
```

## Running Tests

```bash
# Run the test suite
pytest facial_recognition_benchmark/tests.py -v

# Run with coverage
pytest facial_recognition_benchmark/tests.py --cov=facial_recognition_benchmark
```

## Project Structure

```
facial_recognition_benchmark/
├── __init__.py          # Main module interface
├── benchmark.py         # Main benchmark runner
├── detection.py         # Face detection tests
├── descriptors.py       # Descriptor generation tests
├── distance.py          # Cosine distance tests
├── database.py          # Database operation tests
├── recognition.py       # Face recognition tests
├── whispers.py          # Whispers algorithm tests
├── utils.py             # Utility functions
├── tests.py             # Test suite
├── example_usage.py     # Usage examples
├── README.md            # This file
└── data/                # Test data directory
    ├── faces/           # Known face images
    ├── non_faces/       # Non-face images
    └── clusters/        # Clustering test data
```

## CogBench behavioral plugins

The component functions above are retained as documented diagnostics. They are
not all appropriate leaderboard metrics: for example, the distance diagnostic
checks the benchmark's reference calculation and the database diagnostic times
a benchmark-created dictionary. They should help a team reason about its work,
not give that team credit for code it did not write.

The v2 plugins in `plugins.py` instead drive the submitted application through
the contracts in `contracts.py` and `adapters.py`. Fixed cases come from the
versioned manifests, `drivers.py` owns lifecycle ordering and output
validation, and `metrics.py` performs deterministic trusted scoring.

```python
from facial_recognition_benchmark.plugins import RecognitionBenchmark

benchmark = RecognitionBenchmark()
cases = benchmark.load_cases("test")
outputs = benchmark.run(submission_factory, facenet_model, cases)
scores = benchmark.score(outputs, cases)
```

Reynaldo's complete application is exercised through the same factory path in
the repository test suite. The tests also include a function-oriented
application fixture modeled after the 2024 `FaceRecognizer` project to ensure
the adapter contract does not require this repository's class hierarchy.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- [CogWorks](https://rsokl.github.io/CogWeb/) for the project description
- [Facenet Models](https://github.com/CogWorksBWSI/facenet_models) for the face detection models
- [Whispers Algorithm](https://github.com/rsokl/WhispersLectureMaterials) for the clustering approach
