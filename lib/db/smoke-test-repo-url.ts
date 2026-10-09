/**
 * Checks that a stored repo URL follows `GITHUB_WEB_URL` / `GITLAB_WEB_URL`
 * when it still points at the public default host (lib/db/repo.ts).
 *
 *   npx tsx lib/db/smoke-test-repo-url.ts
 */
import { repoUrlOnConfiguredHost } from "./repo";

let failures = 0;

function check(label: string, actual: string | undefined, expected: string | undefined): void {
  if (actual === expected) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label} — got ${actual}, expected ${expected}`);
  }
}

delete process.env.GITHUB_WEB_URL;
delete process.env.GITLAB_WEB_URL;
check("no config leaves github.com alone", repoUrlOnConfiguredHost("github", "https://github.com/o/r"), "https://github.com/o/r");

process.env.GITHUB_WEB_URL = "https://ghe.example.com/";
process.env.GITLAB_WEB_URL = "https://gitlab.example.com";
check("github.com moves to GITHUB_WEB_URL", repoUrlOnConfiguredHost("github", "https://github.com/o/r"), "https://ghe.example.com/o/r");
check("www.github.com moves too", repoUrlOnConfiguredHost("github", "https://www.github.com/o/r"), "https://ghe.example.com/o/r");
check("gitlab.com moves to GITLAB_WEB_URL", repoUrlOnConfiguredHost("gitlab", "https://gitlab.com/g/sub/p"), "https://gitlab.example.com/g/sub/p");
check("another custom host is kept", repoUrlOnConfiguredHost("github", "https://other.example.com/o/r"), "https://other.example.com/o/r");
check("a look-alike host is kept", repoUrlOnConfiguredHost("github", "https://github.com.evil.example/o/r"), "https://github.com.evil.example/o/r");
check("local repos are untouched", repoUrlOnConfiguredHost("local", undefined), undefined);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
