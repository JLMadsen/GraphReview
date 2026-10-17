// Which test frameworks a repo is set up for, from its manifests and config
// files, and which framework each test file belongs to (DESIGN.md §6.22 §1).

import path from "node:path";
import type { TestFramework, TestFrameworkUse } from "./types";

type ReadText = (relPath: string) => Promise<string | null>;

const JS_DEPS: Array<[RegExp, TestFramework]> = [
  [/^vitest$/, "vitest"],
  [/^(jest|@jest\/globals|ts-jest|babel-jest)$/, "jest"],
  [/^(@playwright\/test|playwright)$/, "playwright"],
  [/^cypress$/, "cypress"],
  [/^mocha$/, "mocha"],
];
const JS_SCRIPTS: Array<[RegExp, TestFramework]> = [
  [/\bvitest\b/, "vitest"],
  [/\bjest\b/, "jest"],
  [/\bplaywright\s+test\b/, "playwright"],
  [/\bcypress\s+(run|open)\b/, "cypress"],
  [/\bmocha\b/, "mocha"],
  [/\bnode\s+(?:[^&|;]*\s)?--test\b/, "node"],
];
const CONFIG_FILES: Array<[RegExp, TestFramework]> = [
  [/^vitest\.(config|workspace)\.[cm]?[jt]s$/, "vitest"],
  [/^jest\.config\.([cm]?[jt]s|json)$/, "jest"],
  [/^playwright\.config\.[cm]?[jt]s$/, "playwright"],
  [/^cypress\.(config\.[cm]?[jt]s|json)$/, "cypress"],
  [/^\.mocharc(\.[a-z]+)?$/, "mocha"],
  [/^(pytest\.ini|conftest\.py)$/, "pytest"],
];

/** Every framework use the tree's manifests and configs name, one per framework and root. */
export async function detectFrameworks(files: readonly string[], readText: ReadText): Promise<TestFrameworkUse[]> {
  const found = new Map<string, TestFrameworkUse>();
  const add = (framework: TestFramework, file: string) => {
    const root = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    const key = `${framework}\u0000${root}`;
    if (!found.has(key)) found.set(key, { framework, root, source: file });
  };
  const hasGoTests = files.some((f) => f.endsWith("_test.go"));
  for (const file of files) {
    if (file.split("/").includes("node_modules")) continue;
    const base = path.posix.basename(file);
    for (const [re, framework] of CONFIG_FILES) if (re.test(base)) add(framework, file);
    if (base === "package.json") {
      const text = await readText(file);
      const pkg = parseJson(text);
      if (!pkg) continue;
      const deps = { ...(asRecord(pkg.dependencies)), ...(asRecord(pkg.devDependencies)) };
      for (const name of Object.keys(deps)) for (const [re, framework] of JS_DEPS) if (re.test(name)) add(framework, file);
      for (const script of Object.values(asRecord(pkg.scripts))) {
        if (typeof script !== "string") continue;
        for (const [re, framework] of JS_SCRIPTS) if (re.test(script)) add(framework, file);
      }
      if (pkg.jest && typeof pkg.jest === "object") add("jest", file);
    } else if (base === "pyproject.toml" || base === "setup.cfg" || base === "tox.ini" || /^requirements[^/]*\.txt$/.test(base) || base === "Pipfile") {
      const text = (await readText(file)) ?? "";
      if (/\[tool\.pytest|\[tool:pytest\]|^\[pytest\]|(^|[\s"'])pytest([<>=~!\s"',\]]|$)/m.test(text)) add("pytest", file);
    } else if (base === "pom.xml" || /^build\.gradle(\.kts)?$/.test(base)) {
      const text = (await readText(file)) ?? "";
      if (/junit/i.test(text)) add("junit", file);
    } else if (base === "go.mod" && hasGoTests) {
      add("go", file);
    }
  }
  return [...found.values()].sort((a, b) => a.root.localeCompare(b.root) || a.framework.localeCompare(b.framework));
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const IMPORT_HINTS: Array<[RegExp, TestFramework]> = [
  [/^@playwright\/test$/, "playwright"],
  [/^vitest(\/|$)/, "vitest"],
  [/^@jest\/globals$/, "jest"],
  [/^(node:)?test$/, "node"],
  [/^mocha$/, "mocha"],
  [/^cypress$/, "cypress"],
  [/^pytest$/, "pytest"],
  [/^org\.junit\b/, "junit"],
];
const UNIT_ORDER: TestFramework[] = ["vitest", "jest", "mocha", "node"];

/** The uses whose root holds `file`, nearest root first. */
function usesFor(file: string, uses: readonly TestFrameworkUse[]): TestFrameworkUse[] {
  return uses
    .filter((u) => u.root === "" || file.startsWith(`${u.root}/`))
    .sort((a, b) => b.root.length - a.root.length);
}

/** One test file's framework: its imports, then its language, then its nearest root's setup. */
export function frameworkOf(file: string, imports: readonly string[], uses: readonly TestFrameworkUse[], e2ePath: boolean): TestFramework {
  for (const raw of imports) for (const [re, framework] of IMPORT_HINTS) if (re.test(raw)) return framework;
  const ext = path.posix.extname(file).toLowerCase();
  const around = usesFor(file, uses);
  if (ext === ".go") return "go";
  if (ext === ".py") return uses.some((u) => u.framework === "pytest") ? "pytest" : "unittest";
  if (ext === ".java" || ext === ".kt" || ext === ".kts" || ext === ".scala") return "junit";
  if (/\.cy\.[^./]+$/.test(file) || file.split("/").includes("cypress")) return "cypress";
  if (!/^\.[cm]?[jt]sx?$/.test(ext)) return "other";
  if (e2ePath) {
    const e2e = around.find((u) => u.framework === "playwright" || u.framework === "cypress");
    if (e2e) return e2e.framework;
  }
  // The nearest root that has a unit framework decides; within it, Vitest before Jest.
  for (const use of around) {
    if (!UNIT_ORDER.includes(use.framework)) continue;
    const atRoot = around.filter((u) => u.root === use.root && UNIT_ORDER.includes(u.framework));
    return UNIT_ORDER.find((f) => atRoot.some((u) => u.framework === f)) ?? use.framework;
  }
  return "other";
}
