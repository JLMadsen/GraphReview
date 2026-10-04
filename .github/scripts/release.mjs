// `npm run release` — cuts the next release: bumps the patch number in
// package.json (0.1.4 → 0.1.5), commits and tags it, and pushes both. The
// tag starts .github/workflows/release.yml, which builds, tests and
// publishes. Versions are just a counter; nothing else needs choosing.
import { execFileSync } from "node:child_process";

const run = (command, args) => execFileSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
const read = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const branch = read(["branch", "--show-current"]);
if (branch !== "Master") {
  console.error(`release: releases are cut from Master; this is ${branch || "a detached HEAD"}.`);
  process.exit(1);
}
if (read(["status", "--porcelain"])) {
  console.error("release: commit or stash your changes first.");
  process.exit(1);
}

run("git", ["pull", "--ff-only"]);
run("npm", ["version", "patch", "-m", "Release %s"]);
run("git", ["push", "--follow-tags"]);
console.log("release: pushed — follow it under Actions → Release on GitHub.");
