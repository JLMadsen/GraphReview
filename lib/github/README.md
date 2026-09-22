# lib/github

> `lib/github/` Octokit wrapper, PAT handling, PR/diff/linked-issue fetching

From DESIGN.md §8:

> **REST v3** (`@octokit/rest`) covers most of this — notably
> `GET /repos/{owner}/{repo}/pulls/{pull_number}/files`, which returns
> per-file unified-diff `patch` text directly, and
> `GET /repos/{owner}/{repo}/compare/{base}...{head}` for non-PR ref
> comparisons (decision #4). **GraphQL v4** (`@octokit/graphql`) is used
> specifically for linked-issue resolution — `closingIssuesReferences` on a
> PR is reliably available only via GraphQL — and optionally to batch PR +
> files + linked-issues into fewer round-trips. The PAT (decision #7) is
> stored via in-app settings, persisted in Neo4j, and used as a Bearer
> token. REST rate-limit headers are surfaced in the UI.

## Scope

- A thin Octokit REST + GraphQL client wrapper, constructed from the PAT
  decrypted via `lib/crypto/`.
- Repo/branch listing, PR list + detail, per-file diffs (`patch` text),
  linked-issue resolution, and ad-hoc ref-to-ref comparison.
- Surfacing REST rate-limit headers for the UI.

Out of scope here: where the PAT is stored (`lib/neo4j/` `Settings` node)
and how it's encrypted (`lib/crypto/`).
