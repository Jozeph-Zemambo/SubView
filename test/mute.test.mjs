import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const EXTENSION_ID = "test-extension";
const PRIMARY_TAB_ID = 17;
const PRIMARY_VIDEO_ID = "primary-video";
const OFFSCREEN_VIDEO_ID = "background-video";
const OFFSCREEN_URL = `chrome-extension://${EXTENSION_ID}/offscreen.html`;

let storedState;
let offscreenOpen = false;
let originalMuted = false;
let primaryMuted = false;
let muteRequests = [];
let contentRequests = [];
const runtimeListeners = [];

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

function offscreenContentResponse(request) {
  switch (request.type) {
    case "ACTIVATE":
      return { ok: true, snapshot: mediaSnapshot() };
    case "COMMAND":
      return { ok: true, snapshot: mediaSnapshot({ paused: !request.command.shouldPlay }) };
    case "DEACTIVATE":
      return { ok: true };
    default:
      return { ok: false, error: "Unexpected offscreen request" };
  }
}

const chromeMock = {
  runtime: {
    id: EXTENSION_ID,
    ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
    onConnect: { addListener() {} },
    onMessage: {
      addListener(listener) {
        runtimeListeners.push(listener);
      },
    },
    getURL(path) {
      return `chrome-extension://${EXTENSION_ID}/${path}`;
    },
    getContexts() {
      return Promise.resolve(offscreenOpen ? [{ documentUrl: OFFSCREEN_URL }] : []);
    },
    sendMessage(message) {
      if (message?.target !== "offscreen") return Promise.resolve(undefined);
      switch (message.type) {
        case "OFFSCREEN_LOAD":
          return Promise.resolve({ ok: true, videoId: OFFSCREEN_VIDEO_ID });
        case "OFFSCREEN_CONTENT":
          return Promise.resolve(offscreenContentResponse(message.request));
        case "OFFSCREEN_VOLUME":
          return Promise.resolve({ ok: true });
        case "OFFSCREEN_STOP":
          return Promise.resolve({ ok: true });
        default:
          return Promise.resolve({ ok: false, error: "Unexpected offscreen request" });
      }
    },
  },
  storage: {
    local: { get: async () => ({}), set: async () => undefined },
    session: {
      get(key) {
        return Promise.resolve({ [key]: copy(storedState) });
      },
      set(values) {
        storedState = copy(values.activeSyncState);
        return Promise.resolve();
      },
    },
  },
  scripting: {
    executeScript() {
      return Promise.resolve([]);
    },
  },
  tabs: {
    sendMessage(_tabId, request) {
      contentRequests.push(request);
      switch (request.type) {
        case "ACTIVATE":
          return Promise.resolve({ ok: true, snapshot: mediaSnapshot() });
        case "COMMAND":
          return Promise.resolve({
            ok: true,
            snapshot: mediaSnapshot({ paused: !request.command.shouldPlay }),
          });
        case "SET_MUTED":
          muteRequests.push(request.muted);
          primaryMuted = request.muted ? true : originalMuted;
          return Promise.resolve({ ok: true, snapshot: mediaSnapshot() });
        case "DEACTIVATE":
          primaryMuted = originalMuted;
          return Promise.resolve({ ok: true });
        default:
          return Promise.resolve({ ok: false, error: "Unexpected content request" });
      }
    },
    onActivated: { addListener() {} },
    query: async () => [],
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
  },
  offscreen: {
    Reason: { AUDIO_PLAYBACK: "AUDIO_PLAYBACK" },
    createDocument() {
      offscreenOpen = true;
      return Promise.resolve();
    },
    closeDocument() {
      offscreenOpen = false;
      return Promise.resolve();
    },
  },
};

globalThis.chrome = chromeMock;

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
await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`,
);
// The detector host is imported before the worker's listener and owns the
// GET_LANGUAGE_DETECTION request. These tests exercise only the worker's
// listener so that the two contracts stay independent.
const workerListener = runtimeListeners.at(-1);

function state() {
  return copy(storedState);
}

function invoke(message, sender = { id: EXTENSION_ID }) {
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

async function startBackground(muteOriginal) {
  const config = {
    primary: { tabId: PRIMARY_TAB_ID, videoId: PRIMARY_VIDEO_ID },
    sourceUrl: "https://example.test/background.wav",
    volume: 0.5,
    offsetMs: 0,
  };
  if (muteOriginal !== undefined) config.muteOriginal = muteOriginal;
  const response = await invoke({ type: "START_BACKGROUND_AUDIO", config });
  assert.equal(response?.ok, true, JSON.stringify(response));
  return state();
}

async function emitSecondaryPlaying() {
  const current = state();
  return invoke(
    {
      type: "VIDEO_EVENT",
      pairId: current.pairId,
      side: "secondary",
      videoId: current.secondary.endpoint.videoId,
      event: "playing",
      snapshot: mediaSnapshot({ paused: false }),
      localSequence: 1,
      appliedRevision: current.timeline.revision,
    },
    { id: EXTENSION_ID, url: OFFSCREEN_URL, frameId: 0 },
  );
}

test("background mute preference defaults safely, persists, and toggles live", async () => {
  originalMuted = false;
  primaryMuted = false;
  muteRequests = [];
  contentRequests = [];

  let current = await startBackground();
  assert.equal(current.backgroundAudio.muteOriginal, true);
  assert.deepEqual(muteRequests, [], "visible media stays unmuted until audio plays");

  await emitSecondaryPlaying();
  assert.equal(primaryMuted, true);
  assert.deepEqual(muteRequests, [true]);

  let response = await invoke({ type: "SET_MUTE_ORIGINAL", muteOriginal: false });
  assert.equal(response.ok, true);
  current = state();
  assert.equal(current.backgroundAudio.muteOriginal, false);
  assert.equal(primaryMuted, false);
  assert.deepEqual(muteRequests, [true, false]);

  response = await invoke({ type: "SET_MUTE_ORIGINAL", muteOriginal: true });
  assert.equal(response.ok, true);
  current = state();
  assert.equal(current.backgroundAudio.muteOriginal, true);
  assert.equal(primaryMuted, true, "enabling live reclaims mute while audio is playing");
  assert.deepEqual(muteRequests, [true, false, true]);
  assert.equal(state().backgroundAudio.muteOriginal, true, "preference is persisted");

  const beforeInvalidRequest = state();
  assert.equal(await invoke({ type: "SET_MUTE_ORIGINAL", muteOriginal: "yes" }), undefined);
  assert.deepEqual(state(), beforeInvalidRequest, "invalid preference is rejected by worker validation");

  assert.equal(
    await invoke({ type: "GET_LANGUAGE_DETECTION", tabId: PRIMARY_TAB_ID }),
    undefined,
    "language detection remains owned by its dedicated listener",
  );

  response = await invoke({ type: "STOP_SYNC" });
  assert.equal(response.ok, true);
  assert.equal(primaryMuted, false);
});

test("false initial preference never acquires mute ownership", async () => {
  originalMuted = false;
  primaryMuted = false;
  muteRequests = [];

  const current = await startBackground(false);
  assert.equal(current.backgroundAudio.muteOriginal, false);
  assert.deepEqual(muteRequests, []);

  await emitSecondaryPlaying();
  assert.equal(primaryMuted, false);
  assert.deepEqual(muteRequests, []);

  await invoke({ type: "STOP_SYNC" });
});

test("releasing ownership preserves media that was originally muted", async () => {
  originalMuted = true;
  primaryMuted = true;
  muteRequests = [];

  await startBackground(true);
  await emitSecondaryPlaying();
  assert.equal(primaryMuted, true);

  const response = await invoke({ type: "SET_MUTE_ORIGINAL", muteOriginal: false });
  assert.equal(response.ok, true);
  assert.equal(primaryMuted, true, "release restores the original muted state");
  await invoke({ type: "STOP_SYNC" });
  assert.equal(primaryMuted, true);
});

test("background audio cannot pull a buffering primary seek back to the Dub position", async () => {
  await startBackground(false);
  let sequence = 0;
  const emit = async (side, event, snapshot, revision = state().timeline.revision) => {
    const current = state();
    await invoke({ type: "VIDEO_EVENT", pairId: current.pairId, side,
      videoId: current[side].endpoint.videoId, event, snapshot,
      localSequence: ++sequence, appliedRevision: revision }, side === "primary"
      ? { id: EXTENSION_ID, tab: { id: PRIMARY_TAB_ID }, frameId: 0 }
      : { id: EXTENSION_ID, url: OFFSCREEN_URL, frameId: 0 });
  };
  const snapshot = (time, extra = {}) => ({ ...mediaSnapshot({ paused: false, currentTimeMs: time }), durationMs: 600000, ...extra });
  await emit("primary", "intent-play", snapshot(90000));
  await emit("secondary", "playing", snapshot(90000));
  contentRequests = [];
  await emit("primary", "intent-seek", snapshot(300000));
  await emit("primary", "buffering", snapshot(300000, { readyState: 2 }));
  await emit("secondary", "observation", snapshot(91000));
  assert.equal(state().timeline.authority, "primary", "buffering must not promote Dub");
  assert.equal(state().timeline.positionMs, 300000, "Sub's chosen position must survive old Dub observations");
  assert.deepEqual(contentRequests.filter(r => r.type === "COMMAND"), [], "never send playback corrections to Sub");
  // The untouched primary has no COMMAND revision to acknowledge.
  await emit("primary", "playing", snapshot(300100), 0);
  assert.equal(state().timeline.positionMs, 300100, "accept observations from a read-only primary");
  await emit("secondary", "intent-seek", snapshot(92000));
  assert.equal(state().timeline.positionMs, 300100, "Dub gestures cannot reposition Sub");
  await emit("secondary", "intent-pause", snapshot(92000, { paused: true }));
  assert.equal(state().timeline.playing, true, "Dub gestures cannot pause Sub");
  await invoke({ type: "STOP_SYNC" });
});
