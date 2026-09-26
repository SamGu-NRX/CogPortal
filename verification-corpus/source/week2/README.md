# Facial Recognition System

This repository contains two components for facial recognition benchmarking:

1. **face_recognition_app/** - An implementation of the CogWorks Vision Module Capstone facial recognition application
2. **facial_recognition_benchmark/** - A benchmark suite for testing facial recognition applications

## Relationship

```
┌─────────────────────────────────────────────────────────────┐
│                    facial_recognition_benchmark             │
│  (Tests face detection, recognition, clustering, etc.)      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ Tests
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    face_recognition_app                     │
│  (Implementation using FaceNet models)                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ Uses
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    facenet_models                           │
│  (Pre-trained MTCNN + InceptionResnetV1)                    │
└─────────────────────────────────────────────────────────────┘
```

The **benchmark** tests the **app** by evaluating:
- Face detection accuracy
- Descriptor generation quality
- Face recognition matching
- Whispers clustering performance

## Quick Start

### 1. Install Dependencies

```bash
# Install facenet_models (required by app)
git clone https://github.com/CogWorksBWSI/facenet_models.git
cd facenet_models
git checkout 96b9599b03f26910b66f61ce725a8660e0ba654c
pip install -e .
cd ..

# Install app dependencies
pip install numpy scikit-image opencv-python


# Install benchmark dependencies (for CelebA)
pip install datasets
```

### 2. Install Packages

```bash
cd face_recognition_app
pip install -e .
cd ..

cd facial_recognition_benchmark
pip install -e .
cd ..
```

### 3. Run CelebA Benchmark

```python
import sys
sys.path.insert(0, "/face_recognition_app")
sys.path.insert(0, "/facial_recognition_benchmark")

from facenet_models import FacenetModel
from face_recognition import FaceRecognitionApp
from facial_recognition_benchmark import run_celeba_benchmark

# Initialize
model = FacenetModel()
app = FaceRecognitionApp(model)

# Run benchmark with CelebA dataset from HuggingFace
results = run_celeba_benchmark(
    model=app,              # app has detect() and compute_descriptors()
    num_images=1000,        # Number of CelebA images to use
    num_people=25,          # Number of celebrities
    images_per_person=20    # Images per celebrity
)

print(results.summary())
```

## Using Your Own Images

### Build a Database

```python
from face_recognition import FaceRecognitionApp
from facenet_models import FacenetModel

model = FacenetModel()
app = FaceRecognitionApp(model)

# Add images to database
app.add_image_to_database("photos/alice_1.jpg", "Alice")
app.add_image_to_database("photos/alice_2.jpg", "Alice")
app.add_image_to_database("photos/bob_1.jpg", "Bob")

# Save database
app.save_database("my_database.pkl")
```

### Run Benchmark on Your Images

```python
from facial_recognition_benchmark import run_benchmark

test_config = {
    "face_images": ["test/alice_test.jpg", "test/bob_test.jpg"],
    "test_images": ["test/alice_test.jpg", "test/bob_test.jpg"],
    "ground_truth_labels": ["Alice", "Bob"],
    "threshold": 0.5
}

results = run_benchmark(app, app.get_database_dict(), test_config)
print(results.summary())
```

## CelebA Benchmark Details

The CelebA benchmark uses the dataset from HuggingFace:
- **Dataset:** https://huggingface.co/datasets/flwrlabs/celeba
- **Size:** 202,599 face images of 10,177 celebrities
- **Attributes:** 40 binary attributes per image

The benchmark tests:
1. **Detection** - How well faces are detected in CelebA images
2. **Recognition** - Matching faces against a database of celebrities
3. **Clustering** - Sorting images into groups by person using Whispers

## Project Structure

```
/
├── face_recognition_app/              # Face recognition implementation
│   ├── face_recognition/
│   │   ├── app.py                    # FaceRecognitionApp class (main entry point)
│   │   ├── profile.py                # Profile class for storing descriptors
│   │   ├── database.py               # Database class for managing profiles
│   │   ├── whispers.py               # Whispers clustering algorithm
│   │   └── node.py                   # Node class for graph operations
│   ├── data/faces/                   # Sample face images
│   ├── main.py                       # Example usage
│   └── README.md
│
├── facial_recognition_benchmark/     # Benchmark suite
│   ├── benchmark.py                  # Main benchmark runner
│   ├── celeba_dataset.py            # CelebA dataset loader (HuggingFace)
│   ├── detection.py                  # Face detection tests
│   ├── descriptors.py               # Descriptor generation tests
│   ├── distance.py                   # Cosine distance tests
│   ├── database.py                   # Database operation tests
│   ├── recognition.py               # Face recognition tests
│   ├── whispers.py                   # Whispers clustering tests
│   ├── celeba_example.py            # CelebA benchmark example
│   └── README.md
│
└── README.md                         # This file
```

## API Reference

### FaceRecognitionApp

```python
from face_recognition import FaceRecognitionApp

app = FaceRecognitionApp(
    model,                          # FacenetModel instance
    detection_threshold=0.9,        # Min probability for face detection
    matching_threshold=0.7          # Calibrated public-reference cutoff
)
```

**Key Methods:**
- `detect(image)` → (boxes, probabilities, landmarks)
- `compute_descriptors(image, boxes)` → descriptors
- `process_image(path)` → detection + recognition results
- `add_image_to_database(path, name)` → add face to database
- `cluster_images(images)` → Whispers clustering results
- `get_database_dict()` → dict format for benchmark

### Benchmark Functions

```python
from facial_recognition_benchmark import run_benchmark, run_celeba_benchmark

# Run with custom test data
results = run_benchmark(model, database_dict, test_config)

# Run with CelebA dataset
results = run_celeba_benchmark(model, num_images=1000, num_people=50)
```

## Component diagnostics and official evaluation

The original component benchmarks remain available for local investigation of
detection, descriptor generation, cosine distance, database behavior,
recognition thresholds, and Whispers. They are useful while developing and
calibrating an application, but some deliberately exercise benchmark-owned
reference calculations and therefore do not contribute to the leaderboard.

Official and public CogBench runs use two behavioral plugins instead:

- `vision-recognition` exercises enrollment, known identification, unknown
  rejection, and re-identification after enrollment.
- `vision-clustering` calls the submitted Whispers implementation and compares
  the resulting partition independently of its literal cluster labels.

The complete `face_recognition_app` is the class-based golden implementation
used to test local, CLI, hosted, and portal integration. Applications with
different classes, functions, or storage layouts use a thin adapter without
adopting the reference application's architecture.

See `docs/architecture.md` and `docs/data-and-scoring.md` for the v2 contract,
fixed manifests, and trusted evaluation boundary.

## License

MIT License
