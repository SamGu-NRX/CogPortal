"""
Whispers Algorithm Benchmark Module

Tests the Whispers clustering algorithm including:
- Clustering accuracy with known ground truth
- Convergence behavior
- Weighted vs. unweighted edge performance
- Clustering speed
"""

import numpy as np
import time
from typing import List, Dict, Any, Optional, Tuple
from facial_recognition_benchmark.utils import cosine_distance, cosine_distance_matrix


class Node:
    """Represents a node in the Whispers algorithm graph."""
    
    def __init__(self, ID: int, neighbors: List[int], descriptor: np.ndarray, 
                 truth: Optional[str] = None, file_path: Optional[str] = None):
        """
        Initialize a node.
        
        Parameters
        ----------
        ID : int
            Unique identifier for this node.
        neighbors : List[int]
            Node IDs of neighbors.
        descriptor : np.ndarray
            Shape-(512,) descriptor vector.
        truth : str, optional
            Ground truth label for validation.
        file_path : str, optional
            File path of corresponding image.
        """
        self.id = ID
        self.label = ID  # Initialize with unique label
        self.neighbors = tuple(neighbors)
        self.descriptor = descriptor
        self.truth = truth
        self.file_path = file_path


def create_adjacency_matrix(
    descriptors: List[np.ndarray],
    threshold: float = 0.5,
    weighted: bool = True
) -> Tuple[np.ndarray, List[Node]]:
    """
    Create adjacency matrix and nodes from descriptors.
    
    Parameters
    ----------
    descriptors : List[np.ndarray]
        List of descriptor vectors.
    threshold : float
        Maximum cosine distance for an edge.
    weighted : bool
        Whether to use weighted edges.
    
    Returns
    -------
    Tuple[np.ndarray, List[Node]]
        Adjacency matrix and list of nodes.
    """
    n = len(descriptors)
    adj = np.zeros((n, n))
    
    # Calculate pairwise distances
    for i in range(n):
        for j in range(i + 1, n):
            distance = cosine_distance(descriptors[i], descriptors[j])
            
            if distance < threshold:
                if weighted:
                    weight = 1.0 / (distance ** 2) if distance > 0 else 1e6
                    adj[i, j] = weight
                    adj[j, i] = weight
                else:
                    adj[i, j] = 1.0
                    adj[j, i] = 1.0
    
    # Create nodes
    nodes = []
    for i in range(n):
        neighbors = [j for j in range(n) if adj[i, j] > 0]
        node = Node(ID=i, neighbors=neighbors, descriptor=descriptors[i])
        nodes.append(node)
    
    return adj, nodes


def propagate_label(
    node: Node,
    nodes: List[Node],
    adj: np.ndarray,
    weighted: bool = True
) -> None:
    """
    Propagate label to a node based on neighbors.
    
    Parameters
    ----------
    node : Node
        Node to update.
    nodes : List[Node]
        All nodes in graph.
    adj : np.ndarray
        Adjacency matrix.
    weighted : bool
        Whether to use weighted edges.
    """
    if not node.neighbors:
        return
    
    # Count labels among neighbors
    label_counts = {}
    label_weights = {}
    
    for neighbor_id in node.neighbors:
        neighbor = nodes[neighbor_id]
        label = neighbor.label
        
        if weighted:
            weight = adj[node.id, neighbor_id]
            label_weights[label] = label_weights.get(label, 0) + weight
        else:
            label_counts[label] = label_counts.get(label, 0) + 1
    
    if weighted:
        # Choose label with highest weight sum
        if label_weights:
            max_weight = max(label_weights.values())
            candidates = [label for label, weight in label_weights.items() 
                        if weight == max_weight]
            node.label = np.random.choice(candidates)
    else:
        # Choose most frequent label
        if label_counts:
            max_count = max(label_counts.values())
            candidates = [label for label, count in label_counts.items() 
                        if count == max_count]
            node.label = np.random.choice(candidates)


def whispers(
    descriptors: List[np.ndarray],
    threshold: float = 0.5,
    max_iterations: int = 100,
    weighted: bool = True,
    ground_truth: Optional[List[str]] = None
) -> Dict[str, Any]:
    """
    Run the Whispers clustering algorithm.
    
    Parameters
    ----------
    descriptors : List[np.ndarray]
        List of descriptor vectors.
    threshold : float
        Maximum cosine distance for an edge.
    max_iterations : int
        Maximum number of iterations.
    weighted : bool
        Whether to use weighted edges.
    ground_truth : List[str], optional
        Ground truth labels for validation.
    
    Returns
    -------
    Dict[str, Any]
        Clustering results including labels and metrics.
    """
    results = {
        "num_clusters": 0,
        "iterations_to_converge": 0,
        "converged": False,
        "labels": [],
        "clusters": {},
        "purity": None,
        "nmi": None
    }
    
    if len(descriptors) == 0:
        return results
    
    # Create graph
    adj, nodes = create_adjacency_matrix(descriptors, threshold, weighted)
    
    # Run complete randomized sweeps so convergence reflects the whole graph,
    # rather than one randomly selected node.
    for iteration in range(max_iterations):
        previous_labels = [node.label for node in nodes]
        for node_idx in np.random.permutation(len(nodes)):
            propagate_label(nodes[node_idx], nodes, adj, weighted)

        if [node.label for node in nodes] == previous_labels:
            results["converged"] = True
            results["iterations_to_converge"] = iteration + 1
            break
    
    if not results["converged"]:
        results["iterations_to_converge"] = max_iterations
    
    # Extract final clustering
    results["num_clusters"] = len(set(node.label for node in nodes))
    results["labels"] = [node.label for node in nodes]
    
    # Group nodes by cluster
    for node in nodes:
        label = node.label
        if label not in results["clusters"]:
            results["clusters"][label] = []
        results["clusters"][label].append(node.id)
    
    # Calculate purity if ground truth provided
    if ground_truth and len(ground_truth) == len(nodes):
        results["purity"] = calculate_purity(results["labels"], ground_truth)
        results["nmi"] = calculate_nmi(results["labels"], ground_truth)
    
    return results


def calculate_purity(predicted_labels: List[int], true_labels: List[str]) -> float:
    """
    Calculate clustering purity.
    
    Parameters
    ----------
    predicted_labels : List[int]
        Predicted cluster labels.
    true_labels : List[str]
        True class labels.
    
    Returns
    -------
    float
        Purity score (0 to 1).
    """
    # Create mapping from cluster to true labels
    cluster_true_labels = {}
    for pred, true in zip(predicted_labels, true_labels):
        if pred not in cluster_true_labels:
            cluster_true_labels[pred] = []
        cluster_true_labels[pred].append(true)
    
    # Calculate purity
    total_correct = 0
    for cluster, labels in cluster_true_labels.items():
        # Count most common true label in this cluster
        label_counts = {}
        for label in labels:
            label_counts[label] = label_counts.get(label, 0) + 1
        total_correct += max(label_counts.values())
    
    return total_correct / len(predicted_labels) if predicted_labels else 0.0


def calculate_nmi(predicted_labels: List[int], true_labels: List[str]) -> float:
    """
    Calculate Normalized Mutual Information.
    
    Parameters
    ----------
    predicted_labels : List[int]
        Predicted cluster labels.
    true_labels : List[str]
        True class labels.
    
    Returns
    -------
    float
        NMI score (0 to 1).
    """
    from collections import Counter
    
    n = len(predicted_labels)
    if n == 0:
        return 0.0
    
    # Count joint and marginal distributions
    pred_counter = Counter(predicted_labels)
    true_counter = Counter(true_labels)
    
    # Calculate mutual information
    mi = 0.0
    for pred_label in set(predicted_labels):
        for true_label in set(true_labels):
            # Count joint occurrences
            joint_count = sum(1 for p, t in zip(predicted_labels, true_labels) 
                           if p == pred_label and t == true_label)
            
            if joint_count > 0:
                p_pred = pred_counter[pred_label] / n
                p_true = true_counter[true_label] / n
                p_joint = joint_count / n
                
                mi += p_joint * np.log(p_joint / (p_pred * p_true))
    
    # Calculate entropies
    entropy_pred = -sum((count/n) * np.log(count/n) 
                       for count in pred_counter.values())
    entropy_true = -sum((count/n) * np.log(count/n) 
                       for count in true_counter.values())
    
    # Calculate NMI
    if entropy_pred == 0 or entropy_true == 0:
        return 0.0
    
    nmi = 2 * mi / (entropy_pred + entropy_true)
    return max(0.0, min(1.0, nmi))


def benchmark_whispers_clustering(
    descriptors: List[np.ndarray],
    ground_truth: Optional[List[str]] = None,
    threshold: float = 0.5,
    num_runs: int = 5,
    weighted: bool = True
) -> Dict[str, Any]:
    """
    Benchmark Whispers clustering performance.
    
    Parameters
    ----------
    descriptors : List[np.ndarray]
        List of descriptor vectors.
    ground_truth : List[str], optional
        Ground truth labels for validation.
    threshold : float
        Maximum cosine distance for an edge.
    num_runs : int
        Number of runs to average.
    weighted : bool
        Whether to use weighted edges.
    
    Returns
    -------
    Dict[str, Any]
        Clustering performance metrics.
    """
    results = {
        "avg_num_clusters": 0,
        "avg_iterations": 0,
        "convergence_rate": 0,
        "avg_purity": None,
        "avg_nmi": None,
        "avg_clustering_time": 0,
        "runs": []
    }
    
    cluster_counts = []
    iteration_counts = []
    convergence_count = 0
    purity_scores = []
    nmi_scores = []
    clustering_times = []
    
    for _ in range(num_runs):
        start_time = time.time()
        run_result = whispers(
            descriptors, 
            threshold=threshold, 
            weighted=weighted,
            ground_truth=ground_truth
        )
        clustering_time = time.time() - start_time
        
        cluster_counts.append(run_result["num_clusters"])
        iteration_counts.append(run_result["iterations_to_converge"])
        
        if run_result["converged"]:
            convergence_count += 1
        
        if run_result["purity"] is not None:
            purity_scores.append(run_result["purity"])
        
        if run_result["nmi"] is not None:
            nmi_scores.append(run_result["nmi"])
        
        clustering_times.append(clustering_time)
        
        results["runs"].append({
            "num_clusters": run_result["num_clusters"],
            "iterations": run_result["iterations_to_converge"],
            "converged": run_result["converged"],
            "clustering_time": clustering_time
        })
    
    results["avg_num_clusters"] = np.mean(cluster_counts)
    results["avg_iterations"] = np.mean(iteration_counts)
    results["convergence_rate"] = convergence_count / num_runs
    
    if purity_scores:
        results["avg_purity"] = np.mean(purity_scores)
    
    if nmi_scores:
        results["avg_nmi"] = np.mean(nmi_scores)
    
    results["avg_clustering_time"] = np.mean(clustering_times)
    
    return results
