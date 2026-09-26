"""
Database class for managing face profiles.
"""

import pickle
import os
import numpy as np
from typing import Dict, List, Optional, Tuple
from face_recognition.profile import Profile


class Database:
    """
    Database for storing and managing face profiles.
    
    Attributes
    ----------
    profiles : Dict[str, Profile]
        Dictionary mapping names to Profile objects.
    """
    
    def __init__(self):
        """Initialize empty database."""
        self.profiles: Dict[str, Profile] = {}
    
    def add_profile(self, name: str, descriptors: Optional[List[np.ndarray]] = None) -> Profile:
        """
        Add a new profile to the database.
        
        Parameters
        ----------
        name : str
            Name of the person.
        descriptors : List[np.ndarray], optional
            Initial face descriptors.
        
        Returns
        -------
        Profile
            The created or updated profile.
        """
        if name in self.profiles:
            # Profile exists, add descriptors
            if descriptors:
                for desc in descriptors:
                    self.profiles[name].add_descriptor(desc)
        else:
            # Create new profile
            self.profiles[name] = Profile(name, descriptors)
        
        return self.profiles[name]
    
    def remove_profile(self, name: str) -> bool:
        """
        Remove a profile from the database.
        
        Parameters
        ----------
        name : str
            Name of the person to remove.
        
        Returns
        -------
        bool
            True if profile was removed, False if not found.
        """
        if name in self.profiles:
            del self.profiles[name]
            return True
        return False
    
    def get_profile(self, name: str) -> Optional[Profile]:
        """
        Get a profile by name.
        
        Parameters
        ----------
        name : str
            Name of the person.
        
        Returns
        -------
        Profile or None
            The profile if found, None otherwise.
        """
        return self.profiles.get(name)
    
    def has_profile(self, name: str) -> bool:
        """Check if profile exists."""
        return name in self.profiles
    
    def add_descriptor_to_profile(self, name: str, descriptor: np.ndarray) -> bool:
        """
        Add a descriptor to an existing profile.
        
        Parameters
        ----------
        name : str
            Name of the person.
        descriptor : np.ndarray
            Face descriptor vector.
        
        Returns
        -------
        bool
            True if descriptor was added, False if profile not found.
        """
        if name in self.profiles:
            self.profiles[name].add_descriptor(descriptor)
            return True
        return False
    
    def get_all_names(self) -> List[str]:
        """Return list of all profile names."""
        return list(self.profiles.keys())
    
    def num_profiles(self) -> int:
        """Return number of profiles."""
        return len(self.profiles)
    
    def save(self, filepath: str) -> None:
        """
        Save database to file using pickle.
        
        Parameters
        ----------
        filepath : str
            Path to save the database.
        """
        data = {name: profile.to_dict() for name, profile in self.profiles.items()}
        with open(filepath, 'wb') as f:
            pickle.dump(data, f)
    
    @classmethod
    def load(cls, filepath: str) -> 'Database':
        """
        Load database from file.
        
        Parameters
        ----------
        filepath : str
            Path to the saved database.
        
        Returns
        -------
        Database
            Loaded database instance.
        """
        with open(filepath, 'rb') as f:
            data = pickle.load(f)
        
        db = cls()
        for name, profile_data in data.items():
            db.profiles[name] = Profile.from_dict(profile_data)
        
        return db
    
    def __repr__(self) -> str:
        return f"Database(num_profiles={len(self.profiles)})"
