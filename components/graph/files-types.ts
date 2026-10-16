// Shape of `GET /api/repos/[repoId]/tree` — the Files view's tree. Mirrors
// lib/jobs/repo-tree.ts.

export interface RepoTreeEntryDTO {
  path: string;
  /** Bytes; absent for submodules. */
  size?: number;
  kind: "file" | "symlink" | "submodule";
}

export interface RepoTreeResponseDTO {
  sha: string;
  commit: { subject: string; author: string; date: string } | null;
  entries: RepoTreeEntryDTO[];
  /** The listing was cut off at its cap. */
  truncated: boolean;
}

export interface LastCommitDTO {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

/** Shape of `GET /api/repos/[repoId]/last-commits`: entry name → its newest commit (`null`: not found in time). */
export interface LastCommitsResponseDTO {
  commits: Record<string, LastCommitDTO | null>;
}
