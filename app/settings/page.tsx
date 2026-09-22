import { getSettings } from "@/lib/neo4j";
import { SettingsForm } from "./settings-form";

/**
 * Settings — DESIGN.md §4, §11.
 *
 * A single global (not per-repo) page for the GitHub PAT and AI provider
 * config (base URL/key/model), since both are instance-wide under decision
 * #6's single-local-admin model. Credential fields are encrypted at rest
 * via lib/crypto (see app/settings/actions.ts) before being written to the
 * Settings node in Neo4j (lib/neo4j).
 *
 * This is a server component: it only ever reads whether a secret is
 * currently saved (a boolean), never a decrypted value, so no secret is
 * capable of reaching the client — see settings-form.tsx for how that's
 * rendered.
 */
/**
 * Never prerender this page.
 *
 * Without this, Next statically renders `/settings` at *build* time and
 * serves it with `Cache-Control: s-maxage=31536000`. Inside the Docker
 * image build there is no Neo4j to reach, so `getSettings()` throws, the
 * `catch` below degrades to "nothing is saved", and that HTML is then
 * cached for a year — the page reports no stored PAT and no stored API key
 * no matter what is actually in the database, and the AI card's key field
 * offers a blank input instead of the masked "saved · Replace · Clear" row.
 * (`revalidatePath("/settings")` in the save action papered over it only
 * for whoever happened to save something after the last rebuild.)
 *
 * This page reads live credential state, so it is dynamic by nature — same
 * reasoning as `app/repo/[repoId]/layout.tsx` and the review route.
 */
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // Neo4j may not be reachable yet (e.g. first run before `docker compose
  // up`, or mid-development). Degrade to an empty settings view rather than
  // crashing the whole page.
  let settings: Awaited<ReturnType<typeof getSettings>> | null = null;
  try {
    settings = await getSettings();
  } catch {
    settings = null;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">Settings</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Instance-wide configuration. Credentials are encrypted at rest and
          never sent back to the browser.
        </p>
      </div>

      <SettingsForm
        initialHasGithubPat={Boolean(settings?.githubPatEncrypted)}
        initialHasAiApiKey={Boolean(settings?.aiApiKeyEncrypted)}
        initialAiBaseUrl={settings?.aiBaseUrl ?? ""}
        initialAiModel={settings?.aiModel ?? ""}
      />
    </div>
  );
}
