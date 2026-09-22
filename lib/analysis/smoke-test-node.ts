/**
 * End-to-end check for the hardened JS/Node/Next.js resolver (DESIGN.md §5):
 * `tsconfig.json`/`jsconfig.json` `extends` chains merged with the nearest
 * config picked per importing file, npm/pnpm workspace packages resolved via
 * `exports`/`main`/conventional subpaths, and `package.json` `"imports"`.
 *
 *   npx tsx lib/analysis/smoke-test-node.ts          # run assertions
 *   npx tsx lib/analysis/smoke-test-node.ts --json   # also dump the full result
 *   npx tsx lib/analysis/smoke-test-node.ts <dir>    # analyze a real repo instead
 *
 * Materializes a small pnpm-style TypeScript monorepo into a temp directory,
 * runs `analyzeRepo` against it and asserts the *exact* resolved edge set plus
 * the deliberate cases: a `tsconfig` `extends` chain whose `paths` resolve
 * relative to the config that declares them (or its inherited `baseUrl`) rather
 * than to the importing file or the repo root, nearest-config selection (a
 * package's own, non-extending tsconfig shadows the root one), a workspace
 * package resolved through `exports` (root and named subpath), one resolved
 * through `main` with a conventional (no-`exports`) subpath fallback, repo-root
 * and per-package `package.json` `"imports"` (`#foo/*`), and a barrel re-export.
 */
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { analyzeRepo, type AnalysisResult } from "./graph-builder";
import { materializeSampleNodeRepo } from "./__fixtures__/sample-repo-node";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function checkSet(label: string, actual: string[], expected: string[]): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  const missing = e.filter((x) => !a.includes(x));
  const extra = a.filter((x) => !e.includes(x));
  check(
    label,
    a.length === e.length && missing.length === 0 && extra.length === 0,
    `missing: [${missing.join(", ")}] unexpected: [${extra.join(", ")}]`,
  );
}

function edgeStrings(result: AnalysisResult): string[] {
  return result.edges.map((e) => `${e.from} -> ${e.to}`);
}

function E(from: string, ...tos: string[]): string[] {
  return tos.map((to) => `${from} -> ${to}`);
}

function hasImport(
  result: AnalysisResult,
  file: string,
  raw: string,
  resolvedPath: string,
): boolean {
  return (
    result.files
      .find((f) => f.file === file)
      ?.imports.some((i) => i.raw === raw && i.resolvedPath === resolvedPath) === true
  );
}

async function realWorld(dir: string, dumpJson: boolean): Promise<void> {
  const started = Date.now();
  const result = await analyzeRepo(dir);
  console.log(
    `${dir}\n  ${result.files.length} files, ${result.edges.length} edges, ` +
      `${result.externalPackages.length} external packages (${Date.now() - started} ms)`,
  );
  console.log(`  externals: ${result.externalPackages.slice(0, 25).join(", ")}${result.externalPackages.length > 25 ? ", ..." : ""}`);
  if (dumpJson) console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dumpJson = args.includes("--json");
  const explicitDir = args.find((a) => !a.startsWith("--"));
  if (explicitDir) {
    await realWorld(explicitDir, dumpJson);
    return;
  }

  const fixtureDir = path.join(os.tmpdir(), `graphreview-analysis-node-fixture-${process.pid}`);
  await materializeSampleNodeRepo(fixtureDir);
  console.log(`fixture: ${fixtureDir}\n`);

  try {
    const result = await analyzeRepo(fixtureDir);
    const byFile = new Map(result.files.map((f) => [f.file, f]));

    console.log("files:");
    for (const file of result.files) {
      console.log(`  ${file.file.padEnd(38)} loc=${String(file.loc).padStart(2)} imports=${file.imports.length}`);
    }
    console.log("\nedges:");
    for (const edge of result.edges) console.log(`  ${edge.from}  -->  ${edge.to}`);
    console.log(`\nexternals: ${result.externalPackages.join(", ")}\n`);

    check(
      "every fixture source file is a node",
      [
        "config/dev.ts",
        "tools/build.ts",
        "packages/shared/src/index.ts",
        "packages/shared/src/thing.ts",
        "packages/shared/src/alt.ts",
        "packages/utils/src/index.ts",
        "packages/utils/src/helpers.ts",
        "packages/app/src/index.ts",
        "packages/app/src/config.ts",
        "packages/app/src/localthing.ts",
      ].every((f) => byFile.has(f)),
    );

    checkSet("monorepo: exact edge set", edgeStrings(result), [
      // tools/build.ts: root package's `#env/*` import, `@root/*` (its own
      // config's alias, baseDir = its own/repo dir), and a workspace package
      // resolved through `main` with no explicit subpath.
      ...E("tools/build.ts", "config/dev.ts", "packages/utils/src/index.ts", "packages/shared/src/index.ts"),
      // packages/shared: a barrel re-export, and its own standalone
      // (non-extending) tsconfig's alias resolved relative to its own dir.
      ...E("packages/shared/src/index.ts", "packages/shared/src/thing.ts"),
      ...E("packages/shared/src/thing.ts", "packages/shared/src/alt.ts"),
      // packages/app: a workspace package via `exports` (subpath and root), its
      // own `#config` package-import, the *inherited* `@shared/*` alias
      // (resolved against the root, where it was declared, even though this
      // config's own `baseUrl` points at the package itself), the workspace
      // conventional-subpath fallback (no `exports` entry for it), and its own
      // `@app/*` alias (resolved against its own `baseUrl`).
      ...E(
        "packages/app/src/index.ts",
        "packages/utils/src/helpers.ts",
        "packages/utils/src/index.ts",
        "packages/app/src/config.ts",
        "packages/shared/src/thing.ts",
        "packages/app/src/localthing.ts",
      ),
    ]);

    check(
      "tsconfig extends: a child's own `paths` resolve against its own `baseUrl`, not the repo root",
      hasImport(result, "packages/app/src/index.ts", "@app/localthing", "packages/app/src/localthing.ts"),
    );
    check(
      "tsconfig extends: an *inherited* alias still resolves against where it was declared (the root), even once the child overrides `baseUrl` for its own paths",
      hasImport(result, "packages/app/src/index.ts", "@shared/thing", "packages/shared/src/thing.ts"),
    );
    check(
      "nearest config wins: packages/shared has its own standalone tsconfig (no baseUrl -> paths resolve relative to its own dir), shadowing the root config",
      hasImport(result, "packages/shared/src/thing.ts", "@shared-alt/alt", "packages/shared/src/alt.ts"),
    );
    check(
      "workspace package via `exports`: root entry (\".\") and a named subpath (\"./helpers\") both resolve, as an internal edge not an external package",
      hasImport(result, "packages/app/src/index.ts", "@acme/utils", "packages/utils/src/index.ts") &&
        hasImport(result, "packages/app/src/index.ts", "@acme/utils/helpers", "packages/utils/src/helpers.ts"),
    );
    check(
      "workspace package via `main` (no `exports`): bare import resolves, and a subpath falls back to a conventional path under the package",
      hasImport(result, "tools/build.ts", "@acme/shared", "packages/shared/src/index.ts") &&
        hasImport(result, "packages/app/src/index.ts", "@acme/shared/src/thing", "packages/shared/src/thing.ts"),
    );
    check(
      "package.json \"imports\": a repo-root `#foo/*` and a per-package `#bar` both resolve, each relative to the package.json that declares them",
      hasImport(result, "tools/build.ts", "#env/dev", "config/dev.ts") &&
        hasImport(result, "packages/app/src/index.ts", "#config", "packages/app/src/config.ts"),
    );
    check(
      "pnpm-workspace.yaml `packages/*` is honoured with no npm/yarn \"workspaces\" field present",
      hasImport(result, "tools/build.ts", "@root/packages/utils/src/index", "packages/utils/src/index.ts"),
    );
    check("no external packages: every specifier in this fixture is internal", result.externalPackages.length === 0);
    check(
      "no edge points at a source file that does not exist",
      result.edges.every((e) => byFile.has(e.to)),
    );

    if (dumpJson) console.log(JSON.stringify(result, null, 2));
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
