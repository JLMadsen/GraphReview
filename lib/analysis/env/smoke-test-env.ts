/**
 * Checks for the env catalog (lib/analysis/env/) and the env comparison
 * (DESIGN.md §6.15): a monorepo with a Next app (t3-env schema,
 * `.env.example`, `.env.production`, a `"use client"` import chain), a Node
 * API, a pydantic and a Go service, Compose with `env_file` and `${X:-d}`,
 * a GitHub workflow with secrets and a Prisma schema — then a head that
 * produces each of the four findings.
 *
 *   npx tsx lib/analysis/env/smoke-test-env.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeRepo } from "../graph-builder";
import type { ChangedLines } from "../compare";
import { scanCodeFacts } from "../infra/code-facts";
import { compareEnv } from "./compare";
import { describeEnvChange, envChangesTouching } from "./describe";
import { dotenvTarget, readEnvFile } from "./read";
import { isPlaceholder, isSecretName, isSecretValue, valueForModel } from "./secret";
import type { EnvCatalog } from "./types";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function writeTree(root: string, files: Record<string, string | null>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    if (content === null) {
      rmSync(abs, { force: true });
      continue;
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

const lines = (...l: string[]) => `${l.join("\n")}\n`;

export const BASE: Record<string, string> = {
  "package.json": `{ "name": "mono", "private": true }\n`,
  // --- a Next app ---
  "apps/web/package.json": `{ "name": "web", "dependencies": { "next": "15.0.0" } }\n`,
  "apps/web/next.config.mjs": lines("export default {", "  env: {", '    BUILD_CHANNEL: "stable",', "  },", "};"),
  "apps/web/env.ts": lines(
    'import { createEnv } from "@t3-oss/env-nextjs";',
    'import { z } from "zod";',
    "export const env = createEnv({",
    "  server: {",
    "    DATABASE_URL: z.string().url(),",
    '    LOG_LEVEL: z.enum(["debug", "info"]).default("info"),',
    "  },",
    "  client: {",
    "    NEXT_PUBLIC_API_BASE: z.string().url(),",
    "  },",
    "  runtimeEnv: {",
    "    DATABASE_URL: process.env.DATABASE_URL,",
    "    LOG_LEVEL: process.env.LOG_LEVEL,",
    "    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE,",
    "  },",
    "});"
  ),
  "apps/web/.env.example": lines("# Postgres connection string", "DATABASE_URL=postgres://user:pass@localhost:5432/app", "NEXT_PUBLIC_API_BASE=http://localhost:3000"),
  "apps/web/.env.production": lines("DATABASE_URL=postgres://app:Xk9qPz77LmQa@db.internal:5432/app", "NEXT_PUBLIC_API_BASE=https://app.acme.io"),
  "apps/web/app/page.tsx": lines('import { Pay } from "../components/Pay";', "export default function Page() {", "  const url = process.env.DATABASE_URL!;", "  return <Pay />;", "}"),
  "apps/web/components/Pay.tsx": lines('"use client";', 'import { config } from "../lib/client-config";', "export function Pay() {", "  return <a href={config.base}>pay</a>;", "}"),
  "apps/web/lib/client-config.ts": lines("export const config = {", "  base: process.env.NEXT_PUBLIC_API_BASE,", "  session: process.env.SESSION_SECRET,", "};"),
  "apps/web/lib/blob.ts": lines('"use server";', 'export const token = process.env.PUBLIC_BLOB_TOKEN ?? "";'),
  // --- a Node API ---
  "apps/api/package.json": `{ "name": "api" }\n`,
  "apps/api/.env.example": lines("QUEUE_NAME=jobs"),
  "apps/api/src/server.ts": lines(
    'const redis = process.env.REDIS_URL ?? "redis://localhost:6379";',
    "const db = process.env.DATABASE_URL;",
    "const queue = process.env.QUEUE_NAME;",
    "const only = process.env.API_ONLY;",
    "export { redis, db, queue, only };"
  ),
  // --- a Vite SPA with its own client prefix ---
  "apps/spa/vite.config.ts": lines('import { defineConfig } from "vite";', 'export default defineConfig({ envPrefix: "APP_PUBLIC_" });'),
  "apps/spa/src/main.ts": lines("const api = import.meta.env.APP_PUBLIC_API;", "const key = import.meta.env.SPA_TOKEN;", "export { api, key };"),
  // --- Python and Go ---
  "services/py/settings.py": lines(
    "from pydantic_settings import BaseSettings, SettingsConfigDict",
    "",
    "class Settings(BaseSettings):",
    '    model_config = SettingsConfigDict(env_prefix="APP_")',
    "    db_url: str",
    "    debug: bool = False",
    "",
    "settings = Settings()"
  ),
  "services/go/config.go": lines("package config", "", "type Config struct {", '\tPort int `env:"GO_PORT" envDefault:"8080"`', '\tKey  string `env:"GO_API_KEY,required"`', "}"),
  // --- Compose, CI, Prisma ---
  "compose.yml": lines(
    "services:",
    "  web:",
    "    build: ./apps/web",
    "    env_file: apps/web/.env.production",
    "    environment:",
    "      NODE_ENV: production",
    "      LOG_LEVEL: ${LOG_LEVEL:-info}",
    "  api:",
    "    build:",
    "      context: ./apps/api",
    "    environment:",
    "      - REDIS_URL=redis://redis:6379",
    "      - API_ONLY"
  ),
  ".github/workflows/deploy.yml": lines(
    "name: deploy",
    "on: push",
    "jobs:",
    "  ship:",
    "    environment: production",
    "    runs-on: ubuntu-latest",
    "    env:",
    "      DATABASE_URL: ${{ secrets.DATABASE_URL }}",
    "      SENTRY_ENV: prod",
    "    steps:",
    "      - run: docker build -t acme/web apps/web"
  ),
  ".github/ISSUE_TEMPLATE/bug.yml": lines("name: Bug"),
  "prisma/schema.prisma": lines("datasource db {", '  provider = "postgresql"', '  url      = env("DATABASE_URL")', "}"),
};

/** The head: one change per finding. */
export const HEAD: Record<string, string | null> = {
  // 1. a new read nothing declares (line 5)
  "apps/api/src/server.ts": lines(
    'const redis = process.env.REDIS_URL ?? "redis://localhost:6379";',
    "const db = process.env.DATABASE_URL;",
    "const queue = process.env.QUEUE_NAME;",
    "const only = process.env.API_ONLY;",
    "const mailer = process.env.MAILER_KEY;",
    "export { redis, db, queue, only, mailer };"
  ),
  // 2. a secret-looking name exposed to the client (line 4)
  "apps/web/lib/client-config.ts": lines("export const config = {", "  base: process.env.NEXT_PUBLIC_API_BASE,", "  session: process.env.SESSION_SECRET,", "  stripe: process.env.NEXT_PUBLIC_STRIPE_SECRET,", "};"),
  "apps/web/.env.example": lines("# Postgres connection string", "DATABASE_URL=postgres://user:pass@localhost:5432/app", "NEXT_PUBLIC_API_BASE=http://localhost:3000", "NEXT_PUBLIC_STRIPE_SECRET="),
  // 3. a committed secret value (line 3)
  "apps/web/.env.production": lines("DATABASE_URL=postgres://app:Xk9qPz77LmQa@db.internal:5432/app", "NEXT_PUBLIC_API_BASE=https://app.acme.io", "STRIPE_SECRET_KEY=sk_live_51NabcdefGHIJKLmnop"),
  // 4. a declaration removed while still read
  "apps/api/.env.example": lines("# nothing here any more"),
};

const CHANGED = new Map<string, ChangedLines>([
  ["apps/api/src/server.ts", { added: new Set([5, 6]), removed: new Set([5]) }],
  ["apps/web/lib/client-config.ts", { added: new Set([4]), removed: new Set() }],
  ["apps/web/.env.example", { added: new Set([4]), removed: new Set() }],
  ["apps/web/.env.production", { added: new Set([3]), removed: new Set() }],
  ["apps/api/.env.example", { added: new Set([1]), removed: new Set([1]) }],
]);

const v = (c: EnvCatalog, name: string) => c.vars.find((x) => x.name === name);

async function main(): Promise<void> {
  console.log("classifier");
  check("secret names", isSecretName("STRIPE_SECRET_KEY") && isSecretName("GITHUB_TOKEN") && isSecretName("DB_PASSWORD") && !isSecretName("STRIPE_PUBLISHABLE_KEY") && !isSecretName("API_URL"));
  check("secret values", isSecretValue("sk_live_51Nabcdef12345678") && isSecretValue("postgres://u:hunter2x@db/app") && !isSecretValue("postgres://user:pass@localhost/app") && !isSecretValue("changeme"));
  check("placeholders", isPlaceholder("<your-key>") && isPlaceholder("") && isPlaceholder("${OTHER}") && isPlaceholder("xxxxxx") && !isPlaceholder("8080x"));
  check("values for the model", valueForModel("LOG_LEVEL", "info") === "info" && valueForModel("API_KEY", "abcdef") === "<set, 6 chars>" && valueForModel("API_KEY", "changeme") === "<placeholder>");
  check(".env targets", dotenvTarget("a/.env") === "default" && dotenvTarget(".env.production.local") === "production (local)" && dotenvTarget(".env.local.example") === "example" && dotenvTarget("prod.env") === "prod");

  console.log("code scan");
  const js = scanCodeFacts("typescript", lines('const a = process.env.A ?? "x";', "const b = process.env.B!;", "const { C = 3, D } = process.env;", "if (!process.env.E) throw new Error();", "const f = import.meta.env.VITE_F;"));
  const flags = Object.fromEntries((js?.env ?? []).map(([n, , f]) => [n, f]));
  check("fallback, required, destructured default, guard, import.meta", flags.A?.f === "x" && flags.B?.r === 1 && flags.C?.f === "3" && !flags.D && flags.E?.r === 1 && flags.VITE_F?.m === 1, JSON.stringify(flags));
  const handled = scanCodeFacts(
    "typescript",
    lines('const a = process.env.A?.trim() || "2g";', "const b = Number(process.env.B) || 1;", 'if (process.env.C !== "1") start();', "const d = process.env.D ? 1 : 2;", "if (process.env.E) go();", "const f = process.env.F;")
  );
  const hFlags = Object.fromEntries((handled?.env ?? []).map(([n, , f]) => [n, f?.f]));
  check("optional chaining, Number(…) ||, comparisons, ternaries and if (…) handle a missing value", hFlags.A === "2g" && hFlags.B === "1" && hFlags.C === "…" && hFlags.D === "…" && hFlags.E === "…" && hFlags.F === undefined, JSON.stringify(hFlags));
  const py = scanCodeFacts("python", lines('import os', 'a = os.getenv("A", "d")', 'b = os.environ["B"]', 'c = os.environ.get("C")'));
  const pyFlags = Object.fromEntries((py?.env ?? []).map(([n, , f]) => [n, f]));
  check("python fallback and required", pyFlags.A?.f === "d" && pyFlags.B?.r === 1 && !pyFlags.C, JSON.stringify(pyFlags));
  const writes = scanCodeFacts("typescript", lines('process.env.A = "0";', "delete process.env.B;", 'process.env.C ??= "d";', 'os.environ["D"] = "1"'));
  check("writes aren't reads; ??= is a fallback", JSON.stringify(writes?.env ?? []) === JSON.stringify([["C", 3, { f: "d" }]]), JSON.stringify(writes?.env));
  check('"use server" and server-only mark the file', scanCodeFacts("typescript", lines('"use server";', "export async function a() {}"))?.server === true && scanCodeFacts("typescript", lines('import "server-only";', "export const x = 1;"))?.server === true);
  check('"use client" marks the file', scanCodeFacts("tsx", lines("// hi", '"use client";', "export const x = 1;"))?.client === true);
  const gha = readEnvFile("gha", ".github/workflows/deploy.yml", BASE[".github/workflows/deploy.yml"]);
  check("workflow: secret ref and value, environment as target", gha.kind === "env-source" && gha.sets.some((s) => s.name === "DATABASE_URL" && s.ref === "secret DATABASE_URL" && s.target === "ci:production" && s.line === 8) && gha.sets.some((s) => s.name === "SENTRY_ENV" && s.value === "prod"), JSON.stringify(gha));

  const tmp = mkdtempSync(path.join(os.tmpdir(), "gr-env-"));
  const headDir = mkdtempSync(path.join(os.tmpdir(), "gr-env-head-"));
  try {
    writeTree(tmp, BASE);
    writeTree(headDir, BASE);
    const base = await analyzeRepo(tmp);
    const env = base.env;

    console.log("catalog");
    check("scopes: the Next app (framework) and the API", env.scopes.some((s) => s.root === "apps/web" && s.framework === "next") && env.scopes.some((s) => s.root === "apps/api"), JSON.stringify(env.scopes));
    const db = v(env, "DATABASE_URL");
    check("DATABASE_URL: read in code and Prisma, t3-env + example declared, set in .env.production and CI", Boolean(
      db && db.reads.some((r) => r.file === "apps/web/app/page.tsx" && r.required) && db.reads.some((r) => r.host && r.file === "prisma/schema.prisma") &&
      db.decls.some((d) => d.via === "t3-env" && d.type === "url") && db.decls.some((d) => d.via === "example" && d.description === "Postgres connection string") &&
      db.sets.some((s) => s.target === "production" && s.value?.startsWith("postgres://app:")) && db.sets.some((s) => s.target === "ci:production" && s.ref)
    ), JSON.stringify(db));
    check("DATABASE_URL is secret-looking by value", db?.tags.includes("secret") === true, db?.tags.join(","));
    check(
      "a .env in apps/web doesn't cover the read in apps/api (only CI's secret ref does: maybe set)",
      db?.reads.find((r) => r.file === "apps/api/src/server.ts")?.gap === "maybe-set" && db.reads.find((r) => r.file === "apps/web/app/page.tsx")?.gap === undefined,
      JSON.stringify(db?.reads)
    );
    check("Compose env_file gives .env.production the web service's scope", db?.sets.find((s) => s.target === "production")?.scope.includes("apps/web") === true);
    check("NEXT_PUBLIC_API_BASE is client by prefix, read in client code", v(env, "NEXT_PUBLIC_API_BASE")?.clientVia === "NEXT_PUBLIC_ prefix" && v(env, "NEXT_PUBLIC_API_BASE")!.reads.some((r) => r.client));
    check("PUBLIC_ is no client prefix outside SvelteKit/Astro", v(env, "PUBLIC_BLOB_TOKEN") !== undefined && !v(env, "PUBLIC_BLOB_TOKEN")!.clientVia, JSON.stringify(v(env, "PUBLIC_BLOB_TOKEN")));
    check("SESSION_SECRET read in a file a 'use client' file imports → undefined in client", v(env, "SESSION_SECRET")?.tags.includes("undefined-in-client") === true, v(env, "SESSION_SECRET")?.tags.join(","));
    check("BUILD_CHANNEL from next.config env is client, set but not read", v(env, "BUILD_CHANNEL")?.tags.includes("client") === true && v(env, "BUILD_CHANNEL")!.tags.includes("set-not-read"));
    check("REDIS_URL has a fallback, so no gap", v(env, "REDIS_URL")?.reads.every((r) => r.fallback === "redis://localhost:6379" && !r.gap) === true);
    check("API_ONLY passed through from the host → maybe set", v(env, "API_ONLY")?.tags.includes("maybe-set") === true, v(env, "API_ONLY")?.tags.join(","));
    check("QUEUE_NAME declared by apps/api/.env.example, not set → not-set", v(env, "QUEUE_NAME")?.tags.includes("not-set") === true, v(env, "QUEUE_NAME")?.tags.join(","));
    check("Vite envPrefix makes its names client", v(env, "APP_PUBLIC_API")?.clientVia === "APP_PUBLIC_ prefix", JSON.stringify(v(env, "APP_PUBLIC_API")));
    check("an unprefixed import.meta.env read in a Vite app → undefined in client", v(env, "SPA_TOKEN")?.tags.includes("undefined-in-client") === true, v(env, "SPA_TOKEN")?.tags.join(","));
    check("pydantic fields with env_prefix", v(env, "APP_DB_URL")?.decls[0]?.via === "pydantic" && v(env, "APP_DEBUG")?.decls[0]?.default === "False");
    check("Go struct tags", v(env, "GO_PORT")?.decls[0]?.default === "8080" && v(env, "GO_API_KEY")?.decls[0]?.optional === undefined);
    check("Compose host interpolation with a fallback", v(env, "LOG_LEVEL")?.reads.some((r) => r.host && r.fallback === "info") === true);
    check("NODE_ENV is platform", v(env, "NODE_ENV")?.tags.includes("platform") === true && env.vars[env.vars.length - 1]?.tags.includes("platform") === true);
    check("columns: example first, then .env files, then Compose and CI", env.targets[0]?.id === "example" && env.targets.some((t) => t.id === "compose:web") && env.targets.some((t) => t.id === "ci:production"), env.targets.map((t) => t.id).join(","));
    const graphFile = (file: string) => base.files.find((f) => f.file === file);
    check(
      "env sources are graph files, so an env-only change has a component",
      graphFile("apps/web/.env.example")?.language === "dotenv" && graphFile(".github/workflows/deploy.yml")?.language === "ci" && base.modules.some((m) => m.filePaths.includes("apps/web/.env.example")),
      JSON.stringify([graphFile("apps/web/.env.example"), graphFile(".github/workflows/deploy.yml")])
    );
    check("only the workflow files of .github are read", !base.files.some((f) => f.file.includes("ISSUE_TEMPLATE")) && env.targets.some((t) => t.files.includes(".github/workflows/deploy.yml")));

    console.log("comparison");
    writeTree(headDir, HEAD);
    const head = await analyzeRepo(headDir);
    const diff = compareEnv(base.env, head.env, CHANGED);
    const rules = diff.findings.map((f) => `${f.rule}:${f.name}`);
    check("undeclared read → finding", rules.includes("undeclared-read:MAILER_KEY"), rules.join(", "));
    check("secret to client → finding (defect)", diff.findings.some((f) => f.rule === "secret-to-client" && f.name === "NEXT_PUBLIC_STRIPE_SECRET" && f.assessment === "defect"), rules.join(", "));
    check("committed secret → finding, value not quoted", diff.findings.some((f) => f.rule === "committed-secret" && f.name === "STRIPE_SECRET_KEY" && f.line === 3 && !f.rationale.includes("sk_live") && !f.summary.includes("sk_live")), rules.join(", "));
    check("declaration removed, still read → finding", rules.includes("declaration-removed:QUEUE_NAME"), rules.join(", "));
    check("exactly those four", diff.findings.length === 4, rules.join(", "));
    check("findings first, then gone → new → changed", diff.changes.findIndex((c) => !c.findings) === diff.findings.length || diff.changes.filter((c) => c.findings).length >= 1);
    const stripe = diff.changes.find((c) => c.name === "STRIPE_SECRET_KEY");
    check("a new name with its production cell", stripe?.status === "new" && stripe.deltas.some((d) => d.where === "production" && d.after?.startsWith("sk_live")), JSON.stringify(stripe?.deltas));
    const queue = diff.changes.find((c) => c.name === "QUEUE_NAME");
    check("a removed example cell", queue?.deltas.some((d) => d.where === "example" && d.before === "jobs" && d.after === undefined) === true, JSON.stringify(queue?.deltas));
    check("an infra 'no longer set' finding for the name wins", !compareEnv(base.env, head.env, CHANGED, [{ key: "k", rule: "env-unset", resource: "r", name: "QUEUE_NAME", file: "f", summary: "", rationale: "" }]).findings.some((f) => f.rule === "declaration-removed"));

    console.log("review context");
    const ctx = envChangesTouching(diff, new Set(["apps/web/lib/client-config.ts"]));
    check("a component's review gets the names its files read", ctx.entries.some((e) => e.name === "NEXT_PUBLIC_STRIPE_SECRET") && ctx.findings.some((f) => f.rule === "secret-to-client"));
    const text = describeEnvChange(diff).join("\n");
    check("described for prompts, secret values masked", text.includes("STRIPE_SECRET_KEY") && !text.includes("sk_live") && !text.includes("Xk9qPz77"), text);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(headDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall env checks passed");
}

void main();
