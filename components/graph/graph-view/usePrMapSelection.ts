// What is selected on the PR view (DESIGN.md §6.4, §6.10): the area the view
// is focused on (and one of its components), and on the Functions view the
// selected function and what the reviewer hid.

import { useCallback, useEffect, useMemo, useState } from "react";
import { buildFunctionView, NOTHING_HIDDEN, type HiddenFunctions } from "../call-graph-view";
import type { PrMapRequestDTO, PrMapResponseDTO } from "../pr-map-types";
import { reviewTargetLabel, type ReviewTargetDTO } from "../types";
import type { UseTargetGraphResult } from "../useTargetGraph";

/** Functions and cards hidden on the Functions view, per repo and target. */
const hiddenFunctionsKey = (repoId: string, target: ReviewTargetDTO) => `graphreview.prmap.hidden.${repoId}.${reviewTargetLabel(target)}`;

/** The area (PR map card) the PR view is focused on, and optionally one of its components — they scope the dock. */
export function usePrAreaSelection(prRequest: PrMapRequestDTO | null, map: PrMapResponseDTO | null) {
  const [prArea, setPrArea] = useState<string | null>(null);
  const [prAreaComponent, setPrAreaComponent] = useState<string | null>(null);
  const selectPrArea = useCallback((cardId: string | null) => {
    setPrArea(cardId);
    setPrAreaComponent(null);
  }, []);
  useEffect(() => selectPrArea(null), [prRequest, selectPrArea]);
  // A refreshed map (the review's grouping arriving) has new card ids.
  useEffect(() => {
    if (prArea && map && !map.nodes.some((n) => n.id === prArea)) selectPrArea(null);
  }, [prArea, map, selectPrArea]);
  return { prArea, prAreaComponent, setPrAreaComponent, selectPrArea };
}

/** The Functions view: its model, the selected function, and what the reviewer took off it (the eyes on rows and cards) — remembered per target in this browser. */
export function usePrFunctions(
  repoId: string,
  reviewTarget: ReviewTargetDTO | null,
  map: PrMapResponseDTO | null,
  targetGraph: UseTargetGraphResult
) {
  const [selectedFunction, setSelectedFunction] = useState<string | null>(null);
  const [hiddenFunctions, setHiddenFunctions] = useState<HiddenFunctions>(NOTHING_HIDDEN);
  useEffect(() => {
    setSelectedFunction(null);
    let restored = NOTHING_HIDDEN;
    if (reviewTarget) {
      try {
        const raw = window.localStorage.getItem(hiddenFunctionsKey(repoId, reviewTarget));
        const parsed = raw ? (JSON.parse(raw) as { functions?: string[]; cards?: string[] }) : null;
        if (parsed) restored = { functions: new Set(parsed.functions ?? []), cards: new Set(parsed.cards ?? []) };
      } catch {
        /* storage unavailable or unreadable — start with nothing hidden */
      }
    }
    setHiddenFunctions(restored);
  }, [repoId, reviewTarget]);
  const updateHidden = useCallback(
    (next: HiddenFunctions) => {
      setHiddenFunctions(next);
      if (!reviewTarget) return;
      try {
        const key = hiddenFunctionsKey(repoId, reviewTarget);
        if (next.functions.size === 0 && next.cards.size === 0) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, JSON.stringify({ functions: [...next.functions], cards: [...next.cards] }));
      } catch {
        /* ignored */
      }
    },
    [repoId, reviewTarget]
  );
  const hideFunction = useCallback(
    (id: string) => {
      updateHidden({ functions: new Set([...hiddenFunctions.functions, id]), cards: hiddenFunctions.cards });
      setSelectedFunction((current) => (current === id ? null : current));
    },
    [hiddenFunctions, updateHidden]
  );
  const hideFunctionCard = useCallback(
    (cardId: string) => updateHidden({ functions: hiddenFunctions.functions, cards: new Set([...hiddenFunctions.cards, cardId]) }),
    [hiddenFunctions, updateHidden]
  );
  const showHiddenFunctions = useCallback(() => updateHidden(NOTHING_HIDDEN), [updateHidden]);
  const functionView = useMemo(
    () => buildFunctionView(map, targetGraph.graph?.data, hiddenFunctions),
    [map, targetGraph.graph, hiddenFunctions]
  );
  // A selected function the reviewer just hid (or that a hidden card took with it) is deselected.
  useEffect(() => {
    if (selectedFunction && functionView && !functionView.cardOf.has(selectedFunction)) setSelectedFunction(null);
  }, [selectedFunction, functionView]);
  return { functionView, selectedFunction, setSelectedFunction, hideFunction, hideFunctionCard, showHiddenFunctions };
}
