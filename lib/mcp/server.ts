// The GraphReview MCP server: lets a coding agent (Claude Code, Cursor, …)
// read the AI review of a PR or branch, pull the diff of the components it
// flags, and reply to each finding.
//
// Built fresh per HTTP request by `app/api/mcp/route.ts` (stateless
// Streamable HTTP) — every tool reads straight from the database, so there is
// no session state to keep. Server-only.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addFindingResponse,
  getComponentById,
  getFindingById,
  getPullRequestByNumber,
  getRepoById,
  listFindingsByRepoId,
  listFindingsByTargetKey,
  listRepos,
  type FindingAssessment,
  type FindingRecord,
  type FindingWithComponent,
  type RepoRecord,
} from "@/lib/db";
import {
  ChangedFilesError,
  checkReviewFreshness,
  getReviewJob,
  latestReviewedRevision,
  listTargetChangedFiles,
  matchFilesToComponents,
  reviewTargetKey,
  type ReviewTarget,
} from "@/lib/jobs";
import { readFileAtCommit } from "@/lib/jobs/pr-context";
import { emitFindingsChanged } from "./events";

const INSTRUCTIONS = `GraphReview reviews pull requests and branch comparisons against a component graph of the codebase. Each review is a list of findings, grouped by component; each finding has an assessment (defect > concern > unknown > ok).

Typical flow:
1. list_repos, then list_reviews for the repo to find the review target ("pr:<number>" or "refs:<base>...<head>").
2. get_review for the open findings and the components that need a look.
3. get_component_diff / get_file_diff to read the code a finding is about.
4. respond_to_finding for each finding: "answered" when the concern does not hold (explain why — this resolves it), "fixing" when it is correct and you are fixing it, "comment" for anything else.

Reviews are advisory and can be wrong — check the code before agreeing with a finding.`;

/** Worst first — the order findings and components are listed in. */
const ASSESSMENT_RANK: Record<FindingAssessment, number> = { defect: 0, concern: 1, unknown: 2, ok: 3 };

const targetSchema = z
  .string()
  .describe('The review target: "pr:<number>" or "refs:<baseRef>...<headRef>", as list_reviews returns it.');

function parseTarget(raw: string): ReviewTarget {
  const pr = /^pr:(\d+)$/.exec(raw.trim());
  if (pr) return { kind: "pr", prNumber: Number(pr[1]) };
  const refs = /^refs:(.+?)\.\.\.(.+)$/.exec(raw.trim());
  if (refs) return { kind: "refs", baseRef: refs[1], headRef: refs[2] };
  throw new ToolError(`"${raw}" is not a review target — use "pr:<number>" or "refs:<base>...<head>".`);
}

/** A failure the agent should see as a tool error (and can act on), not a protocol error. */
class ToolError extends Error {}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Runs a tool body, returning its value as JSON text, or its error as an `isError` result. */
async function json(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await work(), null, 2) }] };
  } catch (error) {
    const known = error instanceof ToolError || error instanceof ChangedFilesError;
    if (!known) console.error("GraphReview MCP tool failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: known ? message : `GraphReview error: ${message}` }], isError: true };
  }
}

async function loadRepo(repoId: string): Promise<RepoRecord> {
  const repo = await getRepoById(repoId);
  if (!repo) throw new ToolError(`No repo with id "${repoId}" — list_repos gives the ids.`);
  return repo;
}

/** `resolved`, else `fixing` once any reply said a fix is under way, else `open`. */
function findingStatus(finding: FindingRecord): "resolved" | "fixing" | "open" {
  if (finding.resolvedAt) return "resolved";
  return finding.responses?.some((reply) => reply.kind === "fixing") ? "fixing" : "open";
}

/** A finding as an agent sees it: no ids it can't use, its open/resolved state spelled out. */
function toAgentFinding(finding: FindingWithComponent) {
  return {
    id: finding.id,
    status: findingStatus(finding),
    assessment: finding.assessment,
    category: finding.category,
    ...(finding.componentId ? { componentId: finding.componentId, componentName: finding.componentName } : {}),
    ...(finding.filePath ? { filePath: finding.filePath } : {}),
    ...(finding.lineRange ? { lineRange: finding.lineRange } : {}),
    summary: finding.summary,
    rationale: finding.rationale,
    confidence: finding.confidence,
    ...(finding.kind ? { kind: finding.kind } : {}),
    ...(finding.scope ? { scope: finding.scope } : {}),
    ...(finding.callFailed ? { callFailed: true } : {}),
    ...(finding.responses ? { responses: finding.responses } : {}),
  };
}

function byAssessment<T extends { assessment: FindingAssessment }>(a: T, b: T): number {
  return ASSESSMENT_RANK[a.assessment] - ASSESSMENT_RANK[b.assessment];
}

async function reviewState(repoId: string, targetKey: string, hasFindings: boolean) {
  const job = await getReviewJob(repoId, targetKey);
  const state = job ? await job.getState() : undefined;
  if (state === "active") return "running";
  if (state === "failed") return "failed";
  if (state && state !== "completed" && state !== "unknown") return "queued";
  return hasFindings || state === "completed" ? "completed" : "none";
}

export function createGraphReviewMcpServer(): McpServer {
  const server = new McpServer({ name: "graphreview", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_repos",
    {
      title: "List repos",
      description: "The repositories GraphReview has analyzed, with the ids the other tools take.",
      annotations: { readOnlyHint: true },
    },
    () =>
      json(async () =>
        (await listRepos()).map((repo) => ({
          id: repo.id,
          name: repo.name,
          provider: repo.provider,
          defaultBranch: repo.defaultBranch,
          ...(repo.url ? { url: repo.url } : {}),
          ...(repo.localPath ? { localPath: repo.localPath } : {}),
        }))
      )
  );

  server.registerTool(
    "list_reviews",
    {
      title: "List reviews",
      description:
        "Every review target of a repo that has findings — PRs and branch comparisons — with how many findings are still open, newest first.",
      inputSchema: { repoId: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ repoId }) =>
      json(async () => {
        await loadRepo(repoId);
        const byTarget = new Map<string, { findings: number; open: number; worstOpen?: FindingAssessment; reviewedAt: string }>();
        for (const finding of await listFindingsByRepoId(repoId)) {
          const entry = byTarget.get(finding.targetKey) ?? { findings: 0, open: 0, reviewedAt: "" };
          entry.findings++;
          if (finding.assessment !== "ok" && !finding.resolvedAt) {
            entry.open++;
            if (!entry.worstOpen || ASSESSMENT_RANK[finding.assessment] < ASSESSMENT_RANK[entry.worstOpen]) {
              entry.worstOpen = finding.assessment;
            }
          }
          const at = finding.reviewedAt ?? finding.createdAt;
          if (at > entry.reviewedAt) entry.reviewedAt = at;
          byTarget.set(finding.targetKey, entry);
        }
        const reviews = await Promise.all(
          [...byTarget].map(async ([target, entry]) => {
            const pr = /^pr:(\d+)$/.exec(target);
            const record = pr ? await getPullRequestByNumber(repoId, Number(pr[1])) : null;
            return { target, ...(record ? { title: record.title, url: record.url, state: record.state } : {}), ...entry };
          })
        );
        return reviews.sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt));
      })
  );

  server.registerTool(
    "get_review",
    {
      title: "Get review",
      description:
        "The findings of one review, grouped by component, worst first. By default only findings that still need a look (not OK, not resolved). Also says whether the branch has moved since the review ran.",
      inputSchema: {
        repoId: z.string(),
        target: targetSchema,
        includeSettled: z.boolean().optional().describe("Also return OK and resolved findings. Default false."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ repoId, target: rawTarget, includeSettled }) =>
      json(async () => {
        const repo = await loadRepo(repoId);
        const target = parseTarget(rawTarget);
        const targetKey = reviewTargetKey(target);
        const findings = await listFindingsByTargetKey(repoId, targetKey);
        const state = await reviewState(repoId, targetKey, findings.length > 0);
        const reviewed = state === "completed" ? latestReviewedRevision(findings) : undefined;
        const freshness = reviewed ? await checkReviewFreshness(repo, target, targetKey, reviewed) : undefined;

        const intent = findings.find((f) => f.category === "intent");
        const shown = findings
          .filter((f) => f.category !== "intent")
          .filter((f) => includeSettled || (f.assessment !== "ok" && !f.resolvedAt));

        const groups = new Map<string, { componentId: string; componentName: string; files: Set<string>; findings: FindingWithComponent[] }>();
        for (const finding of shown) {
          const key = finding.componentId || "";
          const group = groups.get(key) ?? {
            componentId: key,
            componentName: finding.componentName || (key ? "(component no longer in the graph)" : "(no component)"),
            files: new Set<string>(),
            findings: [],
          };
          if (finding.filePath) group.files.add(finding.filePath);
          group.findings.push(finding);
          groups.set(key, group);
        }
        const components = [...groups.values()]
          .map((group) => {
            const sorted = group.findings.sort(byAssessment);
            return {
              componentId: group.componentId,
              componentName: group.componentName,
              worst: sorted[0].assessment,
              files: [...group.files].sort(),
              findings: sorted.map(toAgentFinding),
            };
          })
          .sort((a, b) => ASSESSMENT_RANK[a.worst] - ASSESSMENT_RANK[b.worst]);

        return {
          target: targetKey,
          state,
          ...(freshness ? { freshness } : {}),
          counts: {
            total: findings.length,
            open: findings.filter((f) => f.assessment !== "ok" && !f.resolvedAt).length,
            resolved: findings.filter((f) => f.resolvedAt).length,
          },
          ...(intent ? { intent: toAgentFinding(intent) } : {}),
          components,
        };
      })
  );

  server.registerTool(
    "get_changed_components",
    {
      title: "Get changed components",
      description:
        "Which components of the graph a review target's diff touches, with each changed file's status and line counts. Files the graph doesn't know (non-code, or the repo needs re-analysis) are listed apart.",
      inputSchema: { repoId: z.string(), target: targetSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ repoId, target: rawTarget }) =>
      json(async () => {
        const repo = await loadRepo(repoId);
        const files = await listTargetChangedFiles(repo, parseTarget(rawTarget));
        const match = await matchFilesToComponents(repoId, files.map((f) => f.path));
        const fileByPath = new Map(files.map((f) => [f.path, f]));
        const components = await Promise.all(
          [...match.pathsByComponentId].map(async ([componentId, paths]) => {
            const component = await getComponentById(componentId);
            return {
              componentId,
              componentName: component?.name ?? componentId,
              ...(component?.description ? { description: component.description } : {}),
              files: paths.map((path) => {
                const file = fileByPath.get(path)!;
                return { path, status: file.status, additions: file.additions, deletions: file.deletions };
              }),
            };
          })
        );
        const owned = new Set(match.componentIdByPath.keys());
        return {
          components,
          otherFiles: files
            .filter((f) => !owned.has(f.path))
            .map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
        };
      })
  );

  server.registerTool(
    "get_component_diff",
    {
      title: "Get component diff",
      description: "The unified diff of every file one component owns in a review target's diff.",
      inputSchema: { repoId: z.string(), target: targetSchema, componentId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ repoId, target: rawTarget, componentId }) =>
      json(async () => {
        const repo = await loadRepo(repoId);
        const files = await listTargetChangedFiles(repo, parseTarget(rawTarget));
        const match = await matchFilesToComponents(repoId, files.map((f) => f.path));
        const paths = new Set(match.pathsByComponentId.get(componentId) ?? []);
        if (paths.size === 0) {
          throw new ToolError(`The diff touches no file of component "${componentId}" — get_changed_components lists the ones it does.`);
        }
        const component = await getComponentById(componentId);
        return {
          componentId,
          componentName: component?.name ?? componentId,
          files: files
            .filter((f) => paths.has(f.path))
            .map((f) => ({ ...f, ...(f.patch ? {} : { note: "No patch: binary file, or the diff is too large." }) })),
        };
      })
  );

  server.registerTool(
    "get_file_diff",
    {
      title: "Get file diff",
      description:
        "One file's unified diff in a review target. For a file outside the diff (impact findings point at callers the change left untouched), pass the review's head sha to get the whole file at that commit instead.",
      inputSchema: {
        repoId: z.string(),
        target: targetSchema,
        path: z.string(),
        sha: z.string().optional().describe("Head commit to read the whole file at when it is not part of the diff."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ repoId, target: rawTarget, path, sha }) =>
      json(async () => {
        const repo = await loadRepo(repoId);
        const file = (await listTargetChangedFiles(repo, parseTarget(rawTarget))).find((f) => f.path === path);
        if (file) return file;
        if (sha) {
          const whole = await readFileAtCommit(repo, sha, path);
          if (whole?.source === "commit") return { path, inDiff: false, content: whole.text };
        }
        throw new ToolError(`"${path}" is not part of this diff${sha ? ` and could not be read at ${sha}` : " — pass sha to read it whole"}.`);
      })
  );

  server.registerTool(
    "respond_to_finding",
    {
      title: "Respond to finding",
      description:
        'Reply to one finding; the reply shows under it in GraphReview. kind "answered": the concern does not hold or is already handled — explain why; this resolves the finding. "fixing": the concern is correct and you are fixing it — say what you change; the finding stays open until a re-review of the fixed code. "comment": anything else.',
      inputSchema: {
        repoId: z.string(),
        findingId: z.string(),
        kind: z.enum(["answered", "fixing", "comment"]),
        message: z.string().min(1).max(4000),
        author: z.string().max(80).optional().describe('Your name as it should show, e.g. "claude-code". Default "agent".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ repoId, findingId, kind, message, author }) =>
      json(async () => {
        const existing = await getFindingById(findingId);
        if (!existing || existing.repoId !== repoId) throw new ToolError(`No finding with id "${findingId}" in this repo.`);
        if (existing.assessment === "ok" && kind !== "comment") {
          throw new ToolError('This finding is OK — there is nothing to answer or fix. Use kind "comment" to leave a note.');
        }
        const updated = await addFindingResponse(repoId, findingId, {
          kind,
          author: author?.trim() || "agent",
          body: message.trim(),
        });
        if (!updated) throw new ToolError(`Finding "${findingId}" was replaced by a re-review — call get_review again.`);
        emitFindingsChanged(repoId, updated.targetKey, updated.id);
        return {
          id: updated.id,
          status: findingStatus(updated),
          responses: updated.responses,
        };
      })
  );

  return server;
}
