// Draws the extension icons (src/icons/icon-<size>.png) from the popup's own
// burst, colours and title font. Run: node scripts/make-icons.mjs
// Needs a Chromium for playwright-core (CHROMIUM_PATH, or its cached "chromium").
import { chromium } from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "src/icons");
const font = (await readFile(resolve(root, "src/popup/fonts/DelaGothicOne-400.woff2"))).toString("base64");

// Fuller burst for small icon slots: same 10-point Manga Pop silhouette as the
// popup burst, with shallower valleys so the yellow core and "S" read much
// larger next to other browser toolbar icons.
const BURST = "100,4 122,36 168,18 160,64 198,76 168,108 192,150 148,152 144,196 108,168 78,196 64,158 18,176 36,132 2,108 38,84 14,38 64,46 74,6";

// size: file size in px. art: how much of it the drawing fills (the 128px store
// icon leaves an 8px margin for the spikes while its core fills ~96px).
// outline: burst outline, in burst units. letter: the S's outline; 0 draws a
// plain ink S, which is all that survives at 16px toolbar size.
const SIZES = [
  { size: 16, art: 16, outline: 10, letter: 0, font: 146, y: 152 },
  { size: 32, art: 32, outline: 8, letter: 10, font: 132, y: 146 },
  { size: 48, art: 48, outline: 7, letter: 9, font: 130, y: 146 },
  { size: 128, art: 114, outline: 6, letter: 8, font: 126, y: 144 },
];

function page({ size, art, outline, letter, font: fontSize, y }) {
  const pad = (size - art) / 2;
  return `<!doctype html><style>
    @font-face { font-family: "Dela"; src: url(data:font/woff2;base64,${font}) format("woff2"); }
    html, body { margin: 0; background: transparent; }
    svg { display: block; position: absolute; left: ${pad}px; top: ${pad}px; width: ${art}px; height: ${art}px; }
  </style>
  <svg viewBox="-2 -1 204 202" xmlns="http://www.w3.org/2000/svg">
    <polygon points="${BURST}" fill="#ffe14d" stroke="#111" stroke-width="${outline}" stroke-linejoin="round" />
    <text x="100" y="${y}" text-anchor="middle" transform="rotate(-7 100 100)"
      font-family="Dela" font-size="${fontSize}" fill="${letter ? "#ff3b6b" : "#111"}" stroke="#111" stroke-width="${letter}"
      stroke-linejoin="round" paint-order="stroke">S</text>
  </svg>`;
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  channel: process.env.CHROMIUM_PATH ? undefined : "chromium",
});
try {
  for (const spec of SIZES) {
    const tab = await browser.newPage({ viewport: { width: spec.size, height: spec.size }, deviceScaleFactor: 1 });
    await tab.setContent(page(spec));
    await tab.evaluate(() => document.fonts.ready);
    await writeFile(resolve(out, `icon-${spec.size}.png`), await tab.screenshot({ omitBackground: true }));
    await tab.close();
  }
} finally {
  await browser.close();
}
console.log(`Wrote ${SIZES.map(spec => `icon-${spec.size}.png`).join(", ")} to ${out}`);
