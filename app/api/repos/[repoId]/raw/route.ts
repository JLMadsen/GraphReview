// GET /api/repos/[repoId]/raw?path=<file>&sha=<commit>
//
// One image of the repo at a commit, as bytes — the Files view's README
// images and image preview. Only image types are served (lib/jobs/repo-tree.ts
// `IMAGE_TYPES`), and under a sandboxing CSP: an SVG opened on its own
// can't run script on the app's origin. The view always passes the tree's
// sha, so a response never changes and is cached.

import { getRepoById } from "@/lib/db";
import { readRepoImage } from "@/lib/jobs/repo-tree";
import { apiError } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;
  const query = new URL(request.url).searchParams;
  const path = query.get("path")?.trim().replace(/^\/+/, "");
  const sha = query.get("sha")?.trim();
  if (!path || !sha) return apiError("Query must include ?path=<file>&sha=<commit>.", 400);
  try {
    const repo = await getRepoById(repoId);
    if (!repo) return apiError("Repo not found.", 404);
    const image = await readRepoImage(repo, sha, path);
    if (!image) return apiError(`"${path}" isn't an image at ${sha.slice(0, 7)}, or is too large.`, 404);
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        "Content-Type": image.type,
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error(`GET /api/repos/${repoId}/raw failed:`, error);
    return apiError(error instanceof Error ? error.message : "Could not read the image.", 500);
  }
}
