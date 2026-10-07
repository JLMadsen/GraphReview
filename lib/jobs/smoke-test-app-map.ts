/**
 * Smoke test for the app map (DESIGN.md §6.5).
 *
 *   npx tsx lib/jobs/smoke-test-app-map.ts
 *
 * Part A covers the pure builder (lib/jobs/app-map.ts) on a small synthetic
 * repo shaped like this one: layer classification, the heuristic feature
 * grouping (a GitLab feature spanning lib/gitlab and lib/jobs), member
 * matching, loose members resolved to real ones, coverage and the compaction
 * of placed files into members, and assembly of cards and import-derived
 * edges at all three levels. Part B runs lib/ai/app-map.ts's four calls
 * through the real client against the mock server and applies the answers
 * back onto the map. No database.
 */
import { MOCK_DESCRIPTION_PREFIX, startMockServer } from "@/lib/ai/mock-server";
import {
  explainAppCards,
  groupAppFeatures,
  knownMembersOf,
  normalizeAppFeatures,
  normalizeAppLayers,
  normalizeAppPlacements,
  placeAppFiles,
  placeAppLayers,
  resolveMember,
  type AppFeaturesReport,
  type AppMapAiFolder,
} from "@/lib/ai/app-map";
import type { AiProviderConfig } from "@/lib/ai";
import {
  buildAppMap,
  classifyLayer,
  compactPlacements,
  heuristicFeatureGroups,
  matchMember,
  uncoveredFiles,
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

  // Members as models actually write them.
  const known = knownMembersOf([...FILES, "next.config.mjs", "middleware.ts"]);
  const resolves = (raw: string, expected: string[]) => {
    const got = resolveMember(raw, known);
    check(`member ${JSON.stringify(raw)} → ${expected.join(", ") || "nothing"}`, got.join() === expected.join(), got.join());
  };
  resolves("lib/gitlab", ["lib/gitlab/"]);
  resolves("(root)/", ["next.config.mjs", "middleware.ts"]);
  resolves("(root)/next.config.mjs", ["next.config.mjs"]);
  resolves("/worker/index.ts", ["worker/index.ts"]);
  resolves("./worker/index.ts", ["worker/index.ts"]);
  resolves("lib/jobs/*", ["lib/jobs/"]);
  resolves("lib/jobs/**", ["lib/jobs/"]);
  resolves("components/graph/use*", ["components/graph/useReview.ts"]);
  resolves("lib/**/client.ts", ["lib/gitlab/client.ts", "lib/neo4j/client.ts"]);
  resolves("lib/jobs/gitlab*", ["lib/jobs/gitlab-access.ts"]);
  resolves("queue.ts", ["lib/jobs/queue.ts"]);
  resolves("client.ts", []);
  resolves("jobs/review.ts", ["lib/jobs/review.ts"]);
  resolves("Lib/GitLab", ["lib/gitlab/"]);
  resolves("gitlab/", ["lib/gitlab/"]);
  resolves("**", []);
  resolves("lib/jobs/missing.ts", []);

  // Coverage, and placed files compacted into members.
  const partial = [{ key: "jobs", members: ["lib/jobs/", "worker/"] }, { key: "ui", members: ["components/"] }];
  const left = uncoveredFiles(FILES, partial);
  check("uncovered: app, lib/gitlab, lib/neo4j", left.length === 7 && left.every((f) => /^(app|lib\/gitlab|lib\/neo4j)\//.test(f)), left.join());
  const compact = compactPlacements(
    FILES,
    new Map([
      ["lib/neo4j/client.ts", "data"],
      ["lib/neo4j/finding.ts", "data"],
      ["lib/gitlab/client.ts", "data"],
      ["lib/gitlab/types.ts", "jobs"],
      ["app/settings/page.tsx", "ui"],
    ])
  );
  check("compact: a wholly placed folder becomes its prefix", compact.get("data")?.join() === "lib/gitlab/client.ts,lib/neo4j/", compact.get("data")?.join());
  check("compact: a split folder stays file by file", compact.get("jobs")?.join() === "lib/gitlab/types.ts", compact.get("jobs")?.join());
  check("compact: a folder with an unplaced file stays file by file", compact.get("ui")?.join() === "app/settings/page.tsx", compact.get("ui")?.join());
  const covering = compactPlacements(FILES, new Map(left.map((f) => [f, "rest"])));
  check("compact: never a prefix over covered files", covering.get("rest")?.every((m) => m !== "lib/") === true, covering.get("rest")?.join());
  check("compact: placed files end up covered", uncoveredFiles(FILES, [...partial, { key: "rest", members: covering.get("rest") ?? [] }]).length === 0);

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
  const report: AppFeaturesReport = { droppedMembers: [], droppedFeatures: [] };
  const norm = normalizeAppFeatures(
    { features: [{ name: "GitLab", members: ["lib/gitlab", "lib/jobs/gitlab-access.ts", "nope/", "lib/jobs/missing.ts"] }, { name: "gitlab", members: ["lib/"] }] },
    folders,
    report
  );
  check("normalize: unknown members dropped, bare folder gets /", norm[0]?.members.slice(0, 2).join() === "lib/gitlab/,lib/jobs/gitlab-access.ts", norm[0]?.members.join());
  check("normalize: dropped members reported", report.droppedMembers.join() === "nope/,lib/jobs/missing.ts", report.droppedMembers.join());
  check("normalize: a repeated name merges into the first", norm.length === 1 && norm[0].members.at(-1) === "lib/", norm[0]?.members.join());
  const wide: AppMapAiFolder[] = Array.from({ length: 20 }, (_, i) => ({ dir: `f${i}`, files: [{ name: "a.ts", declarations: [] }] }));
  const capReport: AppFeaturesReport = { droppedMembers: [], droppedFeatures: [] };
  const capped = normalizeAppFeatures({ features: wide.map((f, i) => ({ name: `Feature ${i}`, members: [`${f.dir}/`] })) }, wide, capReport);
  check(
    "normalize: features past the cap reported",
    capped.length === 18 && capReport.droppedFeatures.join() === "Feature 18,Feature 19",
    capReport.droppedFeatures.join()
  );
  const layers = normalizeAppLayers({ layers: [{ layer: "logic", description: "x" }, { layer: "bogus" }], moves: [{ member: "lib/jobs/", layer: "logic" }] }, folders);
  check("normalize layers", layers.layers.length === 1 && layers.moves[0]?.member === "lib/jobs/");

  const placeInput = {
    repoName: "demo",
    features: [{ name: "GitLab", members: ["lib/gitlab/"] }, { name: "Jobs", members: ["lib/jobs/"] }],
    files: [
      { path: "lib/runtime/a.ts", declarations: [] },
      { path: "lib/runtime/b.ts", declarations: [] },
      { path: "next.config.mjs", declarations: [] },
    ],
  };
  const placements = normalizeAppPlacements(
    {
      placements: [
        { member: "lib/runtime/a.ts", feature: "gitlab" },
        { member: "lib/runtime/", feature: "Jobs" },
        { member: "next.config.mjs", feature: "Nonexistent" },
        { member: "lib/elsewhere.ts", feature: "Jobs" },
      ],
    },
    placeInput
  );
  check("placements: a file answer beats a folder answer", placements.get("lib/runtime/a.ts") === "GitLab");
  check("placements: a folder answer places the listed files under it", placements.get("lib/runtime/b.ts") === "Jobs");
  check("placements: unknown features and unlisted files ignored", placements.size === 2);

  const mock = await startMockServer({ port: 0, host: "127.0.0.1", delayMs: 0, log: () => undefined });
  const config: AiProviderConfig = { baseUrl: `${mock.url}/v1`, apiKey: "test-key", model: "mock-review-1" };
  try {
    const tree = {
      repoName: "demo",
      folders: [...folders, { dir: "", files: [{ name: "next.config.mjs", declarations: [] }, { name: "middleware.ts", declarations: ["middleware"] }] }],
    };
    const features = await groupAppFeatures(config, tree);
    check("features: parsed", !features.parseFailed && features.features.length > 0);
    // The mock's grouping skips the root files, as models often do; the follow-up places them.
    const allFiles = tree.folders.flatMap((f) => f.files.map((file) => (f.dir ? `${f.dir}/${file.name}` : file.name)));
    const grouped = features.features.map((f) => ({ key: f.name, members: f.members }));
    const leftovers = uncoveredFiles(allFiles, grouped);
    check("features: root files left out", [...leftovers].sort().join() === "middleware.ts,next.config.mjs", leftovers.join());
    const place = await placeAppFiles(config, {
      repoName: "demo",
      features: features.features,
      files: leftovers.map((path) => ({ path, declarations: [] })),
    });
    check("place: parsed", !place.parseFailed && place.placements.size === 2);
    const added = compactPlacements(allFiles, place.placements);
    const after = grouped.map((g) => ({ ...g, members: [...g.members, ...(added.get(g.key) ?? [])] }));
    check("place: every file covered afterwards", uncoveredFiles(allFiles, after).length === 0);
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
