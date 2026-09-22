// Error handling for lib/gitlab. Mirrors lib/github/errors.ts's shape so
// callers that already branch on a GitHubApiError's `status`/`endpoint` can
// treat a GitLabApiError the same way — but wraps `fetch` Response failures
// instead of Octokit's RequestError/GraphqlResponseError.

/**
 * Thrown for any failure while talking to the GitLab REST API — network
 * errors and non-2xx responses. Wraps the original error as `cause` so
 * nothing is lost, while giving callers a stable shape to branch on.
 */
export class GitLabApiError extends Error {
  override readonly name = "GitLabApiError";

  /** HTTP status code when known. `0` when the failure never reached an HTTP response (e.g. a network error). */
  readonly status: number;

  /** A short human-readable label for the call that failed, e.g. `"GET /projects/{id}/merge_requests/{iid}"`. */
  readonly endpoint: string;

  constructor(message: string, options: { status: number; endpoint: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.status = options.status;
    this.endpoint = options.endpoint;
  }
}

/**
 * Builds a {@link GitLabApiError} from a non-OK `fetch` Response. GitLab
 * error bodies are usually `{"message": ...}` (sometimes a nested object or
 * array for validation errors) — read as text and fall back to the raw body
 * when it isn't the expected shape, rather than throwing a second error
 * while trying to report the first.
 */
export async function toGitLabApiError(response: Response, endpoint: string): Promise<GitLabApiError> {
  const bodyText = await response.text().catch(() => "");
  let detail = bodyText;
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText) as { message?: unknown; error?: unknown };
      const message = parsed.message ?? parsed.error;
      if (typeof message === "string") {
        detail = message;
      } else if (message !== undefined) {
        detail = JSON.stringify(message);
      }
    } catch {
      // Not JSON — use the raw body text as-is.
    }
  }

  return new GitLabApiError(
    `GitLab API request failed (${endpoint}): ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`,
    { status: response.status, endpoint }
  );
}

/** Normalizes a network/programmer error (thrown before a response was ever received) into a {@link GitLabApiError}. */
export function toGitLabNetworkError(err: unknown, endpoint: string): GitLabApiError {
  if (err instanceof GitLabApiError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new GitLabApiError(`GitLab API call failed (${endpoint}): ${message}`, {
    status: 0,
    endpoint,
    cause: err,
  });
}
