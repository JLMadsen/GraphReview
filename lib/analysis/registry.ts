/**
 * Central analyzer registry: analyzers are looked up by file
 * extension, so adding language N+1 means adding it here and nowhere else —
 * `graph-builder.ts` never names a language.
 */
import type { LanguageAnalyzer } from "./analyzer";
import { extensionOf } from "./paths";
import { goAnalyzer } from "./languages/go";
import { javaAnalyzer } from "./languages/java";
import { kotlinAnalyzer } from "./languages/kotlin";
import { pythonAnalyzer } from "./languages/python";
import { rustAnalyzer } from "./languages/rust";
import { typescriptAnalyzer } from "./languages/typescript";

const byExtension = new Map<string, LanguageAnalyzer>();
const registered: LanguageAnalyzer[] = [];

/** Register an analyzer for all of its extensions (last registration wins). */
export function registerAnalyzer(analyzer: LanguageAnalyzer): void {
  const existing = registered.findIndex((a) => a.id === analyzer.id);
  if (existing === -1) registered.push(analyzer);
  else registered[existing] = analyzer;
  for (const ext of analyzer.extensions) {
    byExtension.set(ext.toLowerCase(), analyzer);
  }
}

// v1 language coverage: JS/TS and Python. v2 adds Go, Java and Rust to
// prove out the extension point; Kotlin joins Java on the shared JVM resolver.
// Everything else falls through unanalyzed.
registerAnalyzer(typescriptAnalyzer);
registerAnalyzer(pythonAnalyzer);
registerAnalyzer(goAnalyzer);
registerAnalyzer(javaAnalyzer);
registerAnalyzer(kotlinAnalyzer);
registerAnalyzer(rustAnalyzer);

/** Every registered analyzer, in registration order. */
export function listAnalyzers(): readonly LanguageAnalyzer[] {
  return registered;
}

/** The analyzer claiming this extension (`.ts`), if any. */
export function analyzerForExtension(ext: string): LanguageAnalyzer | undefined {
  return byExtension.get(ext.toLowerCase());
}

/** The analyzer claiming this file path, if any. */
export function analyzerForPath(filePath: string): LanguageAnalyzer | undefined {
  return analyzerForExtension(extensionOf(filePath));
}

/** All extensions currently covered by some analyzer. */
export function analyzedExtensions(): string[] {
  return [...byExtension.keys()].sort();
}
