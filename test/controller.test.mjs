import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

class FakeVideo {
  constructor({
    muted = false,
    readyState = 3,
    duration = 60,
    currentTime = 0,
    paused = true,
    playBehavior = "manual",
    autoSeekEvents = true,
    autoRatechange = true,
  } = {}) {
    this.muted = muted;
    this.readyState = readyState;
    this.duration = duration;
    this._currentTime = currentTime;
    this.paused = paused;
    this.ended = false;
    this._playbackRate = 1;
    this.seeking = false;
    this.isConnected = true;
    this.error = null;
    this.playBehavior = playBehavior;
    this.autoSeekEvents = autoSeekEvents;
    this.autoRatechange = autoRatechange;
    this.listeners = new Map();
    this.id = "";
    this.currentSrc = "";
    this.src = "";
    this.width = 0;
    this.height = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
  }

  get currentTime() {
    return this._currentTime;
  }

  set currentTime(value) {
    this._currentTime = value;
    if (!this.autoSeekEvents) return;
    this.dispatch("seeking");
    this.dispatch("seeked");
  }

  get playbackRate() {
    return this._playbackRate;
  }

  set playbackRate(value) {
    this._playbackRate = value;
    if (!this.autoRatechange) return;
    this.dispatch("ratechange");
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, properties = {}) {
    if (type === "seeking") this.seeking = true;
    if (type === "seeked" && !properties.leaveSeeking) this.seeking = false;
    const event = { type, ...properties };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  play() {
    if (this.playBehavior === "reject") {
      return Promise.reject(new Error("play blocked"));
    }
    if (this.playBehavior === "native") {
      this.paused = false;
      this.dispatch("play");
    }
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.dispatch("pause");
  }

  getAttribute() {
    return null;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

const videos = [];
const pagehideListeners = new Set();
globalThis.document = {
  querySelectorAll(selector) {
    return selector === "video" ? videos : [];
  },
  contains(video) {
    return video.isConnected;
  },
};
globalThis.window = {
  addEventListener(type, listener) {
    if (type === "pagehide") pagehideListeners.add(listener);
  },
};

const sourcePath = fileURLToPath(new URL("../src/content/video-controller.ts", import.meta.url));
const { outputFiles } = await build({
  entryPoints: [sourcePath],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
});
const controllerModule = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`,
);

function setupVideo(options) {
  videos.splice(0);
  pagehideListeners.clear();
  const video = new FakeVideo(options);
  videos.push(video);
  const messages = [];
  const controller = new controllerModule.VideoController({
    sendMessage(message) {
      messages.push(message);
    },
  });
  const descriptor = controller.probe()[0];
  assert.ok(descriptor);
  assert.equal(controller.activate("pair-1", "primary", descriptor.id, 0).ok, true);
  return { controller, video, messages };
}

function command(overrides = {}) {
  return {
    commandId: "command-1",
    pairId: "pair-1",
    side: "primary",
    revision: 1,
    targetTimeMs: 2_500,
    playbackRate: 1,
    shouldPlay: false,
    forceSeek: true,
    ...overrides,
  };
}

test("mute state is restored for false, replacement, loss, and pagehide", () => {
  const { controller, video, messages } = setupVideo({ muted: false });

  assert.equal(controller.setMuted("other-pair", true).ok, false);
  assert.equal(video.muted, false);
  assert.equal(controller.setMuted("pair-1", true).ok, true);
  assert.equal(video.muted, true);

  // Repeated true calls preserve the original value rather than taking a new
  // snapshot after the source has already been muted.
  video.muted = false;
  assert.equal(controller.setMuted("pair-1", true).ok, true);
  assert.equal(controller.setMuted("pair-1", false).ok, true);
  assert.equal(video.muted, false);

  assert.equal(controller.setMuted("pair-1", true).ok, true);
  for (const listener of pagehideListeners) listener({ type: "pagehide" });
  assert.equal(video.muted, false);
  assert.equal(messages.at(-1)?.event, "element-lost", "frame pagehide invalidates the endpoint");
  assert.equal(controller.setMuted("pair-1", true).ok, false, "departed selection cannot reacquire mute");
  assert.equal(controller.activate("pair-1", "primary", controller.probe()[0].id, 0).ok, true);

  assert.equal(controller.setMuted("pair-1", true).ok, true);
  video.isConnected = false;
  video.dispatch("error", { message: "source lost" });
  assert.equal(video.muted, false);
  assert.equal(messages.at(-1)?.event, "element-lost");
});

test("replacement restores the old selection before the new one is active", () => {
  videos.splice(0);
  pagehideListeners.clear();
  const first = new FakeVideo({ muted: false });
  const second = new FakeVideo({ muted: true });
  videos.push(first);
  const controller = new controllerModule.VideoController(() => undefined);
  const firstId = controller.probe()[0].id;
  assert.equal(controller.activate("pair-1", "primary", firstId, 0).ok, true);
  assert.equal(controller.setMuted("pair-1", true).ok, true);

  videos.push(second);
  const secondId = controller.probe()[1].id;
  assert.equal(controller.activate("pair-2", "primary", secondId, 1).ok, true);
  assert.equal(first.muted, false);
  assert.equal(second.muted, true);

  assert.equal(controller.setMuted("pair-2", true).ok, true);
  assert.equal(controller.deactivate("pair-2").ok, true);
  assert.equal(second.muted, true);
});

test("matched intermediate remote events do not become user intents", () => {
  const { controller, video, messages } = setupVideo({ playBehavior: "manual" });
  const response = controller.applyCommand(
    command({ shouldPlay: true, targetTimeMs: 2_500 }),
  );
  assert.equal(response.ok, true);
  assert.deepEqual(messages.map((message) => message.event), []);

  video.paused = false;
  video.dispatch("play");
  assert.deepEqual(messages.map((message) => message.event), ["remote-ack"]);
  assert.equal(messages[0].commandId, "command-1");

  video.paused = false;
  video.dispatch("pause");
  video.paused = true;
  video.dispatch("play");
  video.seeking = true;
  video.dispatch("seeked", { leaveSeeking: true });
  video.dispatch("playing");
  video.ended = false;
  video.dispatch("ended");
  assert.deepEqual(messages.map((message) => message.event), ["remote-ack"]);
});

test("same-state superseding commands carry pending native rate and seek events", () => {
  const { controller, video, messages } = setupVideo({
    autoRatechange: false,
    autoSeekEvents: false,
  });

  assert.equal(
    controller.applyCommand(
      command({
        commandId: "rate-1",
        revision: 1,
        targetTimeMs: null,
        playbackRate: 1.5,
      }),
    ).ok,
    true,
  );
  assert.deepEqual(messages, []);
  assert.equal(
    controller.applyCommand(
      command({
        commandId: "rate-2",
        revision: 2,
        targetTimeMs: null,
        playbackRate: 1.5,
      }),
    ).ok,
    true,
  );
  video.dispatch("ratechange");
  assert.equal(messages.at(-1)?.event, "remote-ack");
  assert.equal(messages.at(-1)?.commandId, "rate-2");

  messages.splice(0);
  assert.equal(
    controller.applyCommand(
      command({
        commandId: "seek-1",
        revision: 3,
        targetTimeMs: 2_500,
        forceSeek: true,
      }),
    ).ok,
    true,
  );
  assert.equal(
    controller.applyCommand(
      command({
        commandId: "seek-2",
        revision: 4,
        targetTimeMs: 2_500,
        forceSeek: false,
      }),
    ).ok,
    true,
  );
  video.seeking = false;
  video.dispatch("seeked");
  video.dispatch("ratechange");
  assert.equal(messages.at(-1)?.event, "remote-ack");
  assert.equal(messages.at(-1)?.commandId, "seek-2");
  assert.equal(messages.some((message) => message.event.startsWith("intent-")), false);
});

test("playing seek acknowledgement tolerates native playback progress", () => {
  const { controller, video, messages } = setupVideo({
    paused: false,
    autoSeekEvents: false,
  });
  assert.equal(
    controller.applyCommand(
      command({
        shouldPlay: true,
        targetTimeMs: 2_500,
        forceSeek: true,
      }),
    ).ok,
    true,
  );
  video._currentTime = 2.52;
  video.dispatch("seeked");
  assert.equal(messages.at(-1)?.event, "remote-ack");
  assert.equal(messages.some((message) => message.event === "intent-seek"), false);
});

test("targeted commands wait for loadedmetadata and keep native seek events acknowledged", () => {
  const { controller, video, messages } = setupVideo({
    readyState: 0,
    duration: Number.NaN,
  });
  assert.equal(controller.applyCommand(command()).ok, true);
  assert.equal(video.currentTime, 0);
  assert.deepEqual(messages.map((message) => message.event), []);

  video.readyState = 1;
  video.duration = 60;
  video.dispatch("loadedmetadata");
  assert.equal(video.currentTime, 2.5);
  assert.equal(messages.some((message) => message.event === "intent-seek"), false);
  assert.equal(messages.some((message) => message.event === "remote-ack"), true);
});

test("media error emits play-failed even without a play command", () => {
  const { video, messages } = setupVideo({ readyState: 0, duration: Number.NaN });
  video.dispatch("error", { message: "decode failed" });
  const failure = messages.at(-1);
  assert.equal(failure?.event, "play-failed");
  assert.equal(failure?.commandId, undefined);
  assert.equal(failure?.error, "decode failed");
});

test("native media failure remains source-wide even with a pending playback command", () => {
  const { controller, video, messages } = setupVideo({ readyState: 0, duration: Number.NaN });
  controller.applyCommand(command({ shouldPlay: true }));
  video.dispatch("error", { message: "source request failed" });
  assert.equal(messages.at(-1)?.event, "play-failed");
  assert.equal(messages.at(-1)?.commandId, undefined, "terminal media failure is not scoped to the older pending command");
});
