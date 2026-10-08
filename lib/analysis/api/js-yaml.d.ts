// js-yaml ships no types and @types/js-yaml isn't a dependency; this is the
// one function lib/analysis/api/spec.ts uses.
declare module "js-yaml" {
  export function load(text: string, options?: { json?: boolean; filename?: string }): unknown;
}
