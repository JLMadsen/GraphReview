/**
 * Smoke test for the app map (DESIGN.md §6.5).
 *
 *   npx tsx lib/jobs/smoke-test-app-map.ts
 *
 * Part A covers the pure builder (lib/jobs/app-map.ts) on a small synthetic
 * repo shaped like this one: layer classification, the heuristic feature
 * grouping (a GitLab feature spanning lib/gitlab and lib/jobs), member
 * matching, and assembly of cards and import-derived edges at all three
 * levels. Part B runs lib/ai/app-map.ts's three calls through the real client
 * against the mock server and applies the answers back onto the map. No Neo4j.
 */
import { MOCK_DESCRIPTION_PREFIX, startMockServer } from "@/lib/ai/mock-server";
import {
  explainAppCards,
  groupAppFeatures,
  normalizeAppFeatures,
  normalizeAppLayers,
  placeAppLayers,
  type AppMapAiFolder,
} from "@/lib/ai/app-map";
import type { AiProviderConfig } from "@/lib/ai";
import {
  buildAppMap,
  classifyLayer,
  heuristicFeatureGroups,
  matchMember,
  type AppMapInput,
  type StoredAppMap,
} from "./app-map";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const FILES = [
  "app/api/repos/[repoId]/review/route.ts",
  "app/settings/actions.ts",
  "app/settings/page.tsx",
  "components/graph/GraphView.tsx",
  "components/graph/ReviewPanel.tsx",
  "components/graph/useReview.ts",
  "lib/gitlab/client.ts",
  "lib/gitlab/types.ts",
  "lib/jobs/gitlab-access.ts",
  "lib/jobs/queue.ts",
  "lib/jobs/review.ts",
  "lib/neo4j/client.ts",
  "lib/neo4j/finding.ts",
  "lib/jobs/smoke-test-review.ts",
  "worker/index.ts",
];

const OWNER: Record<string, string> = {
  "app/api/repos/[repoId]/review/route.ts": "m-api",
  "app/settings/actions.ts": "m-settings",
  "app/settings/page.tsx": "m-settings",
  "components/graph/GraphView.tsx": "m-graph",
  "components/graph/ReviewPanel.tsx": "m-graph",
  "components/graph/useReview.ts": "m-graph",
  "lib/gitlab/client.ts": "m-gitlab",
  "lib/gitlab/types.ts": "m-gitlab",
  "lib/jobs/gitlab-access.ts": "m-jobs",
  "lib/jobs/queue.ts": "m-jobs",
  "lib/jobs/review.ts": "m-jobs",
  "lib/jobs/smoke-test-review.ts": "m-jobs",
  "lib/neo4j/client.ts": "m-neo4j",
  "lib/neo4j/finding.ts": "m-neo4j",
  "worker/index.ts": "m-worker",
};

const INPUT: AppMapInput = {
  files: FILES,
  ownerByPath: new Map(Object.entries(OWNER)),
  components: new Map(
    ["api", "settings", "graph", "gitlab", "jobs", "neo4j", "worker"].map((n) => [`m-${n}`, { id: `m-${n}`, name: n }])
  ),
  imports: [
    { from: "components/graph/ReviewPanel.tsx", to: "components/graph/useReview.ts" },
    { from: "components/graph/useReview.ts", to: "app/api/repos/[repoId]/review/route.ts" },
    { from: "app/api/repos/[repoId]/review/route.ts", to: "lib/jobs/queue.ts" },
    { from: "lib/jobs/review.ts", to: "lib/jobs/gitlab-access.ts" },
    { from: "lib/jobs/gitlab-access.ts", to: "lib/gitlab/client.ts" },
    { from: "lib/gitlab/client.ts", to: "lib/gitlab/types.ts" },
    { from: "lib/jobs/review.ts", to: "lib/neo4j/finding.ts" },
    { from: "lib/neo4j/finding.ts", to: "lib/neo4j/client.ts" },
    { from: "worker/index.ts", to: "lib/jobs/review.ts" },
  ],
};

function partA(): void {
  console.log("A. builder");
  check("route.ts is server", classifyLayer("app/api/repos/[repoId]/review/route.ts") === "server");
  check("actions.ts is server", classifyLayer("app/settings/actions.ts") === "server");
  check("page.tsx is ui", classifyLayer("app/settings/page.tsx") === "ui");
  check("useReview.ts is ui", classifyLayer("components/graph/useReview.ts") === "ui");
  check("lib/gitlab is integrations", classifyLayer("lib/gitlab/client.ts") === "integrations");
  check("lib/neo4j is data", classifyLayer("lib/neo4j/finding.ts") === "data");
  check("queue.ts is infrastructure", classifyLayer("lib/jobs/queue.ts") === "infrastructure");
  check("worker/ is infrastructure", classifyLayer("worker/index.ts") === "infrastructure");
  check("smoke test is tests", classifyLayer("lib/jobs/smoke-test-review.ts") === "tests");
  check("lib/jobs/review.ts is logic", classifyLayer("lib/jobs/review.ts") === "logic");

  const features = heuristicFeatureGroups(INPUT);
  const gitlab = features.find((g) => g.files.includes("lib/gitlab/client.ts"));
  check("GitLab feature spans lib/gitlab and lib/jobs", Boolean(gitlab?.files.includes("lib/jobs/gitlab-access.ts")), gitlab?.name);
  check("GitLab feature is named GitLab", gitlab?.name === "GitLab", gitlab?.name);
  const review = features.find((g) => g.files.includes("lib/jobs/review.ts"));
  check(
    "Review feature spans UI, route and job",
    Boolean(review && ["components/graph/ReviewPanel.tsx", "app/api/repos/[repoId]/review/route.ts"].every((f) => review.files.includes(f))),
    review?.files.join(", ")
  );
  check("every file in exactly one feature", features.flatMap((g) => g.files).sort().join() === [...FILES].sort().join());

  const groups = [
    { key: "a", members: ["lib/"] },
    { key: "b", members: ["lib/jobs/"] },
    { key: "c", members: ["lib/jobs/gitlab-access.ts"] },
  ];
  check("longest prefix wins", matchMember("lib/jobs/queue.ts", groups) === "b");
  check("exact path wins", matchMember("lib/jobs/gitlab-access.ts", groups) === "c");
  check("no match", matchMember("worker/index.ts", groups) === undefined);

  const arch = buildAppMap(INPUT, "architecture", null, null);
  check("architecture: UI first", arch.nodes[0]?.id === "layer:ui");
  check("architecture: ui → server edge", arch.edges.some((e) => e.source === "layer:ui" && e.target === "layer:server"));
  check("architecture: integrations card lists both modules", arch.nodes.find((n) => n.id === "layer:integrations")?.modules.length === 2);

  const mods = buildAppMap(INPUT, "modules", null, null);
  check("modules: one card per module", mods.nodes.length === 7);
  const jobsToGitlab = mods.edges.find((e) => e.source === "mod:m-jobs" && e.target === "mod:m-gitlab");
  check("modules: jobs → gitlab edge with sample", jobsToGitlab?.samples[0]?.from === "lib/jobs/gitlab-access.ts");
  check("modules: key file from in-degree", mods.nodes.find((n) => n.id === "mod:m-jobs")?.keyFiles[0]?.path === "lib/jobs/queue.ts");

  // A stored architecture run moves a file; every level's layer bars follow it.
  const storedArch: StoredAppMap = {
    level: "architecture",
    groups: [{ key: "logic", layer: "logic", name: "Logic", members: ["lib/jobs/gitlab-access.ts"] }],
    edges: [{ from: "ui", to: "server", label: "calls", explanation: "Hooks call the route handlers." }],
    model: "m",
    createdAt: "",
  };
  const archAi = buildAppMap(INPUT, "architecture", storedArch, storedArch);
  check("stored move applied", archAi.nodes.find((n) => n.id === "layer:logic")?.files.includes("lib/jobs/gitlab-access.ts") === true);
  check("stored edge label applied", archAi.edges.find((e) => e.source === "layer:ui" && e.target === "layer:server")?.label === "calls");

  const storedFeatures: StoredAppMap = {
    level: "features",
    groups: [{ key: "gitlab", name: "GitLab Integration", members: ["lib/gitlab/", "lib/jobs/gitlab-access.ts"] }],
    edges: [],
    model: "m",
    createdAt: "",
  };
  const featAi = buildAppMap(INPUT, "features", storedFeatures, storedArch);
  const gl = featAi.nodes.find((n) => n.id === "feat:gitlab");
  check("stored feature: 3 files", gl?.files.length === 3);
  check("stored feature: spans logic + integrations", gl?.layers.map((l) => l.layer).sort().join() === "integrations,logic");
  check("stored feature: leftovers placed by heuristic", featAi.unplaced === FILES.length - 3);
}

async function partB(): Promise<void> {
  console.log("B. AI calls against the mock server");
  const folders: AppMapAiFolder[] = [
    { dir: "lib/gitlab", module: "gitlab", files: [{ name: "client.ts", declarations: ["getMergeRequest"], layer: "integrations" }] },
    { dir: "lib/jobs", files: [{ name: "gitlab-access.ts", declarations: [], layer: "integrations" }] },
  ];
  const norm = normalizeAppFeatures(
    { features: [{ name: "GitLab", members: ["lib/gitlab", "lib/jobs/gitlab-access.ts", "nope/", "lib/jobs/missing.ts"] }, { name: "gitlab", members: ["lib/"] }] },
    folders
  );
  check("normalize: unknown members dropped, bare folder gets /", norm[0]?.members.join() === "lib/gitlab/,lib/jobs/gitlab-access.ts", norm[0]?.members.join());
  check("normalize: duplicate names dropped", norm.length === 1);
  const layers = normalizeAppLayers({ layers: [{ layer: "logic", description: "x" }, { layer: "bogus" }], moves: [{ member: "lib/jobs/", layer: "logic" }] }, folders);
  check("normalize layers", layers.layers.length === 1 && layers.moves[0]?.member === "lib/jobs/");

  const mock = await startMockServer({ port: 0, host: "127.0.0.1", delayMs: 0, log: () => undefined });
  const config: AiProviderConfig = { baseUrl: `${mock.url}/v1`, apiKey: "test-key", model: "mock-review-1" };
  try {
    const tree = { repoName: "demo", folders };
    const features = await groupAppFeatures(config, tree);
    check("features: parsed", !features.parseFailed && features.features.length > 0);
    const placed = await placeAppLayers(config, tree);
    check("layers: parsed", !placed.parseFailed && placed.layers.some((l) => l.layer === "integrations"));

    const map = buildAppMap(INPUT, "modules", null, null);
    const nameOf = new Map(map.nodes.map((n) => [n.id, n.name]));
    const jobs = map.nodes.find((n) => n.id === "mod:m-jobs")!;
    const explained = await explainAppCards(config, {
      repoName: "demo",
      cardKind: "module",
      cards: [
        {
          name: jobs.name,
          layers: "Logic 2",
          modules: [],
          files: jobs.files.map((f) => ({ path: f, declarations: [] })),
          outgoing: map.edges
            .filter((e) => e.source === jobs.id)
            .map((e) => ({ to: nameOf.get(e.target)!, weight: e.weight, samples: [] })),
          incoming: [],
        },
      ],
    });
    check("explain: parsed", !explained.parseFailed && explained.cards[0]?.explanation?.startsWith(MOCK_DESCRIPTION_PREFIX) === true);
    check("explain: key file is the card's own", jobs.files.includes(explained.cards[0]?.keyFiles[0]?.path ?? ""));
    check("explain: an edge per outgoing connection", explained.edges.length === map.edges.filter((e) => e.source === jobs.id).length);
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
