// Live check of Auto Dub against a real site, using the built extension in dist/.
// Not part of `npm test`: it needs the network and a site that is up.
//
//   node test/live/hosted-dub.live.mjs <watchUrl> [subServerValue] [--quick]
//
// It selects Sub (and the given Sub server) in a normal tab, enables Auto Dub
// the way the popup does, waits for the hidden Dub, then plays / seeks / pauses /
// changes speed on the visible video while sampling Dub drift. Audio is muted.
import { chromium } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [watchUrl, subServer, ...flags] = process.argv.slice(2);
const quick = flags.includes("--quick");
if (!watchUrl) { console.error("usage: node test/live/hosted-dub.live.mjs <watchUrl> [subServerValue] [--quick]"); process.exit(2); }
const exe = process.env.CHROMIUM_PATH ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const dist = resolve("dist");
const profile = await mkdtemp(join(tmpdir(), "subview-live-"));
const wait = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const result = { watchUrl, subServer: subServer ?? null, ok: false };

// Look like an ordinary browser: some players (one site's video host) block
// anything that announces automation or a headless user agent.
const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const context = await chromium.launchPersistentContext(profile, {
  executablePath: exe, headless: process.env.SHOW_BROWSER !== "1", viewport: { width: 1280, height: 800 }, userAgent, locale: "en-US",
  ignoreDefaultArgs: ["--enable-automation"],
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--mute-audio", "--window-position=-10000,-10000",
    // Real Chrome's autoplay rules by default (REAL_AUTOPLAY=0 restores the old permissive flag).
    // Headless relaxes autoplay; force desktop Chrome's rule (sound needs a user gesture).
    process.env.REAL_AUTOPLAY === "0" ? "--autoplay-policy=no-user-gesture-required" : "--autoplay-policy=document-user-activation-required",
    "--disable-blink-features=AutomationControlled",
    // Browser-wide, so the extension's hidden copy (not a Playwright page) gets it too.
    `--user-agent=${userAgent}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  if (process.env.DEBUG_FRAME_URL) {
    context.on("response", async response => {
      if (!response.url().includes(process.env.DEBUG_FRAME_URL)) return;
      const h = await response.allHeaders().catch(() => ({}));
      log("response:", response.status(), response.request().resourceType(), "sw:", response.fromServiceWorker(), "frame:", (() => { try { return response.frame()?.parentFrame()?.url().slice(0, 60) ?? "top"; } catch { return "service-worker"; } })(),
        "| xfo:", h["x-frame-options"] ?? "-", "| csp:", (h["content-security-policy"] ?? "-").slice(-40), "|", response.url().slice(0, 90));
    });
  }
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(watchUrl, { waitUntil: "domcontentloaded" });
  const langSelect = 'select[aria-label="Language"]', serverSelect = 'select[aria-label="Server"]';
  // Some sites have a Language select; others load on Sub by default.
  const hasLangSelect = await page.waitForSelector(langSelect, { timeout: 20000 }).then(() => true, () => false);
  if (hasLangSelect && await page.$eval(langSelect, s => s.value) !== "sub") await page.selectOption(langSelect, "sub");
  if (!hasLangSelect) {
    // Sites that open on Dub: press their Sub button, as a user would.
    const pressed = await page.evaluate(() => {
      const sub = [...document.querySelectorAll("button,[role=tab],[role=button],a:not([href]),a[href^='#']")]
        .find(el => /^(?:sub|subbed|soft ?sub)$/i.test((el.textContent ?? "").trim()) && el.getClientRects().length);
      sub?.click();
      return Boolean(sub);
    }).catch(() => false);
    if (pressed) log("pressed the page's Sub button");
  }
  if (subServer && !hasLangSelect) {
    // Sites with server buttons: click the one whose label starts with the name, like a user.
    await wait(1500);
    const clicked = await page.evaluate(name => {
      const button = [...document.querySelectorAll("button,[role=button]")].find(b => b.textContent.trim().toLowerCase().startsWith(name));
      button?.click();
      return Boolean(button);
    }, subServer.toLowerCase());
    if (!clicked) throw new Error(`No Sub server button matching "${subServer}".`);
  } else if (subServer) {
    await wait(1500);
    // An exact option value ("alpha:ssub"), or a server family name ("sigma").
    const value = subServer.includes(":") ? subServer : await page.$eval(serverSelect, (s, family) =>
      [...s.options].find(o => o.textContent.trim().toLowerCase().startsWith(family))?.value ?? null, subServer.toLowerCase());
    if (!value) throw new Error(`No Sub server matching "${subServer}".`);
    await page.selectOption(serverSelect, value);
  }
  const visibleVideoFrame = async () => {
    for (const frame of page.frames()) {
      const n = await frame.evaluate(() => [...document.querySelectorAll("video")].filter(v => v.readyState >= 1 && v.duration > 60).length).catch(() => 0);
      if (n) return frame;
    }
    return null;
  };
  // Ad scripts open tabs on the first click; close anything the site opens.
  page.on("popup", popup => { void popup.close().catch(() => undefined); });
  // An alert()/confirm() would block every page.evaluate.
  page.on("dialog", dialog => { void dialog.dismiss().catch(() => undefined); });
  // Press play the way a user does: click the middle of the biggest player.
  const pressPlay = async () => {
    const box = await page.evaluate(() => {
      const players = [...document.querySelectorAll("video,iframe")].map(el => el.getBoundingClientRect())
        .filter(r => r.width > 200 && r.height > 120).sort((a, b) => b.width * b.height - a.width * a.height);
      const r = players[0];
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }).catch(() => null);
    if (box) await page.mouse.click(box.x, box.y).catch(() => undefined);
  };
  let subFrame = null;
  for (let i = 0; i < 60 && !(subFrame = await visibleVideoFrame()); i++) {
    if (i >= 8 && i % 6 === 2) await pressPlay();
    await wait(1000);
  }
  if (!subFrame) throw new Error("The visible Sub video never loaded.");
  const subServerLabel = await page.$eval(serverSelect, s => s.selectedOptions[0]?.textContent.trim()).catch(() => "(default)");
  result.subServerLabel = subServerLabel;
  log("visible tab on Sub, server:", subServerLabel, "| video frame:", new URL(subFrame.url()).host);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const ask = message => popup.evaluate(m => chrome.runtime.sendMessage(m), message);
  const tabId = (await popup.evaluate(() => chrome.tabs.query({}))).find(t => t.url === page.url())?.id;
  await page.bringToFront();
  const site = new URL(page.url()).hostname.replace(/^www\./, "");
  const enabled = await ask({ type: "SET_AUTO_DUB_SITE", site, enabled: true, tabId, settings: { volume: 0.8, offsetMs: 0, muteOriginal: true } });
  if (!enabled.ok) throw new Error(`SET_AUTO_DUB failed: ${enabled.error}`);

  let last = "", state = null, autoDub = null;
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    autoDub = (await ask({ type: "GET_AUTO_DUB" })).autoDub;
    state = (await ask({ type: "GET_STATE" })).state;
    const line = `${autoDub?.status}: ${autoDub?.reason}`;
    if (line !== last) { log("Auto Dub", line); last = line; }
    if (process.env.DEBUG_HOST === "1" && autoDub?.reason?.includes("minimized") && !globalThis.__dumped) {
      globalThis.__dumped = true;
      await wait(8000);
      for (const pg of context.pages()) {
        if (!pg.url().includes("host.html")) continue;
        for (const f of pg.frames()) log("window frame:", f.url().slice(0, 120), "|", (await f.evaluate(() => document.title + " :: " + (document.body?.innerText ?? "").slice(0, 160)).catch(e => "ERR " + e.message.slice(0, 80))).replace(/\s+/g, " "));
      }
    }
    if (process.env.DEBUG_VIDEOS === "1" && Math.round((Date.now() - t0) / 500) % 4 === 0) {
      const vids = await worker.evaluate(() => globalThis.subviewDiagnostics.hostedVideos()).catch(e => String(e));
      log("hidden:", JSON.stringify(Array.isArray(vids) ? vids.map(f => [f.href.slice(0, 50), (f.response?.videos ?? []).map(v => `rs${v.readyState} d${Math.round((v.durationMs ?? 0) / 1000)} t${Math.round(v.currentTimeMs / 1000)} ld${v.loadStartedAt ? Math.round((v.loadStartedAt - Date.now()) / 1000) : "?"}s ${v.source.slice(0, 40)}`)]) : vids).slice(0, 500));
    }
    if (process.env.DEBUG_HOST === "1" && Math.round((Date.now() - t0) / 500) % 10 === 0) {
      log("host:", JSON.stringify(await worker.evaluate(() => { const h = globalThis.subviewDiagnostics.host(); return { container: h.container, frames: h.frames.map(f => [f.depth, f.href.slice(0, 90)]), refused: h.refused }; })).slice(0, 700));
    }
    if (autoDub?.status === "active" && state?.backgroundAudio?.mode === "hosted") break;
    if (autoDub?.status === "error" || autoDub?.status === "unsupported") break;
    await wait(500);
  }
  result.autoDub = autoDub;
  if (autoDub?.status !== "active") throw new Error(`Auto Dub did not become active: ${autoDub?.status} ${autoDub?.reason}`);
  result.timeToActiveS = +((Date.now() - t0) / 1000).toFixed(1);
  result.container = state.backgroundAudio.container;
  result.dubServer = state.backgroundAudio.provider;
  log("ACTIVE via", result.container, "| Dub server:", result.dubServer);

  const drift = () => worker.evaluate(() => globalThis.subviewDiagnostics.sampleSyncDrift());
  const vis = fn => subFrame.evaluate(fn);
  const samples = {};
  async function sampleFor(label, seconds, every = 1000) {
    const list = [];
    for (let t = 0; t < seconds * 1000; t += every) {
      const d = await drift();
      if (d?.ok) list.push(d);
      await wait(every);
    }
    // Steady state only: the first two seconds after an action are the transition itself.
    const steady = list.slice(Math.ceil(2000 / every));
    const abs = steady.filter(d => !d.primaryPaused).map(d => Math.abs(d.driftMs)).sort((a, b) => a - b);
    const pct = p => abs.length ? Math.round(abs[Math.min(abs.length - 1, Math.floor(p * abs.length))]) : null;
    const lastSample = list.at(-1);
    samples[label] = { n: list.length, medianAbsMs: pct(0.5), p90AbsMs: pct(0.9), maxAbsMs: abs.length ? Math.round(abs.at(-1)) : null,
      last: lastSample && { primaryS: +(lastSample.primaryMs / 1000).toFixed(2), secondaryS: +(lastSample.secondaryMs / 1000).toFixed(2),
        driftMs: Math.round(lastSample.driftMs), paused: [lastSample.primaryPaused, lastSample.secondaryPaused],
        rate: lastSample.rate.map(r => +r.toFixed(3)), rttMs: lastSample.rttMs.map(Math.round) } };
    log(label.padEnd(18), JSON.stringify(samples[label]));
  }

  // Don't await play(): some players keep that promise pending. Some ignore
  // script-started playback entirely; a real click on the player starts them.
  const main = "[...document.querySelectorAll('video')].find(v => v.duration > 60)";
  const position = () => vis(`${main}.currentTime`);
  async function ensurePlaying() {
    await vis(`${main}.play().catch(() => {}); true`);
    const before = await position();
    await wait(2500);
    if (await position() > before + 0.5) return;
    const box = await (await subFrame.frameElement()).boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await wait(2500);
    log("visible player needed a click; advancing:", await position() > before + 0.5);
  }
  await ensurePlaying();
  await sampleFor("play", quick ? 8 : 30);
  await vis(() => { const v = [...document.querySelectorAll("video")].find(v => v.duration > 60); v.currentTime = Math.min(600, v.duration / 2); });
  await sampleFor("after seek", quick ? 6 : 15);
  if (process.env.DEBUG_HOSTED === "1") {
    log("state:", JSON.stringify((await ask({ type: "GET_STATE" })).state?.secondary ?? null).slice(0, 400));
    for (let i = 0; i < 4; i++) {
      log("hidden videos:", JSON.stringify(await worker.evaluate(() => globalThis.subviewDiagnostics.hostedVideos())).slice(0, 700));
      log("host:", JSON.stringify(await worker.evaluate(() => { const h = globalThis.subviewDiagnostics.host(); return { frames: h.frames.map(f => [f.depth, f.href.slice(0, 80)]), refused: h.refused }; })).slice(0, 600));
      log("auto dub:", JSON.stringify((await ask({ type: "GET_AUTO_DUB" })).autoDub).slice(0, 300));
      await wait(4000);
    }
  }
  await vis(() => [...document.querySelectorAll("video")].find(v => v.duration > 60).pause());
  await sampleFor("paused", 4);
  await ensurePlaying();
  await sampleFor("resumed", quick ? 6 : 12);
  if (!quick) {
    await vis(() => { [...document.querySelectorAll("video")].find(v => v.duration > 60).playbackRate = 1.5; });
    await sampleFor("rate 1.5x", 12);
    await vis(() => { [...document.querySelectorAll("video")].find(v => v.duration > 60).playbackRate = 1; });
    await sampleFor("rate back 1x", 8);
  }
  result.samples = samples;

  // The visible tab must stay on Sub, live and in storage.
  // Without a Language select, fall back to the player URL (some sites use ?lang=).
  result.visibleLanguage = hasLangSelect ? await page.$eval(langSelect, s => s.value)
    : page.frames().some(f => /[?&]lang=dub\b/.test(f.url())) ? "dub" : "sub (player url)";
  result.visibleStorageMentionsDub = await page.evaluate(() => Object.values(localStorage).some(v => /"language":"dub"/.test(v)));
  const visibleMuted = await vis(() => [...document.querySelectorAll("video")].find(v => v.duration > 60).muted);
  result.visibleMuted = visibleMuted;
  log("visible tab language:", result.visibleLanguage, "| storage mentions dub:", result.visibleStorageMentionsDub, "| visible muted:", visibleMuted);

  await ask({ type: "SET_AUTO_DUB_SITE", site, enabled: false });
  await wait(1500);
  result.afterDisable = {
    rules: (await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).length,
    scripts: (await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length,
    offscreen: await worker.evaluate(() => chrome.offscreen.hasDocument()),
    visibleMuted: await vis(() => [...document.querySelectorAll("video")].find(v => v.duration > 60).muted),
  };
  log("after disable:", JSON.stringify(result.afterDisable));
  result.ok = true;
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  log("FAILED:", result.error);
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
  console.log("RESULT " + JSON.stringify(result));
}
