// The reload offer: a small card SubView shows on the visible tab while a new
// hidden copy has to wait (see COPY_COOLDOWN_MS in auto-dub.ts). Reloading the
// tab makes it a new playback, and then nothing has to wait. The popup shows
// the same offer, but the viewer is looking at the video, not at the popup.

/**
 * Runs in the visible tab (the extension's own world there), so it must not
 * reference anything outside itself.
 */
function renderOffer(until: number): void {
  type Offer = { until: number; stop(): void };
  const marks = globalThis as unknown as { __subviewReloadOffer?: Offer };
  // Already showing, or closed by the viewer, for this same wait.
  if (marks.__subviewReloadOffer?.until === until) return;
  marks.__subviewReloadOffer?.stop();

  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  // A constructed sheet: a page's own rules about inline styles don't apply to it.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .card { box-sizing: border-box; width: 300px; padding: 12px 14px; border: 2.5px solid #111; background: #fffaf0;
      box-shadow: 4px 4px 0 #111; color: #111; font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    b { color: #ff3b6b; font-weight: 900; letter-spacing: 0.02em; }
    p { margin: 4px 0 0; }
    .row { display: flex; gap: 8px; margin-top: 10px; }
    button { cursor: pointer; border: 2.5px solid #111; color: #111; font: 900 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .go { flex: 1; padding: 8px 10px; background: #ffe14d; box-shadow: 2px 2px 0 #111; }
    .always { padding: 8px 10px; background: #fff; }
    .close { padding: 0 2px; border: 0; background: none; font-size: 16px; }
    button:focus-visible { outline: 3px solid #ff3b6b; outline-offset: 2px; }
  `);
  root.adoptedStyleSheets = [sheet];

  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  };
  const card = make("div", "card", "");
  card.setAttribute("role", "alertdialog");
  card.setAttribute("aria-label", "SubView: reload this tab to start Dub now");
  const top = make("div", "top", "");
  const title = make("b", "", "SubView");
  const close = make("button", "close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Not now");
  top.append(title, close);
  const row = make("div", "row", "");
  const go = make("button", "go", "Reload now");
  go.type = "button";
  const always = make("button", "always", "Always reload");
  always.type = "button";
  always.title = "From now on SubView reloads this site's tab by itself when Dub needs it. You can turn that off in SubView's popup.";
  row.append(go, always);
  card.append(top, make("p", "", "Reload your tab and Dub starts right away."), row);
  root.append(card);

  // A fullscreen player hides everything outside itself, so the card goes inside it.
  const place = () => {
    const full = document.fullscreenElement;
    const parent = full && !/^(VIDEO|IFRAME)$/.test(full.tagName) ? full : document.documentElement;
    if (host.parentNode !== parent) parent.append(host);
  };
  // Nothing left to offer once the wait is over; the worker normally removes the card first.
  const tick = () => { if (Date.now() > until + 3_000) offer.stop(); };
  const timer = setInterval(tick, 1000);
  const offer: Offer = {
    until,
    stop() {
      clearInterval(timer);
      document.removeEventListener("fullscreenchange", place);
      host.remove();
    },
  };
  marks.__subviewReloadOffer = offer;
  const answer = (alwaysReload: boolean) => {
    offer.stop();
    void chrome.runtime.sendMessage({ type: "AUTO_DUB_RELOAD", always: alwaysReload }).catch(() => undefined);
  };
  // Only the viewer's own click counts, never one the page's scripts made up.
  go.addEventListener("click", event => { if (event.isTrusted) answer(false); });
  always.addEventListener("click", event => { if (event.isTrusted) answer(true); });
  close.addEventListener("click", event => { if (event.isTrusted) offer.stop(); }); // Stays closed for this wait.
  document.addEventListener("fullscreenchange", place);
  place();
}

/** Runs in the visible tab, like renderOffer. */
function removeOffer(): void {
  const marks = globalThis as unknown as { __subviewReloadOffer?: { stop(): void } };
  marks.__subviewReloadOffer?.stop();
  delete marks.__subviewReloadOffer;
}

/** Show the offer on the tab's page; `until` is when the wait ends by itself (epoch ms). */
export async function offerReload(tabId: number, until: number): Promise<void> {
  try { await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: renderOffer, args: [until] }); }
  catch { /* A page SubView can't draw on still has the offer in the popup. */ }
}

export async function withdrawReloadOffer(tabId: number): Promise<void> {
  try { await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: removeOffer }); }
  catch { /* The tab closed or moved on: nothing left to remove. */ }
}

export async function reloadTab(tabId: number): Promise<void> {
  await chrome.tabs.reload(tabId);
}
