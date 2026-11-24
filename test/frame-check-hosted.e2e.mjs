import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// A local site that refuses to run inside another page: when it finds itself in
// a frame it tries to take over the whole window, and if the browser refuses it
// replaces itself with an error screen. Media is generated PCM; nothing leaves
// the machine.
function wav(seconds, hz) {
  const rate = 8000, count = rate * seconds;
  const data = Buffer.alloc(44 + count * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(count * 2, 40);
  for (let n = 0; n < count; n++) data.writeInt16LE(Math.round(Math.sin(n * Math.PI * 2 * hz / rate) * 900), 44 + n * 2);
  return data;
}
const media = { sub: wav(90, 440), dub: wav(93, 330) };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/media') {
    const body = media[url.searchParams.get('lang')] ?? media.sub;
    const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes' };
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]), end = range[2] ? Number(range[2]) : body.length - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
      res.end(body.subarray(start, end + 1)); return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    res.end(body); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' });
  res.end(`<!doctype html><title>Fixture episode</title><main>
    <select aria-label="Language"><option value="sub">Sub</option><option value="dub">Dub</option></select>
    <video preload="auto" style="width:640px;height:360px"></video></main><script>
      if (window.location !== window.top.location) {
        const giveUp = () => {
          history.replaceState(null, '', '/disconnected');
          document.body.innerHTML = '<h1>Connection failed</h1>';
          throw new Error('refusing to run in a frame');
        };
        // The stricter pages under /strict/ also refuse a sandboxed frame.
        let sandboxed = false;
        try { document.domain = document.domain; } catch { sandboxed = true; }
        if (sandboxed && location.pathname.startsWith('/strict/')) giveUp();
        try { window.top.location = window.location.href; } catch { giveUp(); }
      }
      const language = document.querySelector('select');
      const video = document.querySelector('video');
      const show = value => { language.value = value; video.src = '/media?lang=' + value; video.play().catch(() => {}); };
      language.onchange = () => { localStorage.setItem('fixture-language', language.value); show(language.value); };
      show(localStorage.getItem('fixture-language') ?? 'sub');
    </script>`);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = await mkdtemp(join(tmpdir(), 'subview-framecheck-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH, channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
    headless: true, args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  const ask = message => popup.evaluate(message => chrome.runtime.sendMessage(message), message);
  const state = () => ask({ type: 'GET_STATE' }).then(r => r.state);
  const autoDub = () => ask({ type: 'GET_AUTO_DUB' }).then(r => r.autoDub);
  async function until(read, predicate, label, ms = 30000) {
    const deadline = Date.now() + ms;
    let value;
    do { value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < deadline);
    const extra = await worker.evaluate(async () => ({ offscreen: await chrome.offscreen.hasDocument(), windows: (await chrome.windows.getAll({ populate: true })).map(w => w.tabs.map(t => t.url)) }));
    throw new Error(`${label}: ${JSON.stringify(value)}; autoDub=${JSON.stringify(await autoDub())}; ${JSON.stringify(extra)}`);
  }

  await page.goto(`${origin}/episode`);
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
  const tabId = (await popup.evaluate(() => chrome.tabs.query({}))).find(t => t.url === page.url()).id;
  const windowsBefore = await worker.evaluate(async () => (await chrome.windows.getAll()).length);

  const firstStarted = Date.now();
  assert.equal((await ask({ type: 'SET_AUTO_DUB_SITE', site: '127.0.0.1', enabled: true, tabId, settings: { volume: 0.6, offsetMs: 0, muteOriginal: true } })).ok, true);
  const active = await until(state, s => s?.backgroundAudio?.mode === 'hosted', 'hosted Dub linked');
  const firstTook = Date.now() - firstStarted;
  assert.equal(active.backgroundAudio.container, 'offscreen', 'the hidden document, not the fallback window');
  assert.equal(Math.round(active.secondary.snapshot.durationMs / 1000), 93, 'the Dub media, not Sub');
  const memory = async () => (await worker.evaluate(() => chrome.storage.local.get('autoDubSites'))).autoDubSites['127.0.0.1'];
  assert.equal((await memory()).lenientFrame, true, 'the site remembers which frame worked');
  console.log(`PASS: a page that refuses to run in a frame is retried in the lenient frame, in the hidden document, and Dub is selected there (${(firstTook / 1000).toFixed(1)} s)`);

  const hidden = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
  assert.equal(hidden.length, 1, 'the hidden document survived the takeover attempt');
  assert.match(hidden[0].documentUrl, /^chrome-extension:\/\/[a-z]+\/offscreen\.html$/, 'and is still the extension page, not the site');
  assert.equal(await worker.evaluate(async () => (await chrome.windows.getAll()).length), windowsBefore, 'no window was opened');
  assert.equal(await page.$eval('select', s => s.value), 'sub', 'the visible tab stays on Sub');
  assert.equal(await page.evaluate(() => localStorage.getItem('fixture-language')), null, 'no preference written');
  console.log('PASS: the hidden document survives the takeover attempt; no window opens and the visible tab is untouched');

  await page.evaluate(() => document.querySelector('video').play());
  await until(state, s => s?.secondary.status === 'playing' && s.primary.status === 'playing', 'both playing');
  await page.evaluate(() => { document.querySelector('video').currentTime = 40; });
  await until(state, s => Math.abs(s.secondary.snapshot.currentTimeMs - 40000) < 2000 && s.secondary.status === 'playing', 'Dub follows a seek');
  console.log('PASS: Dub plays and follows a seek');

  await page.goto(`${origin}/episode-2`);
  const nextStarted = Date.now();
  const next = await until(state, s => s?.backgroundAudio?.mode === 'hosted' && s.backgroundAudio.pageUrl.endsWith('/episode-2') && s.backgroundAudio.container === 'offscreen', 'next episode linked in the same hidden document');
  const nextTook = Date.now() - nextStarted;
  assert.equal(Math.round(next.secondary.snapshot.durationMs / 1000), 93, 'the Dub media again');
  assert.ok(nextTook < firstTook - 2000, `no failed first try this time (${nextTook} ms against ${firstTook} ms)`);
  console.log(`PASS: the next episode links in the same hidden document, without the failed first try (${(nextTook / 1000).toFixed(1)} s)`);

  // A page that refuses every hidden way: the lenient frame, then the window,
  // which it takes over. The takeover must not leave a stray window behind.
  await page.goto(`${origin}/strict/episode-3`);
  const failed = await until(autoDub, a => a?.status === 'error', 'the strict page is reported, not left hanging', 60000);
  assert.match(failed.reason, /refuses to play inside another page/);
  await until(() => worker.evaluate(async () => (await chrome.windows.getAll()).length), count => count === windowsBefore, 'the taken-over window is closed');
  assert.equal(await worker.evaluate(() => chrome.offscreen.hasDocument()), false);
  assert.equal(await page.$eval('select', s => s.value), 'sub', 'the visible tab plays on');
  console.log('PASS: a page that takes over the Dub window is closed and reported; no stray window is left');

  await ask({ type: 'SET_AUTO_DUB_SITE', site: '127.0.0.1', enabled: false });
  await until(autoDub, a => a === null || a === undefined, 'Auto Dub off');
} finally {
  await context?.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
