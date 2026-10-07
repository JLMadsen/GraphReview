// The one check every git ref from outside goes through.
//
// Refs arrive from query strings, JSON bodies and MCP tool calls (which an
// agent can be talked into by prompt-injected PR text) and end up as `git`
// arguments. One that starts with "-" is parsed as an option —
// `--output=<path>` makes `git diff` write its output to any file on disk —
// so the API/MCP edges reject such refs up front, and the git calls in
// ./local-git.ts and ./source.ts check again and end option parsing with
// `--end-of-options` before the ref.

/** True when `ref` can be handed to git as a revision: non-empty, no leading "-", no whitespace or control characters. */
export function isSafeGitRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith("-") && !/[\s\p{Cc}]/u.test(ref);
}

/** Throws unless {@link isSafeGitRef} holds. */
export function assertSafeGitRef(ref: string): void {
  if (!isSafeGitRef(ref)) throw new Error(`"${ref}" is not a valid git ref.`);
}
