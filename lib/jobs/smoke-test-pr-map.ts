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
import type { chatCompletion } from "@/lib/ai/client";

/** A provider config for stubbed `chat` calls — never dialled. */
function stubConfig(): AiProviderConfig {
  return { baseUrl: "http://127.0.0.1:9/v1", apiKey: "unused", model: "stub" };
}
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

  // One flat folder is one module; a large, partly deleted one splits.
  const flat: PrMapInput = {
    files: Array.from({ length: 12 }, (_, i) => ({
      path: `src/ui/F${i}.tsx`,
      status: i < 4 ? "removed" : "modified",
      additions: i < 4 ? 0 : 5,
      deletions: 5,
    })),
    componentIdByPath: new Map(Array.from({ length: 12 }, (_, i) => [`src/ui/F${i}.tsx`, "c:ui"] as const)),
    components: new Map([["c:ui", { id: "c:ui", name: "ui" }]]),
    imports: [],
  };
  const flatMap = buildHeuristicPrMap(flat);
  check(
    "a large module card splits off its deleted files",
    JSON.stringify(flatMap.nodes.map((n) => [n.id, n.files.length])) ===
      JSON.stringify([["code:c:ui", 8], ["code:c:ui:removed", 4]]),
    JSON.stringify(flatMap.nodes.map((n) => [n.id, n.files.length]))
  );
  const small = buildHeuristicPrMap({ ...flat, files: flat.files.slice(0, 8) });
  check("a small module card stays whole", small.nodes.length === 1, JSON.stringify(small.nodes.map((n) => n.id)));
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

  // A leftover code file of a module the grouping already placed joins that
  // group; a leftover test of the same module keeps its own card.
  const wider: PrMapInput = {
    ...INPUT,
    files: [...INPUT.files, { path: "src/ffi/abi.ts", status: "added", additions: 12, deletions: 0 }],
    componentIdByPath: new Map([...INPUT.componentIdByPath, ["src/ffi/abi.ts", "c:ffi"]]),
  };
  const partial = applyPrMapGrouping(wider, collectPrMapLinks(wider), {
    groups: [{ name: "Runtime Host", files: ["src/ffi/ffiRuntimeHost.ts"] }],
    edgeLabels: [],
  });
  const hostFiles = partial.nodes.find((n) => n.name === "Runtime Host")?.files.map((f) => f.path) ?? [];
  check(
    "leftover code joins its module's group; its test keeps a test card",
    hostFiles.includes("src/ffi/abi.ts") &&
      !hostFiles.includes("src/ffi/ffiRuntimeHost.test.ts") &&
      partial.nodes.some((n) => n.role === "test" && n.files.some((f) => f.path === "src/ffi/ffiRuntimeHost.test.ts")),
    JSON.stringify(partial.nodes.map((n) => [n.name, n.files.map((f) => f.path)]))
  );
  check(
    "a module the grouping never placed keeps its heuristic card",
    partial.nodes.some((n) => n.id === "code:c:client"),
    JSON.stringify(partial.nodes.map((n) => n.id))
  );

  // Manifests, docs and tests the model dropped into a code box go back to their own cards.
  const stray = applyPrMapGrouping(INPUT, collectPrMapLinks(INPUT), {
    groups: [
      { name: "Everything", files: INPUT.files.map((f) => f.path) },
    ],
    edgeLabels: [],
  });
  const everything = stray.nodes.find((n) => n.name === "Everything")?.files.map((f) => f.path) ?? [];
  check(
    "dependency, docs and test files leave an AI code group",
    JSON.stringify(everything) === JSON.stringify(["src/client.ts", "src/ffi/ffiRuntimeHost.ts"]) &&
      stray.nodes.some((n) => n.id === "dep") &&
      stray.nodes.some((n) => n.id === "docs") &&
      stray.nodes.some((n) => n.role === "test"),
    JSON.stringify(stray.nodes.map((n) => [n.id, n.files.map((f) => f.path)]))
  );
  const docsOnly = applyPrMapGrouping(INPUT, collectPrMapLinks(INPUT), {
    groups: [{ name: "Docs And Deps", files: ["README.md", "package.json", "package-lock.json"] }],
    edgeLabels: [],
  });
  check(
    "a group of only non-code files keeps them",
    docsOnly.nodes.find((n) => n.name === "Docs And Deps")?.files.length === 3
  );

  // An oversized box is sent back once; a smaller split replaces it, a worse one doesn't.
  const big = Array.from({ length: 30 }, (_, i) => ({
    path: `src/ui/F${i}.tsx`,
    status: "modified",
    additions: 1,
    deletions: 0,
    group: "ui",
    highlights: [],
  }));
  const answer = (groups: Array<{ name: string; files: string[] }>) => ({
    content: "```json\n" + JSON.stringify({ groups, edges: [] }) + "\n```",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  });
  const paths = big.map((f) => f.path);
  const bigInput = { files: big, groups: [{ name: "ui", role: "code" }], context: [], links: [], summaries: [] };
  let asked: string[] = [];
  const splitting = await groupPrMap(stubConfig(), bigInput, {
    chat: (async (_config, messages) => {
      asked.push(messages[messages.length - 1].content);
      return asked.length === 1
        ? answer([{ name: "All Of It", files: paths }])
        : answer([
            { name: "Old Part", files: paths.slice(0, 15) },
            { name: "New Part", files: paths.slice(15) },
          ]);
    }) as typeof chatCompletion,
  });
  check(
    "oversized box is split by a follow-up",
    splitting.calls === 2 &&
      asked[1]?.includes('"All Of It" holds 30 of the 30') &&
      JSON.stringify(splitting.groups.map((g) => g.files.length)) === "[15,15]" &&
      splitting.usage.totalTokens === 30,
    JSON.stringify({ calls: splitting.calls, groups: splitting.groups.map((g) => g.files.length) })
  );
  check("the first prompt states the diff size and a group range", /30 changed files .* aim for 4-8 groups/.test(asked[0] ?? ""));
  asked = [];
  const stubborn = await groupPrMap(stubConfig(), bigInput, {
    chat: (async (_config, messages) => {
      asked.push(messages[messages.length - 1].content);
      return asked.length === 1
        ? answer([{ name: "All Of It", files: paths }])
        : answer([{ name: "Some Of It", files: paths.slice(0, 5) }]);
    }) as typeof chatCompletion,
  });
  check(
    "a follow-up that drops files is ignored",
    stubborn.calls === 2 && stubborn.groups.length === 1 && stubborn.groups[0].files.length === 30
  );
  asked = [];
  const fine = await groupPrMap(stubConfig(), bigInput, {
    chat: (async (_config, messages) => {
      asked.push(messages[messages.length - 1].content);
      return answer([
        { name: "A", files: paths.slice(0, 10) },
        { name: "B", files: paths.slice(10, 20) },
        { name: "C", files: paths.slice(20) },
      ]);
    }) as typeof chatCompletion,
  });
  check("balanced boxes need no follow-up", fine.calls === 1 && asked.length === 1);

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
