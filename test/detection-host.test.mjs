import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/background/language-detection-host.ts'], bundle: true, write: false, format: 'iife', globalName: 'hostModule', platform: 'browser' });

function harness() {
  const listeners = [], updates = [], changes = [], removed = [], stops = [];
  let injections = 0;
  const storage = {};
  const tab = { id: 1, url: 'https://example.test/watch?ep=1', status: 'complete' };
  const detection = { pageUrl: tab.url, language: 'sub', available: ['sub', 'dub'], dubCandidates: [], provider: 'A', evidence: ['select'], reason: 'Selected Sub' };
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`, onMessage: { addListener: f => listeners.push(f) }, sendMessage: async m => { updates.push(m); } },
    storage: { session: { get: async () => storage, set: async values => Object.assign(storage, values) } },
    scripting: { executeScript: async () => { injections += 1; return [{ frameId: 0, documentId: 'current-document' }]; } },
    tabs: {
      get: async () => tab,
      sendMessage: async (id, message, options) => {
        if (message.type === 'STOP_LANGUAGE_DETECTION_CONTENT') { stops.push({ id, options }); return { ok: true }; }
        assert.equal(options.documentId, 'current-document');
        return { ok: true, detection };
      },
      onUpdated: { addListener: f => changes.push(f) },
      onRemoved: { addListener: f => removed.push(f) },
    },
  };
  const sandbox = { chrome, URL, console };
  vm.runInNewContext(compiled.outputFiles[0].text, sandbox);
  const ask = (message, sender = { id: 'extension', url: 'chrome-extension://extension/popup.html' }) => new Promise(resolve => {
    for (const listener of listeners) {
      const held = listener(message, sender, resolve);
      if (!held) resolve(undefined);
    }
  });
  const flush = () => new Promise(setImmediate);
  return { chrome, ask, updates, detection, tab, storage, changes, removed, flush, stops, host: sandbox.hostModule, injections: () => injections };
}

test('detection host inspects exact document and rejects page-origin requests', async () => {
  const h = harness();
  const result = await h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.detection.language, 'sub');
  assert.equal(h.updates.at(-1).tabId, 1);
  assert.equal(h.storage.languageDetectionTabs[0][1], 'current-document');
  assert.equal(await h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 }, { id: 'extension', tab: { id: 1 } }), undefined);
  assert.equal((await h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: -1 })).ok, false);
});

test('only current top-level document events are forwarded', async () => {
  const h = harness();
  await h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 });
  h.updates.length = 0;
  const sender = { id: 'extension', tab: { id: 1 }, frameId: 0, documentId: 'current-document' };
  const message = { type: 'LANGUAGE_DETECTION_EVENT', detection: { ...h.detection, language: 'dub' } };
  await h.ask(message, { ...sender, documentId: 'old-document' });
  await h.ask(message, { ...sender, frameId: 2 });
  await h.ask({ ...message, detection: { ...message.detection, pageUrl: 'https://example.test/old' } }, sender);
  await h.flush();
  assert.equal(h.updates.length, 0);
  await h.ask(message, sender);
  await h.flush();
  assert.equal(h.updates.at(-1).detection.language, 'dub');
});

test('detection rejects credential-bearing or executable candidates', async () => {
  for (const url of ['javascript:alert(1)', 'https://user:password@example.test/dub.mp4']) {
    const h = harness();
    h.detection.dubCandidates = [{ url, kind: 'media', label: 'Dub' }];
    assert.equal((await h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 })).ok, false);
  }
});

test('navigation clears known language, and closed tabs release registration', async () => {
  const h = harness();
  await h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 });
  h.tab.url = 'https://example.test/watch?ep=2';
  h.changes[0](1, { status: 'loading' }, h.tab);
  await h.flush();
  assert.equal(h.updates.at(-1).detection.language, 'unknown');
  assert.equal(h.storage.languageDetectionTabs[0][1], null);
  h.removed[0](1);
  await h.flush();
  assert.equal(h.storage.languageDetectionTabs.length, 0);
});

test('overlapping inspections of an unchanged document both succeed', async () => {
  const h = harness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let injections = 0;
  h.chrome.scripting.executeScript = async () => {
    injections += 1;
    await gate;
    return [{ frameId: 0, documentId: 'current-document' }];
  };
  const first = h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 });
  await h.flush();
  const second = h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 });
  await h.flush();
  release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.ok), JSON.stringify(results));
  assert.equal(injections, 1, 'same-document callers share one inspection');
});

test('a failed inspection is released so a later scan can succeed', async () => {
  const h = harness();
  const inject = h.chrome.scripting.executeScript;
  h.chrome.scripting.executeScript = async () => { throw new Error('Temporary injection failure'); };
  assert.equal((await h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 })).ok, false);
  h.chrome.scripting.executeScript = inject;
  const result = await h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.detection.language, 'sub');
});

test('a tab that is let go stops its page observer and is not inspected again on later pages', async () => {
  const h = harness();
  await h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 });
  const injections = h.injections();
  await h.host.unwatchLanguage(1);
  assert.equal(h.storage.languageDetectionTabs.length, 0, 'registration removed');
  assert.deepEqual(JSON.parse(JSON.stringify(h.stops)), [{ id: 1, options: { frameId: 0 } }], 'the page is told to stop observing');

  h.updates.length = 0;
  h.tab.url = 'https://example.org/';
  h.changes[0](1, { status: 'loading', url: h.tab.url }, h.tab);
  h.changes[0](1, { status: 'complete' }, h.tab);
  await h.flush();
  await h.flush();
  assert.equal(h.injections(), injections, 'the next page is never injected');
  assert.equal(h.updates.length, 0, 'nor reported');

  // Its page's own events are ignored too.
  await h.ask({ type: 'LANGUAGE_DETECTION_EVENT', detection: { ...h.detection, pageUrl: h.tab.url } },
    { id: 'extension', tab: { id: 1 }, frameId: 0, documentId: 'current-document' });
  await h.flush();
  assert.equal(h.updates.length, 0);

  // Letting go of a tab that isn't watched sends nothing.
  await h.host.unwatchLanguage(1);
  await h.host.unwatchLanguage(5);
  assert.equal(h.stops.length, 1);
});

test('a tab inspected from Debug tools is let go when it moves to another site, unless its owner keeps it', async () => {
  const h = harness();
  await h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 });
  const injections = h.injections();
  h.tab.url = 'https://example.org/';
  h.changes[0](1, { status: 'loading', url: h.tab.url }, h.tab);
  await h.flush();
  assert.equal(h.storage.languageDetectionTabs.length, 0, 'released');
  assert.match(h.updates.at(-1).detection.reason, /another site/);
  h.changes[0](1, { status: 'complete' }, h.tab);
  await h.flush();
  assert.equal(h.injections(), injections, 'the other site is never inspected');

  // Auto Dub keeps its armed tab: it moves with the viewer between sites it is on for.
  const kept = harness();
  kept.host.keepLanguageWatch(tabId => tabId === 1);
  await kept.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 });
  const before = kept.injections();
  kept.tab.url = 'https://second.test/watch?ep=1';
  kept.detection.pageUrl = kept.tab.url;
  kept.changes[0](1, { status: 'loading', url: kept.tab.url }, kept.tab);
  kept.changes[0](1, { status: 'complete' }, kept.tab);
  for (let i = 0; i < 4; i += 1) await kept.flush();
  assert.equal(kept.injections(), before + 1, 'inspected on the new site');
  assert.equal(kept.storage.languageDetectionTabs[0][1], 'current-document');

  // Same site, new page: still watched without anyone keeping it.
  const same = harness();
  await same.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 });
  same.tab.url = 'https://www.example.test/watch?ep=2';
  same.detection.pageUrl = same.tab.url;
  same.changes[0](1, { status: 'loading', url: same.tab.url }, same.tab);
  same.changes[0](1, { status: 'complete' }, same.tab);
  for (let i = 0; i < 4; i += 1) await same.flush();
  assert.equal(same.storage.languageDetectionTabs.length, 1);
  assert.equal(same.updates.at(-1).detection.pageUrl, same.tab.url);
});

test('a page load that finishes after the tab was let go does not watch it again', async () => {
  const h = harness();
  await h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 });
  h.tab.url = 'https://example.test/watch?ep=2';
  h.detection.pageUrl = h.tab.url;
  h.changes[0](1, { status: 'complete' }, h.tab);
  await h.host.unwatchLanguage(1);
  for (let i = 0; i < 4; i += 1) await h.flush();
  assert.equal(h.storage.languageDetectionTabs.length, 0);
});
