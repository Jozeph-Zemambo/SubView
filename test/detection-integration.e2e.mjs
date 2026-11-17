import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Standalone extension integration test; all pages are local synthetic fixtures.
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (req.url.startsWith('/empty')) return res.end('<title>No controls</title><p>Discussing sub and dub is not playback state.</p>');
  res.end(`<!doctype html><title>Language fixture</title><main><video controls></video>
    <label>Language <select aria-label="Language"><option value="sub">Sub</option><option value="dub">Dub</option></select></label>
    <label>Provider <select aria-label="Provider"><option>Server A</option><option>Server B</option></select></label>
    <button id="episode" onclick="history.pushState({}, '', '?ep=2')">Next episode</button></main>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'subview-detection-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH,
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium', headless: true,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(origin);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/debug.html`);
  await popup.evaluate(() => {
    globalThis.updates = [];
    chrome.runtime.onMessage.addListener(message => {
      if (message.type === 'LANGUAGE_DETECTION_UPDATE') globalThis.updates.push(message);
    });
  });
  const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({})).find(t => t.url?.startsWith(origin)).id, origin);
  const ask = message => popup.evaluate(message => chrome.runtime.sendMessage(message), message);
  const response = await ask({ type: 'GET_LANGUAGE_DETECTION', tabId });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.detection.language, 'sub');
  assert.deepEqual(response.detection.available, ['sub', 'dub']);
  assert.equal(response.detection.provider, 'Server A');
  assert.deepEqual(response.detection.dubCandidates, [], 'plain dub option is not a URL');
  await popup.locator('#primary-tab').selectOption(String(tabId));
  await popup.waitForFunction(() => document.body.textContent.includes('Sub detected'));
  await page.getByLabel('Language').selectOption('dub');
  await popup.waitForFunction(() => globalThis.updates.at(-1)?.detection.language === 'dub');
  await popup.waitForFunction(() => document.body.textContent.includes('Dub detected'));
  await page.getByLabel('Provider').selectOption({ label: 'Server B' });
  await popup.waitForFunction(() => globalThis.updates.at(-1)?.detection.provider === 'Server B');
  await page.locator('#episode').click();
  await popup.waitForFunction(() => globalThis.updates.at(-1)?.detection.pageUrl.endsWith('?ep=2') && globalThis.updates.at(-1)?.detection.language === 'dub');
  await page.goto(`${origin}/empty`);
  await popup.waitForFunction(() => globalThis.updates.at(-1)?.detection.pageUrl.endsWith('/empty') && globalThis.updates.at(-1)?.detection.language === 'unknown');
  await page.goto(`${origin}/watch`);
  await popup.waitForFunction(() => globalThis.updates.at(-1)?.detection.pageUrl.endsWith('/watch') && globalThis.updates.at(-1)?.detection.language === 'sub');
  await popup.screenshot({ path: join(tmpdir(), 'subview-detection-popup.png') });
  assert.equal((await ask({ type: 'GET_STATE' })).state, null, 'detecting Sub does not start guessed audio');
  assert.equal(await page.getByLabel('Language').inputValue(), 'sub', 'detector never clicks Dub');
  console.log('PASS: extension detection, live Sub/Dub/provider, SPA URL, full navigation, popup updates, no auto-play or control clicks');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
