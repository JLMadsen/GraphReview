/**
 * Checks for the security findings (DESIGN.md §6.26): the diff-wide secret
 * scan (hits in any file, placeholders and lockfiles skipped, the value never
 * in a finding) and the endpoint auth findings from an API change.
 *
 * Token-shaped strings are assembled at runtime so this file itself holds
 * none (and trips no push protection).
 *
 *   npm test -- security
 */
import type { ChangedLines } from "../compare";
import type { ApiChange, Endpoint } from "../api/types";
import { endpointAuthFindings, secretFindings } from "./findings";
import { clearMcpToken, createMcpToken, getMcpToken, mcpRequestAllowed } from "../../mcp/token";
import { isScannedFile, scanDiffForSecrets, secretsInLine } from "./secret-scan";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const j = (...parts: string[]) => parts.join("");
const GH = j("gh", "p_", "R8f2KqLm93TzVx0NwYb7Hc4Ud6Ps1AeJg5Wi");
const AWS = j("AK", "IA", "Q7XM2PLK9TRV4BNZ");
const STRIPE = j("sk", "_live_", "51Hx9KqTz8Lm2Pv4Nw7Rb");
const HIGH = "q9Zr4Kx7Tm2Vb8Nc5Lp1Wd3Hj6Fg0Ys";
const DB_PW = "Xk9qPz77vR2m";

function diffOf(files: Record<string, string[]>): string {
  return Object.entries(files)
    .map(([file, lines]) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n"))
    .join("\n");
}

async function main(): Promise<void> {
  console.log("secret scan");
  const diff = diffOf({
    "src/config.ts": [
      `export const github = "${GH}";`, // 1: GitHub token in code
      `const apiKey = "${HIGH}";`, // 2: high-entropy value for a secret name
      `const url = "postgres://app:${DB_PW}@db.internal:5432/app";`, // 3: URL with a password
      `const local = "postgres://app:${DB_PW}@localhost/app";`, // 4: local URL — skipped
      `const sha = "3f786850e387550fdab836ed7e6dc881de23001b";`, // 5: a hash, no secret name — skipped
    ],
    "test/fixtures/aws.json": [`{ "accessKeyId": "${AWS}" }`],
    "certs/server.pem": ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA1x"],
    "docs/setup.md": [
      `STRIPE_SECRET_KEY=${j("sk", "_live_")}xxxxxxxxxxxxxxxx`,
      `token: <token>`,
      `password = "changeme"`,
      `aws_access_key_id = ${j("AK", "IA")}IOSFODNN7EXAMPLE`,
      `GITHUB_TOKEN=${j("gh", "p_")}000000000000000000000000000000000000`,
      `api_key: "\${API_KEY}"`,
      `secret = process.env.SECRET_TOKEN_VALUE_FROM_ENV`,
    ],
    "package-lock.json": [`"resolved": "https://x:${STRIPE}@registry.example.org/a.tgz"`, `"integrity": "sha512-${HIGH}"`],
  });
  const { hits, capped } = scanDiffForSecrets(diff);
  const at = (file: string, line: number) => hits.filter((h) => h.file === file && h.line === line);
  check("GitHub token in code", at("src/config.ts", 1).some((h) => h.kind === "GitHub token"), JSON.stringify(hits));
  check("high-entropy value for a secret name", at("src/config.ts", 2).some((h) => h.kind === "high-entropy value for apiKey"), JSON.stringify(hits));
  check("URL with a password", at("src/config.ts", 3).some((h) => h.kind === "URL with a password"), JSON.stringify(hits));
  check("localhost URL skipped", at("src/config.ts", 4).length === 0);
  check("a bare hash skipped", at("src/config.ts", 5).length === 0);
  check("AWS key in a test fixture", at("test/fixtures/aws.json", 1).some((h) => h.kind === "AWS access key"));
  check("private key in a .pem file", at("certs/server.pem", 1).some((h) => h.kind === "private key"));
  check("placeholders skipped (xxx, <token>, changeme, EXAMPLE, 000…, ${VAR}, a reference)", hits.every((h) => h.file !== "docs/setup.md"), JSON.stringify(hits.filter((h) => h.file === "docs/setup.md")));
  check("lockfiles skipped", !isScannedFile("package-lock.json") && !isScannedFile("web/yarn.lock") && isScannedFile("src/lock.ts") && hits.every((h) => h.file !== "package-lock.json"));
  check("exactly the five hits, not capped", hits.length === 5 && !capped, JSON.stringify(hits));
  check("Stripe live key", secretsInLine(`stripe(${JSON.stringify(STRIPE)})`).some((s) => s.kind === "Stripe live key"));
  check("one hit per value on a line", secretsInLine(`TOKEN=${GH}`).length === 1);
  check("removed lines ignored", scanDiffForSecrets(`diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +0,0 @@\n-${GH}`).hits.length === 0);
  const hunked = scanDiffForSecrets(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,0 +11,2 @@\n+const a = 1;\n+const t = "${GH}";`);
  check("line numbers follow the hunk", hunked.hits[0]?.line === 12, JSON.stringify(hunked.hits));

  const findings = secretFindings(hits, capped, new Set(["src/config.ts:3"]));
  const text = JSON.stringify(findings);
  check("one defect per hit, env-reported line left out", findings.length === 4 && findings.every((f) => f.assessment === "defect" && f.rule === "secret"), text);
  check("findings never hold the value", [GH, AWS, HIGH, DB_PW, "MIIEow"].every((v) => !text.includes(v)), text);
  check("file, line and kind named", findings[0].summary === "A GitHub token is committed in src/config.ts:1", findings[0].summary);
  check("stable key without the value", findings.every((f) => /^security:secret:[^:]+:[^:]+:[0-9a-f]{12}$/.test(f.key)), findings.map((f) => f.key).join(" "));

  console.log("endpoint auth");
  const ep = (id: string, path: string, auth: string[], file = "src/routes.ts", line = 10, framework = "Express"): Endpoint => ({
    id,
    kind: "http",
    method: "GET",
    path,
    framework,
    group: "orders",
    handler: { file, startLine: line, endLine: line + 5, name: "h" },
    registeredAt: { file, line },
    params: [],
    auth,
    reach: [],
  });
  const change = (changes: ApiChange["changes"]): ApiChange => ({ changes, logic: [], counts: { added: 0, removed: 0, changed: 0, breaking: 0, logic: 0 }, total: 0 });
  const authDelta = (a: Endpoint, b: Endpoint) => [{ aspect: "auth" as const, before: a.auth.join(" → ") || undefined, after: b.auth.join(" → ") || undefined }];
  const noInfra = { links: { deploys: [], env: [], routes: [], ports: [] } };
  const touched: Map<string, ChangedLines> = new Map([["src/routes.ts", { added: new Set([10]), removed: new Set([10]) }]]);

  // 1. Auth removed on the registration line the change edits → certain.
  const b1 = ep("e1", "/orders", ["requireAuth"]);
  const h1 = ep("e1", "/orders", []);
  const base = [b1, ep("e9", "/users", ["requireAuth"])];
  const removed = endpointAuthFindings(change([{ id: "e1", status: "changed", endpoint: h1, before: b1, deltas: authDelta(b1, h1) }]), base, noInfra, touched);
  check("something → none is a certain defect", removed.length === 1 && removed[0].rule === "auth-removed" && removed[0].assessment === "defect", JSON.stringify(removed));
  // 2. Same, explicit public marker, registration untouched → still certain.
  const h2 = ep("e1", "/orders", ["@PermitAll"]);
  const explicit = endpointAuthFindings(change([{ id: "e1", status: "changed", endpoint: h2, before: b1, deltas: authDelta(b1, h2) }]), base, noInfra, new Map());
  check("something → @PermitAll is a certain defect", explicit.length === 1 && explicit[0].rule === "auth-removed", JSON.stringify(explicit));
  // 3. Registration untouched, nothing visible → unknown.
  const unknown = endpointAuthFindings(change([{ id: "e1", status: "changed", endpoint: h1, before: b1, deltas: authDelta(b1, h1) }]), base, noInfra, new Map());
  check("something → ? is a concern", unknown.length === 1 && unknown[0].rule === "auth-unknown" && unknown[0].assessment === "concern", JSON.stringify(unknown));
  // 4. Auth changed but still present → nothing.
  const h4 = ep("e1", "/orders", ["requireAdmin"]);
  check("auth swapped, not removed → none", endpointAuthFindings(change([{ id: "e1", status: "changed", endpoint: h4, before: b1, deltas: authDelta(b1, h4) }]), base, noInfra, touched).length === 0);
  // 5. New endpoint without auth in an app that authenticates → concern.
  const n5 = ep("e5", "/export", [], "src/export.ts", 3);
  const open = endpointAuthFindings(change([{ id: "e5", status: "added", endpoint: n5, deltas: [] }]), base, noInfra, new Map());
  check("new endpoint with no auth is a concern", open.length === 1 && open[0].rule === "new-endpoint-open" && open[0].file === "src/export.ts", JSON.stringify(open));
  // 6. …unless an infra route with auth covers it.
  const covered = { links: { deploys: [], env: [], ports: [], routes: [{ resource: "traefik", path: "/export", via: "traefik", endpoints: ["e5"], auth: ["forwardauth"] }] } };
  check("infra-level auth covers a new endpoint", endpointAuthFindings(change([{ id: "e5", status: "added", endpoint: n5, deltas: [] }]), base, covered, new Map()).length === 0);
  // 7. …and an app with no auth anywhere raises nothing.
  check("no auth anywhere → no new-endpoint noise", endpointAuthFindings(change([{ id: "e5", status: "added", endpoint: n5, deltas: [] }]), [ep("e9", "/users", [])], noInfra, new Map()).length === 0);
  // 8. Many open endpoints roll up.
  const many = Array.from({ length: 9 }, (_, i) => ep(`n${i}`, `/n${i}`, [], "src/n.ts", i + 1));
  const rolled = endpointAuthFindings(change(many.map((e) => ({ id: e.id, status: "added" as const, endpoint: e, deltas: [] }))), base, noInfra, new Map());
  check("more than six new open endpoints roll up", rolled.length === 7 && rolled[6].summary.startsWith("3 more"), rolled.map((f) => f.summary).join(" | "));

  console.log("MCP token");
  check("off by default", (await getMcpToken()) === null && mcpRequestAllowed(null, null));
  const token = await createMcpToken();
  check("generated, stored and read back", token.length > 40 && (await getMcpToken()) === token);
  check("required once set", !mcpRequestAllowed(null, token) && !mcpRequestAllowed("Bearer nope", token) && mcpRequestAllowed(`Bearer ${token}`, token));
  await clearMcpToken();
  check("turned off again", (await getMcpToken()) === null);

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall security checks passed");
}

void main();
