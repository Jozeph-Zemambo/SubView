import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const EXTENSION_ID = "iframe-test-extension";
const POPUP_URL = `chrome-extension://${EXTENSION_ID}/popup.html`;
const serviceWorkerPath = fileURLToPath(
  new URL("../src/background/service-worker.ts", import.meta.url),
);
const { outputFiles } = await build({
  entryPoints: [serviceWorkerPath],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
});
const compiledWorker = outputFiles[0].text;
let workerImport = 0;

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function mediaSnapshot({ paused = true, currentTimeMs = 0 } = {}) {
  return {
    currentTimeMs,
    durationMs: 60_000,
    paused,
    ended: false,
    playbackRate: 1,
    readyState: 3,
    canPlay: true,
  };
}

function descriptor(id, label) {
  return {
    id,
    index: 0,
    label,
    source: `https://media.example.test/${id}.m3u8`,
    mediaSources: [`https://media.example.test/${id}.m3u8`],
    durationMs: 60_000,
    currentTimeMs: 0,
    paused: true,
    ended: false,
    playbackRate: 1,
    readyState: 3,
    width: 1280,
    height: 720,
  };
}

async function harness({ injectionResults, videosByDocument = new Map() }) {
  const listeners = [];
  const updates = [];
  const removed = [];
  const changed = [];
  const executeCalls = [];
  const contentMessages = [];
  const storage = {};
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
      getURL(path) {
        return `chrome-extension://${EXTENSION_ID}/${path}`;
      },
      onConnect: { addListener() {} },
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
      sendMessage(message) {
        updates.push(copy(message));
        return Promise.resolve(undefined);
      },
      getContexts() {
        return Promise.resolve([]);
      },
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined },
      session: {
        get(key) {
          return Promise.resolve({ [key]: copy(storage[key]) });
        },
        set(values) {
          Object.assign(storage, copy(values));
          return Promise.resolve();
        },
      },
    },
    scripting: {
      executeScript(details) {
        executeCalls.push(copy(details));
        if (details.target.allFrames) return Promise.resolve(copy(injectionResults));
        const frameId = details.target.frameIds?.[0] ?? 0;
        const documentId = details.target.documentIds?.[0] ?? `doc-frame-${frameId}`;
        return Promise.resolve([{ frameId, documentId }]);
      },
    },
    tabs: {
      async sendMessage(tabId, request, options = {}) {
        contentMessages.push({ tabId, request: copy(request), options: copy(options) });
        if (request.type === "PROBE") {
          return {
            ok: true,
            videos: copy(videosByDocument.get(options.documentId) ?? []),
          };
        }
        if (request.type === "ACTIVATE") {
          return { ok: true, snapshot: mediaSnapshot() };
        }
        if (request.type === "COMMAND") {
          return {
            ok: true,
            snapshot: mediaSnapshot({ paused: !request.command.shouldPlay }),
          };
        }
        if (request.type === "SET_MUTED") {
          return { ok: true, snapshot: mediaSnapshot() };
        }
        if (request.type === "DEACTIVATE") return { ok: true };
        return { ok: false, error: "Unexpected content request" };
      },
      get(tabId) {
        return Promise.resolve({
          id: tabId,
          url: `https://watch.example.test/${tabId}`,
          status: "complete",
        });
      },
      onActivated: { addListener() {} },
      query: async () => [],
      onRemoved: {
        addListener(listener) {
          removed.push(listener);
        },
      },
      onUpdated: {
        addListener(listener) {
          changed.push(listener);
        },
      },
    },
    offscreen: {
      Reason: { AUDIO_PLAYBACK: "AUDIO_PLAYBACK" },
      createDocument() {
        return Promise.resolve();
      },
      closeDocument() {
        return Promise.resolve();
      },
    },
  };

  globalThis.chrome = chrome;
  await import(`data:text/javascript;base64,${Buffer.from(compiledWorker).toString("base64")}#${++workerImport}`);
  const workerListener = listeners.at(-1);
  assert.ok(workerListener, "service worker listener should be installed");

  function invoke(message, sender = { id: EXTENSION_ID, url: POPUP_URL }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const sendResponse = (response) => {
        if (settled) return;
        settled = true;
        resolve(response);
      };

      try {
        const keepAlive = workerListener(message, sender, sendResponse);
        if (keepAlive !== true && !settled) {
          settled = true;
          resolve(undefined);
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    });
  }

  function state() {
    return copy(storage.activeSyncState);
  }

  return { invoke, state, executeCalls, contentMessages, updates, removed, changed };
}

test("probes accessible iframe videos and routes commands to exact documents", async () => {
  const topVideo = descriptor("top-video", "Top frame");
  const iframeVideo = descriptor("iframe-video", "Embedded player");
  const h = await harness({
    injectionResults: [
      { frameId: 0, documentId: "doc-top" },
      { frameId: 7, documentId: "doc-iframe" },
      { frameId: 11, documentId: "doc-empty" },
    ],
    videosByDocument: new Map([
      ["doc-top", [topVideo]],
      ["doc-iframe", [iframeVideo]],
      ["doc-empty", []],
    ]),
  });

  const probe = await h.invoke({ type: "PROBE_TAB", tabId: 42 });
  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.deepEqual(
    probe.probe.videos.map((video) => ({
      id: video.id,
      frameId: video.frameId,
      documentId: video.documentId,
    })),
    [
      { id: "top-video", frameId: 0, documentId: "doc-top" },
      { id: "iframe-video", frameId: 7, documentId: "doc-iframe" },
    ],
  );
  assert.deepEqual(h.executeCalls[0].target, { tabId: 42, allFrames: true });
  assert.deepEqual(
    h.contentMessages
      .filter(({ request }) => request.type === "PROBE")
      .map(({ tabId, options }) => ({ tabId, options })),
    [
      { tabId: 42, options: { frameId: 0, documentId: "doc-top" } },
      { tabId: 42, options: { frameId: 7, documentId: "doc-iframe" } },
      { tabId: 42, options: { frameId: 11, documentId: "doc-empty" } },
    ],
  );

  const start = await h.invoke({
    type: "START_SYNC",
    config: {
      primary: {
        tabId: 42,
        videoId: iframeVideo.id,
        frameId: 7,
        documentId: "doc-iframe",
      },
      secondary: {
        tabId: 84,
        videoId: "secondary-video",
        frameId: 0,
        documentId: "doc-secondary",
      },
      offsetMs: 0,
    },
  });
  assert.equal(start.ok, true, JSON.stringify(start));
  const routedStartMessages = h.contentMessages.filter(({ request }) =>
    request.type === "ACTIVATE" || request.type === "COMMAND",
  );
  assert.ok(routedStartMessages.some(({ tabId, request, options }) =>
    tabId === 42 && request.type === "ACTIVATE" &&
    options.frameId === 7 && options.documentId === "doc-iframe",
  ));
  assert.ok(routedStartMessages.some(({ tabId, request, options }) =>
    tabId === 84 && request.type === "ACTIVATE" &&
    options.frameId === 0 && options.documentId === "doc-secondary",
  ));
  assert.ok(routedStartMessages.some(({ tabId, request, options }) =>
    tabId === 42 && request.type === "COMMAND" &&
    options.frameId === 7 && options.documentId === "doc-iframe",
  ));
  assert.ok(routedStartMessages.some(({ tabId, request, options }) =>
    tabId === 84 && request.type === "COMMAND" &&
    options.frameId === 0 && options.documentId === "doc-secondary",
  ));

  const current = h.state();
  const primaryEvent = {
    type: "VIDEO_EVENT",
    pairId: current.pairId,
    side: "primary",
    videoId: iframeVideo.id,
    event: "intent-pause",
    snapshot: mediaSnapshot(),
    localSequence: 1,
    appliedRevision: current.timeline.revision,
  };
  await h.invoke(primaryEvent, {
    id: EXTENSION_ID,
    tab: { id: 42 },
    frameId: 7,
    documentId: "stale-document",
  });
  assert.equal(h.state().timeline.revision, current.timeline.revision);

  await h.invoke(primaryEvent, {
    id: EXTENSION_ID,
    tab: { id: 42 },
    frameId: 0,
    documentId: "doc-iframe",
  });
  assert.equal(h.state().timeline.revision, current.timeline.revision);

  await h.invoke(primaryEvent, {
    id: EXTENSION_ID,
    tab: { id: 42 },
    frameId: 7,
    documentId: "doc-iframe",
  });
  assert.equal(h.state().timeline.revision, current.timeline.revision + 1);

  await h.invoke({
    ...primaryEvent,
    event: "element-lost",
    localSequence: 2,
    appliedRevision: current.timeline.revision + 1,
    snapshot: null,
  }, {
    id: EXTENSION_ID,
    tab: { id: 42 },
    frameId: 7,
    documentId: "doc-iframe",
  });
  assert.equal(h.state().primary.status, "lost");
});

test("legacy endpoints default to frame 0 while all-frame probes fail closed without document IDs", async () => {
  const legacy = await harness({
    injectionResults: [{ frameId: 0, documentId: "doc-legacy" }],
  });
  const start = await legacy.invoke({
    type: "START_SYNC",
    config: {
      primary: { tabId: 1, videoId: "legacy-primary" },
      secondary: { tabId: 2, videoId: "legacy-secondary" },
      offsetMs: 0,
    },
  });
  assert.equal(start.ok, true, JSON.stringify(start));
  const legacyActivations = legacy.contentMessages.filter(({ request }) => request.type === "ACTIVATE");
  assert.ok(legacyActivations.every(({ options }) =>
    options.frameId === 0 && options.documentId === undefined,
  ));

  const noMetadata = await harness({ injectionResults: [{ frameId: 0 }] });
  const noMetadataProbe = await noMetadata.invoke({ type: "PROBE_TAB", tabId: 42 });
  assert.equal(noMetadataProbe.ok, false);
  assert.match(noMetadataProbe.error, /accessible frames/i);
  assert.equal(
    noMetadata.contentMessages.filter(({ request }) => request.type === "PROBE").length,
    0,
  );

  const empty = await harness({ injectionResults: [] });
  const emptyProbe = await empty.invoke({ type: "PROBE_TAB", tabId: 42 });
  assert.equal(emptyProbe.ok, false);
  assert.match(emptyProbe.error, /accessible frames/i);
});
