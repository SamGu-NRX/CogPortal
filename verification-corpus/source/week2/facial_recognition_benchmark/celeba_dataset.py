"""
CelebA Dataset Loader for Benchmarking

This module provides functionality to load and prepare the CelebA dataset
from HuggingFace Datasets for facial recognition benchmarking.

CelebA (CelebFaces Attributes Dataset) contains:
- 202,599 face images of 10,177 celebrities
- 40 binary attribute annotations per image

Reference: http://mmlab.ie.cuhk.edu.hk/projects/CelebA.html
Dataset: https://huggingface.co/datasets/flwrlabs/celeba
"""

import numpy as np
from typing import List, Tuple, Optional, Dict, Any
from PIL import Image


def load_celeba_dataset(
    num_images: int = 1000,
    num_people: int = 50,
    images_per_person: int = 20,
    split: str = "train",
    cache_dir: str = None
) -> Dict[str, Any]:
    """
    Load CelebA dataset from HuggingFace Datasets.
    
    Parameters
    ----------
    num_images : int
        Total number of images to load.
    num_people : int
        Number of distinct people (identities) to use.
    images_per_person : int
        Target number of images per person.
    split : str
        Dataset split: "train", "valid", or "test".
    cache_dir : str, optional
        Directory to cache dataset.
    
    Returns
    -------
    Dict[str, Any]
        Dictionary containing:
        - images: List of numpy arrays (H, W, 3)
        - identities: List of identity labels (ints)
        - identity_names: Dict mapping identity int to name string
        - attributes: List of attribute dicts
    """
    try:
        from datasets import load_dataset
    except ImportError:
        raise ImportError(
            "HuggingFace Datasets is required. "
            "Install with: pip install datasets"
        )
    
    print(f"Loading CelebA dataset from HuggingFace (split={split})...")
    print(f"  Target: {num_people} people, ~{images_per_person} images each")
    print(f"  Note: First load may take a few minutes to download dataset")
    
    # Load dataset from HuggingFace
    dataset = load_dataset(
        "flwrlabs/celeba",
        split=split,
        cache_dir=cache_dir,
        streaming=True  # Use streaming to avoid downloading entire dataset
    )
    
    # Organize by identity
    identity_images = {}
    identity_attributes = {}
    
    count = 0
    print("  Processing images...")
    
    for example in dataset:
        if count >= num_images:
            break
        
        # Get image (PIL Image)
        pil_image = example['image']
        
        # Convert to numpy array (RGB)
        if pil_image.mode != 'RGB':
            pil_image = pil_image.convert('RGB')
        image = np.array(pil_image)
        
        # Get identity (celeb_id)
        identity = example['celeb_id']
        
        # Get attributes (all 40 binary attributes)
        attrs = {}
        attr_names = [
            '5_o_Clock_Shadow', 'Arched_Eyebrows', 'Attractive', 'Bags_Under_Eyes',
            'Bald', 'Bangs', 'Big_Lips', 'Big_Nose', 'Black_Hair', 'Blond_Hair',
            'Blurry', 'Brown_Hair', 'Bushy_Eyebrows', 'Chubby', 'Double_Chin',
            'Eyeglasses', 'Goatee', 'Gray_Hair', 'Heavy_Makeup', 'High_Cheekbones',
            'Male', 'Mouth_Slightly_Open', 'Mustache', 'Narrow_Eyes', 'No_Beard',
            'Oval_Face', 'Pale_Skin', 'Pointy_Nose', 'Receding_Hairline', 'Rosy_Cheeks',
            'Sideburns', 'Smiling', 'Straight_Hair', 'Wavy_Hair', 'Wearing_Earrings',
            'Wearing_Hat', 'Wearing_Lipstick', 'Wearing_Necklace', 'Wearing_Necktie', 'Young'
        ]
        for attr_name in attr_names:
            attrs[attr_name] = example.get(attr_name, False)
        
        # Limit images per person
        if identity not in identity_images:
            identity_images[identity] = []
            identity_attributes[identity] = []
        
        if len(identity_images[identity]) < images_per_person:
            identity_images[identity].append(image)
            identity_attributes[identity].append(attrs)
            count += 1
        
        # Stop if we have enough people
        if len(identity_images) >= num_people:
            total_imgs = sum(len(imgs) for imgs in identity_images.values())
            if total_imgs >= num_images:
                break
        
        # Progress indicator
        if count % 100 == 0:
            print(f"    Loaded {count} images...")
    
    # Create name mapping (identity int -> name string)
    identity_names = {}
    for i, identity in enumerate(identity_images.keys()):
        identity_names[identity] = f"Celebrity_{i+1:04d}"
    
    # Flatten into lists
    all_images = []
    all_identities = []
    all_attributes = []
    
    for identity, images in identity_images.items():
        for img in images:
            all_images.append(img)
            all_identities.append(identity)
    
    for identity, attrs_list in identity_attributes.items():
        for attrs in attrs_list:
            all_attributes.append(attrs)
    
    print(f"  Loaded {len(all_images)} images from {len(identity_images)} identities")
    
    return {
        "images": all_images,
        "identities": all_identities,
        "identity_names": identity_names,
        "attributes": all_attributes,
        "num_identities": len(identity_images),
        "num_images": len(all_images)
    }


def prepare_benchmark_data(
    celeba_data: Dict[str, Any],
    num_test_images_per_person: int = 3,
    num_database_images_per_person: int = 5
) -> Dict[str, Any]:
    """
    Prepare CelebA data for benchmark testing.
    
    Parameters
    ----------
    celeba_data : Dict[str, Any]
        Raw CelebA data from load_celeba_dataset().
    num_test_images_per_person : int
        Number of images per person for testing.
    num_database_images_per_person : int
        Number of images per person for database.
    
    Returns
    -------
    Dict[str, Any]
        Prepared data for benchmarking.
    """
    # Group by identity
    identity_to_images = {}
    for img, identity in zip(celeba_data["images"], celeba_data["identities"]):
        if identity not in identity_to_images:
            identity_to_images[identity] = []
        identity_to_images[identity].append(img)
    
    # Split into database and test sets
    database_images = []
    database_identities = []
    test_images = []
    test_identities = []
    cluster_images = []
    cluster_identities = []
    
    for identity, images in identity_to_images.items():
        # Ensure we have enough images
        if len(images) < num_database_images_per_person + num_test_images_per_person:
            db_count = min(num_database_images_per_person, len(images) // 2)
            test_count = min(num_test_images_per_person, len(images) - db_count)
        else:
            db_count = num_database_images_per_person
            test_count = num_test_images_per_person
        
        # Split images
        db_imgs = images[:db_count]
        test_imgs = images[db_count:db_count + test_count]
        cluster_imgs = images
        
        # Add to lists
        for img in db_imgs:
            database_images.append(img)
            database_identities.append(identity)
        
        for img in test_imgs:
            test_images.append(img)
            test_identities.append(identity)
        
        for img in cluster_imgs:
            cluster_images.append(img)
            cluster_identities.append(identity)
    
    # Create name mapping
    identity_names = celeba_data.get("identity_names", {})
    
    # Create ground truth labels
    database_labels = [identity_names.get(i, f"Person_{i}") for i in database_identities]
    test_labels = [identity_names.get(i, f"Person_{i}") for i in test_identities]
    cluster_labels = [identity_names.get(i, f"Person_{i}") for i in cluster_identities]
    
    print(f"Prepared benchmark data:")
    print(f"  Database: {len(database_images)} images from {len(set(database_identities))} people")
    print(f"  Test: {len(test_images)} images from {len(set(test_identities))} people")
    print(f"  Cluster: {len(cluster_images)} images from {len(set(cluster_identities))} people")
    
    return {
        "database_images": database_images,
        "database_identities": database_identities,
        "database_labels": database_labels,
        "test_images": test_images,
        "test_identities": test_identities,
        "test_labels": test_labels,
        "cluster_images": cluster_images,
        "cluster_identities": cluster_identities,
        "cluster_labels": cluster_labels,
        "identity_names": identity_names
    }


def get_celeba_attributes(celeba_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Extract attribute statistics from CelebA data.
    
    Parameters
    ----------
    celeba_data : Dict[str, Any]
        CelebA data with attributes.
    
    Returns
    -------
    Dict[str, Any]
        Attribute statistics.
    """
    if not celeba_data.get("attributes"):
        return {}
    
    # Collect all attributes
    all_attrs = {}
    for attrs in celeba_data["attributes"]:
        for attr_name, value in attrs.items():
            if attr_name not in all_attrs:
                all_attrs[attr_name] = []
            all_attrs[attr_name].append(1 if value else 0)
    
    # Calculate statistics
    stats = {}
    for attr_name, values in all_attrs.items():
        values_arr = np.array(values)
        stats[attr_name] = {
            "mean": float(np.mean(values_arr)),
            "std": float(np.std(values_arr)),
            "count": int(np.sum(values_arr))
        }
    
    return stats


def sample_images_for_detection(
    celeba_data: Dict[str, Any],
    num_samples: int = 100
) -> List[np.ndarray]:
    """
    Sample images for face detection testing.
    
    Parameters
    ----------
    celeba_data : Dict[str, Any]
        CelebA data.
    num_samples : int
        Number of images to sample.
    
    Returns
    -------
    List[np.ndarray]
        List of sampled images.
    """
    images = celeba_data["images"]
    if len(images) <= num_samples:
        return images
    
    indices = np.random.choice(len(images), num_samples, replace=False)
    return [images[i] for i in indices]


def sample_pairs_for_matching(
    celeba_data: Dict[str, Any],
    num_pairs: int = 100
) -> Tuple[List[np.ndarray], List[np.ndarray], List[bool]]:
    """
    Sample image pairs for face matching testing.
    
    Parameters
    ----------
    celeba_data : Dict[str, Any]
        CelebA data.
    num_pairs : int
        Number of pairs to sample.
    
    Returns
    -------
    Tuple[List[np.ndarray], List[np.ndarray], List[bool]]
        - images1: First image in each pair
        - images2: Second image in each pair
        - is_match: Whether pair is same person
    """
    images = celeba_data["images"]
    identities = celeba_data["identities"]
    
    # Group by identity
    identity_to_indices = {}
    for i, identity in enumerate(identities):
        if identity not in identity_to_indices:
            identity_to_indices[identity] = []
        identity_to_indices[identity].append(i)
    
    images1 = []
    images2 = []
    is_match = []
    
    # Generate positive pairs (same person)
    positive_count = num_pairs // 2
    identities_with_multiple = [i for i, indices in identity_to_indices.items() 
                                if len(indices) >= 2]
    
    for _ in range(positive_count):
        identity = np.random.choice(identities_with_multiple)
        indices = identity_to_indices[identity]
        idx1, idx2 = np.random.choice(indices, 2, replace=False)
        images1.append(images[idx1])
        images2.append(images[idx2])
        is_match.append(True)
    
    # Generate negative pairs (different people)
    negative_count = num_pairs - positive_count
    identity_list = list(identity_to_indices.keys())
    
    for _ in range(negative_count):
        identity1, identity2 = np.random.choice(identity_list, 2, replace=False)
        idx1 = np.random.choice(identity_to_indices[identity1])
        idx2 = np.random.choice(identity_to_indices[identity2])
        images1.append(images[idx1])
        images2.append(images[idx2])
        is_match.append(False)
    
    return images1, images2, is_match


def sample_images_for_clustering(
    celeba_data: Dict[str, Any],
    num_people: int = 10,
    images_per_person: int = 5
) -> Tuple[List[np.ndarray], List[str]]:
    """
    Sample images for clustering testing.
    
    Parameters
    ----------
    celeba_data : Dict[str, Any]
        CelebA data.
    num_people : int
        Number of people to include.
    images_per_person : int
        Number of images per person.
    
    Returns
    -------
    Tuple[List[np.ndarray], List[str]]
        - images: List of images
        - labels: True identity labels
    """
    # Group by identity
    identity_to_images = {}
    for img, identity in zip(celeba_data["images"], celeba_data["identities"]):
        if identity not in identity_to_images:
            identity_to_images[identity] = []
        identity_to_images[identity].append(img)
    
    # Filter identities with enough images
    valid_identities = [i for i, imgs in identity_to_images.items() 
                       if len(imgs) >= images_per_person]
    
    if len(valid_identities) < num_people:
        num_people = len(valid_identities)
    
    # Sample people
    selected_identities = np.random.choice(valid_identities, num_people, replace=False)
    
    images = []
    labels = []
    
    identity_names = celeba_data.get("identity_names", {})
    
    for identity in selected_identities:
        imgs = identity_to_images[identity]
        sampled_indices = np.random.choice(len(imgs), min(images_per_person, len(imgs)), replace=False)
        
        name = identity_names.get(identity, f"Person_{identity}")
        
        for idx in sampled_indices:
            images.append(imgs[idx])
            labels.append(name)
    
    return images, labels
