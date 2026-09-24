/**
 * Checks for feature merges' pure logic (DESIGN.md §6.3) — no Neo4j needed.
 *
 *   npx tsx lib/jobs/smoke-test-merges.ts
 *
 * Covers ownership resolution (merged modules claiming files out of folder
 * modules, most specific wins, dead patterns) and every heuristic kind
 * (shared name, import-only, move-file, rename) on a small Next.js-shaped repo.
 */
import { clusterByFolderDepth } from "@/lib/analysis/graph-builder";
import { computeMergeSuggestions, displayName, featureKey, type HeuristicModule } from "./merge-heuristics";
import { routeHint } from "./merge-naming";
import { patternsOverlap } from "./merges";
import { folderModuleId, resolveOwnership } from "./ownership";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const REPO = "r1";
const DEPTH = 2;

const files = [
  "app/map/page.tsx",
  "app/map/[id]/page.tsx",
  "components/map/MapView.tsx",
  "components/map/Marker.tsx",
  "app/api/map/route.ts",
  "app/api/users/route.ts",
  "app/settings/page.tsx",
  "components/settings/Form.tsx",
  "components/charts/Chart.tsx",
  "app/dashboard/page.tsx",
  "lib/utils/format.ts",
  "lib/ai/review.ts",
  "lib/ai/label.ts",
  "app/layout.tsx",
  "components/home/Hero.tsx",
  "components/home/Intro.tsx",
];

const edges = [
  { from: "app/map/page.tsx", to: "components/map/MapView.tsx" },
  { from: "app/map/[id]/page.tsx", to: "components/map/Marker.tsx" },
  { from: "components/map/MapView.tsx", to: "components/map/Marker.tsx" },
  { from: "components/map/MapView.tsx", to: "app/api/map/route.ts" },
  { from: "app/settings/page.tsx", to: "components/settings/Form.tsx" },
  // charts used only by the dashboard → import-only suggestion
  { from: "app/dashboard/page.tsx", to: "components/charts/Chart.tsx" },
  { from: "app/dashboard/page.tsx", to: "components/charts/Chart.tsx" },
  { from: "app/dashboard/page.tsx", to: "components/charts/Chart.tsx" },
  // utils used by everyone → shared foundation
  { from: "app/map/page.tsx", to: "lib/utils/format.ts" },
  { from: "app/settings/page.tsx", to: "lib/utils/format.ts" },
  { from: "app/dashboard/page.tsx", to: "lib/utils/format.ts" },
  { from: "components/map/MapView.tsx", to: "lib/utils/format.ts" },
  { from: "app/api/users/route.ts", to: "lib/utils/format.ts" },
  // components/home used only by the root app files → import-only, but by file
  { from: "app/layout.tsx", to: "components/home/Hero.tsx" },
  { from: "app/layout.tsx", to: "components/home/Intro.tsx" },
  { from: "app/layout.tsx", to: "components/home/Hero.tsx" },
  // lib/ai/review.ts belongs with the map feature (for the test's sake)
  { from: "components/map/MapView.tsx", to: "lib/ai/review.ts" },
  { from: "app/map/page.tsx", to: "lib/ai/review.ts" },
];

const clusters = clusterByFolderDepth(files, DEPTH);

/** Same as module-tier.ts's pathPatternFor: the folder (cut at the module depth) a cluster came from. */
function patternOf(filePath: string): string {
  const dir = filePath.split("/").slice(0, -1);
  return `${dir.slice(0, DEPTH).join("/")}/**`;
}

function modulesFor(owner: Map<string, string>, merged: HeuristicModule[] = []): HeuristicModule[] {
  const ownership = resolveOwnership(REPO, clusters, merged);
  return [
    ...ownership.liveFolderModules.map(({ id, cluster }) => ({
      id,
      name: cluster.name,
      origin: "folder" as const,
      pathPatterns: [patternOf(cluster.filePaths[0])],
    })),
    ...merged,
  ].filter((m) => [...owner.values()].includes(m.id));
}

console.log("feature keys");
check("app/map → map", featureKey("app/map") === "map");
check("app/api/map → map", featureKey("app/api/map") === "map");
check("components/maps → map (plural)", featureKey("components/maps") === "map");
check("app/(shop)/checkout → checkout", featureKey("app/(shop)/checkout") === "checkout");
check("app/api → none (layer)", featureKey("app/api") === "");
check("lib/utils → none (generic)", featureKey("lib/utils") === "");
check("app/map/[id] → none (dynamic segment)", featureKey("app/map/[id]") === "");
check("displayName user-profile", displayName("components/user-profile") === "User profile");

console.log("overlap (accept all)");
check("same folder overlaps", patternsOverlap("components/map/**", "components/map/**"));
check("nested folders overlap", patternsOverlap("app/**", "app/map/**"));
check("file inside folder overlaps", patternsOverlap("lib/ai/review.ts", "lib/ai/**"));
check("sibling folders don't", !patternsOverlap("app/map/**", "app/mapping/**"));
check("different files don't", !patternsOverlap("app/layout.tsx", "app/page.tsx"));

console.log("route hints");
check("app/map/page.tsx → /map", routeHint("app/map/page.tsx") === "/map");
check("src/app/api/map/route.ts → /api/map", routeHint("src/app/api/map/route.ts") === "/api/map");
check("app/(shop)/cart/page.tsx → /cart", routeHint("app/(shop)/cart/page.tsx") === "/cart");
check("pages/map/index.tsx → /map", routeHint("pages/map/index.tsx") === "/map");
check("components/x.tsx → none", routeHint("components/x.tsx") === undefined);

console.log("ownership without merges");
const plain = resolveOwnership(REPO, clusters, []);
check(
  "every file owned by its folder module",
  files.every((f) => plain.componentIdByFile.get(f)?.startsWith(`${REPO}:module:`))
);

console.log("heuristics before any merge");
const before = computeMergeSuggestions({
  filePaths: files,
  edges,
  ownerByFile: plain.componentIdByFile,
  modules: modulesFor(plain.componentIdByFile),
  moduleDepth: DEPTH,
});
const mapSuggestion = before.find((s) => s.kind === "merge" && s.name === "Map");
check("suggests merging the map folders", Boolean(mapSuggestion), JSON.stringify(before.map((s) => s.key)));
check(
  "map merge includes app/map, components/map and app/api/map",
  JSON.stringify(mapSuggestion?.members) === JSON.stringify(["app/api/map/**", "app/map/**", "components/map/**"]),
  JSON.stringify(mapSuggestion?.members)
);
check("map merge scores above threshold", (mapSuggestion?.score ?? 0) >= 0.5);
check(
  "settings name group suggested",
  before.some((s) => s.kind === "merge" && s.members.includes("app/settings/**") && s.members.includes("components/settings/**"))
);
check(
  "import-only: charts with dashboard",
  before.some((s) => s.kind === "merge" && s.members.includes("components/charts/**") && s.members.includes("app/dashboard/**")),
  JSON.stringify(before.map((s) => s.key))
);
const home = before.find((s) => s.members.includes("components/home/**"));
check(
  "shallow app/ module referenced by its files, never app/**",
  Boolean(home) && home!.members.includes("app/layout.tsx") && !home!.members.includes("app/**"),
  JSON.stringify(home?.members)
);
check("shared lib/utils never suggested", !before.some((s) => s.members.some((m) => m.startsWith("lib/utils"))));

console.log("ownership with a merged Map module");
const MAP_ID = `${REPO}:feature:map`;
const mapModule: HeuristicModule = {
  id: MAP_ID,
  name: "Map",
  origin: "merge",
  pathPatterns: ["app/map/**", "components/map/**", "app/api/map/**", "lib/ai/review.ts"],
};
const merged = resolveOwnership(REPO, clusters, [mapModule]);
check("app/map/page.tsx → Map", merged.componentIdByFile.get("app/map/page.tsx") === MAP_ID);
check("app/api/map/route.ts carved out of app/api", merged.componentIdByFile.get("app/api/map/route.ts") === MAP_ID);
check(
  "app/api/users/route.ts stays in app/api",
  merged.componentIdByFile.get("app/api/users/route.ts") === folderModuleId(REPO, "api")
);
check("exact file claim: lib/ai/review.ts → Map", merged.componentIdByFile.get("lib/ai/review.ts") === MAP_ID);
check("lib/ai/label.ts stays in the leftover lib/ai module", merged.componentIdByFile.get("lib/ai/label.ts") === folderModuleId(REPO, "ai"));
check(
  "app/map and components/map folder modules are gone",
  !merged.liveFolderModules.some((m) => m.cluster.name === "map" || m.cluster.name === "app/map")
);
check("no dead patterns", !merged.deadPatternsByMergedId.has(MAP_ID));

const withDead = resolveOwnership(REPO, clusters, [
  { id: MAP_ID, pathPatterns: [...mapModule.pathPatterns, "features/gone/**"] },
]);
check(
  "vanished folder reported as dead",
  JSON.stringify(withDead.deadPatternsByMergedId.get(MAP_ID)) === JSON.stringify(["features/gone/**"])
);

console.log("heuristics after the merge");
const after = computeMergeSuggestions({
  filePaths: files,
  edges,
  ownerByFile: merged.componentIdByFile,
  modules: modulesFor(merged.componentIdByFile, [mapModule]),
  moduleDepth: DEPTH,
});
check("map merge no longer suggested", !after.some((s) => s.kind === "merge" && s.name === "Map"));

console.log("rename detection");
const renamedFiles = files.map((f) => f.replace("components/map/", "components/geo/"));
const renamedEdges = edges.map((e) => ({
  from: e.from.replace("components/map/", "components/geo/"),
  to: e.to.replace("components/map/", "components/geo/"),
}));
const renamedClusters = clusterByFolderDepth(renamedFiles, DEPTH);
const mapAfterRename: HeuristicModule = {
  ...mapModule,
  pathPatterns: ["app/map/**", "app/api/map/**", "lib/ai/review.ts"],
  lostFolders: [{ pattern: "components/map/**", fileNames: ["MapView.tsx", "Marker.tsx"], lostAt: "now" }],
};
const renamedOwnership = resolveOwnership(REPO, renamedClusters, [mapAfterRename]);
const renamedSuggestions = computeMergeSuggestions({
  filePaths: renamedFiles,
  edges: renamedEdges,
  ownerByFile: renamedOwnership.componentIdByFile,
  modules: [
    ...renamedOwnership.liveFolderModules.map(({ id, cluster }) => ({
      id,
      name: cluster.name,
      origin: "folder" as const,
      pathPatterns: [patternOf(cluster.filePaths[0])],
    })),
    mapAfterRename,
  ],
  moduleDepth: DEPTH,
});
check(
  "suggests extending Map with components/geo",
  renamedSuggestions.some(
    (s) => s.kind === "extend" && s.targetComponentId === MAP_ID && s.members.includes("components/geo/**")
  ),
  JSON.stringify(renamedSuggestions.map((s) => s.key))
);

console.log("move-file (split)");
const splitFiles = [...files, "lib/ai/prompts.ts"];
const splitEdges = [
  ...edges.filter((e) => e.to !== "lib/ai/review.ts"),
  { from: "lib/ai/prompts.ts", to: "components/map/MapView.tsx" },
  { from: "app/map/page.tsx", to: "lib/ai/prompts.ts" },
];
const mapWithoutReview: HeuristicModule = { ...mapModule, pathPatterns: ["app/map/**", "components/map/**", "app/api/map/**"] };
const splitClusters = clusterByFolderDepth(splitFiles, DEPTH);
const splitOwnership = resolveOwnership(REPO, splitClusters, [mapWithoutReview]);
const splitSuggestions = computeMergeSuggestions({
  filePaths: splitFiles,
  edges: splitEdges,
  ownerByFile: splitOwnership.componentIdByFile,
  modules: [
    ...splitOwnership.liveFolderModules.map(({ id, cluster }) => ({
      id,
      name: cluster.name,
      origin: "folder" as const,
      pathPatterns: [patternOf(cluster.filePaths[0])],
    })),
    mapWithoutReview,
  ],
  moduleDepth: DEPTH,
});
check(
  "suggests moving lib/ai/prompts.ts into Map",
  splitSuggestions.some(
    (s) => s.kind === "move-file" && s.targetComponentId === MAP_ID && s.members.includes("lib/ai/prompts.ts")
  ),
  JSON.stringify(splitSuggestions.map((s) => s.key))
);
check(
  "does not move lib/ai/label.ts (no imports to Map)",
  !splitSuggestions.some((s) => s.members.includes("lib/ai/label.ts"))
);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
