// Fallback sample dataset shown when `GET /api/repos/[repoId]/graph`
// can't be reached (no live Neo4j — see this directory's usage in
// GraphView.tsx) or returns an empty graph (a repo that hasn't been
// analyzed yet). Doubles as the "does the Cytoscape wrapper actually
// render" fixture used to visually verify this component during
// development, per the task's verification instructions.
//
// Flat, module-tier only, no `parentId` — mirrors what v1 realistically
// produces before the domain tier is populated (DESIGN.md §6.1/§16).

import type { GraphEdgeDTO, GraphNodeDTO } from "./types";

export const SAMPLE_NODES: GraphNodeDTO[] = [
  { id: "auth", name: "Auth", tier: "module", fileCount: 17, description: "Login, session, and token handling." },
  { id: "db", name: "DB layer", tier: "module", fileCount: 24, description: "Neo4j driver singleton and repository functions." },
  { id: "ui", name: "UI primitives", tier: "module", fileCount: 31, description: "shadcn/ui-based design system components." },
  { id: "api", name: "API routes", tier: "module", fileCount: 12, description: "Next.js route handlers." },
  { id: "jobs", name: "Worker jobs", tier: "module", fileCount: 9, description: "BullMQ queue/job definitions and processors." },
  { id: "settings", name: "Settings", tier: "module", fileCount: 5, description: "Global settings form and server action." },
  { id: "analysis", name: "Static analysis", tier: "module", fileCount: 14, description: "tree-sitter language analyzers and graph builder." },
];

export const SAMPLE_EDGES: GraphEdgeDTO[] = [
  { source: "api", target: "auth", weight: 6 },
  { source: "api", target: "db", weight: 11 },
  { source: "auth", target: "db", weight: 4 },
  { source: "jobs", target: "db", weight: 8 },
  { source: "jobs", target: "analysis", weight: 5 },
  { source: "settings", target: "db", weight: 2 },
  { source: "ui", target: "api", weight: 3 },
  { source: "analysis", target: "db", weight: 7 },
];
