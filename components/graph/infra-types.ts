// Wire shapes for the Infra view (DESIGN.md §6.12):
//   GET /api/repos/[repoId]/infra-catalog   the analysed commit's infrastructure
// The PR's infra change rides on the target graph (target-graph-types.ts).
// Type-only imports: nothing server-side reaches the client bundle.

import type {
  InfraAction,
  InfraAttr,
  InfraAttrDelta,
  InfraCatalog,
  InfraCategory,
  InfraChange,
  InfraChangeEntry,
  InfraDeployLink,
  InfraEnvLink,
  InfraFinding,
  InfraLinkDelta,
  InfraPortLink,
  InfraResource,
  InfraRouteLink,
  InfraStack,
  InfraTool,
} from "@/lib/analysis/infra/types";

export type {
  InfraAction,
  InfraAttr,
  InfraAttrDelta,
  InfraCatalog,
  InfraCategory,
  InfraChange,
  InfraChangeEntry,
  InfraDeployLink,
  InfraEnvLink,
  InfraFinding,
  InfraLinkDelta,
  InfraPortLink,
  InfraResource,
  InfraRouteLink,
  InfraStack,
  InfraTool,
};

export interface InfraCatalogResponseDTO extends InfraCatalog {
  /** `none`: the repo hasn't been analysed by a version that builds the catalog yet. */
  state: "ready" | "none";
  sha?: string;
  computedAt?: string;
}
