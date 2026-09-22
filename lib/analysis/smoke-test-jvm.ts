/**
 * End-to-end check for the shared JVM (Java + Kotlin) analyzer/resolver,
 * and the JVM coupling fixes: `declares`-based resolution,
 * same-package / wildcard type-reference candidates, a lexical Kotlin analyzer.
 *
 *   npx tsx lib/analysis/smoke-test-jvm.ts          # run assertions
 *   npx tsx lib/analysis/smoke-test-jvm.ts --json   # also dump the full result
 *   npx tsx lib/analysis/smoke-test-jvm.ts <dir>    # analyze a real repo instead
 *
 * Materializes the Gradle multi-module Java + Kotlin fixture into a temp
 * directory, runs `analyzeRepo` against it and asserts the *exact* resolved edge
 * set plus the deliberate edge cases: Java -> Kotlin and Kotlin -> Java imports,
 * same-package references with no import (both directions), Java and Kotlin
 * wildcard imports, a Kotlin `import x as y` alias, a Kotlin top-level function
 * imported from Java via its synthesized `<File>Kt` class, cross-module
 * resolution, `.kts` scripts, comments/strings containing fake imports, an empty
 * file, and syntax-error files in both languages.
 */
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { analyzeRepo, type AnalysisResult } from "./graph-builder";
import { materializeSampleJvmRepo } from "./__fixtures__/sample-repo-jvm";

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

/** Expand `E("a", "b", "c")` into `["a -> b", "a -> c"]`. */
function E(from: string, ...tos: string[]): string[] {
  return tos.map((to) => `${from} -> ${to}`);
}

async function realWorld(dir: string, dumpJson: boolean): Promise<void> {
  const started = Date.now();
  const result = await analyzeRepo(dir);
  console.log(
    `${dir}\n  ${result.files.length} files, ${result.edges.length} edges, ` +
      `${result.externalPackages.length} external packages (${Date.now() - started} ms)`,
  );
  const perLanguage = new Map<string, { files: number; specs: number; resolved: number }>();
  for (const file of result.files) {
    if (file.language !== "java" && file.language !== "kotlin") continue;
    const stats = perLanguage.get(file.language) ?? { files: 0, specs: 0, resolved: 0 };
    stats.files++;
    const specs = new Map<string, boolean>();
    for (const imp of file.imports) specs.set(imp.raw, (specs.get(imp.raw) ?? false) || Boolean(imp.resolvedPath));
    for (const [, resolved] of specs) {
      stats.specs++;
      if (resolved) stats.resolved++;
    }
    perLanguage.set(file.language, stats);
  }
  for (const [language, s] of [...perLanguage].sort()) {
    console.log(`  ${language.padEnd(7)} files=${s.files} import-specifiers=${s.specs} resolved=${s.resolved}`);
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

  const fixtureDir = path.join(os.tmpdir(), `graphreview-analysis-jvm-fixture-${process.pid}`);
  await materializeSampleJvmRepo(fixtureDir);
  console.log(`fixture: ${fixtureDir}\n`);

  try {
    const result = await analyzeRepo(fixtureDir);
    const byFile = new Map(result.files.map((f) => [f.file, f]));

    console.log("files:");
    for (const file of result.files) {
      console.log(
        `  ${file.file.padEnd(60)} ${file.language.padEnd(6)} loc=${String(file.loc).padStart(3)} ` +
          `declares=${JSON.stringify(file.declares ?? [])}`,
      );
    }
    console.log("\nedges:");
    for (const edge of result.edges) console.log(`  ${edge.from}  -->  ${edge.to}`);
    console.log(`\nexternals: ${result.externalPackages.join(", ")}\n`);

    const JM = "jvmapp/core/src/main/java/com/acme";
    const KM = "jvmapp/core/src/main/kotlin/com/acme";
    const JT = "jvmapp/core/src/test/java/com/acme";
    const CL = "jvmapp/client/src/main/kotlin/com/acme/client";

    check(
      "every fixture source file is a node (including empty and syntax-error files)",
      [
        `${JM}/model/User.java`,
        `${JM}/model/Outer.java`,
        `${JM}/app/JavaCaller.java`,
        `${JM}/app/WildcardUser.java`,
        `${JM}/broken/Broken.java`,
        `${KM}/util/Strings.kt`,
        `${KM}/util/Numbers.kt`,
        `${KM}/util/Empty.kt`,
        `${KM}/app/Shapes.kt`,
        `${KM}/app/App.kt`,
        `${KM}/broken/Broken.kt`,
        `${JT}/app/JavaCallerTest.java`,
        `${CL}/Client.kt`,
        "jvmapp/settings.gradle.kts",
        "jvmapp/build.gradle.kts",
        "jvmapp/core/build.gradle.kts",
        "jvmapp/client/build.gradle.kts",
      ].every((f) => byFile.has(f)),
    );

    check("kotlin: .kt and .kts both get language id \"kotlin\"", byFile.get(`${KM}/app/App.kt`)?.language === "kotlin" && byFile.get("jvmapp/build.gradle.kts")?.language === "kotlin");

    checkSet("java: declares package + top-level types only", byFile.get(`${JM}/model/User.java`)?.declares ?? [], ["com.acme.model.User"]);
    checkSet(
      "kotlin: declares top-level classes, functions, typealiases and the synthesized <File>Kt class",
      byFile.get(`${KM}/util/Strings.kt`)?.declares ?? [],
      ["com.acme.util.Name", "com.acme.util.capitalize", "com.acme.util.Strings", "com.acme.util.StringsKt"],
    );
    checkSet(
      "kotlin: object/companion/data class/sealed class/enum/interface all recognised, nested types are not top-level",
      byFile.get(`${KM}/app/Shapes.kt`)?.declares ?? [],
      ["com.acme.app.Shape", "com.acme.app.Color", "com.acme.app.Named"],
    );
    checkSet(
      "kotlin: data class + class + top-level fun (companion object nested, not top-level)",
      byFile.get(`${KM}/app/App.kt`)?.declares ?? [],
      ["com.acme.app.Config", "com.acme.app.Launcher", "com.acme.app.main", "com.acme.app.AppKt"],
    );
    check(
      "kotlin: .kts build scripts never contribute declares",
      byFile.get("jvmapp/build.gradle.kts")?.declares === undefined &&
        byFile.get("jvmapp/core/build.gradle.kts")?.declares === undefined &&
        byFile.get("jvmapp/settings.gradle.kts")?.declares === undefined,
    );
    check(
      "empty file and syntax-error files are tolerated (no crash, no bogus declares)",
      byFile.get(`${KM}/util/Empty.kt`) !== undefined &&
        byFile.get(`${JM}/broken/Broken.java`)?.declares === undefined &&
        byFile.get(`${KM}/broken/Broken.kt`) !== undefined,
    );

    checkSet("java <-> kotlin: exact edge set", edgeStrings(result), [
      // Java -> Kotlin: explicit imports of a Kotlin top-level function's <File>Kt
      // class, and same-package references to a Kotlin class/data class with no import.
      ...E(
        `${JM}/app/JavaCaller.java`,
        `${JM}/model/User.java`,
        `${KM}/util/Strings.kt`, // import com.acme.util.StringsKt (top-level fun capitalize)
        `${KM}/util/Numbers.kt`, // import com.acme.util.NumbersKt (top-level fun triple)
        `${KM}/app/App.kt`, // same-package Launcher + Config, no import
      ),
      // Java wildcard import (`import com.acme.model.*;`) resolves to every file
      // declaring something in that package.
      ...E(`${JM}/app/WildcardUser.java`, `${JM}/model/User.java`, `${JM}/model/Outer.java`),
      // Kotlin -> Java: explicit `import com.acme.model.User`.
      ...E(`${KM}/util/Strings.kt`, `${JM}/model/User.java`),
      // Kotlin: `as` alias, wildcard import, explicit import, and a same-package
      // reference (Shape) resolved with no import at all.
      ...E(`${KM}/app/App.kt`, `${JM}/model/User.java`, `${KM}/util/Strings.kt`, `${KM}/util/Numbers.kt`, `${KM}/app/Shapes.kt`),
      // Test source set: explicit import plus a same-package reference into the
      // *main* source set (only main declares JavaCaller).
      ...E(`${JT}/app/JavaCallerTest.java`, `${JM}/model/User.java`, `${JM}/app/JavaCaller.java`),
      // Cross-module (client depends on core), cross-language both ways.
      ...E(`${CL}/Client.kt`, `${JM}/model/User.java`, `${KM}/app/App.kt`),
    ]);

    check(
      "kotlin: `import x as y` resolves via the aliased name (App.kt -> Strings.kt)",
      result.edges.some((e) => e.from === `${KM}/app/App.kt` && e.to === `${KM}/util/Strings.kt`) &&
        byFile.get(`${KM}/app/App.kt`)?.imports.some((i) => i.raw === "com.acme.util.Strings" && i.resolvedPath === `${KM}/util/Strings.kt`) === true,
    );
    check(
      "kotlin: same-package `Shape` reference with no import resolves, speculatively",
      byFile.get(`${KM}/app/App.kt`)?.imports.some((i) => i.raw === "com.acme.app.Shape" && i.resolvedPath === `${KM}/app/Shapes.kt`) === true,
    );
    check(
      "java: same-package Kotlin `Launcher`/`Config` references with no import resolve",
      byFile.get(`${JM}/app/JavaCaller.java`)?.imports.some((i) => i.raw === "com.acme.app.Launcher" && i.resolvedPath === `${KM}/app/App.kt`) === true &&
        byFile.get(`${JM}/app/JavaCaller.java`)?.imports.some((i) => i.raw === "com.acme.app.Config" && i.resolvedPath === `${KM}/app/App.kt`) === true,
    );
    check(
      "java: wildcard field type `Outer.Inner` contributes a speculative reference to Outer",
      byFile.get(`${JM}/app/WildcardUser.java`)?.imports.some((i) => i.raw === "com.acme.model.Outer" && i.resolvedPath === `${JM}/model/Outer.java`) === true,
    );
    check(
      "comments and string contents (including a fake import inside a Kotlin block comment) never produce an edge or external package",
      !result.edges.some((e) => e.to.includes("secret") || e.to.includes("Hidden") || e.to.includes("InString")) &&
        !result.externalPackages.some((p) => p.includes("fake")),
    );
    check(
      "unresolved external imports (JUnit) are reported, capped at 3 segments for a reverse-domain root",
      result.externalPackages.includes("org.junit.jupiter") && !result.externalPackages.some((p) => p.startsWith("com.acme")),
    );
    check(
      "no edge points at a source file that does not exist (broken imports drop cleanly)",
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
