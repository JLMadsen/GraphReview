/**
 * Checks for splitting oversized folder modules (lib/analysis/split-modules.ts).
 *
 *   npx tsx lib/analysis/smoke-test-split-modules.ts
 *
 * Pure: synthetic file lists and import edges, no checkout.
 */
import { clusterByFolderDepth, type ModuleCluster } from "./graph-builder";
import { MAX_MODULE_FILES, nameStem, splitLargeModules } from "./split-modules";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function summary(modules: ModuleCluster[]): string {
  return JSON.stringify(modules.map((m) => [m.name, m.filePaths.length, m.exactFiles ? "exact" : m.folder]));
}

console.log("name stems");
const stems = Object.fromEntries(
  [
    "c/PrMapCanvas.tsx",
    "c/usePrMap.ts",
    "c/pr-map-types.ts",
    "c/useChecklist.ts",
    "c/review-visuals.ts",
    "c/LabelsControl.tsx",
    "j/smoke-test-pr-map.ts",
    "j/impact.test.ts",
    "g/GraphCanvas.tsx",
    "p/test_parser.py",
    "x/123.ts",
  ].map((p) => [p, nameStem(p, p.startsWith("g/") ? "graph" : "")])
);
check(
  "leading words, two when the first is short, tests named for their subject",
  stems["c/PrMapCanvas.tsx"] === "pr map" &&
    stems["c/usePrMap.ts"] === "pr map" &&
    stems["c/pr-map-types.ts"] === "pr map" &&
    stems["c/useChecklist.ts"] === "checklist" &&
    stems["c/review-visuals.ts"] === "review" &&
    stems["c/LabelsControl.tsx"] === "label" &&
    stems["j/smoke-test-pr-map.ts"] === "pr map" &&
    stems["j/impact.test.ts"] === "impact" &&
    stems["g/GraphCanvas.tsx"] === "graph canvas" &&
    stems["p/test_parser.py"] === "parser" &&
    stems["x/123.ts"] === "",
  JSON.stringify(stems)
);

// A flat UI folder of 36 files: four features of five files, each feature
// importing its own types, a view importing everything (a hub), a barrel,
// and shared widgets imported from every feature.
console.log("\nflat folder");
const features = ["Chart", "Table", "Upload", "Search"];
const flatFiles: string[] = [];
const flatEdges: Array<{ from: string; to: string }> = [];
for (const f of features) {
  const kebab = f.toLowerCase();
  const own = [`ui/${f}Panel.tsx`, `ui/${f}Toolbar.tsx`, `ui/${kebab}-types.ts`, `ui/use${f}.ts`, `ui/${kebab}-utils.ts`];
  flatFiles.push(...own);
  flatEdges.push(
    { from: own[0], to: own[1] },
    { from: own[0], to: own[2] },
    { from: own[0], to: own[3] },
    { from: own[3], to: own[2] },
    { from: own[1], to: own[4] },
    { from: own[0], to: "ui/Spark.tsx" },
    { from: own[1], to: "ui/types.ts" }
  );
}
const filler = ["Avatar", "Badge", "Banner", "Breadcrumb", "Divider", "Footer", "Header", "Icon", "Logo", "Menu", "Pill", "Tooltip"].map(
  (name) => `ui/${name}.tsx`
);
flatFiles.push("ui/MainView.tsx", "ui/index.ts", "ui/Spark.tsx", "ui/types.ts", ...filler);
for (const f of flatFiles) if (f !== "ui/MainView.tsx") flatEdges.push({ from: "ui/MainView.tsx", to: f });
for (const f of filler) flatEdges.push({ from: "ui/index.ts", to: f }, { from: f, to: "ui/types.ts" });
check("fixture is over the limit", flatFiles.length > MAX_MODULE_FILES, String(flatFiles.length));

const flat = splitLargeModules(clusterByFolderDepth(flatFiles, 2), flatEdges);
const byName = new Map(flat.map((m) => [m.name, m]));
check(
  "one part per feature, the core keeps its name and folder",
  flat.length === 5 &&
    byName.get("ui")?.folder === "ui" &&
    !byName.get("ui")?.exactFiles &&
    features.every((f) => byName.get(`ui · ${f.toLowerCase()}`)?.filePaths.length === 5 && byName.get(`ui · ${f.toLowerCase()}`)?.exactFiles),
  summary(flat)
);
const core = byName.get("ui")?.filePaths ?? [];
check(
  "hubs, the barrel and shared helpers stay in the core",
  ["ui/MainView.tsx", "ui/index.ts", "ui/Spark.tsx", "ui/types.ts"].every((f) => core.includes(f)),
  JSON.stringify(core)
);
check("every file kept exactly once", flat.flatMap((m) => m.filePaths).sort().join() === [...flatFiles].sort().join());
check(
  "deterministic",
  summary(splitLargeModules(clusterByFolderDepth([...flatFiles].reverse(), 2), [...flatEdges].reverse())) === summary(flat)
);

console.log("\nleft alone");
const small = clusterByFolderDepth(flatFiles.slice(0, MAX_MODULE_FILES), 2);
check("a module at the limit is untouched", summary(splitLargeModules(small, flatEdges)) === summary(small));
const routes = Array.from({ length: 34 }, (_, i) => `app/api/thing${i}/route.ts`);
const api = clusterByFolderDepth(routes, 2);
check("a tree of one-file folders with one name stays whole", summary(splitLargeModules(api, [])) === summary(api), summary(splitLargeModules(api, [])));
const primitives = Array.from({ length: 40 }, (_, i) => `ui/${["button", "input", "dialog", "card"][i % 4]}-${i}.tsx`);
const prim = clusterByFolderDepth(primitives, 2);
check(
  "a folder whose files barely import each other is not cut by name",
  summary(splitLargeModules(prim, [{ from: primitives[0], to: primitives[4] }])) === summary(prim)
);

console.log("\nfolder cut");
const nested = [
  ...Array.from({ length: 12 }, (_, i) => `lib/engine/core${i}.ts`),
  ...Array.from({ length: 14 }, (_, i) => `lib/engine/languages/lang${i}.ts`),
  ...Array.from({ length: 6 }, (_, i) => `lib/engine/fixtures/f${i}.ts`),
  "lib/engine/tiny/one.ts",
  "lib/engine/tiny/two.ts",
];
const cut = splitLargeModules(clusterByFolderDepth(nested, 2), []);
check(
  "subfolders big enough become modules; small ones stay with the core",
  summary(cut) ===
    JSON.stringify([
      ["engine", 14, "lib/engine"],
      ["engine/fixtures", 6, "lib/engine/fixtures"],
      ["engine/languages", 14, "lib/engine/languages"],
    ]),
  summary(cut)
);

console.log("\nnames");
const clash = splitLargeModules(
  [
    ...clusterByFolderDepth(nested, 2),
    { name: "engine/languages", folder: "other/engine/languages", filePaths: ["other/engine/languages/x.ts"] },
  ],
  []
);
check(
  "an existing module keeps its name; the split part gets a suffix",
  clash.some((m) => m.name === "engine/languages" && m.folder === "other/engine/languages") &&
    clash.some((m) => m.name === "engine/languages (2)" && m.folder === "lib/engine/languages"),
  summary(clash)
);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
