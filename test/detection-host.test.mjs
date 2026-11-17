import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/background/language-detection-host.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });

function harness() {
  const listeners = [], updates = [], changes = [], removed = [];
  const storage = {};
  const tab = { id: 1, url: 'https://example.test/watch?ep=1', status: 'complete' };
  const detection = { pageUrl: tab.url, language: 'sub', available: ['sub', 'dub'], dubCandidates: [], provider: 'A', evidence: ['select'], reason: 'Selected Sub' };
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`, onMessage: { addListener: f => listeners.push(f) }, sendMessage: async m => { updates.push(m); } },
    storage: { session: { get: async () => storage, set: async values => Object.assign(storage, values) } },
    scripting: { executeScript: async () => [{ frameId: 0, documentId: 'current-document' }] },
    tabs: {
      get: async () => tab,
      sendMessage: async (_id, _message, options) => {
        assert.equal(options.documentId, 'current-document');
        return { ok: true, detection };
      },
      onUpdated: { addListener: f => changes.push(f) },
      onRemoved: { addListener: f => removed.push(f) },
    },
  };
  vm.runInNewContext(compiled.outputFiles[0].text, { chrome, URL, console });
  const ask = (message, sender = { id: 'extension', url: 'chrome-extension://extension/popup.html' }) => new Promise(resolve => {
    for (const listener of listeners) {
      const held = listener(message, sender, resolve);
      if (!held) resolve(undefined);
    }
  });
  const flush = () => new Promise(setImmediate);
  return { chrome, ask, updates, detection, tab, storage, changes, removed, flush };
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
