# Agent instructions

## Running the app

GraphReview is one Node process: `npm run dev` starts the Next.js dev server
*and* the background job workers (instrumentation.ts → worker/index.ts).
There is no separate worker, database server or queue to start. Dev data
lives in `.data/` (SQLite file, clone cache, generated credential key);
delete that folder to start from scratch.

Requires Node.js 22.13+ (`node:sqlite`).

## Packaging

The app ships as an npm package run with `npx graphreview`
(bin/graphreview.mjs → `next start`). `npm pack` builds and packs it; test a
change to the launcher or the `files` list by installing that tarball into
an empty folder and running `npx graphreview --no-open --data <tmp dir>`.
Never `npm publish` without the user asking.
