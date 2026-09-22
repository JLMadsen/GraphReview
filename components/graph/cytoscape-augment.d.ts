// Augments @types/cytoscape's `Core` interface with the instance method
// `cytoscape-expand-collapse` attaches at runtime (the plugin ships no
// types of its own — see cytoscape-shims.d.ts, which shims its module
// specifier instead). Split into its own file because augmenting an
// *existing* typed module requires this file to be a module itself (hence
// the `export {}` below), which is the opposite requirement from the
// bodiless shorthand declarations in cytoscape-shims.d.ts.
//
// Option/return shapes are kept intentionally loose (`Record<string,
// unknown>` / `unknown`) — this repo only calls a handful of documented
// methods (see components/graph/GraphCanvas.tsx) and a full re-typing of
// the plugin's surface isn't worth maintaining here.

import type { CollectionArgument, NodeSingular } from "cytoscape";

export {};

declare module "cytoscape" {
  interface Core {
    expandCollapse(options?: Record<string, unknown>): {
      collapseAll(): void;
      expandAll(): void;
      collapse(eles: CollectionArgument): void;
      expand(eles: CollectionArgument): void;
      isCollapsible(node: NodeSingular): boolean;
      isExpandable(node: NodeSingular): boolean;
    };
  }
}
