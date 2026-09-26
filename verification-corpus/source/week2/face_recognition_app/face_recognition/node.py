"""
Node class for representing nodes in the Whispers algorithm graph.
"""

from typing import List, Optional, Tuple
import numpy as np


class Node:
    """
    Represents a node in the Whispers algorithm graph.
    
    Each node corresponds to a face image and stores:
    - A unique ID
    - A label (updated during clustering)
    - Neighbor connections
    - The face descriptor vector
    - Optional ground truth and file path
    
    Attributes
    ----------
    id : int
        Unique identifier for this node.
    label : int
        Cluster label (initialized with node ID).
    neighbors : Tuple[int, ...]
        IDs of neighboring nodes.
    descriptor : np.ndarray
        Shape-(512,) descriptor vector.
    truth : str, optional
        Ground truth label for validation.
    file_path : str, optional
        File path of corresponding image.
    """
    
    def __init__(
        self,
        ID: int,
        neighbors: List[int],
        descriptor: np.ndarray,
        truth: Optional[str] = None,
        file_path: Optional[str] = None
    ):
        """
        Initialize a Node.
        
        Parameters
        ----------
        ID : int
            Unique identifier. Should be in range [0, N-1] for N nodes.
        neighbors : List[int]
            Node IDs of neighbors.
        descriptor : np.ndarray
            Shape-(512,) descriptor vector.
        truth : str, optional
            Ground truth label.
        file_path : str, optional
            Path to corresponding image file.
        """
        self.id = ID
        self.label = ID  # Initialize with unique label
        self.neighbors = tuple(neighbors)
        self.descriptor = descriptor
        self.truth = truth
        self.file_path = file_path
    
    def __repr__(self) -> str:
        return f"Node(id={self.id}, label={self.label}, neighbors={len(self.neighbors)})"
