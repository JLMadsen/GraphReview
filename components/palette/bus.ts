"use client";

// How the command palette (DESIGN.md §6.18) and the Graph tab talk. The
// palette lives in the root layout and the Graph tab deep inside a page, so
// they meet here, in module state that survives client-side navigation:
//
// - The Graph tab publishes what is open (repo, review target, the change's
//   paths) — the palette ranks and offers targets by it.
// - The Graph tab registers a handler for view actions (the chat's
//   `ChatActionDTO`, §6.7) and for a question to its chat.
// - From any other page, the palette navigates to the Graph tab and leaves
//   the action pending; GraphView takes it once it can apply it.

import { useSyncExternalStore } from "react";
import type { ChatActionDTO } from "@/components/graph/chat-types";
import type { ReviewTargetDTO } from "@/components/graph/types";
import type { SearchScope } from "@/lib/search/types";

export interface PaletteGraphContext {
  repoId: string;
  target: ReviewTargetDTO | null;
  /** `pr:<n>` or `refs:<base>...<head>`, as findings and the target graph key it. */
  targetKey?: string;
  /** The open change's paths. */
  touched: string[];
}

export type GraphRequest = { kind: "action"; action: ChatActionDTO } | { kind: "ask"; question: string };

interface Pending {
  repoId: string;
  request: GraphRequest;
  /** Wait for a review target (and its map) before applying. */
  needsTarget: boolean;
}

let context: PaletteGraphContext | null = null;
let handler: { repoId: string; run: (request: GraphRequest) => void } | null = null;
let pending: Pending | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setGraphContext(next: PaletteGraphContext | null): void {
  context = next;
  emit();
}

export function useGraphContext(): PaletteGraphContext | null {
  return useSyncExternalStore(
    subscribe,
    () => context,
    () => null
  );
}

/** The Graph tab's handler; returns the unregister function. */
export function registerGraphHandler(repoId: string, run: (request: GraphRequest) => void): () => void {
  const mine = { repoId, run };
  handler = mine;
  return () => {
    if (handler === mine) handler = null;
  };
}

/** Applies `request` on the open Graph tab of `repoId`; false when there is none. */
export function sendToGraph(repoId: string, request: GraphRequest): boolean {
  if (!handler || handler.repoId !== repoId) return false;
  handler.run(request);
  return true;
}

export function setPendingGraphRequest(next: Pending | null): void {
  pending = next;
}

/** The pending request for `repoId`, taken (cleared) once it can be applied: a target for those that need one, the chat's thread for a question. */
export function takePendingGraphRequest(repoId: string, hasTarget: boolean, chatReady: boolean): GraphRequest | null {
  if (!pending || pending.repoId !== repoId) return null;
  if (pending.needsTarget && !hasTarget) return null;
  if (pending.request.kind === "ask" && !chatReady) return null;
  const { request } = pending;
  pending = null;
  return request;
}

// --- Opening the palette from elsewhere (the `t` key, the repo switcher) ---

export interface OpenPaletteOptions {
  scope?: SearchScope | "commands";
  query?: string;
}

const OPEN_EVENT = "graphreview:open-palette";

export function openPalette(options: OpenPaletteOptions = {}): void {
  window.dispatchEvent(new CustomEvent<OpenPaletteOptions>(OPEN_EVENT, { detail: options }));
}

export function onOpenPalette(listener: (options: OpenPaletteOptions) => void): () => void {
  const wrapped = (e: Event) => listener((e as CustomEvent<OpenPaletteOptions>).detail ?? {});
  window.addEventListener(OPEN_EVENT, wrapped);
  return () => window.removeEventListener(OPEN_EVENT, wrapped);
}

// --- Switching the Graph tab's target from the palette ---------------------
// DiffPanel keeps its selection to itself and mirrors it into the URL with
// replaceState, so a navigation to `?pr=` can look like no change at all to
// the router. A retarget bumps a generation instead; the Graph page's host
// starts GraphView over on the new target when it sees one newer than itself.

export type GraphTarget = { pr: number } | { base: string; head: string } | null;

let retarget: { generation: number; target: GraphTarget } = { generation: 0, target: null };
const retargetListeners = new Set<() => void>();

export function retargetGraph(target: GraphTarget): void {
  retarget = { generation: retarget.generation + 1, target };
  for (const l of retargetListeners) l();
}

export function useGraphRetarget(): { generation: number; target: GraphTarget } {
  return useSyncExternalStore(
    (l) => {
      retargetListeners.add(l);
      return () => retargetListeners.delete(l);
    },
    () => retarget,
    () => retarget
  );
}

/** Whether the Graph tab of `repoId` is the page on screen. */
export function graphIsOpen(repoId: string): boolean {
  return handler?.repoId === repoId;
}
