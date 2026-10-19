// The active AI provider's settings, for the jobs that call a model only when one is set up.

import type { AiProviderConfig } from "@/lib/ai";
import { DEFAULT_REVIEW_EFFORT, GENEROUS_REVIEW_EFFORT, type ReviewEffort } from "@/lib/ai/effort";
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

/** Whether the active provider allows generous spending (lib/db/ai-provider.ts): tokens spent ahead of time to be faster and see more. */
export async function isGenerousSpending(): Promise<boolean> {
  try {
    return (await getActiveAiProvider())?.generousSpending === true;
  } catch {
    return false;
  }
}

/** The review effort a run gets when nobody picked one: the next level up under generous spending. */
export async function defaultReviewEffort(): Promise<ReviewEffort> {
  return (await isGenerousSpending()) ? GENEROUS_REVIEW_EFFORT : DEFAULT_REVIEW_EFFORT;
}
