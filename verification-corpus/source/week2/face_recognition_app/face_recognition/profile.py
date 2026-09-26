"""
Profile class for storing face descriptors associated with a named individual.
"""

import numpy as np
from typing import List, Optional


class Profile:
    """
    Represents a person's face profile in the database.
    
    Attributes
    ----------
    name : str
        The person's name.
    descriptors : List[np.ndarray]
        List of 512-dimensional face descriptor vectors.
    average_descriptor : np.ndarray
        Average of all descriptor vectors.
    """
    
    def __init__(self, name: str, descriptors: Optional[List[np.ndarray]] = None):
        """
        Initialize a Profile.
        
        Parameters
        ----------
        name : str
            The person's name.
        descriptors : List[np.ndarray], optional
            Initial list of descriptor vectors.
        """
        self.name = name
        self.descriptors = descriptors if descriptors is not None else []
        self.average_descriptor = self._compute_average()
    
    def _compute_average(self) -> np.ndarray:
        """Compute average descriptor from all stored descriptors."""
        if not self.descriptors:
            return np.zeros(512)
        return np.mean(self.descriptors, axis=0)
    
    def add_descriptor(self, descriptor: np.ndarray) -> None:
        """
        Add a new descriptor vector to this profile.
        
        Parameters
        ----------
        descriptor : np.ndarray, shape=(512,)
            Face descriptor vector to add.
        """
        self.descriptors.append(descriptor)
        self.average_descriptor = self._compute_average()
    
    def remove_descriptor(self, index: int) -> np.ndarray:
        """
        Remove a descriptor by index.
        
        Parameters
        ----------
        index : int
            Index of descriptor to remove.
        
        Returns
        -------
        np.ndarray
            The removed descriptor.
        """
        removed = self.descriptors.pop(index)
        self.average_descriptor = self._compute_average()
        return removed
    
    def num_descriptors(self) -> int:
        """Return number of descriptors stored."""
        return len(self.descriptors)
    
    def to_dict(self) -> dict:
        """Convert profile to dictionary for serialization."""
        return {
            "name": self.name,
            "descriptors": [d.tolist() for d in self.descriptors],
            "average_descriptor": self.average_descriptor.tolist()
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> 'Profile':
        """
        Create Profile from dictionary.
        
        Parameters
        ----------
        data : dict
            Dictionary with name, descriptors, and average_descriptor.
        
        Returns
        -------
        Profile
            New Profile instance.
        """
        descriptors = [np.array(d) for d in data.get("descriptors", [])]
        profile = cls(name=data["name"], descriptors=descriptors)
        return profile
    
    def __repr__(self) -> str:
        return f"Profile(name='{self.name}', num_descriptors={len(self.descriptors)})"
