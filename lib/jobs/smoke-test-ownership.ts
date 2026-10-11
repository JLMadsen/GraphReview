/**
 * Checks for module ownership (DESIGN.md §6.3) — which component owns each
 * file once accepted feature merges claim files out of folder modules. Pure
 * logic, no database.
 *
 *   npx tsx lib/jobs/smoke-test-ownership.ts
 *
 * Covers plain folder ownership, merged modules carving folders and exact
 * files out of folder modules (most specific wins), dead patterns, and how a
 * flat folder split by name is stored.
 */
import { clusterByFolderDepth } from "@/lib/analysis/graph-builder";
import { folderModuleId, pathPatternsFor, resolveOwnership, type MergedModuleInput } from "./ownership";

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
  "lib/utils/format.ts",
  "lib/ai/review.ts",
  "lib/ai/prompts.ts",
  "app/layout.tsx",
];

const clusters = clusterByFolderDepth(files, DEPTH);

console.log("ownership without merges");
const plain = resolveOwnership(REPO, clusters, []);
check(
  "every file owned by its folder module",
  files.every((f) => plain.componentIdByFile.get(f)?.startsWith(`${REPO}:module:`))
);

console.log("ownership with a merged Map module");
const MAP_ID = `${REPO}:feature:map`;
const mapModule: MergedModuleInput = {
  id: MAP_ID,
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
check("lib/ai/prompts.ts stays in the leftover lib/ai module", merged.componentIdByFile.get("lib/ai/prompts.ts") === folderModuleId(REPO, "ai"));
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

// A flat folder split by name: its core keeps `lib/big/**`, the part lists
// its files, so the folder pattern can't claim the part's files too.
console.log("\nsplit flat folder");
const bigCore = { name: "big", folder: "lib/big", filePaths: ["lib/big/core.ts", "lib/big/util.ts"] };
const bigPart = { name: "big · chart", folder: "lib/big", filePaths: ["lib/big/chart.ts", "lib/big/chart-axis.ts", "lib/big/use-chart.ts"], exactFiles: true as const };
check(
  "a name-cut part is stored with its files, a core with its folder",
  JSON.stringify(pathPatternsFor(bigPart)) === JSON.stringify(["lib/big/chart-axis.ts", "lib/big/chart.ts", "lib/big/use-chart.ts"]) &&
    JSON.stringify(pathPatternsFor(bigCore)) === '["lib/big/**"]'
);
const bigOwnership = resolveOwnership(REPO, [bigCore, bigPart], []);
check(
  "the part owns its files, the core the rest of the folder",
  bigOwnership.componentIdByFile.get("lib/big/chart.ts") !== bigOwnership.componentIdByFile.get("lib/big/core.ts") &&
    bigOwnership.componentIdByFile.get("lib/big/core.ts") === bigOwnership.componentIdByFile.get("lib/big/util.ts"),
  JSON.stringify([...bigOwnership.componentIdByFile])
);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
