// Folder-name heuristics the App map uses to tell feature folders from layer
// folders (DESIGN.md §6.5): `app/map` and `components/maps` both name the
// feature "map"; `components`, `lib` and `utils` name none.

/**
 * Path segments that name a layer, not a feature. Next.js route groups
 * `(group)` and dynamic segments `[id]` are stripped too.
 */
export const LAYER_SEGMENTS = new Set([
  "app", "src", "source", "components", "component", "lib", "libs", "api", "pages", "page",
  "hooks", "services", "service", "routes", "route", "server", "client", "features", "feature",
  "modules", "module", "ui", "views", "view", "screens", "screen", "controllers", "controller",
  "models", "model", "store", "stores", "handlers", "handler", "main", "java", "kotlin", "go",
  "internal", "pkg", "cmd", "web", "frontend", "backend", "actions", "action", "contexts",
  "context", "providers", "provider", "types", "workers", "worker",
]);

/** Feature names too generic to mean "the same feature" when two folders share them. */
export const GENERIC_KEYS = new Set([
  "util", "utils", "helper", "common", "shared", "type", "constant", "config", "style", "asset",
  "test", "__tests__", "__test__", "__fixtures__", "__mocks__", "fixture", "mock", "doc", "script",
  "public", "static", "vendor", "generated", "core", "index", "base", "misc", "tmp", "example",
]);

/** A path segment as a feature word: lower case, no separators, a plain plural made singular. */
export function normaliseSegment(segment: string): string {
  let s = segment.toLowerCase().replace(/[-_\s.]/g, "");
  if (s.length > 3 && s.endsWith("s") && !/(ss|is|us)$/.test(s)) s = s.slice(0, -1);
  return s;
}
