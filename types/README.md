# types

> `types/` shared TS types (IR schema, entity types, API DTOs)

From DESIGN.md §13, this is the shared type layer referenced by:

> **Next.js App Router, TypeScript throughout** (app, worker, and shared
> libs share one codebase and type layer).

## Scope

- Neo4j entity types mirroring the schema in §7 (`Repo`, `Component`,
  `File`, `PullRequest`, `RefSnapshot`, `Finding`, `Settings`) — the
  canonical shapes `lib/neo4j/` repository functions return.
- The static-analysis IR (`FileAnalysis`, per §5) — re-exported here or in
  `lib/analysis/ir.ts`, whichever a given consumer imports from directly.
- API DTOs for `app/api/*` route handlers, so `app/` and any future
  non-Next consumer share one contract.

Out of scope here: runtime validation (zod schemas live alongside their
owning module, e.g. in `lib/ai/` for parsing model output) — this
directory is types only.
