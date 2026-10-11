// Copying text to the clipboard with a brief "copied" state for the button.

import { useCallback, useEffect, useRef, useState } from "react";

/** `[copied, copy]` — `copied` is true for two seconds after each copy. */
export function useCopyText(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    []
  );
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (plain http on a non-localhost host):
      // fall back to a hidden textarea and the legacy copy command.
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  }, []);
  return [copied, copy];
}
