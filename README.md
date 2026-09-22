# GraphReview

A locally-run tool for reviewing GitHub pull requests against a codebase's
component graph. See [`docs/DESIGN.md`](docs/DESIGN.md) for the full
architecture and product spec.

This is currently a project **skeleton**: navigation and screens exist as
placeholders, with no real Neo4j queries, static analysis, GitHub calls, or
AI integration wired up yet.

## Quickstart (Docker Compose — recommended)

```bash
cp docker/.env.example docker/.env
# edit docker/.env: set LOCAL_REPOS_PATH, NEO4J_PASSWORD, SESSION_SECRET

docker compose -f docker/docker-compose.yml --env-file docker/.env up
```

The app is served at [http://localhost:3000](http://localhost:3000). Neo4j
and Redis run as internal-only services (not published to the host) — see
`docs/DESIGN.md` §11–§12.

## Local development (without Docker)

```bash
npm install
npm run dev       # Next.js dev server, http://localhost:3000
npm run worker    # BullMQ worker process (separate terminal)
```

You'll need your own Neo4j 5 and Redis instances reachable via the env vars
in `docker/.env.example` (`NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`,
`REDIS_URL`, `SESSION_SECRET`).

## Project layout

See `docs/DESIGN.md` §13 for the full module/folder structure. Each
`lib/*`, `worker/`, `types/`, and `components/graph/` directory has its own
`README.md` stating what belongs there.
