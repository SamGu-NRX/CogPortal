# Face Recognition Application

An implementation of the CogWorks Vision Module Capstone project for detecting and recognizing faces using FaceNet models.

## Features

- **Face Detection**: Detect faces in images using MTCNN
- **Face Description**: Generate 512-dimensional descriptor vectors using InceptionResnetV1
- **Face Recognition**: Identify faces by comparing descriptors to a database
- **Database Management**: Store and retrieve face profiles
- **Whispers Clustering**: Automatically sort photos into groups by person

## Installation

### Prerequisites

- Python 3.8+
- The following packages:
  - `facenet_models` (or `facenet-pytorch`)
  - `numpy`
  - `scikit-image`

### Install Dependencies

```bash
# Install facenet_models
git clone https://github.com/CogWorksBWSI/facenet_models.git
cd facenet_models
git checkout 96b9599b03f26910b66f61ce725a8660e0ba654c
pip install -e .

# Install other dependencies
conda install -c conda-forge numpy scikit-image
```

### Install This Package

```bash
cd face_recognition_app
pip install -e .
```

## Quick Start

### Basic Usage (Recommended)

The `FaceRecognitionApp` class provides a unified interface:

```python
from facenet_models import FacenetModel
from face_recognition import FaceRecognitionApp

# Initialize
model = FacenetModel()
app = FaceRecognitionApp(model)

# Process an image
results = app.process_image("photo.jpg")

# Print results
for face in results["faces"]:
    print(f"Found {face['name']} with {face['probability']:.2%} confidence")
```

### Adding Faces to Database

```python
# Add from image
app.add_image_to_database("john_photo.jpg", "John Doe")

# Add multiple descriptors
app.add_descriptors_to_database([desc1, desc2, desc3], "Jane Doe")

# Save database
app.save_database("my_database.pkl")
```

### Using with Benchmark

The app can be used directly with the facial recognition benchmark:

```python
from facenet_models import FacenetModel
from face_recognition import FaceRecognitionApp
from facial_recognition_benchmark import run_benchmark, run_celeba_benchmark

# Initialize
model = FacenetModel()
app = FaceRecognitionApp(model)

# Build your database
app.add_image_to_database("photo1.jpg", "Person1")
app.add_image_to_database("photo2.jpg", "Person2")

# Run custom benchmark
test_config = {
    "face_images": ["test1.jpg", "test2.jpg"],
    "test_images": ["test1.jpg"],
    "ground_truth_labels": ["Person1"],
    "threshold": 0.5
}
results = run_benchmark(app, app.get_database_dict(), test_config)
print(results.summary())

# Or run CelebA benchmark
results = run_celeba_benchmark(
    model=app,
    num_images=1000,
    num_people=50
)
print(results.summary())
```

### Using Whispers Clustering

```python
from face_recognition import whispers

# Generate descriptors from images
descriptors = [...]  # List of 512-dim vectors

# Run clustering
results = whispers(
    descriptors,
    threshold=0.5,
    weighted=True
)

# Get clusters
for cluster_label, node_ids in results["clusters"].items():
    print(f"Cluster {cluster_label}: {len(node_ids)} images")
```

## Project Structure

```
face_recognition_app/
├── face_recognition/
│   ├── __init__.py        # Package exports (includes FaceRecognitionApp)
│   ├── app.py             # FaceRecognitionApp - single class interface
│   ├── profile.py         # Profile class
│   ├── database.py        # Database class
│   ├── node.py            # Node class for Whispers
│   ├── recognizer.py      # FaceRecognizer class
│   └── whispers.py        # Whispers algorithm
├── data/
│   └── faces/             # Face images
├── main.py                # Example usage
├── example_with_benchmark.py  # Benchmark integration example
└── README.md              # This file
```

## Classes

### FaceRecognitionApp (Recommended)

Single class interface that combines all functionality:

```python
from face_recognition import FaceRecognitionApp

app = FaceRecognitionApp(model, detection_threshold=0.9, matching_threshold=0.7)

# Detect and recognize
results = app.process_image("photo.jpg")

# Manage database
app.add_image_to_database("new_photo.jpg", "NewPerson")
app.save_database("database.pkl")

# Use with benchmark
db_dict = app.get_database_dict()
```

**Methods:**
- `detect(image)` - Detect faces (same interface as FacenetModel)
- `compute_descriptors(image, boxes)` - Compute descriptors
- `process_image(image_path)` - Full pipeline
- `recognize_face(descriptor)` - Identify a face
- `add_image_to_database(image_path, name)` - Add from image
- `add_descriptors_to_database(descriptors, name)` - Add descriptors
- `cluster_images(images)` - Whispers clustering
- `save_database(filepath)` - Save database
- `load_database(filepath)` - Load database
- `get_database_dict()` - Get dict for benchmark

### Profile

Stores face descriptors for a single person.

```python
from face_recognition import Profile

# Create profile
profile = Profile("Alice", [descriptor1, descriptor2])

# Add more descriptors
profile.add_descriptor(descriptor3)

# Get average
avg = profile.average_descriptor
```

### Database

Manages a collection of profiles.

```python
from face_recognition import Database

db = Database()
db.add_profile("Alice", descriptors)
db.add_profile("Bob", descriptors)

# Save/load
db.save("database.pkl")
db = Database.load("database.pkl")
```

### FaceRecognizer

Main class for face detection and recognition.

```python
from face_recognition import FaceRecognizer

recognizer = FaceRecognizer(model, database=db)

# Process image
results = recognizer.process_image("photo.jpg")

# Recognize a single face
name, distance = recognizer.recognize_face(descriptor)
```

### Node

Represents a node in the Whispers algorithm graph.

```python
from face_recognition import Node

node = Node(
    ID=0,
    neighbors=[1, 2],
    descriptor=descriptor,
    truth="Alice",
    file_path="alice.jpg"
)
```

## API Reference

### FaceRecognitionApp

**Constructor:**
- `FaceRecognitionApp(model, database=None, detection_threshold=0.9, matching_threshold=0.7)`

**Detection/Recognition:**
- `detect(image)` - Detect faces, returns (boxes, probabilities, landmarks)
- `compute_descriptors(image, boxes)` - Compute face descriptors
- `recognize_face(descriptor)` - Identify a face, returns (name, distance)
- `process_image(image_path)` - Full detection + recognition pipeline

**Database Management:**
- `add_image_to_database(image_path, name)` - Add face from image
- `add_descriptors_to_database(descriptors, name)` - Add multiple descriptors
- `add_unknown_face(descriptor, name)` - Add single descriptor
- `save_database(filepath)` - Save to file
- `load_database(filepath)` - Load from file
- `get_database_dict()` - Get dict format for benchmark

**Clustering:**
- `cluster_images(images, threshold=None, weighted=True)` - Whispers clustering

### Database

- `add_profile(name, descriptors)` - Add/update profile
- `remove_profile(name)` - Remove profile
- `get_profile(name)` - Get profile
- `save(filepath)` - Save to file
- `load(filepath)` - Load from file

### whispers()

- `descriptors` - List of descriptor vectors
- `threshold` - Maximum cosine distance for edge
- `weighted` - Use weighted edges
- `max_iterations` - Maximum iterations
- Returns dict with clusters, labels, convergence info

## Running the Demo

```bash
cd face_recognition_app
python main.py
```

## Using with Benchmark

The `FaceRecognitionApp` can be used directly with the benchmark module:

```python
from facenet_models import FacenetModel
from face_recognition import FaceRecognitionApp
from facial_recognition_benchmark import run_benchmark

# Initialize app
model = FacenetModel()
app = FaceRecognitionApp(model)

# Build your database
app.add_image_to_database("photo1.jpg", "Person1")
app.add_image_to_database("photo2.jpg", "Person2")

# Prepare test config
test_config = {
    "face_images": ["path/to/faces..."],
    "test_images": ["path/to/tests..."],
    "ground_truth_labels": ["Person1", "Person2"],
    "threshold": 0.5
}

# Run benchmark - pass app as the model (it has detect/compute_descriptors)
results = run_benchmark(
    app,  # App has detect() and compute_descriptors() methods
    app.get_database_dict(),
    test_config
)

print(results.summary())
```

See `example_with_benchmark.py` for a complete working example.

## CogBench v2 integration

This complete application is the repository's golden end-to-end submission.
`benchmark_adapter.py` returns `FaceRecognitionApp` unchanged; the benchmark's
bounded compatibility layer translates its documented path-based methods into
the recognition and clustering behavior contracts.

After installing this project, both submission entry points are discoverable:

```bash
python -m pip install -e .
cogworks test vision-recognition
cogworks test vision-clustering
```

This is intentionally separate from the future student-template repository.
The template may expose only interfaces, while this project remains useful for
benchmark calibration and for testing the CLI, hosted runner, portal, and
Discord-triggered workflow.

See `TESTING.md` for the progression from offline component tests to official
evaluation.

## License

MIT License
