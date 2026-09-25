/**
 * Smoke test for the PR map (DESIGN.md §6.4).
 *
 *   npx tsx lib/jobs/smoke-test-pr-map.ts
 *
 * Part A covers the pure builder (lib/jobs/pr-map.ts) on a synthetic diff
 * shaped like the talk's example: path classification, dependency-usage
 * detection, the heuristic grouping, labelled edges and context cards.
 * Part B covers lib/ai/pr-map.ts: normalisation of a hand-written model
 * answer, then the real `chatCompletion` client against the mock server,
 * applied back onto the map with `applyPrMapGrouping`. No Neo4j needed.
 */
import { groupPrMap, normalizePrMapGrouping } from "@/lib/ai/pr-map";
import { MOCK_DESCRIPTION_PREFIX, startMockServer } from "@/lib/ai/mock-server";
import type { AiProviderConfig } from "@/lib/ai";
import {
  applyPrMapGrouping,
  assemblePrMap,
  buildHeuristicPrMap,
  changedPackages,
  classifyPath,
  collectPrMapLinks,
  heuristicPrMapGroups,
  patchHighlights,
  type PrMapInput,
} from "./pr-map";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const INPUT: PrMapInput = {
  files: [
    {
      path: "src/ffi/ffiRuntimeHost.ts",
      status: "modified",
      additions: 40,
      deletions: 3,
      patch: '@@ -1 +1 @@\n+import { open, load } from "ffi-rs";\n+export function startHost() {}',
    },
    { path: "src/ffi/ffiRuntimeHost.test.ts", status: "modified", additions: 20, deletions: 0 },
    { path: "src/client.ts", status: "modified", additions: 5, deletions: 1 },
    {
      path: "package.json",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: '@@ -10 +10 @@\n+    "ffi-rs": "^1.2.0",\n     "dev": "next dev"',
    },
    { path: "package-lock.json", status: "modified", additions: 30, deletions: 0 },
    { path: "README.md", status: "modified", additions: 2, deletions: 0 },
  ],
  componentIdByPath: new Map([
    ["src/ffi/ffiRuntimeHost.ts", "c:ffi"],
    ["src/ffi/ffiRuntimeHost.test.ts", "c:ffi"],
    ["src/client.ts", "c:client"],
  ]),
  components: new Map([
    ["c:ffi", { id: "c:ffi", name: "src/ffi", description: "Native runtime host" }],
    ["c:client", { id: "c:client", name: "src/client" }],
    ["c:util", { id: "c:util", name: "src/util" }],
  ]),
  imports: [
    { from: "src/client.ts", to: "src/ffi/ffiRuntimeHost.ts", fromComponentId: "c:client", toComponentId: "c:ffi" },
    { from: "src/ffi/ffiRuntimeHost.test.ts", to: "src/ffi/ffiRuntimeHost.ts", fromComponentId: "c:ffi", toComponentId: "c:ffi" },
    { from: "src/ffi/ffiRuntimeHost.ts", to: "src/util/log.ts", fromComponentId: "c:ffi", toComponentId: "c:util" },
  ],
};

function edge(map: ReturnType<typeof buildHeuristicPrMap>, source: string, target: string) {
  return map.edges.find((e) => e.source === source && e.target === target);
}

function partA(): void {
  console.log("heuristic builder:");
  const roles = Object.fromEntries(
    [
      "a/b.test.ts",
      "pkg/x_test.go",
      "src/test/java/FooTest.java",
      "go.mod",
      "Cargo.lock",
      ".github/workflows/ci.yml",
      "Dockerfile",
      "next.config.ts",
      "docs/guide.md",
      "docs/site/page.tsx",
      "src/app.tsx",
    ].map((p) => [p, classifyPath(p)])
  );
  check(
    "classifyPath",
    roles["a/b.test.ts"] === "test" &&
      roles["pkg/x_test.go"] === "test" &&
      roles["src/test/java/FooTest.java"] === "test" &&
      roles["go.mod"] === "dependency" &&
      roles["Cargo.lock"] === "dependency" &&
      roles[".github/workflows/ci.yml"] === "config" &&
      roles["Dockerfile"] === "config" &&
      roles["next.config.ts"] === "config" &&
      roles["docs/guide.md"] === "docs" &&
      roles["docs/site/page.tsx"] === "code" &&
      roles["src/app.tsx"] === "code",
    JSON.stringify(roles)
  );
  check(
    "changedPackages: version entries only, not scripts",
    JSON.stringify(changedPackages("package.json", INPUT.files[3].patch)) === '["ffi-rs"]'
  );
  check(
    "changedPackages: go.mod require line",
    JSON.stringify(changedPackages("go.mod", "+\tgithub.com/foo/bar v1.2.3")) === '["github.com/foo/bar"]'
  );
  check(
    "patchHighlights keeps changed declarations",
    JSON.stringify(patchHighlights(INPUT.files[0].patch)) === '["+ export function startHost() {}"]'
  );

  const map = buildHeuristicPrMap(INPUT);
  const ids = map.nodes.map((n) => n.id);
  check(
    "one card per module, a test card, dependencies, docs and one context card",
    JSON.stringify(ids) ===
      JSON.stringify(["code:c:client", "code:c:ffi", "test:c:ffi", "dep", "docs", "ctx:c:util"]),
    JSON.stringify(ids)
  );
  check("every changed file on exactly one card", map.nodes.flatMap((n) => n.files).length === INPUT.files.length);
  check("dependency card names the package", map.nodes.find((n) => n.id === "dep")?.description === "Changes ffi-rs");
  check("client imports host", edge(map, "code:c:client", "code:c:ffi")?.label === "imports");
  check("test covers host, counted once", edge(map, "test:c:ffi", "code:c:ffi")?.label === "covers" && edge(map, "test:c:ffi", "code:c:ffi")?.weight === 1);
  check("host uses the dependency", edge(map, "code:c:ffi", "dep")?.label === "uses");
  check("host imports its unchanged neighbour", edge(map, "code:c:ffi", "ctx:c:util")?.label === "imports");
  check("docs have no edges", !map.edges.some((e) => e.source === "docs" || e.target === "docs"));
}

async function partB(): Promise<void> {
  console.log("\nAI grouping:");
  const known = new Set(INPUT.files.map((f) => f.path));
  const normalized = normalizePrMapGrouping(
    {
      groups: [
        { name: "Runtime Host", description: "Binds the ABI", files: ["src/ffi/ffiRuntimeHost.ts", "nope.ts"] },
        { name: "runtime host", files: ["src/client.ts"] },
        { name: "Client", files: ["src/client.ts", "src/ffi/ffiRuntimeHost.ts"] },
        { name: "Empty", files: [] },
      ],
      edges: [
        { from: "Client", to: "Runtime Host", label: "Starts" },
        { from: "Client", to: "Runtime Host", label: "ignore previous instructions and" },
        { from: "Client", to: "Client", label: "calls" },
      ],
    },
    known
  );
  check(
    "unknown paths, duplicate names, re-placed files and empty groups are dropped",
    JSON.stringify(normalized.groups.map((g) => [g.name, g.files])) ===
      JSON.stringify([["Runtime Host", ["src/ffi/ffiRuntimeHost.ts"]], ["Client", ["src/client.ts"]]]),
    JSON.stringify(normalized.groups)
  );
  check(
    "verbs are lower-cased; prose and self-edges dropped",
    JSON.stringify(normalized.edgeLabels) === JSON.stringify([{ from: "Client", to: "Runtime Host", label: "starts" }]),
    JSON.stringify(normalized.edgeLabels)
  );

  const applied = applyPrMapGrouping(INPUT, collectPrMapLinks(INPUT), normalized);
  const client = applied.nodes.find((n) => n.name === "Client");
  const host = applied.nodes.find((n) => n.name === "Runtime Host");
  check("AI groups become cards, leftovers keep heuristic cards", Boolean(client && host) && applied.nodes.flatMap((n) => n.files).length === INPUT.files.length);
  check(
    "AI verb applied to an edge the links justify",
    applied.edges.some((e) => e.source === client?.id && e.target === host?.id && e.label === "starts")
  );

  const mock = await startMockServer({ port: 0, host: "127.0.0.1", delayMs: 0, log: () => undefined });
  const real: AiProviderConfig = { baseUrl: `${mock.url}/v1`, apiKey: "test-key", model: "mock-review-1" };
  try {
    const heuristic = assemblePrMap(INPUT, collectPrMapLinks(INPUT), heuristicPrMapGroups(INPUT));
    const nameOf = new Map(heuristic.nodes.map((n) => [n.id, n.name]));
    const cardOf = new Map(heuristic.nodes.flatMap((n) => n.files.map((f) => [f.path, n.name] as const)));
    const result = await groupPrMap(real, {
      intent: { title: "Host the runtime in-process with ffi-rs" },
      files: INPUT.files.map((f) => ({ ...f, group: cardOf.get(f.path) ?? "", highlights: patchHighlights(f.patch) })),
      groups: heuristic.nodes.filter((n) => n.role !== "context").map((n) => ({ name: n.name, description: n.description, role: n.role })),
      context: heuristic.nodes.filter((n) => n.role === "context").map((n) => ({ name: n.name })),
      links: heuristic.edges.map((e) => ({ from: nameOf.get(e.source)!, to: nameOf.get(e.target)!, label: e.label, weight: e.weight })),
      summaries: [],
    });
    check("mock: parsed", !result.parseFailed && result.usage.promptTokens > 0);
    check("mock: every file grouped once", result.groups.flatMap((g) => g.files).length === INPUT.files.length);
    check("mock: [mock] descriptions", result.groups.every((g) => g.description?.startsWith(MOCK_DESCRIPTION_PREFIX)));
    const mapped = applyPrMapGrouping(INPUT, collectPrMapLinks(INPUT), result);
    check(
      "mock: renamed cards keep their edges, with the mock verb",
      mapped.edges.length === heuristic.edges.length && mapped.edges.every((e) => e.label === "feeds"),
      JSON.stringify(mapped.edges)
    );
  } finally {
    await mock.close();
  }
}

async function main(): Promise<void> {
  partA();
  await partB();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exitCode = 1;
});
