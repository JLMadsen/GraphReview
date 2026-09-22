# lib/gitlab

> `lib/gitlab/` GitLab REST v4 wrapper, PAT handling, merge-request/diff/linked-issue fetching

The GitLab counterpart to `lib/github/` (see that module's README for the
general design this mirrors). A merge request maps onto the exact same
`PullRequestSummary`/`PullRequestDetail`/`PullRequestFile`/`LinkedIssue`
shapes GitHub uses (re-exported from `lib/github/types.ts` — see
`lib/gitlab/types.ts`), so callers branch on `repo.provider` only at the
fetch layer, never past it.

## Scope

- A thin `fetch`-based GitLab REST v4 client, constructed from the PAT
  decrypted via `lib/crypto/`.
- Branch listing, merge-request list + detail, per-file diffs (`changes`
  endpoint), linked-issue resolution (`closes_issues` — a plain REST
  endpoint, no GraphQL needed here), and ad-hoc ref-to-ref comparison.
- Surfacing GitLab's `RateLimit-*` response headers for the UI.

Out of scope here: where the PAT is stored (`lib/neo4j/` `Settings` node,
`gitlabPatEncrypted`) and how it's encrypted (`lib/crypto/`) — see
`lib/jobs/gitlab-access.ts` for that wiring.

## Notable differences from GitHub

- **Project identity**: a GitLab project is addressed by its URL-encoded
  full path (`group/subgroup/project`), not a 2-segment `owner/repo` split —
  GitLab supports arbitrarily nested subgroups.
- **`state=closed`**: GitLab's closed-MR filter excludes merged MRs (unlike
  GitHub, where a closed-PR list includes merged ones) — `listMergeRequests`
  fetches both `closed` and `merged` and merges them to match GitHub's
  "Closed" tab behavior.
- **Per-file added/removed counts**: not returned directly by GitLab's
  changes endpoint — computed by counting `+`/`-` lines in each file's diff
  text instead.
- **`mergeBaseSha`/`htmlUrl` on `RefComparison`**: optional, left unset here
  — GitLab's compare endpoint doesn't cheaply expose either, and neither is
  read downstream today.
