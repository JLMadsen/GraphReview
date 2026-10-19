/**
 * Checks that React's generated ids don't make a component "look different"
 * (lib/preview/harness/harness-render.mjs `normalizeIds`): a warm session
 * worker renders many files in one process, so useId's counter keeps going.
 *
 *   npx tsx lib/preview/smoke-test-preview-ids.ts
 */
import { normalizeIds } from "./harness/harness-render.mjs";

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

console.log("useId renumbering");
const first = '<button id="«r0»-tab" aria-controls="«r0»-panel"></button><div id="«r1»"></div>';
const later = '<button id="«r6»-tab" aria-controls="«r6»-panel"></button><div id="«ra»"></div>';
check("the same markup after more renders compares equal", normalizeIds(first) === normalizeIds(later), normalizeIds(later));
check("ids are numbered by first appearance", normalizeIds(later) === first, normalizeIds(later));
check("React 18's :r5: form too", normalizeIds('<p id=":r5:"></p><p id=":r9:"></p>') === '<p id=":r0:"></p><p id=":r1:"></p>');
check("distinct ids stay distinct", normalizeIds('<a id="«r3»"></a><b id="«r4»"></b>') === '<a id="«r0»"></a><b id="«r1»"></b>');
check("server ids («R…») and plain text are left alone", normalizeIds('<p id="«R1»">r5 «x»</p>') === '<p id="«R1»">r5 «x»</p>');

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
