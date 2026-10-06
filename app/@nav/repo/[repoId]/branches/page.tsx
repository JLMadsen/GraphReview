// The repo's name, source and status in the top bar — see repo-nav.tsx.
// One page per repo route (rather than a catch-all, which Next refuses next
// to the repo's own index route) so the slot always matches the URL.

import { RepoNav } from "../repo-nav";

export const dynamic = "force-dynamic";

export default RepoNav;
