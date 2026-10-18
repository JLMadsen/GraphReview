// What a fresh install still needs (DESIGN.md §6.25): read on the server by
// the landing page's empty state and by the top bar's "AI off" chip.
// Only booleans — never a secret.

import { getActiveAiProvider } from "@/lib/db";

export interface SetupStatus {
  /** An active AI provider is saved (Settings → AI providers). */
  aiConfigured: boolean;
}

/** `null` when the database can't be read — callers then show nothing rather than a wrong "AI off". */
export async function loadSetupStatus(): Promise<SetupStatus | null> {
  try {
    return { aiConfigured: (await getActiveAiProvider()) !== null };
  } catch {
    return null;
  }
}
