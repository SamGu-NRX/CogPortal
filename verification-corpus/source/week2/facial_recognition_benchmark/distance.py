"""
Cosine Distance Calculation Benchmark Module

Tests the correctness and performance of cosine distance calculations including:
- Calculation accuracy
- Threshold selection effectiveness
- Performance with large descriptor sets
"""

import numpy as np
import time
from typing import List, Tuple, Dict, Any, Optional
from facial_recognition_benchmark.utils import cosine_distance, cosine_distance_matrix


def benchmark_cosine_distance_accuracy(
    num_test_vectors: int = 100,
    dimension: int = 512
) -> Dict[str, Any]:
    """
    Benchmark cosine distance calculation accuracy.
    
    Parameters
    ----------
    num_test_vectors : int
        Number of test vectors to generate.
    dimension : int
        Dimension of test vectors.
    
    Returns
    -------
    Dict[str, Any]
        Accuracy metrics for cosine distance calculation.
    """
    results = {
        "test_cases": [],
        "max_error": 0.0,
        "avg_error": 0.0,
        "all_passed": True
    }
    
    errors = []
    
    # Test 1: Identical vectors should have distance 0
    for i in range(min(10, num_test_vectors)):
        vector = np.random.randn(dimension)
        vector = vector / np.linalg.norm(vector)
        
        distance = cosine_distance(vector, vector)
        error = abs(distance - 0.0)
        errors.append(error)
        
        results["test_cases"].append({
            "test": "identical_vectors",
            "expected": 0.0,
            "actual": distance,
            "error": error,
            "passed": error < 1e-6
        })
        
        if error >= 1e-6:
            results["all_passed"] = False
    
    # Test 2: Orthogonal vectors should have distance 1
    for i in range(min(10, num_test_vectors)):
        # Create orthogonal vectors
        v1 = np.zeros(dimension)
        v1[0] = 1.0
        
        v2 = np.zeros(dimension)
        v2[1] = 1.0
        
        distance = cosine_distance(v1, v2)
        error = abs(distance - 1.0)
        errors.append(error)
        
        results["test_cases"].append({
            "test": "orthogonal_vectors",
            "expected": 1.0,
            "actual": distance,
            "error": error,
            "passed": error < 1e-6
        })
        
        if error >= 1e-6:
            results["all_passed"] = False
    
    # Test 3: Opposite vectors should have distance 2
    for i in range(min(10, num_test_vectors)):
        vector = np.random.randn(dimension)
        vector = vector / np.linalg.norm(vector)
        opposite_vector = -vector
        
        distance = cosine_distance(vector, opposite_vector)
        error = abs(distance - 2.0)
        errors.append(error)
        
        results["test_cases"].append({
            "test": "opposite_vectors",
            "expected": 2.0,
            "actual": distance,
            "error": error,
            "passed": error < 1e-6
        })
        
        if error >= 1e-6:
            results["all_passed"] = False
    
    # Test 4: Similar vectors should have small distance
    for i in range(min(10, num_test_vectors)):
        base_vector = np.random.randn(dimension)
        base_vector = base_vector / np.linalg.norm(base_vector)
        
        # Add small noise
        noise = np.random.randn(dimension) * 0.01
        similar_vector = base_vector + noise
        similar_vector = similar_vector / np.linalg.norm(similar_vector)
        
        distance = cosine_distance(base_vector, similar_vector)
        
        results["test_cases"].append({
            "test": "similar_vectors",
            "expected_range": (0.0, 0.5),
            "actual": distance,
            "passed": 0.0 <= distance <= 0.5
        })
        
        if not (0.0 <= distance <= 0.5):
            results["all_passed"] = False
    
    # Calculate error statistics
    if errors:
        results["max_error"] = float(np.max(errors))
        results["avg_error"] = float(np.mean(errors))
    
    return results


def benchmark_cosine_distance_performance(
    vector_sizes: List[int] = None,
    num_test_vectors: int = 100,
    dimension: int = 512,
    num_runs: int = 5
) -> Dict[str, Any]:
    """
    Benchmark cosine distance calculation performance.
    
    Parameters
    ----------
    vector_sizes : List[int], optional
        List of vector set sizes to test.
    num_test_vectors : int
        Number of test vectors to generate.
    dimension : int
        Dimension of test vectors.
    num_runs : int
        Number of runs to average timing.
    
    Returns
    -------
    Dict[str, Any]
        Performance metrics including timing for different vector sizes.
    """
    if vector_sizes is None:
        vector_sizes = [10, 50, 100, 500, 1000]
    
    results = {
        "vector_sizes": vector_sizes,
        "pairwise_times": [],
        "matrix_times": [],
        "pairwise_throughput": [],
        "matrix_throughput": []
    }
    
    for size in vector_sizes:
        # Generate test vectors
        vectors = np.random.randn(size, dimension)
        vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
        
        # Benchmark pairwise distance calculation
        pairwise_times = []
        for _ in range(num_runs):
            start_time = time.time()
            for i in range(size):
                for j in range(i + 1, size):
                    cosine_distance(vectors[i], vectors[j])
            pairwise_times.append(time.time() - start_time)
        
        avg_pairwise_time = np.mean(pairwise_times)
        results["pairwise_times"].append(avg_pairwise_time)
        
        # Calculate pairwise throughput (distances per second)
        num_pairs = size * (size - 1) // 2
        pairwise_throughput = num_pairs / avg_pairwise_time if avg_pairwise_time > 0 else 0
        results["pairwise_throughput"].append(pairwise_throughput)
        
        # Benchmark matrix distance calculation
        matrix_times = []
        for _ in range(num_runs):
            start_time = time.time()
            cosine_distance_matrix(vectors, vectors)
            matrix_times.append(time.time() - start_time)
        
        avg_matrix_time = np.mean(matrix_times)
        results["matrix_times"].append(avg_matrix_time)
        
        # Calculate matrix throughput (distances per second)
        matrix_throughput = (size * size) / avg_matrix_time if avg_matrix_time > 0 else 0
        results["matrix_throughput"].append(matrix_throughput)
    
    return results


def benchmark_cosine_distance_threshold(
    same_person_distances: List[float],
    different_person_distances: List[float],
    thresholds: List[float] = None
) -> Dict[str, Any]:
    """
    Benchmark threshold selection for face matching.
    
    Parameters
    ----------
    same_person_distances : List[float]
        Distances between descriptors of the same person.
    different_person_distances : List[float]
        Distances between descriptors of different people.
    thresholds : List[float], optional
        List of thresholds to test.
    
    Returns
    -------
    Dict[str, Any]
        Threshold analysis including optimal threshold and ROC metrics.
    """
    if thresholds is None:
        thresholds = np.arange(0.0, 1.0, 0.01).tolist()
    
    results = {
        "thresholds": thresholds,
        "true_positive_rates": [],
        "false_positive_rates": [],
        "f1_scores": [],
        "optimal_threshold": None,
        "optimal_f1_score": 0.0,
        "optimal_tpr": 0.0,
        "optimal_fpr": 0.0
    }
    
    tpr_list = []
    fpr_list = []
    f1_list = []
    
    for threshold in thresholds:
        # Initialize before the branches: with an empty input list the branch
        # never assigned these, and the read below raised UnboundLocalError.
        true_positives = 0
        false_positives = 0
        true_negatives = 0
        false_negatives = 0

        # True positive rate: same-person pairs correctly matched
        if same_person_distances:
            true_positives = sum(1 for d in same_person_distances if d <= threshold)
            tpr = true_positives / len(same_person_distances)
        else:
            tpr = 0.0

        # False positive rate: different-person pairs incorrectly matched
        if different_person_distances:
            false_positives = sum(1 for d in different_person_distances if d <= threshold)
            fpr = false_positives / len(different_person_distances)
        else:
            fpr = 0.0

        # Calculate F1 score
        # The old value here was 1 - fpr, which is specificity, not precision.
        # Real precision is TP / (TP + FP), so f1_scores and the optimal
        # threshold derived from them now reflect actual F1.
        if (true_positives + false_positives) > 0:
            precision = true_positives / (true_positives + false_positives)
        else:
            precision = 0.0
        recall = tpr
        if precision + recall > 0:
            f1 = 2 * (precision * recall) / (precision + recall)
        else:
            f1 = 0.0
        
        tpr_list.append(tpr)
        fpr_list.append(fpr)
        f1_list.append(f1)
    
    results["true_positive_rates"] = tpr_list
    results["false_positive_rates"] = fpr_list
    results["f1_scores"] = f1_list
    
    # Find optimal threshold (highest F1 score)
    if f1_list:
        optimal_idx = np.argmax(f1_list)
        results["optimal_threshold"] = thresholds[optimal_idx]
        results["optimal_f1_score"] = f1_list[optimal_idx]
        results["optimal_tpr"] = tpr_list[optimal_idx]
        results["optimal_fpr"] = fpr_list[optimal_idx]
    
    return results
