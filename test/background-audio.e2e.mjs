import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Generated PCM audio exercises real browser media decoding, seeking and
// playback without a third-party streaming service or a checked-in media file.
function wav(seconds) {
  const rate = 8000;
  const length = rate * seconds;
  const data = Buffer.alloc(44 + length * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * 800), 44 + i * 2);
  return data;
}
const audio = wav(120);
const shortAudio = wav(4);
const server = createServer((req, res) => {
  if (req.url === "/audio.wav" || req.url === "/short.wav") {
    const body = req.url === "/short.wav" ? shortAudio : audio;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : body.length - 1;
    res.writeHead(range ? 206 : 200, {
      "Content-Type": "audio/wav", "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${body.length}` } : {}),
    });
    res.end(body.subarray(start, end + 1));
  } else if (req.url === "/invalid") {
    res.writeHead(200, { "Content-Type": "text/html" }); res.end("Not media");
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end('<!doctype html><title>Background audio fixture</title><video controls preload="auto" src="/audio.wav"></video><button onclick="document.querySelector(\'video\').play()">Play fixture</button>');
  }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "subview-e2e-"));
let context;
try {
  const extension = resolve("dist");
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH,
    channel: process.env.CHROMIUM_PATH ? undefined : "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  await worker.evaluate(() => {
    globalThis.__testEvents = [];
    chrome.runtime.onMessage.addListener(message => {
      if (message.type === "VIDEO_EVENT" && message.event !== "observation") {
        globalThis.__testEvents.push(message);
        if (globalThis.__testEvents.length > 40) globalThis.__testEvents.shift();
      }
    });
  });
  const extensionId = new URL(worker.url()).host;
  const visible = await context.newPage();
  await visible.goto(origin);
  await visible.waitForFunction(() => document.querySelector("video").readyState >= 3);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/debug.html`);
  // Use the popup context for requests: service workers cannot message themselves.
  const popupRequest = message => popup.evaluate(message => chrome.runtime.sendMessage(message), message);
  const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({})).find(t => t.url?.startsWith(origin)).id, origin);
  const probe = await popupRequest({ type: "PROBE_TAB", tabId });
  assert.equal(probe.ok, true);
  const primary = { tabId, videoId: probe.probe.videos[0].id };
  let state = () => worker.evaluate(async () => (await chrome.storage.session.get("activeSyncState")).activeSyncState);
  async function waitState(predicate, description) {
    // Test timeout only: completion depends on media state, never elapsed delay.
    const deadline = Date.now() + 15000;
    let value;
    do {
      value = await state();
      if (await predicate(value)) return value;
      await new Promise(setImmediate);
    } while (Date.now() < deadline);
    throw new Error(`${description}: ${JSON.stringify(value)}\nEvents: ${JSON.stringify(await worker.evaluate(() => globalThis.__testEvents.map(e => ({ side: e.side, event: e.event, revision: e.appliedRevision, time: e.snapshot?.currentTimeMs, paused: e.snapshot?.paused, error: e.error }))))}`);
  }
  await popup.locator("#sync-mode").selectOption("background");
  await popup.locator("#primary-tab").selectOption(String(tabId));
  await popup.waitForFunction(() => !document.querySelector("#primary-video").disabled);
  const descriptor = probe.probe.videos[0];
  await popup.locator("#primary-video").selectOption(JSON.stringify([
    descriptor.frameId ?? null, descriptor.documentId ?? null, descriptor.id,
  ]));
  await popup.locator("#source-url").fill(`${origin}/audio.wav`);
  await popup.locator("#offset").fill("+00:00:02");
  await popup.locator("#start-sync").click();
  const started = await waitState(s => !!s?.backgroundAudio, "popup starts background mode");
  assert.equal(started.offsetMs, -2000, "a positive Dub delay places Dub two seconds behind Sub");
  await visible.getByRole("button", { name: "Play fixture" }).click();
  await waitState(s => s?.secondary.status === "playing" && s.primary.snapshot?.currentTimeMs > 500, "background starts");
  assert.equal(await visible.locator("video").evaluate(v => v.muted), true, "visible media muted only after playback");
  assert.equal(await popup.locator("#mute-original").isEnabled(), true, "mute remains configurable live");
  await popup.locator("#mute-original").uncheck();
  await waitState(s => s?.backgroundAudio?.muteOriginal === false, "live mute preference off");
  await visible.waitForFunction(() => document.querySelector('video').muted === false);
  await popup.waitForFunction(async () => (await chrome.storage.local.get('muteOriginal')).muteOriginal === false);
  await popup.reload();
  await popup.waitForFunction(() => !document.querySelector('#mute-original').disabled);
  assert.equal(await popup.locator('#mute-original').isChecked(), false, 'mute setting survives reopening popup');
  await popup.locator("#mute-original").check();
  await waitState(s => s?.backgroundAudio?.muteOriginal === true, "live mute preference on");
  await visible.waitForFunction(() => document.querySelector('video').muted === true);
  assert.equal(await popup.locator("#background-volume").isEnabled(), true);
  await popup.locator("#background-volume").press("ArrowLeft");
  await waitState(s => s?.backgroundAudio?.volume === 0.75, "live volume changes while configuration locked");
  await popup.screenshot({ path: join(tmpdir(), "subview-background-popup.png") });
  await popup.close();
  await waitState(s => s?.secondary.snapshot?.currentTimeMs > 3500, "audio continues after popup closes");
  assert.equal((await worker.evaluate(() => chrome.tabs.query({}))).filter(t => t.url?.includes("offscreen")).length, 0, "no offscreen browser tab");
  await visible.locator("video").evaluate(v => v.pause());
  await waitState(s => s?.secondary.snapshot?.paused === true && s.timeline.playing === false, "pause synchronizes");
  await visible.locator("video").evaluate(v => { v.currentTime = 20; v.playbackRate = 1.5; });
  await waitState(s => Math.abs((s?.secondary.snapshot?.currentTimeMs ?? 0) - 18000) < 350 && s.secondary.snapshot.playbackRate === 1.5, "seek and speed synchronize");
  // Simulate the browser's documented idle-document closure, without a 30s sleep.
  await worker.evaluate(() => chrome.offscreen.closeDocument());
  await visible.getByRole("button", { name: "Play fixture" }).click();
  await waitState(s => s?.secondary.status === "playing" && s.secondary.snapshot.currentTimeMs > 18000, "offscreen recreation on resume");
  const popup2 = await context.newPage();
  await popup2.goto(`chrome-extension://${extensionId}/debug.html`);
  const stop = await popup2.evaluate(() => chrome.runtime.sendMessage({ type: "STOP_SYNC" }));
  assert.equal(stop.ok, true);
  assert.equal(await visible.locator("video").evaluate(v => v.muted), false, "stop restores original sound");
  assert.equal(await worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length), 0);
  await visible.locator("video").evaluate(v => v.pause());
  const bad = await popup2.evaluate(config => chrome.runtime.sendMessage({ type: "START_BACKGROUND_AUDIO", config }), { primary, sourceUrl: `${origin}/invalid`, volume: 0.2, offsetMs: 0 });
  if (bad.ok) {
    await visible.getByRole("button", { name: "Play fixture" }).click();
    await waitState(s => s?.secondary.status === "play-failed", "invalid media reports failure");
  } else assert.ok(bad.error, "early load errors are reported");
  assert.equal(await visible.locator("video").evaluate(v => v.muted), false, "failure preserves visible sound");
  await popup2.evaluate(() => chrome.runtime.sendMessage({ type: "STOP_SYNC" }));
  const ask = message => popup2.evaluate(message => chrome.runtime.sendMessage(message), message);
  await visible.locator('video').evaluate(v => { v.pause(); v.currentTime = 0; });
  const audible = await ask({ type: 'START_BACKGROUND_AUDIO', config: { primary, sourceUrl: `${origin}/audio.wav`, volume: 0.1, offsetMs: 0, muteOriginal: false } });
  assert.equal(audible.ok, true, JSON.stringify(audible));
  await visible.getByRole('button', { name: 'Play fixture' }).click();
  await waitState(s => s?.secondary.status === 'playing', 'background playback with mute disabled');
  assert.equal(await visible.locator('video').evaluate(v => v.muted), false, 'mute disabled leaves original audio audible');
  await ask({ type: 'STOP_SYNC' });
  const restart = async (sourceUrl, offsetMs) => {
    const result = await ask({ type: "START_BACKGROUND_AUDIO", config: { primary, sourceUrl, volume: 0.1, offsetMs } });
    assert.equal(result.ok, true, JSON.stringify(result));
  };
  await visible.locator("video").evaluate(v => { v.pause(); v.currentTime = 0; v.playbackRate = 1; });
  await restart(`${origin}/audio.wav`, -2000);
  await visible.getByRole("button", { name: "Play fixture" }).click();
  await waitState(s => s?.primary.snapshot?.currentTimeMs > 0 && s.primary.snapshot.currentTimeMs < 1800 && s.secondary.snapshot?.paused, "negative offset waits at zero");
  await waitState(s => s?.secondary.status === "playing" && s.secondary.snapshot.currentTimeMs > 0, "negative offset joins at playable position");
  await visible.locator("video").evaluate(v => { v.currentTime = 119.6; });
  await waitState(s => s?.primary.snapshot?.ended && !s.secondary.snapshot?.paused, "visible ending does not stop background audio");
  await ask({ type: "STOP_SYNC" });
  await visible.locator("video").evaluate(v => { v.currentTime = 0; });
  await restart(`${origin}/short.wav`, 0);
  await visible.getByRole("button", { name: "Play fixture" }).click();
  const endedState = await waitState(s => s?.secondary.snapshot?.ended && !s.primary.snapshot?.paused && s.primary.snapshot.currentTimeMs > 4500, "short background audio does not stop visible video");
  assert.equal(await worker.evaluate(pairId => {
    const events = globalThis.__testEvents.filter(e => e.pairId === pairId && e.side === "secondary");
    const end = events.findIndex(e => e.event === "ended");
    return end >= 0 && events.slice(end + 1).some(e => e.event === "playing");
  }, endedState.pairId), false, "ended audio is not briefly replayed by stale snapshots");
  await ask({ type: "STOP_SYNC" });
  await visible.locator("video").evaluate(v => { v.muted = true; v.pause(); v.currentTime = 0; });
  await restart(`${origin}/audio.wav`, 0);
  await visible.getByRole("button", { name: "Play fixture" }).click();
  await waitState(s => s?.secondary.status === "playing", "originally muted session plays");
  const release = await ask({ type: 'SET_MUTE_ORIGINAL', muteOriginal: false });
  assert.equal(release.ok, true);
  assert.equal(await visible.locator('video').evaluate(v => v.muted), true, 'disabling auto-mute preserves user original mute');
  await ask({ type: "STOP_SYNC" });
  assert.equal(await visible.locator("video").evaluate(v => v.muted), true, "original mute is preserved");
  // Existing two-tab mode still operates independently of the hidden player.
  const second = await context.newPage();
  await second.goto(`${origin}/second`);
  await second.getByRole("button", { name: "Play fixture" }).click();
  await second.locator("video").evaluate(v => v.pause());
  await visible.locator("video").evaluate(v => { v.pause(); v.currentTime = 10; });
  const secondId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, `${origin}/second`);
  const secondProbe = await ask({ type: "PROBE_TAB", tabId: secondId });
  const pair = await ask({ type: "START_SYNC", config: { primary, secondary: { tabId: secondId, videoId: secondProbe.probe.videos[0].id }, offsetMs: 1000 } });
  assert.equal(pair.ok, true);
  for (let i = 0; i < 5; i++) {
    await visible.getByRole("button", { name: "Play fixture" }).click();
    await waitState(s => !s?.backgroundAudio && s?.secondary.status === "playing", "two-tab fallback plays");
    await visible.locator("video").evaluate(v => v.pause());
    await waitState(s => s?.secondary.snapshot?.paused && !s.timeline.playing, "two-tab fallback pauses");
  }
  await ask({ type: "STOP_SYNC" });
  await restart(`${origin}/audio.wav`, 0);
  await visible.goto(`${origin}/navigated`);
  await waitState(async s => s === null && await worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length) === 0, "navigation stops hidden session and closes document");
  console.log("PASS: popup start, real playback, signed offsets, pause/seek/rate, popup closure, offscreen recreation, failures, original mute, independent ends, two-tab fallback, navigation cleanup");
} finally {
  await context?.close();
  await new Promise(r => server.close(r));
  await rm(profile, { recursive: true, force: true });
}
