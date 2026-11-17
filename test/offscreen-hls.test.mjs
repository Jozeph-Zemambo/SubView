import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const hlsMock = `
export default class Hls {
  static Events = { ERROR: "error" };
  static isSupported() { return globalThis.__hlsSupported; }
  constructor(config) {
    this.config = config;
    this.listeners = new Map();
    this.destroyed = false;
    globalThis.__hlsInstances.push(this);
  }
  on(event, listener) {
    this.listeners.set(event, listener);
  }
  attachMedia(video) {
    this.video = video;
  }
  loadSource(url) {
    this.url = url;
  }
  destroy() {
    this.destroyed = true;
  }
  fatal(message = "manifest load failed") {
    this.listeners.get(Hls.Events.ERROR)?.(Hls.Events.ERROR, {
      fatal: true,
      type: "networkError",
      details: "manifestLoadError",
      response: { code: 403, url: 'https://cdn.test/master.m3u8?token=never-show-this' },
      error: new Error(message),
    });
  }
}
`;

const compiled = await build({
  entryPoints: ["src/offscreen/offscreen.ts"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  plugins: [{
    name: "mock-hls",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^hls\.js$/ }, () => ({ path: "hls-mock", namespace: "mock-hls" }));
      buildApi.onLoad({ filter: /^hls-mock$/, namespace: "mock-hls" }, () => ({ contents: hlsMock, loader: "js" }));
    },
  }],
});

class FakeVideo {
  constructor() {
    this.listeners = new Map();
    this.muted = false;
    this.volume = 1;
    this.readyState = 0;
    this.duration = Number.NaN;
    this.currentTime = 0;
    this.paused = true;
    this.ended = false;
    this.playbackRate = 1;
    this.seeking = false;
    this.isConnected = true;
    this.error = null;
    this.src = "";
    this.currentSrc = "";
    this.attributes = new Map();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event) {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
    return true;
  }
  pause() {
    this.paused = true;
    this.dispatchEvent({ type: "pause" });
  }
  load() {
    this.readyState = 0;
    this.currentSrc = this.src;
  }
  canPlayType(type) {
    return type === "application/vnd.apple.mpegurl" ? globalThis.__nativeHlsSupport : "";
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this.src = "";
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

const vmRun = code => vm.runInThisContext(code, { filename: "offscreen.js" });

function installPage(video, messages, listeners) {
  globalThis.document = {
    querySelector: selector => selector === "#offscreen-video" ? video : null,
    querySelectorAll: selector => selector === "video" ? [video] : [],
    contains: () => video.isConnected,
  };
  globalThis.window = { addEventListener() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: listener => listeners.push(listener) },
      sendMessage: message => { messages.push(message); return Promise.resolve(); },
    },
  };
}

test("HLS attaches with workers disabled, fatal errors use the controller lifecycle, and STOP destroys it", async () => {
  const video = new FakeVideo();
  const messages = [];
  const listeners = [];
  globalThis.__hlsInstances = [];
  globalThis.__hlsSupported = true;
  globalThis.__nativeHlsSupport = "";
  installPage(video, messages, listeners);
  vmRun(compiled.outputFiles[0].text);

  const ask = message => new Promise(resolve => listeners[0](message, {}, resolve));
  const loaded = await ask({ target: "offscreen", type: "OFFSCREEN_LOAD", url: "https://cdn.example.test/stream.m3u8", volume: 0.25 });
  assert.equal(loaded.ok, true);
  assert.equal(globalThis.__hlsInstances.length, 1);
  const player = globalThis.__hlsInstances[0];
  assert.deepEqual(player.config, { enableWorker: false });
  assert.equal(player.video, video);
  assert.equal(player.url, "https://cdn.example.test/stream.m3u8");

  const replacement = await ask({ target: "offscreen", type: "OFFSCREEN_LOAD", url: "https://cdn.example.test/replacement.m3u8", volume: 0.25 });
  assert.equal(replacement.ok, true);
  assert.equal(player.destroyed, true);
  const replacementPlayer = globalThis.__hlsInstances[1];

  const activated = await ask({
    target: "offscreen",
    type: "OFFSCREEN_CONTENT",
    request: { type: "ACTIVATE", pairId: "pair-1", side: "secondary", videoId: replacement.videoId, revision: 0 },
  });
  assert.equal(activated.ok, true);
  replacementPlayer.fatal("manifest unavailable");
  await new Promise(setImmediate);
  assert.equal(replacementPlayer.destroyed, true);
  assert.equal(messages.at(-1).event, "play-failed");
  assert.match(messages.at(-1).error, /403/);
  assert.match(messages.at(-1).error, /manifest/i);
  assert.equal(messages.at(-1).error.includes('never-show-this'), false);

  const thirdLoad = await ask({ target: "offscreen", type: "OFFSCREEN_LOAD", url: "https://cdn.example.test/stop.m3u8", volume: 0.25 });
  assert.equal(thirdLoad.ok, true);
  const stopPlayer = globalThis.__hlsInstances[2];
  const stopped = await ask({ target: "offscreen", type: "OFFSCREEN_STOP" });
  assert.equal(stopped.ok, true);
  assert.equal(stopPlayer.destroyed, true);
  assert.equal(video.src, "");
});

test("HLS falls back to native playback when hls.js is unsupported", async () => {
  const video = new FakeVideo();
  const listeners = [];
  globalThis.__hlsInstances = [];
  globalThis.__hlsSupported = false;
  globalThis.__nativeHlsSupport = "maybe";
  installPage(video, [], listeners);
  vmRun(compiled.outputFiles[0].text);
  const ask = message => new Promise(resolve => listeners[0](message, {}, resolve));
  const result = await ask({ target: "offscreen", type: "OFFSCREEN_LOAD", url: "https://cdn.example.test/native.m3u8", volume: 1 });
  assert.equal(result.ok, true);
  assert.equal(video.src, "https://cdn.example.test/native.m3u8");
  assert.equal(globalThis.__hlsInstances.length, 0);
});

test("offscreen rejects invalid or root-mismatched graph payloads and bare site blob URLs",async()=>{
  const video=new FakeVideo(),listeners=[];
  globalThis.__hlsInstances=[];globalThis.__hlsSupported=true;installPage(video,[],listeners);vmRun(compiled.outputFiles[0].text);
  const ask=message=>new Promise(resolve=>listeners[0]({target:"offscreen",type:"OFFSCREEN_LOAD",volume:.3,...message},{},resolve));
  const rootUrl="blob:https://player.test/active",sourceGraph={rootUrl,manifests:[{url:rootUrl,body:"#EXTM3U\n#EXTINF:1,\nhttps://media.test/a.aac\n#EXT-X-ENDLIST"}]};
  assert.equal((await ask({url:rootUrl})).ok,false);
  assert.equal((await ask({url:"blob:https://player.test/other",sourceGraph})).ok,false);
  assert.equal((await ask({url:rootUrl,sourceGraph:{...sourceGraph,manifests:[]}})).ok,false);
  assert.equal(globalThis.__hlsInstances.length,0);
});
