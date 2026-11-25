import type { AvailableLanguage, DubCandidate, LanguageDetection } from "../shared/language-detection";
import { languageFromUrl } from "../shared/dub-url";

const CONTROL = 'select,button,a,input[type="radio"],[role="tab"],[role="radio"],[role="button"]';
const PLAYER = 'video,iframe';
const EXCLUDED = 'nav,header,footer,aside,[role="navigation"],[role="search"],[role="complementary"]';
// Zero-width characters are layout padding (Vuetify puts one in every select).
const clean = (text: string | null | undefined) => (text ?? '').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();

function label(element: Element): string {
  const aria = clean(element.getAttribute('aria-label'));
  if (aria) return aria;
  const ids = element.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
  const labelled = clean(ids.map(id => element.ownerDocument.getElementById(id)?.textContent ?? '').join(' '));
  if (labelled) return labelled;
  if ('labels' in element) {
    const labels = (element as HTMLInputElement | HTMLSelectElement).labels;
    const named = clean(Array.from(labels ?? []).map(item => item.textContent).join(' '));
    if (named) return named;
  }
  return clean(element.textContent);
}

function language(text: string): AvailableLanguage | null {
  // Symbols (▾ arrows, • bullets, ★) decorate labels; only words count.
  const value = clean(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
    // An episode count after the label ("Dub 24") is a badge, not part of it.
    .replace(/\s+\d+$/, '');
  if (/^(?:(?:english|japanese|eng|jpn)\s+)?(?:(?:soft|hard)\s*)?(?:sub|subbed|subtitled|subtitles)(?:\s+(?:english|japanese|eng|jpn))?$/.test(value)) return 'sub';
  if (/^(?:(?:english|japanese|eng|jpn)\s+)?(?:dub|dubbed)(?:\s+(?:english|japanese|eng|jpn))?$/.test(value)) return 'dub';
  return null;
}

// Hosted pages (see hosted/hosted-agent.ts) can live in a document that never
// lays out, where every element has zero client rects. There, visibility comes
// from attributes and computed style alone.
let requireLayout = true;
export function useLayoutIndependentVisibility(): void {
  requireLayout = false;
}

function visible(element: Element): boolean {
  if (!element.isConnected || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  for (let item: Element | null = element; item; item = item.parentElement) {
    const style = view.getComputedStyle(item);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  // Transparent native selects often overlay a visible custom trigger. Opacity
  // and viewport intersection do not determine whether a control is available.
  return !requireLayout || element.getClientRects().length > 0;
}

/**
 * One reading of the page (a detection, a selection) asks "is there a player
 * near this control?" for every candidate control. Finding players means
 * visiting every element (shadow roots can't be found by selector), so within
 * one synchronous reading the page's players are found once and the answers
 * are reused. Nothing is kept between readings: the page changes in between.
 */
interface LocatedPlayer {
  player: Element;
  /** The player itself, or the outermost shadow host (in the page's own tree) it lives under. */
  anchor: Element;
}
interface ReadingCache {
  players: Map<Document, LocatedPlayer[]>;
  scopes: Map<Element, Element[]>;
  scopeHasPlayer: Map<Element, boolean>;
  visiblePlayers: Map<Element, boolean>;
  sole: Map<Document, boolean>;
  rowTexts: Map<Element, string | null>;
  serverRows: Map<Document, ServerRow[]>;
}
let reading: ReadingCache | null = null;

/** Run synchronous work as one reading of the page; nested calls share the outer reading. */
function oneReading<T>(work: () => T): T {
  if (reading) return work();
  reading = {
    players: new Map(), scopes: new Map(), scopeHasPlayer: new Map(), visiblePlayers: new Map(), sole: new Map(),
    rowTexts: new Map(), serverRows: new Map(),
  };
  try { return work(); } finally { reading = null; }
}

function collectPlayers(root: ParentNode, anchor: Element | null, found: LocatedPlayer[]): void {
  for (const player of Array.from(root.querySelectorAll(PLAYER))) found.push({ player, anchor: anchor ?? player });
  for (const host of Array.from(root.querySelectorAll('*'))) {
    if (host.shadowRoot) collectPlayers(host.shadowRoot, anchor ?? host, found);
  }
}

/** Players under a root, including inside open shadow roots (not the root's own). */
function playersIn(root: Element): Element[] {
  const doc = root.ownerDocument;
  const body = doc.body;
  if (!reading || !body || !body.contains(root)) {
    const found: LocatedPlayer[] = [];
    collectPlayers(root, null, found);
    return found.map(item => item.player);
  }
  let players = reading.scopes.get(root);
  if (!players) {
    let all = reading.players.get(doc);
    if (!all) {
      all = [];
      collectPlayers(body, null, all);
      reading.players.set(doc, all);
    }
    // The same players, in the same order, as searching `root` itself would find.
    players = all.filter(item => item.anchor !== root && root.contains(item.anchor)).map(item => item.player);
    reading.scopes.set(root, players);
  }
  return players;
}

function visiblePlayer(player: Element): boolean {
  if (!reading) return visible(player);
  let shown = reading.visiblePlayers.get(player);
  if (shown === undefined) reading.visiblePlayers.set(player, shown = visible(player));
  return shown;
}

function scopeHasVisiblePlayer(scope: Element): boolean {
  let found = reading?.scopeHasPlayer.get(scope);
  if (found === undefined) {
    found = playersIn(scope).some(visiblePlayer);
    reading?.scopeHasPlayer.set(scope, found);
  }
  return found;
}

function inPlayerContext(element: Element): boolean {
  if (element.closest(EXCLUDED) || /\b(?:filter|search|sort)\b/i.test(label(element))) return false;
  // A hosted copy is the episode page SubView loaded itself, so its controls
  // need no player nearby: sites mount players outside the controls' section,
  // keep them hidden until ready, or put them in shadow roots.
  if (!requireLayout) return true;
  const scope = element.closest('main,[role="main"],section,[role="region"]') ?? element.ownerDocument.body;
  return Boolean(scope && scopeHasVisiblePlayer(scope)) || soleMainPlayer(element.ownerDocument);
}

/** Sites often put the controls in a different section from the player. With
 * exactly one episode-sized player on the page, the controls are for it. */
function soleMainPlayer(doc: Document): boolean {
  if (!doc.body) return false;
  const known = reading?.sole.get(doc);
  if (known !== undefined) return known;
  const sole = playersIn(doc.body).filter(player => {
    const box = player.getBoundingClientRect();
    return visiblePlayer(player) && box.width >= 400 && box.height >= 225;
  }).length === 1;
  reading?.sole.set(doc, sole);
  return sole;
}

/** Characters other than spaces and zero-width padding (what `clean` keeps). */
function visibleLength(text: string): number {
  return text.replace(/[\s\u200b-\u200d\u2060\ufeff]/g, '').length;
}

/**
 * The element's text (as textContent), or null once it holds more than `limit`
 * characters besides spaces. Labels are short; reading a wrapper's whole
 * subtree to learn that it isn't one is the expensive part.
 */
function shortText(element: Element, limit: number): string | null {
  // Most elements hold just their own text: read it directly.
  if (!element.firstElementChild) {
    const own = element.textContent ?? '';
    return own.length <= limit || visibleLength(own) <= limit ? own : null;
  }
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = '';
  let count = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? '';
    count += visibleLength(value);
    if (count > limit) return null;
    text += value;
  }
  return text;
}

/** A link that runs script instead of navigating (href missing, "#…" or javascript:). */
function nonNavigatingLink(element: Element): boolean {
  if (element.tagName !== 'A') return false;
  const href = (element.getAttribute('href') ?? '').trim();
  return !href || href.startsWith('#') || /^javascript:/i.test(href);
}

function pairable(element: Element): boolean {
  return element.tagName === 'BUTTON' || nonNavigatingLink(element);
}

function enabled(element: Element): boolean {
  return !element.matches(':disabled,[aria-disabled="true"]');
}

function selected(element: Element): boolean {
  if (element.tagName === 'INPUT') return (element as HTMLInputElement).checked;
  return ['aria-selected', 'aria-checked', 'aria-pressed'].some(attr => element.getAttribute(attr) === 'true') ||
    ['page', 'true', 'step'].includes(element.getAttribute('aria-current') ?? '');
}

// Some pages (utility-CSS sites) mark the chosen Sub/Dub button
// only by styling it. Variant tokens like "hover:bg-white/5" are pseudo-class
// styling, not state, so they're ignored.
const SELECTED_CLASS = /^(?:is-|has-)?(?:active|selected|current|checked|on)$|(?:^|[-_])(?:active|selected|current|checked|primary)(?:$|[-_])/;
const NEGATED_CLASS = /(?:^|[-_])(?:in|un|not|non)[-_]?(?:active|selected|current|checked)/;

function stateClasses(element: Element): Set<string> {
  return new Set(Array.from(element.classList).map(token => token.toLowerCase()).filter(token => !token.includes(':')));
}

/** One Sub and one Dub control with no accessible state: the selected one is
 * the only one carrying a selected-looking class the other lacks. */
const STATE_ATTRIBUTES = ['aria-selected', 'aria-checked', 'aria-pressed', 'aria-current'];

/** True when the page states selection itself, even as "false". */
function hasAccessibleState(element: Element): boolean {
  return element.tagName === 'INPUT' || STATE_ATTRIBUTES.some(attr => element.hasAttribute(attr));
}

function styledSelection(pair: Element[]): Element | null {
  if (pair.length !== 2 || pair.some(hasAccessibleState)) return null;
  const kinds = new Set(pair.map(element => language(label(element))));
  if (!kinds.has('sub') || !kinds.has('dub')) return null;
  const [a, b] = pair.map(stateClasses);
  const marked = (own: Set<string>, other: Set<string>) =>
    [...own].some(token => !other.has(token) && SELECTED_CLASS.test(token) && !NEGATED_CLASS.test(token));
  const markA = marked(a, b);
  const markB = marked(b, a);
  return markA === markB ? null : pair[markA ? 0 : 1];
}

// Server-row layout: a "SUB:" row and a "DUB:" row, each holding server
// buttons ("HD-1", "zeta"…). The row holding the current server is the
// current language; the servers in the Dub row are the Dub servers.
// An icon letter or two may lead ("CC Sub:", "D Dub:"); a quality may trail ("DUB FHD").
const ROW_LABEL = /^(?:[a-z]{1,2}\s+)?(sub|subbed|dub|dubbed|soft\s?sub|hard\s?sub)(?:\s+(?:fhd|hd|sd|\d{3,4}p))?\s*:?$/i;
const ROW_LABEL_TAGS = 'span,div,label,strong,b,p,dt,legend,h2,h3,h4,h5,h6';
const SERVER_BUTTON = 'button,[role="button"],[onclick]';
const MAX_SERVERS = 12;
const EPISODE_LABEL = /^(?:ep(?:isode)?\.?\s*)?\d+$/i;

interface ServerRow {
  language: AvailableLanguage;
  servers: Element[];
}

/** More than either row label pattern can hold, spaces aside ("hd hard sub 1080p:" is 15). */
const ROW_LABEL_MAX_CHARS = 32;

/** A row label's text, cleaned, or null for anything too big to be one. */
function rowLabelText(element: Element): string | null {
  if (element.children.length > 2) return null;
  const known = reading?.rowTexts.get(element);
  if (known !== undefined) return known;
  const text = shortText(element, ROW_LABEL_MAX_CHARS);
  const value = text === null ? null : clean(text);
  reading?.rowTexts.set(element, value);
  return value;
}

function rowLabel(element: Element): AvailableLanguage | null {
  const text = rowLabelText(element);
  const match = text === null ? null : ROW_LABEL.exec(text);
  if (!match || element.closest(`${CONTROL},[role="option"]`)) return null;
  return /dub/i.test(match[1]) ? 'dub' : 'sub';
}

function serverLabel(element: Element): string {
  return clean(element.textContent) || clean(element.getAttribute('aria-label'));
}

/** A plain "Server:" / "Sources:" row, for sites whose language switch is separate. */
const SERVER_ROW_LABEL = /^(?:servers?|sources?|providers?|mirrors?)\s*:?$/i;

function anyRowLabel(element: Element): boolean {
  const text = rowLabelText(element);
  if (text === null || (!ROW_LABEL.test(text) && !SERVER_ROW_LABEL.test(text))) return false;
  return !element.closest(`${CONTROL},[role="option"]`);
}

/** The server buttons next to a row label, or null when they don't look like servers. */
function labeledButtons(label: Element): { row: Element; servers: Element[] } | null {
  let row = label.parentElement;
  while (row && !row.querySelector(SERVER_BUTTON)) row = row.parentElement;
  // Too far up: the container holds more than this one row label.
  if (!row || Array.from(row.querySelectorAll(ROW_LABEL_TAGS)).filter(anyRowLabel).length !== 1) return null;
  const servers = Array.from(row.querySelectorAll(SERVER_BUTTON)).filter(button =>
    visible(button) && enabled(button) && inPlayerContext(button) && !language(serverLabel(button)) && serverLabel(button));
  // Episode lists sit under "Sub"/"Dub" labels too: numbered or long rows aren't servers.
  if (!servers.length || servers.length > MAX_SERVERS || servers.some(button => EPISODE_LABEL.test(serverLabel(button)))) return null;
  return { row, servers };
}

function serverRows(doc: Document): ServerRow[] {
  return oneReading(() => {
    const known = reading?.serverRows.get(doc);
    if (known) return known;
    const rows = new Map<Element, ServerRow>();
    for (const element of Array.from(doc.querySelectorAll(ROW_LABEL_TAGS))) {
      const lang = rowLabel(element);
      if (!lang || !visible(element)) continue;
      const found = labeledButtons(element);
      if (found && !rows.has(found.row)) rows.set(found.row, { language: lang, servers: found.servers });
    }
    const found = [...rows.values()];
    const kinds = new Set(found.map(row => row.language));
    const result = kinds.has('sub') && kinds.has('dub') ? found : [];
    reading?.serverRows.set(doc, result);
    return result;
  });
}

/** The one current server across all rows: accessible state first, else a
 * selected-looking class no other server button has. */
function currentServer(rows: ServerRow[]): Element | null {
  const servers = rows.flatMap(row => row.servers);
  if (servers.some(hasAccessibleState)) {
    const marked = servers.filter(selected);
    return marked.length === 1 ? marked[0] : null;
  }
  const tokens = servers.map(stateClasses);
  const styled = servers.filter((_, index) => [...tokens[index]].some(token =>
    SELECTED_CLASS.test(token) && !NEGATED_CLASS.test(token) && tokens.every((other, j) => j === index || !other.has(token))));
  return styled.length === 1 ? styled[0] : null;
}

function rowOf(rows: ServerRow[], server: Element | null): ServerRow | null {
  return server ? rows.find(row => row.servers.includes(server)) ?? null : null;
}

// Custom dropdowns (Vuetify, MUI, Headless UI…): a trigger that pops up a
// role="listbox" of role="option" items. The options often exist only while
// the menu is open, so a closed trigger is read from its displayed value.
const POPUP = '[aria-haspopup="listbox"],[role="combobox"]';
const POPUP_NAME = /\b(?:sub\s*\/\s*dub|dub\s*\/\s*sub|audio|language|version|translation)\b/i;
const SERVER_NAME = /\b(?:provider|server|source|quality)\b/i;

interface LanguagePopup {
  trigger: Element;
  current: AvailableLanguage | null;
  /** Languages offered, when the options are rendered. */
  offered: AvailableLanguage[] | null;
}

function textWithout(element: Element, skip: string): string {
  if (element instanceof HTMLInputElement) return clean(element.value);
  const view = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = '';
  for (let node = view.nextNode(); node; node = view.nextNode()) {
    if (!node.parentElement?.closest(skip)) text += ` ${node.textContent ?? ''}`;
  }
  return clean(text);
}

function popupName(trigger: Element): string {
  const doc = trigger.ownerDocument;
  const ids = trigger.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
  return clean([
    trigger.getAttribute('aria-label'),
    ...ids.map(id => doc.getElementById(id)?.textContent),
    ...Array.from(trigger.querySelectorAll('label')).map(item => item.textContent),
    ...Array.from((trigger as HTMLInputElement).labels ?? []).map(item => item.textContent),
  ].join(' '));
}

function popupListbox(trigger: Element): Element | null {
  const doc = trigger.ownerDocument;
  for (const id of [trigger.getAttribute('aria-controls'), trigger.getAttribute('aria-owns')].join(' ').split(/\s+/)) {
    const owned = id ? doc.getElementById(id) : null;
    if (owned) return owned.matches('[role="listbox"]') ? owned : owned.querySelector('[role="listbox"]');
  }
  return trigger.querySelector('[role="listbox"]');
}

function popupOptions(listbox: Element | null): Element[] {
  return listbox ? Array.from(listbox.querySelectorAll('[role="option"]')).filter(option => enabled(option) && visible(option)) : [];
}

function languagePopups(doc: Document): LanguagePopup[] {
  return oneReading(() => Array.from(doc.querySelectorAll(POPUP)).flatMap((trigger): LanguagePopup[] => {
    if (!visible(trigger) || !enabled(trigger) || !inPlayerContext(trigger)) return [];
    const name = popupName(trigger);
    if (SERVER_NAME.test(name)) return [];
    const shown = language(textWithout(trigger, 'label,[role="listbox"]'));
    const options = popupOptions(popupListbox(trigger));
    const kinds = options.map(option => language(label(option)));
    if (options.length && kinds.includes('sub') && kinds.includes('dub')) {
      const chosen = options.filter(option => option.getAttribute('aria-selected') === 'true');
      const current = chosen.length === 1 ? language(label(chosen[0])) : shown;
      return [{ trigger, current, offered: ["sub", "dub"] }];
    }
    // Closed menu: trust the displayed value only under a Sub/Dub-like name.
    return shown && POPUP_NAME.test(name) ? [{ trigger, current: shown, offered: null }] : [];
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Clicks the way a user does, for menus that open on pointer or mouse down. */
function press(element: Element): void {
  const view = element.ownerDocument.defaultView;
  const init = { bubbles: true, cancelable: true, composed: true, button: 0 };
  if (view?.PointerEvent) element.dispatchEvent(new view.PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }));
  if (view?.MouseEvent) element.dispatchEvent(new view.MouseEvent('mousedown', init));
  if (view?.PointerEvent) element.dispatchEvent(new view.PointerEvent('pointerup', { ...init, pointerType: 'mouse', isPrimary: true }));
  if (view?.MouseEvent) element.dispatchEvent(new view.MouseEvent('mouseup', init));
  (element as HTMLElement).click();
}

// Generous: a hidden copy may share a busy CPU, and React menus render late.
const MENU_OPEN_TIMEOUT_MS = 5_000;

/** Open the single Sub/Dub popup menu and choose the target language. */
async function selectFromPopup(doc: Document, target: AvailableLanguage): Promise<{ ok: boolean; error?: string; at?: number }> {
  const popups = languagePopups(doc);
  if (popups.length !== 1) return selectionError('Could not identify one Sub/Dub menu.');
  const { trigger } = popups[0];
  const find = () => popupOptions(popupListbox(trigger)).filter(option => language(label(option)) === target);
  let options = find();
  if (!options.length) {
    // Some menus open on click, others on pointer down; a full press covers both
    // but toggles click-openers twice, so try a plain click first.
    (trigger as HTMLElement).click();
    for (const started = Date.now(); !find().length && Date.now() - started < MENU_OPEN_TIMEOUT_MS / 2;) await sleep(100);
    if (!find().length) press(trigger);
    for (const started = Date.now(); !find().length && Date.now() - started < MENU_OPEN_TIMEOUT_MS;) await sleep(100);
    options = find();
  }
  if (options.length !== 1) {
    trigger.dispatchEvent(new (doc.defaultView?.KeyboardEvent ?? KeyboardEvent)('keydown', { key: 'Escape', bubbles: true }));
    return selectionError(options.length ? 'The Sub/Dub menu has more than one Dub option.' : 'This episode has no Dub option.');
  }
  // Loads started while the menu opened belong to Sub; only the choice counts.
  const playing = requireLayout ? null : playingEpisode(doc);
  const shown = new Set(episodeLabels(doc));
  const at = Date.now();
  press(options[0]);
  if (playing !== null) await followEpisode(doc, playing, shown);
  return { ok: true, at };
}

// Some sites keep Dub episodes on their own pages: the Sub/Dub menu only
// filters the episode list, and the Dub episode opens from that list. In a
// hidden copy, re-open the episode that was playing from the filtered list.
const EPISODE_TEXT = /^(?:ep(?:isode)?\.?\s*)0*(\d+(?:\.\d+)?)(?![\d.])/i;
const PLAYING_TEXT = /\b(?:now\s+)?(?:playing|watching)\b/i;
const EPISODE_FOLLOW_TIMEOUT_MS = 3_000;

function episodeNumber(element: Element): number | null {
  const match = EPISODE_TEXT.exec(clean(element.textContent));
  return match ? Number(match[1]) : null;
}

/** Smallest elements that start with an episode label ("EP 01", "Episode 1"). */
function episodeLabels(doc: Document): Element[] {
  const labels = Array.from(doc.querySelectorAll('span,div,a,button,li,p,b,strong')).filter(element => {
    if (element.children.length > 2) return false;
    const text = shortText(element, 40);
    if (text === null) return false;
    const value = clean(text);
    return value.length <= 40 && EPISODE_TEXT.test(value) && visible(element);
  });
  return labels.filter(element => !labels.some(other => other !== element && element.contains(other)));
}

/** The episode list item marked as playing ("EP 01 Playing", aria-current). */
function playingEpisode(doc: Document): number | null {
  const marked = new Set<number>();
  for (const element of episodeLabels(doc)) {
    const item = element.closest('a,button,li,[tabindex],[role="link"],[role="button"]') ?? element.parentElement;
    if (!item) continue;
    if (PLAYING_TEXT.test(clean(item.textContent)) || item.matches('[aria-current]:not([aria-current="false"])')) {
      marked.add(episodeNumber(element) as number);
    }
  }
  return marked.size === 1 ? [...marked][0] : null;
}

async function followEpisode(doc: Document, episode: number, shown: Set<Element>): Promise<void> {
  // Only a re-rendered (Dub) list counts: the old nodes are the Sub list.
  const find = () => episodeLabels(doc).filter(element => episodeNumber(element) === episode && !shown.has(element));
  for (const started = Date.now(); Date.now() - started < EPISODE_FOLLOW_TIMEOUT_MS; await sleep(200)) {
    const items = find();
    // The playing marker means the list still shows the Sub episode; wait for the Dub list.
    if (items.length !== 1) continue;
    const item = items[0].closest('a,button,li,[tabindex],[role="link"],[role="button"]') ?? items[0];
    if (PLAYING_TEXT.test(clean(item.textContent))) continue;
    if (!staysInPage(items[0]) || !staysInPage(item)) return;
    press(items[0]);
    return;
  }
}

// ---------- audio chosen by language ----------
// Licensed services carry one episode with several audio languages instead of
// separate Sub and Dub versions: a control named "Audio" whose options are
// languages ("Japanese", "English"). Dub there is audio in the viewer's own
// language; any other selected language is Sub.
const AUDIO_GROUP = '[role="menu"],[role="listbox"],[role="radiogroup"],select';
const AUDIO_OPTION = '[role="menuitemradio"],[role="option"],[role="radio"],option';
const AUDIO_NAME = /\baudio\b/i;
/** Audio description and commentary tracks are in a language but aren't the Dub. */
const DESCRIPTIVE = /\[ad\]|\bad\b|audio descri|descriptive|commentary/i;
/** Buttons that may hold the audio choice, most specific first; the last is a player's settings menu. */
const AUDIO_TRIGGER_NAMES = [/\baudio\b/i, /\b(?:languages?|tracks?)\b/i, /\b(?:settings|preferences)\b/i];
const MAX_AUDIO_TRIGGERS = 3;
/** Containers a page names for its player: where player buttons and player messages live. */
const PLAYER_AREA = '[id*="player" i],[class*="player" i],[id*="video" i],[class*="video" i]';

/** A name the page gave the element itself; never its text content. */
function explicitName(element: Element): string {
  const ids = element.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
  return clean([
    element.getAttribute('aria-label'),
    ...ids.map(id => element.ownerDocument.getElementById(id)?.textContent),
    ...Array.from((element as HTMLSelectElement).labels ?? []).map(item => item.textContent),
  ].join(' '));
}

/** Names of the languages the browser prefers, most preferred first: the code, its own name, its English name. */
function viewerLanguages(): string[][] {
  const preferred = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  const codes = [...new Set(preferred.filter(Boolean).map(code => code.toLowerCase().split('-')[0]))];
  return (codes.length ? codes : ['en']).map(code => {
    const names = new Set([code]);
    for (const locale of [code, 'en']) {
      try {
        const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code);
        if (name) names.add(name.toLowerCase());
      } catch { /* An unknown code keeps just itself. */ }
    }
    return [...names];
  });
}

/** How preferred an option's language is to the viewer: 0 is best, -1 is not theirs. */
function viewerRank(text: string, preferred: string[][]): number {
  const value = text.toLowerCase();
  return preferred.findIndex(names => names.some(name =>
    value === name || (value.startsWith(name) && !/\p{L}/u.test(value.charAt(name.length)))));
}

function audioOptionText(option: Element): string {
  return clean(option.textContent) || clean(option.getAttribute('aria-label'));
}

function chosen(option: Element): boolean {
  return option instanceof HTMLOptionElement ? option.selected
    : ['aria-checked', 'aria-selected'].some(attr => option.getAttribute(attr) === 'true');
}

interface AudioReading {
  group: Element;
  current: AvailableLanguage | null;
  /** The option to press for Dub, when the episode has the viewer's language. */
  dub: Element | null;
}

/** Audio-language controls that are rendered right now (many exist only while their menu is open). */
function audioReadings(doc: Document): AudioReading[] {
  const preferred = viewerLanguages();
  return Array.from(doc.querySelectorAll(AUDIO_GROUP)).flatMap((group): AudioReading[] => {
    if (!AUDIO_NAME.test(explicitName(group)) || !visible(group)) return [];
    const options = Array.from(group.querySelectorAll(AUDIO_OPTION)).filter(option => enabled(option) && audioOptionText(option));
    const selectedOptions = options.filter(chosen);
    if (options.length < 2 || selectedOptions.length > 1) return [];
    const ranked = options.map(option => ({ option, text: audioOptionText(option), rank: viewerRank(audioOptionText(option), preferred) }));
    const mine = ranked.filter(item => item.rank >= 0 && !DESCRIPTIVE.test(item.text)).sort((a, b) => a.rank - b.rank);
    // Regional variants ("Español (España)") share a rank: the plain name wins, else the first listed.
    const best = mine.find(item => preferred[item.rank]?.includes(item.text.toLowerCase())) ?? mine[0] ?? null;
    const selectedRank = selectedOptions.length ? viewerRank(audioOptionText(selectedOptions[0]), preferred) : null;
    const current = selectedRank === null ? null : best && selectedRank === best.rank ? 'dub' : 'sub';
    return [{ group, current, dub: best?.option ?? null }];
  });
}

/** Buttons that may open the audio choice, best guess first. */
function audioTriggers(doc: Document): Element[] {
  return oneReading(() => Array.from(doc.querySelectorAll('button,[role="button"]')).flatMap(element => {
    if (!element.hasAttribute('aria-haspopup') && !element.hasAttribute('aria-expanded')) return [];
    const name = explicitName(element);
    const rank = AUDIO_TRIGGER_NAMES.findIndex(pattern => pattern.test(name));
    // Not visible(): players hide their control bar while idle, and the button is still the way in.
    // Inside the player only: a site's own "Language" menu is about the interface, not the audio.
    if (rank < 0 || SERVER_NAME.test(name) || !element.isConnected || element.closest('[inert]') || !element.closest(PLAYER_AREA) ||
        !enabled(element) || !inPlayerContext(element)) return [];
    return [{ element, rank }];
  }).sort((a, b) => a.rank - b.rank).slice(0, MAX_AUDIO_TRIGGERS).map(item => item.element));
}

// What the control said when it was last readable, per page address: closing
// the menu removes the options, not the choice. Player controls also leave the
// page while idle, so a trigger seen on this address still counts.
//
// A reading of the original language also follows the viewer to the next
// episode inside the same app: players keep the audio choice while the page
// stays loaded, and nothing on the new address would say so (the menu is
// closed). A reading of the viewer's own language is not carried: there, being
// wrong would keep Auto Dub off, so it is read afresh. A reload starts with
// nothing, as the player does.
let audioMemory: { href: string; current: AvailableLanguage; hasDub: boolean } | null = null;
let audioTriggerSeenOn = '';

interface AudioState {
  current: AvailableLanguage | null;
  hasDub: boolean;
  element: Element | null;
}

function audioState(doc: Document): AudioState | null {
  const href = doc.location?.href ?? doc.URL;
  const readings = audioReadings(doc);
  if (readings.length > 1) return null;
  if (readings.length === 1) {
    const [{ group, current, dub }] = readings;
    const hasDub = Boolean(dub);
    if (current) audioMemory = { href, current, hasDub };
    return { current, hasDub, element: group };
  }
  const [trigger] = audioTriggers(doc);
  if (trigger) audioTriggerSeenOn = href;
  else if (audioTriggerSeenOn !== href || !doc.body || !playersIn(doc.body).length) return null;
  if (trigger && audioMemory && audioMemory.href !== href) {
    // Whether this episode has the viewer's language is for the hidden copy to find out.
    audioMemory = audioMemory.current === 'sub' ? { href, current: 'sub', hasDub: true } : null;
  }
  if (audioMemory?.href === href) return { current: audioMemory.current, hasDub: audioMemory.hasDub, element: trigger ?? null };
  // Closed and never read: the hidden copy opens it to find out.
  return { current: null, hasDub: true, element: trigger ?? null };
}

/** Debug tools: the audio controls as they are right now. */
export function describeAudioControls(doc: Document): unknown {
  const state = (element: Element) => {
    const marks: string[] = [];
    for (let item: Element | null = element; item && item !== doc.body; item = item.parentElement) {
      for (const attr of ["data-state", "aria-hidden", "hidden", "inert"]) if (item.hasAttribute(attr)) marks.push(`${attr}=${item.getAttribute(attr) || "true"}`);
      const style = doc.defaultView?.getComputedStyle(item);
      if (style?.display === "none") marks.push("display:none");
      if (style?.visibility === "hidden") marks.push("visibility:hidden");
    }
    return [...new Set(marks)].join(" ") || "plain";
  };
  return {
    triggers: audioTriggers(doc).map(trigger => ({ name: explicitName(trigger), expanded: trigger.getAttribute("aria-expanded"), state: state(trigger) })),
    groups: Array.from(doc.querySelectorAll(AUDIO_GROUP)).filter(group => AUDIO_NAME.test(explicitName(group))).map(group => ({
      name: explicitName(group),
      readable: visible(group),
      state: state(group),
      options: Array.from(group.querySelectorAll(AUDIO_OPTION)).slice(0, 6).map(option => `${audioOptionText(option)}${chosen(option) ? "*" : ""}`),
    })),
    animations: typeof doc.getAnimations === "function" ? doc.getAnimations().length : null,
  };
}

const AUDIO_OPEN_CLICK_MS = 1_500;
const AUDIO_OPEN_PRESS_MS = 2_500;
/** How long the control gets to show the new choice before it counts as unconfirmed. */
const AUDIO_CONFIRM_MS = 600;

export const ALREADY_DUB_ERROR = "This page is already playing audio in your language.";

/**
 * Hosted pages only: open the player's audio menu if needed and choose the
 * viewer's language. `confirmed` says the control itself then showed that
 * choice, which is the only evidence when the audio switches in place without
 * loading a new video. `already` means nothing needed choosing.
 */
async function selectFromAudioControl(doc: Document): Promise<{ ok: boolean; error?: string; at?: number; confirmed?: boolean; already?: boolean }> {
  const read = () => { const found = audioReadings(doc); return found.length === 1 ? found[0] : null; };
  const until = async (ms: number) => { for (const started = Date.now(); !read() && Date.now() - started < ms;) await sleep(100); return read(); };
  const escape = (element: Element) => element.dispatchEvent(new (doc.defaultView?.KeyboardEvent ?? KeyboardEvent)('keydown', { key: 'Escape', bubbles: true }));
  let reading = read();
  for (const trigger of reading ? [] : audioTriggers(doc)) {
    // Click-openers first: a full press would toggle them twice.
    (trigger as HTMLElement).click();
    reading = await until(AUDIO_OPEN_CLICK_MS);
    if (!reading) { press(trigger); reading = await until(AUDIO_OPEN_PRESS_MS); }
    if (reading) break;
    escape(trigger); // A settings menu without an audio choice: leave it closed.
  }
  if (!reading) return selectionError('The player showed no audio language choice.');
  if (reading.current === 'dub') return { ok: false, error: ALREADY_DUB_ERROR, already: true };
  if (!reading.dub) return selectionError('This episode has no audio in your language.');
  const at = Date.now();
  if (reading.dub instanceof HTMLOptionElement) {
    const select = reading.dub.closest('select');
    if (!select) return selectionError('The audio choice is not a usable control.');
    select.value = reading.dub.value;
    select.selectedIndex = reading.dub.index;
    const EventConstructor = doc.defaultView?.Event ?? Event;
    select.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    select.dispatchEvent(new EventConstructor('change', { bubbles: true }));
  } else {
    press(reading.dub);
  }
  let confirmed = false;
  for (const started = Date.now(); !confirmed && Date.now() - started < AUDIO_CONFIRM_MS; await sleep(100)) confirmed = read()?.current === 'dub';
  // A stale "Sub" must not outlive the press; an address change forgets it anyway.
  audioMemory = confirmed ? { href: doc.location?.href ?? doc.URL, current: 'dub', hasDub: true } : null;
  return { ok: true, at, confirmed };
}

// ---------- putting a player's choices back ----------
// A reload SubView itself asked for must not cost the viewer their settings.
// Many players come back from one on their defaults (audio, subtitles, speed).
// So before the reload SubView notes what each of the player's menus has
// chosen, by the names the page gives them, and afterwards chooses the same
// again. Nothing here knows any site: a choice is a named menu, list or select
// with exactly one option chosen, found in the player or opened by one of its
// own buttons.
export interface PlayerChoice {
  /** The name the page gives the group ("Audio Language", "Subtitles"). */
  group: string;
  /** The text of the chosen option. */
  option: string;
}

const CHOICE_OPEN_MS = 1_000;
const CHOICE_SETTLE_MS = 500;
const MAX_CHOICES = 12;

interface ChoiceGroup {
  element: Element;
  name: string;
  options: Element[];
  selected: Element;
  inPlayer: boolean;
}

/**
 * A closed panel often stays in the page, laid out but fully transparent. Only
 * used to tell what was there before a menu opened: a panel that has just
 * opened can be transparent too (its fade-in does not advance in a tab that is
 * not on screen), and that one must be read.
 */
function fadedOut(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  for (let item: Element | null = element; item; item = item.parentElement) {
    if (Number(view.getComputedStyle(item).opacity) === 0) return true;
  }
  return false;
}

/** Choice groups rendered right now. Which server plays is not the viewer's setting to put back. */
function choiceGroups(doc: Document, countFaded = true): ChoiceGroup[] {
  return Array.from(doc.querySelectorAll(AUDIO_GROUP)).flatMap((group): ChoiceGroup[] => {
    const name = explicitName(group);
    if (!name || SERVER_NAME.test(name) || !visible(group) || (!countFaded && fadedOut(group))) return [];
    const options = Array.from(group.querySelectorAll(AUDIO_OPTION)).filter(option => enabled(option) && audioOptionText(option));
    const selectedOptions = options.filter(chosen);
    if (options.length < 2 || selectedOptions.length !== 1) return [];
    return [{ element: group, name, options, selected: selectedOptions[0], inPlayer: Boolean(group.closest(PLAYER_AREA)) }];
  });
}

/**
 * Open each of the player's menus, run `read`, and close the menu again.
 * `read` is given a way to look at the groups that belong to the player right
 * now (inside it, or not on the page before the menu opened). It returns true
 * to have the same menu reopened and read once more (a menu that closes itself
 * after a choice).
 */
async function withPlayerMenus(doc: Document, read: (look: () => ChoiceGroup[]) => Promise<boolean>): Promise<void> {
  // The player's own: inside it, inside the panel the button says it controls, or not on the page before the menu opened.
  const mine = (known: Set<string>, panel: Element | null = null) => choiceGroups(doc).filter(group =>
    group.inPlayer || !known.has(group.name) || Boolean(panel?.contains(group.element)));
  const until = async (test: () => boolean, ms: number) => { for (const started = Date.now(); !test() && Date.now() - started < ms;) await sleep(100); return test(); };
  // Choices that need no opening: plain selects in the player.
  const shown = new Set(choiceGroups(doc, false).map(group => group.name));
  await read(() => mine(shown).filter(group => group.selected instanceof HTMLOptionElement));
  for (const trigger of audioTriggers(doc)) {
    for (let round = 0; round < MAX_CHOICES; round += 1) {
      if (!trigger.isConnected) break;
      // What is on the page while the menu is closed; a faded-out panel is not.
      const known = new Set(choiceGroups(doc, false).map(group => group.name));
      // A button that says whether its menu is open is believed: a closed
      // panel often stays in the page, faded out, and looks rendered. Without
      // that, open means groups that were not there before.
      const says = trigger.hasAttribute('aria-expanded');
      const controls = trigger.getAttribute('aria-controls');
      const panel = controls ? doc.getElementById(controls) : null;
      const open = () => says ? trigger.getAttribute('aria-expanded') === 'true' : choiceGroups(doc).some(group => !known.has(group.name));
      // Open already (the viewer's doing): read it as it is, and leave it open.
      const wasOpen = open();
      if (!wasOpen) {
        // Click-openers first: a full press would toggle them twice.
        (trigger as HTMLElement).click();
        if (!await until(open, CHOICE_OPEN_MS)) { press(trigger); await until(open, CHOICE_OPEN_MS); }
      }
      if (!open()) break; // Not a menu SubView can open: nothing is pressed blind.
      await until(() => mine(known, panel).length > 0, CHOICE_OPEN_MS); // Menus render a moment after they open.
      const again = await read(() => mine(known, panel));
      if (!wasOpen && open()) {
        const KeyboardEventConstructor = doc.defaultView?.KeyboardEvent ?? KeyboardEvent;
        trigger.dispatchEvent(new KeyboardEventConstructor('keydown', { key: 'Escape', bubbles: true }));
        if (!await until(() => !open(), 400)) { (trigger as HTMLElement).click(); await until(() => !open(), CHOICE_OPEN_MS); }
      }
      if (!again) break;
    }
  }
}

/** What the player's menus have chosen right now. Opens and closes them to look. */
export async function capturePlayerChoices(doc: Document): Promise<PlayerChoice[]> {
  const found = new Map<string, string>();
  await withPlayerMenus(doc, async look => {
    for (const group of look()) if (!found.has(group.name)) found.set(group.name, audioOptionText(group.selected));
    return false;
  });
  return Array.from(found, ([group, option]) => ({ group, option })).slice(0, MAX_CHOICES);
}

/** Choose the noted options again where the player now has something else. Returns the names of the groups it changed. */
export async function restorePlayerChoices(doc: Document, choices: PlayerChoice[]): Promise<string[]> {
  const wanted = new Map(choices.slice(0, MAX_CHOICES).map(choice => [choice.group, choice.option]));
  const seen = new Set<string>();
  const changed: string[] = [];
  const choose = (target: Element) => {
    if (!(target instanceof HTMLOptionElement)) { press(target); return; }
    const select = target.closest('select');
    if (!select) return;
    select.value = target.value;
    select.selectedIndex = target.index;
    const EventConstructor = doc.defaultView?.Event ?? Event;
    select.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    select.dispatchEvent(new EventConstructor('change', { bubbles: true }));
  };
  await withPlayerMenus(doc, async look => {
    let pressed = false;
    // Look afresh after every choice: pressing an option can redraw the menu, or close it.
    for (let group; (group = look().find(item => wanted.has(item.name) && !seen.has(item.name)));) {
      seen.add(group.name);
      const target = group.options.find(option => audioOptionText(option) === wanted.get(group!.name));
      if (!target || chosen(target)) continue;
      choose(target);
      pressed = true;
      changed.push(group.name);
      await sleep(CHOICE_SETTLE_MS);
    }
    // Reopen only a menu that a choice may have closed with groups still to do.
    return pressed && seen.size < wanted.size;
  });
  return changed;
}

interface RecognizedOption {
  option: HTMLOptionElement;
  language: AvailableLanguage;
}

type DubSelection =
  | {
    kind: 'select';
    select: HTMLSelectElement;
    option: HTMLOptionElement;
    current: AvailableLanguage | null;
  }
  | {
    kind: 'control';
    element: Element;
    current: AvailableLanguage | null;
  };

interface ControlGroup {
  group: Element;
  controls: Element[];
}

function recognizedOptions(select: HTMLSelectElement): RecognizedOption[] {
  return Array.from(select.options).flatMap(option => {
    if (option.disabled || option.hidden || option.closest('optgroup[disabled]')) return [];
    const kind = language(label(option)) ?? language(option.value);
    return kind ? [{ option, language: kind }] : [];
  });
}

function semanticControlGroup(element: Element): Element | null {
  const explicit = element.closest('[role="tablist"],[role="radiogroup"],fieldset');
  if (explicit) return explicit;
  if (element.matches('[role="tab"],[role="radio"],input[type="radio"]')) {
    return element.parentElement;
  }
  return null;
}

/** In a hidden copy, following a same-site Sub/Dub link only moves that copy. */
function hostedSameSiteLink(element: Element): boolean {
  if (requireLayout || element.tagName !== 'A') return false;
  try {
    const url = new URL((element as HTMLAnchorElement).href);
    const target = element.getAttribute('target') ?? element.ownerDocument.querySelector('base[target]')?.getAttribute('target') ?? '';
    return url.origin === element.ownerDocument.location.origin && ['', '_self'].includes(target.trim().toLowerCase()) &&
      !element.hasAttribute('download');
  } catch {
    return false;
  }
}

function canActivateWithoutNavigation(element: Element): boolean {
  if (element.tagName === 'A') return (nonNavigatingLink(element) || hostedSameSiteLink(element)) && typeof (element as HTMLElement).click === 'function';
  if (element.matches('input[type="radio"]')) return true;
  const role = element.getAttribute('role');
  if (element.closest('a[href]')) return false;
  if (element.tagName === 'BUTTON') {
    const button = element as HTMLButtonElement;
    if (button.form && button.type !== 'button') return false;
    return typeof button.click === 'function';
  }
  // An inline click handler on a non-link (a server <span>) runs script, not navigation.
  if (element.hasAttribute('onclick')) return typeof (element as HTMLElement).click === 'function';
  return (role === 'tab' || role === 'radio' || role === 'button') && typeof (element as HTMLElement).click === 'function';
}

function selectionError(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** Select one unambiguous semantic language control without following links. */
function selectLanguage(doc: Document, target: AvailableLanguage, force = false): { ok: boolean; error?: string } {
  return oneReading(() => selectLanguageNow(doc, target, force));
}

function selectLanguageNow(doc: Document, target: AvailableLanguage, force: boolean): { ok: boolean; error?: string } {
  const previous = target === 'dub' ? 'sub' : 'dub';
  const detection = detectLanguage(doc);
  if (detection.language === target) return { ok: true };
  if (!force && detection.language !== previous) {
    return selectionError(`Could not identify one selected ${previous === 'sub' ? 'Sub' : 'Dub'} control near a player.`);
  }

  const choices: DubSelection[] = [];
  let ambiguous = false;

  for (const select of Array.from(doc.querySelectorAll<HTMLSelectElement>('select'))) {
    if (!visible(select) || !enabled(select) || !inPlayerContext(select)) continue;
    const name = label(select);
    if (/\b(?:provider|server)\b/i.test(name)) continue;

    const recognized = recognizedOptions(select);
    const subs = recognized.filter(item => item.language === 'sub');
    const dubs = recognized.filter(item => item.language === 'dub');
    if (!subs.length || !dubs.length) continue;
    if (select.multiple || subs.length !== 1 || dubs.length !== 1) {
      ambiguous = true;
      continue;
    }

    const selectedOptions = Array.from(select.selectedOptions);
    const current = selectedOptions.length === 1
      ? language(label(selectedOptions[0])) ?? language(selectedOptions[0].value)
      : null;
    choices.push({ kind: 'select', select, option: (target === 'dub' ? dubs : subs)[0].option, current });
  }

  const controlGroups = new Map<Element, ControlGroup>();
  const buttonPairs = new Map<Element, Element[]>();
  // Reading a label is cheap; visibility and player context are not. Only
  // controls that name a language matter, and the other controls of a group
  // that holds one (their selected state counts there).
  const candidates = Array.from(doc.querySelectorAll(CONTROL)).filter(element => element.tagName !== 'SELECT')
    .map(element => ({ element, group: semanticControlGroup(element), named: language(label(element)) !== null }));
  const languageGroups = new Set(candidates.flatMap(item => item.named && item.group ? [item.group] : []));
  const usable = (element: Element) => visible(element) && enabled(element) && inPlayerContext(element);
  for (const { element, group, named } of candidates) {
    if (!group) {
      if (named && pairable(element) && element.parentElement && usable(element)) {
        buttonPairs.set(element.parentElement, [...buttonPairs.get(element.parentElement) ?? [], element]);
      }
      continue;
    }
    if (!languageGroups.has(group) || !usable(element)) continue;
    const existing = controlGroups.get(group) ?? { group, controls: [] };
    existing.controls.push(element);
    controlGroups.set(group, existing);
  }

  for (const { controls: groupControls } of controlGroups.values()) {
    const recognized = groupControls.flatMap(element => {
      const kind = language(label(element));
      return kind ? [{ element, language: kind }] : [];
    });
    const subs = recognized.filter(item => item.language === 'sub');
    const dubs = recognized.filter(item => item.language === 'dub');
    if (!subs.length || !dubs.length) continue;
    if (subs.length !== 1 || dubs.length !== 1) {
      ambiguous = true;
      continue;
    }

    const selectedControls = groupControls.filter(selected);
    const styled = selectedControls.length ? null : styledSelection([...subs, ...dubs].map(item => item.element));
    const current = selectedControls.length === 1 ? language(label(selectedControls[0]))
      : styled ? language(label(styled)) : null;
    choices.push({ kind: 'control', element: (target === 'dub' ? dubs : subs)[0].element, current });
  }

  if (!choices.length && !ambiguous) {
    const rows = serverRows(doc);
    const current = rowOf(rows, currentServer(rows));
    const targetRows = rows.filter(row => row.language === target);
    if (targetRows.length && (current || force)) {
      choices.push({ kind: 'control', element: targetRows[0].servers[0], current: current?.language ?? null });
    }
  }

  // Last resort: a plain button pair whose state is only styled. Used only when
  // no semantic group exists, so it never makes a semantic page ambiguous.
  if (!choices.length && !ambiguous) {
    for (const pair of buttonPairs.values()) {
      const marked = pair.filter(selected);
      const chosen = marked.length === 1 ? marked[0] : styledSelection(pair);
      const wanted = pair.filter(element => language(label(element)) === target);
      if (pair.length !== 2 || wanted.length !== 1 || (!chosen && !force)) continue;
      choices.push({ kind: 'control', element: wanted[0], current: chosen ? language(label(chosen)) : null });
    }
  }

  // A hidden copy has no layout, so a page's desktop and mobile copies of the
  // same switch both count as visible. Copies that agree are one control.
  if (!requireLayout && !ambiguous && choices.length > 1 &&
      choices.every(choice => choice.kind === 'control' && choice.current === choices[0].current)) {
    choices.splice(1);
  }
  if (ambiguous || choices.length !== 1) {
    return selectionError('Multiple or ambiguous Sub/Dub controls are available.');
  }
  const choice = choices[0];
  if (!force && choice.current !== previous) {
    return selectionError(`The current language is not an unambiguous ${previous === 'sub' ? 'Sub' : 'Dub'} selection.`);
  }

  try {
    if (choice.kind === 'select') {
      // selectedIndex preserves the exact option when a page reuses values;
      // value still follows the native select contract for controlled UIs.
      choice.select.value = choice.option.value;
      choice.select.selectedIndex = choice.option.index;
      const EventConstructor = doc.defaultView?.Event ?? Event;
      choice.select.dispatchEvent(new EventConstructor('input', { bubbles: true }));
      choice.select.dispatchEvent(new EventConstructor('change', { bubbles: true }));
    } else {
      if (!canActivateWithoutNavigation(choice.element)) {
        return selectionError(`The ${target === 'dub' ? 'Dub' : 'Sub'} control is not a safe non-navigating control.`);
      }
      (choice.element as HTMLElement).click();
    }
    return { ok: true };
  } catch (error) {
    return selectionError(error instanceof Error ? error.message : String(error));
  }
}

export function selectDub(doc: Document): { ok: boolean; error?: string } {
  return selectLanguage(doc, 'dub');
}

export function selectSub(doc: Document): { ok: boolean; error?: string } {
  return selectLanguage(doc, 'sub');
}

/**
 * Hosted pages only: select Dub with any supported control, including popup
 * menus that must be opened first. `force` clicks Dub even when the page never
 * says which language is selected; the caller must then confirm the switch by
 * seeing a new video load.
 */
export async function selectDubInteractive(doc: Document, force = false): Promise<{ ok: boolean; error?: string; at?: number; confirmed?: boolean; already?: boolean }> {
  // Standard controls first (a native select); an error here clicked nothing.
  const standard = selectLanguage(doc, 'dub');
  if (standard.ok) return standard;
  if (languagePopups(doc).length) return selectFromPopup(doc, 'dub');
  if (menuButtons(doc).length) return selectFromMenuButton(doc, 'dub');
  if (detectLanguage(doc).audioControl) return selectFromAudioControl(doc);
  return force ? selectLanguage(doc, 'dub', true) : standard;
}

const MENU_ITEM = 'button,a,li,[tabindex],[role="menuitem"],[role="menuitemradio"],[role="option"]';

const MENU_CLASS = /drop|menu|trigger|select|picker|toggle|switch|pill/i;

/** A button that opens a list or cycles: menu markup, a dropdown-ish class on it
 * or its wrapper, or an icon (chevron) next to its label. A plain "Dub" link
 * button to a catalogue has none of these. */
function looksLikeMenu(element: Element): boolean {
  return element.hasAttribute('aria-haspopup') || element.hasAttribute('aria-expanded') ||
    MENU_CLASS.test(String(element.getAttribute('class') ?? '')) || MENU_CLASS.test(String(element.parentElement?.getAttribute('class') ?? '')) ||
    Boolean(element.querySelector('svg,i,[class*="icon"],[class*="chevron"],[class*="arrow"]')) || /[▾▼⌄˅]/.test(element.textContent ?? '');
}

/** Plain dropdowns: one button showing the current language ("Subbed ▾"),
 * whose list of choices only appears after a click. */
function menuButtons(doc: Document): Element[] {
  return oneReading(() => {
    // The label first: it is cheap, and almost no button names a language.
    const buttons = Array.from(doc.querySelectorAll('button,[role="button"]')).filter(element =>
      !element.matches(POPUP) && language(label(element)) && !/\d/.test(label(element)) &&
      visible(element) && enabled(element) && inPlayerContext(element) && looksLikeMenu(element) && staysInPage(element));
    // A lone one only: a visible pair is a switch, not a menu.
    return buttons.length === 1 && !Array.from(doc.querySelectorAll(MENU_ITEM)).some(item => {
      const kind = language(label(item));
      return kind && kind !== language(label(buttons[0])) && item !== buttons[0] && !buttons[0].contains(item) && visible(item);
    }) ? buttons : [];
  });
}

/** Visible elements labelled with a language, outermost of any nested copies. */
/** Clicking this can't navigate anywhere but (in a hidden copy) the copy itself. */
function staysInPage(element: Element): boolean {
  const link = element.closest('a[href]');
  if (link && !nonNavigatingLink(link) && !hostedSameSiteLink(link)) return false;
  const button = element.closest('button') as HTMLButtonElement | null;
  return !(button?.form && button.type !== 'button');
}

function languageItems(doc: Document, target: AvailableLanguage, exclude: Element): Element[] {
  return oneReading(() => {
    const items = Array.from(doc.querySelectorAll('body *')).filter(item =>
      item !== exclude && !exclude.contains(item) && item.children.length <= 4 && language(label(item)) === target &&
      visible(item) && enabled(item) && staysInPage(item) && inPlayerContext(item));
    return items.filter(item => !items.some(other => other !== item && other.contains(item)));
  });
}

async function selectFromMenuButton(doc: Document, target: AvailableLanguage): Promise<{ ok: boolean; error?: string; at?: number }> {
  const [button] = menuButtons(doc);
  if (language(label(button)) === target) return { ok: true };
  // Menu items are often plain <div>s: the choice is whatever Dub label appears
  // once the menu opens, not anything already on the page (episode badges…).
  const before = new Set(languageItems(doc, target, button));
  const find = () => languageItems(doc, target, button).filter(item => !before.has(item));
  const pressedAt = Date.now();
  press(button);
  // Some of these buttons just cycle: one click and the label reads Dub.
  const switched = () => language(label(button)) === target;
  for (const started = Date.now(); !find().length && !switched() && Date.now() - started < MENU_OPEN_TIMEOUT_MS;) await sleep(100);
  if (switched()) return { ok: true, at: pressedAt };
  let items = find();
  // Menus hidden only by opacity or transform count as visible before opening;
  // then the Dub choice is the one sitting beside the button.
  if (!items.length) items = languageItems(doc, target, button).filter(item => button.parentElement?.contains(item));
  if (items.length !== 1) return selectionError(items.length ? 'The language menu has more than one Dub choice.' : 'The language menu showed no Dub choice.');
  const at = Date.now();
  press(items[0]);
  return { ok: true, at };
}

function providerSelect(doc: Document): HTMLSelectElement | null {
  return oneReading(() => {
    const controls = Array.from(doc.querySelectorAll<HTMLSelectElement>('select')).filter(select =>
      /\b(?:provider|server)\b/i.test(label(select)) && visible(select) && enabled(select) && inPlayerContext(select));
    return controls.length === 1 && !controls[0].multiple ? controls[0] : null;
  });
}

export interface ProviderOption {
  label: string;
  selected: boolean;
}

/** Servers of the row in use: the current server's row, else the Dub row. */
function activeServerRow(doc: Document): { row: ServerRow; current: Element | null } | null {
  return oneReading(() => {
    const rows = serverRows(doc);
    if (!rows.length) {
      // One plain "Server:" row; the language switch lives elsewhere.
      // The label test first: it rules out nearly every element without layout work.
      const plain = Array.from(doc.querySelectorAll(ROW_LABEL_TAGS))
        .filter(element => anyRowLabel(element) && !rowLabel(element) && visible(element))
        .map(labeledButtons).filter((item): item is { row: Element; servers: Element[] } => Boolean(item));
      const unique = [...new Map(plain.map(item => [item.row, item])).values()];
      if (unique.length !== 1) return null;
      const row: ServerRow = { language: 'dub', servers: unique[0].servers };
      return { row, current: currentServer([row]) };
    }
    const current = currentServer(rows);
    const row = rowOf(rows, current) ?? rows.find(item => item.language === 'dub');
    return row ? { row, current } : null;
  });
}

/** List the options of the single accessible Provider/Server control, if any. */
export function listProviders(doc: Document): { ok: boolean; options?: ProviderOption[]; error?: string } {
  const select = providerSelect(doc);
  if (!select) {
    const active = activeServerRow(doc);
    if (!active) return selectionError('Could not identify one Provider or Server control.');
    return { ok: true, options: active.row.servers.map(server => ({ label: serverLabel(server), selected: server === active.current })) };
  }
  const options = Array.from(select.options)
    .filter(option => !option.disabled && !option.hidden && !option.closest('optgroup[disabled]') && clean(option.textContent))
    .map(option => ({ label: clean(option.textContent), selected: option.index === select.selectedIndex }));
  return { ok: true, options };
}

/** Select an exact accessible Provider/Server option label. */
export function selectProvider(doc: Document, provider: string): { ok: boolean; error?: string } {
  if (!provider.trim() || provider.length > 512) return selectionError('Invalid requested provider.');
  const select = providerSelect(doc);
  if (!select) {
    const active = activeServerRow(doc);
    const matches = active?.row.servers.filter(server => serverLabel(server) === provider) ?? [];
    if (matches.length !== 1) return selectionError(active ? 'The requested server is unavailable or ambiguous.' : 'Could not identify one Provider or Server control.');
    if (matches[0] !== active?.current) (matches[0] as HTMLElement).click();
    return { ok: true };
  }
  const options = Array.from(select.options).filter(option => !option.disabled && !option.hidden &&
    !option.closest('optgroup[disabled]') && clean(option.textContent) === provider);
  if (options.length !== 1) return selectionError('The requested provider is unavailable or ambiguous.');
  const option = options[0];
  if (select.selectedIndex === option.index) return { ok: true };
  try {
    select.value = option.value;
    select.selectedIndex = option.index;
    const EventConstructor = doc.defaultView?.Event ?? Event;
    select.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    select.dispatchEvent(new EventConstructor('change', { bubbles: true }));
    return { ok: true };
  } catch (error) {
    return selectionError(error instanceof Error ? error.message : String(error));
  }
}

const NOTICE = '[role="alert"],[role="alertdialog"],[role="dialog"],dialog[open]';
const MAX_NOTICE_LENGTH = 220;

/**
 * What the page is telling the viewer where its player is: an alert or dialog
 * inside the player area ("Stream limit reached", "Not available in your
 * region"). Site-wide dialogs (cookie banners, sign-up prompts) don't count.
 */
export function pageNotices(doc: Document): string[] {
  const found = new Set<string>();
  for (const element of Array.from(doc.querySelectorAll(NOTICE))) {
    if (!element.closest(PLAYER_AREA) || !visible(element)) continue;
    // The message without its buttons ("Try again"), one space between its parts.
    const text = textWithout(element, 'button,a,[role="button"]');
    if (text.length >= 8) found.add(text.length > MAX_NOTICE_LENGTH ? `${text.slice(0, MAX_NOTICE_LENGTH)}…` : text);
  }
  return [...found].slice(0, 2);
}

function candidate(raw: string | null, base: string, text: string): DubCandidate | null {
  // Values such as "dub" or provider IDs are not relative media/page URLs.
  if (!raw || !/^(?:https?:\/\/|\/|\.\.?\/|\?)/i.test(raw.trim())) return null;
  try {
    const url = new URL(raw, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    const kind = /\.(mp4|webm|mp3|m4a|wav|ogg|oga|ogv|aac|flac|m3u8)$/i.test(url.pathname) ? 'media' : 'page';
    return { url: url.href, kind, label: text || 'Dub' };
  } catch { return null; }
}

/** Read semantic controls only. Never click a control or infer a stream URL. */
export function detectLanguage(doc: Document): LanguageDetection {
  return oneReading(() => detectLanguageNow(doc));
}

function detectLanguageNow(doc: Document): LanguageDetection {
  const result: LanguageDetection = {
    pageUrl: doc.location?.href ?? doc.URL,
    language: 'unknown', available: [], dubCandidates: [], provider: null,
    evidence: [], reason: 'No supported Sub/Dub controls found near a player.',
  };
  const active = new Set<AvailableLanguage>();
  const available = new Set<AvailableLanguage>();
  const candidates = new Map<string, DubCandidate>();
  const providers = new Set<string>();
  const add = (element: Element, lang: AvailableLanguage, isSelected: boolean, rawUrl: string | null) => {
    available.add(lang);
    if (isSelected) {
      active.add(lang);
      result.evidence.push(`${element.tagName.toLowerCase()}: ${label(element).slice(0, 120)} selected`);
    }
    if (lang === 'dub') {
      const found = candidate(rawUrl, doc.baseURI, label(element));
      if (found) candidates.set(found.url, found);
    }
  };

  for (const select of Array.from(doc.querySelectorAll('select'))) {
    if (!visible(select) || !enabled(select) || !inPlayerContext(select)) continue;
    const name = label(select);
    if (/\b(?:provider|server)\b/i.test(name)) {
      const option = select.selectedOptions[0];
      if (option && !option.disabled && clean(option.textContent)) providers.add(clean(option.textContent));
      continue;
    }
    const options = Array.from(select.options).filter(option => !option.disabled && !option.hidden && !option.closest('optgroup[disabled]'));
    const recognized = options.map(option => ({ option, lang: language(label(option)) ?? language(option.value) }));
    const kinds = new Set(recognized.flatMap(item => item.lang ? [item.lang] : []));
    if (!(kinds.has('sub') && kinds.has('dub')) && !/\b(?:language|audio)\b/i.test(name)) continue;
    // A language select containing unrelated choices is not a binary Sub/Dub
    // signal unless its selected option itself explicitly names one.
    for (const { option, lang } of recognized) if (lang) add(option, lang, option.selected, option.getAttribute('value'));
  }

  const rows = serverRows(doc);
  if (rows.length) {
    for (const row of rows) available.add(row.language);
    const current = currentServer(rows);
    const row = rowOf(rows, current);
    if (current && row) {
      add(current, row.language, true, null);
      providers.add(serverLabel(current));
    }
  }

  for (const popup of languagePopups(doc)) {
    if (popup.current) add(popup.trigger, popup.current, true, null);
    // A closed menu only shows its current value; the other language is
    // confirmed when the hidden copy opens the menu.
    for (const lang of popup.offered ?? ['sub', 'dub'] as const) available.add(lang);
  }

  // The label first: it is cheap, and a page has thousands of links and
  // buttons of which a handful name a language. Peers below are only ever
  // compared by language, so controls without one never mattered here.
  const controls = Array.from(doc.querySelectorAll(CONTROL)).filter(element =>
    element.tagName !== 'SELECT' && !element.matches(POPUP) && language(label(element)) &&
    visible(element) && enabled(element) && inPlayerContext(element));
  for (const element of controls) {
    const lang = language(label(element));
    if (!lang) continue;
    const group = element.closest('[role="tablist"],[role="radiogroup"],fieldset') ?? element.parentElement;
    if (!group) continue;
    const peers = controls.filter(peer => group.contains(peer));
    const choices = new Set(peers.map(peer => language(label(peer))).filter(Boolean));
    if (!choices.has('sub') || !choices.has('dub')) continue;
    // Plain Dub links expose availability, not selection. Selection comes from
    // native checked or accessibility state, else from a styled button pair.
    const styled = pairable(element) &&
      styledSelection(peers.filter(peer => pairable(peer) && language(label(peer)))) === element;
    add(element, lang, selected(element) || styled, element.tagName === 'A' ? element.getAttribute('href') : null);
  }

  if (!available.size) {
    const [menu] = menuButtons(doc);
    if (menu) {
      // The button shows the current choice; the other one is in its list.
      add(menu, language(label(menu)) as AvailableLanguage, true, null);
      available.add('sub');
      available.add('dub');
    }
  }

  // Last, and only when the page has no Sub/Dub control at all: audio by language.
  let audioUnread = false;
  if (!available.size) {
    const audio = audioState(doc);
    if (audio) {
      result.audioControl = true;
      audioUnread = audio.current === null;
      if (audio.current && audio.element) add(audio.element, audio.current, true, null);
      else if (audio.current) { available.add(audio.current); active.add(audio.current); }
      available.add('sub');
      if (audio.hasDub) available.add('dub');
    }
  }

  if (!providers.size) {
    const servers = activeServerRow(doc);
    if (servers?.current) providers.add(serverLabel(servers.current));
  }

  result.available = (['sub', 'dub'] as const).filter(item => available.has(item));
  result.dubCandidates = [...candidates.values()];
  result.provider = providers.size === 1 ? [...providers][0] : null;
  result.evidence = [...new Set(result.evidence)];
  if (active.size === 1) {
    result.language = [...active][0];
    result.reason = 'Selected language is exposed by the page controls.';
  } else if (active.size > 1) {
    result.reason = 'Conflicting selected language controls; choose a single player.';
  } else if (languageFromUrl(result.pageUrl) && doc.body && playersIn(doc.body).length) {
    // No control says which is selected, but the address does.
    result.language = languageFromUrl(result.pageUrl) as AvailableLanguage;
    result.available = ['sub', 'dub'];
    result.reason = 'Selected language is named in the page address.';
  } else if (available.size) {
    result.reason = audioUnread
      ? 'This player chooses audio by language in a menu; SubView reads it in its hidden copy.'
      : 'Sub/Dub options exist, but no unambiguous selected state is exposed.';
    if (available.has('sub') && available.has('dub')) result.stateUnclear = true;
  }
  return result;
}

/**
 * Busy pages (animated players, live feeds) mutate many times a second. One
 * reading per this many milliseconds is plenty for a control a person clicks,
 * and keeps the page's own main thread free.
 */
const OBSERVE_DELAY_MS = 150;

/** Observe only; document events/mutations drive updates, not polling timers. */
export function observeLanguage(doc: Document, callback: (result: LanguageDetection) => void): () => void {
  let previous = '';
  let stopped = false;
  let suspended = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const emit = () => {
    if (stopped || suspended) return;
    const result = detectLanguage(doc);
    const signature = JSON.stringify(result);
    if (signature === previous) return;
    previous = signature;
    callback(result);
  };
  // Changes gather for a moment, then one reading covers them all. The wait
  // starts at the first change and is not pushed back by later ones, so a
  // page that never stops changing is still read.
  const schedule = () => {
    if (stopped || suspended || timer !== null) return;
    timer = setTimeout(() => { timer = null; emit(); }, OBSERVE_DELAY_MS);
  };
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const relevant = (node: Node): boolean => {
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    return Boolean(element && (element.matches(`${CONTROL},${POPUP},${PLAYER},${AUDIO_GROUP},${AUDIO_OPTION},option,label`) || element.closest(`${CONTROL},${POPUP},${AUDIO_GROUP}`) || element.querySelector(`${CONTROL},${POPUP},${PLAYER},${AUDIO_GROUP}`)));
  };
  const observer = new MutationObserver(records => {
    // A reading is already on its way: it will see these changes too.
    if (stopped || suspended || timer !== null) return;
    if (records.some(record => relevant(record.target) || [...record.addedNodes, ...record.removedNodes].some(relevant))) schedule();
  });
  const connect = () => observer.observe(doc, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['aria-selected', 'aria-checked', 'aria-pressed', 'aria-current', 'checked', 'selected', 'value', 'href', 'disabled', 'hidden', 'inert', 'aria-hidden', 'style', 'class', 'src', 'aria-label', 'aria-labelledby', 'label', 'type', 'name', 'role'],
  });
  const hide = () => { suspended = true; observer.disconnect(); cancel(); };
  const show = () => { if (!stopped) { suspended = false; connect(); schedule(); } };
  doc.addEventListener('change', schedule, true);
  doc.addEventListener('input', schedule, true);
  doc.addEventListener('click', schedule, true);
  doc.defaultView?.addEventListener('popstate', schedule);
  doc.defaultView?.addEventListener('hashchange', schedule);
  doc.defaultView?.addEventListener('resize', schedule);
  doc.defaultView?.addEventListener('pagehide', hide);
  doc.defaultView?.addEventListener('pageshow', show);
  connect();
  emit();
  return () => {
    stopped = true;
    cancel();
    observer.disconnect();
    doc.removeEventListener('change', schedule, true);
    doc.removeEventListener('input', schedule, true);
    doc.removeEventListener('click', schedule, true);
    doc.defaultView?.removeEventListener('popstate', schedule);
    doc.defaultView?.removeEventListener('hashchange', schedule);
    doc.defaultView?.removeEventListener('resize', schedule);
    doc.defaultView?.removeEventListener('pagehide', hide);
    doc.defaultView?.removeEventListener('pageshow', show);
  };
}

