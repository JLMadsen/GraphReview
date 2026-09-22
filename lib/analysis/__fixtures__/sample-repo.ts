/**
 * A tiny polyglot repo used to exercise the analyzer end to end.
 *
 * The fixture is kept as data (path → contents) and materialized into a temp
 * directory on demand, rather than living as real `.ts`/`.py` files in this
 * repo: the sources here are deliberately broken/incomplete from a type
 * checker's point of view, and checking them in as real files would put them in
 * the project's own `tsc`/lint scope.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const SAMPLE_REPO_FILES: Record<string, string> = {
  "tsconfig.json": [
    "{",
    '  // path aliases should be honoured by the resolver',
    '  "compilerOptions": {',
    '    "baseUrl": ".",',
    '    "paths": {',
    '      "@/*": ["./*"]',
    "    },",
    "  }",
    "}",
    "",
  ].join("\n"),

  "src/auth/index.ts": [
    'import { verifyToken } from "./token";',
    'import type { Client } from "../db/client";',
    'import { log } from "@/src/shared/log";',
    'import { z } from "zod";',
    "",
    "export async function login(client: Client, raw: string) {",
    '  const { createSession } = await import("./session");',
    "  log(z.string().parse(raw));",
    "  return createSession(client, verifyToken(raw));",
    "}",
    "",
  ].join("\n"),

  "src/auth/token.ts": [
    'import { createHash } from "node:crypto";',
    'import { hash } from "./helpers/hash";',
    'export { createSession } from "./session";',
    "",
    "export function verifyToken(raw: string) {",
    "  return hash(createHash, raw);",
    "}",
    "",
  ].join("\n"),

  "src/auth/helpers/hash.ts": [
    'import { SALT } from "../../shared/constants";',
    "",
    "export function hash(factory: unknown, value: string) {",
    "  return String(factory) + SALT + value;",
    "}",
    "",
  ].join("\n"),

  "src/auth/session.ts": [
    'import type { Client } from "../db/client";',
    "",
    "export function createSession(client: Client, token: string) {",
    "  return { client, token };",
    "}",
    "",
  ].join("\n"),

  "src/db/client.ts": [
    'import pg from "pg";',
    'import { schema } from "./schema";',
    "",
    "export type Client = typeof pg.Client;",
    "export const tables = schema;",
    "",
  ].join("\n"),

  "src/db/schema.ts": ["export const schema = { users: 1 };", ""].join("\n"),

  "src/shared/log.ts": [
    '// `./constants.js` must resolve to constants.ts (TS ESM style specifier)',
    'import { PREFIX } from "./constants.js";',
    "",
    "export function log(message: string) {",
    "  console.log(PREFIX, message);",
    "}",
    "",
  ].join("\n"),

  "src/shared/constants.ts": [
    'export const PREFIX = "[sample]";',
    'export const SALT = "salt";',
    "",
  ].join("\n"),

  "src/ui/Button.tsx": [
    'import React from "react";',
    'import { log } from "@/src/shared/log";',
    'import styles from "./button.module.css";',
    "",
    "export const Button = () => <button className={styles.root} onClick={() => log(\"click\")} />;",
    "",
  ].join("\n"),

  "src/ui/button.module.css": [".root { color: red; }", ""].join("\n"),

  "scripts/build.js": [
    'const fs = require("node:fs");',
    'const { schema } = require("../src/db/schema");',
    "",
    'fs.writeFileSync("schema.json", JSON.stringify(schema));',
    "",
  ].join("\n"),

  "services/api/__init__.py": "",

  "services/api/app.py": [
    "import importlib",
    "",
    "import fastapi",
    "",
    "from . import models",
    "from .routes import router",
    "from ..shared.util import helper",
    "",
    "app = fastapi.FastAPI()",
    "app.include_router(router)",
    "",
    "",
    "def reload_routes():",
    '    return importlib.import_module("services.api.routes")',
    "",
    "",
    "def describe():",
    "    return helper(models.Thing)",
    "",
  ].join("\n"),

  "services/api/routes.py": [
    "import os",
    "",
    "from .models import Thing",
    "",
    "router = [Thing, os.name]",
    "",
  ].join("\n"),

  "services/api/models.py": [
    "import dataclasses",
    "",
    "",
    "@dataclasses.dataclass",
    "class Thing:",
    "    name: str",
    "",
  ].join("\n"),

  "services/shared/__init__.py": "",

  "services/shared/util.py": [
    "import json",
    "",
    "",
    "def helper(value):",
    "    return json.dumps(str(value))",
    "",
  ].join("\n"),

  // Must be skipped by the walker.
  "node_modules/junk/index.js": 'module.exports = require("./other");',
  "dist/bundle.js": 'require("./chunk");',
  ".git/config": "[core]\n",
};

/** Write the fixture into `targetDir` (wiped first). Returns `targetDir`. */
export async function materializeSampleRepo(targetDir: string): Promise<string> {
  await rm(targetDir, { recursive: true, force: true });
  for (const [relative, contents] of Object.entries(SAMPLE_REPO_FILES)) {
    const absolute = path.join(targetDir, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
  return targetDir;
}
