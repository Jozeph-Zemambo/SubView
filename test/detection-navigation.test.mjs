import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['src/background/language-detection-host.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
});

const oldUrl = 'https://example.test/watch?ep=1';
const newUrl = 'https://example.test/watch?ep=2';

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

function detection(pageUrl, language = 'sub') {
  return {
    pageUrl,
    language,
    available: ['sub', 'dub'],
    dubCandidates: [],
    provider: 'A',
    evidence: ['select'],
    reason: language === 'dub' ? 'Selected Dub' : 'Selected Sub',
  };
}

function assertRegistration(h, expected) {
  assert.equal(JSON.stringify(h.storage.languageDetectionTabs), JSON.stringify(expected));
}

function harness() {
  const listeners = [];
  const changes = [];
  const removed = [];
  const updates = [];
  const storage = {};
  const scriptPlans = [];
  const messagePlans = [];
  const tab = { id: 1, url: oldUrl, status: 'complete' };
  let scriptCalls = 0;
  let messageCalls = 0;

  const chrome = {
    runtime: {
      id: 'extension',
      getURL: path => `chrome-extension://extension/${path}`,
      onMessage: { addListener: listener => listeners.push(listener) },
      sendMessage: async message => { updates.push(message); },
    },
    storage: {
      session: {
        get: async () => JSON.parse(JSON.stringify(storage)),
        set: async values => Object.assign(storage, JSON.parse(JSON.stringify(values))),
      },
    },
    scripting: {
      executeScript: async () => {
        const plan = scriptPlans.shift();
        assert.ok(plan, 'unexpected executeScript call');
        scriptCalls += 1;
        plan.started.resolve();
        await plan.gate;
        return [{ frameId: 0, documentId: plan.documentId }];
      },
    },
    tabs: {
      get: async tabId => {
        assert.equal(tabId, tab.id);
        return tab;
      },
      sendMessage: async (_tabId, _message, options) => {
        const plan = messagePlans.shift();
        assert.ok(plan, 'unexpected tabs.sendMessage call');
        assert.equal(options.documentId, plan.documentId);
        messageCalls += 1;
        plan.started.resolve();
        await plan.gate;
        return { ok: true, detection: plan.detection };
      },
      onUpdated: { addListener: listener => changes.push(listener) },
      onRemoved: { addListener: listener => removed.push(listener) },
    },
  };

  vm.runInNewContext(compiled.outputFiles[0].text, { chrome, URL, console });

  const ask = (message, sender = {
    id: 'extension',
    url: 'chrome-extension://extension/popup.html',
  }) => new Promise(resolve => {
    for (const listener of listeners) {
      const held = listener(message, sender, resolve);
      if (!held) resolve(undefined);
    }
  });

  const queueScript = (documentId, wait = false) => {
    const started = deferred();
    const gate = wait ? deferred() : { promise: Promise.resolve(), resolve() {} };
    scriptPlans.push({ documentId, started, gate: gate.promise });
    return { started: started.promise, release: gate.resolve };
  };

  const queueMessage = (documentId, result, wait = false) => {
    const started = deferred();
    const gate = wait ? deferred() : { promise: Promise.resolve(), resolve() {} };
    messagePlans.push({ documentId, detection: result, started, gate: gate.promise });
    return { started: started.promise, release: gate.resolve };
  };

  return {
    ask,
    changes,
    chrome,
    queueMessage,
    queueScript,
    removed,
    storage,
    tab,
    updates,
    flush: () => new Promise(setImmediate),
    get messageCalls() { return messageCalls; },
    get scriptCalls() { return scriptCalls; },
  };
}

test('navigation during injection rejects the old inspection without stale state or broadcast', async () => {
  const h = harness();
  const oldScript = h.queueScript('old-document', true);
  const oldInspection = h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 });

  await oldScript.started;
  assert.equal(h.scriptCalls, 1);

  h.tab.url = newUrl;
  h.tab.status = 'loading';
  h.changes[0](1, { status: 'loading', url: newUrl }, h.tab);
  await h.flush();

  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].detection.language, 'unknown');
  assertRegistration(h, [[1, null]]);

  oldScript.release();
  const result = await oldInspection;
  assert.equal(result.ok, false);
  await h.flush();

  assertRegistration(h, [[1, null]]);
  assert.equal(h.updates.some(update => update.detection?.pageUrl === oldUrl), false);
});

test('closing a tab during content messaging rejects the old inspection and removes its registration', async () => {
  const h = harness();
  h.queueScript('old-document');
  const oldMessage = h.queueMessage('old-document', detection(oldUrl), true);
  const oldInspection = h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 });

  await oldMessage.started;
  assert.equal(h.messageCalls, 1);
  assertRegistration(h, [[1, 'old-document']]);

  h.removed[0](1);
  await h.flush();
  assertRegistration(h, []);

  oldMessage.release();
  const result = await oldInspection;
  assert.equal(result.ok, false);
  await h.flush();

  assertRegistration(h, []);
  assert.equal(h.updates.length, 0);
  assert.equal(h.updates.some(update => update.detection?.pageUrl === oldUrl), false);
});

test('a new-generation inspection stays registered when the old message resolves afterward', async () => {
  const h = harness();
  h.queueScript('old-document');
  const oldMessage = h.queueMessage('old-document', detection(oldUrl), true);
  const oldInspection = h.ask({ type: 'GET_LANGUAGE_DETECTION', tabId: 1 });

  await oldMessage.started;
  assert.equal(h.messageCalls, 1);

  h.tab.url = newUrl;
  h.tab.status = 'loading';
  h.changes[0](1, { status: 'loading', url: newUrl }, h.tab);
  await h.flush();
  assertRegistration(h, [[1, null]]);

  h.queueScript('new-document');
  const newMessage = h.queueMessage('new-document', detection(newUrl, 'dub'));
  h.tab.status = 'complete';
  h.changes[0](1, { status: 'complete' }, h.tab);

  await newMessage.started;
  await h.flush();
  assertRegistration(h, [[1, 'new-document']]);
  assert.equal(h.updates.at(-1).detection.pageUrl, newUrl);
  assert.equal(h.updates.at(-1).detection.language, 'dub');

  oldMessage.release();
  const oldResult = await oldInspection;
  assert.equal(oldResult.ok, false);
  await h.flush();

  assertRegistration(h, [[1, 'new-document']]);
  assert.equal(h.updates.some(update => update.detection?.pageUrl === oldUrl), false);
});
