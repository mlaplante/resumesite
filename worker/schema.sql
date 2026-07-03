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

-- Every POST that reaches the Turnstile check, accepted or not. The rate
-- limit counts these (rather than accepted submissions) so failed-challenge
-- spam is bounded too. Rows older than the rate-limit window are pruned
-- opportunistically on each recorded attempt.
CREATE TABLE IF NOT EXISTS contact_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_attempts_ip_ts ON contact_attempts (ip, ts DESC);
CREATE INDEX IF NOT EXISTS idx_contact_attempts_ts ON contact_attempts (ts DESC);
