// `npm test` — runs every smoke test (lib/**/smoke-test*.ts) one after the
// other with tsx and stops at the first that fails. Each gets its own empty
// data folder (GRAPHREVIEW_HOME) so none can touch a real one.
//
//   npm test                # all of them
//   npm test -- jobs impact # only those whose path contains "jobs" or "impact"
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// tsx's own CLI, started with this Node: no npx, no shell, no .cmd on Windows.
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const filters = process.argv.slice(2);

const tests = readdirSync(path.join(root, "lib"), { recursive: true })
  .map((file) => path.join("lib", file).split(path.sep).join("/"))
  .filter((file) => /^smoke-test.*\.ts$/.test(path.posix.basename(file)))
  .filter((file) => filters.length === 0 || filters.some((filter) => file.includes(filter)))
  .sort();

if (tests.length === 0) {
  console.error(`smoke tests: none found${filters.length ? ` matching ${filters.join(", ")}` : ""}.`);
  process.exit(1);
}

const started = Date.now();
for (const [index, test] of tests.entries()) {
  console.log(`\n=== [${index + 1}/${tests.length}] ${test}`);
  const home = mkdtempSync(path.join(os.tmpdir(), "graphreview-test-"));
  const testStarted = Date.now();
  let result;
  try {
    result = spawnSync(process.execPath, [tsx, test], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, GRAPHREVIEW_HOME: home },
    });
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
  const seconds = ((Date.now() - testStarted) / 1000).toFixed(1);
  if (result.error || result.status !== 0) {
    const why = result.error?.message ?? (result.signal ? `killed by ${result.signal}` : `exit code ${result.status}`);
    console.error(`\nsmoke tests: ${test} failed (${why}, ${seconds} s).`);
    process.exit(result.status || 1);
  }
  console.log(`=== ${test} passed (${seconds} s)`);
}
console.log(`\nsmoke tests: all ${tests.length} passed (${((Date.now() - started) / 1000).toFixed(1)} s).`);
