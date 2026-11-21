import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The built extension against a local site whose players choose audio by
// language, in the two shapes seen on licensed services:
//   /track/…  a labelled track button; choosing a language saves it to the
//             account (a PATCH), moves to that version's own address and loads
//             its stream.
//   /limit/…  plays in a tab, but refuses in a second copy and says why.
//   /panel/…  a settings button; its panel holds the audio list, the choice is
//             kept in localStorage and the audio switches in place (no new load).
// Media is generated PCM; nothing leaves the machine.
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
/** What reached the server: account saves, and notes the pages leave about themselves. */
const saved = [], notes = [];

const TRACK_PAGE = `<!doctype html><title>Track episode</title><main>
  <video preload="auto" style="display:block;width:640px;height:360px"></video>
  <div class="player-controls"><button id="tracks" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Audio and subtitle language options">A</button>
    <button id="settings" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Player Settings">S</button></div>
  <div id="pop"></div></main><script>
    const video = document.querySelector('video');
    const audio = () => location.pathname.endsWith('-en') ? 'English' : 'Japanese';
    const load = () => { video.src = '/media?lang=' + (audio() === 'English' ? 'dub' : 'sub'); };
    const item = (name, on) => '<div role="menuitemradio" aria-label="' + name + '" aria-checked="' + on + '">' + name + '</div>';
    const draw = () => { pop.innerHTML = '<div role="menu"><div role="menu" aria-label="Audio Track Selection">' + ['Japanese', 'English', 'English [AD]'].map(name => item(name, name === audio())).join('') +
      '</div><div role="menu" aria-label="Subtitle and closed caption selection">' + item('English', true) + item('None', false) + '</div></div>'; };
    tracks.onclick = () => { const open = tracks.getAttribute('aria-expanded') === 'true'; tracks.setAttribute('aria-expanded', String(!open)); if (open) pop.innerHTML = ''; else setTimeout(draw, 120); };
    pop.onclick = event => {
      const picked = event.target.closest('[aria-label="Audio Track Selection"] [role="menuitemradio"]');
      const name = picked && picked.getAttribute('aria-label');
      if (!name || name === audio()) return;
      // Like the real thing: save the preference to the account, and carry on whether or not that worked.
      fetch('/account', { method: 'PATCH', body: name }).catch(() => fetch('/note?save-blocked=' + name));
      history.pushState(null, '', location.pathname.replace(/-(?:ja|en)$/, name === 'English' ? '-en' : '-ja'));
      load();
      draw();
    };
    load();
  </script>`;

const PANEL_PAGE = `<!doctype html><title>Panel episode</title><main>
  <video preload="auto" src="/media?lang=sub" style="display:block;width:640px;height:360px"></video>
  <div id="gear" class="player-button" role="button" aria-label="Settings" aria-expanded="false" tabindex="0" style="width:32px;height:32px"></div>
  <div id="panel"></div></main><script>
    let current = localStorage.getItem('audio-lang') ?? 'Japanese';
    const option = (group, name, on) => '<li role="option" aria-label="' + group + ', ' + name + '" aria-selected="' + on + '"><span>' + name + '</span></li>';
    const draw = () => { panel.innerHTML = '<div role="menu"><ul role="listbox" aria-label="Audio Language">' + ['English', 'Japanese'].map(name => option('Audio Language', name, name === current)).join('') +
      '</ul><ul role="listbox" aria-label="Subtitles">' + option('Subtitles', 'Subtitles Off', true) + option('Subtitles', 'American English', false) + '</ul></div>'; };
    gear.onclick = () => { const open = gear.getAttribute('aria-expanded') === 'true'; gear.setAttribute('aria-expanded', String(!open)); if (open) panel.innerHTML = ''; else draw(); };
    panel.onclick = event => {
      const picked = event.target.closest('[aria-label="Audio Language"] [role="option"]');
      if (!picked || picked.textContent === current) return;
      current = picked.textContent;
      localStorage.setItem('audio-lang', current);
      fetch('/note?chose=' + current + '&framed=' + (top !== self)); // The same video keeps playing: nothing reloads.
      draw();
    };
  </script>`;

// Plays for the viewer; the framed (second) copy gets the service's refusal instead of a video.
const LIMIT_PAGE = `<!doctype html><title>Limited episode</title><main><div id="player-container"></div>
  <div class="player-controls"><button type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Audio and subtitle language options">A</button></div></main><script>
    const box = document.getElementById('player-container');
    if (top === self) box.innerHTML = '<video preload="auto" src="/media?lang=sub" style="display:block;width:640px;height:360px"></video>';
    else box.innerHTML = '<div role="dialog"><h2>Stream Limit Reached</h2><p>Stop an existing stream to continue.</p><button type="button">Try Again</button></div>';
  </script>`;

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
  if (url.pathname === '/account') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { saved.push(`${req.method} ${body}`); res.writeHead(204); res.end(); });
    return;
  }
  if (url.pathname === '/note') { notes.push(url.search); res.writeHead(204); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' });
  res.end(url.pathname.startsWith('/track/') ? TRACK_PAGE : url.pathname.startsWith('/limit/') ? LIMIT_PAGE : PANEL_PAGE);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = await mkdtemp(join(tmpdir(), 'subview-audio-'));
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
  const blockRules = () => worker.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).filter(rule => rule.action.type === 'block').length);
  async function until(read, predicate, label, ms = 40000) {
    const deadline = Date.now() + ms;
    let value;
    do { value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < deadline);
    throw new Error(`${label}: ${JSON.stringify(value)}; autoDub=${JSON.stringify(await autoDub())}; saved=${JSON.stringify(saved)}; notes=${JSON.stringify(notes)}`);
  }
  const ready = () => page.waitForFunction(() => document.querySelector('video').readyState >= 1);

  // ---- a version per address, saved to the account ----
  await page.goto(`${origin}/track/1-ja`);
  await ready();
  const tabId = (await popup.evaluate(() => chrome.tabs.query({}))).find(t => t.url === page.url()).id;
  assert.equal((await ask({ type: 'SET_AUTO_DUB_SITE', site: '127.0.0.1', enabled: true, tabId, settings: { volume: 0.6, offsetMs: 0, muteOriginal: true } })).ok, true);
  const track = await until(state, s => s?.backgroundAudio?.mode === 'hosted', 'hosted Dub linked on the track-menu page');
  assert.equal(track.backgroundAudio.container, 'offscreen', 'the hidden document, not the fallback window');
  assert.equal(Math.round(track.secondary.snapshot.durationMs / 1000), 93, "the viewer's-language stream, not the original");
  console.log('PASS: opens the track menu in the hidden copy, chooses the viewer\'s language and follows it to the new stream');

  assert.deepEqual(saved, [], 'the account never received the hidden copy\'s language choice');
  assert.ok(notes.includes('?save-blocked=English'), `the hidden copy did try to save it: ${JSON.stringify(notes)}`);
  await until(blockRules, count => count === 0, 'the settings guard is removed again', 15000);
  console.log('PASS: the account save from the hidden copy is blocked, and the guard is lifted afterwards');

  assert.ok(page.url().endsWith('/track/1-ja'), 'the visible tab stays on the original-language address');
  assert.equal(await page.locator('[role="menuitemradio"]').count(), 0, "the visible tab's menu was never opened");
  assert.equal(Math.round(await page.evaluate(() => document.querySelector('video').duration)), 90, 'the visible tab still plays the original');
  console.log('PASS: the visible tab is untouched');

  await page.evaluate(() => document.querySelector('video').play());
  await until(state, s => s?.secondary.status === 'playing' && s.primary.status === 'playing', 'both playing');
  await page.evaluate(() => { document.querySelector('video').currentTime = 40; });
  await until(state, s => Math.abs(s.secondary.snapshot.currentTimeMs - 40000) < 2000 && s.secondary.status === 'playing', 'Dub follows a seek');
  console.log('PASS: the Dub plays and follows a seek');

  // ---- one stream, audio switched in place, choice kept in localStorage ----
  notes.length = 0;
  await page.goto(`${origin}/panel/1`);
  await ready();
  const panel = await until(state, s => s?.backgroundAudio?.mode === 'hosted' && s.backgroundAudio.pageUrl.endsWith('/panel/1'), 'hosted Dub linked on the settings-panel page');
  assert.equal(panel.backgroundAudio.container, 'offscreen');
  assert.ok(notes.includes('?chose=English&framed=true'), `the hidden copy chose English: ${JSON.stringify(notes)}`);
  assert.equal(notes.filter(note => note.startsWith('?chose=')).length, 1, 'chosen once, and only in the hidden copy');
  assert.equal(await page.evaluate(() => localStorage.getItem('audio-lang')), null, "the viewer's own saved choice is untouched");
  assert.equal(await page.locator('[role="listbox"]').count(), 0, "the visible tab's settings were never opened");
  assert.equal((await autoDub()).status, 'active');
  console.log('PASS: finds the audio list inside the settings panel and accepts a switch that happens in place');
  console.log("PASS: the hidden copy's choice stays out of the viewer's localStorage");

  // ---- already on the viewer's language ----
  const pagesBefore = context.pages().length;
  await page.evaluate(() => localStorage.setItem('audio-lang', 'English'));
  await page.goto(`${origin}/panel/2`);
  await ready();
  const waiting = await until(autoDub, a => a?.status === 'waiting' && /already playing audio in your language/.test(a.reason), 'waits when the page is already on the viewer\'s language');
  assert.equal(await state(), null, 'nothing is linked');
  assert.equal(context.pages().length, pagesBefore, 'no minimized fallback window was opened');
  assert.match(waiting.reason, /switch the audio back/);
  console.log("PASS: a page already on the viewer's language is reported as waiting, with no fallback window");

  // ---- the service refuses a second copy and says why ----
  await page.evaluate(() => localStorage.removeItem('audio-lang'));
  await page.goto(`${origin}/limit/1`);
  await ready();
  const refused = await until(autoDub, a => a?.status === 'error', 'reports the refusal', 60000);
  assert.match(refused.reason, /The page in the hidden copy says: “Stream Limit Reached Stop an existing stream to continue\.”/);
  assert.equal(context.pages().length, pagesBefore, 'no minimized fallback window was opened for a page that refused');
  console.log("PASS: when the page in the hidden copy refuses to play, its own message is shown and no fallback window is opened");

  await ask({ type: 'SET_AUTO_DUB_SITE', site: '127.0.0.1', enabled: false });
  const leftovers = await worker.evaluate(async () => ({
    rules: (await chrome.declarativeNetRequest.getSessionRules()).length,
    scripts: (await chrome.scripting.getRegisteredContentScripts()).length,
    offscreen: await chrome.offscreen.hasDocument(),
  }));
  assert.deepEqual(leftovers, { rules: 0, scripts: 0, offscreen: false });
  console.log('PASS: Disable leaves no rules, scripts or hidden page behind');
} finally {
  await context?.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
