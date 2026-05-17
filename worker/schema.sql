CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  ip TEXT,
  ts INTEGER NOT NULL
);

-- Used by retention purge.
CREATE INDEX IF NOT EXISTS idx_submissions_ts ON submissions (ts DESC);

-- Used by per-IP rate limit lookup; covers the (ip, ts > ?) predicate.
CREATE INDEX IF NOT EXISTS idx_submissions_ip_ts ON submissions (ip, ts DESC);
