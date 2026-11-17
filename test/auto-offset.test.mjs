import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const EXTENSION_ID = "auto-offset-test-extension";
const PRIMARY_TAB_ID = 17;
const SECONDARY_TAB_ID = 23;
const OFFSCREEN_TAB_ID = -1;
const OFFSCREEN_URL = `chrome-extension://${EXTENSION_ID}/offscreen.html`;

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
const { outputFiles: helperOutput } = await build({
  entryPoints: [fileURLToPath(new URL("../src/shared/auto-offset.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
});
const autoOffset = await import(
  `data:text/javascript;base64,${Buffer.from(helperOutput[0].text).toString("base64")}`,
);
let workerImport = 0;

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function snapshot({ durationMs, currentTimeMs = 0, paused = true } = {}) {
  return {
    currentTimeMs,
    durationMs,
    paused,
    ended: false,
    playbackRate: 1,
    readyState: 3,
    canPlay: true,
  };
}

async function harness({ primary, secondary, background = false, initialStorage = {}, initialRules = [] } = {}) {
  const listeners = [];
  const updates = [];
  const requests = [];
  const storage = copy(initialStorage);
  let mediaRules = copy(initialRules);
  let offscreenOpen = false;

  const snapshots = new Map([
    [PRIMARY_TAB_ID, copy(primary ?? snapshot({ durationMs: 10_000 }))],
    [SECONDARY_TAB_ID, copy(secondary ?? snapshot({ durationMs: 20_000 }))],
    [OFFSCREEN_TAB_ID, copy(secondary ?? snapshot({ durationMs: 20_000 }))],
  ]);

  const chrome = {
    declarativeNetRequest: {
      getSessionRules: async () => copy(mediaRules),
      updateSessionRules: async ({removeRuleIds, addRules = []}) => {
        mediaRules = mediaRules.filter(rule => !removeRuleIds.includes(rule.id)).concat(copy(addRules));
      },
    },
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
        removeListener() {},
      },
      sendMessage(message) {
        if (message?.target === "offscreen") {
          requests.push({ tabId: OFFSCREEN_TAB_ID, request: copy(message) });
          if (message.type === "OFFSCREEN_LOAD") {
            requests.at(-1).rulesAtLoad = copy(mediaRules);
            offscreenOpen = true;
            return Promise.resolve({ ok: true, videoId: "background-video" });
          }
          if (message.type === "OFFSCREEN_CONTENT") {
            const request = message.request;
            if (request.type === "ACTIVATE") {
              return Promise.resolve({
                ok: true,
                snapshot: copy(snapshots.get(OFFSCREEN_TAB_ID)),
              });
            }
            if (request.type === "COMMAND") {
              return Promise.resolve({
                ok: true,
                snapshot: copy(snapshots.get(OFFSCREEN_TAB_ID)),
              });
            }
            return Promise.resolve({ ok: true });
          }
          return Promise.resolve({ ok: true });
        }
        updates.push(copy(message));
        return Promise.resolve(undefined);
      },
      getContexts() {
        return Promise.resolve(
          offscreenOpen ? [{ documentUrl: OFFSCREEN_URL }] : [],
        );
      },
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined },
      session: {
        get(key) {
          if (typeof key === "string") return Promise.resolve({ [key]: copy(storage[key]) });
          return Promise.resolve(copy(storage));
        },
        set(values) {
          Object.assign(storage, copy(values));
          return Promise.resolve();
        },
      },
    },
    scripting: {
      executeScript() {
        return Promise.resolve([{ frameId: 0, documentId: "document-0" }]);
      },
    },
    tabs: {
      sendMessage(tabId, request, options = {}) {
        requests.push({ tabId, request: copy(request), options: copy(options) });
        const media = snapshots.get(tabId) ?? snapshot({ durationMs: null });
        if (request.type === "ACTIVATE") {
          return Promise.resolve({ ok: true, snapshot: copy(media) });
        }
        if (request.type === "COMMAND") {
          return Promise.resolve({ ok: true, snapshot: copy(media) });
        }
        if (request.type === "PROBE") {
          return Promise.resolve({ ok: true, videos: [] });
        }
        return Promise.resolve({ ok: true });
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
      onRemoved: { addListener() {}, removeListener() {} },
      onUpdated: { addListener() {}, removeListener() {} },
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

  globalThis.chrome = chrome;
  await import(
    `data:text/javascript;base64,${Buffer.from(compiledWorker).toString("base64")}#${++workerImport}`,
  );
  const workerListener = listeners.at(-1);
  assert.ok(workerListener, "service worker listener should be installed");

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

  function state() {
    return copy(storage.activeSyncState);
  }

  return {
    invoke,
    state,
    requests,
    updates,
    background,
    rules: () => copy(mediaRules),
  };
}

function startConfig({ offsetMs = 2_000, autoOffset = true } = {}) {
  return {
    primary: { tabId: PRIMARY_TAB_ID, videoId: "primary-video" },
    secondary: { tabId: SECONDARY_TAB_ID, videoId: "secondary-video" },
    offsetMs,
    autoOffset,
  };
}

function commands(harnessResult) {
  return harnessResult.requests
    .filter(({ request }) => request.type === "COMMAND")
    .map(({ request }) => request.command);
}

test("auto-offset helpers preserve exact millisecond differences and expose pending live lengths", () => {
  assert.equal(autoOffset.deriveAutoOffset(10_000, 37_585), 27_585);
  assert.equal(autoOffset.deriveAutoOffset(Number.POSITIVE_INFINITY, 37_585), null);
  assert.deepEqual(
    autoOffset.resolveAutoOffset(2_000, true, null, 37_585),
    { offsetMs: 2_000, pending: true },
  );
  assert.equal(
    autoOffset.canonicalPositionFor(0, -27_585, "primary", true),
    27_585,
  );
});

test("auto offset follows the effective duration difference and restores the manual offset", async () => {
  const h = await harness({
    primary: snapshot({ durationMs: 10_000 }),
    secondary: snapshot({ durationMs: 20_000 }),
  });

  const started = await h.invoke({
    type: "START_SYNC",
    config: startConfig({ offsetMs: 2_000, autoOffset: true }),
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.state.autoOffset, true);
  assert.equal(started.state.manualOffsetMs, 2_000);
  assert.equal(started.state.offsetMs, 12_000);
  assert.equal(started.state.autoOffsetPending, false);

  const initialCommands = commands(h);
  assert.equal(
    initialCommands.find((command) => command.side === "secondary").targetTimeMs,
    12_000,
    "the longer Dub skips its ten-second excess plus the manual correction",
  );

  const disabled = await h.invoke({ type: "SET_AUTO_OFFSET", enabled: false });
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  assert.equal(disabled.state.autoOffset, false);
  assert.equal(disabled.state.manualOffsetMs, 2_000);
  assert.equal(disabled.state.offsetMs, 2_000);

  const reenabled = await h.invoke({ type: "SET_AUTO_OFFSET", enabled: true });
  assert.equal(reenabled.ok, true, JSON.stringify(reenabled));
  assert.equal(reenabled.state.autoOffset, true);
  assert.equal(reenabled.state.offsetMs, 12_000);
});

test("a longer primary gets a negative offset and skips its lead-in", async () => {
  const h = await harness({
    primary: snapshot({ durationMs: 20_000 }),
    secondary: snapshot({ durationMs: 10_000 }),
  });

  const started = await h.invoke({
    type: "START_SYNC",
    config: startConfig({ offsetMs: 1_500, autoOffset: true }),
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.state.offsetMs, -8_500);
  assert.equal(started.state.manualOffsetMs, 1_500);
  assert.equal(started.state.autoOffsetPending, false);
  assert.equal(started.state.timeline.positionMs, 8_500);

  const initialCommands = commands(h);
  assert.equal(
    initialCommands.find((command) => command.side === "primary").targetTimeMs,
    8_500,
    "the longer primary starts after its lead-in with the manual correction",
  );
  assert.equal(
    initialCommands.find((command) => command.side === "secondary").targetTimeMs,
    0,
  );
});

test("auto offset does not guess when a duration is unknown", async () => {
  const h = await harness({
    primary: snapshot({ durationMs: null }),
    secondary: snapshot({ durationMs: 37_585 }),
  });

  const started = await h.invoke({
    type: "START_SYNC",
    config: startConfig({ offsetMs: 2_500, autoOffset: true }),
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.state.autoOffset, true);
  assert.equal(started.state.manualOffsetMs, 2_500);
  assert.equal(
    started.state.offsetMs,
    2_500,
    "unknown/live media keeps the configured manual offset",
  );
  assert.equal(started.state.autoOffsetPending, true);

  const initialCommands = commands(h);
  assert.equal(
    initialCommands.find((command) => command.side === "secondary").targetTimeMs,
    2_500,
  );

  // A later metadata observation resolves the pending setting without a
  // timer or a guessed duration, preserving the exact 27,585 ms difference.
  const beforeRevision = started.state.timeline.revision;
  await h.invoke(
    {
      type: "VIDEO_EVENT",
      pairId: started.state.pairId,
      side: "primary",
      videoId: "primary-video",
      event: "observation",
      snapshot: snapshot({ durationMs: 10_000 }),
      localSequence: 1,
      appliedRevision: beforeRevision,
    },
    { id: EXTENSION_ID, tab: { id: PRIMARY_TAB_ID }, frameId: 0 },
  );

  const resolved = h.state();
  assert.equal(resolved.autoOffsetPending, false);
  assert.equal(resolved.offsetMs, 30_085);
  assert.equal(resolved.manualOffsetMs, 2_500);
  const resolvedCommands = commands(h).filter(
    (command) => command.side === "secondary",
  );
  assert.equal(
    resolvedCommands.at(-1).targetTimeMs,
    30_085,
    "the longer secondary receives the precise resolved target plus correction",
  );
});

test("background audio carries auto offset through start and SET_AUTO_OFFSET", async () => {
  const h = await harness({
    primary: snapshot({ durationMs: 10_000 }),
    secondary: snapshot({ durationMs: 20_000 }),
    background: true,
  });

  const started = await h.invoke({
    type: "START_BACKGROUND_AUDIO",
    config: {
      primary: { tabId: PRIMARY_TAB_ID, videoId: "primary-video" },
      sourceUrl: "https://media.example.test/dub.wav",
      volume: 0.5,
      offsetMs: 3_000,
      autoOffset: true,
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.state.autoOffset, true);
  assert.equal(started.state.manualOffsetMs, 3_000);
  assert.equal(started.state.offsetMs, 13_000);
  assert.equal(started.state.autoOffsetPending, false);
  assert.equal(started.state.secondary.endpoint.tabId, OFFSCREEN_TAB_ID);

  const disabled = await h.invoke({ type: "SET_AUTO_OFFSET", enabled: false });
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  assert.equal(disabled.state.offsetMs, 3_000);
  assert.equal(disabled.state.manualOffsetMs, 3_000);
});


test("manual correction adds to auto offset while Sub stays in charge", async () => {
  const h = await harness({ primary: snapshot({ durationMs: 10_000, currentTimeMs: 4_000 }), secondary: snapshot({ durationMs: 20_000, currentTimeMs: 14_000 }) });
  const started = await h.invoke({ type: "START_BACKGROUND_AUDIO", config: { primary: { tabId: PRIMARY_TAB_ID, videoId: "primary-video" }, sourceUrl: "https://media.example.test/dub.wav", volume: 0.5, offsetMs: 0, autoOffset: true } });
  assert.equal(started.ok, true);
  h.requests.length = 0;
  const corrected = await h.invoke({ type: "SET_MANUAL_OFFSET", offsetMs: -500 });
  assert.equal(corrected.ok, true, JSON.stringify(corrected));
  assert.equal(corrected.state.autoOffset, true);
  assert.equal(corrected.state.manualOffsetMs, -500);
  assert.equal(corrected.state.offsetMs, 9_500);
  assert.equal(corrected.state.timeline.positionMs, 4_000);
  assert.equal(commands(h).filter(command => command.side === "primary").length, 0, "timing corrections must not seek Sub");
  const dubCommands = h.requests.filter(({ request }) => request.type === "OFFSCREEN_CONTENT" && request.request?.type === "COMMAND");
  assert.equal(dubCommands.at(-1).request.request.command.targetTimeMs, 13_500);
});


test("manual correction at a negative Dub target preserves Sub and survives auto toggling", async () => {
  const h = await harness({ primary: snapshot({ durationMs: 20_000, currentTimeMs: 10_000 }), secondary: snapshot({ durationMs: 10_000 }) });
  const started = await h.invoke({ type: "START_BACKGROUND_AUDIO", config: { primary: { tabId: PRIMARY_TAB_ID, videoId: "primary-video" }, sourceUrl: "https://media.example.test/dub.wav", volume: 0.5, offsetMs: 0, autoOffset: true } });
  assert.equal(started.ok, true);
  h.requests.length = 0;
  const corrected = await h.invoke({ type: "SET_MANUAL_OFFSET", offsetMs: -500 });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.state.offsetMs, -10_500);
  assert.equal(corrected.state.timeline.positionMs, 10_000, "a negative Dub target must not reposition Sub");
  assert.equal(commands(h).filter(command => command.side === "primary").length, 0);
  const disabled = await h.invoke({ type: "SET_AUTO_OFFSET", enabled: false });
  assert.equal(disabled.state.offsetMs, -500);
  const manual = await h.invoke({ type: "SET_MANUAL_OFFSET", offsetMs: 500 });
  assert.equal(manual.state.offsetMs, 500);
  assert.equal(manual.state.timeline.positionMs, 10_000);
  const reenabled = await h.invoke({ type: "SET_AUTO_OFFSET", enabled: true });
  assert.equal(reenabled.state.offsetMs, -9_500);
  assert.equal(reenabled.state.manualOffsetMs, 500);
});


test("hidden Dub waiting for playable data is not reported as active", async () => {
  const h = await harness({
    primary: snapshot({ durationMs: 60_000, currentTimeMs: 15_000, paused: false }),
    secondary: { ...snapshot({ durationMs: 60_000 }), canPlay: false, readyState: 1 },
  });
  const started = await h.invoke({ type: "START_BACKGROUND_AUDIO", config: { primary: { tabId: PRIMARY_TAB_ID, videoId: "primary-video" }, sourceUrl: "https://media.test/dub.m3u8", volume: 0.5, offsetMs: 0 } });
  assert.equal(started.ok, true);
  assert.equal(started.state.secondary.pendingCommand.shouldPlay, true);
  assert.equal(started.state.status, "buffering", "play intent alone does not prove audible Dub");
  assert.equal(started.state.message, "Waiting for Dub audio.");
  const emit = async (side, event, media, sequence) => {
    const state = h.state();
    await h.invoke({ type:"VIDEO_EVENT", pairId:state.pairId, side, videoId:state[side].endpoint.videoId, event, snapshot:media, localSequence:sequence, appliedRevision:state.timeline.revision }, side === "primary" ? {id:EXTENSION_ID,tab:{id:PRIMARY_TAB_ID},frameId:0} : {id:EXTENSION_ID,url:OFFSCREEN_URL});
  };
  await emit("secondary", "observation", { ...snapshot({durationMs:60_000}),canPlay:false,readyState:1 }, 1);
  assert.equal(h.state().status, "buffering", "paused metadata-only observations remain waiting");
  await emit("secondary", "playing", snapshot({durationMs:60_000,currentTimeMs:15_000,paused:false}), 2);
  assert.equal(h.state().status, "active");
  assert.equal(h.state().message, null);
  await emit("primary", "intent-pause", snapshot({durationMs:60_000,currentTimeMs:15_000,paused:true}), 1);
  await emit("secondary", "observation", snapshot({durationMs:60_000,currentTimeMs:15_000,paused:true}), 3);
  assert.equal(h.state().status, "paused", "normal user pause is not buffering");
});

test("a media failure emitted during recreation survives a newer primary intent", async () => {
  const h = await harness();
  const started = await h.invoke({type:"START_BACKGROUND_AUDIO",config:{primary:{tabId:PRIMARY_TAB_ID,videoId:"primary-video"},sourceUrl:"https://media.test/ticket.wav",volume:0.5,offsetMs:0}});
  const beforeRevision = started.state.timeline.revision;
  await h.invoke({type:"VIDEO_EVENT",pairId:started.state.pairId,side:"primary",videoId:"primary-video",event:"intent-play",snapshot:snapshot({durationMs:60_000,paused:false}),localSequence:1,appliedRevision:beforeRevision}, {id:EXTENSION_ID,tab:{id:PRIMARY_TAB_ID},frameId:0});
  assert.ok(h.state().timeline.revision > beforeRevision);
  await h.invoke({type:"VIDEO_EVENT",pairId:started.state.pairId,side:"secondary",videoId:started.state.secondary.endpoint.videoId,event:"play-failed",error:"MEDIA_ERR_SRC_NOT_SUPPORTED: server returned403",snapshot:{...snapshot({durationMs:null}),readyState:0,canPlay:false},localSequence:1,appliedRevision:beforeRevision},{id:EXTENSION_ID,url:OFFSCREEN_URL});
  assert.equal(h.state().secondary.status,"play-failed", "native media failure cannot be discarded just because Sub advanced revision");
  assert.equal(h.state().status,"error");
});


test("an old play command rejection cannot override a newer Sub pause", async () => {
  const h = await harness();
  const started = await h.invoke({type:"START_BACKGROUND_AUDIO",config:{primary:{tabId:PRIMARY_TAB_ID,videoId:"primary-video"},sourceUrl:"https://media.test/ticket.wav",volume:0.5,offsetMs:0}});
  const beforeRevision = started.state.timeline.revision;
  await h.invoke({type:"VIDEO_EVENT",pairId:started.state.pairId,side:"primary",videoId:"primary-video",event:"intent-pause",snapshot:snapshot({durationMs:60_000,paused:true}),localSequence:1,appliedRevision:beforeRevision},{id:EXTENSION_ID,tab:{id:PRIMARY_TAB_ID},frameId:0});
  await h.invoke({type:"VIDEO_EVENT",pairId:started.state.pairId,side:"secondary",videoId:started.state.secondary.endpoint.videoId,event:"play-failed",commandId:"old-play-command",error:"NotAllowedError",snapshot:snapshot({durationMs:60_000,paused:true}),localSequence:1,appliedRevision:beforeRevision},{id:EXTENSION_ID,url:OFFSCREEN_URL});
  assert.equal(h.state().status,"paused");
  assert.notEqual(h.state().secondary.status,"play-failed");
  assert.equal(h.state().manualPlayRequired,null);
});
