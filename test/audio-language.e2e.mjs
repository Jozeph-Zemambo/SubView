// Players that choose audio by language (Japanese / English…) instead of
// Sub/Dub. Two shapes, both standard markup: a labelled track button that
// opens an "Audio" menu and moves to another address, and a settings button
// whose panel holds an "Audio Language" list that switches in place.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const { outputFiles: [{ text: detectorScript }] } = await build({
  entryPoints: [fileURLToPath(new URL("../src/content/language-detection.ts", import.meta.url))],
  bundle: true, write: false, format: "iife", globalName: "__languageDetectionEngine", target: "es2022",
});

let browser;
let launchError;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, channel: process.env.CHROMIUM_PATH ? undefined : "chromium", headless: true });
} catch (error) {
  launchError = error;
}
after(async () => { await browser?.close(); });
const options = () => launchError ? { skip: `Chromium is unavailable: ${launchError.message}` } : undefined;

async function withPage(markup, callback, locale = "en-US") {
  const context = await browser.newContext({ locale });
  const page = await context.newPage();
  try {
    await page.setContent(`<!doctype html><base href="https://fixture.test/watch/episode">${markup}`);
    await page.addScriptTag({ content: detectorScript });
    return await callback(page);
  } finally {
    await context.close();
  }
}
const detect = page => page.evaluate(() => window.__languageDetectionEngine.detectLanguage(document));
const select = page => page.evaluate(() => window.__languageDetectionEngine.selectDubInteractive(document, true));
const player = '<video style="display:block;width:640px;height:360px"></video>';

/** A track button; its menus exist only while open, and choosing audio moves to another address. */
const trackMenu = (audio, chosen = "Japanese") => `<main>${player}
  <div id="controls" class="player-controls">
    <button id="tracks" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Audio and subtitle language options"></button>
    <button id="settings" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Player Settings"></button>
    <div id="pop"></div>
  </div>
  <script>
    window.saved = [];
    let current = ${JSON.stringify(chosen)};
    const audio = ${JSON.stringify(audio)};
    const item = (name, on) => '<div role="menuitemradio" aria-label="' + name + '" aria-checked="' + on + '">' + name + '</div>';
    const draw = () => { pop.innerHTML = '<div role="menu"><div role="menu" aria-label="Audio Track Selection">' + audio.map(name => item(name, name === current)).join('') +
      '</div><div role="menu" aria-label="Subtitle and closed caption selection">' + item('English', true) + item('None', false) + '</div></div>'; };
    tracks.addEventListener('click', () => { const open = tracks.getAttribute('aria-expanded') === 'true'; tracks.setAttribute('aria-expanded', String(!open)); if (open) pop.innerHTML = ''; else setTimeout(draw, 150); });
    settings.addEventListener('click', () => { pop.innerHTML = '<div role="menu" aria-label="Quality">' + item('Highest', true) + item('Data Saver', false) + '</div>'; });
    pop.addEventListener('click', event => {
      const picked = event.target.closest('[aria-label="Audio Track Selection"] [role="menuitemradio"]');
      if (!picked) return;
      current = picked.getAttribute('aria-label');
      window.saved.push(current);
      location.hash = current;
      draw();
    });
  </script></main>`;

/** A settings button; its panel holds the audio list, and choosing switches in place. */
const settingsPanel = (chosen = "Japanese", audio = ["English", "Japanese"]) => `<main>${player}
  <div id="bar" class="player-bar"><div id="gear" role="button" aria-label="Settings" aria-expanded="false" tabindex="0" style="width:32px;height:32px"></div><div id="panel"></div></div>
  <script>
    let current = ${JSON.stringify(chosen)};
    const audio = ${JSON.stringify(audio)};
    const option = (group, name, on) => '<li role="option" aria-label="' + group + ', ' + name + '" aria-selected="' + on + '"><span>' + name + '</span></li>';
    const draw = () => { panel.innerHTML = '<div role="menu"><ul role="listbox" aria-label="Audio Language">' + audio.map(name => option('Audio Language', name, name === current)).join('') +
      '</ul><ul role="listbox" aria-label="Subtitles">' + option('Subtitles', 'Subtitles Off', true) + option('Subtitles', 'American English', false) +
      '</ul><ul role="listbox" aria-label="Playback Rate">' + option('Playback Rate', '1x', true) + option('Playback Rate', '2x', false) + '</ul></div>'; };
    gear.addEventListener('click', () => { const open = gear.getAttribute('aria-expanded') === 'true'; gear.setAttribute('aria-expanded', String(!open)); if (open) panel.innerHTML = ''; else draw(); });
    panel.addEventListener('click', event => {
      const picked = event.target.closest('[aria-label="Audio Language"] [role="option"]');
      if (!picked) return;
      current = picked.textContent;
      draw();
    });
  </script></main>`;

test("a closed audio menu is reported as an audio control whose state the hidden copy must read", options(), async () => {
  for (const markup of [trackMenu(["Japanese", "English", "English [AD]", "Deutsch"]), settingsPanel()]) {
    await withPage(markup, async page => {
      const found = await detect(page);
      assert.equal(found.language, "unknown");
      assert.equal(found.stateUnclear, true);
      assert.equal(found.audioControl, true);
      assert.deepEqual(found.available, ["sub", "dub"]);
    });
  }
});

test("opens a track menu, chooses the viewer's language, and leaves subtitles and descriptive tracks alone", options(), async () => {
  await withPage(trackMenu(["Japanese", "English", "English [AD]", "Deutsch"]), async page => {
    const result = await select(page);
    assert.equal(result.ok, true);
    assert.equal(result.confirmed, true);
    assert.deepEqual(await page.evaluate(() => window.saved), ["English"]);
    assert.equal(await page.locator('[aria-label="Subtitle and closed caption selection"] [aria-checked="true"]').textContent(), "English");
    assert.equal((await detect(page)).language, "dub");
    // Asked again while the open menu shows the viewer's language: nothing is pressed.
    assert.equal((await select(page)).ok, true);
    assert.deepEqual(await page.evaluate(() => window.saved), ["English"]);
  });
});

test("finds the audio list inside a settings panel and remembers the choice once the panel closes", options(), async () => {
  await withPage(settingsPanel(), async page => {
    const result = await select(page);
    assert.equal(result.ok, true);
    assert.equal(result.confirmed, true);
    assert.equal(await page.locator('[aria-label="Audio Language"] [aria-selected="true"]').textContent(), "English");
    assert.equal(await page.locator('[aria-label="Subtitles"] [aria-selected="true"]').textContent(), "Subtitles Off");
    assert.equal(await page.locator('[aria-label="Playback Rate"] [aria-selected="true"]').textContent(), "1x");
    await page.click("#gear"); // close: the list leaves the page
    assert.equal(await page.locator('[role="listbox"]').count(), 0);
    const closed = await detect(page);
    assert.equal(closed.language, "dub");
    assert.equal(closed.audioControl, true);
  });
});

test("reads an open audio menu directly: original language is Sub, the viewer's is Dub", options(), async () => {
  await withPage(settingsPanel("Japanese"), async page => {
    await page.click("#gear");
    const found = await detect(page);
    assert.equal(found.language, "sub");
    assert.deepEqual(found.available, ["sub", "dub"]);
    assert.equal(found.stateUnclear, undefined);
  });
  await withPage(settingsPanel("English"), async page => {
    await page.click("#gear");
    assert.equal((await detect(page)).language, "dub");
  });
});

test("a closed menu that turns out to be on the viewer's language reports that instead of pressing anything", options(), async () => {
  await withPage(settingsPanel("English"), async page => {
    const result = await select(page);
    assert.equal(result.ok, false);
    assert.equal(result.already, true);
    assert.equal(await page.locator('[aria-label="Audio Language"] [aria-selected="true"]').textContent(), "English");
  });
  await withPage(trackMenu(["Japanese", "English"], "English"), async page => {
    const result = await select(page);
    assert.equal(result.already, true);
    assert.deepEqual(await page.evaluate(() => window.saved), []);
  });
});

test("an episode without the viewer's language has no Dub, and nothing is pressed", options(), async () => {
  await withPage(trackMenu(["Japanese", "Deutsch", "Français"]), async page => {
    const result = await select(page);
    assert.equal(result.ok, false);
    assert.match(result.error, /no audio in your language/);
    assert.deepEqual(await page.evaluate(() => window.saved), []);
    const found = await detect(page);
    assert.equal(found.language, "sub");
    assert.deepEqual(found.available, ["sub"]);
  });
});

test("Dub follows the browser's language, not English", options(), async () => {
  await withPage(trackMenu(["Japanese", "English", "Deutsch", "Deutsch [AD]"]), async page => {
    assert.equal((await select(page)).ok, true);
    assert.deepEqual(await page.evaluate(() => window.saved), ["Deutsch"]);
  }, "de-DE");
});

test("a settings menu with no audio choice is closed again and reported, not guessed at", options(), async () => {
  const markup = `<main>${player}<div class="player-controls"><button id="settings" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Player Settings"></button></div><div id="pop"></div>
    <script>
      window.clicks = 0;
      settings.addEventListener('click', () => { window.clicks += 1; pop.innerHTML = '<div role="menu" aria-label="Quality"><div role="menuitemradio" aria-checked="true">Highest</div><div role="menuitemradio" aria-checked="false">Low</div></div>'; });
      pop.addEventListener('click', () => { window.changed = true; });
    </script></main>`;
  await withPage(markup, async page => {
    const result = await select(page);
    assert.equal(result.ok, false);
    assert.match(result.error, /no audio language choice/);
    assert.equal(await page.evaluate(() => window.changed), undefined);
  });
});

test("ordinary Sub/Dub controls still win over a settings button beside them", options(), async () => {
  const markup = `<main>${player}
    <div role="radiogroup"><button type="button" role="radio" aria-checked="true">Sub</button><button type="button" role="radio" aria-checked="false">Dub</button></div>
    <button type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Settings"></button></main>`;
  await withPage(markup, async page => {
    const found = await detect(page);
    assert.equal(found.language, "sub");
    assert.equal(found.audioControl, undefined);
    assert.equal(found.stateUnclear, undefined);
  });
});

test("a site-language menu or a named audio control outside the player is not an audio control", options(), async () => {
  const markup = `<main>${player}<div role="button" aria-haspopup="listbox" aria-expanded="false" aria-label="App Language">English</div></main>
    <footer><div role="button" aria-haspopup="listbox" aria-expanded="false" aria-label="App Language">English</div>
    <button type="button" aria-haspopup="menu" aria-label="Audio settings"></button></footer>`;
  await withPage(markup, async page => {
    const found = await detect(page);
    assert.equal(found.audioControl, undefined);
    assert.equal(found.language, "unknown");
    assert.deepEqual(found.available, []);
  });
});

test("the audio button counts while the player's control bar is hidden", options(), async () => {
  const markup = `<main>${player}<div id="bar" class="player-controls" style="visibility:hidden;opacity:0">
    <button type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Audio and subtitle language options"></button></div></main>`;
  await withPage(markup, async page => {
    const found = await detect(page);
    assert.equal(found.audioControl, true);
    assert.equal(found.stateUnclear, true);
  });
});

test("reports what the page says where its player is, and ignores site-wide dialogs", options(), async () => {
  const markup = `<main><div id="player-container">
      <div role="dialog" data-testid="error-overlay"><h2>Stream Limit Reached</h2><p>Continue watching on this device by stopping an existing stream.</p><button type="button">Try Again</button></div>
    </div></main>
    <div role="dialog" aria-label="Cookies">We use cookies to improve your experience. <button type="button">Accept</button></div>
    <div class="video-wrap"><div role="alert" hidden>An old, hidden message that no longer applies.</div></div>`;
  await withPage(markup, async page => {
    assert.deepEqual(await page.evaluate(() => window.__languageDetectionEngine.pageNotices(document)),
      ["Stream Limit Reached Continue watching on this device by stopping an existing stream."]);
  });
});
