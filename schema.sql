CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE users (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  home        GEOGRAPHY(Point,4326) NOT NULL
);

CREATE TABLE posts (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL CHECK (type IN ('request','offer')),
  category    TEXT NOT NULL,
  title       TEXT NOT NULL CHECK (char_length(title) BETWEEN 5 AND 90),
  location    GEOGRAPHY(Point,4326) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','done')),
  matched_with BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '48 hours'
);
CREATE INDEX posts_geo_idx    ON posts USING GIST (location);
CREATE INDEX posts_active_idx ON posts (status, expires_at);
CREATE INDEX posts_user_idx   ON posts (user_id, status);

CREATE TABLE exchanges (
  id         BIGSERIAL PRIMARY KEY,
  post_id    BIGINT UNIQUE NOT NULL REFERENCES posts(id),
  user_a     BIGINT NOT NULL REFERENCES users(id),
  user_b     BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reputation is a calculated field: 10 points per completed exchange.
CREATE VIEW user_reputation AS
SELECT u.id AS user_id,
       COUNT(e.id) * 10 AS points,
       CASE WHEN COUNT(e.id) * 10 >= 60 THEN 'Pillar'
            WHEN COUNT(e.id) * 10 >= 30 THEN 'Trusted'
            WHEN COUNT(e.id) * 10 >= 10 THEN 'Neighbor'
            ELSE 'New' END AS level
FROM users u
LEFT JOIN exchanges e ON u.id IN (e.user_a, e.user_b)
GROUP BY u.id;
