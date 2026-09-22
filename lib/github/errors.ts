// Error handling for lib/github. See README.md — this module never swallows
// API errors; it wraps them with enough context (HTTP status + the logical
// endpoint that was being called) for a caller to show something sensible.

/**
 * Thrown for any failure while talking to the GitHub REST or GraphQL API —
 * network errors, non-2xx REST responses, and GraphQL responses that carry
 * an `errors` array. Wraps the original Octokit error as `cause` so nothing
 * is lost, while giving callers a stable shape to branch on.
 */
export class GitHubApiError extends Error {
  override readonly name = "GitHubApiError";

  /**
   * HTTP status code when known (e.g. 404, 403, 401). `0` when the failure
   * never reached an HTTP response (e.g. a network error) and GraphQL
   * errors, which aren't carried as a distinct HTTP status by
   * `@octokit/graphql`.
   */
  readonly status: number;

  /** A short human-readable label for the call that failed, e.g. `"GET /repos/{owner}/{repo}/pulls/{pull_number}"` or `"GraphQL getLinkedIssues"`. */
  readonly endpoint: string;

  constructor(message: string, options: { status: number; endpoint: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.status = options.status;
    this.endpoint = options.endpoint;
  }
}

/**
 * Normalizes any error thrown by Octokit (REST `RequestError`, GraphQL
 * `GraphqlResponseError`, or a plain network/programmer error) into a
 * {@link GitHubApiError} tagged with the endpoint that was being called.
 */
export function toGitHubApiError(err: unknown, endpoint: string): GitHubApiError {
  if (err instanceof GitHubApiError) {
    return err;
  }

  // Structural checks (rather than `instanceof`) so this keeps working even
  // if a caller's Octokit dependency graph ends up with a duplicate copy of
  // @octokit/request-error or @octokit/graphql in node_modules.
  if (isRequestErrorLike(err)) {
    return new GitHubApiError(`GitHub API request failed (${endpoint}): ${err.message}`, {
      status: err.status,
      endpoint,
      cause: err,
    });
  }

  if (isGraphqlErrorLike(err)) {
    const firstMessage = err.errors?.[0]?.message ?? err.message;
    return new GitHubApiError(`GitHub GraphQL request failed (${endpoint}): ${firstMessage}`, {
      status: 0,
      endpoint,
      cause: err,
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  return new GitHubApiError(`GitHub API call failed (${endpoint}): ${message}`, {
    status: 0,
    endpoint,
    cause: err,
  });
}

function isRequestErrorLike(err: unknown): err is { message: string; status: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number" &&
    "message" in err
  );
}

function isGraphqlErrorLike(
  err: unknown
): err is { message: string; errors?: Array<{ message: string }> } {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "GraphqlResponseError"
  );
}
