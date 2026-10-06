// The top bar's `@nav` slot (see app/layout.tsx) is empty everywhere but
// inside a repo. An explicit empty page per route, not just `default.tsx`:
// on a client-side navigation a slot with no match for the new URL keeps
// showing what it showed before, so leaving a repo would leave its name up.

export default function EmptyNav() {
  return null;
}
