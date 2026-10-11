// The active AI provider's settings, for the jobs that call a model only when one is set up.

import type { AiProviderConfig } from "@/lib/ai";
import { decrypt } from "@/lib/crypto";
import {
  getActiveAiProvider,
} from "@/lib/db";

/** The active provider's config, or `null` when it isn't fully configured. */
export async function loadAiConfigOrNull(): Promise<AiProviderConfig | null> {
  const provider = await getActiveAiProvider();
  if (!provider?.baseUrl || !provider.apiKeyEncrypted || !provider.model) return null;
  try {
    return { baseUrl: provider.baseUrl, apiKey: decrypt(provider.apiKeyEncrypted), model: provider.model };
  } catch {
    return null;
  }
}
