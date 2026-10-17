// The top bar's `@nav` slot (see app/layout.tsx) is empty everywhere but
// inside a repo. An explicit empty page per route, not just `default.tsx`:
// on a client-side navigation a slot with no match for the new URL keeps
// showing what it showed before, so leaving a repo would leave its name up.
// On the Repos page it holds the "AI off" chip when no provider is set up
// (DESIGN.md §6.25).

import { AiOffChip } from "../ai-off-chip";
import { loadSetupStatus } from "../setup-status";

export const dynamic = "force-dynamic";

export default async function ReposNav() {
  const setup = await loadSetupStatus();
  return setup && !setup.aiConfigured ? <AiOffChip /> : null;
}
