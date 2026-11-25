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
      export function keepLanguageWatch(fn) { globalThis.keepsWatch = fn; }
      export async function unwatchLanguage(tabId) { globalThis.unwatched.push(tabId); }
      export async function inspectLanguage(tabId) {
        globalThis.inspected.push(tabId);
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

function harness(seed = {}) {
  const listeners = [], navigations = [], closed = [], activations = [];
  // A seed stands for what an earlier run of the worker left in storage.
  const storage = seed.storage ?? {}, local = seed.local ?? {};
  const config = { tabId: 1, volume: .8, offsetMs: 0, muteOriginal: true };
  const detection = {
    pageUrl: 'https://watch.test/episode/1', language: 'sub', available: ['sub', 'dub'],
    dubCandidates: [], provider: 'alpha · s-sub', reason: 'Selected Sub', evidence: ['select'],
  };
  let sync = null, serial = 0, queue = Promise.resolve();
  const starts = [], lookups = [];
  let hostCloses = 0, hostIdles = 0, clockOffset = 0;
  // The reload offer on the visible page, and reloads of the visible tab.
  const offers = [], withdrawn = [], reloads = [];
  // What the visible player says about itself before a reload, and what is handed back to it afterwards.
  const player = { state: { timeMs: 300_000, playing: true, choices: [{ group: 'Audio Language', option: 'Japanese' }, { group: 'Subtitles', option: 'English' }] }, order: [], restores: [] };
  // The module's clock, so tests can let a minute pass.
  class Clock extends Date {
    constructor(...args) { if (args.length) super(...args); else super(Date.now() + clockOffset); }
    static now() { return Date.now() + clockOffset; }
  }
  const sandbox = {
    URL, console, AbortController, clearTimeout, fixtureDetection: detection, Date: Clock, unwatched: [], inspected: [],
    // Long housekeeping timers (minutes) must not hold the test process open.
    setTimeout: (fn, ms, ...rest) => { const timer = setTimeout(fn, ms, ...rest); if (ms > 60_000) timer.unref(); return timer; },
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
    idleHost: async () => { hostIdles += 1; },
    offerReload: async (tabId, until) => { offers.push({ tabId, until }); },
    withdrawReloadOffer: async tabId => { withdrawn.push(tabId); },
    reloadTab: async tabId => { reloads.push(tabId); player.order.push('reload'); },
    capturePlayer: async (tabId, seen) => { player.order.push(`capture ${seen.documentId}`); return player.state; },
    restorePlayer: (tabId, seen, state) => { player.restores.push({ tabId, documentId: seen.documentId, state }); return player.busy?.promise ?? Promise.resolve(); },
  };
  const api = sandbox.autoModule.setupAutoDub(hooks);
  const ask = message => new Promise(resolve => listeners[0](message,
    { id: 'ext', url: 'chrome-extension://ext/popup.html' }, resolve));
  // A message from anywhere else; resolves 'ignored' when Auto Dub does not take it.
  const askAs = (sender, message) => new Promise(resolve => { if (!listeners[0](message, sender, resolve)) resolve('ignored'); });
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
  // An address change in a page that stays loaded counts once it has stayed changed for a moment.
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 450)); await flush(); };
  return { settle, player, offers, withdrawn, reloads, askAs, now: () => Clock.now(), config, ask, starts, lookups, hooks, api, change, flush, sandbox, video, storage, local, navigations, activations, closed, found, status, enable, turnOff,
    hostCloses: () => hostCloses, hostIdles: () => hostIdles, advance: ms => { clockOffset += ms; }, sync: () => sync, setSync: value => { sync = value; } };
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
  // The app moves to the next episode in the same page; the new address is read a moment later.
  h.navigations[0](1, { url: 'https://watch.test/episode/2' });
  await h.change({ pageUrl: 'https://watch.test/episode/2' });
  await h.settle();
  assert.equal(h.sync(), null, 'the old episode\'s Dub stops');
  assert.equal(h.hostCloses(), closesBefore, 'the hidden document is kept for the next episode');
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
  await h.settle();
  assert.equal(h.lookups.length, 3);
  h.navigations[0](1, { url: 'https://watch.test/episode/1' });
  await h.change({ pageUrl: 'https://watch.test/episode/1' });
  await h.settle();
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
  assert.equal(h.local.autoDubSites['watch.test'].enabled, false, 'off, but its settings are kept');
  assert.equal(await h.status(), null);
});

test('turning a site off stops Auto Dub and takes it off the list; turning it back on brings back everything it had', async () => {
  const h = harness();
  await h.ask({ type: 'SET_AUTO_DUB_SITE', site: 'watch.test', enabled: true, tabId: 1,
    settings: { volume: .4, offsetMs: 1500, muteOriginal: false, autoReload: true } });
  await h.flush();
  // A page that only runs in the lenient frame, on a server that then played.
  const gone = new Error('The hidden copy left the episode page.');
  gone.name = 'HostedPageGoneError';
  h.lookups[0].reject(gone);
  await h.flush();
  h.lookups[1].resolve(h.found(h.lookups[1].request, { provider: 'alpha · embed' }));
  await h.flush();
  await h.api.syncChanged({ ...h.sync(), secondary: { status: 'playing', snapshot: { durationMs: 1_450_000 } } });
  await h.flush();
  assert.equal((await h.status()).status, 'active');
  const learned = h.local.autoDubSites['watch.test'];
  assert.equal(learned.lenientFrame, true);
  assert.equal(learned.dubServer, 'alpha');

  const off = await h.turnOff();
  await h.flush();
  assert.equal(off.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(off.sites)), [], 'no longer listed as on');
  assert.equal(off.autoDub, null);
  assert.equal(h.sync(), null, 'the Dub is stopped');
  assert.equal(await h.status(), null);
  // The popup on that site still shows what it had, ready for next time.
  const shown = await h.ask({ type: 'GET_AUTO_DUB', site: 'watch.test' });
  assert.deepEqual(JSON.parse(JSON.stringify(shown.sites)), []);
  assert.equal(shown.siteSettings.enabled, false);
  assert.equal(shown.siteSettings.volume, .4);
  assert.equal(shown.siteSettings.offsetMs, 1500);

  // Switching to (or loading) a tab on that site does not attach while it is off.
  const lookups = h.lookups.length;
  h.activations[0]({ tabId: 7 });
  await h.flush();
  h.navigations[0](8, { status: 'complete' }, { id: 8, active: true, url: 'https://watch.test/episode/3' });
  await h.flush();
  assert.equal(await h.status(), null);
  assert.equal(h.lookups.length, lookups);
  // Nor can "Use this tab" attach it there.
  const use = await h.ask({ type: 'USE_AUTO_DUB_TAB', site: 'watch.test', tabId: 1 });
  assert.equal(use.ok, false);
  assert.match(use.error, /isn't on for watch\.test/);

  // Back on, with only what the popup's mixer shows: the learned parts come back too.
  const on = await h.ask({ type: 'SET_AUTO_DUB_SITE', site: 'watch.test', enabled: true, tabId: 1,
    settings: { volume: .4, offsetMs: 1500, muteOriginal: false, autoOffset: false, autoReload: true } });
  await h.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(on.sites)), ['watch.test']);
  const back = h.local.autoDubSites['watch.test'];
  assert.equal(back.enabled, true);
  assert.equal(back.volume, .4);
  assert.equal(back.offsetMs, 1500);
  assert.equal(back.muteOriginal, false);
  assert.equal(back.autoReload, true);
  assert.equal(back.lenientFrame, true);
  assert.equal(back.dubServer, 'alpha');
  assert.equal((await h.status()).tabId, 1, 'attached again');
  const next = h.lookups.at(-1).request;
  assert.equal(next.lenientFrame, true);
  assert.equal(next.rememberedServer, 'alpha');
});

test('a site saved before sites could be off counts as on, and turning off a site never turned on stores nothing', async () => {
  const h = harness({ local: { autoDubSites: { 'watch.test': { volume: .5, offsetMs: 0, muteOriginal: true } } } });
  const shown = await h.ask({ type: 'GET_AUTO_DUB', site: 'watch.test' });
  assert.deepEqual(JSON.parse(JSON.stringify(shown.sites)), ['watch.test']);
  assert.equal(shown.siteSettings.enabled, true);
  const off = await h.ask({ type: 'SET_AUTO_DUB_SITE', site: 'never.test', enabled: false });
  assert.equal(off.ok, true);
  assert.equal(off.siteSettings.volume, .8, 'defaults for a site with nothing saved');
  assert.equal(h.local.autoDubSites?.['never.test'], undefined);
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
  await h.settle();
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

test('a hidden copy that opens on the viewer\'s language is kept, paused, and becomes the Dub when the tab switches', async () => {
  const h = harness();
  // A player whose audio menu is closed: the visible tab can't say which language it is on.
  h.sandbox.fixtureDetection = { ...h.sandbox.fixtureDetection, language: 'unknown', stateUnclear: true, audioControl: true, provider: null };
  await h.enable();
  await h.flush();
  assert.equal(h.lookups.length, 1);
  assert.equal(h.lookups[0].request.visibleOnOriginal, false, 'an unread menu says nothing about the visible tab');
  const closesBefore = h.hostCloses();
  const already = new Error('This page is already playing audio in your language.');
  already.name = 'AlreadyDubError';
  h.lookups[0].reject(already);
  await h.flush();
  assert.equal(h.lookups.length, 1, 'no minimized-window attempt');
  const waiting = await h.status();
  assert.equal(waiting.status, 'waiting');
  assert.match(waiting.reason, /already playing audio in your language/);
  // Closing it and opening another moments later would count as a third player on the service.
  assert.equal(h.hostCloses(), closesBefore, 'the copy is kept');
  assert.equal(h.hostIdles(), 1, 'and paused');

  // The page still can't say: nothing is retried.
  await h.change({ reason: 'media event' });
  assert.equal(h.lookups.length, 1);

  // The viewer opens the menu and it first reads as their own language: still kept.
  await h.change({ language: 'dub', stateUnclear: undefined, reason: 'audio menu read' });
  assert.equal(h.lookups.length, 1);
  assert.equal(h.hostCloses(), closesBefore);
  assert.equal((await h.status()).status, 'waiting');

  // They choose the original language: Auto Dub starts, in the copy that is already open.
  await h.change({ language: 'sub', stateUnclear: undefined, reason: 'audio menu read' });
  assert.equal(h.lookups.length, 2);
  assert.equal(h.lookups[1].request.reuseOpenCopy, true);
  assert.equal(h.hostCloses(), closesBefore);
  // A copy that opens on the viewer's language is now the Dub itself, not a reason to wait.
  assert.equal(h.lookups[1].request.visibleOnOriginal, true);
  h.lookups[1].resolve(h.found(h.lookups[1].request));
  await h.flush();
  assert.equal((await h.status()).status, 'active');
});

test('a restarted worker still treats a kept copy as kept: no new copy, and no Dub until the tab says original language', async () => {
  const unread = { language: 'unknown', stateUnclear: true, audioControl: true, provider: null };
  const before = harness();
  before.sandbox.fixtureDetection = { ...before.sandbox.fixtureDetection, ...unread };
  await before.enable();
  await before.flush();
  const already = new Error('This page is already playing audio in your language.');
  already.name = 'AlreadyDubError';
  before.lookups[0].reject(already);
  await before.flush();
  assert.equal((await before.status()).status, 'waiting');

  // The browser puts an idle worker to sleep; the next event starts a new one over the same saved state.
  const after = harness({ storage: before.storage, local: before.local });
  after.sandbox.fixtureDetection = { ...after.sandbox.fixtureDetection, ...unread };
  await after.flush();
  await after.change({ reason: 'media event' });
  assert.equal(after.lookups.length, 0, 'the copy is neither reloaded nor linked');
  assert.equal(after.hostCloses(), 0, 'nor closed');
  const waiting = await after.status();
  assert.equal(waiting.status, 'waiting');
  assert.match(waiting.reason, /already playing audio in your language/);

  await after.change({ language: 'sub', stateUnclear: undefined, reason: 'audio menu read' });
  assert.equal(after.lookups.length, 1);
  assert.equal(after.lookups[0].request.reuseOpenCopy, true);
  assert.equal(after.lookups[0].request.visibleOnOriginal, true);
});

test('a page that gives up inside the hidden copy is retried in the lenient frame, and the site remembers it', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  assert.equal(h.lookups[0].request.lenientFrame, false, 'the plain frame first');
  const gone = new Error('The hidden copy left the episode page.');
  gone.name = 'HostedPageGoneError';
  h.lookups[0].reject(gone);
  await h.flush();
  assert.equal(h.lookups.length, 2);
  assert.equal(h.lookups[1].request.container, 'offscreen', 'still the hidden document, not a window');
  assert.equal(h.lookups[1].request.lenientFrame, true);
  h.lookups[1].resolve(h.found(h.lookups[1].request));
  await h.flush();
  assert.equal((await h.status()).status, 'active');
  assert.equal(h.local.autoDubSites['watch.test'].lenientFrame, true);

  // The next episode skips the try that is known to fail.
  h.navigations[0](1, { url: 'https://watch.test/episode/2' });
  await h.flush();
  await h.change({ pageUrl: 'https://watch.test/episode/2' });
  await h.settle();
  assert.equal(h.lookups.length, 3);
  assert.equal(h.lookups[2].request.container, 'offscreen');
  assert.equal(h.lookups[2].request.lenientFrame, true);
});

test('when the lenient frame fails too, the minimized window is still tried; other failures skip the lenient frame', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  const gone = new Error('The hidden page never showed its Sub/Dub controls.');
  gone.name = 'HostedPageGoneError';
  h.lookups[0].reject(gone);
  await h.flush();
  h.lookups[1].reject(new Error('No Dub server loaded a playable episode.'));
  await h.flush();
  assert.equal(h.lookups.length, 3);
  assert.equal(h.lookups[2].request.container, 'window');
  assert.equal(h.lookups[2].request.lenientFrame, false);
  assert.equal(h.local.autoDubSites['watch.test'].lenientFrame, false, 'nothing learned from a failure');

  const other = harness();
  await other.enable();
  await other.flush();
  other.lookups[0].reject(new Error('No Dub server loaded a playable episode.'));
  await other.flush();
  assert.equal(other.lookups.length, 2);
  assert.equal(other.lookups[1].request.container, 'window', 'a playback failure goes straight to the window, as before');
});

test('where streams are counted, a second hidden copy for the same playback waits; a reloaded tab does not', async () => {
  const h = harness();
  h.video.protected = true; // copy-protected video: a service that counts streams
  await h.enable();
  await h.flush();
  h.lookups[0].resolve(h.found(h.lookups[0].request));
  await h.flush();
  assert.equal((await h.status()).status, 'active');

  // Off and on again while the same video keeps playing: the closed copy still counts on the service.
  await h.turnOff();
  await h.flush();
  await h.enable();
  await h.flush();
  assert.equal(h.lookups.length, 1, 'no second copy yet');
  const waiting = await h.status();
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.reason, 'Reload your tab and Dub starts right away.');

  h.advance(61_000);
  await h.change({ reason: 'one minute later' });
  assert.equal(h.lookups.length, 1, 'a closed player is counted for longer than a minute');
  h.advance(40_000);
  await h.change({ reason: 'a hundred seconds later' });
  assert.equal(h.lookups.length, 2, 'then it loads');

  // A reloaded tab is a new playback, younger than the copy that closed: nothing to wait for.
  const reloaded = harness();
  reloaded.video.protected = true;
  await reloaded.enable();
  await reloaded.flush();
  reloaded.lookups[0].resolve(reloaded.found(reloaded.lookups[0].request));
  await reloaded.flush();
  await reloaded.turnOff();
  await reloaded.flush();
  reloaded.video.documentId = 'doc-after-reload';
  await reloaded.enable();
  await reloaded.flush();
  assert.equal(reloaded.lookups.length, 2);

  // Sites that don't protect their video don't count streams: no wait, as before.
  const open = harness();
  await open.enable();
  await open.flush();
  open.lookups[0].resolve(open.found(open.lookups[0].request));
  await open.flush();
  await open.turnOff();
  await open.flush();
  await open.enable();
  await open.flush();
  assert.equal(open.lookups.length, 2);
});

test('where streams are counted, a failed hidden copy is reported instead of opening a window as one more player', async () => {
  const h = harness();
  h.video.protected = true;
  await h.enable();
  await h.flush();
  h.lookups[0].reject(new Error('The hidden page did not switch to Dub.'));
  await h.flush();
  assert.equal(h.lookups.length, 1, 'no minimized-window attempt');
  const failed = await h.status();
  assert.equal(failed.status, 'error');
  assert.match(failed.reason, /did not switch to Dub/);
});

test('a hidden copy whose page refused to play reports what the page said, without trying a window', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  const refused = new Error('The Dub player never loaded a playable episode. The page in the hidden copy says: “Stream Limit Reached”');
  refused.name = 'HostedPageNoticeError';
  h.lookups[0].reject(refused);
  await h.flush();
  assert.equal(h.lookups.length, 1, 'no minimized-window attempt');
  const failed = await h.status();
  assert.equal(failed.status, 'error');
  assert.match(failed.reason, /Stream Limit Reached/);
  assert.equal(h.hostCloses() >= 1, true);
  // Not retried until the viewer asks.
  await h.change({ reason: 'media event' });
  assert.equal(h.lookups.length, 1);
});

// A copy-protected episode that is playing with its Dub linked, then turned off:
// the next copy for the same playback has to wait.
async function closedCopy(settings = {}) {
  const h = harness();
  h.video.protected = true;
  const on = () => h.ask({ type: 'SET_AUTO_DUB_SITE', site: 'watch.test', enabled: true, tabId: 1,
    settings: { volume: .8, offsetMs: 0, muteOriginal: true, ...settings } });
  await on();
  await h.flush();
  h.lookups[0].resolve(h.found(h.lookups[0].request));
  await h.flush();
  await h.turnOff();
  await h.flush();
  const closedAt = h.now();
  await on();
  await h.flush();
  return { h, closedAt };
}

test('while a second copy has to wait, reloading the tab is offered in the popup and on the page; taking it starts Dub at once', async () => {
  const { h, closedAt } = await closedCopy();
  const waiting = await h.status();
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.reloadOffer, true, 'the popup shows its reload button');
  assert.equal(waiting.reason, 'Reload your tab and Dub starts right away.');
  assert.equal(h.offers.length, 1, 'offered on the page once');
  assert.equal(h.offers[0].tabId, 1);
  assert.ok(Math.abs(h.offers[0].until - (closedAt + 100_000)) < 1_000, 'counting down to the end of the wait');
  assert.equal(h.reloads.length, 0, 'never reloaded unasked');

  // Still waiting a little later: the same offer, not a second card.
  h.advance(10_000);
  await h.change({ reason: 'ten seconds later' });
  assert.equal(h.offers.length, 1);

  assert.equal((await h.ask({ type: 'AUTO_DUB_RELOAD' })).ok, true);
  assert.deepEqual(h.reloads, [1]);
  assert.deepEqual(h.withdrawn, [1], 'the card is taken down');
  const reloading = await h.status();
  assert.match(reloading.reason, /Reloading this tab/);
  assert.equal(reloading.reloadOffer, undefined);
  assert.equal(h.lookups.length, 1, 'nothing loads against the old page');

  // The reloaded page's video is a new playback.
  h.video.documentId = 'doc-after-reload';
  await h.change({ reason: 'reloaded' });
  assert.equal(h.lookups.length, 2, 'the copy loads without waiting');
  assert.equal(h.local.autoDubSites['watch.test'].autoReload, false, 'one reload is not a standing permission');
  await h.turnOff();
});

test('the offer on the page is answered only from the armed tab; "Always reload" also saves the permission', async () => {
  const { h } = await closedCopy();
  assert.equal(await h.askAs({ id: 'ext', tab: { id: 2 }, frameId: 0 }, { type: 'AUTO_DUB_RELOAD' }), 'ignored', 'another tab');
  assert.equal(await h.askAs({ id: 'ext', tab: { id: 1 }, frameId: 3 }, { type: 'AUTO_DUB_RELOAD' }), 'ignored', 'a frame inside the page');
  assert.equal(await h.askAs({ id: 'other', tab: { id: 1 }, frameId: 0 }, { type: 'AUTO_DUB_RELOAD' }), 'ignored', 'another extension');
  assert.equal(h.reloads.length, 0);

  const answer = await h.askAs({ id: 'ext', tab: { id: 1 }, frameId: 0 }, { type: 'AUTO_DUB_RELOAD', always: true });
  assert.equal(answer.ok, true);
  assert.deepEqual(h.reloads, [1]);
  assert.equal(h.local.autoDubSites['watch.test'].autoReload, true);
  await h.turnOff();
});

test('a reload is refused when Dub is not waiting on one', async () => {
  const h = harness();
  h.video.protected = true;
  await h.enable();
  await h.flush();
  assert.equal((await h.ask({ type: 'AUTO_DUB_RELOAD' })).ok, false, 'a lookup is running');
  h.lookups[0].resolve(h.found(h.lookups[0].request));
  await h.flush();
  assert.equal((await h.ask({ type: 'AUTO_DUB_RELOAD' })).ok, false, 'Dub is playing');
  assert.equal(h.reloads.length, 0);
  await h.turnOff();
});

test('where the viewer allowed it, the tab is reloaded instead of waiting: once, and without an offer', async () => {
  const { h } = await closedCopy({ autoReload: true });
  assert.deepEqual(h.reloads, [1]);
  assert.equal(h.offers.length, 0);
  assert.match((await h.status()).reason, /Reloading this tab/);

  // The reload is still landing: the old page's video proves nothing yet.
  h.advance(3_000);
  await h.change({ reason: 'old page, still there' });
  assert.deepEqual(h.reloads, [1]);
  assert.equal(h.offers.length, 0);

  // A reload that did not give a new playback is not repeated; once it has clearly not landed, the wait is offered as usual.
  h.advance(61_000);
  await h.change({ reason: 'same video after the reload' });
  assert.deepEqual(h.reloads, [1], 'one reload per wait');
  assert.equal(h.offers.length, 1);
  assert.equal((await h.status()).reloadOffer, true);
  await h.turnOff();

  // The usual case: the reloaded page has a new video, and the copy loads at once.
  const usual = await closedCopy({ autoReload: true });
  usual.h.video.documentId = 'doc-after-reload';
  await usual.h.change({ reason: 'reloaded' });
  assert.equal(usual.h.lookups.length, 2);
  assert.deepEqual(usual.h.reloads, [1]);
  await usual.h.turnOff();
});

test('allowing reloads in the middle of a wait reloads for that wait too; turning it off again stops it', async () => {
  const { h } = await closedCopy();
  assert.equal(h.reloads.length, 0);
  const allowed = await h.ask({ type: 'SET_AUTO_DUB_RELOAD', site: 'watch.test', enabled: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.siteSettings.autoReload, true);
  assert.deepEqual(h.reloads, [1]);
  assert.deepEqual(h.withdrawn, [1]);

  const off = await h.ask({ type: 'SET_AUTO_DUB_RELOAD', site: 'watch.test', enabled: false });
  assert.equal(off.siteSettings.autoReload, false);
  assert.equal((await h.ask({ type: 'SET_AUTO_DUB_RELOAD', site: 'watch.test' })).ok, false, 'needs a yes or a no');
  assert.deepEqual(h.reloads, [1]);
  await h.turnOff();
});

test('the offer is taken down when the wait ends by itself, and when Auto Dub is turned off', async () => {
  const { h } = await closedCopy();
  assert.equal(h.offers.length, 1);
  h.advance(101_000);
  await h.change({ reason: 'the wait is over' });
  assert.equal(h.lookups.length, 2);
  assert.deepEqual(h.withdrawn, [1]);
  assert.equal((await h.status()).reloadOffer, undefined);
  assert.equal(h.reloads.length, 0);
  await h.turnOff();

  const other = await closedCopy();
  await other.h.turnOff();
  await other.h.flush();
  assert.deepEqual(other.h.withdrawn, [1]);
});

test('a site that does not count streams never gets a reload or an offer', async () => {
  const h = harness();
  const on = () => h.ask({ type: 'SET_AUTO_DUB_SITE', site: 'watch.test', enabled: true, tabId: 1,
    settings: { volume: .8, offsetMs: 0, muteOriginal: true, autoReload: true } });
  await on();
  await h.flush();
  h.lookups[0].resolve(h.found(h.lookups[0].request));
  await h.flush();
  await h.turnOff();
  await h.flush();
  await on();
  await h.flush();
  assert.equal(h.lookups.length, 2);
  assert.equal(h.reloads.length, 0);
  assert.equal(h.offers.length, 0);
  await h.turnOff();
});

test('a reload SubView asked for puts the viewer back: position, playing, and what the player menus had chosen', async () => {
  const { h } = await closedCopy();
  assert.equal((await h.ask({ type: 'AUTO_DUB_RELOAD' })).ok, true);
  assert.deepEqual(h.player.order, ['capture doc', 'reload'], 'the player is read before the page goes away');
  assert.equal(h.player.restores.length, 0);

  // The old page is still there for a moment: nothing to hand anything to yet.
  await h.change({ reason: 'old page, still there' });
  assert.equal(h.player.restores.length, 0);

  h.video.documentId = 'doc-after-reload';
  await h.change({ reason: 'reloaded' });
  assert.equal(h.player.restores.length, 1);
  assert.equal(h.player.restores[0].documentId, 'doc-after-reload', 'handed to the new page');
  assert.deepEqual(h.player.restores[0].state, h.player.state, 'exactly what was noted');
  assert.equal(h.lookups.length, 2, 'and the copy loads meanwhile');

  // Once only.
  await h.change({ reason: 'later' });
  assert.equal(h.player.restores.length, 1);
  await h.turnOff();

  // The automatic reload does the same.
  const auto = await closedCopy({ autoReload: true });
  assert.deepEqual(auto.h.player.order, ['capture doc', 'reload']);
  auto.h.video.documentId = 'doc-after-reload';
  await auto.h.change({ reason: 'reloaded' });
  assert.equal(auto.h.player.restores.length, 1);
  await auto.h.turnOff();
});

test('nothing is put back when the player said nothing, the viewer moved on, or too long has passed', async () => {
  const silent = await closedCopy();
  silent.h.player.state = null;
  await silent.h.ask({ type: 'AUTO_DUB_RELOAD' });
  silent.h.video.documentId = 'doc-after-reload';
  await silent.h.change({ reason: 'reloaded' });
  assert.deepEqual(silent.h.reloads, [1], 'the reload still happens');
  assert.equal(silent.h.player.restores.length, 0);
  await silent.h.turnOff();

  const moved = await closedCopy();
  await moved.h.ask({ type: 'AUTO_DUB_RELOAD' });
  moved.h.video.documentId = 'doc-after-reload';
  await moved.h.change({ pageUrl: 'https://watch.test/episode/2' });
  assert.equal(moved.h.player.restores.length, 0, 'another episode is not where they were');
  await moved.h.turnOff();

  const late = await closedCopy();
  await late.h.ask({ type: 'AUTO_DUB_RELOAD' });
  late.h.advance(61_000);
  late.h.video.documentId = 'doc-after-reload';
  await late.h.change({ reason: 'a minute later' });
  assert.equal(late.h.player.restores.length, 0);
  await late.h.turnOff();

  const off = await closedCopy();
  await off.h.ask({ type: 'AUTO_DUB_RELOAD' });
  await off.h.turnOff();
  await off.h.flush();
  off.h.video.documentId = 'doc-after-reload';
  await off.h.enable();
  await off.h.flush();
  assert.equal(off.h.player.restores.length, 0, 'turned off in between');
  await off.h.turnOff();
});

test('a tab that turns to the original language while the copy is still loading gets the kept copy at once', async () => {
  const h = harness();
  h.sandbox.fixtureDetection = { ...h.sandbox.fixtureDetection, language: 'unknown', stateUnclear: true, audioControl: true, provider: null };
  await h.enable();
  await h.flush();
  assert.equal(h.lookups.length, 1);
  assert.equal(h.lookups[0].request.visibleOnOriginal, false);

  // The audio menu is read as the original language before the copy has answered.
  await h.change({ language: 'sub', stateUnclear: undefined, reason: 'audio menu read' });
  assert.equal(h.lookups.length, 1, 'the running lookup is left alone');

  const already = new Error('This page is already playing audio in your language.');
  already.name = 'AlreadyDubError';
  h.lookups[0].reject(already);
  await h.flush();
  assert.equal(h.lookups.length, 2, 'not left waiting for a change that already happened');
  assert.equal(h.lookups[1].request.reuseOpenCopy, true);
  assert.equal(h.lookups[1].request.visibleOnOriginal, true);
  h.lookups[1].resolve(h.found(h.lookups[1].request));
  await h.flush();
  assert.equal((await h.status()).status, 'active');
  await h.turnOff();
});

test('while the put-back is pressing the player, nothing is decided from what the menus show on the way', async () => {
  const { h } = await closedCopy({ autoReload: true });
  assert.deepEqual(h.reloads, [1]);
  // A player whose audio menu is closed after the reload, and a put-back that takes a moment.
  h.player.busy = deferred();
  h.video.documentId = 'doc-after-reload';
  await h.change({ language: 'unknown', stateUnclear: true, audioControl: true, provider: null, reason: 'reloaded' });
  assert.equal(h.player.restores.length, 1);
  assert.equal(h.lookups.length, 1, 'no copy is loaded against a page that is still being set up');
  assert.match((await h.status()).reason, /Putting your player back/);

  // The put-back opens the settings, which still show the viewer's own language...
  const closes = h.hostCloses();
  await h.change({ language: 'dub', stateUnclear: undefined, reason: 'audio menu read' });
  // ...and then chooses the original language again.
  await h.change({ language: 'sub', stateUnclear: undefined, reason: 'audio menu read' });
  assert.equal(h.lookups.length, 1);
  assert.equal(h.hostCloses(), closes, 'nothing was closed on the way');
  assert.deepEqual(h.reloads, [1], 'and nothing was reloaded again');

  h.player.busy.resolve();
  await h.flush();
  assert.equal(h.lookups.length, 2, 'the copy loads once the player is as the viewer left it');
  assert.equal(h.lookups[1].request.visibleOnOriginal, true);
  h.lookups[1].resolve(h.found(h.lookups[1].request));
  await h.flush();
  assert.equal((await h.status()).status, 'active');
  assert.deepEqual(h.reloads, [1]);
  await h.turnOff();
});

test('an automatic reload is never repeated within minutes of any reload SubView made', async () => {
  const { h } = await closedCopy({ autoReload: true });
  assert.deepEqual(h.reloads, [1]);
  h.video.documentId = 'doc-after-reload';
  await h.change({ reason: 'reloaded' });
  h.lookups[1].resolve(h.found(h.lookups[1].request));
  await h.flush();
  assert.equal((await h.status()).status, 'active');

  // The same situation again a moment later, whatever caused it: the card asks.
  h.advance(20_000);
  const on = () => h.ask({ type: 'SET_AUTO_DUB_SITE', site: 'watch.test', enabled: true, tabId: 1, settings: { volume: .8, offsetMs: 0, muteOriginal: true, autoReload: true } });
  await h.turnOff();
  await h.flush();
  await on();
  await h.flush();
  assert.deepEqual(h.reloads, [1], 'no second reload');
  assert.equal((await h.status()).reloadOffer, true);
  assert.equal(h.offers.length, 1);

  // The viewer's own click still reloads.
  assert.equal((await h.ask({ type: 'AUTO_DUB_RELOAD' })).ok, true);
  assert.deepEqual(h.reloads, [1, 1]);
  h.video.documentId = 'doc-after-second-reload';
  await h.change({ reason: 'reloaded again' });
  h.lookups[2].resolve(h.found(h.lookups[2].request));
  await h.flush();

  // Minutes later the automatic reload is available again.
  h.advance(6 * 60_000);
  await h.turnOff();
  await h.flush();
  await on();
  await h.flush();
  assert.deepEqual(h.reloads, [1, 1, 1]);
  await h.turnOff();
});

test('reading the audio menu as the viewer\'s language does not close a copy that is still loading', async () => {
  const h = harness();
  h.sandbox.fixtureDetection = { ...h.sandbox.fixtureDetection, language: 'unknown', stateUnclear: true, audioControl: true, provider: null };
  await h.enable();
  await h.flush();
  assert.equal(h.lookups.length, 1);
  const closes = h.hostCloses();

  // The viewer opens the settings before the copy has answered: they show their own language.
  await h.change({ language: 'dub', stateUnclear: undefined, reason: 'audio menu read' });
  assert.equal(h.hostCloses(), closes, 'the loading copy is left alone');
  assert.equal(h.lookups[0].request.signal.aborted, false);

  const already = new Error('This page is already playing audio in your language.');
  already.name = 'AlreadyDubError';
  h.lookups[0].reject(already);
  await h.flush();
  assert.equal(h.hostCloses(), closes, 'and is kept once it has loaded');
  assert.equal((await h.status()).status, 'waiting');

  // They choose the original language: the kept copy is the Dub, with no wait and no reload.
  await h.change({ language: 'sub', stateUnclear: undefined, reason: 'audio menu read' });
  assert.equal(h.lookups.length, 2);
  assert.equal(h.lookups[1].request.reuseOpenCopy, true);
  assert.equal(h.reloads.length, 0);
  await h.turnOff();
});

test('an address that changes and comes straight back is not a new page: the copy stays, nothing waits', async () => {
  const h = harness();
  h.video.protected = true;
  // A player whose audio menu is closed, with a copy kept for it.
  h.sandbox.fixtureDetection = { ...h.sandbox.fixtureDetection, language: 'unknown', stateUnclear: true, audioControl: true, provider: null };
  await h.enable();
  await h.flush();
  const already = new Error('This page is already playing audio in your language.');
  already.name = 'AlreadyDubError';
  h.lookups[0].reject(already);
  await h.flush();
  const closes = h.hostCloses();
  const loaded = { id: 1, active: true, status: 'complete' };

  // The app's router goes somewhere and is back 9 ms later; the page stays loaded throughout.
  h.navigations[0](1, { url: 'https://watch.test/episode/1#nowhere' }, { ...loaded, url: 'https://watch.test/episode/1#nowhere' });
  h.sandbox.receiveDetection(1, { pageUrl: 'https://watch.test/episode/1#nowhere', language: 'unknown', available: [], dubCandidates: [], provider: null, evidence: [], reason: 'Page changed; checking language controls…', placeholder: 'address' });
  h.navigations[0](1, { url: 'https://watch.test/episode/1' }, { ...loaded, url: 'https://watch.test/episode/1' });
  h.sandbox.receiveDetection(1, { ...h.sandbox.fixtureDetection, language: 'unknown', available: [], reason: 'Page changed; checking language controls…', placeholder: 'address' });
  await h.flush();
  // The page is read again and says what it said before.
  h.sandbox.receiveDetection(1, h.sandbox.fixtureDetection);
  await h.flush();
  await new Promise(resolve => setTimeout(resolve, 500)); // past the settling time
  await h.flush();

  assert.equal(h.hostCloses(), closes, 'the kept copy was not closed');
  assert.equal(h.lookups.length, 1, 'and not loaded again');
  assert.equal(h.offers.length, 0, 'no reload is offered');
  const still = await h.status();
  assert.equal(still.status, 'waiting');
  assert.match(still.reason, /already playing audio in your language/);

  // The kept copy is still the one used when the viewer switches.
  await h.change({ language: 'sub', stateUnclear: undefined, reason: 'audio menu read' });
  assert.equal(h.lookups.length, 2);
  assert.equal(h.lookups[1].request.reuseOpenCopy, true);
  await h.turnOff();
});

test('an address change that stays changed is still a new episode, with or without an early reading', async () => {
  const loaded = { id: 1, active: true, status: 'complete' };
  // The new page is read before the settling time is up: the reading is kept until the address has stayed.
  const early = harness();
  await early.enable();
  await early.flush();
  early.lookups[0].resolve(early.found(early.lookups[0].request));
  await early.flush();
  assert.equal((await early.status()).status, 'active');
  early.navigations[0](1, { url: 'https://watch.test/episode/2' }, { ...loaded, url: 'https://watch.test/episode/2' });
  await early.change({ pageUrl: 'https://watch.test/episode/2' });
  assert.equal(early.lookups.length, 1, 'not yet: the address might come straight back');
  await new Promise(resolve => setTimeout(resolve, 500));
  await early.flush();
  assert.equal(early.lookups.length, 2);
  assert.equal(early.lookups[1].request.pageUrl, 'https://watch.test/episode/2');
  assert.equal(early.sync(), null, 'the old episode\'s Dub stopped');
  await new Promise(resolve => setTimeout(resolve, 500));
  await early.flush();
  assert.equal(early.lookups[1].request.signal.aborted, false, 'the settling time running out does not undo the new lookup');
  await early.turnOff();

  // No reading arrives in time: the old Dub still stops once the address has settled.
  const late = harness();
  await late.enable();
  await late.flush();
  late.lookups[0].resolve(late.found(late.lookups[0].request));
  await late.flush();
  late.sandbox.fixtureDetection = { ...late.sandbox.fixtureDetection, pageUrl: 'https://watch.test/episode/2' }; // what the tab now shows
  late.navigations[0](1, { url: 'https://watch.test/episode/2' }, { ...loaded, url: 'https://watch.test/episode/2' });
  await late.flush();
  assert.notEqual(late.sync(), null, 'not yet');
  await new Promise(resolve => setTimeout(resolve, 500));
  await late.flush();
  assert.equal(late.sync(), null, 'stopped when the address stayed changed');
  assert.match((await late.status()).reason, /Page changed/);
  await late.turnOff();
});

test('the reload guard survives the worker going to sleep', async () => {
  const { h } = await closedCopy({ autoReload: true });
  assert.deepEqual(h.reloads, [1]);
  h.video.documentId = 'doc-after-reload';
  await h.change({ reason: 'reloaded' });
  h.lookups[1].resolve(h.found(h.lookups[1].request));
  await h.flush();
  h.advance(20_000);
  await h.turnOff();
  await h.flush();
  assert.equal(typeof h.storage.autoDubLastReload, 'number', 'the time of the reload is saved');

  // Chrome stopped the idle worker; a new one starts from what was saved.
  const again = harness({ storage: h.storage, local: h.local });
  again.video.protected = true;
  again.video.documentId = 'doc-after-reload';
  again.advance(20_000);
  await again.ask({ type: 'SET_AUTO_DUB_SITE', site: 'watch.test', enabled: true, tabId: 1, settings: { volume: .8, offsetMs: 0, muteOriginal: true, autoReload: true } });
  await again.flush();
  assert.equal(again.reloads.length, 0, 'no automatic reload minutes after the last one, even from a fresh worker');
  assert.equal((await again.status()).reloadOffer, true, 'the card asks instead');
  await again.turnOff();
});

// A second enabled site, with settings the viewer saved for it earlier.
const OTHER_SETTINGS = {
  enabled: true, volume: 0.35, offsetMs: 2500, muteOriginal: false, autoOffset: true,
  dubServer: 'beta', failedServers: {}, lenientFrame: true, autoReload: true,
};
function twoSites() {
  const h = harness({ local: { autoDubSites: { 'other.test': { ...OTHER_SETTINGS } } } });
  const urls = { 1: 'https://watch.test/episode/1', 2: 'https://other.test/episode/9', 3: 'https://watch.test/episode/2' };
  h.sandbox.chrome.tabs.get = async id => {
    if (!urls[id]) throw new Error(`No tab with id: ${id}.`);
    return { id, active: id !== 1, url: urls[id] };
  };
  return h;
}

test('"Use this tab" moves Auto Dub from a paused tab on one site to a tab on another, keeping that site\'s saved settings', async () => {
  const h = twoSites();
  await h.enable();
  await h.flush();
  h.lookups[0].resolve(h.found(h.lookups[0].request));
  await h.flush();
  assert.equal((await h.status()).tabId, 1);
  assert.equal(h.sync().pairId, 'pair-1');
  assert.equal(h.sync().timeline.playing, false, 'the Dub on the first tab is paused');

  h.sandbox.fixtureDetection = { ...h.sandbox.fixtureDetection, pageUrl: 'https://other.test/episode/9' };
  const response = await h.ask({ type: 'USE_AUTO_DUB_TAB', site: 'other.test', tabId: 2 });
  await h.flush();
  assert.equal(response.ok, true);
  assert.equal(response.autoDub.tabId, 2);
  assert.equal(response.autoDub.site, 'other.test');
  assert.deepEqual(JSON.parse(JSON.stringify(response.sites)).sort(), ['other.test', 'watch.test']);
  assert.deepEqual(JSON.parse(JSON.stringify(response.siteSettings)), OTHER_SETTINGS);
  assert.notEqual(h.sync()?.pairId, 'pair-1', 'the first tab\'s Dub is stopped');
  assert.equal((await h.status()).tabId, 2);
  assert.deepEqual(h.local.autoDubSites['other.test'], OTHER_SETTINGS, 'saved settings untouched');
  assert.ok(h.local.autoDubSites['watch.test'], 'the first site stays on');
});

test('"Use this tab" is refused for a site that is off, a tab on a different site, or a bad tab, and nothing moves', async () => {
  const h = twoSites();
  await h.enable();
  await h.flush();
  h.lookups[0].resolve(h.found(h.lookups[0].request));
  await h.flush();
  const before = JSON.stringify(h.local.autoDubSites);

  const off = await h.ask({ type: 'USE_AUTO_DUB_TAB', site: 'nope.test', tabId: 2 });
  assert.equal(off.ok, false);
  assert.match(off.error, /isn't on for nope\.test/);

  const mismatch = await h.ask({ type: 'USE_AUTO_DUB_TAB', site: 'other.test', tabId: 3 });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /isn't on other\.test/);

  const gone = await h.ask({ type: 'USE_AUTO_DUB_TAB', site: 'other.test', tabId: 99 });
  assert.equal(gone.ok, false);

  for (const bad of [{ site: 'other.test', tabId: 'x' }, { site: 'other.test', tabId: 1.5 }, { site: 'bad site!', tabId: 2 }, { tabId: 2 }]) {
    assert.equal((await h.ask({ type: 'USE_AUTO_DUB_TAB', ...bad })).ok, false, JSON.stringify(bad));
  }
  assert.equal(await h.askAs({ id: 'ext', url: 'https://other.test/episode/9', tab: { id: 2 } },
    { type: 'USE_AUTO_DUB_TAB', site: 'other.test', tabId: 2 }), 'ignored', 'only the extension\'s own pages may ask');

  await h.flush();
  assert.equal((await h.status()).tabId, 1);
  assert.equal(h.sync().pairId, 'pair-1', 'the running Dub is left alone');
  assert.equal(JSON.stringify(h.local.autoDubSites), before);
});

// Watching a tab means its page re-reads its controls on every change. A tab
// Auto Dub has left must be let go, or SubView follows it to every site it visits.
test('Auto Dub lets its tab go when the tab leaves the site, and never inspects it on the next site', async () => {
  const h = harness();
  await h.enable();
  await h.flush();
  assert.equal(h.sandbox.keepsWatch(1), true, 'the armed tab stays watched while Auto Dub is on it');
  assert.deepEqual([...h.sandbox.unwatched], []);
  const inspections = h.sandbox.inspected.length;

  h.navigations[0](1, { url: 'https://example.org/' }, { id: 1, active: true, status: 'loading', url: 'https://example.org/' });
  await h.flush();
  assert.equal(await h.status(), null, 'Auto Dub detached');
  assert.deepEqual([...h.sandbox.unwatched], [1], 'and let the tab go');
  assert.equal(h.sandbox.keepsWatch(1), false, 'nothing keeps it watched');

  h.navigations[0](1, { status: 'complete' }, { id: 1, active: true, status: 'complete', url: 'https://example.org/' });
  await h.flush();
  assert.equal(h.sandbox.inspected.length, inspections, 'the new site is never inspected');
  assert.deepEqual([...h.sandbox.unwatched], [1]);
});

test('turning the site off, closing the tab, or moving Auto Dub to another tab lets the old tab go', async () => {
  const off = harness();
  await off.enable();
  await off.flush();
  await off.turnOff();
  await off.flush();
  assert.deepEqual([...off.sandbox.unwatched], [1], 'site turned off');

  const closed = harness();
  await closed.enable();
  await closed.flush();
  for (const listener of closed.closed) listener(1);
  await closed.flush();
  assert.equal(await closed.status(), null);
  assert.deepEqual([...closed.sandbox.unwatched], [1], 'tab closed');

  const moved = twoSites();
  await moved.enable();
  await moved.flush();
  moved.sandbox.fixtureDetection = { ...moved.sandbox.fixtureDetection, pageUrl: 'https://other.test/episode/9' };
  const response = await moved.ask({ type: 'USE_AUTO_DUB_TAB', site: 'other.test', tabId: 2 });
  await moved.flush();
  assert.equal(response.ok, true);
  assert.deepEqual([...moved.sandbox.unwatched], [1], 'the tab Auto Dub moved away from');
  assert.equal(moved.sandbox.keepsWatch(2), true);
  assert.equal(moved.sandbox.keepsWatch(1), false);
  assert.equal(moved.sandbox.inspected.at(-1), 2, 'the new tab is watched');
});
