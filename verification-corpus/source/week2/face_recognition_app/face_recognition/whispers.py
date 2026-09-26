"""
Whispers algorithm implementation for clustering face images.
"""

import numpy as np
from typing import List, Dict, Tuple, Optional
from face_recognition.node import Node


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
        Cosine distance (0 = identical, 1 = orthogonal, 2 = opposite).
    """
    dot_product = np.dot(descriptor1, descriptor2)
    norm1 = np.linalg.norm(descriptor1)
    norm2 = np.linalg.norm(descriptor2)
    
    if norm1 == 0 or norm2 == 0:
        return 1.0
    
    return 1.0 - (dot_product / (norm1 * norm2))


def create_graph(
    descriptors: List[np.ndarray],
    threshold: float = 0.5,
    weighted: bool = True,
    file_paths: Optional[List[str]] = None,
    truths: Optional[List[str]] = None
) -> Tuple[List[Node], np.ndarray]:
    """
    Create graph nodes and adjacency matrix from descriptors.
    
    Parameters
    ----------
    descriptors : List[np.ndarray]
        List of descriptor vectors.
    threshold : float
        Maximum cosine distance for an edge.
    weighted : bool
        Whether to use weighted edges (1/distance^2).
    file_paths : List[str], optional
        File paths for each descriptor.
    truths : List[str], optional
        Ground truth labels.
    
    Returns
    -------
    Tuple[List[Node], np.ndarray]
        List of nodes and adjacency matrix.
    """
    n = len(descriptors)
    adj = np.zeros((n, n))
    
    # Calculate pairwise distances and build adjacency matrix
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
        
        file_path = file_paths[i] if file_paths and i < len(file_paths) else None
        truth = truths[i] if truths and i < len(truths) else None
        
        node = Node(
            ID=i,
            neighbors=neighbors,
            descriptor=descriptors[i],
            truth=truth,
            file_path=file_path
        )
        nodes.append(node)
    
    return nodes, adj


def propagate_label(
    node: Node,
    nodes: List[Node],
    adj: np.ndarray,
    weighted: bool = True
) -> None:
    """
    Propagate label to a node based on its neighbors.
    
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
    
    label_weights: Dict[int, float] = {}
    label_counts: Dict[int, int] = {}
    
    for neighbor_id in node.neighbors:
        neighbor = nodes[neighbor_id]
        label = neighbor.label
        
        if weighted:
            weight = adj[node.id, neighbor_id]
            label_weights[label] = label_weights.get(label, 0) + weight
        else:
            label_counts[label] = label_counts.get(label, 0) + 1
    
    if weighted and label_weights:
        max_weight = max(label_weights.values())
        candidates = [label for label, weight in label_weights.items() 
                     if weight == max_weight]
        node.label = np.random.choice(candidates)
    elif label_counts:
        max_count = max(label_counts.values())
        candidates = [label for label, count in label_counts.items() 
                     if count == max_count]
        node.label = np.random.choice(candidates)


def connected_components(nodes: List[Node]) -> List[List[int]]:
    """
    Find connected components based on node labels.
    
    Parameters
    ----------
    nodes : List[Node]
        All nodes in graph.
    
    Returns
    -------
    List[List[int]]
        List of lists, each containing node IDs with the same label.
    """
    label_to_nodes: Dict[int, List[int]] = {}
    
    for node in nodes:
        if node.label not in label_to_nodes:
            label_to_nodes[node.label] = []
        label_to_nodes[node.label].append(node.id)
    
    return list(label_to_nodes.values())


def whispers(
    descriptors: List[np.ndarray],
    threshold: float = 0.5,
    max_iterations: int = 100,
    weighted: bool = True,
    file_paths: Optional[List[str]] = None,
    truths: Optional[List[str]] = None
) -> Dict:
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
    file_paths : List[str], optional
        File paths for each descriptor.
    truths : List[str], optional
        Ground truth labels for validation.
    
    Returns
    -------
    Dict
        Results containing:
        - nodes: List of Node objects
        - adjacency: Adjacency matrix
        - num_clusters: Number of clusters found
        - labels: Final labels for each node
        - converged: Whether algorithm converged
        - iterations: Number of iterations run
        - clusters: Dict mapping cluster labels to node IDs
    """
    if len(descriptors) == 0:
        return {
            "nodes": [],
            "adjacency": np.array([]),
            "num_clusters": 0,
            "labels": [],
            "converged": False,
            "iterations": 0,
            "clusters": {}
        }
    
    # Create graph
    nodes, adj = create_graph(descriptors, threshold, weighted, file_paths, truths)
    
    # Run complete randomized sweeps. Checking convergence after a single node
    # update can stop immediately even though most of the graph was untouched.
    converged = False
    iterations = 0
    
    for iteration in range(max_iterations):
        previous_labels = [node.label for node in nodes]
        for node_idx in np.random.permutation(len(nodes)):
            propagate_label(nodes[node_idx], nodes, adj, weighted)

        if [node.label for node in nodes] == previous_labels:
            converged = True
            iterations = iteration + 1
            break
    
    if not converged:
        iterations = max_iterations
    
    # Extract final clustering
    final_labels = [node.label for node in nodes]
    clusters = {}
    for node in nodes:
        if node.label not in clusters:
            clusters[node.label] = []
        clusters[node.label].append(node.id)
    
    return {
        "nodes": nodes,
        "adjacency": adj,
        "num_clusters": len(clusters),
        "labels": final_labels,
        "converged": converged,
        "iterations": iterations,
        "clusters": clusters
    }


def organize_photos_by_cluster(
    results: Dict,
    output_dir: str
) -> Dict[int, List[str]]:
    """
    Organize photos into folders based on clustering results.
    
    Parameters
    ----------
    results : Dict
        Output from whispers() function.
    output_dir : str
        Directory to organize photos into.
    
    Returns
    -------
    Dict[int, List[str]]
        Mapping of cluster labels to file paths.
    """
    import os
    
    cluster_files: Dict[int, List[str]] = {}
    
    for node in results["nodes"]:
        if node.file_path:
            label = node.label
            if label not in cluster_files:
                cluster_files[label] = []
            cluster_files[label].append(node.file_path)
            
            # Create directory if it doesn't exist
            cluster_dir = os.path.join(output_dir, f"cluster_{label}")
            os.makedirs(cluster_dir, exist_ok=True)
    
    return cluster_files
