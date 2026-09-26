"""
Face Descriptor Generation Benchmark Module

Tests the InceptionResnetV1 descriptor generation capabilities including:
- Descriptor consistency (same person, different images)
- Descriptor discrimination (different people)
- Descriptor generation speed
- Descriptor vector properties
"""

import numpy as np
import time
from typing import List, Tuple, Dict, Any, Optional
from facial_recognition_benchmark.utils import load_image, cosine_distance, cosine_distance_matrix


def benchmark_descriptor_generation(
    model,
    image_paths: List[str],
    ground_truth_boxes: Optional[Dict[str, List[Tuple[int, int, int, int]]]] = None
) -> Dict[str, Any]:
    """
    Benchmark face descriptor generation performance.
    
    Parameters
    ----------
    model : FacenetModel
        The face detection model to benchmark.
    image_paths : List[str]
        List of paths to images containing faces.
    ground_truth_boxes : Dict[str, List[Tuple[int, int, int, int]]], optional
        Dictionary mapping image paths to lists of bounding boxes.
    
    Returns
    -------
    Dict[str, Any]
        Benchmark results including descriptor quality and timing.
    """
    results = {
        "descriptors_generated": 0,
        "avg_generation_time": None,
        "descriptor_dimensions": [],
        "generation_times": [],
        "descriptors": []
    }
    
    total_generation_time = 0.0
    
    for image_path in image_paths:
        try:
            image = load_image(image_path)
            
            # Detect faces first
            boxes, probabilities, landmarks = model.detect(image)
            
            if boxes is None or len(boxes) == 0:
                continue
            
            # Measure descriptor generation time
            start_time = time.time()
            descriptors = model.compute_descriptors(image, boxes)
            generation_time = time.time() - start_time
            total_generation_time += generation_time
            
            # Record results
            results["descriptors_generated"] += len(descriptors)
            results["generation_times"].append(generation_time)
            results["descriptor_dimensions"].append(descriptors.shape[1] if len(descriptors.shape) > 1 else 0)
            
            results["descriptors"].append({
                "image_path": image_path,
                "num_descriptors": len(descriptors),
                "descriptors": descriptors
            })
            
        except Exception as e:
            print(f"Error processing {image_path}: {e}")
            continue
    
    # Calculate average generation time
    if results["generation_times"]:
        results["avg_generation_time"] = np.mean(results["generation_times"])
    
    return results


def benchmark_descriptor_consistency(
    model,
    same_person_images: List[List[str]],
    different_person_images: Optional[List[List[str]]] = None
) -> Dict[str, Any]:
    """
    Benchmark descriptor consistency and discrimination.
    
    Parameters
    ----------
    model : FacenetModel
        The face detection model to benchmark.
    same_person_images : List[List[str]]
        List of lists, where each inner list contains images of the same person.
    different_person_images : List[List[str]], optional
        List of lists, where each inner list contains images of different people.
    
    Returns
    -------
    Dict[str, Any]
        Consistency and discrimination metrics.
    """
    results = {
        "intra_class_distances": [],
        "inter_class_distances": [],
        "avg_intra_class_distance": None,
        "avg_inter_class_distance": None,
        "discrimination_ratio": None,
        "same_person_pairs": [],
        "different_person_pairs": []
    }
    
    # Calculate intra-class distances (same person)
    all_same_person_descriptors = []
    for person_images in same_person_images:
        person_descriptors = []
        
        for image_path in person_images:
            try:
                image = load_image(image_path)
                boxes, probabilities, landmarks = model.detect(image)
                
                if boxes is not None and len(boxes) > 0:
                    descriptors = model.compute_descriptors(image, boxes)
                    person_descriptors.append(descriptors[0])  # Take first face
            except Exception as e:
                print(f"Error processing {image_path}: {e}")
                continue
        
        if len(person_descriptors) >= 2:
            # Calculate pairwise distances within same person
            descriptors_array = np.array(person_descriptors)
            distances = cosine_distance_matrix(descriptors_array, descriptors_array)
            
            # Get upper triangle (excluding diagonal)
            triu_indices = np.triu_indices(len(person_descriptors), k=1)
            intra_distances = distances[triu_indices]
            
            results["intra_class_distances"].extend(intra_distances.tolist())
            all_same_person_descriptors.extend(person_descriptors)
            
            # Record some example pairs
            if len(intra_distances) > 0:
                results["same_person_pairs"].append({
                    "distance": float(np.mean(intra_distances)),
                    "min_distance": float(np.min(intra_distances)),
                    "max_distance": float(np.max(intra_distances))
                })
    
    # Calculate inter-class distances (different people)
    if different_person_images:
        different_person_descriptors = []
        
        for person_images in different_person_images:
            person_descriptors = []
            
            for image_path in person_images[:2]:  # Take up to 2 images per person
                try:
                    image = load_image(image_path)
                    boxes, probabilities, landmarks = model.detect(image)
                    
                    if boxes is not None and len(boxes) > 0:
                        descriptors = model.compute_descriptors(image, boxes)
                        person_descriptors.append(descriptors[0])
                except Exception as e:
                    print(f"Error processing {image_path}: {e}")
                    continue
            
            if person_descriptors:
                different_person_descriptors.append(person_descriptors[0])
        
        if len(different_person_descriptors) >= 2:
            # Calculate pairwise distances between different people
            descriptors_array = np.array(different_person_descriptors)
            distances = cosine_distance_matrix(descriptors_array, descriptors_array)
            
            # Get upper triangle (excluding diagonal)
            triu_indices = np.triu_indices(len(different_person_descriptors), k=1)
            inter_distances = distances[triu_indices]
            
            results["inter_class_distances"].extend(inter_distances.tolist())
            
            # Record some example pairs
            if len(inter_distances) > 0:
                results["different_person_pairs"].append({
                    "distance": float(np.mean(inter_distances)),
                    "min_distance": float(np.min(inter_distances)),
                    "max_distance": float(np.max(inter_distances))
                })
    
    # Calculate average distances
    if results["intra_class_distances"]:
        results["avg_intra_class_distance"] = np.mean(results["intra_class_distances"])
    
    if results["inter_class_distances"]:
        results["avg_inter_class_distance"] = np.mean(results["inter_class_distances"])
    
    # Calculate discrimination ratio (higher is better)
    if results["avg_intra_class_distance"] and results["avg_inter_class_distance"]:
        if results["avg_intra_class_distance"] > 0:
            results["discrimination_ratio"] = results["avg_inter_class_distance"] / results["avg_intra_class_distance"]
    
    return results


def benchmark_descriptor_properties(
    model,
    image_paths: List[str]
) -> Dict[str, Any]:
    """
    Benchmark properties of generated descriptors.
    
    Parameters
    ----------
    model : FacenetModel
        The face detection model to benchmark.
    image_paths : List[str]
        List of paths to images containing faces.
    
    Returns
    -------
    Dict[str, Any]
        Descriptor properties including norm distribution and uniqueness.
    """
    results = {
        "total_descriptors": 0,
        "descriptor_norms": [],
        "avg_norm": None,
        "norm_std": None,
        "dimension_consistent": True,
        "unique_ratio": None
    }
    
    all_descriptors = []
    
    for image_path in image_paths:
        try:
            image = load_image(image_path)
            boxes, probabilities, landmarks = model.detect(image)
            
            if boxes is not None and len(boxes) > 0:
                descriptors = model.compute_descriptors(image, boxes)
                all_descriptors.extend(descriptors)
                
                results["total_descriptors"] += len(descriptors)
        except Exception as e:
            print(f"Error processing {image_path}: {e}")
            continue
    
    if all_descriptors:
        descriptors_array = np.array(all_descriptors)
        
        # Calculate norms
        norms = np.linalg.norm(descriptors_array, axis=1)
        results["descriptor_norms"] = norms.tolist()
        results["avg_norm"] = float(np.mean(norms))
        results["norm_std"] = float(np.std(norms))
        
        # Check dimension consistency
        expected_dim = 512  # FaceNet descriptor dimension
        actual_dims = [d.shape[0] for d in all_descriptors]
        results["dimension_consistent"] = all(d == expected_dim for d in actual_dims)
        
        # Calculate uniqueness ratio (how many unique descriptors there are)
        unique_descriptors = np.unique(descriptors_array, axis=0)
        results["unique_ratio"] = len(unique_descriptors) / len(all_descriptors)
    
    return results
