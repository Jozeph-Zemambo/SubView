import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['src/background/auto-dub.ts'], bundle: true, write: false,
  format: 'iife', globalName: 'autoModule', platform: 'browser',
  plugins: [{ name: 'detection-fixture', setup(builder) {
    builder.onResolve({ filter: /^\.\/language-detection-host$/ }, () => ({ path: 'detector', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      export function onLanguageDetection(fn) { globalThis.receiveDetection = fn; }
      export async function inspectLanguage(tabId) {
        const value = globalThis.fixtureDetection;
        globalThis.receiveDetection(tabId, value);
        return value;
      }
    ` }));
  } }],
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function harness() {
  const listeners = [], navigations = [], closed = [], activations = [];
  const storage = {}, local = {};
  const config = { tabId: 1, volume: .8, offsetMs: 0, muteOriginal: true };
  const detection = {
    pageUrl: 'https://watch.test/episode/1', language: 'sub', available: ['sub', 'dub'],
    dubCandidates: [], provider: 'alpha · s-sub', reason: 'Selected Sub', evidence: ['select'],
  };
  let sync = null, serial = 0, queue = Promise.resolve();
  const starts = [], lookups = [];
  let hostCloses = 0;
  const sandbox = {
    URL, console, AbortController, setTimeout, clearTimeout, fixtureDetection: detection,
    chrome: {
      storage: {
        session: { get: async () => storage, set: async value => Object.assign(storage, value) },
        local: { get: async () => local, set: async value => Object.assign(local, JSON.parse(JSON.stringify(value))) },
      },
      runtime: { id: 'ext', getURL: path => `chrome-extension://ext/${path}`,
        onMessage: { addListener: fn => listeners.push(fn) }, sendMessage: async () => undefined },
      tabs: {
        get: async id => ({ id, active: true, url: sandbox.fixtureDetection.pageUrl }),
        query: async () => [],
        onActivated: { addListener: fn => activations.push(fn) },
        onUpdated: { addListener: fn => navigations.push(fn) },
        onRemoved: { addListener: fn => closed.push(fn) },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(compiled.outputFiles[0].text, sandbox);
  const video = { id: 'video-1', source: 'https://media.test/sub.m3u8', readyState: 4, frameId: 2, documentId: 'doc', durationMs: 1_440_000 };
  const hooks = {
    enqueue(fn) { const next = queue.then(fn); queue = next.catch(() => undefined); return next; },
    getState: () => sync,
    probe: async () => ({ ok: true, tabId: 1, videos: [video] }),
    startHosted: async value => {
      starts.push(value);
      sync = { pairId: `pair-${++serial}`, status: 'active', offsetMs: value.offsetMs,
        timeline: { playing: false, positionMs: 0 },
        secondary: { status: 'paused', snapshot: { durationMs: 1_450_000 } }, primary: { status: 'paused', endpoint: value.primary } };
      return { ok: true, state: sync };
    },
    stop: async () => { sync = null; },
    findDub: request => { const d = deferred(); lookups.push({ request, ...d }); return d.promise; },
    replacement: null,
    findReplacement: async () => hooks.replacement,
    closeHost: async () => { hostCloses += 1; },
  };
  const api = sandbox.autoModule.setupAutoDub(hooks);
  const ask = message => new Promise(resolve => listeners[0](message,
    { id: 'ext', url: 'chrome-extension://ext/popup.html' }, resolve));
  const flush = async () => { for (let i = 0; i < 6; i++) { await queue; await new Promise(setImmediate); } };
  const change = async delta => {
    sandbox.fixtureDetection = { ...sandbox.fixtureDetection, ...delta };
    sandbox.receiveDetection(1, sandbox.fixtureDetection);
    await flush();
  };
  const found = (request, overrides = {}) => ({
    pageUrl: request.pageUrl, container: request.container, provider: 'alpha',
    endpoint: { tabId: -2, videoId: 'dub-video', documentId: 'hosted-doc' }, ...overrides,
  });
  const status = async () => (await ask({ type: 'GET_AUTO_DUB' })).autoDub;
  // The popup turns Auto Dub on for the current tab's site, with its settings.
  const enable = (cfg = config) => ask({ type: 'SET_AUTO_DUB_SITE', site: 'watch.test', enabled: true, tabId: cfg.tabId,
    settings: { volume: cfg.volume, offsetMs: cfg.offsetMs, muteOriginal: cfg.muteOriginal } });
  const turnOff = () => ask({ type: 'SET_AUTO_DUB_SITE', site: 'watch.test', enabled: false });
  return { config, ask, starts, lookups, hooks, api, change, flush, sandbox, video, storage, local, navigations, activations, found, status, enable, turnOff,
    hostCloses: () => hostCloses, sync: () => sync, setSync: value => { sync = value; } };
}

test('Auto Dub is opt-in and links the hosted Dub video once per episode', async () => {
  const h = harness();
  await h.flush();
  assert.equal(await h.status(), null);
  assert.equal(h.lookups.length, 0);

  assert.equal((await h.enable()).ok, true);
  await h.flush();
  assert.equal(h.lookups.length, 1);
  const { request } = h.lookups[0];
  assert.equal(request.pageUrl, 'https://watch.test/episode/1');
  assert.equal(request.container, 'offscreen');
  assert.equal(request.preferredProvider, 'alpha · s-sub');
  assert.equal(request.primaryDurationMs, 1_440_000);
  assert.equal((await h.status()).status, 'finding');

  h.lookups[0].resolve(h.found(request));
  await h.flush();
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0].secondary.documentId, 'hosted-doc');
  assert.equal(h.starts[0].primary.documentId, 'doc');
  assert.equal((await h.status()).status, 'active');

  // Cosmetic detection changes and a Sub server switch keep the running Dub.
  await h.change({ reason: 'Changed explanation only' });
  await h.change({ provider: 'beta · s-sub' });
  assert.equal(h.lookups.length, 1);
  assert.equal(h.starts.length, 1);
});

test('selecting Dub on the visible page stops Auto Dub; returning to Sub loads it again', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  h.lookups[0].resolve(h.found(h.lookups[0].request));
  await h.flush();
  await h.change({ language: 'dub' });
  assert.equal(h.sync(), null);
  assert.equal(h.hostCloses() >= 1, true);
  assert.equal((await h.status()).status, 'waiting');

  await h.api.updatePreferences({ muteOriginal: false, offsetMs: 1500 });
  await h.change({ language: 'sub' });
  assert.equal(h.lookups.length, 2);
  h.lookups[1].resolve(h.found(h.lookups[1].request));
  await h.flush();
  assert.equal(h.starts.length, 2);
  assert.equal(h.starts[1].muteOriginal, false);
  assert.equal(h.starts[1].offsetMs, 1500);
});

test('Auto Dub never replaces a manual session, guesses between players, or runs without a Dub option', async () => {
  const h = harness();
  await h.flush();
  h.setSync({ pairId: 'manual' });
  assert.equal((await h.enable()).ok, true, 'the site is turned on');
  await h.flush();
  assert.equal(h.sync().pairId, 'manual', 'the manual session is left alone');
  assert.match((await h.status()).reason, /Stop the current sync session/);
  assert.equal(h.lookups.length, 0);

  h.setSync(null);
  h.hooks.probe = async () => ({ ok: true, tabId: 1, videos: [h.video, { ...h.video, id: 'ad' }] });
  h.api.refresh(1);
  await h.flush();
  const result = { ok: true };
  assert.equal((await h.status()).status, 'ambiguous');
  assert.equal(h.lookups.length, 0);

  h.hooks.probe = async () => ({ ok: true, tabId: 1, videos: [h.video] });
  await h.change({ available: ['sub'] });
  assert.equal((await h.status()).status, 'unsupported');
  assert.equal(h.lookups.length, 0);
  assert.equal(result.ok, true);
});

test('a hidden-page failure falls back to the minimized window, then reports and waits for Scan again', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  h.lookups[0].reject(new Error('The hidden page never showed its Sub/Dub controls.'));
  await h.flush();
  assert.equal(h.lookups.length, 2);
  assert.equal(h.lookups[1].request.container, 'window');

  h.lookups[1].reject(new Error('No Dub server loaded a playable episode (tried “beta”).'));
  await h.flush();
  const failed = await h.status();
  assert.equal(failed.status, 'error');
  assert.match(failed.reason, /No Dub server/);
  assert.equal(h.hostCloses() >= 1, true);

  // Ordinary media events do not retry a failed episode.
  await h.change({ reason: 'media event' });
  assert.equal(h.lookups.length, 2);
  // Scan again does.
  h.api.refresh(1);
  await h.flush();
  assert.equal(h.lookups.length, 3);
  assert.equal(h.lookups[2].request.container, 'offscreen');
});

test('Disable cancels an in-flight lookup and ignores its late result', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  const { request, resolve } = h.lookups[0];
  await h.turnOff();
  assert.equal(request.signal.aborted, true);
  resolve(h.found(request));
  await h.flush();
  assert.equal(h.starts.length, 0);
  assert.equal(await h.status(), null);
});

test('a new episode URL stops the old Dub, keeps the container for reuse, and looks up the new episode', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  h.lookups[0].resolve(h.found(h.lookups[0].request));
  await h.flush();
  const closesBefore = h.hostCloses();
  h.navigations[0](1, { url: 'https://watch.test/episode/2' });
  await h.flush();
  assert.equal(h.sync(), null, 'the old episode\'s Dub stops');
  assert.equal(h.hostCloses(), closesBefore, 'the hidden document is kept for the next episode');
  await h.change({ pageUrl: 'https://watch.test/episode/2' });
  assert.equal(h.lookups.length, 2);
  assert.equal(h.lookups[1].request.pageUrl, 'https://watch.test/episode/2');
});

test('a replaced visible video relinks the same hosted Dub without reloading it', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  h.lookups[0].resolve(h.found(h.lookups[0].request));
  await h.flush();
  // The worker ends the pair when the visible element disappears.
  h.setSync(null);
  await h.api.syncChanged(null);
  await h.flush();
  assert.equal(h.lookups.length, 1);
  assert.equal(h.starts.length, 2);
  assert.equal(h.starts[1].secondary.documentId, 'hosted-doc');
});

test('a Dub that stops playing moves to the window, is reloaded once there, then reported', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  h.lookups[0].resolve(h.found(h.lookups[0].request));
  await h.flush();

  const lost = () => ({ ...h.sync(), secondary: { status: 'lost' }, message: 'The hidden Dub page stopped playing.' });
  // Found in the hidden document but failed to play there: the window is next.
  await h.api.syncChanged(lost());
  await h.flush();
  assert.equal(h.lookups.length, 2);
  assert.equal(h.lookups[1].request.container, 'window');
  h.lookups[1].resolve(h.found(h.lookups[1].request, { endpoint: { tabId: -2, videoId: 'dub-2', documentId: 'hosted-doc-2' } }));
  await h.flush();
  assert.equal(h.starts.at(-1).secondary.documentId, 'hosted-doc-2');

  // One reload in the window.
  await h.api.syncChanged(lost());
  await h.flush();
  assert.equal(h.lookups.length, 3);
  assert.equal(h.lookups[2].request.container, 'window');
  h.lookups[2].resolve(h.found(h.lookups[2].request));
  await h.flush();

  await h.api.syncChanged(lost());
  await h.flush();
  assert.equal(h.lookups.length, 3);
  const final = await h.status();
  assert.equal(final.status, 'error');
  assert.match(final.reason, /stopped playing/);
});

test('Disable during a lookup closes the partly loaded hidden page', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  const before = h.hostCloses();
  await h.turnOff();
  assert.equal(h.lookups[0].request.signal.aborted, true);
  assert.ok(h.hostCloses() > before, 'the container a cancelled lookup opened is closed');
});

test('returning to an episode that failed tries it again', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  h.lookups[0].reject(new Error('hidden failed'));
  await h.flush();
  h.lookups[1].reject(new Error('window failed'));
  await h.flush();
  assert.equal((await h.status()).status, 'error');

  h.navigations[0](1, { url: 'https://watch.test/episode/2' });
  await h.change({ pageUrl: 'https://watch.test/episode/2' });
  assert.equal(h.lookups.length, 3);
  h.navigations[0](1, { url: 'https://watch.test/episode/1' });
  await h.change({ pageUrl: 'https://watch.test/episode/1' });
  assert.equal(h.lookups.length, 4);
  assert.equal(h.lookups[3].request.pageUrl, 'https://watch.test/episode/1');
});

test('a Dub that should be playing but never starts is recovered; intentional waiting is not', async () => {
  const h = harness();
  const timers = [];
  h.sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  h.sandbox.clearTimeout = id => { if (timers[id - 1]) timers[id - 1].fn = null; };
  await h.enable({ ...h.config, offsetMs: -60_000 });
  await h.flush();
  h.lookups[0].resolve(h.found(h.lookups[0].request));
  await h.flush();
  const playing = (positionMs, secondary = 'buffering') => ({ ...h.sync(), timeline: { playing: true, positionMs },
    primary: { ...h.sync().primary, status: 'playing' }, secondary: { status: secondary, snapshot: { durationMs: 1_450_000 } } });

  // Lead-in: Sub at 15 s with a -60 s offset puts Dub's target before its start.
  await h.api.syncChanged(playing(15_000));
  const armed = () => timers.filter(t => t.fn).length;
  assert.equal(armed(), 0, 'waiting for a lead-in is not a failure');

  // Past the lead-in, Dub should be audible. Stuck buffering arms the deadline.
  await h.api.syncChanged(playing(75_000));
  assert.equal(armed(), 1);
  // It starts playing: the deadline is dropped.
  await h.api.syncChanged(playing(76_000, 'playing'));
  assert.equal(armed(), 0);

  // Stuck again, and the deadline passes: recovery moves to the window.
  const stuck = playing(80_000);
  h.setSync(stuck);
  await h.api.syncChanged(stuck);
  timers.filter(t => t.fn).at(-1).fn();
  await h.flush();
  assert.equal(h.lookups.length, 2);
  assert.equal(h.lookups[1].request.container, 'window');
});

test('if the visible tab flips to Dub right after the hidden copy chose Dub, Auto Dub stops instead of looping', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  h.lookups[0].request.onSelected();
  // The site leaked the hidden copy's choice into the visible tab.
  await h.change({ language: 'dub' });
  assert.equal(h.lookups[0].request.signal.aborted, true, 'the hidden copy is closed at once');
  const stopped = await h.status();
  assert.equal(stopped.status, 'error');
  assert.match(stopped.reason, /shares the setting/);
  // The user switches back to Sub: no new copy, no loop.
  await h.change({ language: 'sub' });
  assert.equal(h.lookups.length, 1);
  assert.equal((await h.status()).status, 'error');
  // A deliberate retry is still possible.
  h.api.refresh(1);
  await h.flush();
  assert.equal(h.lookups.length, 2);
});

test('turning a site on is remembered, and Auto Dub attaches to any tab on that site the user switches to', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  assert.ok(h.local.autoDubSites['watch.test'], 'saved in the extension\'s local storage');
  assert.equal(h.local.autoDubSites['watch.test'].volume, 0.8);
  // Nothing is running here (both the hidden copy and the window gave up).
  h.lookups[0].reject(new Error('stop'));
  await h.flush();
  h.lookups[1].reject(new Error('stop'));
  await h.flush();

  // The user switches to another tab on the same site; nothing was running, so Auto Dub follows.
  h.activations[0]({ tabId: 7 });
  await h.flush();
  assert.equal((await h.status()).tabId, 7);

  await h.turnOff();
  await h.flush();
  assert.equal(h.local.autoDubSites['watch.test'], undefined);
  assert.equal(await h.status(), null);
});

test('a working Dub server is remembered for the site; a failed one is tried last next time', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  const first = h.lookups[0].request;
  assert.equal(first.rememberedServer, null);
  first.onServerFailed('delta · s-sub');
  first.onServerFailed('beta');
  h.lookups[0].resolve(h.found(first, { provider: 'alpha · embed' }));
  await h.flush();
  await h.api.syncChanged({ ...h.sync(), secondary: { status: 'playing', snapshot: { durationMs: 1_450_000 } } });
  await h.flush();
  const saved = h.local.autoDubSites['watch.test'];
  assert.equal(saved.dubServer, 'alpha');
  assert.deepEqual(Object.keys(saved.failedServers).sort(), ['beta', 'delta']);

  // Next episode: the remembered server goes first, the failed ones last.
  h.navigations[0](1, { url: 'https://watch.test/episode/2' }, { id: 1, active: true, url: 'https://watch.test/episode/2' });
  await h.change({ pageUrl: 'https://watch.test/episode/2' });
  const next = h.lookups.at(-1).request;
  assert.equal(next.rememberedServer, 'alpha');
  assert.deepEqual([...next.avoidServers].sort(), ['beta', 'delta']);
});

test('Auto Dub stays on the tab it is playing in when the user looks at another tab on the same site', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  h.lookups[0].resolve(h.found(h.lookups[0].request));
  await h.flush();
  assert.equal(h.starts.length, 1);
  h.activations[0]({ tabId: 9 });
  await h.flush();
  assert.equal((await h.status()).tabId, 1, 'the playing tab keeps its Dub');
  assert.equal(h.sync()?.pairId, 'pair-1');
});

test('a Dub player that rebuilds its video is reconnected in place, without reloading or the window', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  h.lookups[0].resolve(h.found(h.lookups[0].request));
  await h.flush();
  const closesBefore = h.hostCloses();

  h.hooks.replacement = h.found(h.lookups[0].request, { endpoint: { tabId: -2, videoId: 'dub-rebuilt', documentId: 'hosted-doc' } });
  await h.api.syncChanged({ ...h.sync(), secondary: { status: 'lost' }, message: 'The Dub video was replaced.' });
  await h.flush();
  assert.equal(h.lookups.length, 1);
  assert.equal(h.hostCloses(), closesBefore);
  assert.equal(h.starts.at(-1).secondary.videoId, 'dub-rebuilt');
  assert.equal(h.starts.at(-1).container, 'offscreen');
  assert.equal((await h.status()).status, 'active');
});
