// Barrel for lib/db/. Re-exports the connection lifecycle, shared entity
// types, and every per-entity repository module's typed functions. See
// README.md for scope.

export { closeDb, getDb } from "./client";
export * from "./types";

export * from "./repo";
export * from "./component";
export * from "./file";
export * from "./pullRequest";
export * from "./refSnapshot";
export * from "./finding";
export * from "./label";
export * from "./merge";
export * from "./checklist";
export * from "./chat";
export * from "./pr-map";
export * from "./app-map";
export * from "./settings";
export * from "./ai-provider";
export * from "./kv";
