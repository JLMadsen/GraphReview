# GraphReview — Design Document

Status: **v1 and v2 done; v3 partially done** (Go/Java/Kotlin/Rust analyzers and Next.js/Node workspace resolution shipped; Louvain re-clustering was built as an unwired library function, then removed). Since then the Graph tab became card maps — the App map and the PR map (§6.4, §6.5), drawn with React Flow and ELK — with the PR checklist, the PR chat and the before/after preview beside them (§6.6–§6.9); the review gained impact and intent passes (§9.1); the app moved from Docker Compose + Neo4j + Redis to one Node process with SQLite (§12); and the Cytoscape Repo view, with the Relabel and merge-suggestion controls that lived in it, was removed (§6.4's note). Synced with the code on 2026-10-06. Per-phase status is in §15; open caveats in §16; hard-won implementation gotchas in §17. This is a design log: sections describe the design, an **"As built"** note says where the build differs, and dated notes say what changed later. Graph notation (`(:Component)`, `-[:CHILD_OF]->`) is kept from the Neo4j days; §7 says how it maps onto the SQLite tables.

## 1. Product concept

GraphReview is a locally-run tool for reviewing GitHub pull requests — and, as built, GitLab merge requests — in a different way than a flat diff. It statically analyzes a target codebase into an **ontological graph** of components (e.g. "Auth", "DB layer", "UI primitives") connected by their code dependencies. When you select a PR/MR — or diff any two refs — it highlights which components are touched by the changed files. An AI model then explains, per touched component, what the change does in plain English and judges whether it is sound on its own merits, labelling how each change relates to the PR/MR's stated intent (its title/description and any linked issue). It also looks for code the change left behind (callers of a changed signature that weren't updated) and checks once, for the whole PR, whether it delivers what it describes — all surfaced as advisory annotations directly on the graph. **As built (2026-10-02)** — see §9's "Review passes"; before that date the single verdict was "does this match the stated intent", which flagged correct drive-by fixes.

The app is designed to run entirely on a developer's own machine, against repos they choose, with a fully swappable AI backend and no dependency on a specific GitHub App registration.

## 2. Locked decisions

These were decided deliberately and should not be relitigated without a documented reason — they shape every section below.

| # | Decision |
|---|---|
| 1 | **Graph construction** is static analysis, fully automatic. No manual curation is required to get an initial graph; nodes remain editable afterward. |
| 2 | **Edges** represent code dependencies (imports/calls) — objective, derived from static analysis, not asserted relationships. |
| 3 | **Intent validation** compares the diff against the PR's title/description (and linked issue, when resolvable) fetched from GitHub. **As built:** the same check runs for a GitLab merge request, fetched from the GitLab API instead. |
| 4 | **Repo access** supports a local clone already on disk, or an app-managed clone by URL, through one interface. **As built (2026-10-03):** a local source is any absolute path on the machine, optionally confined to `LOCAL_REPOS_ROOT` — see §14. |
| 5 | **Distribution** was originally Docker Compose (app + worker + Neo4j + Redis). **Replaced (2026-10-03):** an npm package run with `npx graphreview` — one Node process, one SQLite file, no services to run. Docker is optional, for previews only (§12). |
| 6 | **Auth** is a single local admin user, no real authentication — at most a lightweight local session gate. |
| 7 | **GitHub auth** is a user-supplied Personal Access Token (PAT) entered in settings — no OAuth App or GitHub App registration. **As built:** GitLab support (gitlab.com or one self-hosted instance) mirrors this exactly — a separate user-supplied GitLab PAT, also entered in settings. |
| 8 | **AI provider** is a generic OpenAI-compatible chat-completions endpoint (base URL + API key + model name), fully user-configurable. No hardcoded provider, and no reliance on provider-specific structured-output/tool-calling features. |
| 9 | **Node purpose/description** lives only in GraphReview's database as a component property, edited in-app — never committed to the target repo. |
| 10 | **Intent-check UX** is advisory annotations only in the graph UI. It never blocks a review and never auto-posts to GitHub or GitLab. |
| 11 | **Language scope** is polyglot as an *extension point* from day one (common IR + per-language plugin interface). Actual v1 language coverage is still phased — see §15. |
| 12 | **Multi-repo**: one running instance tracks multiple repos simultaneously, each in its own namespace, switchable in the UI. |
| 13 | **Frontend** is Next.js (App Router, TypeScript) with shadcn/ui as the base component library. |

## Sections

The rest of the design is split into one file per section, so a task reads only the part it touches. Section numbers are stable — code comments cite them as `DESIGN.md §6.13`; look the number up here.

| Section | File | Covers |
|---|---|---|
| §3–4 | [design/overview.md](design/overview.md) | Tech stack, screens & navigation |
| §5–6.2 | [design/analysis.md](design/analysis.md) | Static analysis strategy, component inference, clustering |
| §6.3 | [design/6.3-feature-merges.md](design/6.3-feature-merges.md) | Feature merges and splits (decided and built 2026-09-24) |
| §6.4 | [design/6.4-pr-map.md](design/6.4-pr-map.md) | The PR map — a second view of the same diff (built 2026-09-24) |
| §6.5 | [design/6.5-app-map.md](design/6.5-app-map.md) | The app map — the whole codebase as cards, at three levels (built 2026-09-26) |
| §6.6 | [design/6.6-checklist.md](design/6.6-checklist.md) | The PR prerequisite checklist (built 2026-09-26) |
| §6.7 | [design/6.7-pr-chat.md](design/6.7-pr-chat.md) | The PR chat (built 2026-09-26; pointing, screen context, views, triage 2026-10-14) |
| §6.8 | [design/6.8-graph-tab-layout.md](design/6.8-graph-tab-layout.md) | Visual language and layout of the Graph tab (redesign, 2026-09-26) |
| §6.9 | [design/6.9-preview.md](design/6.9-preview.md) | Before/after preview: running the changed code (built 2026-10-02) |
| §6.10 | [design/6.10-names-and-call-graph.md](design/6.10-names-and-call-graph.md) | Names, base/head comparison and the call graph (built 2026-10-08) |
| §6.11 | [design/6.11-api.md](design/6.11-api.md) | The API: an endpoint catalog and what a change does to it (built 2026-10-08) |
| §6.12 | [design/6.12-infra.md](design/6.12-infra.md) | Infrastructure as code: an infra catalog and what a change does to it (decided 2026-10-08, built 2026-10-10) |
| §6.13 | [design/6.13-db-schema.md](design/6.13-db-schema.md) | Database schema: a schema catalog, its diff and the review context (decided 2026-10-10, built 2026-10-10) |
| §6.14 | [design/6.14-files.md](design/6.14-files.md) | Files: the repo as files (built 2026-10-11) |
| §6.15 | [design/6.15-env.md](design/6.15-env.md) | Env variables: a variable catalog, its diff and four certain findings (decided and built 2026-10-13) |
| §6.16 | [design/6.16-infra-views.md](design/6.16-infra-views.md) | Infra sub-views: Diagram, Files with plain-English notes, Requests (built 2026-10-13) |
| §6.17 | [design/6.17-local-config.md](design/6.17-local-config.md) | Use local config: AI providers from OpenCode, Codex, Claude Code and other harness configs (built 2026-10-14) |
| §6.18 | [design/6.18-command-palette.md](design/6.18-command-palette.md) | Command palette: Ctrl+Space search and commands over everything in a repo (built 2026-10-14) |
| §6.19 | [design/6.19-stats.md](design/6.19-stats.md) | Stats: lines of code per language, contributors, and a timeline of commits, lines and CI runs (built 2026-10-16) |
| §6.20 | [design/6.20-jobs.md](design/6.20-jobs.md) | Jobs: a header indicator and drawer for background jobs across repos, plus inline status and failures in the views that start them (built 2026-10-16) |
| §7–8 | [design/data-model.md](design/data-model.md) | Data model, GitHub integration surface |
| §9–10 | [design/ai-pipeline.md](design/ai-pipeline.md) | AI integration flow, the review pipeline, labeling, analysis lifecycle & AI cost |
| §11–14 | [design/runtime.md](design/runtime.md) | Secrets, distribution & runtime layout, module/folder structure, local repo access |
| §15–16 | [design/roadmap.md](design/roadmap.md) | Phasing, known caveats and open follow-ups |
| §17 | [design/lessons.md](design/lessons.md) | Implementation lessons — check first when something "just doesn't work" |
