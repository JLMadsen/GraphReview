// The Graph tab's repo context: the header/defaults, the analysis status and
// the component graph (for component names).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { GraphResponseDTO } from "../types";

/** Trimmed shape of `GET /api/repos/[repoId]` — see this repo's task brief. Only the fields this view needs. */
export interface RepoContext {
  name: string;
  provider?: "local" | "github" | "gitlab" | "git";
  defaultBranch?: string;
  lastAnalyzedSha?: string;
  status?: "analyzing" | "up_to_date" | "stale" | "error";
}

/** How often the repo's status is re-read while an analysis runs. */
const ANALYSIS_POLL_MS = 3000;

export interface RepoContextState {
  repo: RepoContext | null;
  /** The component graph — only its node names are used now (the dock and inspector label components with them). */
  graph: GraphResponseDTO | null;
  /**
   * Bumped when an analysis finishes, to re-fetch the component graph and
   * the catalogs without remounting anything. Never read by the effects it
   * retriggers.
   */
  graphNonce: number;
}

export function useRepoContext(repoId: string): RepoContextState {
  const [repo, setRepo] = useState<RepoContext | null>(null);
  const [graph, setGraph] = useState<GraphResponseDTO | null>(null);
  const [graphNonce, setGraphNonce] = useState(0);

  // While an analysis is running (`analyzing`, or `stale` = refreshing an
  // existing graph) the status is re-read every few seconds — a cheap read of
  // the job queue, no git call — and the moment it finishes (or the analyzed
  // commit changes) the graph and the App map are fetched again and the
  // server-rendered header is refreshed. Without this the tab kept showing
  // the old map until a manual reload. Fails silently: the endpoint 404s for
  // an unknown repo and errors without a readable database.
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasWorking = false;
    let lastSha: string | undefined;
    let first = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/repos/${repoId}`);
        const data = res.ok ? ((await res.json()) as RepoContext) : null;
        if (cancelled || !data) return;
        setRepo(data);
        const working = data.status === "analyzing" || data.status === "stale";
        const finished = (wasWorking && !working) || (!first && data.lastAnalyzedSha !== lastSha);
        if (finished) {
          setGraphNonce((n) => n + 1);
          router.refresh();
        }
        wasWorking = working;
        lastSha = data.lastAnalyzedSha;
        first = false;
        if (working) timer = setTimeout(() => void load(), ANALYSIS_POLL_MS);
      } catch {
        /* nice-to-have — keep what's on screen */
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [repoId, router]);

  // The component graph, for component names. An unanalyzed repo or an
  // unreadable database just leaves names unresolved (ids show instead) —
  // the App map has its own "not analyzed yet" state.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/repos/${repoId}/graph`)
      .then(async (res) => (res.ok ? ((await res.json()) as GraphResponseDTO) : null))
      .then((data) => {
        if (!cancelled) setGraph(data);
      })
      .catch(() => {
        if (!cancelled) setGraph(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, graphNonce]);

  return { repo, graph, graphNonce };
}

/**
 * On a desktop-sized window the tab exactly fills the viewport under the
 * app's nav and the repo header, and each column scrolls on its own — the
 * page itself never does. Sets `--tab-h` (that height) on the root element;
 * the map takes a fixed share of it and the review scrolls in the rest.
 */
export function useTabHeight(rootRef: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = el.getBoundingClientRect().top + window.scrollY;
        el.style.setProperty("--tab-h", `${Math.max(480, window.innerHeight - top)}px`);
      });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", fit);
    };
  }, [rootRef]);
}
