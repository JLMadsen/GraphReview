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

GraphReview reuses your machine's npm/pip config and trusted certificates, and
settings for self-hosted GitLab/GitHub, registry mirrors and extra CAs go in
`~/.graphreview/config.env`. See
[`install.md`](install.md#private-registries-company-certificates-and-offline-networks)
for what's automatic and what you need to set.

## Running your own AI

GraphReview's labeling and PR review features call an OpenAI-compatible
`/v1/chat/completions` endpoint, so a locally-run model (e.g. Ollama) works
as a drop-in replacement for a hosted API key. See
[`install.md`](install.md#6-optional-features) for setup steps.

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
