// Wire shapes for the app map (DESIGN.md §6.5) — the Graph tab's "App map"
// view: the whole analyzed codebase drawn the way the PR map draws one diff,
// as cards with labelled edges, at one of three levels of detail. Shared by
// `GET /api/repos/[repoId]/app-map`, the builder in lib/jobs/app-map.ts, the
// AI pass in lib/ai/app-map.ts and the canvas in this directory. Framework-
// and DB-agnostic on purpose, like ./pr-map-types.ts, so a client component
// can import it.

/**
 * How the app is cut into cards:
 *   - `architecture` — one card per layer (UI, Server & API, Logic, …);
 *   - `features`     — one card per capability ("GitLab integration"), which
 *                       usually spans several folders and layers;
 *   - `modules`      — one card per analyzed module (the Repo graph's nodes).
 */
export type AppMapLevel = "architecture" | "features" | "modules";

export const APP_MAP_LEVELS: ReadonlyArray<{ value: AppMapLevel; label: string; title: string }> = [
  { value: "architecture", label: "Architecture", title: "The app's layers — UI, server, logic, data, integrations, infrastructure" },
  { value: "features", label: "Features", title: "What the app does — each card is one capability, across every folder that implements it" },
  { value: "modules", label: "Modules", title: "Every analyzed module, the same boxes as the Repo graph" },
];

export function isAppMapLevel(value: unknown): value is AppMapLevel {
  return value === "architecture" || value === "features" || value === "modules";
}

/** The fixed layer palette the architecture level sorts every file into. */
export type AppLayerId = "ui" | "server" | "logic" | "data" | "integrations" | "infrastructure" | "tests";

export interface AppLayerInfo {
  name: string;
  /** What the layer means in general — the card's fallback description and the AI prompt's definition. */
  blurb: string;
  /** Accent colour (card stripe, layer bars). Literal, not a token: it is used in inline styles on both themes. */
  color: string;
}

/** Order is the architecture level's reading order, front to back. */
export const APP_LAYERS: Record<AppLayerId, AppLayerInfo> = {
  ui: { name: "UI", blurb: "Pages, components and client hooks — what the user sees and clicks", color: "#6d72f0" },
  server: { name: "Server & API", blurb: "Route handlers, server actions and entry points that receive requests", color: "#0ea5a4" },
  logic: { name: "Logic", blurb: "Domain rules, jobs, algorithms and orchestration — the app's own behaviour", color: "#d97706" },
  data: { name: "Data & storage", blurb: "Database access, schemas, queries and persisted state", color: "#16a34a" },
  integrations: { name: "Integrations", blurb: "Clients for outside services and APIs the app talks to", color: "#db2777" },
  infrastructure: { name: "Infrastructure", blurb: "Processes, queues, build, deployment and runtime configuration", color: "#64748b" },
  tests: { name: "Tests & tooling", blurb: "Tests, fixtures and smoke scripts", color: "#8b5cf6" },
};

export const APP_LAYER_ORDER: AppLayerId[] = ["ui", "server", "logic", "data", "integrations", "infrastructure", "tests"];

export function isAppLayerId(value: unknown): value is AppLayerId {
  return typeof value === "string" && value in APP_LAYERS;
}

export interface AppMapKeyFileDTO {
  path: string;
  /** What the file does within its card, one line. */
  role: string;
}

/** A module contributing files to a card. */
export interface AppMapModuleDTO {
  id: string;
  name: string;
  /** Files of this module that are on this card. */
  files: number;
}

export interface AppMapNodeDTO {
  /** Stable within one level: `layer:<id>`, `feat:<key>`, `mod:<componentId>`. */
  id: string;
  name: string;
  /** One line. */
  description?: string;
  /** A few sentences on what the card does and how — from the AI pass; absent on a heuristic map. */
  explanation?: string;
  /** The files most worth opening first, with their role. */
  keyFiles: AppMapKeyFileDTO[];
  /** Architecture cards: the layer itself. Other levels: the layer most of the card's files are in. */
  layer: AppLayerId;
  /** Which layers the card's files sit in, most files first. */
  layers: Array<{ layer: AppLayerId; files: number }>;
  /** Every file on the card, sorted. */
  files: string[];
  /** Each file's layer — only present when the card spans more than one layer. */
  fileLayers?: Record<string, AppLayerId>;
  /** Modules contributing files, most files first — what selecting the card selects on the Repo view. */
  modules: AppMapModuleDTO[];
}

export interface AppMapEdgeDTO {
  source: string;
  target: string;
  /** A short verb: `uses` from the heuristic map, or what the AI pass chose. */
  label: string;
  /** How many file-level imports the edge stands for. */
  weight: number;
  /** One sentence on what flows along the edge — AI only. */
  explanation?: string;
  /** Up to three of the file-level imports behind the edge. */
  samples: Array<{ from: string; to: string }>;
}

/** Response shape for `GET /api/repos/[repoId]/app-map?level=…`. */
export interface AppMapResponseDTO {
  level: AppMapLevel;
  nodes: AppMapNodeDTO[];
  edges: AppMapEdgeDTO[];
  /** `ai` once an app-map run has grouped/explained this level; `heuristic` otherwise. */
  source: "heuristic" | "ai";
  model?: string;
  generatedAt?: string;
  /** Files placed by the heuristic because they appeared after the AI run grouped this level. */
  newFiles?: number;
  totalFiles: number;
  /** File path → owning module id, so a file chip can open its module. */
  fileOwners: Record<string, string>;
}

// ---------------------------------------------------------------------------
// The AI run (`/api/repos/[repoId]/app-map/job`)
// ---------------------------------------------------------------------------

export type AppMapJobStateDTO = "none" | "queued" | "running" | "completed" | "failed" | "cancelled";

export type AppMapPhaseDTO = "grouping" | "explaining" | "saving";

export interface AppMapProgressDTO {
  level: AppMapLevel;
  phase: AppMapPhaseDTO;
  /** Cards explained so far (`explaining`), else 0. */
  done: number;
  total: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface AppMapJobStatusDTO {
  state: AppMapJobStateDTO;
  /** The level the current (or last) run is/was for. */
  level?: AppMapLevel;
  progress?: AppMapProgressDTO;
  error?: string;
  finishedAt?: string;
  aiConfigured: boolean;
  /** Levels that have a stored AI map, with when and by which model. */
  generated: Partial<Record<AppMapLevel, { generatedAt: string; model: string }>>;
}

export function isAppMapJobPending(state: AppMapJobStateDTO): boolean {
  return state === "queued" || state === "running";
}
