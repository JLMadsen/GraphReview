// GET /api/repos/[repoId]/components/[componentId]/files
//
// The sibling `graph` route only reports a component's file *count* (it's
// what sizes the nodes); this route answers "which files, exactly", for the
// Graph tab's selected-component panel (clicking a node in
// `components/graph/GraphCanvas.tsx`).
//
// Unlike `graph/route.ts` and `diff-impact/route.ts`, no raw `runRead` is
// needed here: `lib/neo4j/file.ts` already exposes exactly this query as
// `listFilesByComponentId` (ordered by `f.path ASC`), so this route is a
// thin repository call plus a repo-scoping check.
//
// One special case: a **domain-tier** component (created by the AI
// labeling job) owns no files of its own — `BELONGS_TO` only ever points at
// a module. Clicking a domain box in the graph must still show something, so
// for a domain this returns the union of its child modules' files, merged
// and re-sorted by path.

import { NextResponse } from "next/server";
import {
  getComponentById,
  listChildComponents,
  listFilesByComponentId,
} from "@/lib/neo4j";
import type { FileRecord } from "@/lib/neo4j";
import { apiError, errorMessage } from "@/app/api/repos/_shared";
import type { ComponentFilesResponseDTO } from "@/components/graph/types";

export const dynamic = "force-dynamic";

/**
 * Every file under a domain, via its child modules' `BELONGS_TO` edges.
 *
 * One query per child rather than a single cross-tier `runRead`: a domain
 * has at most a handful of modules (lib/ai/label.ts caps the tier at 8
 * domains over the repo's modules), and reusing the existing repository
 * function keeps this route free of raw Cypher. Results are de-duplicated by
 * id — a file belongs to exactly one module today, but nothing in the schema
 * forbids a second `BELONGS_TO`, and a duplicated row would show up as a
 * repeated line in the panel.
 */
async function listDomainFiles(domainId: string): Promise<FileRecord[]> {
  const children = await listChildComponents(domainId);
  const byId = new Map<string, FileRecord>();
  for (const child of children) {
    for (const file of await listFilesByComponentId(child.id)) {
      byId.set(file.id, file);
    }
  }
  return [...byId.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ repoId: string; componentId: string }> }
) {
  const { repoId, componentId } = await params;

  try {
    // Component ids are globally unique, so the lookup doesn't need the
    // repo — but scoping the response to the repo in the URL keeps the
    // route from being a cross-repo read of anything a caller can guess.
    const component = await getComponentById(componentId);
    if (!component || component.repoId !== repoId) {
      return apiError(
        `No component with id "${componentId}" in repo "${repoId}".`,
        404
      );
    }

    const files =
      component.tier === "domain"
        ? await listDomainFiles(componentId)
        : await listFilesByComponentId(componentId);

    const body: ComponentFilesResponseDTO = {
      componentId: component.id,
      componentName: component.name,
      files: files.map((f) => ({
        id: f.id,
        path: f.path,
        language: f.language,
        loc: Number.isFinite(f.loc) ? f.loc : 0,
      })),
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error(
      `GET /api/repos/${repoId}/components/${componentId}/files failed:`,
      err
    );
    return apiError(errorMessage(err) || "Failed to load component files.", 500);
  }
}
