/**
 * Checks that a component which only wraps `{children}` in a context
 * provider is skipped by the preview (lib/preview/symbols.ts
 * `isPassThrough`), while one with markup or styling of its own still runs.
 *
 *   npm test -- passthrough
 */
import { detectChangedSymbols } from "./symbols";

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const after = `
import { createContext } from "react";
const Ctx = createContext(null);
export function ThemeProvider({ children, theme }) {
  const value = useMemo(() => ({ theme }), [theme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const AuthProvider = ({ children }) => (
  <SessionContext value={1}>
    <>{children}</>
  </SessionContext>
);
export function StyledProvider({ children }) {
  return <Ctx.Provider value={1}><div className="p-4">{children}</div></Ctx.Provider>;
}
export function ToastProvider({ children }) {
  return <Ctx.Provider value={1}>{children}<Toaster /></Ctx.Provider>;
}
export function Card({ children }) {
  return <Panel>{children}</Panel>;
}
`;

async function main(): Promise<void> {
  const { runnable, skipped } = await detectChangedSymbols("src/providers.tsx", "node", null, after);
  const ran = runnable.map((s) => s.name);
  const skippedNames = skipped.map((s) => s.name);
  check("context provider around children is skipped", skippedNames.includes("ThemeProvider"), skipped);
  check("arrow provider with a fragment is skipped", skippedNames.includes("AuthProvider"), skipped);
  check("provider with styled markup still runs", ran.includes("StyledProvider"), ran);
  check("provider that renders a sibling still runs", ran.includes("ToastProvider"), ran);
  check("non-provider wrapper still runs", ran.includes("Card"), ran);

  if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
