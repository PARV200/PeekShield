"""
PEEKSHIELD Database Module — SQLite Trusted Face Storage
Stores up to 4 trusted face profiles and their multi-sample 128-d SFace embeddings locally.
"""

import os
import sqlite3
import numpy as np


class ProfileDB:
    MAX_PROFILES = 4

    def __init__(self, db_path=None):
        if db_path is None:
            base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            db_path = os.path.join(base_dir, "database", "profiles.db")

        self.db_path = db_path
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self.init_db()

    def _get_connection(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def init_db(self):
        """Create tables if they don't exist."""
        with self._get_connection() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS trusted_profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS face_samples (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id INTEGER NOT NULL,
                    embedding BLOB NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (profile_id) REFERENCES trusted_profiles(id) ON DELETE CASCADE
                );
            """)

    def get_profile_count(self):
        """Return the number of registered trusted profiles."""
        with self._get_connection() as conn:
            cur = conn.execute("SELECT COUNT(*) AS cnt FROM trusted_profiles")
            return cur.fetchone()["cnt"]

    def can_register_new(self):
        """Check if maximum allowed profiles (4) is reached."""
        return self.get_profile_count() < self.MAX_PROFILES

    def add_profile(self, name):
        """
        Create a new trusted profile.
        Raises ValueError if name exists or 4 profiles are already registered.
        """
        name = name.strip()
        if not name:
            raise ValueError("Profile name cannot be empty.")

        if self.get_profile_count() >= self.MAX_PROFILES:
            raise ValueError(f"Maximum limit of {self.MAX_PROFILES} trusted profiles reached.")

        with self._get_connection() as conn:
            cur = conn.execute("INSERT INTO trusted_profiles (name) VALUES (?)", (name,))
            return cur.lastrowid

    def add_sample(self, profile_id, embedding):
        """
        Save a face sample embedding (128-d float32 numpy array or bytes).
        """
        if isinstance(embedding, np.ndarray):
            raw_bytes = embedding.astype(np.float32).tobytes()
        elif isinstance(embedding, bytes):
            raw_bytes = embedding
        else:
            raise TypeError("Embedding must be a numpy ndarray or bytes.")

        with self._get_connection() as conn:
            conn.execute(
                "INSERT INTO face_samples (profile_id, embedding) VALUES (?, ?)",
                (profile_id, raw_bytes)
            )

    def get_all_profiles(self):
        """Return metadata for all registered trusted profiles."""
        with self._get_connection() as conn:
            cur = conn.execute("""
                SELECT p.id, p.name, p.created_at, COUNT(s.id) AS sample_count
                FROM trusted_profiles p
                LEFT JOIN face_samples s ON p.id = s.profile_id
                GROUP BY p.id
                ORDER BY p.id ASC
            """)
            return [dict(row) for row in cur.fetchall()]

    def get_all_profile_embeddings(self):
        """
        Load all profile embeddings for real-time recognition.
        Returns:
            dict of {profile_id: {"name": str, "samples": [numpy_array, ...]}}
        """
        with self._get_connection() as conn:
            profiles = {}
            p_cur = conn.execute("SELECT id, name FROM trusted_profiles ORDER BY id ASC")
            for p in p_cur.fetchall():
                profiles[p["id"]] = {"name": p["name"], "samples": []}

            s_cur = conn.execute("SELECT profile_id, embedding FROM face_samples")
            for s in s_cur.fetchall():
                pid = s["profile_id"]
                if pid in profiles:
                    emb = np.frombuffer(s["embedding"], dtype=np.float32).reshape(1, 128)
                    profiles[pid]["samples"].append(emb)

            return profiles

    def delete_profile(self, profile_id):
        """Delete a profile and its associated face samples."""
        with self._get_connection() as conn:
            conn.execute("DELETE FROM trusted_profiles WHERE id = ?", (profile_id,))
            return True

    def clear_all(self):
        """Clear all profiles (for testing/reset)."""
        with self._get_connection() as conn:
            conn.execute("DELETE FROM trusted_profiles")
            return True

