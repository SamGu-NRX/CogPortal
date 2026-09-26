"""
Test suite for the facial recognition benchmark module.

This module contains tests to verify that the benchmark components
are working correctly.
"""

import numpy as np
import pytest
import tempfile
import os
import pickle

from facial_recognition_benchmark.utils import (
    cosine_distance,
    cosine_distance_matrix,
    generate_random_descriptor,
    generate_test_database
)
from facial_recognition_benchmark.distance import (
    benchmark_cosine_distance_accuracy,
    benchmark_cosine_distance_performance
)
from facial_recognition_benchmark.database import (
    benchmark_database_operations,
    benchmark_database_search
)
from facial_recognition_benchmark.whispers import (
    create_adjacency_matrix,
    whispers,
    calculate_purity,
    calculate_nmi
)


class TestCosineDistance:
    """Test cosine distance calculations."""
    
    def test_identical_vectors(self):
        """Test that identical vectors have distance 0."""
        vector = generate_random_descriptor()
        distance = cosine_distance(vector, vector)
        assert abs(distance) < 1e-6, f"Expected ~0, got {distance}"
    
    def test_orthogonal_vectors(self):
        """Test that orthogonal vectors have distance 1."""
        v1 = np.zeros(512)
        v1[0] = 1.0
        v2 = np.zeros(512)
        v2[1] = 1.0
        
        distance = cosine_distance(v1, v2)
        assert abs(distance - 1.0) < 1e-6, f"Expected ~1.0, got {distance}"
    
    def test_opposite_vectors(self):
        """Test that opposite vectors have distance 2."""
        vector = generate_random_descriptor()
        opposite_vector = -vector
        
        distance = cosine_distance(vector, opposite_vector)
        assert abs(distance - 2.0) < 1e-6, f"Expected ~2.0, got {distance}"
    
    def test_similar_vectors(self):
        """Test that similar vectors have small distance."""
        base_vector = generate_random_descriptor()
        noise = np.random.randn(512) * 0.01
        similar_vector = base_vector + noise
        similar_vector = similar_vector / np.linalg.norm(similar_vector)
        
        distance = cosine_distance(base_vector, similar_vector)
        assert 0.0 <= distance <= 0.5, f"Expected small distance, got {distance}"
    
    def test_distance_matrix(self):
        """Test distance matrix calculation."""
        vectors = np.random.randn(5, 512)
        vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
        
        distance_matrix = cosine_distance_matrix(vectors, vectors)
        
        # Check shape
        assert distance_matrix.shape == (5, 5), f"Expected (5, 5), got {distance_matrix.shape}"
        
        # Check diagonal is zero
        diagonal = np.diag(distance_matrix)
        assert np.allclose(diagonal, 0), "Diagonal should be zero"
        
        # Check symmetry
        assert np.allclose(distance_matrix, distance_matrix.T), "Matrix should be symmetric"


class TestCosineDistanceBenchmark:
    """Test cosine distance benchmark functions."""
    
    def test_accuracy_benchmark(self):
        """Test accuracy benchmark passes."""
        results = benchmark_cosine_distance_accuracy(num_test_vectors=10)
        assert results["all_passed"], "Accuracy benchmark should pass"
        assert results["max_error"] < 1e-6, "Max error should be very small"
    
    def test_performance_benchmark(self):
        """Test performance benchmark runs."""
        results = benchmark_cosine_distance_performance(
            vector_sizes=[10, 50],
            num_test_vectors=10,
            num_runs=2
        )
        assert len(results["pairwise_times"]) == 2
        assert len(results["matrix_times"]) == 2


class TestDatabaseOperations:
    """Test database operations."""
    
    def test_database_operations(self):
        """Test basic database operations."""
        results = benchmark_database_operations(num_people=3, descriptors_per_person=2)
        assert results["operations_successful"], "Database operations should succeed"
        assert results["profile_creation_time"] is not None
        assert results["database_save_time"] is not None
        assert results["database_load_time"] is not None
    
    def test_database_search(self):
        """Test database search functionality."""
        database = generate_test_database(num_people=3, descriptors_per_person=3)
        query_descriptors = [generate_random_descriptor() for _ in range(3)]
        
        results = benchmark_database_search(database, query_descriptors, threshold=0.5)
        assert results["search_time"] is not None
        assert results["matches_found"] >= 0


class TestWhispersAlgorithm:
    """Test Whispers algorithm implementation."""
    
    def test_adjacency_matrix(self):
        """Test adjacency matrix creation."""
        descriptors = [generate_random_descriptor() for _ in range(5)]
        adj, nodes = create_adjacency_matrix(descriptors, threshold=0.5, weighted=True)
        
        assert adj.shape == (5, 5), f"Expected (5, 5), got {adj.shape}"
        assert len(nodes) == 5
        assert np.allclose(adj, adj.T), "Adjacency matrix should be symmetric"
    
    def test_whispers_clustering(self):
        """Test whispers clustering algorithm."""
        # Create clustered data
        descriptors = []
        labels = []
        
        for i in range(3):
            base = generate_random_descriptor()
            for _ in range(3):
                noise = np.random.randn(512) * 0.05
                desc = base + noise
                desc = desc / np.linalg.norm(desc)
                descriptors.append(desc)
                labels.append(f"Person_{i+1}")
        
        results = whispers(
            descriptors,
            threshold=0.3,
            weighted=True,
            ground_truth=labels
        )
        
        assert results["num_clusters"] > 0
        assert len(results["labels"]) == len(descriptors)
        assert results["converged"] or results["iterations_to_converge"] > 0
    
    def test_purity_calculation(self):
        """Test purity calculation."""
        predicted = [1, 1, 2, 2, 3, 3]
        true = ["A", "A", "B", "B", "C", "C"]
        
        purity = calculate_purity(predicted, true)
        assert 0.0 <= purity <= 1.0
        assert purity == 1.0, "Perfect clustering should have purity 1.0"
    
    def test_nmi_calculation(self):
        """Test NMI calculation."""
        predicted = [1, 1, 2, 2, 3, 3]
        true = ["A", "A", "B", "B", "C", "C"]
        
        nmi = calculate_nmi(predicted, true)
        assert 0.0 <= nmi <= 1.0
        assert nmi > 0.9, "Perfect clustering should have high NMI"


class TestUtilities:
    """Test utility functions."""
    
    def test_generate_random_descriptor(self):
        """Test random descriptor generation."""
        desc = generate_random_descriptor(dim=512)
        assert desc.shape == (512,)
        assert abs(np.linalg.norm(desc) - 1.0) < 1e-6, "Descriptor should be normalized"
    
    def test_generate_test_database(self):
        """Test test database generation."""
        database = generate_test_database(num_people=3, descriptors_per_person=5)
        assert len(database) == 3
        
        for name, profile in database.items():
            assert "name" in profile
            assert "descriptors" in profile
            assert "average_descriptor" in profile
            assert len(profile["descriptors"]) == 5
            assert profile["average_descriptor"].shape == (512,)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
