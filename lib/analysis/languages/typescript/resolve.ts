/**
 * JS/TS import-specifier resolution.
 *
 * Deliberately *not* a full Node/TS module resolver: it resolves relative
 * specifiers, `tsconfig.json`/`jsconfig.json` `paths`/`baseUrl` (including
 * `extends` chains, nearest-config-per-file), and local workspace packages
 * (npm/yarn `workspaces`, pnpm-workspace.yaml, `package.json` `"imports"`)
 * against the set of files actually present in the repo. No `node_modules`
 * traversal for anything outside the repo — those describe dependencies outside
 * it, which the graph models as external packages anyway.
 *
 * Resolution order for a bare specifier: `#subpath` imports (Node's
 * package-private `"imports"` map) -> the nearest tsconfig/jsconfig `paths`
 * alias -> that config's `baseUrl` -> a workspace package name/subpath.
 */
import type { AnalyzerContext } from "../../analyzer";
import { dirOf, joinPosix } from "../../paths";
import { cleanSpecifier, isRelative, probe } from "./probe";
import { hasMatchingAlias, matchAlias, nearestTsConfig, prepareTsConfig, resolveViaTsConfig } from "./tsconfig";
import {
  isPackageImportsSpecifier,
  isWorkspacePackageSpecifier,
  prepareWorkspaces,
  resolvePackageImportsSpecifier,
  resolveWorkspaceImport,
} from "./workspace";

export async function prepareTypeScript(ctx: AnalyzerContext): Promise<void> {
  await prepareTsConfig(ctx);
  await prepareWorkspaces(ctx);
}

/**
 * Resolve a JS/TS specifier to a repo-relative path, or `undefined` when it is
 * external / unresolvable. `prepareTypeScript` must have run first.
 */
export function resolveTypeScriptImport(
  raw: string,
  fromFile: string,
  ctx: AnalyzerContext,
): string | undefined {
  const spec = cleanSpecifier(raw);
  if (spec === "") return undefined;

  if (isRelative(spec)) {
    return probe(joinPosix(dirOf(fromFile), spec), ctx.files);
  }
  if (spec.startsWith("/")) {
    // Root-absolute specifiers only appear in bundler-ish setups; treat them as
    // repo-root relative, which is what those setups mean in practice.
    return probe(joinPosix(spec), ctx.files);
  }
  if (spec.startsWith("#")) {
    return resolvePackageImportsSpecifier(spec, fromFile, ctx);
  }

  const config = nearestTsConfig(fromFile, ctx);
  const viaConfig = resolveViaTsConfig(spec, config, ctx.files);
  if (viaConfig) return viaConfig;
  if (matchAlias(spec, config)) return undefined; // alias claimed it but its target doesn't exist: not a workspace fallback

  return resolveWorkspaceImport(spec, ctx);
}

/**
 * npm package name behind an unresolved specifier, or `undefined` when the
 * specifier is repo-internal (a relative path to a missing file, a path alias
 * or workspace package that did not resolve to a file, or a `#imports` subpath)
 * and therefore not an external dependency.
 */
export function typeScriptExternalPackage(
  raw: string,
  ctx: AnalyzerContext,
): string | undefined {
  const spec = cleanSpecifier(raw);
  if (spec === "" || isRelative(spec) || spec.startsWith("/") || spec.startsWith("#")) return undefined;
  if (isPackageImportsSpecifier(spec, ctx)) return undefined;
  // externalPackageName gets no importing file (per the analyzer interface), so this
  // checks every tsconfig/jsconfig in the repo rather than picking a nearest one.
  if (hasMatchingAlias(spec, ctx)) return undefined;
  if (isWorkspacePackageSpecifier(spec, ctx)) return undefined;

  const segments = spec.split("/");
  if (spec.startsWith("@") && segments.length >= 2) return `${segments[0]}/${segments[1]}`;
  return segments[0];
}
