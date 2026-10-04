# GraphReview

A locally-run tool for reviewing GitHub pull requests and GitLab merge
requests against a codebase's component graph.


![GraphReview's component graph and AI review view](docs/images/example3.png)

Preview app changes: GraphReview renders the changed components before and
after, in a sandboxed Docker container.

![GraphReview's before and after app renderings](docs/images/example4.png)

## Quickstart

You need [Node.js](https://nodejs.org) 22.13 or newer and
[git](https://git-scm.com). Then:

```bash
npx graphreview
```

That starts GraphReview at [http://127.0.0.1:3470](http://127.0.0.1:3470)
and opens it in your browser. Everything it stores — the database, clones of
GitHub/GitLab repos, and the key that encrypts your saved tokens — lives in
`~/.graphreview`. Stop it with Ctrl+C.

Options: `--port <n>`, `--data <dir>`, `--no-open` (`npx graphreview --help`).

[Docker](https://www.docker.com/products/docker-desktop/) is optional: it's
only used by the before/after preview, which says so when Docker isn't
running. Everything else works without it.

## Running from a checkout

```bash
npm install
npm run dev       # http://localhost:3470, workers included (other port: npm run dev -- -p 4000)
```

`npm run dev` keeps its data in `.data/` in the checkout, separate from an
installed copy's `~/.graphreview`. `npm run build && npm start` runs the
production build the same way `npx graphreview` does.

## Private registries, company certificates and offline networks

Most of this is automatic — GraphReview reuses the setup your machine already has:

- **Installing GraphReview** goes through your normal npm config (`~/.npmrc`),
  like any other package.
- **Previews install a repo's dependencies with your own package-manager
  config.** Your user-level `.npmrc`, `.yarnrc`, `.yarnrc.yml` and pip config
  (registries, scopes, auth tokens) are copied into the install container.
  `${VAR}` references in them are filled in from your environment, and
  settings that point at folders on your machine (cache, prefix) are left
  out.
- **Company certificates are trusted wherever your machine trusts them:** the
  Windows certificate store / macOS keychain (Node 22.15 or newer),
  `NODE_EXTRA_CA_CERTS`, and any `cafile` / `cert` set in your npm or pip
  config. That covers preview installs and GraphReview's own calls to your
  AI server, GitHub Enterprise or GitLab. (git clones use git's own setup;
  Git for Windows already uses the Windows certificate store.)
- **Downloads are cached** in one Docker volume and preferred over the
  network, so once a package has been downloaded, reinstalling it doesn't
  need the registry.
- **A missing Docker image falls back.** If the Node image a repo asks for
  can't be pulled, the closest one already on your machine is used and the
  preview says so.

**What you need to do, once.** Settings live in **`~/.graphreview/config.env`**
— GraphReview creates it on first start with every option below already in
it, commented out. Remove the `#` in front of the lines you need, fill in your
values, and restart GraphReview. (Each start prints which settings it used.)

1. **Self-hosted GitLab** (or GitHub Enterprise) — then save a PAT in Settings:
   ```ini
   GITLAB_API_URL=https://gitlab.example.com/api/v4
   GITLAB_WEB_URL=https://gitlab.example.com
   ```
2. **Your registry instead of Docker Hub**, for the preview images — the path
   where it mirrors Docker Hub's official images:
   ```ini
   PREVIEW_IMAGE_REGISTRY=registry.example.com/dockerhub/library
   ```
   If that registry needs a login, run `docker login registry.example.com`
   once. (Alternatives: a `registry-mirrors` entry in Docker Desktop →
   Settings → Docker Engine, or `docker pull node:22-bookworm-slim` once while
   online — then this line isn't needed.)
3. **Company certificates — only if they aren't installed in Windows/macOS**
   (if they are, there's nothing to do). Point at a `.pem`/`.crt` file; no
   quotes or escaping needed for Windows paths:
   ```ini
   NODE_EXTRA_CA_CERTS=C:\certs\company-ca.pem
   ```
   GraphReview, its git clones and preview installs all trust it.
4. **AI:** add a provider your network can reach (for example Ollama on
   `http://localhost:11434/v1`) in Settings → AI providers.

Nothing else is needed if your npm/pip registry is set up in your user-level
config (`~/.npmrc`, pip config). If you configure it through environment
variables instead, put those in `config.env` too (`NPM_CONFIG_REGISTRY`,
`PIP_INDEX_URL`, `HTTPS_PROXY`, … — the file lists them); they're passed on to
preview installs.

Known limit: Yarn 1 lockfiles pin `registry.yarnpkg.com` URLs, so offline
they only install from the download cache or a mirror that serves those URLs.
To clear the download cache: `docker volume rm graphreview-preview-downloads`.

## Running your own AI

GraphReview's labeling and PR review features call an OpenAI-compatible
`/v1/chat/completions` endpoint, so a locally-run model (e.g. Ollama) works
as a drop-in replacement for a hosted API key. See
[`install.md`](install.md#5-optional-features) for setup steps.

## Connecting a coding agent (MCP)

GraphReview serves an MCP server at `http://127.0.0.1:3470/api/mcp`
(Streamable HTTP) while it runs. A coding agent can read a review's open
findings and the diff of each flagged component, then answer each finding —
"this doesn't hold, because…" (resolves it) or "right, fixing it" — and
the replies show under the finding in the app. For Claude Code (desktop
app or CLI), add a `.mcp.json` to the root of the repo the agent works in:

```json
{ "mcpServers": { "graphreview": { "type": "http", "url": "http://127.0.0.1:3470/api/mcp" } } }
```

Settings → Connect a coding agent has the setup for other agents. See [`lib/mcp/README.md`](lib/mcp/README.md) for the tools.

## Project layout

Each `lib/*`, `worker/`, `types/`, and `components/graph/` directory has its
own `README.md` stating what belongs there.
