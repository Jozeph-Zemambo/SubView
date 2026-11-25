import { CONTENT_SCRIPT_PATH, isExtensionUiSender, isRecord } from "../shared/messages";
import type { LanguageDetection } from "../shared/language-detection";
import { siteKey } from "../shared/auto-dub-sites";

// Watch only explicitly inspected tabs and Auto Dub's owned lookup tabs.
// This host observes controls; the separate discovery flow selects Dub.
const KEY = "languageDetectionTabs";
const watched = new Map<number, string | null>();
/** The document last inspected in each tab; kept across address changes to tell whether the page itself is still there. */
const lastDocument = new Map<number, string>();
/**
 * Chrome reports an address change made by the page's own router exactly like
 * the start of a page load. What tells them apart is whether the document
 * that was there is still there to answer.
 */
async function documentAlive(tabId: number, documentId: string | undefined): Promise<boolean> {
  if (!documentId) return false;
  try { await chrome.tabs.sendMessage(tabId, { type: "PROBE" }, { documentId }); return true; }
  catch { return false; }
}
/** The site each watched tab was on when last inspected; leaving it ends the watch (see `keepLanguageWatch`). */
const watchedSite = new Map<number, string | null>();
/**
 * Says whether a watched tab stays watched when it moves to another site.
 * Auto Dub keeps its armed tab: it moves with the viewer between sites it is
 * on for, and lets the tab go itself (`unwatchLanguage`) when it detaches.
 */
let keepsWatch: (tabId: number) => boolean = () => false;
export function keepLanguageWatch(keep: (tabId: number) => boolean): void {
  keepsWatch = keep;
}
const generations = new Map<number, number>();
const inspections = new Map<number, { generation: number; promise: Promise<LanguageDetection> }>();
let writes = Promise.resolve();
export class SupersededInspection extends Error {}
const subscribers = new Set<(tabId: number, detection: LanguageDetection) => void>();
export function onLanguageDetection(listener: (tabId: number, detection: LanguageDetection) => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}
const restored = chrome.storage.session.get(KEY).then((stored) => {
  const entries = stored[KEY];
  if (Array.isArray(entries)) for (const entry of entries) {
    if (Array.isArray(entry) && Number.isInteger(entry[0]) && entry[0] >= 0 &&
        (entry[1] === null || typeof entry[1] === "string")) {
      watched.set(entry[0], entry[1]);
      if (typeof entry[1] === "string") lastDocument.set(entry[0], entry[1]);
    }
  }
}).catch(() => undefined);

function save(): Promise<void> {
  const entries = [...watched];
  writes = writes.catch(() => undefined).then(() => chrome.storage.session.set({ [KEY]: entries }));
  return writes;
}

function unknown(pageUrl: string, reason: string): LanguageDetection {
  return { pageUrl, language: "unknown", available: [], dubCandidates: [], provider: null, evidence: [], reason };
}

function validDetection(value: unknown): value is LanguageDetection {
  if (!isRecord(value)) return false;
  return typeof value.pageUrl === "string" &&
    ["sub", "dub", "unknown"].includes(String(value.language)) &&
    Array.isArray(value.available) && value.available.every(v => v === "sub" || v === "dub") &&
    Array.isArray(value.dubCandidates) && value.dubCandidates.every(v => {
      if (!isRecord(v) || typeof v.url !== "string" || typeof v.label !== "string" ||
          (v.kind !== "page" && v.kind !== "media")) return false;
      try { const url = new URL(v.url); return /^https?:$/.test(url.protocol) && !url.username && !url.password; }
      catch { return false; }
    }) && (value.provider === null || typeof value.provider === "string") &&
    Array.isArray(value.evidence) && value.evidence.every(v => typeof v === "string") &&
    typeof value.reason === "string";
}

async function broadcast(tabId: number, detection: LanguageDetection): Promise<void> {
  for (const listener of subscribers) listener(tabId, detection);
  try { await chrome.runtime.sendMessage({ type: "LANGUAGE_DETECTION_UPDATE", tabId, detection }); }
  catch { /* The popup may be closed. */ }
}

export async function inspectLanguage(tabId: number, expectedGeneration?: number): Promise<LanguageDetection> {
  await restored;
  // A generation identifies a page lifecycle, not an inspection request.
  // Popup scans, navigation completion and Dub lookup can all ask together.
  const generation = generations.get(tabId) ?? 0;
  // Asked for a page lifecycle that has already ended (the tab was let go meanwhile): don't start watching again.
  if (expectedGeneration !== undefined && expectedGeneration !== generation) {
    throw new SupersededInspection("The page changed during detection. Scan again.");
  }
  const pending = inspections.get(tabId);
  if (pending?.generation === generation) return pending.promise;
  const promise = inspectDocument(tabId, generation).finally(() => {
    if (inspections.get(tabId)?.promise === promise) inspections.delete(tabId);
  });
  inspections.set(tabId, { generation, promise });
  return promise;
}

async function inspectDocument(tabId: number, generation: number): Promise<LanguageDetection> {
  const assertCurrent = () => {
    if ((generations.get(tabId) ?? 0) !== generation) {
      throw new SupersededInspection("The page changed during detection. Scan again.");
    }
  };
  watched.set(tabId, null);
  await save();
  assertCurrent();
  const tab = await chrome.tabs.get(tabId);
  assertCurrent();
  if (!tab.url || !/^https?:\/\//.test(tab.url)) throw new Error("Language detection requires an HTTP(S) watch page.");
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] }, files: [CONTENT_SCRIPT_PATH],
  });
  const documentId = results.find(result => result.frameId === 0)?.documentId;
  assertCurrent();
  if (!documentId) throw new Error("The page returned no document identifier.");
  watched.set(tabId, documentId);
  lastDocument.set(tabId, documentId);
  watchedSite.set(tabId, siteKey(tab.url));
  await save();
  assertCurrent();
  const response: unknown = await chrome.tabs.sendMessage(tabId,
    { type: "GET_LANGUAGE_DETECTION_CONTENT" }, { documentId });
  assertCurrent();
  if (!isRecord(response) || response.ok !== true || !validDetection(response.detection)) {
    throw new Error("The page returned no language detection result.");
  }
  if (response.detection.pageUrl !== tab.url) {
    throw new SupersededInspection("The page changed during detection. Scan again.");
  }
  await broadcast(tabId, response.detection);
  assertCurrent();
  return response.detection;
}

/** Forget a tab: any inspection in flight for it is superseded. */
function forget(tabId: number): void {
  generations.set(tabId, (generations.get(tabId) ?? 0) + 1);
  watched.delete(tabId);
  lastDocument.delete(tabId);
  watchedSite.delete(tabId);
}

/** Best effort: the page may be gone, mid-load, or never have had the observer. */
function stopContentObserver(tabId: number): void {
  try {
    void chrome.tabs.sendMessage(tabId, { type: "STOP_LANGUAGE_DETECTION_CONTENT" }, { frameId: 0 }).catch(() => undefined);
  } catch { /* No such tab. */ }
}

/**
 * Stop watching a tab: its page stops observing its controls, and later page
 * loads in it are not inspected. Nothing is done for a tab that isn't watched.
 */
export async function unwatchLanguage(tabId: number): Promise<void> {
  await restored;
  if (!watched.has(tabId) && !inspections.has(tabId)) return;
  forget(tabId);
  // Sent before any later inspection of the same tab can message the page, so it can't stop a newer observer.
  stopContentObserver(tabId);
  await save().catch(() => undefined);
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRecord(message)) return false;
  if (message.type === "GET_LANGUAGE_DETECTION") {
    // Requests originate in extension UI, never in a page's content script.
    if (!isExtensionUiSender(sender)) return false;
    if (!Number.isInteger(message.tabId) || (message.tabId as number) < 0) {
      sendResponse({ ok: false, error: "Invalid detection tab." }); return false;
    }
    void inspectLanguage(message.tabId as number).then(
      detection => sendResponse({ ok: true, detection }),
      error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  if (message.type !== "LANGUAGE_DETECTION_EVENT" || !validDetection(message.detection)) return false;
  const tabId = sender.tab?.id;
  if (sender.id !== chrome.runtime.id || tabId === undefined || sender.frameId !== 0 || !sender.documentId) return false;
  const detection = message.detection;
  void restored.then(async () => {
    if (watched.get(tabId) !== sender.documentId) return;
    const tab = await chrome.tabs.get(tabId);
    if (tab.url !== detection.pageUrl || watched.get(tabId) !== sender.documentId) return;
    await broadcast(tabId, detection);
  }).catch(() => undefined);
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  void restored.then(async () => {
    if (!watched.has(tabId)) return;
    // Left the site it was inspected on: a scan there says nothing about this
    // page, and the viewer never asked about this site. Let the tab go.
    const url = change.url ?? (change.status === "complete" ? tab.url : undefined);
    if (url !== undefined && watchedSite.has(tabId) && siteKey(url) !== watchedSite.get(tabId) && !keepsWatch(tabId)) {
      forget(tabId);
      await save();
      await broadcast(tabId, unknown(url, "This tab moved to another site. Scan again to check it."));
      return;
    }
    if (change.status === "loading" || change.url !== undefined) {
      generations.set(tabId, (generations.get(tabId) ?? 0) + 1);
      watched.set(tabId, null);
      await save();
      // The page itself stays loaded when only its address changed (see LanguageDetection.addressOnly).
      const addressOnly = change.url !== undefined && await documentAlive(tabId, lastDocument.get(tabId));
      await broadcast(tabId, { ...unknown(tab.url ?? "", "Page changed; checking language controls…"), placeholder: addressOnly ? "address" : "load" });
    }
    // A URL-only update covers SPA pushState/replaceState without patching the
    // site's history methods or polling. Full navigations wait for completion.
    if (change.status === "complete" || (change.url !== undefined && tab.status === "complete")) {
      // Only this page lifecycle: a tab let go meanwhile is not taken back.
      if (!watched.has(tabId)) return;
      try { await inspectLanguage(tabId, generations.get(tabId) ?? 0); }
      catch (error) {
        if (error instanceof SupersededInspection || !watched.has(tabId)) return;
        await broadcast(tabId, unknown(tab.url ?? "", error instanceof Error ? error.message : "Detection unavailable."));
      }
    }
  }).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener(tabId => {
  void restored.then(async () => {
    forget(tabId);
    await save();
  }).catch(() => undefined);
});
