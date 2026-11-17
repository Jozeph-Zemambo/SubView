import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const detectorPath = fileURLToPath(new URL("../src/content/language-detection.ts", import.meta.url));
const { outputFiles: [{ text: detectorScript }] } = await build({
  entryPoints: [detectorPath],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "__languageDetectionEngine",
  target: "es2022",
});

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/content/content-entry.ts", import.meta.url))],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  write: false,
});
const contentEntryScript = outputFiles[0].text;

let browser;
let launchError;

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    channel: process.env.CHROMIUM_PATH ? undefined : "chromium",
    headless: true,
  });
} catch (error) {
  launchError = error;
}

after(async () => {
  await browser?.close();
});

function testOptions() {
  return launchError
    ? { skip: `Chromium is unavailable: ${launchError instanceof Error ? launchError.message : String(launchError)}` }
    : undefined;
}

async function withPage(markup, callback) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent(`<!doctype html><base href="https://fixture.test/watch/episode">${markup}`);
    await page.addScriptTag({ content: detectorScript });
    return await callback(page);
  } finally {
    await context.close();
  }
}

function selectDub(page) {
  return page.evaluate(() => window.__languageDetectionEngine.selectDub(document));
}

test("selects Sub safely when a duplicate remembers Dub", testOptions(), async () => {
  await withPage(`<main><video style="width:320px;height:180px"></video>
    <select aria-label="Language"><option value="sub">Sub</option><option value="dub" selected>Dub</option></select></main>`, async page => {
    assert.deepEqual(await page.evaluate(() => window.__languageDetectionEngine.selectSub(document)), { ok: true });
    assert.equal(await page.getByLabel('Language').inputValue(), 'sub');
    assert.deepEqual(await selectDub(page), { ok: true });
    assert.equal(await page.getByLabel('Language').inputValue(), 'dub');
  });
});

test("selects one native Dub option and emits input/change without navigation", testOptions(), async () => {
  await withPage(`
    <main>
      <video style="display:block;width:320px;height:180px"></video>
      <label for="audio">Audio language</label>
      <select id="audio" aria-label="Audio language" style="opacity:0;position:absolute;left:-10000px;top:-10000px">
        <option value="sub" selected>Sub</option>
        <option value="https://fixture.test/media/episode-dub.m3u8">Dub</option>
      </select>
    </main>
  `, async page => {
    const result = await page.evaluate(() => {
      const select = document.querySelector("#audio");
      window.__selectEvents = [];
      select.addEventListener("input", () => window.__selectEvents.push("input"));
      select.addEventListener("change", () => window.__selectEvents.push("change"));
      return window.__languageDetectionEngine.selectDub(document);
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(await page.locator("#audio").inputValue(), "https://fixture.test/media/episode-dub.m3u8");
    assert.deepEqual(await page.evaluate(() => window.__selectEvents), ["input", "change"]);
    assert.equal(page.url(), "about:blank");
  });
});

test("activates a unique semantic tab or radio control, but never a Dub link", testOptions(), async () => {
  await withPage(`
    <main>
      <video style="display:block;width:320px;height:180px"></video>
      <div role="tablist" aria-label="Audio language">
        <button id="sub" type="button" role="tab" aria-selected="true">Sub</button>
        <button id="dub" type="button" role="tab" aria-selected="false">Dub</button>
      </div>
    </main>
  `, async page => {
    await page.evaluate(() => {
      window.__dubClicks = 0;
      document.querySelector("#dub").addEventListener("click", () => {
        window.__dubClicks += 1;
        document.querySelector("#sub").setAttribute("aria-selected", "false");
        document.querySelector("#dub").setAttribute("aria-selected", "true");
      });
    });
    assert.deepEqual(await selectDub(page), { ok: true });
    assert.equal(await page.evaluate(() => window.__dubClicks), 1);
    assert.equal(await page.locator("#dub").getAttribute("aria-selected"), "true");
  });

  await withPage(`
    <main>
      <video style="display:block;width:320px;height:180px"></video>
      <fieldset>
        <legend>Audio language</legend>
        <label><input id="sub" type="radio" name="audio" value="sub" checked>Sub</label>
        <label><input id="dub" type="radio" name="audio" value="dub">Dub</label>
      </fieldset>
    </main>
  `, async page => {
    assert.deepEqual(await selectDub(page), { ok: true });
    assert.equal(await page.locator("#dub").isChecked(), true);
    assert.equal(await page.locator("#sub").isChecked(), false);
  });

  await withPage(`
    <main>
      <video style="display:block;width:320px;height:180px"></video>
      <div role="tablist" aria-label="Audio language">
        <button id="sub" type="button" role="tab" aria-selected="true">Sub</button>
        <a id="dub" role="tab" href="/dub-episode">Dub</a>
      </div>
    </main>
  `, async page => {
    await page.evaluate(() => {
      window.__dubClicks = 0;
      document.querySelector("#dub").addEventListener("click", () => window.__dubClicks += 1);
    });
    const result = await selectDub(page);
    assert.equal(result.ok, false);
    assert.equal(await page.evaluate(() => window.__dubClicks), 0);
    assert.equal(page.url(), "about:blank");
    assert.equal(await page.locator("#sub").getAttribute("aria-selected"), "true");
  });

  await withPage(`
    <main>
      <video style="display:block;width:320px;height:180px"></video>
      <form id="player-form">
        <div role="tablist" aria-label="Audio language">
          <button id="sub" role="tab" aria-selected="true">Sub</button>
          <button id="dub" role="tab" aria-selected="false">Dub</button>
        </div>
      </form>
    </main>
  `, async page => {
    await page.evaluate(() => {
      window.__submits = 0;
      document.querySelector("#player-form").addEventListener("submit", event => {
        event.preventDefault();
        window.__submits += 1;
      });
    });
    const result = await selectDub(page);
    assert.equal(result.ok, false);
    assert.equal(await page.evaluate(() => window.__submits), 0);
    assert.equal(await page.locator("#dub").getAttribute("aria-selected"), "false");
  });
});

test("is a no-op when already Dub and fails closed for unknown or multiple controls", testOptions(), async () => {
  await withPage(`
    <main>
      <video style="display:block;width:320px;height:180px"></video>
      <select id="audio" aria-label="Language">
        <option value="sub">Sub</option>
        <option value="dub" selected>Dub</option>
      </select>
    </main>
  `, async page => {
    const result = await page.evaluate(() => {
      const select = document.querySelector("#audio");
      window.__selectEvents = 0;
      select.addEventListener("input", () => window.__selectEvents += 1);
      select.addEventListener("change", () => window.__selectEvents += 1);
      return window.__languageDetectionEngine.selectDub(document);
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(await page.evaluate(() => window.__selectEvents), 0);
  });

  await withPage(`
    <main>
      <video style="display:block;width:320px;height:180px"></video>
      <select id="audio" aria-label="Language">
        <option value="choose" selected>Choose audio</option>
        <option value="sub">Sub</option>
        <option value="dub">Dub</option>
      </select>
    </main>
  `, async page => {
    const result = await selectDub(page);
    assert.equal(result.ok, false);
    assert.equal(await page.locator("#audio").inputValue(), "choose");
  });

  await withPage(`
    <main>
      <video style="display:block;width:320px;height:180px"></video>
      <div role="tablist" aria-label="Audio one">
        <button type="button" role="tab" aria-selected="true">Sub</button>
        <button type="button" role="tab" aria-selected="false">Dub</button>
      </div>
      <div role="tablist" aria-label="Audio two">
        <button type="button" role="tab" aria-selected="false">Sub</button>
        <button type="button" role="tab" aria-selected="false">Dub</button>
      </div>
    </main>
  `, async page => {
    const result = await selectDub(page);
    assert.equal(result.ok, false);
    assert.equal(await page.locator("[role=tablist]").nth(0).locator("button").nth(1).getAttribute("aria-selected"), "false");
  });
});

test("content entry authorizes both language selection commands only from the extension worker", testOptions(), async () => {
  await withPage(`
    <main>
      <video style="display:block;width:320px;height:180px"></video>
      <select id="audio" aria-label="Language">
        <option value="sub" selected>Sub</option>
        <option value="dub">Dub</option>
      </select>
    </main>
  `, async page => {
    await page.evaluate(() => {
      globalThis.chrome = {
        runtime: {
          id: "fixture-extension",
          onMessage: {
            addListener(listener) {
              window.__contentListener = listener;
            },
          },
          sendMessage() {
            return Promise.resolve();
          },
        },
      };
    });
    await page.addScriptTag({ content: contentEntryScript });

    const ask = sender => page.evaluate(senderValue => new Promise(resolve => {
      window.__contentListener({ type: "SELECT_DUB_CONTENT" }, senderValue, resolve);
    }), sender);
    assert.deepEqual(await ask({ id: "fixture-extension", tab: { id: 11 } }), {
      ok: false,
      error: "Unauthorized content request",
    });
    assert.equal(await page.locator("#audio").inputValue(), "sub");
    assert.deepEqual(await ask({ id: "fixture-extension" }), { ok: true });
    assert.equal(await page.locator("#audio").inputValue(), "dub");
    const askSub = sender => page.evaluate(senderValue => new Promise(resolve => {
      window.__contentListener({ type: "SELECT_SUB_CONTENT" }, senderValue, resolve);
    }), sender);
    assert.equal((await askSub({ id: "fixture-extension", tab: { id: 11 } })).ok, false);
    assert.equal(await page.locator("#audio").inputValue(), "dub");
    assert.deepEqual(await askSub({ id: "fixture-extension" }), { ok: true });
    assert.equal(await page.locator("#audio").inputValue(), "sub");
  });
});

test("restores an exact accessible Provider option without choosing a similar label", testOptions(), async () => {
  await withPage(`<main><video style="width:320px;height:180px"></video>
    <select aria-label="Provider"><option>Remembered</option><option value="wanted">Requested · Sub</option><option>Requested · Dub</option></select></main>`, async page => {
    const result=await page.evaluate(()=> {
      window.events=[];
      const select=document.querySelector('select');
      for(const event of ['input','change']) select.addEventListener(event,()=>window.events.push(event));
      return window.__languageDetectionEngine.selectProvider(document,'Requested · Sub');
    });
    assert.deepEqual(result,{ok:true});
    assert.equal(await page.getByLabel('Provider').inputValue(),'wanted');
    assert.deepEqual(await page.evaluate(()=>window.events),['input','change']);
    assert.equal((await page.evaluate(()=>window.__languageDetectionEngine.selectProvider(document,'Requested'))).ok,false);
  });
});

test("provider restoration rejects disabled, absent and ambiguous controls", testOptions(), async () => {
  for (const markup of [
    '<select aria-label="Server"><option>Old</option><option disabled>Wanted</option></select>',
    '<select aria-label="Server"><option>Old</option></select>',
    '<select aria-label="Server"><option>Old</option><option>Wanted</option></select><select aria-label="Provider"><option>Old</option><option>Wanted</option></select>',
  ]) {
    await withPage(`<main><video style="width:320px;height:180px"></video>${markup}</main>`,async page=>{
      assert.equal((await page.evaluate(()=>window.__languageDetectionEngine.selectProvider(document,'Wanted'))).ok,false);
      assert.equal(await page.locator('select').first().inputValue(),'Old');
    });
  }
});

test("clicks Dub in a styled-only button pair and refuses when the styling is ambiguous", testOptions(), async () => {
  const markup = (sub, dub) => `<main><video style="display:block;width:320px;height:180px"></video>
    <div id="switch"><button type="button" class="${sub}">Sub</button><button type="button" class="${dub}">Dub</button></div>
    <script>
      for (const button of document.querySelectorAll('#switch button')) button.addEventListener('click', () => {
        for (const other of document.querySelectorAll('#switch button')) other.className = other === button ? 'bg-primary' : 'text-muted-foreground';
      });
    </script></main>`;
  await withPage(markup("bg-primary", "text-muted-foreground"), async page => {
    assert.deepEqual(await selectDub(page), { ok: true });
    assert.equal(await page.locator('#switch button', { hasText: 'Dub' }).getAttribute('class'), 'bg-primary');
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.detectLanguage(document))).language, 'dub');
    assert.deepEqual(await selectDub(page), { ok: true });
  });
  await withPage(markup("active", "active"), async page => {
    assert.equal((await selectDub(page)).ok, false);
  });
});

test("opens an accessible popup menu and chooses its Dub option", testOptions(), async () => {
  await withPage(`<main><video style="display:block;width:320px;height:180px"></video>
    <div id="trigger" role="button" aria-haspopup="listbox" aria-owns="list-1"><label>Sub/Dub</label><span id="value">Japanese (SUB)</span></div>
    <div id="menu"></div>
    <script>
      // Options exist only while open, like Vuetify.
      document.getElementById('trigger').addEventListener('click', () => {
        document.getElementById('menu').innerHTML = '<div role="listbox" id="list-1"><div role="option" aria-selected="true">Japanese (SUB)</div><div role="option" aria-selected="false">English (DUB)</div><div role="option">Español (Latina)</div></div>';
        for (const option of document.querySelectorAll('[role=option]')) option.addEventListener('click', () => {
          document.getElementById('value').textContent = option.textContent;
          document.getElementById('menu').innerHTML = '';
        });
      });
    </script></main>`, async page => {
    const chosen = await page.evaluate(() => window.__languageDetectionEngine.selectDubInteractive(document));
    assert.equal(chosen.ok, true);
    assert.equal(typeof chosen.at, 'number');
    assert.equal(await page.locator('#value').textContent(), 'English (DUB)');
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.detectLanguage(document))).language, 'dub');
  });
});

test("clicks the first Dub-row server, and lists and switches Dub servers", testOptions(), async () => {
  await withPage(`<main><video style="display:block;width:320px;height:180px"></video>
    <div id="servers">
      <div><span>SUB:</span><div><button class="srv active">HD-1</button><button class="srv">HD-2</button></div></div>
      <div><span>DUB:</span><div><button class="srv">HD-1</button><button class="srv">HD-2</button></div></div>
    </div>
    <script>
      for (const button of document.querySelectorAll('.srv')) button.addEventListener('click', () => {
        for (const other of document.querySelectorAll('.srv')) other.classList.toggle('active', other === button);
      });
    </script></main>`, async page => {
    assert.deepEqual(await page.evaluate(() => window.__languageDetectionEngine.selectDubInteractive(document)), { ok: true });
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.detectLanguage(document))).language, 'dub');
    assert.deepEqual(await page.evaluate(() => window.__languageDetectionEngine.listProviders(document)),
      { ok: true, options: [{ label: 'HD-1', selected: true }, { label: 'HD-2', selected: false }] });
    assert.deepEqual(await page.evaluate(() => window.__languageDetectionEngine.selectProvider(document, 'HD-2')), { ok: true });
    const active = await page.evaluate(() => [...document.querySelectorAll('.srv.active')].map(b => b.closest('div').previousElementSibling.textContent + b.textContent));
    assert.deepEqual(active, ['DUB:HD-2']);
  });
});

test("force clicks Dub when no control says which language is selected", testOptions(), async () => {
  await withPage(`<main><video style="display:block;width:320px;height:180px"></video>
    <div><button id="sub" class="x">Sub</button><button id="dub" class="y">Dub</button></div>
    <script>document.getElementById('dub').addEventListener('click', () => { document.body.dataset.clicked = 'dub'; });</script></main>`, async page => {
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.selectDubInteractive(document))).ok, false);
    assert.deepEqual(await page.evaluate(() => window.__languageDetectionEngine.selectDubInteractive(document, true)), { ok: true });
    assert.equal(await page.evaluate(() => document.body.dataset.clicked), 'dub');
  });
});

test("opens a plain language menu button and chooses Dub from its list", testOptions(), async () => {
  await withPage(`<main><video style="display:block;width:480px;height:270px"></video>
    <div><button id="menu"><span>Subbed</span> ▾</button><ul id="list" hidden><li>Subbed</li><li id="dub">Dubbed</li></ul></div>
    <script>
      document.getElementById('menu').addEventListener('click', () => { document.getElementById('list').hidden = false; });
      document.getElementById('dub').addEventListener('click', () => { document.querySelector('#menu span').textContent = 'Dubbed'; document.getElementById('list').hidden = true; });
    </script></main>`, async page => {
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.detectLanguage(document))).language, 'sub');
    const chosen = await page.evaluate(() => window.__languageDetectionEngine.selectDubInteractive(document));
    assert.equal(chosen.ok, true);
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.detectLanguage(document))).language, 'dub');
  });
});

test("switches a styled Soft Sub / Dub pair of non-navigating links", testOptions(), async () => {
  await withPage(`<main><video style="display:block;width:480px;height:270px"></video>
    <div class="server-type"><a class="tab active">Soft Sub</a><a class="tab" href="#">Dub</a><a href="/dub-page">Dub page</a></div>
    <script>for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', event => {
      event.preventDefault();
      for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
    });</script></main>`, async page => {
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.detectLanguage(document))).language, 'sub');
    assert.deepEqual(await page.evaluate(() => window.__languageDetectionEngine.selectDub(document)), { ok: true });
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.detectLanguage(document))).language, 'dub');
    assert.equal(page.url().endsWith('/dub-page'), false);
  });
});

test("lists and switches a plain SERVER: button row when the language switch is separate", testOptions(), async () => {
  await withPage(`<main><video style="display:block;width:480px;height:270px"></video>
    <div><span>AUDIO:</span><button class="lang active">SUB</button><button class="lang">DUB</button></div>
    <div><span>SERVER:</span><button class="srv active">CloudOne (HD-1)</button><button class="srv">PlayTwo</button><button class="srv">StreamThree</button></div>
    <script>for (const b of document.querySelectorAll('.srv')) b.addEventListener('click', () => {
      for (const o of document.querySelectorAll('.srv')) o.classList.toggle('active', o === b);
    });</script></main>`, async page => {
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.detectLanguage(document))).provider, 'CloudOne (HD-1)');
    assert.deepEqual(await page.evaluate(() => window.__languageDetectionEngine.listProviders(document)), { ok: true, options: [
      { label: 'CloudOne (HD-1)', selected: true }, { label: 'PlayTwo', selected: false }, { label: 'StreamThree', selected: false }] });
    assert.deepEqual(await page.evaluate(() => window.__languageDetectionEngine.selectProvider(document, 'PlayTwo')), { ok: true });
    assert.equal(await page.locator('.srv.active').textContent(), 'PlayTwo');
  });
});

test("in a hidden copy, re-opens the playing episode from a list the Dub menu filtered", testOptions(), async () => {
  await withPage(`<main><video style="display:block;width:480px;height:270px"></video>
    <div id="trigger" role="button" aria-haspopup="listbox" aria-owns="list-1"><label>Sub/Dub</label><span id="value">Japanese (SUB)</span></div>
    <div id="menu"></div>
    <div id="episodes"><div class="card" tabindex="0"><span>EP 01</span> Playing</div><div class="card" tabindex="0"><span>EP 02</span></div></div>
    <script>
      document.getElementById('trigger').addEventListener('click', () => {
        document.getElementById('menu').innerHTML = '<div role="listbox" id="list-1"><div role="option" aria-selected="true">Japanese (SUB)</div><div role="option">English (DUB)</div></div>';
        document.querySelectorAll('[role=option]')[1].addEventListener('click', () => {
          document.getElementById('value').textContent = 'English (DUB)';
          document.getElementById('menu').innerHTML = '';
          document.getElementById('episodes').innerHTML = '<div class="card" tabindex="0"><span>EP 01</span></div><div class="card" tabindex="0"><span>EP 02</span></div>';
          document.querySelectorAll('.card').forEach((card, i) => card.addEventListener('click', () => { document.body.dataset.opened = String(i + 1); }));
        });
      });
    </script></main>`, async page => {
    await page.evaluate(() => window.__languageDetectionEngine.useLayoutIndependentVisibility());
    const chosen = await page.evaluate(() => window.__languageDetectionEngine.selectDubInteractive(document));
    assert.equal(chosen.ok, true);
    assert.equal(await page.evaluate(() => document.body.dataset.opened), '1');
  });
});

test("server rows with icon prefixes, quality suffixes and clickable spans", testOptions(), async () => {
  await withPage(`<main><video style="display:block;width:480px;height:270px"></video>
    <div><span><span>CC</span> Sub:</span><span class="srv active" onclick="pick(this)">Kappa</span><span class="srv" onclick="pick(this)">Omega</span></div>
    <div><span>DUB FHD</span><span class="srv" onclick="pick(this)">Kappa</span><span class="srv" onclick="pick(this)">Omega</span></div>
    <script>function pick(el) { for (const o of document.querySelectorAll('.srv')) o.classList.toggle('active', o === el); }</script></main>`, async page => {
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.detectLanguage(document))).language, 'sub');
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.selectDubInteractive(document))).ok, true);
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.detectLanguage(document))).language, 'dub');
  });
});

test("review guards: catalogue buttons, native selects first, base targets, stale or fractional episode lists", testOptions(), async () => {
  // A lone "Dub 24" catalogue button is not a language menu.
  await withPage(`<main><video style="display:block;width:480px;height:270px"></video><button>Dub 24</button></main>`, async page => {
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.detectLanguage(document))).language, 'unknown');
  });
  // A native Sub/Dub select wins over a decorative "Subbed ▾" button.
  await withPage(`<main><video style="display:block;width:480px;height:270px"></video>
    <select aria-label="Language"><option value="sub" selected>Sub</option><option value="dub">Dub</option></select>
    <button class="dropdown-trigger">Subbed ▾</button></main>`, async page => {
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.selectDubInteractive(document))).ok, true);
    assert.equal(await page.getByLabel('Language').inputValue(), 'dub');
  });
  // In a hidden copy, a same-site link under <base target="_blank"> would leave the copy.
  await withPage(`<base target="_blank"><main><video style="display:block;width:480px;height:270px"></video>
    <div><a class="tab active" href="/watch/sub">Sub</a><a class="tab" href="/watch/dub">Dub</a></div></main>`, async page => {
    await page.evaluate(() => window.__languageDetectionEngine.useLayoutIndependentVisibility());
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.selectDubInteractive(document))).ok, false);
  });
});

test("episode follow waits for a re-rendered list and keeps fractional episodes apart", testOptions(), async () => {
  await withPage(`<main><video style="display:block;width:480px;height:270px"></video>
    <div id="trigger" role="button" aria-haspopup="listbox" aria-owns="list-1"><label>Sub/Dub</label><span id="value">Japanese (SUB)</span></div>
    <div id="menu"></div>
    <div id="episodes"><a class="card" href="#e1" aria-current="page"><span>EP 1.5</span></a><a class="card" href="#e2"><span>EP 2</span></a></div>
    <script>
      document.getElementById('trigger').addEventListener('click', () => {
        document.getElementById('menu').innerHTML = '<div role="listbox" id="list-1"><div role="option" aria-selected="true">Japanese (SUB)</div><div role="option">English (DUB)</div></div>';
        document.querySelectorAll('[role=option]')[1].addEventListener('click', () => {
          document.getElementById('value').textContent = 'English (DUB)';
          document.getElementById('menu').innerHTML = '';
          // The Dub list has episode 1 but not 1.5.
          setTimeout(() => {
            document.getElementById('episodes').innerHTML = '<a class="card" href="#d1"><span>EP 1</span></a><a class="card" href="#d2"><span>EP 2</span></a>';
            document.querySelectorAll('.card').forEach(card => card.addEventListener('click', () => { document.body.dataset.opened = card.getAttribute('href'); }));
          }, 300);
        });
      });
      document.querySelectorAll('.card').forEach(card => card.addEventListener('click', () => { document.body.dataset.opened = card.getAttribute('href'); }));
    </script></main>`, async page => {
    await page.evaluate(() => window.__languageDetectionEngine.useLayoutIndependentVisibility());
    assert.equal((await page.evaluate(() => window.__languageDetectionEngine.selectDubInteractive(document))).ok, true);
    assert.equal(await page.evaluate(() => document.body.dataset.opened ?? null), null);
  });
});
