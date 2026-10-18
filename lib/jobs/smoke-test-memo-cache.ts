/**
 * The in-process caches behind the code views (memo-cache.ts): one load per
 * key while it lasts, failures never kept, TTL, entry and weight caps.
 *
 *   npm test -- memo-cache
 */
import { clearMemoCaches, isFullSha, memo } from "./memo-cache";

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` - ${JSON.stringify(detail)}`}`);
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  let loads = 0;
  const load = (value: string) => async () => {
    loads++;
    await wait(5);
    return value;
  };
  const opts = { ttlMs: 60_000, maxEntries: 3 };

  const [a, b] = await Promise.all([memo("t", "k", opts, load("x")), memo("t", "k", opts, load("y"))]);
  check("two requests for one key share one load", a === "x" && b === "x" && loads === 1, { a, b, loads });
  await memo("t", "k", opts, load("z"));
  check("a later request is a hit", loads === 1, loads);

  let failed = 0;
  await memo("t", "bad", opts, async () => {
    failed++;
    throw new Error("no");
  }).catch(() => {});
  await memo("t", "bad", opts, async () => {
    failed++;
    return "ok";
  });
  check("a failed load isn't kept", failed === 2, failed);

  await memo("short", "k", { ttlMs: 10, maxEntries: 5 }, load("old"));
  await wait(20);
  const fresh = await memo("short", "k", { ttlMs: 10, maxEntries: 5 }, load("new"));
  check("past its TTL an entry loads again", fresh === "new", fresh);

  clearMemoCaches();
  loads = 0;
  for (const k of ["1", "2", "3", "4"]) await memo("lru", k, opts, load(k));
  await memo("lru", "2", opts, load("2"));
  await memo("lru", "1", opts, load("1"));
  check("past maxEntries the least recently used goes", loads === 5, loads);

  loads = 0;
  const heavy = { ttlMs: 60_000, maxEntries: 100, maxWeight: 10, weigh: (s: string) => s.length };
  await memo("w", "a", heavy, load("123456"));
  await memo("w", "b", heavy, load("123456"));
  await wait(1);
  await memo("w", "b", heavy, load("123456"));
  await memo("w", "a", heavy, load("123456"));
  check("past maxWeight the oldest goes, the newest stays", loads === 3, loads);

  check("only a full commit id counts as immutable", isFullSha("a".repeat(40)) && !isFullSha("main") && !isFullSha("abc1234"));

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall memo-cache checks passed");
}

void main();
