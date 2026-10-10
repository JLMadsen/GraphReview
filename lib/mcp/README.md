# lib/mcp

> The MCP server coding agents connect to: read reviews, reply to findings.

`server.ts` builds the server; `app/api/mcp/route.ts` serves it at
`/api/mcp` as stateless Streamable HTTP (a fresh server per POST, JSON
responses, no sessions). It is reachable from this machine only — the
loopback rule in `middleware.ts` applies to it like every other route.

## Tools

| Tool | What it does |
| --- | --- |
| `list_repos` | Repos and their ids. |
| `list_reviews` | A repo's review targets that have findings (`pr:<n>` or `refs:<base>...<head>`), open counts, newest first. |
| `get_review` | One review's findings grouped by component, worst first; open ones only unless `includeSettled`. Includes the PR-level intent verdict and whether the branch moved since the review. |
| `get_changed_components` | Which components the diff touches, per file status and +/- counts. |
| `get_component_diff` | The patches of every changed file one component owns. |
| `get_file_diff` | One file's patch; with `sha`, a file outside the diff whole at that commit (for impact findings). |
| `list_endpoints` | Every endpoint of the repo's analysed commit (HTTP, server actions, tRPC, GraphQL) with handler, middleware/auth, params and request/response shapes; filter by `kind` or `query`. |
| `get_api_changes` | What a review target does to the API: added, removed, changed (deltas marked breaking); separately, endpoints with the same contract whose code behind changed (`logicChanged`, with the call path). Starts the base/head comparison when there is none. |
| `list_infra` | The infrastructure as code of the repo's analysed commit (Terraform/OpenTofu, Nomad, Kubernetes, Helm, Dockerfiles): stacks and resources with tags and versions, which workload ships which code, env vars read but not set, routes; filter by `tool` or `query`. |
| `get_infra_changes` | What a review target does to the infrastructure, plan-style (create / destroy / update / moved / version, attribute deltas), link deltas and the certain `infra` findings. Starts the base/head comparison when there is none. |
| `list_tables` | The database schema of the repo's analysed commit: tables from migrations (replayed), schema files and ORM models, each column with its source, keys, FKs, mapped models, endpoints that read or write them (SQL-text links marked), drift, migration order problems; filter by `query`. |
| `get_schema_changes` | What a review target does to the schema: tables and columns added / dropped / retyped / renamed, indexes, FKs, enums, the migrations it adds, drift it introduces and the certain `schema` findings. Starts the base/head comparison when there is none. |
| `respond_to_finding` | Append a reply: `answered` (resolves it), `fixing` (concern is right, fix under way; stays open), `comment`. |

## Prompt

`review` (optional `target`, `repo`): the whole workflow as one message —
find the review for the agent's current branch, check each open finding,
answer or fix it, summarise. It lists the reviews that exist when it is
called, so the agent can match its branch without a lookup. Agents show it
as a slash command: `/mcp__graphreview__review` in Claude Code,
`/mcp.graphreview.review` in VS Code. The server can't see the agent's
checkout, so matching the branch is the agent's job.

Replies are stored on the finding (`FindingRecord.responses`) and shown in
the review dock, live: `events.ts` signals the change in-process, and
`GET /api/repos/[repoId]/review/events` streams it to the open dock (server-sent
events), which refetches the review. Like a manual resolve, they belong to that review run: a
re-review replaces the findings and starts them without replies.

Scope: reads and replies only. Starting a review, and posting anything to
GitHub/GitLab, are not exposed.
