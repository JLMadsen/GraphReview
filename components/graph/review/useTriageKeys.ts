// Keyboard triage in the review dock: J/K move through the visible rows,
// Enter expands, R resolves (or reopens), D opens the file. Off while typing,
// while a dialog is open, and when `enabled` is false (the Files tab).

import { useCallback, useEffect, useRef, useState } from "react";
import type { RowActions } from "./parts";

export function useTriageKeys(enabled: boolean, visibleRows: ReadonlyArray<{ key: string }>) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const rowActions = useRef(new Map<string, RowActions>());
  /** Each row registers what the keys do to it while it is mounted. */
  const registerRow = useCallback((key: string, actions: RowActions | null) => {
    if (actions) rowActions.current.set(key, actions);
    else rowActions.current.delete(key);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      // The target is the document itself when nothing has focus.
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("[role=dialog]")) return;
      const keys = visibleRows.map((row) => row.key);
      if (keys.length === 0) return;
      const index = activeKey ? keys.indexOf(activeKey) : -1;
      const key = e.key.toLowerCase();
      if (key === "j" || key === "k") {
        e.preventDefault();
        const next = key === "j" ? Math.min(keys.length - 1, index + 1) : Math.max(0, index < 0 ? 0 : index - 1);
        setActiveKey(keys[next]);
        return;
      }
      const actions = index >= 0 ? rowActions.current.get(keys[index]) : undefined;
      if (!actions) return;
      if (e.key === "Enter" && !el?.closest("button, a")) {
        e.preventDefault();
        actions.toggle();
      } else if (key === "r") {
        e.preventDefault();
        actions.resolve();
      } else if (key === "d") {
        e.preventDefault();
        actions.open();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, visibleRows, activeKey]);
  return { activeKey, setActiveKey, registerRow };
}
