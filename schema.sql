CREATE TABLE IF NOT EXISTS spots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  description TEXT,
  category TEXT,
  photo_url TEXT,
  rating REAL,
  rating_count INTEGER DEFAULT 0,
  source TEXT DEFAULT 'google',
  trending_score REAL DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_spots_location ON spots(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_spots_trending ON spots(trending_score DESC);
CREATE INDEX IF NOT EXISTS idx_spots_category ON spots(category);
