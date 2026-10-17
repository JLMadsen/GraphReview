// Small state hooks the Graph tab's views share: a choice remembered in this
// browser, the same mirrored into the URL, and a view that mounts the first
// time it is opened.

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * State remembered per browser in localStorage under `key`. It is read after
 * mount (the server render has no storage), so the first paint shows
 * `fallback`; `parse` returns undefined for a missing or unknown value.
 * Storage that is unavailable just keeps the default.
 */
export function useStoredState<T>(
  key: string,
  fallback: T,
  parse: (raw: string | null) => T | undefined,
  serialize: (value: T) => string = String
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    try {
      const stored = parse(window.localStorage.getItem(key));
      if (stored !== undefined) setValue(stored);
    } catch {
      /* storage unavailable — keep the default */
    }
    // Read once per key; `parse` is a plain function of the raw value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, serialize(next));
      } catch {
        /* ignored */
      }
    },
    [key, serialize]
  );
  return [value, set];
}

/** How a change reaches the browser history: a new entry (Back undoes it), or the current one rewritten. */
export type HistoryMode = "push" | "replace";

/**
 * A choice that is both remembered per browser (as `useStoredState`) and
 * mirrored into the URL as `?<param>=` (DESIGN.md §6.25), so it can be
 * linked and Back/Forward step through it. The URL wins when it has the
 * param; without one, the stored choice is the default. A change pushes a
 * history entry unless asked to replace; the first push also writes the
 * value it leaves onto the entry it leaves, so Back returns to it.
 *
 * `takeGivenAtLoad()` says, once, whether the page was opened with the
 * param — for a caller that would otherwise switch on its own at load.
 * Native `history.pushState` keeps Next's router in step (Next ≥ 14.1).
 */
export function useUrlState<T extends string>(
  param: string,
  storageKey: string,
  fallback: T,
  parse: (raw: string | null) => T | undefined
): { value: T; set: (next: T, history?: HistoryMode) => void; takeGivenAtLoad: () => boolean } {
  const [stored, setStored] = useStoredState<T>(storageKey, fallback, parse);
  const [fromUrl, setFromUrl] = useState<T | undefined>(undefined);
  const givenAtLoad = useRef<boolean | null>(null);
  useEffect(() => {
    const read = () => {
      const value = parse(new URLSearchParams(window.location.search).get(param));
      if (givenAtLoad.current === null) givenAtLoad.current = value !== undefined;
      setFromUrl(value);
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
    // `parse` is a plain function of the raw value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [param]);
  const value = fromUrl ?? stored;
  // Read through a ref so `set` stays the same function (callers list it as an effect dependency).
  const current = useRef(value);
  current.current = value;
  const set = useCallback(
    (next: T, history: HistoryMode = "push") => {
      setStored(next);
      setFromUrl(next);
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.get(param) === next) return;
        const value = current.current;
        if (history === "push" && !url.searchParams.has(param) && value !== next) {
          // The entry being left had no param: pin what it showed, so Back shows it again.
          const here = new URL(url);
          here.searchParams.set(param, value);
          window.history.replaceState(window.history.state, "", here);
        }
        url.searchParams.set(param, next);
        if (history === "push") window.history.pushState(null, "", url);
        else window.history.replaceState(window.history.state, "", url);
      } catch {
        /* the URL is a convenience */
      }
    },
    [param, setStored]
  );
  const takeGivenAtLoad = useCallback(() => {
    const given = givenAtLoad.current === true;
    givenAtLoad.current = false;
    return given;
  }, []);
  return { value, set, takeGivenAtLoad };
}

/** Whether a view has been opened yet — it mounts (and starts fetching) then and stays mounted. `mount` opens it early, e.g. for a link into it. */
export function useLazyMount(active: boolean): [boolean, () => void] {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (active) setMounted(true);
  }, [active]);
  const mount = useCallback(() => setMounted(true), []);
  return [mounted, mount];
}
