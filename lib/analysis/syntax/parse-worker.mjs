// The parse worker: tree-sitter parsing off the server's main thread.
//
// Started by ./parse-pool.ts with `worker_threads`. Loaded from disk as-is
// (it ships in the npm package next to ./extract.mjs), so it never goes
// through the Next.js bundler. A grammar that crashes the WASM runtime, or a
// pathological file that never finishes, takes this worker down — the pool
// notices, skips that file and starts a fresh worker — instead of the app.
//
// Request:  { id, grammarId, grammarPath, queryPath?, family?, source }
// Response: { id, matches, symbols } or { id, error }

import { readFile } from "node:fs/promises";
import { parentPort } from "node:worker_threads";
import { Language, Parser, Query } from "web-tree-sitter";
import { extractSymbols } from "./extract.mjs";

let init;
const languages = new Map();
const parsers = new Map();
const queries = new Map();

async function parserFor(grammarId, grammarPath) {
  init ??= Parser.init();
  await init;
  let parser = parsers.get(grammarId);
  if (parser) return parser;
  let language = languages.get(grammarId);
  if (!language) {
    language = await Language.load(new Uint8Array(await readFile(grammarPath)));
    languages.set(grammarId, language);
  }
  parser = new Parser();
  parser.setLanguage(language);
  parsers.set(grammarId, parser);
  return parser;
}

async function queryFor(grammarId, queryPath) {
  const key = `${grammarId} ${queryPath}`;
  let query = queries.get(key);
  if (!query) {
    query = new Query(languages.get(grammarId), await readFile(queryPath, "utf8"));
    queries.set(key, query);
  }
  return query;
}

async function handle(request) {
  const parser = await parserFor(request.grammarId, request.grammarPath);
  const query = request.queryPath ? await queryFor(request.grammarId, request.queryPath) : null;
  const tree = parser.parse(request.source);
  if (!tree) return { id: request.id, matches: [], symbols: null };
  try {
    const matches = query
      ? query.matches(tree.rootNode).map((match) => ({
          patternIndex: match.patternIndex,
          captures: match.captures.map((capture) => ({
            name: capture.name,
            text: capture.node.text,
            startRow: capture.node.startPosition.row,
          })),
        }))
      : [];
    const symbols = request.family ? extractSymbols(tree.rootNode, request.family) : null;
    return { id: request.id, matches, symbols };
  } finally {
    tree.delete();
  }
}

parentPort.on("message", (request) => {
  handle(request).then(
    (response) => parentPort.postMessage(response),
    (error) => parentPort.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  );
});
