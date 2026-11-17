import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const AUTO_OFFSET_SCREENSHOT_PATH = join(
  tmpdir(),
  "subview-auto-offset-enabled.png",
);

// Generated local WAV files keep this test independent of external media and
// exercise the same browser duration metadata used by the extension.
function wav(seconds, frequency) {
  const rate = 8_000;
  const length = Math.round(rate * seconds);
  const data = Buffer.alloc(44 + length * 2);
  data.write("RIFF");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(length * 2, 40);
  for (let index = 0; index < length; index += 1) {
    data.writeInt16LE(
      Math.round(Math.sin((index * 2 * Math.PI * frequency) / rate) * 800),
      44 + index * 2,
    );
  }
  return data;
}

const media = new Map([
  ["/media/primary-short.wav", wav(10, 220)],
  ["/media/dub-long.wav", wav(20, 330)],
  ["/media/primary-long.wav", wav(20, 250)],
  ["/media/dub-short.wav", wav(10, 370)],
]);

function fixtureMarkup(kind) {
  const primary = kind === "primary-long" ? "primary-long" : "primary-short";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Auto offset fixture</title>
    <style>
      body { font: 16px system-ui, sans-serif; margin: 2rem; }
      main { display: grid; gap: 1rem; max-width: 44rem; }
      video { background: #17201b; display: block; width: 36rem; height: 20rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Auto offset fixture</h1>
      <video id="fixture-video" controls preload="auto" src="/media/${primary}.wav"></video>
      <button id="play-fixture" type="button">Play fixture</button>
    </main>
    <script>
      document.querySelector("#play-fixture").addEventListener("click", () => {
        void document.querySelector("#fixture-video").play();
      });
    </script>
  </body>
</html>`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const body = media.get(url.pathname);
  if (body) {
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const requestedEnd = range?.[2] ? Number(range[2]) : body.length - 1;
    const end = Math.min(requestedEnd, body.length - 1);
    if (start >= body.length || end < start) {
      response.writeHead(416, { "Content-Range": `bytes */${body.length}` });
      response.end();
      return;
    }
    response.writeHead(range ? 206 : 200, {
      "Content-Type": "audio/wav",
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      ...(range
        ? { "Content-Range": `bytes ${start}-${end}/${body.length}` }
        : {}),
    });
    response.end(body.subarray(start, end + 1));
    return;
  }

  if (url.pathname === "/fixture") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixtureMarkup(url.searchParams.get("kind")));
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});

const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "subview-auto-offset-"));
let context;
let popup;

// Polls observable extension/media state transitions. No product timing is
// simulated here; the deadline only bounds a failed browser run.
async function waitForValue(read, predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await read();
    if (await predicate(value)) return value;
    if (Date.now() >= deadline) break;
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  } while (Date.now() < deadline);
  throw new Error(`${description}: ${safeJson(value)}`);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

try {
  const extension = resolve("dist");
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH,
    channel: process.env.CHROMIUM_PATH ? undefined : "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });

  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const visible = await context.newPage();

  async function openPopup() {
    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/debug.html`);
    await popup.waitForSelector("#auto-offset");
    return popup;
  }

  async function getState() {
    return worker.evaluate(async () => {
      const stored = await chrome.storage.session.get("activeSyncState");
      return stored.activeSyncState ?? null;
    });
  }

  async function getTabId() {
    return worker.evaluate(async (pageOrigin) => {
      const tab = (await chrome.tabs.query({})).find((candidate) =>
        candidate.url?.startsWith(pageOrigin),
      );
      if (typeof tab?.id !== "number") throw new Error("fixture tab was not found");
      return tab.id;
    }, origin);
  }

  async function probe(tabId) {
    const response = await popup.evaluate(
      (message) => chrome.runtime.sendMessage(message),
      { type: "PROBE_TAB", tabId },
    );
    assert.equal(response.ok, true, safeJson(response));
    assert.ok(response.probe?.ok, safeJson(response));
    assert.equal(response.probe.videos.length, 1, safeJson(response));
    return response.probe.videos[0];
  }

  async function stopSync() {
    const response = await popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: "STOP_SYNC" }),
    );
    assert.equal(response.ok, true, safeJson(response));
    await waitForValue(getState, (state) => state === null, "sync stop");
  }

  async function navigateFixture(kind) {
    await visible.goto(`${origin}/fixture?kind=${kind}`, {
      waitUntil: "domcontentloaded",
    });
    await visible.waitForFunction(
      () => document.querySelector("#fixture-video")?.readyState >= 3,
    );
  }

  async function configureBackground({ source, manualValue }) {
    const tabId = await getTabId();
    const descriptor = await probe(tabId);
    await popup.locator("#sync-mode").selectOption("background");
    await popup.locator("#primary-tab").selectOption(String(tabId));
    await popup.waitForFunction(
      () => document.querySelector("#primary-video")?.disabled === false,
    );
    await popup.locator("#primary-video").selectOption(
      JSON.stringify([
        descriptor.frameId ?? null,
        descriptor.documentId ?? null,
        descriptor.id,
      ]),
    );
    await popup.locator("#source-url").fill(`${origin}${source}`);
    await popup.locator("#offset").fill(manualValue);
    const autoOffset = popup.locator("#auto-offset");
    await popup.waitForFunction(
      () => document.querySelector("#auto-offset")?.disabled === false,
    );
    if (await autoOffset.isChecked()) await autoOffset.uncheck();
    assert.equal(await autoOffset.isChecked(), false, "auto offset starts off");
    assert.equal(await autoOffset.isEnabled(), true, "auto offset is usable before start");
    await autoOffset.check();
    assert.equal(await autoOffset.isChecked(), true);
    await popup.locator("#start-sync").click();
    return { tabId, autoOffset };
  }

  await openPopup();

  // The Dub is ten seconds longer: auto plus a +2s correction skips Dub's
  // initial excess. The screenshot captures this enabled state immediately
  // after the first successful start for visual review.
  await navigateFixture("primary-short");
  const first = await configureBackground({
    source: "/media/dub-long.wav",
    manualValue: "-00:00:02",
  });
  const firstState = await waitForValue(
    getState,
    (state) =>
      state?.autoOffset === true &&
      state?.autoOffsetPending === false &&
      state?.offsetMs === 12_000,
    "Dub-longer auto offset plus correction",
  );
  assert.equal(firstState.manualOffsetMs, 2_000);
  assert.equal(await first.autoOffset.isChecked(), true);
  assert.equal(
    await first.autoOffset.isEnabled(),
    true,
    "auto offset remains usable while the fieldset is active",
  );
  await popup.screenshot({ path: AUTO_OFFSET_SCREENSHOT_PATH });
  console.log(`AUTO_OFFSET_SCREENSHOT_PATH=${AUTO_OFFSET_SCREENSHOT_PATH}`);

  await visible.locator("#play-fixture").click();
  const firstPlaying = await waitForValue(
    getState,
    (state) =>
      state?.secondary?.status === "playing" &&
      (state.secondary.snapshot?.currentTimeMs ?? 0) >= 9_500,
    "Dub starts after its ten-second excess",
  );
  assert.ok(firstPlaying.secondary.snapshot.currentTimeMs >= 9_500);

  await first.autoOffset.uncheck();
  const firstManual = await waitForValue(
    getState,
    (state) =>
      state?.autoOffset === false &&
      state?.autoOffsetPending === false &&
      state?.offsetMs === 2_000,
    "manual offset restored after disabling auto offset",
  );
  assert.equal(firstManual.manualOffsetMs, 2_000);
  assert.equal(await first.autoOffset.isEnabled(), true);
  assert.equal(await popup.locator("#offset").inputValue(), "-00:00:02");
  await stopSync();

  // The primary is ten seconds longer: auto plus a +3s correction is -7s.
  // The visible primary skips the corrected lead-in once on startup.
  await navigateFixture("primary-long");
  await popup.reload();
  await popup.waitForSelector("#auto-offset");
  const second = await configureBackground({
    source: "/media/dub-short.wav",
    manualValue: "-00:00:03",
  });
  const secondState = await waitForValue(
    getState,
    (state) =>
      state?.autoOffset === true &&
      state?.autoOffsetPending === false &&
      state?.offsetMs === -7_000,
    "primary-longer auto offset",
  );
  assert.equal(secondState.manualOffsetMs, 3_000);
  await visible.waitForFunction(
    () => document.querySelector("#fixture-video")?.currentTime >= 6.5,
  );
  assert.ok(
    (await visible.locator("#fixture-video").evaluate((video) => video.currentTime)) >=
      6.5,
    "primary skips its corrected lead-in",
  );

  await second.autoOffset.uncheck();
  const secondManual = await waitForValue(
    getState,
    (state) =>
      state?.autoOffset === false &&
      state?.offsetMs === 3_000 &&
      state?.manualOffsetMs === 3_000,
    "primary-longer manual offset restoration",
  );
  assert.equal(secondManual.manualOffsetMs, 3_000);
  assert.equal(await popup.locator("#offset").inputValue(), "-00:00:03");

  assert.equal(await popup.locator("[data-offset-step]").count(), 6);
  // Corrections change Dub's target while the paused visible Sub stays put.
  const before = await visible.locator("#fixture-video").evaluate(video => video.currentTime);
  await popup.locator('[data-offset-step="100"]').click();
  await waitForValue(getState, state => state?.offsetMs === 2_900, "manual correction");
  await popup.waitForFunction(() => document.querySelector("#offset").value === "-00:00:02.9");
  assert.ok(Math.abs(await visible.locator("#fixture-video").evaluate(video => video.currentTime) - before) < 0.04);
  await second.autoOffset.check();
  await waitForValue(getState, state => state?.offsetMs === -7_100, "auto plus correction");
  const alignedBefore = await visible.locator("#fixture-video").evaluate(video => video.currentTime);
  assert.equal(await popup.locator('[data-offset-step="-1000"]').isEnabled(), true);
  await popup.locator('[data-offset-step="-1000"]').click();
  await waitForValue(getState, state => state?.autoOffset && state.offsetMs === -6_100 && state.manualOffsetMs === 3_900, "live correction with auto enabled");
  await popup.waitForFunction(() => document.querySelector("#offset").value === "-00:00:03.9");
  assert.ok(Math.abs(await visible.locator("#fixture-video").evaluate(video => video.currentTime) - alignedBefore) < 0.04, "correction never moves Sub backward");
  await popup.screenshot({ path: join(tmpdir(), "subview-offset-buttons.png") });

  console.log(
    "PASS: auto offset plus manual corrections, longer-primary lead-in skip, popup usability, fixed Sub position during corrections, and isolated local WAV playback",
  );
} finally {
  await popup?.close();
  await context?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(profile, { recursive: true, force: true });
}
