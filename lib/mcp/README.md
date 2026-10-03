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
| `respond_to_finding` | Append a reply: `answered` (resolves it), `fixing` (concern is right, fix under way; stays open), `comment`. |

Replies are stored on the finding (`FindingRecord.responses`) and shown in
the review dock. Like a manual resolve, they belong to that review run: a
re-review replaces the findings and starts them without replies.

Scope: reads and replies only. Starting a review, and posting anything to
GitHub/GitLab, are not exposed.
