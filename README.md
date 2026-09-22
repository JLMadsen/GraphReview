# GraphReview

A locally-run tool for reviewing GitHub pull requests and GitLab merge
requests against a codebase's component graph. See
[`docs/DESIGN.md`](docs/DESIGN.md) for the full architecture and product
spec.

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

## Running your own AI

GraphReview's labeling and PR review features call an OpenAI-compatible
`/v1/chat/completions` endpoint — it isn't tied to a specific provider, so a
locally-run model works as a drop-in replacement for a hosted API key.
[Ollama](https://ollama.com) is the easiest option since it's a native
install on both Windows and Ubuntu (no GPU-in-Docker setup required) and
speaks the same API shape.

**1. Install Ollama and pull a model**

Windows: download and run the installer from [ollama.com/download](https://ollama.com/download).

Ubuntu:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Then, on either OS, pull a small instruct model (a quantized 7-8B model is
enough for labeling/intent and fits an 8GB GPU like a 3070; review quality
will be well below a hosted frontier model):

```bash
ollama pull qwen2.5:7b-instruct
```

Ollama listens on `http://localhost:11434` and exposes an OpenAI-compatible
API at `/v1`.

**2. Point GraphReview at it**

The AI provider isn't configured via env vars — it's set on the app's
**Settings** page (base URL, API key, model name), stored encrypted in
Neo4j (`docs/DESIGN.md` §11). Use:

| Field | Value |
|---|---|
| Base URL | `http://localhost:11434/v1` (running `npm run dev` outside Docker) or `http://host.docker.internal:11434/v1` (running via Docker Compose — Ollama stays on the host, not in a container) |
| API key | any placeholder string, e.g. `local` — Ollama doesn't check it |
| Model | the tag you pulled, e.g. `qwen2.5:7b-instruct` |

Use **Test connection** on the Settings page to confirm it's reachable.

`docker/docker-compose.yml` already maps `host.docker.internal` to the host
gateway for both `app` and `worker`, so the Docker Compose base URL above
works the same on Windows and Ubuntu.

## Project layout

See `docs/DESIGN.md` §13 for the full module/folder structure. Each
`lib/*`, `worker/`, `types/`, and `components/graph/` directory has its own
`README.md` stating what belongs there.
