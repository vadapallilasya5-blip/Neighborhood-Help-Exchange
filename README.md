# Setup
1. Create a PostgreSQL database and run: psql $DATABASE_URL -f schema.sql   (needs PostGIS)
2. npm install
3. DATABASE_URL=postgres://user:pass@host/db npm start
4. Send requests with header  x-user-id: <id>   (replace with real auth)

# Scaling to 100K concurrent requests
- Run many stateless API instances behind a load balancer (the connection pool is per instance, so use PgBouncer).
- Add read replicas for GET /feed; cache hot feed queries in Redis by geohash cell for 15-30 seconds.
- The GiST index on posts.location makes the 10 km search fast; a cron job can delete rows past expires_at.
