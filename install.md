# Installing and running GraphReview

GraphReview is a locally-run Next.js app that reviews GitHub pull requests
against a statically-derived "component graph" of a codebase, with optional
AI-generated per-component summaries and intent checks. It's built as three
processes sharing one codebase: the **app** (Next.js web server), a
**worker** (BullMQ job consumer that does the actual static analysis and AI
calls), backed by **Neo4j** (graph storage) and **Redis** (job queue). See
[`docs/DESIGN.md`](docs/DESIGN.md) for the full architecture.

> **Note on the root README:** [`README.md`](README.md) currently describes
> the project as a "skeleton" with nothing wired up. That's stale —
> `docs/DESIGN.md` (§15) shows v1 and v2 are done (static analysis, the
> graph UI, GitHub integration, AI review, and AI labeling all work). This
> file reflects the current, more complete state; when in doubt, trust
> `docs/DESIGN.md`.

## 1. Prerequisites

| For | Need |
|---|---|
| Docker Compose install (recommended) | Docker Desktop (Windows/Mac) or Docker Engine + Compose plugin (Linux) |
| Local dev without Docker | Node.js 20+ (matches the Docker image's `node:20-alpine`; not pinned in `package.json`), `git` on `PATH`, and your own reachable **Neo4j 5** and **Redis** instances |
| Optional: running your own local AI model | [Ollama](https://ollama.com) (or any other OpenAI-compatible server) |

`package.json` has no `engines` field, so nothing enforces the Node version
locally — use Node 20+ to match what's actually tested (the container
image).

## 2. Install — Docker Compose (recommended)

This is decision #5 in the design doc: Compose is the primary, supported way
to run the app.

```bash
cp docker/.env.example docker/.env
# edit docker/.env — see §4 below for what's required vs. optional

npm run docker
```

`npm run docker` runs `docker compose -f docker/docker-compose.yml
--env-file docker/.env build && docker image prune -f && docker compose ...
up`. The app is served at [http://localhost:3000](http://localhost:3000).

**Caveats:**

- **Always use `npm run docker`, not `docker compose up --build` /
  `docker build` directly.** Rebuilding without pruning leaves the previous
  image dangling (`<none>:<none>`) and silently eats disk over repeated
  rebuilds, since the tag just moves to the new image. `npm run docker:build`
  builds+prunes without starting containers; `npm run docker:up` starts
  already-built images without rebuilding — only safe when you're sure
  nothing changed since the last build.
- **There is no bind-mounted source.** The image is built once from
  whatever's on disk at build time. Any code change requires re-running
  `npm run docker` (a rebuild) to take effect — editing files while the
  containers are up does nothing.
- **Both `app` and `worker` must be running.** The worker is what actually
  does static analysis, AI calls, *and* runs the one-time Neo4j schema
  migration (`runMigrations()`) on startup. The app alone will come up fine
  but nothing will ever get analyzed and the schema constraints won't be
  created.
- **Neo4j and Redis are not published to the host** by default (only `app`'s
  port 3000 is). If you want the Neo4j Browser for debugging, add a `ports:`
  mapping (e.g. `7474:7474` / `7687:7687`) to the `neo4j` service in
  `docker/docker-compose.yml` yourself.
- **Windows + Docker Desktop**: after an unclean shutdown, Docker Desktop can
  fail to start with a `removing stale socket ...
  userAnalyticsOtlpHttp.sock` error. Fix: rename aside
  `%LOCALAPPDATA%\Docker\run` and let Docker recreate it. This is a known
  recurring Docker Desktop issue, not a GraphReview bug — check for it first
  if Docker won't start after a machine restart.
- **Wiping the `neo4j_data` volume loses everything** — all analyzed repos,
  curated component descriptions, AI-generated domain labels, saved GitHub
  PAT and AI provider config. There's no export/backup feature yet.

## 3. Install — local development (without Docker)

```bash
npm install
npm run dev       # Next.js dev server, http://localhost:3000
npm run worker    # BullMQ worker — separate terminal, required (see above)
```

You need your own Neo4j 5 and Redis reachable via the env vars below
(`NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `REDIS_URL`, `SESSION_SECRET`).
Easiest way to get those without installing them natively is still Docker,
just for the two dependency containers — e.g. run only `neo4j`/`redis` from
`docker/docker-compose.yml`, or their official images directly.

**Caveat:** this path is explicitly *not* the primary supported one (decision
#5) — local-path repo ingestion in particular is designed around a single
bind-mounted folder under Docker (§14); outside Docker there's no equivalent
mount restriction, so it behaves a bit differently (see §4's
`LOCAL_REPOS_ROOT` note below).

## 4. Configuration (env vars)

Copy `docker/.env.example` to `docker/.env` and fill in the **required**
section; everything else has a working default.

### Required

| Var | Purpose |
|---|---|
| `NEO4J_URI` | Bolt URI — leave as `bolt://neo4j:7687` under Compose |
| `NEO4J_USER` | Neo4j username — leave as `neo4j` under Compose |
| `NEO4J_PASSWORD` | **Must be at least 8 characters** (Neo4j's own requirement) |
| `REDIS_URL` | Leave as `redis://redis:6379` under Compose |
| `LOCAL_REPOS_PATH` | Absolute **host** path bind-mounted read-only at `/data/local-repos`. Only repos already cloned under this one folder are usable as a "local" source — see the caveat below. |
| `SESSION_SECRET` | Long random string (e.g. `openssl rand -base64 32`) — keys AES-256-GCM encryption of the GitHub PAT and AI provider API keys at rest in Neo4j. |

### Optional — tuning

| Var | Default | Purpose |
|---|---|---|
| `REPO_CACHE_DIR` | `/data/repos` (Docker) / `./.data/repos` (plain `npm run dev`) | Where app-managed clone-by-URL repos are cached |
| `LOCAL_REPOS_ROOT` | `/data/local-repos` (Docker) / `LOCAL_REPOS_PATH` itself (outside Docker) | Container-side root that "local path" repos are confined to |
| `ANALYSIS_CONCURRENCY` | `1` | Parallel static-analysis jobs (CPU-bound; 1 is sensible) |
| `REVIEW_CONCURRENCY` | `1` | Parallel AI review jobs (documented in `worker/index.ts`, not in `.env.example`) |
| `LABEL_CONCURRENCY` | `1` | Parallel AI labeling jobs (same as above) |
| `STALENESS_SWEEP_INTERVAL_MS` | `0` (off) | Periodic background staleness re-check; the normal trigger is "on view", so this is only for keeping repos warm without anyone opening the UI |

### Optional — closed-network / mirror support

All default to the real-world service and only matter on a network without
direct internet access:

| Var | Purpose |
|---|---|
| `GITHUB_API_URL` | Point at a GitHub Enterprise Server / internal proxy (default: `https://api.github.com`) |
| `GITHUB_WEB_URL` | GitHub *web* host for clone URLs and UI links (default: `https://github.com`) |
| `NODE_BASE_IMAGE` | Base image for the app/worker build (default: `node:20-alpine`) |
| `ALPINE_MIRROR` | Alpine package mirror for `apk add git` during image build |
| `NEO4J_IMAGE` / `REDIS_IMAGE` | Mirrors of the official `neo4j:5` / `redis:7-alpine` images |

**Caveat: npm's registry is deliberately not covered here.** `npm ci`/`npm
run build` inside the Docker image build still need real npm registry access
or your own `.npmrc`/`NPM_CONFIG_REGISTRY` — none of the above vars affect
that.

### Not env vars

The **GitHub PAT** and **AI provider config** (base URL / API key / model)
are *not* set via env vars — they're entered on the app's **Settings** page
at runtime and stored encrypted in Neo4j. Env vars only cover infrastructure
wiring.

## 5. First-run setup (in the app)

1. Open [http://localhost:3000](http://localhost:3000).
2. Go to **Settings**:
   - **GitHub PAT** (optional) — needed only for PR/linked-issue fetching
     and cloning private repos. Local repos work with **no GitHub PAT at
     all** — branch listing, ref comparison, and diffs for the AI review all
     come from the checkout's own `git`. Needs `repo` scope.
   - **AI provider(s)** (optional) — add one or more OpenAI-compatible
     endpoints (base URL, API key, model name). You can save several and
     toggle which one is *active*; only the active one is used. Use **Test
     connection** before saving to confirm it's reachable — it sends one
     tiny chat completion, nothing is persisted by the test itself.
3. Add a repo from the landing page — either a path under `LOCAL_REPOS_PATH`
   or a GitHub URL. This kicks off static analysis automatically.

**Caveat:** without an AI provider configured, the app is still fully usable
for the graph/diff-impact view — AI review and labeling just show a
non-alarming "not configured" note instead of running.

## 6. Optional features

- **Multiple AI providers, hot-swappable.** Save a local model and a hosted
  one side by side and flip the active toggle — no restart needed.
- **Running your own local AI model instead of a hosted API key.** Any
  OpenAI-compatible `/v1/chat/completions` server works. [Ollama](https://ollama.com)
  is the easiest local option:
  ```bash
  # Windows: installer from https://ollama.com/download
  # Ubuntu:
  curl -fsSL https://ollama.com/install.sh | sh

  ollama pull qwen2.5:7b-instruct   # small instruct model, fits an 8GB GPU
  ```
  Then in Settings: Base URL `http://localhost:11434/v1` (plain `npm run
  dev`) or `http://host.docker.internal:11434/v1` (Docker Compose — Ollama
  stays on the host), API key any placeholder (e.g. `local`), Model the tag
  you pulled. `docker-compose.yml` already maps `host.docker.internal` to
  the host gateway on both Windows and Linux for this to work uniformly.
  Caveat: review/label quality with a small local model is well below a
  hosted frontier model.
- **AI-assisted domain labeling.** A repo starts with only a mechanical
  folder-based module tier — the higher-level "domain" grouping (e.g.
  "Auth", "UI primitives") requires an AI provider and a manual click
  ("Generate labels" in the graph toolbar). It does not run automatically on
  first analysis.
- **Testing the AI pipeline without a real provider** — a dependency-free
  mock OpenAI-compatible server:
  ```bash
  npx tsx lib/ai/mock-server.ts --port 4010
  ```
  Point Settings at `http://localhost:4010/v1` (or
  `http://host.docker.internal:4010/v1` from a container) with any API key.
  Special tokens in a prompt: `MOCK_FAIL` → HTTP 500, `MOCK_GARBAGE` →
  unparseable response; `MOCK_DELAY_MS` env var simulates latency. Caveat:
  on Windows, `tsx` can leave a child process behind after you stop it —
  kill the PID still listening on the port.
- **Smoke tests** (no test runner/framework — plain scripts):
  ```bash
  npx tsx lib/ai/smoke-test.ts
  npx tsx lib/ai/smoke-test-review.ts
  npx tsx lib/ai/smoke-test-label.ts
  npx tsx lib/analysis/smoke-test.ts
  npx tsx lib/analysis/smoke-test-langs.ts [dir]   # Go/Java/Rust
  npx tsx lib/analysis/smoke-test-jvm.ts [dir]     # Java+Kotlin resolver
  npx tsx lib/analysis/smoke-test-node.ts [dir]    # JS/TS monorepo resolver
  ```
- **Closed-network / air-gapped deployment** — see the mirror env vars in §4.

## 7. Other known caveats worth knowing before you rely on this

- **Local-path repos are confined to one bind-mounted folder under Docker**
  (`LOCAL_REPOS_PATH`). A repo cloned elsewhere on the host must be moved or
  symlinked into that folder, or ingested via the app's clone-by-URL path
  instead.
- **GitHub-backed review paths are code-reviewed but not live-tested**
  against a real PAT/GitHub API as of this writing (per `docs/DESIGN.md`
  §16) — the plumbing is there but hasn't been exercised end-to-end.
  Similarly, AI review/labeling has mainly been exercised against the mock
  server; a real provider surfaced client-compatibility issues (reasoning
  models, `temperature`/`max_tokens` rejections) that are now handled, but
  output *quality* against a real model is otherwise unproven.
- **No audit trail for AI findings.** Re-running a review overwrites prior
  findings for the same PR/component rather than versioning them — fine for
  an advisory tool, not for anything compliance-adjacent.
- **Component/domain descriptions live only in Neo4j**, never written back
  to the target repo — losing the `neo4j_data` volume loses them with no
  recovery path.
- **Java/Kotlin dependency resolution is lexical, not type-checked** — same-
  package/wildcard-import references can produce false edges when a local
  variable happens to share a name with a real class.
