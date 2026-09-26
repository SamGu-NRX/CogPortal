"""
Face Detection Benchmark Module

Tests the MTCNN face detection capabilities including:
- Detection accuracy on known face images
- False positive rejection on non-face images
- Detection probability threshold effectiveness
- Detection speed performance
"""

import numpy as np
import time
from typing import List, Tuple, Dict, Any, Optional
from facial_recognition_benchmark.utils import load_image


def benchmark_detection(
    model,
    face_images: List[str],
    non_face_images: Optional[List[str]] = None,
    # ground_truth_boxes removed: it was never read, and its positional slot
    # swallowed ground_truth_num_faces from run_benchmark, leaving accuracy None.
    ground_truth_num_faces: Optional[Dict[str, int]] = None
) -> Dict[str, Any]:
    """
    Benchmark face detection performance.

    Parameters
    ----------
    model : FacenetModel
        The face detection model to benchmark.
    face_images : List[str]
        List of paths to images containing faces.
    non_face_images : List[str], optional
        List of paths to images without faces (for false positive testing).
    ground_truth_num_faces : Dict[str, int], optional
        Dictionary mapping image paths to expected number of faces.
    
    Returns
    -------
    Dict[str, Any]
        Benchmark results including accuracy, false positive rate, and timing.
    """
    results = {
        "detection_accuracy": None,
        "false_positive_rate": None,
        "avg_detection_probability": None,
        "avg_detection_time": None,
        "detections": [],
        "false_positives": []
    }
    
    # Test face detection on face images
    correct_detections = 0
    total_detections = 0
    total_probability = 0.0
    detection_times = []
    
    for image_path in face_images:
        try:
            image = load_image(image_path)
            
            # Measure detection time
            start_time = time.time()
            boxes, probabilities, landmarks = model.detect(image)
            detection_time = time.time() - start_time
            detection_times.append(detection_time)
            
            num_detected = len(boxes) if boxes is not None else 0
            
            # Check against ground truth if provided
            if ground_truth_num_faces and image_path in ground_truth_num_faces:
                expected = ground_truth_num_faces[image_path]
                if num_detected == expected:
                    correct_detections += 1
                total_detections += 1
            
            # Record detection results
            detection_result = {
                "image_path": image_path,
                "num_faces_detected": num_detected,
                "probabilities": probabilities.tolist() if probabilities is not None else [],
                "detection_time": detection_time
            }
            results["detections"].append(detection_result)
            
            # Sum probabilities for average
            if probabilities is not None and len(probabilities) > 0:
                total_probability += np.mean(probabilities)
                
        except Exception as e:
            print(f"Error processing {image_path}: {e}")
            continue
    
    # Calculate accuracy if ground truth provided
    if total_detections > 0:
        results["detection_accuracy"] = correct_detections / total_detections
    
    # Calculate average detection probability
    if results["detections"]:
        results["avg_detection_probability"] = total_probability / len(results["detections"])
    
    # Calculate average detection time
    if detection_times:
        results["avg_detection_time"] = np.mean(detection_times)
    
    # Test false positive rejection on non-face images
    if non_face_images:
        false_positive_count = 0
        total_non_face_images = len(non_face_images)
        
        for image_path in non_face_images:
            try:
                image = load_image(image_path)
                boxes, probabilities, landmarks = model.detect(image)
                
                num_detected = len(boxes) if boxes is not None else 0
                
                if num_detected > 0:
                    false_positive_count += 1
                    
                    # Record false positive details
                    fp_result = {
                        "image_path": image_path,
                        "num_false_positives": num_detected,
                        "probabilities": probabilities.tolist() if probabilities is not None else []
                    }
                    results["false_positives"].append(fp_result)
                    
            except Exception as e:
                print(f"Error processing {image_path}: {e}")
                continue
        
        results["false_positive_rate"] = false_positive_count / total_non_face_images if total_non_face_images > 0 else 0.0
    
    return results


def benchmark_detection_probability_threshold(
    model,
    face_images: List[str],
    non_face_images: List[str],
    thresholds: List[float] = None
) -> Dict[str, Any]:
    """
    Find optimal detection probability threshold for filtering false positives.
    
    Parameters
    ----------
    model : FacenetModel
        The face detection model to benchmark.
    face_images : List[str]
        List of paths to images containing faces.
    non_face_images : List[str]
        List of paths to images without faces.
    thresholds : List[float], optional
        List of probability thresholds to test.
    
    Returns
    -------
    Dict[str, Any]
        Results showing accuracy at each threshold and optimal threshold.
    """
    if thresholds is None:
        thresholds = np.arange(0.5, 1.0, 0.05).tolist()
    
    results = {
        "thresholds": thresholds,
        "face_detection_rates": [],
        "false_positive_rates": [],
        "optimal_threshold": None,
        "optimal_f1_score": 0.0
    }
    
    face_detection_rates = []
    false_positive_rates = []
    f1_scores = []
    
    for threshold in thresholds:
        # Count true positives (faces detected above threshold)
        true_positives = 0
        for image_path in face_images:
            try:
                image = load_image(image_path)
                boxes, probabilities, landmarks = model.detect(image)
                
                if probabilities is not None:
                    # Count faces detected with probability >= threshold
                    detected_above_threshold = np.sum(probabilities >= threshold)
                    if detected_above_threshold > 0:
                        true_positives += 1
            except Exception:
                continue
        
        # Count false positives (non-faces detected above threshold)
        false_positives = 0
        for image_path in non_face_images:
            try:
                image = load_image(image_path)
                boxes, probabilities, landmarks = model.detect(image)
                
                if probabilities is not None:
                    detected_above_threshold = np.sum(probabilities >= threshold)
                    if detected_above_threshold > 0:
                        false_positives += 1
            except Exception:
                continue
        
        # Calculate rates
        face_detection_rate = true_positives / len(face_images) if face_images else 0.0
        false_positive_rate = false_positives / len(non_face_images) if non_face_images else 0.0
        
        face_detection_rates.append(face_detection_rate)
        false_positive_rates.append(false_positive_rate)
        
        # Calculate F1 score (balance between precision and recall)
        precision = 1 - false_positive_rate
        recall = face_detection_rate
        if precision + recall > 0:
            f1 = 2 * (precision * recall) / (precision + recall)
        else:
            f1 = 0.0
        f1_scores.append(f1)
    
    results["face_detection_rates"] = face_detection_rates
    results["false_positive_rates"] = false_positive_rates
    
    # Find optimal threshold (highest F1 score)
    if f1_scores:
        optimal_idx = np.argmax(f1_scores)
        results["optimal_threshold"] = thresholds[optimal_idx]
        results["optimal_f1_score"] = f1_scores[optimal_idx]
    
    return results


def benchmark_detection_consistency(
    model,
    image_paths: List[str],
    num_runs: int = 5
) -> Dict[str, Any]:
    """
    Test consistency of face detection across multiple runs.
    
    Parameters
    ----------
    model : FacenetModel
        The face detection model to benchmark.
    image_paths : List[str]
        List of paths to test images.
    num_runs : int
        Number of times to run detection on each image.
    
    Returns
    -------
    Dict[str, Any]
        Consistency metrics for detection results.
    """
    results = {
        "consistency_scores": [],
        "avg_variance": 0.0,
        "max_variance": 0.0
    }
    
    variances = []
    
    for image_path in image_paths:
        try:
            image = load_image(image_path)
            face_counts = []
            
            for _ in range(num_runs):
                boxes, probabilities, landmarks = model.detect(image)
                num_faces = len(boxes) if boxes is not None else 0
                face_counts.append(num_faces)
            
            # Calculate variance in detected face counts
            variance = np.var(face_counts)
            variances.append(variance)
            
            results["consistency_scores"].append({
                "image_path": image_path,
                "face_counts": face_counts,
                "variance": variance
            })
            
        except Exception as e:
            print(f"Error processing {image_path}: {e}")
            continue
    
    if variances:
        results["avg_variance"] = np.mean(variances)
        results["max_variance"] = np.max(variances)
    
    return results
