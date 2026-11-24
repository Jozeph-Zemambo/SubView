import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// A local site whose video is copy-protected, the mark SubView takes for a
// service that counts streams. There a second hidden copy for the same
// playback has to wait, unless the visible tab is reloaded. Media is generated
// PCM; nothing leaves the machine.
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

// A player that remembers nothing: every load starts paused at the beginning,
// on the viewer's own language, with subtitles off. Audio is chosen by
// language in a settings panel and switches in place. Japanese is the original
// (the 90 s media), English the Dub (93 s).
const FORGETFUL_PAGE = `<!doctype html><title>Forgetful episode</title><main>
  <video preload="auto" style="display:block;width:640px;height:360px"></video>
  <div id="gear" class="player-button" role="button" aria-label="Settings" aria-expanded="false" tabindex="0" style="width:32px;height:32px;background:#888"></div>
  <div id="panel"></div></main><script>
    const video = document.querySelector('video');
    const lists = { 'Audio Language': ['English', 'Japanese'], 'Subtitles': ['Subtitles Off', 'American English'], 'Subtitle Size': ['Small', 'Large'] };
    const chosen = window.fixtureChosen = { 'Audio Language': 'English', 'Subtitles': 'Subtitles Off', 'Subtitle Size': 'Small' };
    window.fixtureOpened = 0;
    window.fixturePickedWhileClosed = 0;
    sessionStorage.setItem('loads', String(Number(sessionStorage.getItem('loads') ?? 0) + 1));
    const load = () => {
      const at = video.currentTime, playing = !video.paused;
      video.src = '/media?lang=' + (chosen['Audio Language'] === 'English' ? 'dub' : 'sub');
      video.addEventListener('loadedmetadata', () => { video.currentTime = at; if (playing) video.play().catch(() => {}); }, { once: true });
    };
    const draw = () => { panel.innerHTML = '<div role="menu">' + Object.entries(lists).map(([group, names]) => '<ul role="listbox" aria-label="' + group + '">' +
      names.map(name => '<li role="option" aria-selected="' + (chosen[group] === name) + '"><span>' + name + '</span></li>').join('') + '</ul>').join('') + '</div>'; };
    // A closed panel stays in the page, faded out, as real players' panels do.
    gear.onclick = () => { const open = gear.getAttribute('aria-expanded') === 'true'; gear.setAttribute('aria-expanded', String(!open)); panel.style.opacity = open ? '0' : '1'; if (!open) { window.fixtureOpened += 1; draw(); } };
    panel.onclick = event => {
      const picked = event.target.closest('[role="option"]');
      if (!picked) return;
      if (gear.getAttribute('aria-expanded') !== 'true') window.fixturePickedWhileClosed += 1;
      const group = picked.closest('[role="listbox"]').getAttribute('aria-label');
      if (chosen[group] === picked.textContent) return;
      chosen[group] = picked.textContent;
      if (group === 'Audio Language') load();
      draw();
    };
    navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{ initDataTypes: ['keyids'],
      audioCapabilities: [{ contentType: 'audio/webm; codecs="opus"' }] }])
      .then(access => access.createMediaKeys()).then(keys => video.setMediaKeys(keys))
      .then(() => { document.title = 'Forgetful episode (protected)'; load(); });
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
  if (url.pathname.startsWith('/forgetful/')) {
    // The hidden copy is the slow one, as on a real service: the viewer's tab
    // is back and being set up while the copy is still loading.
    const framed = req.headers['sec-fetch-dest'] === 'iframe';
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(FORGETFUL_PAGE); }, framed ? 2500 : 0);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Fixture episode</title><main>
    <select aria-label="Language"><option value="sub">Sub</option><option value="dub">Dub</option></select>
    <video preload="auto" style="width:640px;height:360px"></video></main><script>
      const language = document.querySelector('select');
      const video = document.querySelector('video');
      const show = value => { language.value = value; video.src = '/media?lang=' + value; video.play().catch(() => {}); };
      language.onchange = () => { localStorage.setItem('fixture-language', language.value); show(language.value); };
      navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{ initDataTypes: ['keyids'],
        audioCapabilities: [{ contentType: 'audio/webm; codecs="opus"' }] }])
        .then(access => access.createMediaKeys()).then(keys => video.setMediaKeys(keys))
        .then(() => { document.title = 'Fixture episode (protected)'; show(localStorage.getItem('fixture-language') ?? 'sub'); });
    </script>`);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = await mkdtemp(join(tmpdir(), 'subview-reload-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH, channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
    headless: true, args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  const control = await context.newPage();
  const extension = `chrome-extension://${new URL(worker.url()).host}`;
  await control.goto(`${extension}/popup.html`);
  const ask = message => control.evaluate(message => chrome.runtime.sendMessage(message), message);
  const state = () => ask({ type: 'GET_STATE' }).then(r => r.state);
  const autoDub = () => ask({ type: 'GET_AUTO_DUB' }).then(r => r.autoDub);
  async function until(read, predicate, label, ms = 30000) {
    const deadline = Date.now() + ms;
    let value;
    do { value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < deadline);
    throw new Error(`${label}: ${JSON.stringify(value)}; autoDub=${JSON.stringify(await autoDub())}`);
  }
  const linked = label => until(state, s => s?.backgroundAudio?.mode === 'hosted', label);
  // Like the popup, every turn-on says whether reloads are allowed; a site turned off keeps its choice otherwise.
  const settings = { volume: 0.6, offsetMs: 0, muteOriginal: true, autoReload: false };

  // ---- a player that forgets everything on reload, on a site where reloads are allowed ----
  await page.goto(`${origin}/forgetful/1`);
  await page.waitForFunction(() => document.title.includes('protected') && document.querySelector('video').readyState >= 1);
  const tabId = (await control.evaluate(() => chrome.tabs.query({}))).find(t => t.url === page.url()).id;
  const turnOn = extra => ask({ type: 'SET_AUTO_DUB_SITE', site: '127.0.0.1', enabled: true, tabId, settings: { ...settings, ...extra } });
  const turnOff = async () => {
    await ask({ type: 'SET_AUTO_DUB_SITE', site: '127.0.0.1', enabled: false });
    await until(autoDub, a => a === null || a === undefined, 'Auto Dub off');
  };
  const card = () => page.getByRole('alertdialog', { name: /SubView/ });
  const player = () => page.evaluate(() => { const v = document.querySelector('video'); return { ...window.fixtureChosen, time: v.currentTime, paused: v.paused, duration: Math.round(v.duration),
    open: document.querySelector('#gear').getAttribute('aria-expanded') === 'true' ? 1 : 0, opened: window.fixtureOpened, blind: window.fixturePickedWhileClosed, loads: Number(sessionStorage.getItem('loads')) }; });
  const putBack = (wasAt, label) => until(player, v => v['Audio Language'] === 'Japanese' && v.Subtitles === 'American English' && v['Subtitle Size'] === 'Large' &&
    !v.paused && v.time >= wasAt - 3 && v.open === 0, label);
  const reloaded = () => page.waitForFunction(() => window.__before === undefined && document.title.includes('protected'), null, { timeout: 15000 });

  await turnOn({ autoReload: true });
  await until(autoDub, a => a?.status === 'waiting' && /already playing audio in your language/.test(a.reason), 'the fresh copy is on the viewer\'s language, like the tab');
  // The viewer sets the player up their way: original audio, subtitles on, large.
  const pick = async (group, name) => page.locator(`[aria-label="${group}"] [role="option"]`, { hasText: name }).click();
  await page.locator('#gear').click();
  await pick('Audio Language', 'Japanese');
  await pick('Subtitles', 'American English');
  await pick('Subtitle Size', 'Large');
  await page.locator('#gear').click();
  await linked('Dub linked once the tab is on the original language');
  assert.equal((await player()).loads, 1, 'choosing the original language by hand reloads nothing');
  await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 40; return v.play(); });
  await until(state, s => s?.secondary.status === 'playing' && s.primary.status === 'playing' && s.primary.snapshot.currentTimeMs > 40000, 'both playing from 40 s');

  // The app changes the address and puts it back 9 ms later (a "back" with
  // nowhere to go). The episode never left: the Dub must carry on untouched,
  // with no copy closed and so no wait and no card.
  const copyBefore = (await state()).secondary.endpoint.documentId;
  await page.evaluate(() => { history.pushState(null, '', location.pathname + '#nowhere?x=1'); setTimeout(() => history.replaceState(null, '', location.pathname), 9); });
  await new Promise(r => setTimeout(r, 2000));
  const afterBounce = await linked('Dub linked after the address flicker');
  assert.equal(afterBounce.secondary.endpoint.documentId, copyBefore, 'the same hidden copy, not a reloaded one');
  assert.equal((await autoDub()).status, 'active');
  assert.equal(await card().count(), 0, 'no reload card');
  assert.equal((await worker.evaluate(() => chrome.storage.session.get('autoDubLastCopy'))).autoDubLastCopy, undefined, 'no copy was closed');
  assert.equal((await player()).loads, 1);
  console.log('PASS: an address that changes and comes straight back leaves the Dub alone: nothing closed, no card');

  // Off and on during the same playback: the copy that just closed still counts,
  // so a new one would have to wait. Allowed, SubView reloads the tab instead.
  await turnOff();
  let wasAt = await page.evaluate(() => { window.__before = true; return document.querySelector('video').currentTime; });
  await turnOn({ autoReload: true });
  await reloaded();
  let back = await putBack(wasAt, 'the reloaded player is put back');
  assert.ok(back.time < wasAt + 20, `back where the viewer was, not somewhere else (${wasAt.toFixed(1)} s before, ${back.time.toFixed(1)} s after)`);
  assert.equal(back.duration, 90, 'the tab plays the original audio again');
  assert.equal(back.opened, 1, 'the settings were opened once, and closed again');
  assert.equal(back.blind, 0, 'every choice was made in the open panel, none in a closed one');
  assert.equal(await card().count(), 0, 'no card when reloads are allowed');
  const again = await linked('Dub linked after the automatic reload');
  assert.equal(Math.round(again.secondary.snapshot.durationMs / 1000), 93, 'the Dub media');
  await until(state, s => s?.secondary.status === 'playing' && s.primary.status === 'playing', 'both playing again');
  console.log(`PASS: allowed, SubView reloads the tab by itself and puts the player back: audio, subtitles and size re-chosen, ${wasAt.toFixed(0)} s -> ${back.time.toFixed(0)} s, playing, Dub linked`);

  // SubView's own put-back opens the settings while they still show the
  // viewer's language. If that reading closed the copy that was loading, the
  // next step would be another wait and another reload, again and again.
  await new Promise(r => setTimeout(r, 6000));
  const settled = await player();
  assert.equal(settled.loads, 2, `the tab was reloaded once, not again and again (${settled.loads - 1} reloads)`);
  assert.equal(settled['Audio Language'], 'Japanese');
  assert.equal(settled.paused, false);
  assert.equal((await state())?.backgroundAudio?.mode, 'hosted', 'and Dub is still linked');

  // The same again moments later: no second automatic reload so soon. The card asks.
  await turnOff();
  await turnOn({ autoReload: true });
  await until(autoDub, a => a?.reloadOffer === true, 'a second wait within minutes is offered, not taken');
  await card().waitFor({ timeout: 5000 });
  assert.equal((await player()).loads, 2);
  console.log('PASS: the tab is reloaded once, never in a loop; a second wait soon after shows the card instead');

  // The viewer's own click reloads, and is put back the same way.
  wasAt = await page.evaluate(() => { window.__before = true; return document.querySelector('video').currentTime; });
  await card().getByRole('button', { name: 'Reload now' }).click();
  await reloaded();
  back = await putBack(wasAt, 'put back after the viewer\'s own reload click');
  await linked('Dub linked after the reload click on the forgetful page');
  assert.equal((await player()).loads, 3);
  console.log('PASS: "Reload now" on the card reloads once and puts the player back too');
  await turnOff();

  // ---- the offer itself, on a plain page ----
  await page.goto(`${origin}/episode`);
  await page.waitForFunction(() => document.title.includes('protected') && document.querySelector('video').readyState >= 1);
  await turnOn();
  await linked('first Dub linked on the plain page');
  const popup = await context.newPage();
  await popup.goto(`${extension}/popup.html?tab=${tabId}`);
  assert.equal(await popup.locator('#reload').isHidden(), true, 'no reload button while nothing waits');

  await turnOff();
  await turnOn();
  const waiting = await until(autoDub, a => a?.reloadOffer === true, 'the wait offers a reload');
  assert.equal(waiting.reason, 'Reload your tab and Dub starts right away.');
  await card().waitFor({ timeout: 5000 });
  assert.equal((await card().innerText()).replace(/\s+/g, ' ').trim(), 'SubView × Reload your tab and Dub starts right away. Reload now Always reload', 'one sentence and the buttons, nothing more');
  console.log('PASS: while a second copy has to wait, a card on the page offers to reload the tab, in one sentence');

  await popup.locator('#reload').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await popup.locator('#status').innerText(), 'Reload your tab and Dub starts right away.');
  assert.equal(await popup.locator('#auto-reload').getAttribute('aria-checked'), 'false');
  console.log('PASS: the popup shows the same offer as a button, and the allow switch is off');

  // A click the page's own scripts make up is not the viewer's.
  await page.evaluate(() => { window.__before = true; document.querySelector('html > div').shadowRoot.querySelector('.go').click(); });
  await new Promise(r => setTimeout(r, 500));
  assert.equal(await page.evaluate(() => window.__before), true, 'a scripted click does not reload');

  const clicked = Date.now();
  await card().getByRole('button', { name: 'Reload now' }).click();
  await page.waitForFunction(() => window.__before === undefined, null, { timeout: 10000 });
  await linked('Dub linked after the reload');
  const took = Date.now() - clicked;
  assert.ok(took < 30000, `no 100 s wait (${took} ms)`);
  assert.equal(await card().count(), 0, 'the card is gone');
  assert.equal(await popup.locator('#reload').isHidden(), true, 'and so is the popup button');
  assert.equal(await page.$eval('select', s => s.value), 'sub', 'the visible tab is still on Sub');
  console.log(`PASS: "Reload now" reloads the tab and Dub is linked ${(took / 1000).toFixed(1)} s after the click`);

  // The popup switch saves the permission for the site, both ways.
  const saved = () => worker.evaluate(() => chrome.storage.local.get('autoDubSites')).then(s => s.autoDubSites['127.0.0.1'].autoReload);
  await popup.locator('#auto-reload').click();
  await until(saved, value => value === true, 'the switch turns the permission on');
  await popup.locator('#auto-reload').click();
  await until(saved, value => value === false, 'and off again');

  // "Always reload" on the card saves the permission and reloads.
  await turnOff();
  await page.evaluate(() => { window.__before = true; });
  await turnOn();
  await until(autoDub, a => a?.reloadOffer === true, 'offered while the permission is off');
  assert.equal(await page.evaluate(() => window.__before), true, 'not reloaded unasked');
  await card().getByRole('button', { name: 'Always reload' }).click();
  await page.waitForFunction(() => window.__before === undefined, null, { timeout: 10000 });
  await linked('Dub linked after Always reload');
  assert.equal(await saved(), true);
  console.log('PASS: the popup switch saves the permission both ways; "Always reload" on the card turns it on and reloads');

  await turnOff();
} finally {
  await context?.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
