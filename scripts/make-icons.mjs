// Draws the extension icons (src/icons/icon-<size>.png) from the popup's own
// burst, colours and title font. Run: node scripts/make-icons.mjs
// Needs a Chromium for playwright-core (CHROMIUM_PATH, or its cached "chromium").
import { chromium } from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "src/icons");
const font = (await readFile(resolve(root, "src/popup/fonts/DelaGothicOne-400.woff2"))).toString("base64");

// Same polygon as the popup's power button (src/popup/popup.html).
const BURST = "100,8 118,52 162,26 146,72 194,78 152,104 186,142 138,138 140,188 106,154 82,194 72,148 26,170 48,128 6,108 52,90 22,46 72,58 78,12";

// size: file size in px. art: how much of it the drawing fills (the store asks
// for 96px of artwork on the 128px canvas). outline: burst outline, in burst
// units. letter: the S's outline; 0 draws a plain ink S, which is all that
// survives at toolbar size.
const SIZES = [
  { size: 16, art: 16, outline: 9, letter: 0 },
  { size: 32, art: 32, outline: 7, letter: 9 },
  { size: 48, art: 48, outline: 6, letter: 8 },
  { size: 128, art: 96, outline: 5, letter: 7 },
];

function page({ size, art, outline, letter }) {
  const pad = (size - art) / 2;
  return `<!doctype html><style>
    @font-face { font-family: "Dela"; src: url(data:font/woff2;base64,${font}) format("woff2"); }
    html, body { margin: 0; background: transparent; }
    svg { display: block; position: absolute; left: ${pad}px; top: ${pad}px; width: ${art}px; height: ${art}px; }
  </style>
  <svg viewBox="-4 -4 208 208" xmlns="http://www.w3.org/2000/svg">
    <polygon points="${BURST}" fill="#ffe14d" stroke="#111" stroke-width="${outline}" stroke-linejoin="round" />
    <text x="100" y="${letter ? 138 : 143}" text-anchor="middle" transform="rotate(-8 100 100)"
      font-family="Dela" font-size="${letter ? 104 : 118}" fill="${letter ? "#ff3b6b" : "#111"}" stroke="#111" stroke-width="${letter}"
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
