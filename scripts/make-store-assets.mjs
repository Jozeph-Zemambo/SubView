// Draws the Chrome Web Store images (small promo tile and four screenshots)
// from the popup's own markup, styles, fonts and burst. Every scene is original
// SVG; the site is a placeholder (stream.example).
// Run: node scripts/make-store-assets.mjs [extra-output-dir ...]
// Writes opaque PNGs (no alpha channel) to release/store-assets/ and to any
// extra directories given. Needs a Chromium for playwright-core (CHROMIUM_PATH,
// or its cached "chromium"), like make-icons.mjs.
import { chromium } from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const outDirs = [resolve(root, "release/store-assets"), ...process.argv.slice(2).map(dir => resolve(dir))];
const fontData = async file => (await readFile(resolve(root, "src/popup/fonts", file))).toString("base64");
const FONTS = `
  @font-face { font-family: "Dela Gothic One"; src: url(data:font/woff2;base64,${await fontData("DelaGothicOne-400.woff2")}) format("woff2"); font-weight: 400; }
  @font-face { font-family: "Zen Kaku Gothic New"; src: url(data:font/woff2;base64,${await fontData("ZenKakuGothicNew-500.woff2")}) format("woff2"); font-weight: 500; }
  @font-face { font-family: "Zen Kaku Gothic New"; src: url(data:font/woff2;base64,${await fontData("ZenKakuGothicNew-900.woff2")}) format("woff2"); font-weight: 900; }`;

// Same polygon as the popup's power button (src/popup/popup.html).
const BURST = "100,8 118,52 162,26 146,72 194,78 152,104 186,142 138,138 140,188 106,154 82,194 72,148 26,170 48,128 6,108 52,90 22,46 72,58 78,12";
// Manga Pop (src/popup/popup.css).
const C = { ink: "#111", paper: "#fffaf0", pink: "#ff3b6b", yellow: "#ffe14d", blue: "#8ee8ff", night: "#1b1918", cream: "#f1e7d6", muted: "#6b6560", nightMuted: "#8a7f73", nightPanel: "#24211f" };
const SITE = "stream.example";
const TITLE = "var(--title)";
const BODY = "var(--body)";
// The fonts above are Latin only; Japanese signage falls back to a system face.
const JP = `"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", "Yu Gothic", sans-serif`;

const BASE_CSS = `${FONTS}
  :root { --title: "Dela Gothic One", "Avenir Next", sans-serif; --body: "Zen Kaku Gothic New", "Avenir Next", sans-serif; }
  * { box-sizing: border-box; }
  html, body { margin: 0; overflow: hidden; }
  body { position: relative; font: 500 16px/1.4 ${BODY}; }
  .tone { position: absolute; inset: 0; pointer-events: none; }
  img { display: block; }`;

/** The extension icon's burst with its S (as in make-icons.mjs at 128 px). */
function burstIcon(size, { outline = 5, letter = 7 } = {}) {
  return `<svg width="${size}" height="${size}" viewBox="-4 -4 208 208" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
    <polygon points="${BURST}" fill="${C.yellow}" stroke="${C.ink}" stroke-width="${outline}" stroke-linejoin="round" />
    <text x="100" y="138" text-anchor="middle" transform="rotate(-8 100 100)" font-family="Dela Gothic One" font-size="104"
      fill="${C.pink}" stroke="${C.ink}" stroke-width="${letter}" stroke-linejoin="round" paint-order="stroke">S</text>
  </svg>`;
}

// ---------------------------------------------------------------- PNG output

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/** Re-encode a screenshot as 24-bit RGB: the store wants images without an alpha channel. */
function opaquePng(png) {
  let pos = 8, header = null;
  const data = [];
  while (pos < png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString("latin1", pos + 4, pos + 8);
    const body = png.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") header = body;
    else if (type === "IDAT") data.push(body);
    pos += 12 + length;
  }
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4), colorType = header[9];
  if (header[8] !== 8 || ![2, 6].includes(colorType) || header[12] !== 0) throw new Error("Unexpected PNG format from the browser.");
  const bpp = colorType === 6 ? 4 : 3, stride = width * bpp;
  const raw = inflateSync(Buffer.concat(data));
  const out = Buffer.alloc((width * 3 + 1) * height);
  let previous = new Uint8Array(stride), seeThrough = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = previous[i], c = i >= bpp ? previous[i - bpp] : 0;
      if (filter === 1) line[i] += a;
      else if (filter === 2) line[i] += b;
      else if (filter === 3) line[i] += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        line[i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
    }
    const row = y * (width * 3 + 1);
    out[row] = 1; // "Sub" filter: each byte minus the same channel one pixel left.
    for (let x = 0; x < width; x++) {
      if (bpp === 4 && line[x * 4 + 3] !== 255) seeThrough += 1;
      for (let ch = 0; ch < 3; ch++) {
        const value = line[x * bpp + ch], left = x > 0 ? line[(x - 1) * bpp + ch] : 0;
        out[row + 1 + x * 3 + ch] = (value - left) & 255;
      }
    }
    previous = line;
  }
  if (seeThrough) throw new Error(`${seeThrough} see-through pixels; every page must paint an opaque background.`);
  const rgbHeader = Buffer.from(header);
  rgbHeader[9] = 2;
  return Buffer.concat([png.subarray(0, 8), pngChunk("IHDR", rgbHeader), pngChunk("IDAT", deflateSync(out, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- the real popup

/**
 * The popup's own page (src/popup/popup.html + popup.css), filled in the way
 * popup.ts would for one state, at 2x. Returns the image and where its controls are.
 */
async function popupShot(browser, scheme, fill) {
  const tab = await browser.newPage({ viewport: { width: 400, height: 1000 }, deviceScaleFactor: 2, colorScheme: scheme });
  await tab.goto(pathToFileURL(resolve(root, "src/popup/popup.html")).href);
  const boxes = await tab.evaluate(fill => {
    const $ = id => document.getElementById(id);
    document.body.dataset.state = fill.state;
    $("site").textContent = fill.site;
    $("power-label").textContent = fill.word;
    $("tally-text").textContent = fill.tally;
    $("status").textContent = fill.status;
    $("power").setAttribute("aria-pressed", "true");
    $("server").textContent = fill.server;
    $("server").classList.toggle("dim", fill.dim);
    $("source").textContent = fill.source;
    $("source").classList.toggle("dim", fill.dim);
    $("volume").value = String(fill.volume);
    $("volume-out").value = `${fill.volume}%`;
    $("mute").setAttribute("aria-checked", String(fill.mute));
    $("offset").value = String(fill.offset);
    $("auto-offset").setAttribute("aria-checked", String(fill.autoOffset));
    $("auto-reload").setAttribute("aria-checked", String(fill.autoReload));
    $("use-tab").hidden = !fill.useTab;
    $("reload").hidden = true;
    const body = document.body.getBoundingClientRect();
    const box = element => {
      const r = element.getBoundingClientRect();
      return { x: r.left - body.left, y: r.top - body.top, w: r.width, h: r.height };
    };
    const row = id => box($(id).closest(".control"));
    return {
      width: body.width, height: body.height,
      power: box($("power")), status: box($("status")), useTab: box($("use-tab")), panels: box(document.querySelector(".panels")),
      volume: row("volume"), mute: row("mute"), offset: row("offset"), nudge: box(document.querySelector(".nudge")),
      autoOffset: row("auto-offset"), autoReload: row("auto-reload"),
      muteSwitch: box($("mute")), autoOffsetSwitch: box($("auto-offset")), autoReloadSwitch: box($("auto-reload")),
    };
  }, { ...fill, site: SITE });
  await tab.evaluate(() => document.fonts.ready);
  const png = await (await tab.$("body")).screenshot({ animations: "disabled" });
  await tab.close();
  return { src: `data:image/png;base64,${png.toString("base64")}`, ...boxes };
}

/** The Debug tools page (src/popup/debug.html + debug.css) set up for Two tabs, at 2x. */
async function debugShot(browser) {
  const tab = await browser.newPage({ viewport: { width: 390, height: 1400 }, deviceScaleFactor: 2, colorScheme: "light" });
  await tab.goto(pathToFileURL(resolve(root, "src/popup/debug.html")).href);
  const layout = await tab.evaluate(site => {
    const $ = id => document.getElementById(id);
    const options = (select, labels, chosen = 0) => {
      select.replaceChildren(...labels.map((label, index) => new Option(label, String(index + 1), index === chosen, index === chosen)));
      select.disabled = false;
    };
    document.querySelector(".popup-shell").style.maxHeight = "none";
    $("sync-mode").value = "two-tabs";
    // As debug.ts renders Two tabs mode (renderModeFields / renderControls).
    $("background-secondary").hidden = true;
    $("auto-dub-section").hidden = true;
    $("two-tab-secondary").hidden = false;
    $("swap-row").hidden = false;
    $("swap-tabs").disabled = false;
    options($("primary-tab"), [`Episode 04 — Original (Sub) — ${site}`, `Episode 04 — Dubbed Audio — ${site}`], 0);
    options($("secondary-tab"), [`Episode 04 — Original (Sub) — ${site}`, `Episode 04 — Dubbed Audio — ${site}`], 1);
    options($("primary-video"), ["Video 1 — 23:40"]);
    options($("secondary-video"), ["Video 1 — 23:40"]);
    $("primary-video-message").textContent = "1 video found.";
    $("secondary-video-message").textContent = "1 video found.";
    $("primary-rescan").hidden = false;
    $("secondary-rescan").hidden = false;
    $("language-detection-state").textContent = "Detected";
    $("language-detection-summary").textContent = "Sub detected · Dub available";
    $("offset").value = "+00:00:00.500";
    $("start-sync").disabled = false;
    $("stop-sync").disabled = true;
    $("sync-status").dataset.tone = "neutral";
    $("status-label").textContent = "Ready";
    $("status-message").textContent = "Choose two tabs and videos, then start sync.";
    const shell = document.querySelector(".popup-shell").getBoundingClientRect();
    const top = element => element.getBoundingClientRect().top - shell.top;
    return { width: shell.width, height: shell.height, split: top(document.querySelector(".offset-section")) };
  }, SITE);
  await tab.evaluate(() => document.fonts.ready);
  const shell = await tab.$(".popup-shell");
  const png = await shell.screenshot({ animations: "disabled" });
  await tab.close();
  return { src: `data:image/png;base64,${png.toString("base64")}`, ...layout };
}

// ---------------------------------------------------------------- an original scene

function random(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

/** A cel-shaded street at night or at dusk, with a vertical shop sign and its translation. */
function scene(kind) {
  const night = kind === "night";
  const r = random(night ? 7 : 23);
  const sky = night
    ? [["0", "#120c2b"], ["0.45", "#2b1650"], ["0.78", "#6a2767"], ["1", "#d2537a"]]
    : [["0", "#2e2a6e"], ["0.35", "#7a3f8c"], ["0.66", "#ef6f7d"], ["1", "#ffc56b"]];
  const far = night ? "#2c1f52" : "#6a3a79";
  const mid = night ? "#1a1233" : "#3a2150";
  const front = night ? "#0d0a1a" : "#1f1230";
  const windowLit = night ? "#ffd36b" : "#ffe2a3";
  const neon = night ? "#ff5fa2" : "#8ee8ff";
  const sign = night ? ["ラ", "ー", "メ", "ン"] : ["本", "屋"];
  const signLabel = night ? "LATE-NIGHT RAMEN" : "CORNER BOOKSHOP";
  let svg = `<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;height:100%">
    <defs>
      <linearGradient id="sky-${kind}" x1="0" y1="0" x2="0" y2="1">${sky.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>
      <radialGradient id="vignette-${kind}" cx="0.5" cy="0.45" r="0.75"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></radialGradient>
      <filter id="glow-${kind}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <rect width="1600" height="900" fill="url(#sky-${kind})"/>`;
  if (night) {
    for (let i = 0; i < 80; i++) svg += `<circle cx="${(r() * 1600).toFixed(0)}" cy="${(r() * 430).toFixed(0)}" r="${(0.8 + r() * 1.8).toFixed(1)}" fill="#fff" opacity="${(0.35 + r() * 0.6).toFixed(2)}"/>`;
    svg += `<circle cx="1180" cy="170" r="150" fill="#fff1c9" opacity="0.10"/><circle cx="1180" cy="170" r="86" fill="#fff1c9"/><circle cx="1150" cy="150" r="14" fill="#f1dca8"/><circle cx="1205" cy="195" r="9" fill="#f1dca8"/>`;
  } else {
    svg += `<circle cx="1050" cy="600" r="230" fill="#ffe7a0" opacity="0.18"/><circle cx="1050" cy="600" r="130" fill="#ffe7a0"/>`;
    for (let i = 0; i < 5; i++) svg += `<rect x="${(r() * 1400).toFixed(0)}" y="${(90 + i * 70).toFixed(0)}" width="${(160 + r() * 260).toFixed(0)}" height="10" rx="5" fill="#ffd2c2" opacity="0.35"/>`;
  }
  // Far skyline.
  for (let x = -20; x < 1620;) {
    const w = 60 + r() * 90, h = 170 + r() * 230;
    svg += `<rect x="${x.toFixed(0)}" y="${(720 - h).toFixed(0)}" width="${w.toFixed(0)}" height="${(h + 10).toFixed(0)}" fill="${far}"/>`;
    x += w + 4;
  }
  // Middle buildings, with windows.
  for (let x = -40; x < 1640;) {
    const w = 110 + r() * 110, h = 130 + r() * 230, top = 770 - h;
    svg += `<rect x="${x.toFixed(0)}" y="${top.toFixed(0)}" width="${w.toFixed(0)}" height="${(h + 10).toFixed(0)}" fill="${mid}"/>`;
    for (let wy = top + 22; wy < 735; wy += 30) {
      for (let wx = x + 14; wx < x + w - 18; wx += 24) {
        if (r() < 0.32) svg += `<rect x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="11" height="15" fill="${windowLit}" opacity="${(0.65 + r() * 0.35).toFixed(2)}"/>`;
      }
    }
    x += w + 10;
  }
  if (night) {
    // An elevated railway with a lit train.
    svg += `<rect x="0" y="642" width="1600" height="14" fill="#0f0b20"/>`;
    for (let x = 30; x < 1600; x += 210) svg += `<rect x="${x}" y="652" width="16" height="120" fill="#0f0b20"/>`;
    svg += `<rect x="700" y="590" width="760" height="54" rx="10" fill="#2b2650"/><rect x="700" y="630" width="760" height="6" fill="${C.pink}" opacity="0.8"/>`;
    for (let x = 724; x < 1440; x += 46) svg += `<rect x="${x}" y="602" width="30" height="20" rx="3" fill="#fff3c4" opacity="${(0.75 + r() * 0.25).toFixed(2)}"/>`;
  }
  // Power lines and a pole: the street's foreground.
  svg += `<g stroke="${front}" stroke-width="3" fill="none">
      <path d="M -20 200 Q 700 330 1392 196"/><path d="M -20 238 Q 700 372 1392 236"/><path d="M -20 276 Q 720 410 1392 276"/>
      <path d="M 1392 196 Q 1500 236 1640 214"/><path d="M 1392 236 Q 1500 276 1640 258"/>
    </g>
    <rect x="1380" y="160" width="22" height="760" fill="${front}"/><rect x="1330" y="188" width="122" height="12" fill="${front}"/><rect x="1342" y="228" width="98" height="10" fill="${front}"/>
    <rect x="0" y="770" width="1600" height="130" fill="${front}"/>
    <rect x="0" y="826" width="1600" height="6" fill="#ffffff" opacity="0.07"/>`;
  // The shop with its vertical sign, lanterns and curtain.
  svg += `<rect x="60" y="430" width="470" height="350" fill="${night ? "#231736" : "#3d2252"}"/>
    <rect x="60" y="430" width="470" height="26" fill="${night ? "#2f1f47" : "#4e2c66"}"/>
    <rect x="96" y="560" width="396" height="210" fill="${night ? "#ffcf86" : "#ffe0a8"}" opacity="0.92"/>
    <g fill="${night ? "#c8323f" : "#2f6cb3"}">${[0, 1, 2, 3, 4].map(i => `<rect x="${104 + i * 78}" y="560" width="72" height="92"/>`).join("")}</g>
    <g fill="#fff" opacity="0.9" font-family='${JP}' font-weight="700" font-size="40" text-anchor="middle">${(night ? ["中", "華", "そ", "ば", "屋"] : ["古", "本", "あ", "り", "ま"]).map((ch, i) => `<text x="${140 + i * 78}" y="622">${ch}</text>`).join("")}</g>
    <g filter="url(#glow-${kind})">
      <ellipse cx="96" cy="560" rx="26" ry="36" fill="${night ? "#ff4d4d" : "#ff8a5c"}"/><ellipse cx="494" cy="560" rx="26" ry="36" fill="${night ? "#ff4d4d" : "#ff8a5c"}"/>
      <rect x="560" y="196" width="86" height="${60 + sign.length * 74}" rx="10" fill="#1b1030" stroke="${neon}" stroke-width="7"/>
    </g>
    <g font-family='${JP}' font-weight="800" font-size="60" fill="#fff" text-anchor="middle" filter="url(#glow-${kind})">
      ${sign.map((ch, i) => `<text x="603" y="${278 + i * 74}">${ch}</text>`).join("")}
    </g>
    <text x="670" y="214" font-family="Zen Kaku Gothic New" font-weight="900" font-size="26" letter-spacing="3" fill="#fff6d8" stroke="#2a0d24" stroke-width="7" paint-order="stroke" transform="rotate(90 670 214)">${signLabel}</text>
    <rect width="1600" height="900" fill="url(#vignette-${kind})"/>
  </svg>`;
  return svg;
}

const ICON = {
  pause: `<svg viewBox="0 0 24 24" width="22" height="22"><rect x="6" y="5" width="4" height="14" rx="1" fill="#fff"/><rect x="14" y="5" width="4" height="14" rx="1" fill="#fff"/></svg>`,
  next: `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 5l9 7-9 7z" fill="#fff"/><rect x="16" y="5" width="3" height="14" rx="1" fill="#fff"/></svg>`,
  volume: `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 9h4l5-4v14l-5-4H4z" fill="#fff"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
  cc: `<svg viewBox="0 0 24 24" width="24" height="22"><rect x="2.5" y="5" width="19" height="14" rx="3" fill="none" stroke="#fff" stroke-width="2"/><text x="12" y="15.5" text-anchor="middle" font-family="Zen Kaku Gothic New" font-weight="900" font-size="8" fill="#fff">CC</text></svg>`,
  gear: `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="#fff" d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>`,
  full: `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>`,
};

/** A browser window around a made-up player page on stream.example. */
function playerWindow({ dark, kind, width, subtitles, played, time, menu = "", below = "" }) {
  const videoHeight = Math.round(width * 9 / 16);
  const bar = dark ? "#2b2826" : "#e9e2d4";
  const pill = dark ? "#1b1918" : "#fffaf0";
  const text = dark ? C.cream : C.ink;
  const muted = dark ? C.nightMuted : C.muted;
  return `<div class="window" style="width:${width}px;border:3px solid ${dark ? "#000" : C.ink};background:${dark ? "#151312" : "#fff"};box-shadow:${dark ? "8px 8px 0 #000" : `8px 8px 0 ${C.ink}`}">
    <div style="display:flex;align-items:center;gap:14px;height:44px;padding:0 14px;background:${bar};border-bottom:3px solid ${dark ? "#000" : C.ink}">
      <span style="display:flex;gap:7px">${[0, 1, 2].map(() => `<i style="width:12px;height:12px;border-radius:50%;background:${dark ? "#4a4542" : "#c9c0b0"};display:block"></i>`).join("")}</span>
      <span style="flex:1;display:flex;align-items:center;gap:8px;height:28px;padding:0 12px;border-radius:14px;background:${pill};color:${muted};font:500 14px/1 ${BODY}">
        <svg width="12" height="14" viewBox="0 0 12 14"><rect x="1" y="6" width="10" height="7.5" rx="1.5" fill="${muted}"/><path d="M3.2 6V4.2a2.8 2.8 0 0 1 5.6 0V6" stroke="${muted}" stroke-width="1.6" fill="none"/></svg>
        <span><b style="color:${text};font-weight:900">${SITE}</b>/watch/episode-04</span>
      </span>
    </div>
    <div style="position:relative;height:${videoHeight}px;overflow:hidden;background:#000">
      ${scene(kind)}
      <div style="position:absolute;left:0;right:0;bottom:64px;text-align:center;color:#fff;font:900 ${Math.round(width / 34)}px/1.32 ${BODY};
        text-shadow:0 0 3px #000,0 0 3px #000,2px 2px 0 #000,-2px -2px 0 #000,2px -2px 0 #000,-2px 2px 0 #000,0 2px 0 #000,0 -2px 0 #000,2px 0 0 #000,-2px 0 0 #000">
        ${subtitles.map(line => `<div>${line}</div>`).join("")}
      </div>
      <div style="position:absolute;left:0;right:0;bottom:0;height:120px;background:linear-gradient(transparent,rgba(0,0,0,.72))"></div>
      <div style="position:absolute;left:18px;right:18px;bottom:46px;height:5px;border-radius:3px;background:rgba(255,255,255,.28)">
        <div style="position:absolute;left:0;top:0;bottom:0;width:${Math.min(100, played + 9)}%;border-radius:3px;background:rgba(255,255,255,.45)"></div>
        <div style="position:absolute;left:0;top:0;bottom:0;width:${played}%;border-radius:3px;background:${C.pink}"></div>
        <div style="position:absolute;left:calc(${played}% - 7px);top:-4.5px;width:14px;height:14px;border-radius:50%;background:${C.pink};border:2px solid #fff"></div>
      </div>
      <div style="position:absolute;left:18px;right:18px;bottom:10px;height:28px;display:flex;align-items:center;gap:16px;color:#fff;font:900 14px/1 ${BODY}">
        ${ICON.pause}${ICON.next}${ICON.volume}<span style="letter-spacing:.02em">${time}</span>
        <span style="margin-left:auto;display:flex;gap:16px;align-items:center">${ICON.cc}${ICON.gear}${ICON.full}</span>
      </div>
      ${menu}
    </div>
    ${below}
  </div>`;
}

function pageHtml({ width, height, background, body, extraCss = "" }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    html, body { width: ${width}px; height: ${height}px; background: ${background}; }
    ${extraCss}</style></head><body>${body}</body></html>`;
}

const toneLight = `<div class="tone" style="background-image:radial-gradient(${C.ink} 1.2px, transparent 1.4px);background-size:9px 9px;opacity:.07"></div>`;
const toneDark = `<div class="tone" style="background-image:radial-gradient(#000 1.6px, transparent 1.8px);background-size:6px 6px;opacity:.55;-webkit-mask:linear-gradient(160deg,#000 0%,transparent 55%,#000 100%)"></div>`;

/** Headline in the popup's lettering: big title line, one plain sentence under it. */
function headline({ title, line, dark, x = 56, y = 40, width = 1168, align = "left" }) {
  return `<header style="position:absolute;left:${x}px;top:${y}px;width:${width}px;text-align:${align}">
    <h1 style="margin:0;font:400 42px/1.12 ${TITLE};color:${dark ? C.cream : C.ink};transform:skew(-6deg);transform-origin:${align === "center" ? "center" : "left"} bottom">${title}</h1>
    <p style="margin:12px 0 0;font:500 19px/1.4 ${BODY};color:${dark ? "#c9bdac" : "#4a4440"}">${line}</p>
  </header>`;
}

function sticker(text, { bg = C.yellow, color = C.ink, rotate = -2, size = 14 } = {}) {
  return `<span style="display:inline-block;padding:5px 11px;border:2.5px solid ${C.ink};background:${bg};color:${color};box-shadow:3px 3px 0 ${C.ink};font:900 ${size}px/1.2 ${BODY};letter-spacing:.03em;transform:rotate(${rotate}deg);white-space:nowrap">${text}</span>`;
}

// ---------------------------------------------------------------- the five images

function promoTile() {
  return pageHtml({
    width: 440, height: 280, background: C.pink,
    extraCss: `
      .rays { position:absolute; inset:-200px; background: repeating-conic-gradient(from 0deg at 50% 50%, rgba(255,255,255,.16) 0deg 6deg, transparent 6deg 15deg); }
      .title { display: inline-block; font: 400 40px/1 ${TITLE}; color: ${C.cream}; transform: skew(-6deg); white-space: nowrap;
        -webkit-text-stroke: 2px ${C.ink}; paint-order: stroke fill; text-shadow: 4px 4px 0 ${C.ink}; }
      .title i { font-style: normal; color: ${C.yellow}; }`,
    body: `
      <div class="rays" style="left:-320px;top:-330px;right:auto;bottom:auto;width:880px;height:880px"></div>
      <div class="tone" style="background-image:radial-gradient(rgba(17,17,17,.22) 1.3px, transparent 1.5px);background-size:8px 8px;-webkit-mask:linear-gradient(115deg,transparent 35%,#000 100%)"></div>
      <div style="position:absolute;left:16px;top:20px;filter:drop-shadow(5px 5px 0 ${C.ink})">${burstIcon(150)}</div>
      <div style="position:absolute;left:178px;top:50px;width:250px">
        <div class="title" id="fit">Sub<i>View!</i></div>
        <div style="margin-top:14px;font:900 13px/1 ${BODY};color:#fff;letter-spacing:.18em;text-transform:uppercase;text-shadow:1.5px 1.5px 0 ${C.ink}">Auto Dub · one tap</div>
      </div>
      <div style="position:absolute;left:0;right:0;bottom:22px;text-align:center">
        <span style="display:inline-block;padding:9px 18px;border:3px solid ${C.ink};background:${C.paper};box-shadow:4px 4px 0 ${C.ink};transform:rotate(-2deg);font:900 21px/1.1 ${BODY};color:${C.ink};letter-spacing:.01em;white-space:nowrap">
          Watch <b style="color:${C.pink}">Sub</b> · Hear <b style="color:${C.pink}">Dub</b> in Sync</span>
      </div>`,
  });
}

function shotLive(popup) {
  const scale = Math.min(1, 610 / popup.height);
  const w = Math.round(popup.width * scale), h = Math.round(popup.height * scale);
  return pageHtml({
    width: 1280, height: 800, background: C.night,
    body: `${toneDark}
      ${headline({ dark: true, title: `Watch <span style="color:${C.yellow}">Sub</span>. Hear the <span style="color:${C.pink}">Dub</span>. In sync.`,
        line: "Auto Dub plays the dubbed audio from a hidden copy of the page, so your tab never leaves Sub." })}
      <div style="position:absolute;left:56px;top:${170 + Math.round((610 - 555) / 2)}px">
        ${playerWindow({ dark: true, kind: "night", width: 800, played: 54, time: "12:48 / 23:40",
          subtitles: ["We missed the last train again…", "Fine. Ramen’s on me this time."],
          below: `<div style="display:flex;align-items:center;gap:12px;height:62px;padding:0 18px;color:${C.cream};font:900 17px/1 ${BODY}">
            Episode 04 · The Last Train
            <span style="margin-left:auto;display:flex;gap:10px;align-items:center;font:900 13px/1 ${BODY};color:${C.nightMuted}">Your tab plays ${sticker("SUB", { bg: C.cream, rotate: -3, size: 13 })} You hear ${sticker("DUB", { bg: C.pink, color: "#fff", rotate: 2, size: 13 })}</span>
          </div>` })}
      </div>
      <div style="position:absolute;left:${1280 - 56 - w}px;top:${170 + Math.round((610 - h) / 2)}px;width:${w}px;filter:drop-shadow(0 0 28px rgba(255,59,107,.28))">
        <img src="${popup.src}" style="width:${w}px;height:${h}px;box-shadow:8px 8px 0 #000">
      </div>`,
  });
}

function shotMenus(popup) {
  const scale = Math.min(1, 610 / popup.height);
  const w = Math.round(popup.width * scale), h = Math.round(popup.height * scale);
  const row = (label, on, first = false) => `<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 16px;${first ? "background:rgba(255,255,255,.08);" : ""}">
    <span>${label}</span>${on ? `<span style="color:${C.pink};font-weight:900">✓</span>` : ""}</div>`;
  const menu = `<div style="position:absolute;right:18px;top:18px;width:250px;padding:8px 0;border-radius:12px;background:rgba(20,18,26,.94);border:1px solid rgba(255,255,255,.12);
      color:#fff;font:500 16px/1.2 ${BODY};box-shadow:0 12px 30px rgba(0,0,0,.45)">
      <div style="padding:8px 16px 6px;font:900 11.5px/1 ${BODY};letter-spacing:.14em;text-transform:uppercase;color:#bdb3c9">Audio Language</div>
      ${row("Japanese", true, true)}${row("English", false)}
      <div style="height:1px;margin:8px 16px;background:rgba(255,255,255,.14)"></div>
      <div style="padding:6px 16px 6px;font:900 11.5px/1 ${BODY};letter-spacing:.14em;text-transform:uppercase;color:#bdb3c9">Subtitles</div>
      ${row("English", true)}${row("Off", false)}
    </div>`;
  const chip = (label, on) => `<span style="padding:7px 13px;border:2.5px solid ${C.ink};background:${on ? C.ink : "#fff"};color:${on ? "#fff" : C.ink};font:900 13px/1 ${BODY};letter-spacing:.06em">${label}</span>`;
  const below = `<div style="display:flex;align-items:center;gap:10px;height:62px;padding:0 18px;color:${C.ink};font:900 13px/1 ${BODY}">
      <span style="color:${C.muted};letter-spacing:.08em;text-transform:uppercase;font-size:11.5px">Or on the page</span>
      ${chip("SUB", true)}${chip("DUB", false)}
      <span style="width:2px;height:24px;background:#d8cfbf;margin:0 4px"></span>
      ${chip("Server 1", false)}${chip("Server 2", true)}${chip("Server 3", false)}
    </div>`;
  return pageHtml({
    width: 1280, height: 800, background: C.paper,
    body: `${toneLight}
      ${headline({ dark: false, title: `Audio menus <span style="color:${C.pink}">or</span> Sub/Dub buttons.`,
        line: "SubView reads the player’s Audio Language menu, or the page’s own Sub/Dub and server picks, and keeps your tab on the original." })}
      <div style="position:absolute;left:56px;top:${170 + Math.round((610 - 555) / 2)}px">
        ${playerWindow({ dark: false, kind: "dusk", width: 800, played: 31, time: "07:22 / 23:40", menu, below,
          subtitles: ["The festival starts at sundown.", "Then we’d better hurry!"] })}
      </div>
      <div style="position:absolute;left:${1280 - 56 - w}px;top:${170 + Math.round((610 - h) / 2)}px">
        <img src="${popup.src}" style="width:${w}px;height:${h}px;box-shadow:8px 8px 0 ${C.ink}">
      </div>`,
  });
}

/** Two popups side by side, with labelled leader lines to their controls. */
function shotMixer(light, dark) {
  const top = 168, room = 800 - top - 28;
  const scale = Math.min(1, room / Math.max(light.height, dark.height));
  const lw = light.width * scale, dw = dark.width * scale;
  const gap = 36, colW = 230;
  const lx = Math.round((1280 - lw - dw - gap) / 2), dx = Math.round(lx + lw + gap);
  const ly = Math.round(top + (room - Math.max(light.height, dark.height) * scale) / 2), dy = ly;
  // A control row's dot sits in the popup's side margin, beside the row; a button's at its edge.
  const point = (shot, x0, y0, box, side, edge = true) => ({
    x: x0 + (edge ? (side === "left" ? 9 : shot.width - 9) : side === "left" ? box.x - 2 : box.x + box.w + 2) * scale,
    y: y0 + (box.y + box.h / 2) * scale,
  });
  const callouts = [
    { side: "left", title: "Use this tab", text: "Move Auto Dub here in one click.", at: point(light, lx, ly, light.useTab, "left", false) },
    { side: "left", title: "Dub volume", text: "Set how loud the Dub plays.", at: point(light, lx, ly, light.volume, "left") },
    { side: "left", title: "Mute original audio", text: "Hear only the Dub voices.", at: point(light, lx, ly, light.mute, "left") },
    { side: "left", title: "±0.5 s timing nudge", text: "Line the Dub up by ear.", at: point(light, lx, ly, light.offset, "left") },
    { side: "right", title: "Auto offset", text: "Trims a longer intro for you.", at: point(dark, dx, dy, dark.autoOffset, "right") },
    { side: "right", title: "Reload tab for Dub", text: "Skip a site’s wait with one reload.", at: point(dark, dx, dy, dark.autoReload, "right") },
  ];
  // Stack each column's labels at their targets' heights, pushed apart where they'd touch.
  const LABEL_H = 64, SPACING = 12;
  for (const side of ["left", "right"]) {
    let floor = top;
    for (const c of callouts.filter(c => c.side === side).sort((a, b) => a.at.y - b.at.y)) {
      c.y = Math.max(floor, c.at.y - LABEL_H / 2);
      floor = c.y + LABEL_H + SPACING;
    }
  }
  const labelX = side => side === "left" ? lx - 34 - colW : dx + dw + 34;
  const labels = callouts.map(c => `<div style="position:absolute;left:${labelX(c.side)}px;top:${c.y}px;width:${colW}px;height:${LABEL_H}px;
      padding:9px 13px;border:2.5px solid ${C.ink};background:#fff;box-shadow:4px 4px 0 ${C.ink};text-align:${c.side === "left" ? "right" : "left"}">
      <div style="font:400 15px/1.2 ${TITLE};color:${C.ink};white-space:nowrap">${c.title}</div>
      <div style="margin-top:4px;font:500 13px/1.25 ${BODY};color:#4a4440;white-space:nowrap">${c.text}</div>
    </div>`).join("");
  const lines = callouts.map(c => {
    const x1 = c.side === "left" ? labelX("left") + colW + 2 : labelX("right") - 2, y1 = c.y + LABEL_H / 2;
    const elbow = c.side === "left" ? x1 + 14 : x1 - 14;
    const lineColor = c.side === "right" ? "#f1e7d6" : C.ink;
    return `<polyline points="${x1},${y1} ${elbow},${y1} ${c.at.x},${c.at.y}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="${c.at.x}" cy="${c.at.y}" r="7" fill="${C.pink}" stroke="${lineColor}" stroke-width="2.5"/>`;
  }).join("");
  const split = Math.round(lx + lw + gap / 2);
  return pageHtml({
    width: 1280, height: 800, background: C.paper,
    body: `
      <div style="position:absolute;left:${split}px;top:0;right:0;bottom:0;background:${C.night}"></div>
      <div class="tone" style="right:auto;width:${split}px;background-image:radial-gradient(${C.ink} 1.2px, transparent 1.4px);background-size:9px 9px;opacity:.07"></div>
      <div class="tone" style="left:${split}px;background-image:radial-gradient(#000 1.6px, transparent 1.8px);background-size:6px 6px;opacity:.55"></div>
      <header style="position:absolute;left:0;right:0;top:34px;text-align:center">
        <h1 style="display:inline-block;margin:0;padding:10px 26px 12px;border:3px solid ${C.ink};background:${C.yellow};box-shadow:6px 6px 0 ${C.ink};font:400 36px/1.1 ${TITLE};color:${C.ink};transform:rotate(-1.2deg)">
          Your mix, remembered for each site</h1>
        <p style="margin:18px 0 0;font:900 16px/1.3 ${BODY};letter-spacing:.02em">
          <span style="display:inline-block;width:${split - 40}px;text-align:right;padding-right:22px;color:#4a4440">Light theme</span><span style="display:inline-block;width:${1280 - split - 40}px;text-align:left;padding-left:22px;color:#c9bdac">Dark theme · follows your system</span></p>
      </header>
      <img src="${light.src}" style="position:absolute;left:${lx}px;top:${ly}px;width:${lw}px;height:${light.height * scale}px;box-shadow:7px 7px 0 ${C.ink}">
      <img src="${dark.src}" style="position:absolute;left:${dx}px;top:${dy}px;width:${dw}px;height:${dark.height * scale}px;box-shadow:7px 7px 0 #000">
      <svg width="1280" height="800" style="position:absolute;left:0;top:0;overflow:visible">${lines}</svg>
      ${labels}`,
  });
}

function shotDebug(debug) {
  const top = 172, cardW = 390;
  const firstH = debug.split, secondH = debug.height - debug.split;
  const card = (y0, h) => `<div style="width:${cardW}px;height:${h}px;overflow:hidden;border:3px solid ${C.ink};box-shadow:7px 7px 0 ${C.ink};background:#fff">
      <img src="${debug.src}" style="width:${debug.width}px;height:${debug.height}px;margin-top:${-y0}px"></div>`;
  const tabCard = (title, role, note, kind, accent) => `<div style="width:360px;border:3px solid ${C.ink};background:#fff;box-shadow:6px 6px 0 ${C.ink}">
      <div style="display:flex;align-items:center;gap:9px;height:38px;padding:0 12px;border-bottom:3px solid ${C.ink};background:#e9e2d4;font:900 13.5px/1 ${BODY};color:${C.ink};white-space:nowrap">
        <i style="width:10px;height:10px;border-radius:50%;background:${accent};border:2px solid ${C.ink};display:block;flex:none"></i>${title}</div>
      <div style="height:${Math.round(354 * 9 / 16)}px;overflow:hidden">${scene(kind)}</div>
      <div style="padding:10px 12px;font:500 13.5px/1.3 ${BODY};color:#4a4440"><b style="font-weight:900;color:${C.ink}">${role}</b> · ${note}</div>
    </div>`;
  return pageHtml({
    width: 1280, height: 800, background: C.paper,
    body: `${toneLight}
      ${headline({ dark: false, x: 48, y: 36, title: `Manual mode: <span style="color:${C.pink}">any two</span> video tabs.`,
        line: "In Debug tools, pick the tab you watch and the tab you want to hear. SubView keeps the two videos in step." })}
      <div style="position:absolute;left:48px;top:${top}px;display:grid;gap:22px">
        ${tabCard("Episode 04 — Original (Sub)", "Primary", "the video you watch", "night", C.yellow)}
        <div style="position:absolute;left:150px;top:${Math.round(38 + 354 * 9 / 16 + 30)}px;z-index:2">${sticker("⇅ kept in sync", { bg: C.pink, color: "#fff", rotate: -3, size: 15 })}</div>
        ${tabCard("Episode 04 — Dubbed Audio", "Secondary", "the audio you hear", "dusk", C.pink)}
      </div>
      <div style="position:absolute;left:${1280 - 48 - cardW * 2 - 28}px;top:${top}px;display:flex;gap:28px;align-items:flex-start">
        ${card(0, firstH)}
        <div style="display:grid;gap:26px;justify-items:start">
          ${card(debug.split, secondH)}
          <div style="width:${cardW}px;font:500 15px/1.45 ${BODY};color:#4a4440">
            ${sticker("No Sub/Dub switch needed", { rotate: -2, size: 14 })}
            <p style="margin:14px 0 0">Works with any two tabs that play an HTML5 video. Swap them, nudge the delay from 0.1 s to 5 s, or let Auto offset line up the intros.</p>
          </div>
        </div>
      </div>`,
  });
}

// ---------------------------------------------------------------- render

const LIVE = { state: "live", word: "DUB!!", tally: "On air", status: "Dub's playing in sync! Your tab stays on Sub.",
  server: "Server 2", source: "Hidden copy", dim: false, volume: 80, mute: true, offset: 0, autoOffset: false, autoReload: false, useTab: false };
const STANDBY = { ...LIVE, state: "standby", word: "ON", tally: "Standby", status: `On for ${SITE}. Auto Dub is paused in another tab (${SITE}).`,
  // Nothing remembered yet: a remembered server's " · last worked" doesn't fit the panel.
  server: "—", source: "—", dim: true, volume: 65, offset: 0.5, useTab: true };

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  channel: process.env.CHROMIUM_PATH ? undefined : "chromium",
});
const written = [];
try {
  // popup.ts isn't loaded (no extension APIs here); popupShot writes the same fields it does.
  const shoot = (scheme, fill) => popupShot(browser, scheme, fill);
  const darkLive = await shoot("dark", LIVE);
  const lightLive = await shoot("light", { ...LIVE, volume: 70, autoReload: true });
  const lightStandby = await shoot("light", STANDBY);
  const darkMixer = await shoot("dark", { ...LIVE, volume: 85, autoOffset: true, autoReload: true, offset: -0.5 });
  const debug = await debugShot(browser);

  const images = [
    ["small-promo-440x280.png", 440, 280, promoTile()],
    ["screenshot-1-auto-dub-live.png", 1280, 800, shotLive(darkLive)],
    ["screenshot-2-audio-menu.png", 1280, 800, shotMenus(lightLive)],
    ["screenshot-3-mixer-controls.png", 1280, 800, shotMixer(lightStandby, darkMixer)],
    ["screenshot-4-debug-tools.png", 1280, 800, shotDebug(debug)],
  ];
  for (const dir of outDirs) await mkdir(dir, { recursive: true });
  for (const [name, width, height, html] of images) {
    const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await tab.setContent(html);
    await tab.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode()));
    });
    // The promo title is fitted to its column rather than guessed (inline-block, so it measures its own text).
    await tab.evaluate(() => {
      const fit = document.getElementById("fit");
      if (!fit) return;
      let size = 56;
      fit.style.fontSize = `${size}px`;
      while (fit.offsetWidth > fit.parentElement.clientWidth - 8 && size > 20) fit.style.fontSize = `${--size}px`;
    });
    const png = opaquePng(await tab.screenshot({ animations: "disabled" }));
    await tab.close();
    for (const dir of outDirs) await writeFile(resolve(dir, name), png);
    written.push(name);
  }
} finally {
  await browser.close();
}
console.log(`Wrote ${written.join(", ")} to:\n${outDirs.map(dir => `  ${dir}`).join("\n")}`);
