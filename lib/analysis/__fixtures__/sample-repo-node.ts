/**
 * A small npm/pnpm-style TypeScript monorepo used to exercise the hardened JS/TS
 * resolver end to end (see `smoke-test-node.ts`): a `tsconfig.json` `extends`
 * chain with `paths` resolved relative to the declaring config (or its inherited
 * `baseUrl`), the *nearest* config picked per importing file, `pnpm-workspace.yaml`
 * workspace packages resolved via `exports` (root + subpath) and `main`, a
 * conventional (no-`exports`) subpath fallback, `package.json` `"imports"`
 * (`#foo/*`, both repo-root and per-package), and a barrel re-export.
 *
 * Layout:
 *   tsconfig.base.json         baseUrl "." + `@shared/*`
 *   tsconfig.json               extends the base, adds `@root/*`
 *   pnpm-workspace.yaml          `packages/*`
 *   package.json                 repo-root `"imports"`: `#env/*`
 *   config/dev.ts                 target of `#env/dev`
 *   tools/build.ts                 no config of its own: uses the root config + root `imports`
 *   packages/shared/               no `exports` (main-only); its OWN, non-extending tsconfig
 *   packages/utils/                `exports` with a root (".") and a subpath ("./helpers")
 *   packages/app/                   extends the root base (inherits `@shared/*`, resolved against
 *                                   the ROOT since that's where it was declared) but sets its own
 *                                   `baseUrl` for its own `@app/*`; its own `"imports"` (`#config`)
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const NODE_FILES: Record<string, string> = {
  "package.json": json({
    name: "monorepo-root",
    private: true,
    imports: { "#env/*": "./config/*.ts" },
  }),
  "pnpm-workspace.yaml": lines("packages:", "  - 'packages/*'"),
  "tsconfig.base.json": json({
    compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["packages/shared/src/*"] } },
  }),
  "tsconfig.json": json({
    extends: "./tsconfig.base.json",
    compilerOptions: { paths: { "@root/*": ["./*"] } },
  }),

  "config/dev.ts": lines("export const isDev = true"),
  "tools/build.ts": lines(
    'import { isDev } from "#env/dev"',
    'import utilsIndex from "@root/packages/utils/src/index"',
    'import shared from "@acme/shared"',
    "",
    "console.log(isDev, utilsIndex, shared)",
  ),

  // --- packages/shared: main-only (no `exports`), its own standalone tsconfig
  //     (no `extends`, no `baseUrl` -> paths resolve relative to its own dir). ---
  "packages/shared/package.json": json({ name: "@acme/shared", main: "./src/index.ts" }),
  "packages/shared/tsconfig.json": json({
    compilerOptions: { paths: { "@shared-alt/*": ["./src/*"] } },
  }),
  "packages/shared/src/index.ts": lines('export * from "./thing"'),
  "packages/shared/src/thing.ts": lines(
    'import { alt } from "@shared-alt/alt"',
    "",
    "export const thing = alt + 1",
  ),
  "packages/shared/src/alt.ts": lines("export const alt = 1"),

  // --- packages/utils: `exports` with a root entry and one named subpath. ---
  "packages/utils/package.json": json({
    name: "@acme/utils",
    exports: { ".": "./src/index.ts", "./helpers": "./src/helpers.ts" },
  }),
  "packages/utils/src/index.ts": lines("export const root = 1"),
  "packages/utils/src/helpers.ts": lines("export const helper = 1"),

  // --- packages/app: extends the root base (inherits `@shared/*`), adds its own
  //     `@app/*`, and its own package-private `#config` import. ---
  "packages/app/package.json": json({
    name: "@acme/app",
    imports: { "#config": "./src/config.ts" },
  }),
  // Its own `baseUrl` (the realistic monorepo pattern): overrides the inherited
  // root `baseUrl` for its OWN `paths` only - the inherited `@shared/*` keeps
  // resolving against the root, where it was declared.
  "packages/app/tsconfig.json": json({
    extends: "../../tsconfig.base.json",
    compilerOptions: { baseUrl: ".", paths: { "@app/*": ["./src/*"] } },
  }),
  "packages/app/src/index.ts": lines(
    'import { helper } from "@acme/utils/helpers"',
    'import { root } from "@acme/utils"',
    'import config from "#config"',
    'import { thing } from "@shared/thing"',
    'import { thing as t2 } from "@acme/shared/src/thing"',
    'import { local } from "@app/localthing"',
    "",
    "export { helper, root, config, thing, t2, local }",
  ),
  "packages/app/src/config.ts": lines("export default { env: \"test\" }"),
  "packages/app/src/localthing.ts": lines("export const local = 1"),
};

export const SAMPLE_NODE_REPO_FILES: Record<string, string> = { ...NODE_FILES };

/** Write {@link SAMPLE_NODE_REPO_FILES} under `rootDir` (created fresh). */
export async function materializeSampleNodeRepo(rootDir: string): Promise<void> {
  await rm(rootDir, { recursive: true, force: true });
  for (const [relative, contents] of Object.entries(SAMPLE_NODE_REPO_FILES)) {
    const absolute = path.join(rootDir, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
}
