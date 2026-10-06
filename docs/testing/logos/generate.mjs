// Regenerates every SVG in this folder, index.html, and the app icons
// (app/icon.svg, favicon.ico, apple-icon.png) from option A. Run from the
// repo root: node docs/testing/logos/generate.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const repo = fileURLToPath(new URL("../../..", import.meta.url)).replace(/[\\/]$/, "");
const require = createRequire(repo + "/package.json");
const sharp = require("sharp");

const G = `<path d="M8 0V32M16 0V32M24 0V32M0 8H32M0 16H32M0 24H32" stroke="#fff" stroke-opacity=".08" stroke-width=".6"/>`;
const GL = `<path d="M8 0V32M16 0V32M24 0V32M0 8H32M0 16H32M0 24H32" stroke="#567bf7" stroke-opacity=".15" stroke-width=".6"/>`;
const tile = (fill, rx = 7) => `<rect width="32" height="32" rx="${rx}" fill="${fill}"/>`;
const BG = (rx) => tile("#123458", rx) + G;
const A = "#f2b84b", W = "#fff", N = "#123458";

const inner = `<path d="M10.5 10.5L16 16.5M10.5 18.5L16 16.5M10.5 10.5V18.5" stroke="#fff" stroke-opacity=".7" stroke-width="1.4"/>`;
const card = (f, dash) => `<rect x="4" y="4" width="16.5" height="16.5" rx="4" fill="#567bf7" fill-opacity="${f}"${dash ? ' stroke="#9db6ff" stroke-width="1" stroke-dasharray="2 1.5"' : ""}/>`;
const cardNodes = (c) => `<path d="M8.5 8.5L15.5 15.5M8.5 15.5H15.5M8.5 8.5V15.5" stroke="${c}" stroke-opacity=".7" stroke-width="1.3"/><circle cx="8.5" cy="8.5" r="2.1" fill="${c}"/><circle cx="8.5" cy="15.5" r="2.1" fill="${c}"/><circle cx="15.5" cy="15.5" r="2.4" fill="${c}"/>`;

// The chosen mark. `rx` is a parameter so the apple-icon can be full-bleed
// (iOS applies its own mask).
const comboA = (rx = 7) => BG(rx) + card(0.4, 1) + cardNodes(W) +
  `<circle cx="24.5" cy="24.5" r="5.2" fill="none" stroke="${A}" stroke-opacity=".4" stroke-width="1.1"/><path d="M15.5 15.5L21.9 21.9" stroke="${A}" stroke-width="2" stroke-linecap="round"/><circle cx="24.5" cy="24.5" r="2.7" fill="${N}" stroke="${A}" stroke-width="1.8"/>`;

const logos = [
  // Round 1: broad directions
  ["round1", "0-current", "Current", tile("#567bf7") + `<g transform="translate(4 5.25)" fill="#fff"><path d="M12 6.5v4M9.2 15.2l-2.6-2.1M14.8 15.2l2.6-2.1" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity="0.8"/><circle cx="12" cy="4.5" r="2.9"/><circle cx="5" cy="17" r="2.9"/><circle cx="19" cy="17" r="2.9"/></g>`],
  ["round1", "1-diff-graph", "Diff graph", tile("#14161c") + `<path d="M16 8L8 22" stroke="#3fb950" stroke-width="2.4" stroke-linecap="round"/><path d="M16 8L24 22" stroke="#f85149" stroke-width="2.4" stroke-linecap="round"/><path d="M8 22H24" stroke="#ffffff" stroke-opacity=".35" stroke-width="2.4" stroke-linecap="round"/><circle cx="16" cy="8" r="3.2" fill="#fff"/><circle cx="8" cy="22" r="3.2" fill="#fff"/><circle cx="24" cy="22" r="3.2" fill="#fff"/>`],
  ["round1", "2-lens", "Lens", tile("#567bf7") + `<path d="M19.5 19.5L25.5 25.5" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><circle cx="13.5" cy="13.5" r="8" fill="none" stroke="#fff" stroke-width="2.4"/><path d="M13.5 10L10.5 16H16.5Z" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.2" stroke-linejoin="round"/><circle cx="13.5" cy="10" r="1.8" fill="#fff"/><circle cx="10.5" cy="16" r="1.8" fill="#fff"/><circle cx="16.5" cy="16" r="1.8" fill="#fff"/>`],
  ["round1", "3-check-path", "Check path", tile("#567bf7") + `<path d="M7.5 16.5L13 22L24.5 9.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" stroke-opacity=".85"/><circle cx="7.5" cy="16.5" r="3" fill="#fff"/><circle cx="13" cy="22" r="3" fill="#fff"/><circle cx="24.5" cy="9.5" r="3" fill="#fff"/>`],
  ["round1", "4-g-trace", "G trace", tile("#14161c") + `<path d="M22.6 10.2A8.6 8.6 0 1 0 24.6 17H17" fill="none" stroke="#7c9bff" stroke-width="2.6" stroke-linecap="round"/><circle cx="22.6" cy="10.2" r="2.7" fill="#fff"/><circle cx="17" cy="17" r="2.7" fill="#fff"/>`],
  ["round1", "5-blueprint-areas", "Blueprint areas", BG() + `<ellipse cx="11.5" cy="12" rx="7" ry="6" fill="#567bf7" fill-opacity=".35" stroke="#9db6ff" stroke-width="1" stroke-dasharray="2 1.5"/><ellipse cx="20.5" cy="20.5" rx="7" ry="6" fill="#2fb8a0" fill-opacity=".3" stroke="#7fe0cc" stroke-width="1" stroke-dasharray="2 1.5"/><path d="M9 10L13.5 14L19 19L23 22.5" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1.2"/><circle cx="9" cy="10" r="2" fill="#fff"/><circle cx="13.5" cy="14" r="2" fill="#fff"/><circle cx="19" cy="19" r="2" fill="#fff"/><circle cx="23" cy="22.5" r="2" fill="#fff"/>`],
  // Round 2: variants of 5
  ["round2", "5a-solid-areas", "Solid areas", BG() + `<ellipse cx="12" cy="12.5" rx="7.5" ry="6.5" fill="#567bf7" fill-opacity=".6"/><ellipse cx="20.5" cy="20" rx="7.5" ry="6.5" fill="#2fb8a0" fill-opacity=".55"/><path d="M9.5 10.5L16 16.5L22.5 21.5" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="1.6" stroke-linecap="round"/><circle cx="9.5" cy="10.5" r="2.4" fill="#fff"/><circle cx="16" cy="16.5" r="2.4" fill="#fff"/><circle cx="22.5" cy="21.5" r="2.4" fill="#fff"/>`],
  ["round2", "5b-three-areas", "Three areas", BG() + `<circle cx="12" cy="12.5" r="7" fill="#567bf7" fill-opacity=".5"/><circle cx="20" cy="12.5" r="7" fill="#2fb8a0" fill-opacity=".45"/><circle cx="16" cy="19.5" r="7" fill="#f2b84b" fill-opacity=".4"/><path d="M16 15.5L10.5 11M16 15.5L21.5 11M16 15.5V22" stroke="#fff" stroke-opacity=".8" stroke-width="1.4" stroke-linecap="round"/><circle cx="10.5" cy="11" r="2" fill="#fff"/><circle cx="21.5" cy="11" r="2" fill="#fff"/><circle cx="16" cy="22" r="2" fill="#fff"/><circle cx="16" cy="15.5" r="2.6" fill="#fff"/>`],
  ["round2", "5c-card-areas", "Card areas", BG() + `<rect x="4.5" y="5.5" width="14" height="11.5" rx="3" fill="#567bf7" fill-opacity=".4" stroke="#9db6ff" stroke-width="1" stroke-dasharray="2 1.5"/><rect x="13.5" y="15" width="14" height="11.5" rx="3" fill="#2fb8a0" fill-opacity=".35" stroke="#7fe0cc" stroke-width="1" stroke-dasharray="2 1.5"/><path d="M8.5 9.5L13 13L19 19L23.5 22.5" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.3"/><circle cx="8.5" cy="9.5" r="2" fill="#fff"/><circle cx="13" cy="13" r="2" fill="#fff"/><circle cx="19" cy="19" r="2" fill="#fff"/><circle cx="23.5" cy="22.5" r="2" fill="#fff"/>`],
  ["round2", "5d-impact-crossing", "Impact crossing", BG() + `<circle cx="13.5" cy="13.5" r="9" fill="#567bf7" fill-opacity=".35" stroke="#9db6ff" stroke-width="1" stroke-dasharray="2 1.5"/><path d="M10.5 10.5L16 16.5M10.5 18.5L16 16.5M10.5 10.5V18.5" stroke="#fff" stroke-opacity=".7" stroke-width="1.3"/><path d="M16 16.5L25 24.5" stroke="${A}" stroke-width="1.8" stroke-linecap="round"/><circle cx="10.5" cy="10.5" r="2.1" fill="#fff"/><circle cx="10.5" cy="18.5" r="2.1" fill="#fff"/><circle cx="16" cy="16.5" r="2.4" fill="#fff"/><circle cx="25" cy="24.5" r="2.6" fill="${A}"/>`],
  ["round2", "5e-monoline", "Monoline", BG() + `<ellipse cx="12" cy="12.5" rx="7.5" ry="6.5" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="1.4"/><ellipse cx="20" cy="19.5" rx="7.5" ry="6.5" fill="none" stroke="#7fe0cc" stroke-width="1.4"/><path d="M9.5 11L16 16L22.5 21" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="1.2"/><circle cx="9.5" cy="11" r="2.2" fill="#fff"/><circle cx="16" cy="16" r="2.2" fill="#fff"/><circle cx="22.5" cy="21" r="2.2" fill="#7fe0cc"/>`],
  ["round2", "5f-light-blueprint", "Light blueprint", tile("#eaf1ff") + GL + `<ellipse cx="12" cy="12.5" rx="7.5" ry="6.5" fill="#567bf7" fill-opacity=".25" stroke="#567bf7" stroke-width="1"/><ellipse cx="20.5" cy="20" rx="7.5" ry="6.5" fill="#2fb8a0" fill-opacity=".25" stroke="#1f9a85" stroke-width="1"/><path d="M9.5 10.5L16 16.5L22.5 21.5" fill="none" stroke="#123458" stroke-opacity=".7" stroke-width="1.4"/><circle cx="9.5" cy="10.5" r="2.3" fill="#123458"/><circle cx="16" cy="16.5" r="2.3" fill="#123458"/><circle cx="22.5" cy="21.5" r="2.3" fill="#123458"/>`],
  // Round 3: variants of 5d
  ["round3", "d1-solid-bolder", "Solid, bolder", BG() + `<circle cx="13.5" cy="13.5" r="9" fill="#567bf7" fill-opacity=".55"/>` + inner + `<path d="M16 16.5L25 24.5" stroke="${A}" stroke-width="2.4" stroke-linecap="round"/><circle cx="10.5" cy="10.5" r="2.4" fill="${W}"/><circle cx="10.5" cy="18.5" r="2.4" fill="${W}"/><circle cx="16" cy="16.5" r="2.6" fill="${W}"/><circle cx="25" cy="24.5" r="3" fill="${A}"/>`],
  ["round3", "d2-ripple", "Ripple", BG() + `<circle cx="13" cy="13" r="8.5" fill="#567bf7" fill-opacity=".5"/><path d="M10 10L15.5 15.5M10 17.5L15.5 15.5M10 10V17.5" stroke="#fff" stroke-opacity=".7" stroke-width="1.4"/><path d="M15.5 15.5L23.5 23.5" stroke="${A}" stroke-width="2" stroke-linecap="round"/><circle cx="23.5" cy="23.5" r="5" fill="none" stroke="${A}" stroke-opacity=".45" stroke-width="1.2"/><circle cx="10" cy="10" r="2.2" fill="${W}"/><circle cx="10" cy="17.5" r="2.2" fill="${W}"/><circle cx="15.5" cy="15.5" r="2.5" fill="${W}"/><circle cx="23.5" cy="23.5" r="2.7" fill="${A}"/>`],
  ["round3", "d3-area-to-area", "Area to area", BG() + `<circle cx="11.5" cy="11.5" r="7.5" fill="#567bf7" fill-opacity=".55"/><circle cx="23" cy="23" r="6" fill="#2fb8a0" fill-opacity=".45"/><path d="M8.5 8.5L14 13.5M8.5 15L14 13.5M8.5 8.5V15" stroke="#fff" stroke-opacity=".7" stroke-width="1.3"/><path d="M14 13.5L23 23" stroke="${A}" stroke-width="2" stroke-linecap="round"/><circle cx="8.5" cy="8.5" r="2.1" fill="${W}"/><circle cx="8.5" cy="15" r="2.1" fill="${W}"/><circle cx="14" cy="13.5" r="2.4" fill="${W}"/><circle cx="23" cy="23" r="2.7" fill="${A}"/>`],
  ["round3", "d4-broken-boundary", "Broken boundary", BG() + `<circle cx="13.5" cy="13.5" r="9" fill="#567bf7" fill-opacity=".35"/><path d="M18.4 21.05A9 9 0 1 1 21.05 18.4" fill="none" stroke="#9db6ff" stroke-width="1.3"/>` + inner + `<path d="M16 16.5L25 24.5" stroke="${A}" stroke-width="2" stroke-linecap="round"/><circle cx="10.5" cy="10.5" r="2.2" fill="${W}"/><circle cx="10.5" cy="18.5" r="2.2" fill="${W}"/><circle cx="16" cy="16.5" r="2.5" fill="${W}"/><circle cx="25" cy="24.5" r="2.8" fill="${A}"/>`],
  ["round3", "d5-fan-out", "Fan-out", BG() + `<circle cx="12" cy="15" r="8.5" fill="#567bf7" fill-opacity=".5"/><path d="M8.5 11.5L14.5 16M8.5 19L14.5 16" stroke="#fff" stroke-opacity=".7" stroke-width="1.3"/><path d="M14.5 16L25 8M14.5 16L24.5 25" stroke="${A}" stroke-width="1.8" stroke-linecap="round"/><circle cx="8.5" cy="11.5" r="2.1" fill="${W}"/><circle cx="8.5" cy="19" r="2.1" fill="${W}"/><circle cx="14.5" cy="16" r="2.7" fill="${A}"/><circle cx="25" cy="8" r="2.4" fill="${A}"/><circle cx="24.5" cy="25" r="2.4" fill="${A}"/>`],
  ["round3", "d6-minimal", "Minimal", BG() + `<circle cx="13" cy="13" r="8.5" fill="#567bf7" fill-opacity=".55"/><path d="M13 13L24 24" stroke="${A}" stroke-width="2.4" stroke-linecap="round"/><circle cx="13" cy="13" r="3.2" fill="${W}"/><circle cx="24" cy="24" r="3.2" fill="${A}"/>`],
  ["round3", "d7-card-area", "Card area", BG() + `<rect x="4" y="4" width="16.5" height="16.5" rx="4" fill="#567bf7" fill-opacity=".4" stroke="#9db6ff" stroke-width="1" stroke-dasharray="2 1.5"/>` + cardNodes(W) + `<path d="M15.5 15.5L25 25" stroke="${A}" stroke-width="2" stroke-linecap="round"/><circle cx="25" cy="25" r="2.8" fill="${A}"/>`],
  ["round3", "d8-hollow-target", "Hollow target", BG() + `<circle cx="13.5" cy="13.5" r="9" fill="#567bf7" fill-opacity=".5"/>` + inner + `<path d="M16 16.5L22.8 22.5" stroke="${A}" stroke-width="2" stroke-linecap="round"/><circle cx="10.5" cy="10.5" r="2.3" fill="${W}"/><circle cx="10.5" cy="18.5" r="2.3" fill="${W}"/><circle cx="16" cy="16.5" r="2.5" fill="${W}"/><circle cx="25" cy="24.5" r="2.7" fill="#123458" stroke="${A}" stroke-width="1.8"/>`],
  ["round3", "d9-light", "Light", tile("#eaf1ff") + GL + `<circle cx="13.5" cy="13.5" r="9" fill="#567bf7" fill-opacity=".25" stroke="#567bf7" stroke-width="1" stroke-dasharray="2 1.5"/><path d="M10.5 10.5L16 16.5M10.5 18.5L16 16.5M10.5 10.5V18.5" stroke="#123458" stroke-opacity=".6" stroke-width="1.4"/><path d="M16 16.5L25 24.5" stroke="#d9901a" stroke-width="2.2" stroke-linecap="round"/><circle cx="10.5" cy="10.5" r="2.3" fill="#123458"/><circle cx="10.5" cy="18.5" r="2.3" fill="#123458"/><circle cx="16" cy="16.5" r="2.5" fill="#123458"/><circle cx="25" cy="24.5" r="3" fill="#d9901a"/>`],
  // Round 4: card area + hollow target + ripple
  ["round4", "A-straight-combo", "A · Straight combo (chosen)", comboA()],
  ["round4", "B-solid-card-two-rings", "B · Solid card, two rings", BG() + card(0.55, 0) + cardNodes(W) + `<circle cx="24.5" cy="24.5" r="6.6" fill="none" stroke="${A}" stroke-opacity=".22" stroke-width="1"/><circle cx="24.5" cy="24.5" r="4.6" fill="none" stroke="${A}" stroke-opacity=".5" stroke-width="1"/><path d="M15.5 15.5L21.9 21.9" stroke="${A}" stroke-width="2" stroke-linecap="round"/><circle cx="24.5" cy="24.5" r="2.5" fill="${N}" stroke="${A}" stroke-width="1.8"/>`],
  ["round4", "C-dashed-ripple", "C · Dashed ripple", BG() + card(0.45, 0) + cardNodes(W) + `<circle cx="24.5" cy="24.5" r="5.4" fill="none" stroke="${A}" stroke-opacity=".7" stroke-width="1" stroke-dasharray="2 1.5"/><path d="M15.5 15.5L21.9 21.9" stroke="${A}" stroke-width="2" stroke-linecap="round"/><circle cx="24.5" cy="24.5" r="2.7" fill="${N}" stroke="${A}" stroke-width="1.8"/>`],
  ["round4", "D-outward-arcs", "D · Outward arcs", BG() + card(0.45, 1) + cardNodes(W) + `<path d="M28.23 22.67A4.8 4.8 0 0 1 22.67 28.23" fill="none" stroke="${A}" stroke-opacity=".6" stroke-width="1.3" stroke-linecap="round"/><path d="M30.39 22.28A7 7 0 0 1 22.28 30.39" fill="none" stroke="${A}" stroke-opacity=".3" stroke-width="1.3" stroke-linecap="round"/><path d="M15.5 15.5L21 21" stroke="${A}" stroke-width="2" stroke-linecap="round"/><circle cx="23.5" cy="23.5" r="2.6" fill="${N}" stroke="${A}" stroke-width="1.8"/>`],
  ["round4", "E-light", "E · Light", tile("#eaf1ff") + GL + `<rect x="4" y="4" width="16.5" height="16.5" rx="4" fill="#567bf7" fill-opacity=".22" stroke="#567bf7" stroke-width="1" stroke-dasharray="2 1.5"/>` + cardNodes(N) + `<circle cx="24.5" cy="24.5" r="5.2" fill="none" stroke="#d9901a" stroke-opacity=".45" stroke-width="1.1"/><path d="M15.5 15.5L21.9 21.9" stroke="#d9901a" stroke-width="2" stroke-linecap="round"/><circle cx="24.5" cy="24.5" r="2.7" fill="#eaf1ff" stroke="#d9901a" stroke-width="1.8"/>`],
];

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">\n  ${body}\n</svg>\n`;
const out = repo + "/docs/testing/logos";
const rounds = {
  round1: "Round 1 — broad directions",
  round2: "Round 2 — variants of 5 (blueprint areas)",
  round3: "Round 3 — variants of 5d (impact crossing)",
  round4: "Round 4 — card area + hollow target + ripple",
};
for (const r of Object.keys(rounds)) mkdirSync(`${out}/${r}`, { recursive: true });
for (const [r, file, , body] of logos) writeFileSync(`${out}/${r}/${file}.svg`, svg(body));

// Contact sheet: every logo at 96/32/16px, grouped by round.
const sections = Object.entries(rounds).map(([r, title]) => {
  const cards = logos.filter((l) => l[0] === r).map(([, file, label]) => {
    const src = `${r}/${file}.svg`;
    return `<figure><div class="sizes"><img src="${src}" width="96" height="96" alt=""><div><img src="${src}" width="32" height="32" alt=""><img src="${src}" width="16" height="16" alt=""></div></div><figcaption>${label}</figcaption></figure>`;
  }).join("\n      ");
  return `  <h2>${title}</h2>\n    <div class="grid">\n      ${cards}\n    </div>`;
}).join("\n");
writeFileSync(`${out}/index.html`, `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GraphReview logos</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 1100px; padding: 24px 16px; background: Canvas; color: CanvasText; }
  h2 { font-size: 16px; font-weight: 500; margin: 32px 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
  figure { margin: 0; padding: 16px; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 12px; }
  .sizes { display: flex; gap: 12px; align-items: center; }
  .sizes div { display: flex; flex-direction: column; gap: 8px; }
  figcaption { margin-top: 10px; font-size: 13px; opacity: .7; }
</style>
<h1 style="font-size:20px;font-weight:500">GraphReview logo explorations</h1>
<p style="opacity:.7">Round 4 option A is the one wired into the app (app/icon.svg, favicon.ico, apple-icon.png, header mark).</p>
${sections}
`);

// App icons from option A.
writeFileSync(repo + "/app/icon.svg", svg(comboA()));
await sharp(Buffer.from(svg(comboA(0))), { density: 1200 }).resize(180, 180).png().toFile(repo + "/app/apple-icon.png");
const pngs = await Promise.all([16, 32, 48].map((n) =>
  sharp(Buffer.from(svg(comboA())), { density: 1200 }).resize(n, n).png().toBuffer().then((b) => [n, b])));
// ICO container: header, one directory entry per size, then the PNGs.
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
let offset = 6 + 16 * pngs.length;
const dir = pngs.map(([n, b]) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(n, 0); e.writeUInt8(n, 1); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(b.length, 8); e.writeUInt32LE(offset, 12); offset += b.length;
  return e;
});
writeFileSync(repo + "/app/favicon.ico", Buffer.concat([header, ...dir, ...pngs.map(([, b]) => b)]));
console.log(`wrote ${logos.length} logos`);
