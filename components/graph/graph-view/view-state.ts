// Small state hooks the Graph tab's views share: a choice remembered in this
// browser, and a view that mounts the first time it is opened.

import { useCallback, useEffect, useState } from "react";

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

/** Whether a view has been opened yet — it mounts (and starts fetching) then and stays mounted. `mount` opens it early, e.g. for a link into it. */
export function useLazyMount(active: boolean): [boolean, () => void] {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (active) setMounted(true);
  }, [active]);
  const mount = useCallback(() => setMounted(true), []);
  return [mounted, mount];
}
