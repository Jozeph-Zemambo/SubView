import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const execFileAsync = promisify(execFile);
const AFCONVERT = "/usr/bin/afconvert";

function createWav(seconds) {
  const sampleRate = 44_100;
  const frameCount = sampleRate * seconds;
  const data = Buffer.alloc(44 + frameCount * 2);
  data.write("RIFF");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(frameCount * 2, 40);
  for (let frame = 0; frame < frameCount; frame++) {
    const sample = Math.round(Math.sin(frame * 2 * Math.PI * 440 / sampleRate) * 7_000);
    data.writeInt16LE(sample, 44 + frame * 2);
  }
  return data;
}

function sendBody(request, response, body, contentType) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Type": contentType,
  };
  const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? "");
  if (!range) {
    response.writeHead(200, { ...headers, "Content-Length": body.length });
    response.end(body);
    return;
  }

  const start = Number(range[1]);
  const end = range[2] ? Number(range[2]) : body.length - 1;
  if (start >= body.length || end < start) {
    response.writeHead(416, { ...headers, "Content-Range": `bytes */${body.length}` });
    response.end();
    return;
  }

  const boundedEnd = Math.min(end, body.length - 1);
  response.writeHead(206, {
    ...headers,
    "Content-Length": boundedEnd - start + 1,
    "Content-Range": `bytes ${start}-${boundedEnd}/${body.length}`,
  });
  response.end(body.subarray(start, boundedEnd + 1));
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object" && address.port);
  return `http://127.0.0.1:${address.port}`;
}

test("plays a generated one-segment AAC HLS stream and restores mute on fatal manifest failure", async () => {
  if (process.platform !== "darwin") {
    return test.skip("The local AAC fixture uses macOS afconvert");
  }
  await access(AFCONVERT);
  await access(resolve("dist", "offscreen", "offscreen.js"));

  const fixtureDirectory = await mkdtemp(join(tmpdir(), "subview-hls-playback-"));
  const profileDirectory = await mkdtemp(join(tmpdir(), "subview-hls-profile-"));
  let context;
  let server;
  let invalidManifestResponse = null;
  let resolveInvalidManifestRequest;
  const invalidManifestRequested = new Promise(resolveRequest => {
    resolveInvalidManifestRequest = resolveRequest;
  });

  try {
    const wavPath = join(fixtureDirectory, "primary.wav");
    const aacPath = join(fixtureDirectory, "segment.aac");
    await writeFile(wavPath, createWav(8));
    // This macOS afconvert build selects AAC from the ADTS container format;
    // its -hf output has no `aac` data-format token, so `-d aac` is rejected.
    await execFileAsync(AFCONVERT, [
      "-f", "adts",
      "-b", "96000",
      wavPath,
      "-o", aacPath,
    ]);
    const [wavData, aacData] = await Promise.all([readFile(wavPath), readFile(aacPath)]);
    assert.ok(aacData.length > 0, "afconvert produced an AAC fixture");

    const playlist = Buffer.from([
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-TARGETDURATION:8",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXTINF:8.000,",
      "segment.aac",
      "#EXT-X-ENDLIST",
      "",
    ].join("\n"));

    server = createServer((request, response) => {
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Origin": "*",
        });
        response.end();
        return;
      }

      const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
      if (path === "/") {
        const html = `<!doctype html><meta charset="utf-8">
          <video id="primary" preload="auto" src="/primary.wav"></video>
          <button id="play" onclick="document.querySelector('#primary').play()">Play primary</button>`;
        sendBody(request, response, Buffer.from(html), "text/html; charset=utf-8");
      } else if (path === "/primary.wav") {
        sendBody(request, response, wavData, "audio/wav");
      } else if (path === "/stream.m3u8") {
        sendBody(request, response, playlist, "application/vnd.apple.mpegurl");
      } else if (path === "/segment.aac") {
        sendBody(request, response, aacData, "audio/aac");
      } else if (path === "/invalid.m3u8") {
        invalidManifestResponse = response;
        resolveInvalidManifestRequest();
      } else {
        response.writeHead(404, { "Access-Control-Allow-Origin": "*" });
        response.end("Not found");
      }
    });
    const origin = await listen(server);

    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath: process.env.CHROMIUM_PATH,
      channel: process.env.CHROMIUM_PATH ? undefined : "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${resolve("dist")}`,
        `--load-extension=${resolve("dist")}`,
      ],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    await worker.evaluate(() => {
      globalThis.__hlsTestEvents = [];
      chrome.runtime.onMessage.addListener(message => {
        if (message?.type === "VIDEO_EVENT") globalThis.__hlsTestEvents.push(message);
      });
    });
    const extensionId = new URL(worker.url()).host;

    const visible = await context.newPage();
    await visible.goto(`${origin}/`);
    await visible.waitForFunction(() => document.querySelector("#primary")?.readyState >= 1);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/debug.html`);
    const request = message => popup.evaluate(messageValue => chrome.runtime.sendMessage(messageValue), message);
    const readState = () => worker.evaluate(async () => (await chrome.storage.session.get("activeSyncState")).activeSyncState);
    async function waitForState(predicate, description) {
      const deadline = Date.now() + 20_000;
      let state;
      do {
        state = await readState();
        if (predicate(state)) return state;
        await new Promise(setImmediate);
      } while (Date.now() < deadline);
      const events = await worker.evaluate(() => globalThis.__hlsTestEvents.map(event => ({
        side: event.side,
        event: event.event,
        error: event.error,
        time: event.snapshot?.currentTimeMs,
      })));
      throw new Error(`${description}: ${JSON.stringify(state)}\nEvents: ${JSON.stringify(events)}`);
    }

    const tabId = await worker.evaluate(async base => {
      const tabs = await chrome.tabs.query({});
      return tabs.find(tab => tab.url?.startsWith(base))?.id;
    }, origin);
    assert.ok(Number.isInteger(tabId), "the visible fixture tab is discoverable");
    const probe = await request({ type: "PROBE_TAB", tabId });
    assert.equal(probe.ok, true, JSON.stringify(probe));
    const primary = { tabId, videoId: probe.probe.videos[0].id };

    const start = await request({
      type: "START_BACKGROUND_AUDIO",
      config: {
        primary,
        sourceUrl: `${origin}/stream.m3u8`,
        volume: 0.2,
        offsetMs: 0,
        muteOriginal: true,
      },
    });
    assert.equal(start.ok, true, JSON.stringify(start));

    await visible.getByRole("button", { name: "Play primary" }).click();
    const playing = await waitForState(
      state => state?.secondary.status === "playing" && state.secondary.snapshot?.currentTimeMs > 0,
      "generated HLS secondary starts playing",
    );
    const firstTimeMs = playing.secondary.snapshot.currentTimeMs;
    const advanced = await waitForState(
      state => (state?.secondary.snapshot?.currentTimeMs ?? 0) > firstTimeMs + 500,
      "generated HLS secondary time advances",
    );
    assert.ok(advanced.secondary.snapshot.currentTimeMs > firstTimeMs + 500);
    assert.equal(await visible.locator("#primary").evaluate(video => video.muted), true);

    const stateBeforeFailure = await readState();
    const invalidLoad = await request({
      target: "offscreen",
      type: "OFFSCREEN_LOAD",
      url: `${origin}/invalid.m3u8`,
      volume: 0.2,
    });
    assert.equal(invalidLoad.ok, true, JSON.stringify(invalidLoad));
    await invalidManifestRequested;

    const reactivated = await request({
      target: "offscreen",
      type: "OFFSCREEN_CONTENT",
      request: {
        type: "ACTIVATE",
        pairId: stateBeforeFailure.pairId,
        side: "secondary",
        videoId: stateBeforeFailure.secondary.endpoint.videoId,
        revision: stateBeforeFailure.timeline.revision,
      },
    });
    assert.equal(reactivated.ok, true, JSON.stringify(reactivated));

    assert.ok(invalidManifestResponse, "invalid manifest request is held until the controller is active");
    invalidManifestResponse.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": "application/vnd.apple.mpegurl",
    });
    invalidManifestResponse.end("not an HLS playlist\n");
    invalidManifestResponse = null;

    const failed = await waitForState(
      state => state?.secondary.status === "play-failed",
      "fatal HLS manifest failure reaches the existing controller lifecycle",
    );
    assert.equal(failed.secondary.status, "play-failed");
    await visible.waitForFunction(() => document.querySelector("#primary").muted === false);
    assert.equal(await visible.locator("#primary").evaluate(video => video.muted), false);
    assert.ok(
      (await worker.evaluate(() => globalThis.__hlsTestEvents)).some(event =>
        event.side === "secondary" && event.event === "play-failed" && /HLS playback failed/.test(event.error ?? "")),
    );

    const stop = await request({ type: "STOP_SYNC" });
    assert.equal(stop.ok, true, JSON.stringify(stop));
    await popup.close();
    await visible.close();
  } finally {
    if (invalidManifestResponse) invalidManifestResponse.destroy();
    await context?.close();
    if (server) await new Promise(resolveClose => server.close(() => resolveClose()));
    await rm(profileDirectory, { recursive: true, force: true });
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
