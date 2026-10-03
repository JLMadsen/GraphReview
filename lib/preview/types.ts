// Shared shapes for the before/after preview (DESIGN.md §6.9): what the
// sandbox harnesses print, what the preview job returns, and what the Graph
// tab renders. Type-only, so client components may import it.

/** Which harness/image runs a file. */
export type PreviewRuntime = "node" | "python";

/** `component`: rendered to HTML. `function`: called, return value + arguments compared. */
export type PreviewSymbolKind = "component" | "function";

/** How the symbol changed between base and head. */
export type PreviewChange = "modified" | "added" | "removed";

export type PreviewSide = "before" | "after";

/** One mocked input. Functions use `args` (and `kwargs` in Python); components use `props`. */
export interface PreviewInput {
  args?: unknown[];
  kwargs?: Record<string, unknown>;
  props?: Record<string, unknown>;
}

export interface PreviewCaseInput {
  label: string;
  input: PreviewInput;
}

/** Mocked inputs per symbol name — what the AI produces and what the user can edit and re-run. */
export type PreviewInputs = Record<string, PreviewCaseInput[]>;

/** A changed top-level declaration found in the file. */
export interface PreviewSymbol {
  name: string;
  kind: PreviewSymbolKind;
  change: PreviewChange;
  /** 1-based line in the head file (base file for removed symbols). */
  line: number;
  /** Its own code is unchanged, but it uses this changed declaration of the same file. */
  via?: string;
}

/** One case on one side, as printed by a harness. */
export interface PreviewCaseOutcome {
  label: string;
  /** Function: `repr`/`inspect` of the return value. */
  returned?: string;
  /** Function: the arguments as passed in, in the same format as `argsAfter`. */
  argsBefore?: string;
  /** Function: the arguments after the call — differs from `argsBefore` when the call mutated them. */
  argsAfter?: string;
  /** Component: server-rendered markup. */
  html?: string;
  threw?: string;
  durationMs?: number;
  logs?: string[];
}

export interface PreviewHarnessSymbol {
  name: string;
  kind: PreviewSymbolKind;
  error?: string;
  cases?: PreviewCaseOutcome[];
}

/** The JSON a harness prints after its result marker. */
export interface PreviewHarnessResult {
  side: PreviewSide;
  symbols: PreviewHarnessSymbol[];
  stubbedModules?: string[];
  warnings?: string[];
  css?: string;
  cssNote?: string;
  /** The module couldn't even be loaded. */
  fatal?: string;
  /** Server actions and fetch requests the code made, mocked or not. */
  serverCalls?: PreviewServerCall[];
}

/**
 * A call to the server the code made while rendering: a Next.js server
 * action (replaced by a stub in client code) or a fetch request. Neither can
 * reach a server in the sandbox, so they're answered from mocks.
 */
export interface PreviewServerCall {
  /** `action <file>#<name>` or `fetch <METHOD> <path>` — also the key in {@link PreviewMocks}. */
  key: string;
  kind: "action" | "fetch";
  count: number;
  /** Answered from a mock this run. */
  mocked: boolean;
  module?: string;
  name?: string;
  args?: string;
  method?: string;
  url?: string;
  body?: string;
}

/** Mocked server responses by call key: what each action returns / each request's JSON body. */
export type PreviewMocks = Record<string, unknown>;

/** What happened to one side as a whole. */
export interface PreviewSideSummary {
  sha: string;
  /** The file doesn't exist on this side (added or removed file). */
  missing?: boolean;
  fatal?: string;
  stubbedModules: string[];
  warnings: string[];
  /** Component previews only: the stylesheet both the bundle and the app's global CSS produced. */
  css?: string;
  cssNote?: string;
  /** Dependency install state, e.g. "cached", "installed", "none", "failed: …". */
  deps: string;
}

export interface PreviewCaseResult {
  label: string;
  input: PreviewInput;
  before?: PreviewCaseOutcome;
  after?: PreviewCaseOutcome;
  /** Before and after disagree on anything shown (return, arguments, markup, error). */
  differs: boolean;
}

export interface PreviewSymbolResult extends PreviewSymbol {
  cases: PreviewCaseResult[];
  beforeError?: string;
  afterError?: string;
}

/** The preview job's result. */
export interface PreviewResult {
  filePath: string;
  runtime: PreviewRuntime;
  baseSha: string;
  headSha: string;
  symbols: PreviewSymbolResult[];
  /** Changed declarations that weren't run, with why (not exported, a type, a class…). */
  skipped: Array<{ name: string; reason: string }>;
  before: PreviewSideSummary;
  after: PreviewSideSummary;
  /** Where the inputs came from. */
  inputsSource: "ai" | "default" | "user";
  inputs: PreviewInputs;
  /** Set when AI input generation failed and defaults were used instead. */
  inputsNote?: string;
  /** Server responses the renders were given (record → mock → replay). */
  mocks: PreviewMocks;
  mocksSource: "ai" | "user" | "none";
  /** Why some server calls went unanswered, when they did. */
  mocksNote?: string;
  /** Server calls the code made in the final run, both sides together. */
  serverCalls: PreviewServerCall[];
  durationMs: number;
}

export type PreviewStage = "resolving" | "inputs" | "preparing" | "running";

export interface PreviewProgress {
  stage: PreviewStage;
  message: string;
}

export type PreviewJobState = "none" | "queued" | "running" | "completed" | "failed";

/** `GET /api/repos/[repoId]/preview` */
/** Whether previews can run on this machine (they need Docker), and if not, why. */
export interface PreviewSandboxDTO {
  available: boolean;
  reason?: string;
}

export interface PreviewStatusDTO {
  state: PreviewJobState;
  progress?: PreviewProgress;
  result?: PreviewResult;
  error?: string;
  logs?: string[];
  sandbox?: PreviewSandboxDTO;
}

// ---------------------------------------------------------------------------
// Scan: which changed files hold changed components (on target load, no Docker)
// ---------------------------------------------------------------------------

export interface PreviewScanComponent {
  name: string;
  change: PreviewChange;
  line: number;
  via?: string;
}

/** What the scan job returns: changed components per file. Plain functions are left out on purpose. */
export interface PreviewScanResult {
  baseSha: string;
  headSha: string;
  files: Array<{ filePath: string; components: PreviewScanComponent[] }>;
}

/** One file of the scan joined with its preview run, for the Graph tab's "Looks different" section. */
export interface PreviewScanFileDTO {
  filePath: string;
  components: Array<
    PreviewScanComponent & {
      /** From the file's last finished preview run: whether any case renders differently. Absent when not run. */
      looks?: "different" | "same" | "failed";
    }
  >;
  /** The file's preview job, if one exists. */
  preview: PreviewJobState;
}

/** `GET /api/repos/[repoId]/preview/scan` */
export interface PreviewScanDTO {
  state: PreviewJobState;
  files: PreviewScanFileDTO[];
  error?: string;
  sandbox?: PreviewSandboxDTO;
}
