/**
 * End-to-end check for the Louvain community-detection clustering.
 *
 *   npx tsx lib/analysis/louvain-smoke-test.ts
 *
 * Unlike `smoke-test.ts` (which exercises `analyzeRepo` against files on
 * disk), `clusterByCommunity` takes already-parsed `FileAnalysis[]` /
 * `ImportEdge[]` in memory, so this fixture is just plain data — no
 * materializing to a temp directory needed.
 *
 * The synthetic graph has four densely-interconnected-within,
 * disconnected-between-each-other groups of files (so Louvain has an
 * unambiguous, deterministic answer: merging any two of them across a zero
 * -edge cut can only ever lower modularity) plus two files with no edges at
 * all. Two of the four connected groups deliberately share the same
 * top-level folder ("src/auth" and "src/legacy") to exercise the
 * name-collision fallback, and the two edgeless files exercise the
 * "unconnected" fallback.
 */
import type { ImportEdge, ModuleCluster } from "./graph-builder";
import type { FileAnalysis } from "./ir";
import { clusterByCommunity, UNCONNECTED_CLUSTER_NAME } from "./louvain-cluster";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function file(path: string): FileAnalysis {
  return { file: path, language: "typescript", imports: [], loc: 10 };
}

function edge(from: string, to: string): ImportEdge {
  return { from, to, kind: "import" };
}

// Group A: src/auth/* — a triangle of mutual imports. 3 files.
const groupA = ["src/auth/login.ts", "src/auth/session.ts", "src/auth/token.ts"];
// Group B: services/payments/* — a triangle of mutual imports. 3 files.
const groupB = ["services/payments/charge.ts", "services/payments/invoice.ts", "services/payments/refund.ts"];
// Group D: src/legacy/* — a single edge. 2 files. Shares top-level folder
// "src" with group A, on purpose, to exercise the naming-collision fallback.
const groupD = ["src/legacy/old-handler.ts", "src/legacy/old-utils.ts"];
// Group C: tools/reports/* — a single edge. 2 files.
const groupC = ["tools/reports/export.ts", "tools/reports/generate.ts"];
// Isolated: no import edges at all, either direction.
const isolated = ["docs/readme-notes.ts", "config/flag.ts"];

const files: FileAnalysis[] = [...groupA, ...groupB, ...groupD, ...groupC, ...isolated].map(file);

const edges: ImportEdge[] = [
  edge(groupA[0], groupA[1]),
  edge(groupA[0], groupA[2]),
  edge(groupA[1], groupA[2]),

  edge(groupB[0], groupB[1]),
  edge(groupB[0], groupB[2]),
  edge(groupB[1], groupB[2]),

  edge(groupD[0], groupD[1]),

  edge(groupC[0], groupC[1]),
];

function findModuleContaining(modules: ModuleCluster[], sampleFile: string): ModuleCluster | undefined {
  return modules.find((m) => m.filePaths.includes(sampleFile));
}

function sameFileSet(cluster: ModuleCluster | undefined, expected: string[]): boolean {
  if (!cluster) return false;
  const a = cluster.filePaths.slice().sort();
  const b = expected.slice().sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function main(): void {
  const result = clusterByCommunity(files, edges);

  console.log("clusters:");
  for (const cluster of result) {
    console.log(`  ${cluster.name}: ${cluster.filePaths.join(", ")}`);
  }
  console.log();

  console.log("assertions:");
  check("produces 5 clusters (4 communities + 1 unconnected group)", result.length === 5, `got ${result.length}`);

  const clusterA = findModuleContaining(result, groupA[0]);
  const clusterB = findModuleContaining(result, groupB[0]);
  const clusterD = findModuleContaining(result, groupD[0]);
  const clusterC = findModuleContaining(result, groupC[0]);
  const clusterUnconnected = findModuleContaining(result, isolated[0]);

  check("group A (src/auth triangle) forms its own community", sameFileSet(clusterA, groupA));
  check("group B (services/payments triangle) forms its own community", sameFileSet(clusterB, groupB));
  check("group D (src/legacy pair) forms its own community", sameFileSet(clusterD, groupD));
  check("group C (tools/reports pair) forms its own community", sameFileSet(clusterC, groupC));
  check(
    "the four connected communities are pairwise distinct",
    new Set([clusterA, clusterB, clusterD, clusterC]).size === 4,
  );

  check('group A is named after its top-level folder ("src")', clusterA?.name === "src", clusterA?.name);
  check(
    'group B is named after its top-level folder ("services")',
    clusterB?.name === "services",
    clusterB?.name,
  );
  check(
    'group D collides with A on "src" and falls back to "cluster-N"',
    clusterD?.name?.startsWith("cluster-") === true,
    clusterD?.name,
  );
  check('group C is named after its top-level folder ("tools")', clusterC?.name === "tools", clusterC?.name);
  check("group D's fallback name isn't reused by any other cluster", clusterD?.name !== clusterA?.name);

  check(
    `isolated files land in a single "${UNCONNECTED_CLUSTER_NAME}" cluster`,
    clusterUnconnected?.name === UNCONNECTED_CLUSTER_NAME && sameFileSet(clusterUnconnected, isolated),
  );

  const allClusteredPaths = result.flatMap((m) => m.filePaths).slice().sort();
  const allInputPaths = files.map((f) => f.file).slice().sort();
  check(
    "every input file appears in exactly one output cluster",
    JSON.stringify(allClusteredPaths) === JSON.stringify(allInputPaths),
  );

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
