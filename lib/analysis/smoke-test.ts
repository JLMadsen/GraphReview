/**
 * End-to-end check for the static analysis engine.
 *
 *   npx tsx lib/analysis/smoke-test.ts          # run assertions
 *   npx tsx lib/analysis/smoke-test.ts --json   # also dump the full result
 *   npx tsx lib/analysis/smoke-test.ts <dir>    # analyze a real repo instead
 *
 * Materializes the polyglot fixture into a temp directory, runs `analyzeRepo`
 * against it and asserts the interesting resolution cases (relative imports,
 * tsconfig path aliases, `.js` → `.ts` specifiers, CommonJS require, dynamic
 * import, Python relative/absolute imports, importlib) plus the folder
 * clustering and external-package grouping.
 */
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { analyzeRepo, type AnalysisResult } from "./graph-builder";
import { materializeSampleRepo } from "./__fixtures__/sample-repo";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function hasEdge(result: AnalysisResult, from: string, to: string, kind: string): boolean {
  return result.edges.some((e) => e.from === from && e.to === to && e.kind === kind);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dumpJson = args.includes("--json");
  const explicitDir = args.find((a) => !a.startsWith("--"));

  if (explicitDir) {
    const result = await analyzeRepo(explicitDir);
    console.log(
      `${result.files.length} files, ${result.edges.length} edges, ` +
        `${result.modules.length} modules, ${result.externalPackages.length} external packages`,
    );
    console.log(result.modules.map((m) => `  ${m.name} (${m.filePaths.length})`).join("\n"));
    if (dumpJson) console.log(JSON.stringify(result, null, 2));
    return;
  }

  const fixtureDir = path.join(os.tmpdir(), `graphreview-analysis-fixture-${process.pid}`);
  await materializeSampleRepo(fixtureDir);
  console.log(`fixture: ${fixtureDir}\n`);

  try {
    const result = await analyzeRepo(fixtureDir);

    console.log("files:");
    for (const file of result.files) {
      const resolved = file.imports.filter((i) => i.resolvedPath).length;
      console.log(
        `  ${file.file.padEnd(32)} ${file.language.padEnd(11)} loc=${String(file.loc).padStart(3)} ` +
          `imports=${file.imports.length} (resolved ${resolved})`,
      );
    }

    console.log("\nedges:");
    for (const edge of result.edges) {
      console.log(`  ${edge.from}  --${edge.kind}-->  ${edge.to}`);
    }

    console.log("\nmodules:");
    for (const cluster of result.modules) {
      console.log(`  ${cluster.name}: ${cluster.filePaths.join(", ")}`);
    }

    console.log(`\nexternalPackages: ${result.externalPackages.join(", ")}`);

    console.log("\nassertions:");
    const fileNames = result.files.map((f) => f.file);
    check("walker skips node_modules/dist/.git", !fileNames.some((f) =>
      f.startsWith("node_modules/") || f.startsWith("dist/") || f.startsWith(".git/")));
    check("16 source files analyzed", result.files.length === 16, `got ${result.files.length}`);
    check(
      "languages tagged per extension",
      result.files.find((f) => f.file === "src/ui/Button.tsx")?.language === "tsx" &&
        result.files.find((f) => f.file === "scripts/build.js")?.language === "javascript" &&
        result.files.find((f) => f.file === "src/db/schema.ts")?.language === "typescript" &&
        result.files.find((f) => f.file === "services/api/app.py")?.language === "python",
    );

    // --- JS/TS resolution ---
    check("relative import", hasEdge(result, "src/auth/index.ts", "src/auth/token.ts", "import"));
    check("parent-relative import", hasEdge(result, "src/auth/index.ts", "src/db/client.ts", "import"));
    check("tsconfig path alias @/*", hasEdge(result, "src/auth/index.ts", "src/shared/log.ts", "import"));
    check("dynamic import() is kind=call", hasEdge(result, "src/auth/index.ts", "src/auth/session.ts", "call"));
    check("re-export edge", hasEdge(result, "src/auth/token.ts", "src/auth/session.ts", "import"));
    check("nested folder import", hasEdge(result, "src/auth/token.ts", "src/auth/helpers/hash.ts", "import"));
    check(".js specifier resolves to .ts", hasEdge(result, "src/shared/log.ts", "src/shared/constants.ts", "import"));
    check("CommonJS require edge", hasEdge(result, "scripts/build.js", "src/db/schema.ts", "require"));
    check("tsx alias import", hasEdge(result, "src/ui/Button.tsx", "src/shared/log.ts", "import"));

    const button = result.files.find((f) => f.file === "src/ui/Button.tsx");
    check(
      "non-source asset resolves in IR but yields no edge",
      button?.imports.some((i) => i.resolvedPath === "src/ui/button.module.css") === true &&
        !result.edges.some((e) => e.to === "src/ui/button.module.css"),
    );

    // --- Python resolution ---
    check("python relative module", hasEdge(result, "services/api/app.py", "services/api/routes.py", "import"));
    check("bare `from . import` hits __init__", hasEdge(result, "services/api/app.py", "services/api/__init__.py", "import"));
    check("`from . import models` submodule", hasEdge(result, "services/api/app.py", "services/api/models.py", "import"));
    check("two-dot relative import", hasEdge(result, "services/api/app.py", "services/shared/util.py", "import"));
    check("importlib.import_module is kind=call", hasEdge(result, "services/api/app.py", "services/api/routes.py", "call"));
    check("python sibling import", hasEdge(result, "services/api/routes.py", "services/api/models.py", "import"));
    check(
      "speculative submodule guesses dropped when unresolved",
      !result.files
        .find((f) => f.file === "services/api/app.py")
        ?.imports.some((i) => i.raw === ".routes.router"),
    );

    // --- external packages ---
    const externals = new Set(result.externalPackages);
    for (const pkg of ["zod", "pg", "react", "node:crypto", "node:fs", "fastapi", "os", "json", "dataclasses", "importlib"]) {
      check(`external package: ${pkg}`, externals.has(pkg));
    }
    check(
      "path aliases are not treated as external packages",
      !result.externalPackages.some((p) => p.startsWith("@/")),
    );
    check(
      "relative specifiers never become external packages",
      !result.externalPackages.some((p) => p.startsWith(".")),
    );

    // --- clustering (module tier) ---
    const moduleNames = result.modules.map((m) => m.name);
    check(
      "folder clustering at depth 2",
      JSON.stringify(moduleNames) ===
        JSON.stringify(["api", "auth", "db", "scripts", "services/shared", "src/shared", "ui"]),
      moduleNames.join(", "),
    );
    check(
      "nested files roll up into their depth-2 module",
      result.modules.find((m) => m.name === "auth")?.filePaths.includes("src/auth/helpers/hash.ts") === true,
    );

    const depth1 = await analyzeRepo(fixtureDir, { moduleDepth: 1 });
    check(
      "moduleDepth is configurable",
      JSON.stringify(depth1.modules.map((m) => m.name)) ===
        JSON.stringify(["scripts", "services", "src"]),
      depth1.modules.map((m) => m.name).join(", "),
    );

    if (dumpJson) console.log(`\n${JSON.stringify(result, null, 2)}`);

    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }

  if (failures > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
