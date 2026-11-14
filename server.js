const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const RADIUS_M = 10_000;   // 10 km
const MAX_ACTIVE = 3;      // spam limit per user

// Pooled connections; run several instances behind a load balancer for 100K concurrent requests.
const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 50 });
const app = express();
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

// Placeholder auth: replace with JWT/session in production.
app.use((req, res, next) => {
  const id = Number(req.header('x-user-id'));
  if (!id) return res.status(401).json({ error: 'Sign in first.' });
  req.userId = id;
  next();
});

const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Server error' }); });

// Feed: active posts within 10 km of the caller's position, nearest first.
app.get('/feed', wrap(async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return res.status(400).json({ error: 'lat and lng are required.' });
  const { rows } = await db.query(
    `SELECT p.id, p.type, p.category, p.title, p.status, p.expires_at,
            ST_Distance(p.location, ST_MakePoint($2,$1)::geography) / 1000 AS distance_km,
            u.name AS author, r.points AS author_points, r.level AS author_level
       FROM posts p
       JOIN users u ON u.id = p.user_id
       JOIN user_reputation r ON r.user_id = u.id
      WHERE p.expires_at > now()
        AND p.status <> 'done'
        AND ST_DWithin(p.location, ST_MakePoint($2,$1)::geography, $3)
        AND ($4::text IS NULL OR p.category = $4)
      ORDER BY distance_km
      LIMIT 100`,
    [lat, lng, RADIUS_M, req.query.category || null]);
  res.json(rows);
}));

// Create a post: enforces radius and the 3-active-posts limit.
app.post('/posts', wrap(async (req, res) => {
  const { type, category, title, lat, lng } = req.body;
  if (!['request', 'offer'].includes(type) || !category || !title || title.length < 5 || title.length > 90)
    return res.status(400).json({ error: 'Check the type, category and title (5-90 characters).' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.userId]); // serialises concurrent posts by one user
    const active = await client.query(
      `SELECT COUNT(*)::int AS n FROM posts WHERE user_id=$1 AND status<>'done' AND expires_at>now()`, [req.userId]);
    if (active.rows[0].n >= MAX_ACTIVE) {
      await client.query('ROLLBACK');
      return res.status(429).json({ error: 'You already have 3 active posts.' });
    }
    const near = await client.query(
      `SELECT ST_DWithin(home, ST_MakePoint($2,$1)::geography, $3) AS ok FROM users WHERE id=$4`,
      [lat, lng, RADIUS_M, req.userId]);
    if (!near.rows[0]?.ok) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Posts must be within 10 km of your location.' });
    }
    const ins = await client.query(
      `INSERT INTO posts (user_id,type,category,title,location)
       VALUES ($1,$2,$3,$4,ST_MakePoint($6,$5)::geography) RETURNING *`,
      [req.userId, type, category, title, lat, lng]);
    await client.query('COMMIT');
    res.status(201).json(ins.rows[0]);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

// Suggested matches: opposite type, same category, within 10 km of the post.
app.get('/posts/:id/matches', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT q.id, q.type, q.title, ST_Distance(q.location, p.location)/1000 AS distance_km
       FROM posts p
       JOIN posts q ON q.type <> p.type AND q.category = p.category AND q.id <> p.id
                   AND q.user_id <> p.user_id AND q.status='open' AND q.expires_at > now()
                   AND ST_DWithin(q.location, p.location, $2)
      WHERE p.id = $1
      ORDER BY distance_km LIMIT 20`, [req.params.id, RADIUS_M]);
  res.json(rows);
}));

// Match: claim an open post (atomic, so only one person wins).
app.post('/posts/:id/match', wrap(async (req, res) => {
  const { rowCount } = await db.query(
    `UPDATE posts SET status='matched', matched_with=$2
      WHERE id=$1 AND status='open' AND expires_at>now() AND user_id<>$2`,
    [req.params.id, req.userId]);
  if (!rowCount) return res.status(409).json({ error: 'This post is no longer available.' });
  res.json({ ok: true });
}));

// Complete: either side confirms; creates the exchange that raises both reputations.
app.post('/posts/:id/complete', wrap(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE posts SET status='done'
        WHERE id=$1 AND status='matched' AND $2 IN (user_id, matched_with)
        RETURNING id, user_id, matched_with`, [req.params.id, req.userId]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Nothing to complete.' }); }
    await client.query('INSERT INTO exchanges (post_id,user_a,user_b) VALUES ($1,$2,$3)',
      [rows[0].id, rows[0].user_id, rows[0].matched_with]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

// Trust Score badge for a profile.
app.get('/users/:id/trust', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT points, level FROM user_reputation WHERE user_id=$1', [req.params.id]);
  rows.length ? res.json(rows[0]) : res.status(404).json({ error: 'User not found.' });
}));

app.listen(process.env.PORT || 3000, () => console.log('API running'));
