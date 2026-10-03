# Installing and running GraphReview

GraphReview is a locally-run Next.js app that reviews pull requests against
a statically-derived "component graph" of a codebase, with optional
AI-generated summaries, reviews and intent checks. It runs as **one
process**: the web server and the background workers (static analysis, AI
calls, previews) share it, and everything is stored in one SQLite file.

## 1. Prerequisites

| For | Need |
|---|---|
| Running GraphReview | [Node.js](https://nodejs.org) **22.13+** (for the built-in `node:sqlite`) and `git` on `PATH` |
| Before/after previews (optional) | [Docker Desktop](https://www.docker.com/products/docker-desktop/) or Docker Engine, running |
| Running your own local AI model (optional) | [Ollama](https://ollama.com) or any other OpenAI-compatible server |

## 2. Install and run

```bash
npx graphreview
```

The first run downloads the package; later runs start in about a second. The
app is served at [http://127.0.0.1:3470](http://127.0.0.1:3470) — or the
next free port, if 3470 is taken — and the browser opens on it. Ctrl+C stops
it. To keep it installed rather than going through `npx` each time:

```bash
npm install -g graphreview
graphreview
```

| Option | Purpose |
|---|---|
| `--port <n>` | Listen on this port instead of 3470 |
| `--data <dir>` | Use this data folder instead of `~/.graphreview` (also `GRAPHREVIEW_HOME`) |
| `--no-open` | Don't open the browser |

**Caveats:**

- **The server listens on 127.0.0.1 only.** GraphReview has no login — it
  is a single-user tool for your own machine, so it isn't reachable from
  other machines. It also refuses requests addressed to any other host name
  and state-changing requests from other websites (`middleware.ts`), so a
  page you visit can't drive it through your browser.
- **One instance per data folder.** Starting it again while it's running just
  points you at the running one (two servers on one database would each run
  workers and trip over each other's jobs).
- **Stopping it mid-job.** Queued jobs survive a restart. A job that was
  *running* is retried if it's an analysis, and marked "Interrupted — run it
  again" if it's an AI job (AI jobs never re-run on their own, since that
  would silently repeat model spend).
- **SQLite in Node is still flagged experimental** by Node itself; the
  launcher hides the warning. It's stable in practice for this use.

## 3. Running from a source checkout

```bash
npm install
npm run dev       # dev server with hot reload, http://localhost:3470 (other port: npm run dev -- -p 4000)
```

The workers start with the dev server (via `instrumentation.ts`) — there's
nothing else to run. `npm run dev` keeps its data in `.data/` in the
checkout, so it never touches an installed copy's database.

`npm run build` then `npm start` runs the production build exactly as
`npx graphreview` does. `npm pack` builds and produces the publishable
tarball (`npm install -g ./graphreview-<version>.tgz` to try it).

## 4. Where data lives

Everything is in the data folder (`~/.graphreview` by default):

| File | What |
|---|---|
| `graphreview.db` (+ `-wal`, `-shm`) | The SQLite database: repos, the component graph, findings, settings, saved AI providers, job queue |
| `repos/` | Clones of GitHub/GitLab repos (local repos are read in place, never copied) |
| `secret.key` | Random key that encrypts saved tokens and API keys in the database. Generated on first use. Lose it and saved credentials have to be re-entered — nothing else is affected |

Back up or move GraphReview by copying the folder while it's stopped.
Deleting it resets GraphReview completely.

## 5. First-run setup (in the app)

1. Go to **Settings**:
   - **GitHub / GitLab PAT** (optional) — needed only for PR/MR and linked-
     issue fetching and cloning private repos. Local repos work with **no
     token at all** — branch listing, ref comparison, and diffs for the AI
     review all come from the checkout's own `git`. GitHub needs `repo`
     scope, GitLab `api`.
   - **AI provider(s)** (optional) — add one or more OpenAI-compatible
     endpoints (base URL, API key, model name). You can save several and
     toggle which one is *active*; only the active one is used. Use **Test
     connection** before saving to confirm it's reachable.
2. Add a repo from the landing page — pick one of the git repos GraphReview
   found in the usual folders (`~/code`, `~/Documents/GitHub`,
   `~/source/repos`, …), type the full path to any other checkout, or paste a
   GitHub/GitLab URL. This kicks off static analysis automatically.

Without an AI provider the app is still fully usable for the graph and
diff-impact view — AI review and labeling just show a "not configured" note.

## 6. Optional features

- **Multiple AI providers, hot-swappable.** Save a local model and a hosted
  one side by side and flip the active toggle — no restart needed.
- **Running your own local AI model.** Any OpenAI-compatible
  `/v1/chat/completions` server works. [Ollama](https://ollama.com) is the
  easiest local option:
  ```bash
  # Windows: installer from https://ollama.com/download
  # Ubuntu:
  curl -fsSL https://ollama.com/install.sh | sh

  ollama pull qwen2.5:7b-instruct   # small instruct model, fits an 8GB GPU
  ```
  Then in Settings: Base URL `http://localhost:11434/v1`, API key any
  placeholder (e.g. `local`), Model the tag you pulled. Review/label quality
  with a small local model is well below a hosted frontier model.
- **AI-assisted domain labeling.** A repo starts with a mechanical
  folder-based module tier — the higher-level "domain" grouping needs an AI
  provider and a click on "Generate labels" in the graph toolbar.
- **Before/after previews** render changed UI components and run changed
  functions at the base and the head, each in a throwaway Docker container
  with no network while the code runs. Meant for repos you trust. Without
  Docker running, the preview buttons are disabled and say why.
- **Testing the AI pipeline without a real provider** — a dependency-free
  mock OpenAI-compatible server (from a checkout):
  ```bash
  npx tsx lib/ai/mock-server.ts --port 4010
  ```
  Point Settings at `http://localhost:4010/v1` with any API key. Special
  tokens in a prompt: `MOCK_FAIL` → HTTP 500, `MOCK_GARBAGE` → unparseable
  response; `MOCK_DELAY_MS` env var simulates latency. On Windows, `tsx`
  can leave a child process behind after you stop it — kill the PID still
  listening on the port.
- **Smoke tests** (plain scripts, from a checkout):
  ```bash
  npx tsx lib/ai/smoke-test.ts
  npx tsx lib/ai/smoke-test-review.ts
  npx tsx lib/ai/smoke-test-label.ts
  npx tsx lib/analysis/smoke-test.ts
  npx tsx lib/analysis/smoke-test-langs.ts [dir]   # Go/Java/Rust
  npx tsx lib/analysis/smoke-test-jvm.ts [dir]     # Java+Kotlin resolver
  npx tsx lib/analysis/smoke-test-node.ts [dir]    # JS/TS monorepo resolver
  ```

## 7. Configuration (env vars)

Nothing is required. Tokens and AI providers are entered in **Settings**,
not env vars. Set any of these in the environment GraphReview starts in:

### General

| Var | Default | Purpose |
|---|---|---|
| `GRAPHREVIEW_HOME` | `~/.graphreview` (`.data/` under `npm run dev`) | Data folder (same as `--data`) |
| `LOCAL_REPOS_ROOT` | unset | Confine local repos to this folder: only repos under it can be added, relative paths resolve from it, and the add-repo list shows its repos |
| `REPO_CACHE_DIR` | `<data folder>/repos` | Where GitHub/GitLab clones are kept |
| `SESSION_SECRET` | `secret.key` in the data folder | Key credential encryption with this string instead of the generated key |
| `AI_REQUEST_TIMEOUT_MS` | `1800000` (30 min) | Longest one AI request may take; `0` = no limit. Raise it for large local models |
| `ANALYSIS_CONCURRENCY` | `1` | Parallel static-analysis jobs (CPU-bound; 1 is sensible) |
| `REVIEW_CONCURRENCY` / `LABEL_CONCURRENCY` / `APP_MAP_CONCURRENCY` | `1` | Parallel AI jobs of each kind |
| `STALENESS_SWEEP_INTERVAL_MS` | `0` (off) | Periodic background staleness re-check; the normal trigger is "on view" |
| `GRAPHREVIEW_NO_WORKER` | unset | `1` serves the UI without processing jobs |
| `GRAPHREVIEW_ALLOWED_HOSTS` | unset | Comma-separated extra host names to answer to besides localhost/127.0.0.1 (e.g. when reaching `npm run dev` by a LAN name) |

### Before/after preview sandbox

| Var | Default | Purpose |
|---|---|---|
| `PREVIEW_NODE_IMAGE` / `PREVIEW_PYTHON_IMAGE` | `node:20-bookworm-slim` / `python:3.12-slim` | Images the code runs in (pulled on first use) |
| `PREVIEW_RUN_TIMEOUT_MS` / `PREVIEW_INSTALL_TIMEOUT_MS` | `120000` / `900000` | Wall-clock limits for one side's run, and for a dependency install |
| `PREVIEW_MEMORY` / `PREVIEW_CPUS` | `2g` / `1` | Resource caps per sandbox container |
| `PREVIEW_DEPS_MAX_AGE_HOURS` / `PREVIEW_DEPS_KEEP` | `48` / `6` | Installed dependencies are cached in Docker volumes (often hundreds of MB each); after every preview, caches unused this long are removed and only this many are kept |
| `PREVIEW_CONCURRENCY` | `1` | Files previewed at once (each runs two containers) |

### Closed networks

All optional — set them only on a network where the public services aren't
reachable and an internal mirror or proxy stands in:

| Var | Purpose |
|---|---|
| `GITHUB_API_URL` / `GITHUB_WEB_URL` | GitHub Enterprise Server or an internal proxy (defaults `https://api.github.com` / `https://github.com`) |
| `GITLAB_API_URL` / `GITLAB_WEB_URL` | Self-hosted GitLab (defaults to gitlab.com) |
| `NODE_EXTRA_CA_CERTS` | A file of internal CA certificates. Node uses it for the AI endpoint and the GitHub/GitLab APIs, and preview installs get it combined with the public roots |
| `NPM_CONFIG_REGISTRY` | npm registry mirror — for installing GraphReview itself, and for preview dependency installs |
| `PIP_INDEX_URL` | PyPI mirror for Python preview installs |
| `PREVIEW_IMAGE_REGISTRY` | Registry/namespace prefix for the preview images, e.g. `mirror.corp/library` |
| `HTTPS_PROXY` / `NO_PROXY` | Passed to preview installs as well |

git uses its own configuration (`git config http.sslCAInfo …`,
`http.proxy`) for clones. Fonts are bundled, so neither GraphReview nor the
browser needs to reach Google Fonts.

## 8. Other known caveats worth knowing before you rely on this

- **GitHub-backed review paths are code-reviewed but not live-tested**
  against a real PAT/GitHub API as of this writing. Similarly, AI
  review/labeling has mainly been exercised against the mock server; a real
  provider surfaced client-compatibility issues (reasoning models,
  `temperature`/`max_tokens` rejections) that are now handled, but output
  *quality* against a real model is otherwise unproven.
- **No audit trail for AI findings.** Re-running a review overwrites prior
  findings for the same PR/component rather than versioning them — fine for
  an advisory tool, not for anything compliance-adjacent.
- **Component/domain descriptions live only in GraphReview's database**,
  never written back to the target repo — deleting the data folder loses
  them.
- **Java/Kotlin dependency resolution is lexical, not type-checked** — same-
  package/wildcard-import references can produce false edges when a local
  variable happens to share a name with a real class.
