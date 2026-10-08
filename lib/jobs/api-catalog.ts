// The endpoint catalog as the app serves it (DESIGN.md §6.11): the stored
// catalog of the repo's analysed commit, with shapes a model inferred for
// untyped handlers (✦) filled in where the code said nothing — and the
// inference itself, run on demand for one endpoint.

import type { ApiCatalog, Endpoint } from "@/lib/analysis/api/types";
import { inferApiShape } from "@/lib/ai/api-shape";
import { readApiCatalog, readInferredApiShape, writeInferredApiShape, type InferredApiShape, type RepoRecord } from "@/lib/db";
import { loadAiConfigOrNull } from "./merge-naming";
import { readFileAtCommit } from "./pr-context";

/** Fills an endpoint's unknown shapes from an inference, marked `ai`. */
export function withInferred(e: Endpoint, inferred: InferredApiShape | undefined): Endpoint & { summary?: string; inferred?: boolean } {
  if (!inferred) return e;
  const params = [...e.params];
  for (const p of inferred.params ?? []) if (!params.some((x) => x.name === p.name && x.in === p.in)) params.push(p);
  return {
    ...e,
    params,
    ...(!e.request?.fields && inferred.request ? { request: { ...inferred.request, source: "ai" as const } } : {}),
    ...(!e.response?.fields && inferred.response ? { response: { ...inferred.response, source: "ai" as const } } : {}),
    ...(inferred.summary && !e.spec?.summary ? { summary: inferred.summary } : {}),
    inferred: true,
  };
}

export function readServedApiCatalog(repoId: string): { sha: string; computedAt: string; catalog: ApiCatalog } | null {
  const stored = readApiCatalog(repoId);
  if (!stored) return null;
  return {
    ...stored,
    catalog: {
      ...stored.catalog,
      endpoints: stored.catalog.endpoints.map((e) => (e.handler?.hash ? withInferred(e, readInferredApiShape(repoId, e.handler.hash)) : e)),
    },
  };
}

export class ApiInferenceError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** Asks the model what one endpoint takes and returns; stored by the handler's fingerprint. */
export async function inferEndpointShape(repo: RepoRecord, endpointId: string, signal?: AbortSignal): Promise<Endpoint> {
  const stored = readApiCatalog(repo.id);
  const endpoint = stored?.catalog.endpoints.find((e) => e.id === endpointId);
  if (!stored || !endpoint) throw new ApiInferenceError("No such endpoint in the analysed commit.", 404);
  if (!endpoint.handler?.hash) throw new ApiInferenceError("This endpoint has no handler code to read.", 400);
  const config = await loadAiConfigOrNull();
  if (!config) throw new ApiInferenceError("Set up an AI provider in Settings to infer shapes.", 400);

  const file = await readFileAtCommit(repo, stored.sha, endpoint.handler.file);
  if (!file) throw new ApiInferenceError(`Could not read ${endpoint.handler.file}.`, 502);
  const lines = file.text.split("\n");
  const handlerText = lines.slice(Math.max(0, endpoint.handler.startLine - 1), endpoint.handler.endLine).join("\n");
  const known = [
    endpoint.params.length ? `params ${endpoint.params.map((p) => `${p.name} (${p.in})`).join(", ")}` : "",
    endpoint.request?.fields ? `request fields ${endpoint.request.fields.map((f) => f.name).join(", ")}` : "",
    endpoint.response?.fields ? `response fields ${endpoint.response.fields.map((f) => f.name).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  const result = await inferApiShape(
    config,
    {
      framework: endpoint.framework,
      kind: endpoint.kind,
      method: endpoint.method,
      path: endpoint.path,
      filePath: endpoint.handler.file,
      handler: handlerText,
      file: file.text,
      ...(known ? { known } : {}),
    },
    { signal }
  );
  if (result.parseFailed) throw new ApiInferenceError("The model's answer couldn't be read. Try again.", 502);
  const inferred: InferredApiShape = {
    ...(result.params.length ? { params: result.params } : {}),
    ...(result.request ? { request: { ...result.request, source: "ai" as const } } : {}),
    ...(result.response ? { response: { ...result.response, source: "ai" as const } } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
    model: config.model,
    inferredAt: new Date().toISOString(),
  };
  writeInferredApiShape(repo.id, endpoint.handler.hash, inferred);
  return withInferred(endpoint, inferred);
}
