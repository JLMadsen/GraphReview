// The command palette's search request and results (DESIGN.md §6.18).
// Shared by `POST /api/search` and the palette.

export type SearchKind =
  | "file"
  | "symbol"
  | "component"
  | "pr"
  | "branch"
  | "commit"
  | "finding"
  | "endpoint"
  | "table"
  | "env"
  | "infra"
  | "repo";

/** `all` is the unprefixed search; the rest are a prefix or a chip. */
export type SearchScope = "all" | "files" | "symbols" | "refs" | "findings" | "findings-all" | "endpoints" | "repos";

export type SearchTone = "defect" | "concern" | "unknown" | "ok" | "changed" | "open" | "merged" | "closed" | "draft" | "muted";

export interface SearchItem {
  /** `<kind>:<id>` — the history key. */
  key: string;
  kind: SearchKind;
  id: string;
  title: string;
  subtitle?: string;
  badge?: { text: string; tone: SearchTone };
  /** The open change touches it. */
  touched?: boolean;
  score: number;
  /** Indexes into `title` that matched the query. */
  match?: number[];
  /** A file, symbol, finding or catalog item: where it lives. */
  path?: string;
  line?: number;
  /** A file's, symbol's or finding's component; a component's own id. */
  componentId?: string;
  /** A symbol: `<file>#<qualified>`, the call graph's function id. */
  declId?: string;
  prNumber?: number;
  url?: string;
  /** A branch's name; a commit's sha. */
  ref?: string;
  parent?: string;
  /** A finding: whether a `fixing` reply is on it already. */
  fixing?: boolean;
  repoId?: string;
}

export interface SearchRequest {
  /** Absent outside a repo: only repos are searched. */
  repoId?: string;
  q: string;
  scope: SearchScope;
  /** The Graph tab's open review target, `pr:<n>` or `refs:<base>...<head>`. */
  targetKey?: string;
  /** The open change's paths — ranked first, and searched even when the analysed tip doesn't have them. */
  touched?: string[];
}

export interface SearchNotice {
  id: string;
  text: string;
  action?: "analyse-head" | "reanalyse" | "refresh-remote";
}

/** The repo searched, for the palette's targets (links, the default branch). */
export interface SearchRepoInfo {
  id: string;
  name: string;
  provider: "local" | "github" | "gitlab" | "git";
  url?: string;
  defaultBranch: string;
}

export interface SearchResponse {
  repo?: SearchRepoInfo;
  items: SearchItem[];
  notices: SearchNotice[];
  /** Empty unscoped query: the last picks in this repo. */
  recents?: SearchItem[];
}

export const SCOPE_PREFIXES: ReadonlyArray<{ prefix: string; scope: SearchScope | "commands"; label: string }> = [
  { prefix: ">", scope: "commands", label: "Commands" },
  { prefix: "/", scope: "files", label: "Files" },
  { prefix: "@", scope: "symbols", label: "Symbols" },
  { prefix: "#", scope: "refs", label: "PRs, branches, commits" },
  { prefix: "!", scope: "findings", label: "Findings" },
  { prefix: ":", scope: "endpoints", label: "Endpoints" },
];
