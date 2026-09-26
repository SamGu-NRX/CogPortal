"""
Face Recognition Matching Benchmark Module

Tests face recognition matching capabilities including:
- Recognition accuracy against known faces
- Unknown face handling
- Adding new faces to database
- Recognition speed
"""

import numpy as np
import time
from typing import List, Tuple, Dict, Any, Optional
from facial_recognition_benchmark.utils import (
    cosine_distance, 
    generate_random_descriptor,
    load_image
)


def benchmark_face_recognition(
    model,
    database: Dict[str, Any],
    test_images: List[str],
    ground_truth_labels: Optional[List[str]] = None,
    threshold: float = 0.5
) -> Dict[str, Any]:
    """
    Benchmark face recognition performance.
    
    Parameters
    ----------
    model : FacenetModel
        The face detection model to benchmark.
    database : Dict[str, Any]
        Database of face profiles.
    test_images : List[str]
        List of paths to test images.
    ground_truth_labels : List[str], optional
        List of expected labels for test images.
    threshold : float
        Maximum cosine distance for a match.
    
    Returns
    -------
    Dict[str, Any]
        Recognition performance metrics.
    """
    results = {
        "recognition_accuracy": None,
        "unknown_detection_rate": None,
        "avg_recognition_time": None,
        "recognitions": [],
        "true_positives": 0,
        "false_positives": 0,
        "true_negatives": 0,
        "false_negatives": 0,
        "misidentifications": 0
    }
    
    recognition_times = []
    predictions = []
    
    for i, image_path in enumerate(test_images):
        try:
            image = load_image(image_path)
            
            # Detect faces
            boxes, probabilities, landmarks = model.detect(image)
            
            if boxes is None or len(boxes) == 0:
                # No face detected
                predictions.append("Unknown")
                continue
            
            # Get descriptor for first face
            descriptors = model.compute_descriptors(image, boxes)
            if len(descriptors) == 0:
                predictions.append("Unknown")
                continue
            
            descriptor = descriptors[0]
            
            # Find best match in database
            start_time = time.time()
            best_match = None
            best_distance = float('inf')
            
            for name, profile in database.items():
                distance = cosine_distance(descriptor, profile["average_descriptor"])
                if distance < best_distance:
                    best_distance = distance
                    best_match = name
            
            recognition_time = time.time() - start_time
            recognition_times.append(recognition_time)
            
            # Determine if match is within threshold
            if best_distance <= threshold:
                predictions.append(best_match)
            else:
                predictions.append("Unknown")
            
            # Record recognition result
            recognition_result = {
                "image_path": image_path,
                "predicted_label": predictions[-1],
                "distance": best_distance,
                "recognition_time": recognition_time
            }
            results["recognitions"].append(recognition_result)
            
        except Exception as e:
            print(f"Error processing {image_path}: {e}")
            predictions.append("Unknown")
            continue
    
    # Calculate metrics if ground truth provided
    if ground_truth_labels and len(ground_truth_labels) == len(predictions):
        # The old else-branch put naming the wrong known person into
        # true_negatives, and a correct Unknown/Unknown rejection into
        # true_positives. Wrong-name-for-known now gets its own counter,
        # misidentifications, and correct rejection is a true negative.
        for pred, truth in zip(predictions, ground_truth_labels):
            if pred == truth and truth != "Unknown":
                results["true_positives"] += 1
            elif pred == truth:  # both "Unknown": correct rejection
                results["true_negatives"] += 1
            elif pred == "Unknown" and truth != "Unknown":
                results["false_negatives"] += 1
            elif pred != "Unknown" and truth == "Unknown":
                results["false_positives"] += 1
            else:  # both known, different names
                results["misidentifications"] += 1

        total = len(predictions)
        if total > 0:
            # Exact-match accuracy over all cases, unchanged from before:
            # correct predictions include Unknown/Unknown, which the old code
            # counted in true_positives.
            correct = results["true_positives"] + results["true_negatives"]
            results["recognition_accuracy"] = correct / total
        
        # Calculate unknown detection rate
        unknown_count = sum(1 for truth in ground_truth_labels if truth == "Unknown")
        if unknown_count > 0:
            true_unknown = sum(1 for pred, truth in zip(predictions, ground_truth_labels) 
                            if pred == "Unknown" and truth == "Unknown")
            results["unknown_detection_rate"] = true_unknown / unknown_count
    
    # Calculate average recognition time
    if recognition_times:
        results["avg_recognition_time"] = np.mean(recognition_times)
    
    return results


def benchmark_unknown_handling(
    model,
    database: Dict[str, Any],
    unknown_images: List[str],
    threshold: float = 0.5
) -> Dict[str, Any]:
    """
    Benchmark handling of unknown faces.
    
    Parameters
    ----------
    model : FacenetModel
        The face detection model to benchmark.
    database : Dict[str, Any]
        Database of face profiles.
    unknown_images : List[str]
        List of paths to images of unknown people.
    threshold : float
        Maximum cosine distance for a match.
    
    Returns
    -------
    Dict[str, Any]
        Unknown handling metrics.
    """
    results = {
        "unknown_detection_rate": None,
        "avg_confidence": None,
        "false_match_rate": None,
        "unknown_results": []
    }
    
    false_matches = 0
    confidences = []
    
    for image_path in unknown_images:
        try:
            image = load_image(image_path)
            
            # Detect faces
            boxes, probabilities, landmarks = model.detect(image)
            
            if boxes is None or len(boxes) == 0:
                continue
            
            # Get descriptor
            descriptors = model.compute_descriptors(image, boxes)
            if len(descriptors) == 0:
                continue
            
            descriptor = descriptors[0]
            
            # Find best match
            best_match = None
            best_distance = float('inf')
            
            for name, profile in database.items():
                distance = cosine_distance(descriptor, profile["average_descriptor"])
                if distance < best_distance:
                    best_distance = distance
                    best_match = name
            
            # Check if incorrectly matched
            is_false_match = best_distance <= threshold
            if is_false_match:
                false_matches += 1
            
            # Record confidence (1 - distance, higher is more confident)
            confidence = 1.0 - best_distance
            confidences.append(confidence)
            
            results["unknown_results"].append({
                "image_path": image_path,
                "best_match": best_match,
                "distance": best_distance,
                "is_false_match": is_false_match,
                "confidence": confidence
            })
            
        except Exception as e:
            print(f"Error processing {image_path}: {e}")
            continue
    
    # Calculate metrics
    if unknown_images:
        results["unknown_detection_rate"] = 1.0 - (false_matches / len(unknown_images))
    
    if confidences:
        results["avg_confidence"] = np.mean(confidences)
    
    if false_matches > 0:
        results["false_match_rate"] = false_matches / len(unknown_images)
    
    return results


def benchmark_new_face_addition(
    model,
    database: Dict[str, Any],
    new_person_images: List[str],
    new_person_name: str,
    threshold: float = 0.5
) -> Dict[str, Any]:
    """
    Benchmark adding new faces to database.
    
    Parameters
    ----------
    model : FacenetModel
        The face detection model to benchmark.
    database : Dict[str, Any]
        Database of face profiles.
    new_person_images : List[str]
        List of paths to images of a new person.
    new_person_name : str
        Name for the new person.
    threshold : float
        Maximum cosine distance for a match.
    
    Returns
    -------
    Dict[str, Any]
        New face addition metrics.
    """
    results = {
        "addition_time": None,
        "descriptors_added": 0,
        "profile_created": False,
        "verification_results": []
    }
    
    # Add new person to database
    start_time = time.time()
    
    descriptors = []
    for image_path in new_person_images:
        try:
            image = load_image(image_path)
            
            # Detect and describe face
            boxes, probabilities, landmarks = model.detect(image)
            
            if boxes is not None and len(boxes) > 0:
                face_descriptors = model.compute_descriptors(image, boxes)
                descriptors.append(face_descriptors[0])
        except Exception as e:
            print(f"Error processing {image_path}: {e}")
            continue
    
    if descriptors:
        database[new_person_name] = {
            "name": new_person_name,
            "descriptors": descriptors,
            "average_descriptor": np.mean(descriptors, axis=0)
        }
        results["descriptors_added"] = len(descriptors)
        results["profile_created"] = True
    
    results["addition_time"] = time.time() - start_time
    
    # Verify new person can be recognized
    for image_path in new_person_images[:3]:  # Test with up to 3 images
        try:
            image = load_image(image_path)
            
            boxes, probabilities, landmarks = model.detect(image)
            
            if boxes is not None and len(boxes) > 0:
                face_descriptors = model.compute_descriptors(image, boxes)
                
                if len(face_descriptors) > 0:
                    descriptor = face_descriptors[0]
                    
                    # Find best match
                    best_match = None
                    best_distance = float('inf')
                    
                    for name, profile in database.items():
                        distance = cosine_distance(descriptor, profile["average_descriptor"])
                        if distance < best_distance:
                            best_distance = distance
                            best_match = name
                    
                    results["verification_results"].append({
                        "image_path": image_path,
                        "matched_name": best_match,
                        "distance": best_distance,
                        "correct_match": best_match == new_person_name
                    })
        except Exception as e:
            print(f"Error verifying {image_path}: {e}")
            continue
    
    return results
