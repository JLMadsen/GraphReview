/**
 * End-to-end check for the Go / Java / Rust analyzers (v2 language coverage).
 *
 *   npx tsx lib/analysis/smoke-test-langs.ts          # run assertions
 *   npx tsx lib/analysis/smoke-test-langs.ts --json   # also dump the full result
 *   npx tsx lib/analysis/smoke-test-langs.ts <dir>    # analyze a real repo instead
 *                                                     # (resolved/external stats per language)
 *
 * Materializes the Go + Java + Rust fixture into a temp directory, runs
 * `analyzeRepo` against it and asserts the *exact* resolved edge set per language
 * and the exact external-package list, plus the deliberate edge cases: commented
 * out imports, imports inside strings, empty files, syntax errors, test files,
 * `vendor/`, nested Go modules and multi-module / multi-source-set Java.
 */
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { analyzeRepo, type AnalysisResult } from "./graph-builder";
import { analyzedExtensions, analyzerForPath, listAnalyzers } from "./registry";
import type { AnalyzerContext } from "./analyzer";
import { walkRepo } from "./walk";
import { materializeSampleLangsRepo } from "./__fixtures__/sample-repo-langs";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

/** Exact set comparison with a readable diff on failure. */
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

/** `from -> to` strings for every edge whose source starts with `prefix`. */
function edgesUnder(result: AnalysisResult, prefix: string): string[] {
  return result.edges.filter((e) => e.from.startsWith(prefix)).map((e) => `${e.from} -> ${e.to}`);
}

/** Expand `E("a", "b", "c")` into `["a -> b", "a -> c"]`. */
function E(from: string, ...tos: string[]): string[] {
  return tos.map((to) => `${from} -> ${to}`);
}

async function realWorld(dir: string, dumpJson: boolean): Promise<void> {
  const started = Date.now();
  const result = await analyzeRepo(dir);
  const files = await walkRepo(path.resolve(dir));
  const ctx: AnalyzerContext = { rootDir: path.resolve(dir), files: new Set(files), cache: new Map() };
  for (const analyzer of listAnalyzers()) await analyzer.prepare?.(ctx);

  console.log(
    `${dir}\n  ${result.files.length} files, ${result.edges.length} edges, ` +
      `${result.modules.length} modules, ${result.externalPackages.length} external packages ` +
      `(${Date.now() - started} ms)`,
  );
  const perLanguage = new Map<string, { files: number; specs: number; resolved: number; external: number; internalMiss: number }>();
  for (const file of result.files) {
    const stats = perLanguage.get(file.language) ?? { files: 0, specs: 0, resolved: 0, external: 0, internalMiss: 0 };
    stats.files++;
    // One specifier can resolve to several files (Go package): count it once.
    const specs = new Map<string, boolean>();
    for (const imp of file.imports) specs.set(imp.raw, (specs.get(imp.raw) ?? false) || Boolean(imp.resolvedPath));
    for (const [raw, resolved] of specs) {
      stats.specs++;
      if (resolved) stats.resolved++;
      else if (analyzerForPath(file.file)?.externalPackageName(raw, ctx)) stats.external++;
      else stats.internalMiss++;
    }
    perLanguage.set(file.language, stats);
  }
  for (const [language, s] of [...perLanguage].sort()) {
    console.log(
      `  ${language.padEnd(11)} files=${s.files} import-specifiers=${s.specs} ` +
        `resolved=${s.resolved} external=${s.external} unresolved-internal=${s.internalMiss}`,
    );
  }
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

  const fixtureDir = path.join(os.tmpdir(), `graphreview-analysis-langs-fixture-${process.pid}`);
  await materializeSampleLangsRepo(fixtureDir);
  console.log(`fixture: ${fixtureDir}\n`);

  try {
    const result = await analyzeRepo(fixtureDir);

    console.log("files:");
    for (const file of result.files) {
      const resolved = file.imports.filter((i) => i.resolvedPath).length;
      console.log(
        `  ${file.file.padEnd(72)} ${file.language.padEnd(5)} loc=${String(file.loc).padStart(3)} ` +
          `imports=${file.imports.length} (resolved ${resolved})`,
      );
    }
    console.log("\nedges:");
    for (const edge of result.edges) console.log(`  ${edge.from}  --${edge.kind}-->  ${edge.to}`);
    console.log(`\nexternalPackages: ${result.externalPackages.join(", ")}`);

    console.log("\nassertions:");
    const byFile = new Map(result.files.map((f) => [f.file, f]));
    const importsOf = (file: string): string[] => (byFile.get(file)?.imports ?? []).map((i) => i.raw);

    // --- registry / walker ---
    check(
      "registry claims .go/.java/.rs",
      [".go", ".java", ".rs"].every((ext) => analyzedExtensions().includes(ext)),
    );
    check("vendor/ is skipped by the walker", !result.files.some((f) => f.file.includes("/vendor/")));
    const goFiles = result.files.filter((f) => f.file.startsWith("gosvc/"));
    const javaFiles = result.files.filter((f) => f.file.startsWith("javaapp/"));
    const rustFiles = result.files.filter((f) => f.file.startsWith("rustcrate/"));
    check("11 Go / 14 Java / 17 Rust files analyzed", goFiles.length === 11 && javaFiles.length === 14 && rustFiles.length === 17, `${goFiles.length}/${javaFiles.length}/${rustFiles.length}`);
    check(
      "languages tagged per extension",
      goFiles.every((f) => f.language === "go") &&
        javaFiles.every((f) => f.language === "java") &&
        rustFiles.every((f) => f.language === "rust"),
    );

    // --- Go: exact edges (a package fans out to every non-test .go file in its directory) ---
    const UTIL = ["gosvc/pkg/util/strings.go", "gosvc/pkg/util/util.go"];
    const STORE = ["gosvc/internal/store/store.go", "gosvc/internal/store/store_memory.go"];
    checkSet("go: exact edge set", edgesUnder(result, "gosvc/"), [
      ...E("gosvc/main.go", ...STORE, ...UTIL, "gosvc/tools/gen/gen.go"),
      ...E("gosvc/cmd/tool/main.go", ...STORE, "gosvc/tools/gen/internal/emit/emit.go"),
      ...E("gosvc/internal/store/store.go", ...UTIL),
      ...E("gosvc/internal/store/store_test.go", ...UTIL),
      ...E("gosvc/tools/gen/gen.go", ...UTIL),
    ]);
    check(
      "go: package import resolves to the package DIRECTORY (grouped + aliased import)",
      result.edges.some((e) => e.from === "gosvc/main.go" && e.to === "gosvc/internal/store/store_memory.go"),
    );
    check("go: _test.go files are never link targets", !result.edges.some((e) => e.to.endsWith("_test.go")));
    check(
      "go: _test.go files are still analysed as importers",
      result.edges.some((e) => e.from === "gosvc/internal/store/store_test.go") &&
        importsOf("gosvc/internal/store/store_test.go").includes("testing"),
    );
    check(
      "go: nested go.mod with an unrelated module path (raw-string import)",
      result.edges.some((e) => e.from === "gosvc/main.go" && e.to === "gosvc/tools/gen/gen.go") &&
        result.edges.some((e) => e.from === "gosvc/cmd/tool/main.go" && e.to === "gosvc/tools/gen/internal/emit/emit.go"),
    );
    check(
      "go: nested module importing its parent module resolves",
      result.edges.some((e) => e.from === "gosvc/tools/gen/gen.go" && e.to === "gosvc/pkg/util/util.go"),
    );
    check(
      "go: alias / dot / blank imports are captured",
      ["strings", "github.com/lib/pq", "example.com/svc/internal/store"].every((s) => importsOf("gosvc/main.go").includes(s)),
    );
    check(
      "go: commented-out and in-string imports are ignored",
      !importsOf("gosvc/main.go").some((s) => s.includes("secret")),
    );
    check(
      "go: in-module import of a missing package is dropped, not external",
      importsOf("gosvc/main.go").includes("example.com/svc/missing/pkg") &&
        !result.externalPackages.some((p) => p.startsWith("example.")),
    );
    check("go: cgo `import \"C\"` is not external", !result.externalPackages.includes("C"));

    // --- Java: exact edges ---
    const JM = "javaapp/core/src/main/java/com/acme";
    const JT = "javaapp/core/src/test/java/com/acme";
    const JC = "javaapp/client/src/main/java/com/acme/client";
    checkSet("java: exact edge set", edgesUnder(result, "javaapp/"), [
      ...E(
        `${JM}/app/Main.java`,
        `${JM}/model/User.java`,
        `${JM}/model/Outer.java`, // nested type import -> enclosing class file
        `${JM}/util/Strings.java`, // wildcard + static member
        `${JM}/util/Numbers.java`, // wildcard + static wildcard
        `${JM}/cfg/Settings.java`, // own source set wins over the test copy
      ),
      ...E(`${JM}/util/Strings.java`, `${JM}/model/User.java`),
      ...E(
        `${JT}/app/MainTest.java`,
        `${JM}/app/Main.java`,
        `${JT}/cfg/Settings.java`, // test source set wins here
        `${JM}/model/User.java`, // wildcard, only the main source set has the package
        `${JM}/model/Outer.java`,
      ),
      ...E(
        `${JC}/Client.java`,
        `${JC}/internal/Http.java`,
        `${JM}/model/User.java`, // across Maven modules
        `${JM}/util/Strings.java`,
      ),
    ]);
    check(
      "java: wildcard import skips package-info.java",
      !result.edges.some((e) => e.to.endsWith("package-info.java")),
    );
    check(
      "java: static import resolves to the class file",
      importsOf(`${JM}/app/Main.java`).includes("com.acme.util.Strings.capitalize") &&
        result.edges.some((e) => e.from === `${JM}/app/Main.java` && e.to === `${JM}/util/Strings.java`),
    );
    check(
      "java: commented-out and in-string imports are ignored",
      !importsOf(`${JM}/app/Main.java`).some((s) => s.includes("secret") || s.includes("InString")),
    );

    // --- Rust: exact edges ---
    const RS = "rustcrate/src";
    const HL = "rustcrate/crates/helper/src";
    checkSet("rust: exact edge set", edgesUnder(result, "rustcrate/"), [
      ...E(`${RS}/lib.rs`, `${RS}/config.rs`, `${RS}/net/mod.rs`, `${RS}/util.rs`, `${RS}/legacy/old_impl.rs`, `${RS}/net/client.rs`, `${RS}/net/server.rs`, `${HL}/lib.rs`),
      ...E(`${RS}/main.rs`, `${RS}/cli.rs`, `${RS}/config.rs`, `${HL}/lib.rs`),
      ...E(`${RS}/cli.rs`, `${RS}/main.rs`), // `super::Mode`: cli is a bin-only module
      ...E(`${RS}/config.rs`, `${RS}/util.rs`, `${RS}/net/client.rs`, `${RS}/config/tests.rs`),
      ...E(`${RS}/config/tests.rs`, `${RS}/config.rs`, `${RS}/util.rs`),
      ...E(`${RS}/util.rs`, `${RS}/util/inner.rs`, `${RS}/config.rs`),
      ...E(`${RS}/util/inner.rs`, `${RS}/util.rs`, `${RS}/config.rs`, `${RS}/net/server.rs`),
      ...E(`${RS}/net/mod.rs`, `${RS}/net/client.rs`, `${RS}/net/server.rs`, `${RS}/config.rs`),
      ...E(`${RS}/net/client.rs`, `${RS}/net/server.rs`),
      ...E(`${RS}/net/server.rs`, `${RS}/lib.rs`), // `crate::Result` names an item of the root
      ...E(`${RS}/legacy/old_impl.rs`, `${RS}/config.rs`),
      ...E("rustcrate/tests/integration.rs", "rustcrate/tests/common/mod.rs", `${RS}/net/client.rs`),
      ...E("rustcrate/tests/common/mod.rs", `${RS}/config.rs`),
      ...E(`${HL}/lib.rs`, `${HL}/deep.rs`),
      ...E(`${HL}/deep.rs`, `${HL}/lib.rs`),
    ]);
    const lib = importsOf(`${RS}/lib.rs`);
    check(
      "rust: #[path] mod (with an intervening #[cfg]) resolves to the named file",
      byFile.get(`${RS}/lib.rs`)?.imports.some(
        (i) => i.raw === '#[path = "legacy/old_impl.rs"] mod legacy' && i.resolvedPath === `${RS}/legacy/old_impl.rs`,
      ) === true,
    );
    check(
      "rust: `mod x;` -> x.rs, x/mod.rs; missing module stays unresolved; inline mod is not an import",
      byFile.get(`${RS}/lib.rs`)?.imports.some((i) => i.raw === "mod net" && i.resolvedPath === `${RS}/net/mod.rs`) === true &&
        lib.includes("mod missing") &&
        !byFile.get(`${RS}/lib.rs`)?.imports.some((i) => i.raw === "mod missing" && i.resolvedPath) &&
        !lib.some((s) => s.includes("inline_only")),
    );
    check(
      "rust: brace use-trees are flattened (pub use net::{client::Client, server})",
      lib.includes("net::client::Client") && lib.includes("net::server"),
    );
    check(
      "rust: nested brace tree with self (std::{fs, io::{self, Read}})",
      ["std::fs", "std::io", "std::io::Read"].every((s) => importsOf(`${RS}/config.rs`).includes(s)),
    );
    check(
      "rust: `use super::*` in an inline test module is dropped",
      !importsOf(`${RS}/config.rs`).some((s) => s === "super::*" || s === "self::*"),
    );
    check(
      "rust: commented-out mod and in-string use are ignored",
      !lib.some((s) => s.includes("ghost") || s.includes("fake") || s.includes("not_a_module")),
    );
    check(
      "rust: 2018 uniform path (`use cli::Args`) and item-of-root (`crate::Result`)",
      result.edges.some((e) => e.from === `${RS}/main.rs` && e.to === `${RS}/cli.rs`) &&
        result.edges.some((e) => e.from === `${RS}/net/server.rs` && e.to === `${RS}/lib.rs`),
    );
    check(
      "rust: bin crate reaches its own lib by crate name (`use my_app::...`)",
      result.edges.some((e) => e.from === `${RS}/main.rs` && e.to === `${RS}/config.rs`),
    );
    check(
      "rust: workspace crate resolves (`use helper_lib::h`, `extern crate helper_lib`)",
      result.edges.some((e) => e.from === `${RS}/main.rs` && e.to === `${HL}/lib.rs`) &&
        result.edges.some((e) => e.from === `${RS}/lib.rs` && e.to === `${HL}/lib.rs`),
    );

    // --- shared edge cases ---
    for (const broken of ["gosvc/internal/broken/broken.go", `${JM}/Broken.java`, `${RS}/broken.rs`]) {
      const file = byFile.get(broken);
      check(`syntax error: ${broken.split("/").pop()} is a node with no imports`, file !== undefined && file.imports.length === 0);
    }
    for (const empty of ["gosvc/internal/empty/empty.go", `${JM}/Empty.java`, `${RS}/empty.rs`]) {
      const file = byFile.get(empty);
      check(`empty file: ${empty.split("/").pop()} is a node (loc 0, no imports)`, file !== undefined && file.loc === 0 && file.imports.length === 0);
    }
    check("no self-edges", !result.edges.some((e) => e.from === e.to));

    // --- external packages: exact ---
    checkSet("externalPackages: exact list", result.externalPackages, [
      // Go: stdlib capped at two segments, third-party = module root
      "encoding/json", "fmt", "net/http", "os", "strings", "testing",
      "github.com/gin-gonic/gin", "github.com/lib/pq", "github.com/spf13/cobra",
      "go.uber.org/zap", "golang.org/x/sync", "gopkg.in/yaml.v3",
      // Java: package part only, 3 segments for reverse-domain roots, else 2
      "com.acme.gen", "com.google.common", "java.util", "javax.inject", "lombok",
      "org.junit", "org.springframework.boot", "org.springframework.web",
      // Rust: crate names of declared dependencies, plus std
      "anyhow", "clap", "pretty_assertions", "rand", "reqwest", "serde", "serde_json", "std", "tokio",
    ]);
    check(
      "rust: enum variants / workspace + own crates are never external",
      !["Mode", "helper_lib", "my_app", "crate", "self", "super"].some((p) => result.externalPackages.includes(p)),
    );

    // --- clustering still works on the new languages ---
    check(
      "folder clustering covers the new files",
      result.modules.reduce((n, m) => n + m.filePaths.length, 0) === result.files.length,
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
