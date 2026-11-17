import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// A local site shaped like the hard cases seen in the wild: the player is a
// cross-origin frame that only loads once it is on screen and has painted, the
// language choice is saved in localStorage, and other tabs follow it through
// storage events. Media is generated PCM; nothing leaves the machine.
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
let origin, embedOrigin;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/media') {
    const body = media[url.searchParams.get('lang')] ?? media.sub;
    const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (range) { // Seeking needs byte ranges.
      const start = Number(range[1]), end = range[2] ? Number(range[2]) : body.length - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
      res.end(body.subarray(start, end + 1)); return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    res.end(body); return;
  }
  if (url.pathname === '/player') {
    // The player shell. Like some real players, the video sits one frame deeper.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': `frame-ancestors ${origin}` });
    res.end(`<!doctype html><iframe allow="autoplay" style="width:640px;height:360px" src="/inner${url.search}"></iframe>`); return;
  }
  if (url.pathname === '/inner') {
    // Refuses to render outside its own site. Requested by the player, not the
    // episode page, so SubView must learn the player's site before it loads.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `frame-ancestors ${origin} ${embedOrigin}` });
    res.end(`<!doctype html><video preload="auto" style="width:640px;height:360px"></video><script>
      const video = document.querySelector('video');
      const lang = new URL(location.href).searchParams.get('lang');
      let seen = false, painted = false;
      const start = () => { if (!seen || !painted || video.src) return; video.src = '${'${ORIGIN}'}/media?lang=' + lang; video.play().catch(() => {}); };
      new IntersectionObserver(entries => { seen = entries.some(e => e.isIntersecting); start(); }).observe(video);
      requestAnimationFrame(() => { painted = document.visibilityState === 'visible'; start(); });
    </script>`.replaceAll('${ORIGIN}', embedOrigin)); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' });
  res.end(`<!doctype html><title>Fixture episode</title><main>
    <select aria-label="Language"><option value="sub">Sub</option><option value="dub">Dub</option></select>
    <select aria-label="Server"><option>alpha · s-sub</option><option>beta · s-sub</option></select>
    <iframe allow="autoplay" style="width:640px;height:360px"></iframe></main><script>
      const language = document.querySelector('select[aria-label="Language"]');
      const frame = document.querySelector('iframe');
      const show = value => { language.value = value; frame.src = '${embedOrigin}/player?lang=' + value; };
      language.onchange = () => { localStorage.setItem('fixture-language', language.value); show(language.value); };
      addEventListener('storage', event => { if (event.key === 'fixture-language') show(event.newValue); });
      show(localStorage.getItem('fixture-language') ?? 'sub');
    </script>`);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
origin = `http://127.0.0.1:${server.address().port}`;
embedOrigin = origin.replace('127.0.0.1', 'localhost');

const profile = await mkdtemp(join(tmpdir(), 'subview-hosted-'));
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
    throw new Error(`${label}: ${JSON.stringify(value)}; autoDub=${JSON.stringify(await autoDub())}`);
  }

  await page.goto(`${origin}/episode`);
  const subFrame = await until(async () => page.frames().find(f => f.url().includes('/inner?lang=sub')), Boolean, 'visible Sub player frame');
  await subFrame.waitForFunction(() => document.querySelector('video').readyState >= 1);
  const tabId = (await popup.evaluate(() => chrome.tabs.query({}))).find(t => t.url === page.url()).id;

  const shoot = async name => {
    if (!process.env.POPUP_SCREENSHOT) return;
    const shot = await context.newPage();
    await shot.setViewportSize({ width: 340, height: 600 });
    await shot.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html?tab=${tabId}`);
    await shot.waitForTimeout(900);
    await shot.screenshot({ path: process.env.POPUP_SCREENSHOT.replace('.png', `-${name}.png`), fullPage: true });
    await shot.close();
  };
  await shoot('off');
  assert.equal((await ask({ type: 'SET_AUTO_DUB_SITE', site: '127.0.0.1', enabled: true, tabId, settings: { volume: 0.6, offsetMs: 0, muteOriginal: true } })).ok, true);
  await shoot('searching');
  const active = await until(state, s => s?.backgroundAudio?.mode === 'hosted', 'hosted Dub linked');
  assert.equal(active.backgroundAudio.container, 'offscreen', 'the hidden document, not the fallback window');
  assert.equal(active.backgroundAudio.provider, 'alpha · s-sub');
  assert.equal(Math.round(active.secondary.snapshot.durationMs / 1000), 93, 'the Dub media, not Sub');
  assert.equal((await autoDub()).status, 'active');
  const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  const embed = rules.find(rule => rule.condition.initiatorDomains);
  assert.deepEqual([...embed.condition.initiatorDomains].sort(), ['127.0.0.1', 'localhost'], 'headers dropped only for frames the episode site or its player request');
  assert.ok(rules.every(rule => rule.condition.requestDomains || rule.condition.initiatorDomains), 'no rule matches every tabless frame');
  console.log('PASS: lazy cross-origin embed (two frames deep) loads in the offscreen document and Dub is selected there');
  console.log('PASS: anti-framing headers are dropped only for frames the episode site and its player load');
  await shoot('live');

  assert.equal(await page.$eval('select', s => s.value), 'sub', 'the visible tab stays on Sub');
  assert.equal(await page.evaluate(() => localStorage.getItem('fixture-language')), null, 'no preference written');
  assert.ok(page.frames().some(f => f.url().includes('/inner?lang=sub')), 'the visible player never switched');
  console.log('PASS: selecting Dub in the hidden copy leaves the visible tab and its storage untouched');

  await subFrame.evaluate(() => document.querySelector('video').play());
  await until(state, s => s?.secondary.status === 'playing' && s.primary.status === 'playing', 'both playing');
  await until(() => subFrame.evaluate(() => document.querySelector('video').muted), Boolean, 'visible video muted once Dub plays');
  await new Promise(r => setTimeout(r, 4000));
  const drifts = [];
  for (let i = 0; i < 6; i++) {
    const sample = await worker.evaluate(() => globalThis.subviewDiagnostics.sampleSyncDrift());
    if (sample?.ok) drifts.push(Math.abs(sample.driftMs));
    await new Promise(r => setTimeout(r, 500));
  }
  drifts.sort((a, b) => a - b);
  assert.ok(drifts.length >= 4 && drifts[Math.floor(drifts.length / 2)] < 120, `median drift ${drifts}`);
  console.log(`PASS: Dub follows the visible video (median drift ${Math.round(drifts[Math.floor(drifts.length / 2)])} ms)`);

  await subFrame.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 40; });
  await until(state, s => Math.abs(s.secondary.snapshot.currentTimeMs - 40000) < 2000 && s.secondary.status === 'playing', 'Dub follows a seek');
  await subFrame.evaluate(() => document.querySelector('video').pause());
  await until(state, s => s.secondary.snapshot.paused, 'Dub follows a pause');
  console.log('PASS: seek and pause follow the visible video');

  // Per-site: the next episode gets Dub with no popup interaction.
  await page.goto(`${origin}/episode-2`);
  await until(async () => page.frames().find(f => f.url().includes('/inner?lang=sub')), Boolean, 'next episode Sub player');
  const next = await until(state, s => s?.backgroundAudio?.mode === 'hosted' && s.backgroundAudio.pageUrl.endsWith('/episode-2'), 'next episode linked automatically');
  assert.equal(Math.round(next.secondary.snapshot.durationMs / 1000), 93);
  const sites = await worker.evaluate(() => chrome.storage.local.get('autoDubSites'));
  assert.ok(sites.autoDubSites['127.0.0.1'], 'the site stays on in local storage');
  console.log('PASS: with the site turned on, the next episode gets its Dub automatically');

  await ask({ type: 'SET_AUTO_DUB_SITE', site: '127.0.0.1', enabled: false });
  await until(state, s => s === null, 'sync stopped');
  const leftovers = await worker.evaluate(async () => ({
    rules: (await chrome.declarativeNetRequest.getSessionRules()).length,
    scripts: (await chrome.scripting.getRegisteredContentScripts()).length,
    offscreen: await chrome.offscreen.hasDocument(),
  }));
  assert.deepEqual(leftovers, { rules: 0, scripts: 0, offscreen: false });
  const currentSub = page.frames().find(f => f.url().includes('/inner?lang=sub'));
  assert.equal(await currentSub.evaluate(() => document.querySelector('video').muted), false, 'visible sound restored');
  console.log('PASS: Disable removes the hidden page, its header rules and its scripts, and restores sound');
} finally {
  await context?.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
