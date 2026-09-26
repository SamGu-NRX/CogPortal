"""
Utility functions for the facial recognition benchmark.
"""

import numpy as np
from typing import List, Tuple, Optional, Dict, Any


def cosine_distance(descriptor1: np.ndarray, descriptor2: np.ndarray) -> float:
    """
    Compute cosine distance between two descriptor vectors.
    
    Parameters
    ----------
    descriptor1 : np.ndarray, shape=(D,)
        First descriptor vector.
    descriptor2 : np.ndarray, shape=(D,)
        Second descriptor vector.
    
    Returns
    -------
    float
        Cosine distance (0 = identical, 1 = completely different)
    """
    dot_product = np.dot(descriptor1, descriptor2)
    norm1 = np.linalg.norm(descriptor1)
    norm2 = np.linalg.norm(descriptor2)
    
    if norm1 == 0 or norm2 == 0:
        return 1.0
    
    return 1.0 - (dot_product / (norm1 * norm2))


def cosine_distance_matrix(descriptors1: np.ndarray, descriptors2: np.ndarray) -> np.ndarray:
    """
    Compute pairwise cosine distance matrix between two sets of descriptors.
    
    Parameters
    ----------
    descriptors1 : np.ndarray, shape=(M, D)
        First set of descriptor vectors.
    descriptors2 : np.ndarray, shape=(N, D)
        Second set of descriptor vectors.
    
    Returns
    -------
    np.ndarray, shape=(M, N)
        Cosine distance matrix where entry (i,j) is the distance between
        descriptors1[i] and descriptors2[j].
    """
    # Normalize descriptors
    norms1 = np.linalg.norm(descriptors1, axis=1, keepdims=True)
    norms2 = np.linalg.norm(descriptors2, axis=1, keepdims=True)
    
    # Avoid division by zero
    norms1 = np.where(norms1 == 0, 1, norms1)
    norms2 = np.where(norms2 == 0, 1, norms2)
    
    normed1 = descriptors1 / norms1
    normed2 = descriptors2 / norms2
    
    # Compute cosine similarity matrix
    similarity = np.dot(normed1, normed2.T)
    
    # Convert to distance
    return 1.0 - similarity


def load_image(path: str) -> np.ndarray:
    """
    Load an image from file path and return as RGB numpy array.
    
    Parameters
    ----------
    path : str
        Path to image file.
    
    Returns
    -------
    np.ndarray, shape=(H, W, 3)
        RGB image array.
    """
    try:
        import skimage.io as io
        image = io.imread(str(path))
        if image.shape[-1] == 4:
            # Image is RGBA, remove alpha channel
            image = image[..., :-1]
        return image
    except ImportError:
        raise ImportError("scikit-image is required for image loading. "
                         "Install with: conda install -c conda-forge scikit-image")


def generate_random_descriptor(dim: int = 512) -> np.ndarray:
    """
    Generate a random normalized descriptor vector for testing.
    
    Parameters
    ----------
    dim : int
        Dimension of descriptor vector (default: 512).
    
    Returns
    -------
    np.ndarray, shape=(dim,)
        Random normalized descriptor vector.
    """
    descriptor = np.random.randn(dim)
    return descriptor / np.linalg.norm(descriptor)


def generate_test_database(num_people: int = 3, descriptors_per_person: int = 5) -> Dict[str, Any]:
    """
    Generate a synthetic test database with random descriptors.
    
    Parameters
    ----------
    num_people : int
        Number of people to generate profiles for.
    descriptors_per_person : int
        Number of descriptors per person.
    
    Returns
    -------
    Dict[str, Any]
        Database dictionary mapping names to profiles.
    """
    database = {}
    
    for i in range(num_people):
        name = f"Person_{i+1}"
        descriptors = []
        
        # Generate similar descriptors for the same person
        base_descriptor = generate_random_descriptor()
        for _ in range(descriptors_per_person):
            # Add small random noise to base descriptor
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
