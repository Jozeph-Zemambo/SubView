import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const sourcePath = fileURLToPath(new URL("../src/content/language-detection.ts", import.meta.url));
const { outputFiles: [{ text: engineScript }] } = await build({
  entryPoints: [sourcePath],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "__languageDetectionEngine",
  target: "es2022",
});

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
    await page.addScriptTag({ content: engineScript });
    return await callback(page);
  } finally {
    await context.close();
  }
}

async function detect(page) {
  return page.evaluate(() => window.__languageDetectionEngine.detectLanguage(document));
}

test("detects opacity-zero offscreen native language and provider selects", testOptions(), async () => {
  await withPage(`
    <main>
      <div id="player"><iframe title="player frame" src="about:blank"></iframe></div>
      <div id="overlay" style="position:absolute;left:-10000px;top:-10000px">
        <select id="language" aria-label="Language" style="display:block;visibility:visible;opacity:0">
          <option value="sub">Sub</option>
          <option value="dub" selected>Dub</option>
        </select>
        <select id="provider" aria-label="Provider" style="display:block;visibility:visible;opacity:0">
          <option value="beta:ssub">beta · s-sub</option>
          <option value="delta:ssub" selected>delta · s-sub</option>
        </select>
      </div>
    </main>
  `, async page => {
    const result = await detect(page);
    assert.equal(result.language, "dub");
    assert.deepEqual(result.available, ["sub", "dub"]);
    assert.equal(result.provider, "delta · s-sub");
    assert.deepEqual(result.dubCandidates, []);
  });
});

test("uses selected semantic tabs and radio controls, not prose", testOptions(), async () => {
  await withPage(`
    <h1>Dubbed catalogue title</h1>
    <p>This description mentions sub and dub but has no selected state.</p>
    <section aria-label="Audio choices">
      <iframe title="player frame" src="about:blank"></iframe>
      <div role="tablist">
        <button role="tab" aria-selected="false">Sub</button>
        <a role="tab" aria-selected="true" aria-label="Dub" title="Dub episode" href="/watch/dub-episode.mp4">Dub episode</a>
      </div>
    </section>
  `, async page => {
    const result = await detect(page);
    assert.equal(result.language, "dub");
    assert.deepEqual(result.available, ["sub", "dub"]);
    assert.deepEqual(result.dubCandidates, [{
      url: "https://fixture.test/watch/dub-episode.mp4",
      kind: "media",
      label: "Dub",
    }]);
  });

  await withPage(`
    <iframe title="player frame" src="about:blank"></iframe>
    <div role="radiogroup" aria-label="Audio">
      <span role="radio" aria-checked="false">Sub</span>
      <span role="radio" aria-checked="true">Dub</span>
    </div>
  `, async page => {
    const result = await detect(page);
    assert.equal(result.language, "dub");
    assert.deepEqual(result.available, ["sub", "dub"]);
  });
});

test("does not treat unselected catalogue links or prose as language detection", testOptions(), async () => {
  await withPage(`
    <h1>Dubbed episode</h1>
    <p>Sub and dub versions are listed below.</p>
    <article class="catalogue-card"><a href="/dub.mp4">Dub</a></article>
  `, async page => {
    const result = await detect(page);
    assert.equal(result.language, "unknown");
    assert.deepEqual(result.available, []);
    assert.deepEqual(result.dubCandidates, []);
  });
});

test("surfaces only safe actual URLs and keeps plain dub option values out", testOptions(), async () => {
  await withPage(`
    <iframe title="player frame" src="about:blank"></iframe>
    <select aria-label="Language">
      <option value="sub" selected>Sub</option>
      <option value="https://fixture.test/media/dub.mp4">Dub</option>
      <option value="dub">Dub mirror without a URL</option>
    </select>
    <div role="tablist">
      <button role="tab" aria-selected="false">Sub</button>
      <a role="tab" aria-selected="false" aria-label="Dub" title="Dub page" href="/watch/dub-page">Dub page</a>
      <a role="tab" aria-selected="false" aria-label="Dub" title="Dub script" href="javascript:alert(1)">Dub script</a>
      <a role="tab" aria-selected="false" aria-label="Dub" title="Dub credentials" href="https://user:password@fixture.test/dub.mp4">Dub credentials</a>
    </div>
  `, async page => {
    const result = await detect(page);
    assert.equal(result.language, "sub");
    assert.deepEqual(result.dubCandidates, [
      {
        url: "https://fixture.test/media/dub.mp4",
        kind: "media",
        label: "Dub",
      },
      {
        url: "https://fixture.test/watch/dub-page",
        kind: "page",
        label: "Dub",
      },
    ]);
  });
});

test("returns unknown for conflicting selected controls", testOptions(), async () => {
  await withPage(`
    <iframe title="player frame" src="about:blank"></iframe>
    <select aria-label="Language">
      <option value="sub">Sub</option>
      <option value="dub" selected>Dub</option>
    </select>
    <div role="tablist">
      <button role="tab" aria-selected="true">Sub</button>
      <button role="tab" aria-selected="false">Dub</button>
    </div>
  `, async page => {
    const result = await detect(page);
    assert.equal(result.language, "unknown");
    assert.deepEqual(result.available, ["sub", "dub"]);
    assert.match(result.reason, /conflicting|ambiguous/i);
  });
});

test("watcher emits initially, reacts to events/mutations/navigation, deduplicates, and resumes after pagehide", testOptions(), async () => {
  await withPage(`
    <iframe title="player frame" src="about:blank"></iframe>
    <div role="tablist">
      <button id="sub" role="tab" aria-selected="true">Sub</button>
      <button id="dub" role="tab" aria-selected="false">Dub</button>
    </div>
    <select id="language" aria-label="Language">
      <option value="sub" selected>Sub</option>
      <option value="dub">Dub</option>
    </select>
  `, async page => {
    assert.equal(await page.evaluate(() => {
      window.__languageEvents = [];
      window.__stopLanguageObserver = window.__languageDetectionEngine.observeLanguage(
        document,
        result => window.__languageEvents.push(result),
      );
      return window.__languageEvents.length;
    }), 1);

    await page.evaluate(() => {
      document.querySelector("#language").value = "dub";
      document.querySelector("#sub").setAttribute("aria-selected", "false");
      document.querySelector("#dub").setAttribute("aria-selected", "true");
      document.querySelector("#language").dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#language").dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => window.__languageEvents.length === 2);
    assert.equal(await page.evaluate(() => window.__languageEvents.at(-1).language), "dub");

    await page.locator("#language").selectOption("dub");
    assert.equal(await page.evaluate(() => window.__languageEvents.length), 2);

    await page.evaluate(() => {
      document.querySelector("#sub").setAttribute("aria-selected", "false");
      document.querySelector("#dub").setAttribute("aria-selected", "true");
    });
    await page.waitForFunction(() => window.__languageEvents.length === 2);

    await page.evaluate(() => {
      location.hash = "changed";
    });
    await page.waitForFunction(() => window.__languageEvents.length === 3);
    assert.match(await page.evaluate(() => window.__languageEvents.at(-1).pageUrl), /#changed$/);

    await page.evaluate(() => {
      dispatchEvent(new Event("pagehide"));
      document.querySelector("#language").value = "sub";
      document.querySelector("#sub").setAttribute("aria-selected", "true");
      document.querySelector("#dub").setAttribute("aria-selected", "false");
      document.querySelector("#language").dispatchEvent(new Event("change", { bubbles: true }));
      dispatchEvent(new Event("pageshow"));
    });
    await page.waitForFunction(() => window.__languageEvents.length === 4);
    assert.equal(await page.evaluate(() => window.__languageEvents.at(-1).language), "sub");

    await page.evaluate(() => window.__stopLanguageObserver());
    await page.locator("#language").selectOption("dub");
    assert.equal(await page.evaluate(() => window.__languageEvents.length), 4);
  });
});

test("reads a styled-only Sub/Dub button pair, but not ties, hover classes or negations", testOptions(), async () => {
  const pair = (sub, dub) => `<main><video style="display:block;width:320px;height:180px"></video>
    <div class="switch"><button type="button" class="${sub}">Sub</button><button type="button" class="${dub}">Dub</button></div></main>`;
  const cases = [
    ["rounded bg-primary text-primary-foreground", "rounded text-muted-foreground hover:bg-white/5", "sub"],
    ["tab", "tab is-active", "dub"],
    ["tab active", "tab active", "unknown"],
    ["tab hover:active", "tab", "unknown"],
    ["tab inactive", "tab", "unknown"],
    ["tab non-selected", "tab", "unknown"],
    ["tab", "tab", "unknown"],
  ];
  for (const [sub, dub, expected] of cases) {
    await withPage(pair(sub, dub), async page => {
      assert.equal((await detect(page)).language, expected, `${sub} | ${dub}`);
    });
  }
});

test("explicit accessibility state wins over styled classes", testOptions(), async () => {
  await withPage(`<main><video style="display:block;width:320px;height:180px"></video>
    <div><button type="button" class="active" aria-pressed="false">Sub</button><button type="button" aria-pressed="true">Dub</button></div></main>`, async page => {
    assert.equal((await detect(page)).language, "dub");
  });
});

test("reads SUB:/DUB: server rows by the row holding the current server", testOptions(), async () => {
  const rows = (subClass, dubClass, extra = "") => `<main><video style="display:block;width:320px;height:180px"></video>
    <div class="servers">
      <div class="row"><span>SUB:</span><div><button class="${subClass}">HD-1</button><button class="srv">HD-2</button></div></div>
      <div class="row"><span><span>D</span> Dub:</span><div><button class="${dubClass}" ${extra}>HD-1</button><button class="srv">HD-2</button></div></div>
    </div></main>`;
  await withPage(rows("srv bg-primary", "srv"), async page => {
    const result = await detect(page);
    assert.equal(result.language, "sub");
    assert.deepEqual(result.available, ["sub", "dub"]);
    assert.equal(result.provider, "HD-1");
  });
  await withPage(rows("srv", "srv", 'aria-pressed="true"'), async page => {
    assert.equal((await detect(page)).language, "dub");
  });
  await withPage(rows("srv", "srv"), async page => {
    const result = await detect(page);
    assert.equal(result.language, "unknown");
    assert.equal(result.stateUnclear, true);
  });
});

test("reads a closed accessible popup menu from its displayed value and label", testOptions(), async () => {
  await withPage(`<main><video style="display:block;width:320px;height:180px"></video>
    <div role="button" aria-haspopup="listbox" aria-owns="list-1"><label>Sub/Dub</label><div>&#8203;Japanese (SUB)</div></div></main>`, async page => {
    const result = await detect(page);
    assert.equal(result.language, "sub");
    assert.deepEqual(result.available, ["sub", "dub"]);
  });
  // A popup that isn't about Sub/Dub (no Sub/Dub name) is ignored when closed.
  await withPage(`<main><video style="display:block;width:320px;height:180px"></video>
    <div role="combobox" aria-haspopup="listbox" aria-label="Sort">Sub</div></main>`, async page => {
    assert.equal((await detect(page)).language, "unknown");
  });
});

test("falls back to the language named in the page address", testOptions(), async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.route("https://fixture.test/**", route => route.fulfill({ contentType: "text/html", body: `<main><video style="display:block;width:320px;height:180px"></video>
      <div><button class="a">Sub</button><button class="b">Dub</button></div></main>` }));
    await page.goto("https://fixture.test/watch?ep=1&lang=sub");
    await page.addScriptTag({ content: engineScript });
    const result = await detect(page);
    assert.equal(result.language, "sub");
    assert.match(result.reason, /address/);
  } finally {
    await context.close();
  }
});

test("does not read episode lists under Sub/Dub labels as server rows", testOptions(), async () => {
  await withPage(`<main><video style="display:block;width:320px;height:180px"></video>
    <div><span>Sub</span><button class="active">EP 1</button><button>EP 2</button></div>
    <div><span>Dub</span><button>1</button><button>2</button></div></main>`, async page => {
    const result = await detect(page);
    assert.equal(result.language, "unknown");
    assert.deepEqual(result.available, []);
  });
});

test("explicit aria state, even false, disables styling inference", testOptions(), async () => {
  await withPage(`<main><video style="display:block;width:320px;height:180px"></video>
    <div><button aria-selected="false">Sub</button><button aria-selected="false" class="bg-primary">Dub</button></div></main>`, async page => {
    assert.notEqual((await detect(page)).language, "dub");
  });
});

// A page the size of a busy video site: thousands of elements, a thousand
// links and buttons, deep wrappers, one player. Detection reads it on every
// change, on the page's own main thread, so it must stay cheap.
test("reads a large page quickly and still finds its Sub/Dub switch", testOptions(), async () => {
  await withPage(`<main id="root"><video style="display:block;width:640px;height:360px"></video>
    <div role="tablist"><button role="tab" aria-selected="false">Sub</button><button role="tab" aria-selected="true">Dub</button></div>
    <div id="feed"></div></main>`, async page => {
    const timings = await page.evaluate(() => {
      const feed = document.querySelector("#feed");
      for (let i = 0; i < 1000; i += 1) {
        // Each card: a chain of wrappers (five deep), spans of text, and a link or a button.
        let parent = feed;
        for (let depth = 0; depth < 4; depth += 1) {
          const wrapper = document.createElement("div");
          wrapper.className = `card-${depth}`;
          parent.append(wrapper);
          parent = wrapper;
        }
        const title = document.createElement("span");
        title.textContent = `Video number ${i} with a longer title about something`;
        const meta = document.createElement("span");
        meta.textContent = `${i}K views · ${i % 12} months ago`;
        const control = document.createElement(i % 2 ? "a" : "button");
        if (i % 2) control.setAttribute("href", `/watch?v=${i}`);
        control.textContent = i % 3 ? `Open ${i}` : "Share";
        parent.append(title, meta, control);
      }
      const engine = window.__languageDetectionEngine;
      const runs = [];
      let result;
      for (let run = 0; run < 5; run += 1) {
        const started = performance.now();
        result = engine.detectLanguage(document);
        runs.push(performance.now() - started);
      }
      return { runs, language: result.language, available: result.available, elements: document.querySelectorAll("*").length };
    });
    assert.ok(timings.elements > 7000, `page has ${timings.elements} elements`);
    assert.equal(timings.language, "dub");
    assert.deepEqual(timings.available, ["sub", "dub"]);
    const median = [...timings.runs].sort((a, b) => a - b)[2];
    console.log(`detectLanguage on ${timings.elements} elements: median ${median.toFixed(1)} ms (runs: ${timings.runs.map(ms => ms.toFixed(1)).join(", ")})`);
    assert.ok(median < 50, `median ${median.toFixed(1)} ms`);
  });
});
