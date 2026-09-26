"""
Database Operations Benchmark Module

Tests database operations including:
- Profile creation and management
- Database save/load operations
- Adding/removing profiles
- Adding images to profiles
"""

import numpy as np
import time
import pickle
import tempfile
import os
from typing import List, Dict, Any, Optional
from facial_recognition_benchmark.utils import generate_random_descriptor, generate_test_database


def benchmark_database_operations(
    num_people: int = 10,
    descriptors_per_person: int = 5
) -> Dict[str, Any]:
    """
    Benchmark database operations performance.
    
    Parameters
    ----------
    num_people : int
        Number of people to test with.
    descriptors_per_person : int
        Number of descriptors per person.
    
    Returns
    -------
    Dict[str, Any]
        Performance metrics for database operations.
    """
    results = {
        "profile_creation_time": None,
        "database_save_time": None,
        "database_load_time": None,
        "add_profile_time": None,
        "remove_profile_time": None,
        "add_descriptor_time": None,
        "operations_successful": True,
        "database_size": None
    }
    
    # Test profile creation
    start_time = time.time()
    database = {}
    for i in range(num_people):
        name = f"Person_{i+1}"
        descriptors = [generate_random_descriptor() for _ in range(descriptors_per_person)]
        database[name] = {
            "name": name,
            "descriptors": descriptors,
            "average_descriptor": np.mean(descriptors, axis=0)
        }
    results["profile_creation_time"] = time.time() - start_time
    
    # Test database save
    with tempfile.NamedTemporaryFile(delete=False, suffix='.pkl') as f:
        temp_path = f.name
    
    try:
        start_time = time.time()
        with open(temp_path, 'wb') as f:
            pickle.dump(database, f)
        results["database_save_time"] = time.time() - start_time
        
        # Get database file size
        results["database_size"] = os.path.getsize(temp_path)
        
        # Test database load
        start_time = time.time()
        with open(temp_path, 'rb') as f:
            loaded_database = pickle.load(f)
        results["database_load_time"] = time.time() - start_time
        
        # Verify loaded database matches original
        if set(database.keys()) != set(loaded_database.keys()):
            results["operations_successful"] = False
        
        # Test add profile
        start_time = time.time()
        new_name = "NewPerson"
        new_descriptors = [generate_random_descriptor() for _ in range(descriptors_per_person)]
        loaded_database[new_name] = {
            "name": new_name,
            "descriptors": new_descriptors,
            "average_descriptor": np.mean(new_descriptors, axis=0)
        }
        results["add_profile_time"] = time.time() - start_time
        
        # Test remove profile
        start_time = time.time()
        del loaded_database[new_name]
        results["remove_profile_time"] = time.time() - start_time
        
        # Test add descriptor
        start_time = time.time()
        test_name = list(loaded_database.keys())[0]
        loaded_database[test_name]["descriptors"].append(generate_random_descriptor())
        loaded_database[test_name]["average_descriptor"] = np.mean(
            loaded_database[test_name]["descriptors"], axis=0
        )
        results["add_descriptor_time"] = time.time() - start_time
        
    finally:
        # Clean up temporary file
        if os.path.exists(temp_path):
            os.unlink(temp_path)
    
    return results


def benchmark_database_search(
    database: Dict[str, Any],
    query_descriptors: List[np.ndarray],
    threshold: float = 0.5
) -> Dict[str, Any]:
    """
    Benchmark database search performance.
    
    Parameters
    ----------
    database : Dict[str, Any]
        Database of face profiles.
    query_descriptors : List[np.ndarray]
        List of query descriptor vectors to search for.
    threshold : float
        Maximum cosine distance for a match.
    
    Returns
    -------
    Dict[str, Any]
        Search performance metrics.
    """
    from facial_recognition_benchmark.utils import cosine_distance
    
    results = {
        "search_time": None,
        "matches_found": 0,
        "searches_per_second": None,
        "matches": []
    }
    
    search_times = []
    
    for query_desc in query_descriptors:
        best_match = None
        best_distance = float('inf')
        
        start_time = time.time()
        
        for name, profile in database.items():
            # Compare with average descriptor
            distance = cosine_distance(query_desc, profile["average_descriptor"])
            
            if distance < best_distance:
                best_distance = distance
                best_match = name
        
        search_time = time.time() - start_time
        search_times.append(search_time)
        
        # Check if match is within threshold
        if best_distance <= threshold and best_match is not None:
            results["matches_found"] += 1
            results["matches"].append({
                "query_descriptor": query_desc,
                "matched_name": best_match,
                "distance": best_distance
            })
    
    if search_times:
        results["search_time"] = np.mean(search_times)
        results["searches_per_second"] = 1.0 / results["search_time"] if results["search_time"] > 0 else 0
    
    return results


def benchmark_database_scalability(
    person_counts: List[int] = None,
    descriptors_per_person: int = 5
) -> Dict[str, Any]:
    """
    Benchmark database performance scalability.
    
    Parameters
    ----------
    person_counts : List[int], optional
        List of person counts to test.
    descriptors_per_person : int
        Number of descriptors per person.
    
    Returns
    -------
    Dict[str, Any]
        Scalability metrics.
    """
    if person_counts is None:
        person_counts = [10, 50, 100, 500, 1000]
    
    results = {
        "person_counts": person_counts,
        "creation_times": [],
        "save_times": [],
        "load_times": [],
        "search_times": [],
        "file_sizes": []
    }
    
    for num_people in person_counts:
        # Create database
        start_time = time.time()
        database = {}
        for i in range(num_people):
            name = f"Person_{i+1}"
            descriptors = [generate_random_descriptor() for _ in range(descriptors_per_person)]
            database[name] = {
                "name": name,
                "descriptors": descriptors,
                "average_descriptor": np.mean(descriptors, axis=0)
            }
        creation_time = time.time() - start_time
        results["creation_times"].append(creation_time)
        
        # Save database
        with tempfile.NamedTemporaryFile(delete=False, suffix='.pkl') as f:
            temp_path = f.name
        
        try:
            start_time = time.time()
            with open(temp_path, 'wb') as f:
                pickle.dump(database, f)
            save_time = time.time() - start_time
            results["save_times"].append(save_time)
            
            # Get file size
            file_size = os.path.getsize(temp_path)
            results["file_sizes"].append(file_size)
            
            # Load database
            start_time = time.time()
            with open(temp_path, 'rb') as f:
                loaded_database = pickle.load(f)
            load_time = time.time() - start_time
            results["load_times"].append(load_time)
            
            # Test search performance
            query_descriptors = [generate_random_descriptor() for _ in range(5)]
            search_result = benchmark_database_search(
                loaded_database, query_descriptors, threshold=0.5
            )
            results["search_times"].append(search_result["search_time"])
            
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
    
    return results
