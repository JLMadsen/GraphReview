// What a fresh install still needs (DESIGN.md §6.25): read on the server by
// the landing page's setup checklist and by the top bar's "AI off" chip.
// Only booleans — never a secret.

import { getActiveAiProvider, getSettings } from "@/lib/db";

export interface SetupStatus {
  /** An active AI provider is saved (Settings → AI providers). */
  aiConfigured: boolean;
  githubPat: boolean;
  gitlabPat: boolean;
}

/** `null` when the database can't be read — callers then show nothing rather than a wrong "AI off". */
export async function loadSetupStatus(): Promise<SetupStatus | null> {
  try {
    const [settings, provider] = await Promise.all([getSettings(), getActiveAiProvider()]);
    return {
      aiConfigured: provider !== null,
      githubPat: Boolean(settings?.githubPatEncrypted),
      gitlabPat: Boolean(settings?.gitlabPatEncrypted),
    };
  } catch {
    return null;
  }
}
