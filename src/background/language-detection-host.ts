import { CONTENT_SCRIPT_PATH, isExtensionUiSender, isRecord } from "../shared/messages";
import type { LanguageDetection } from "../shared/language-detection";

// Watch only explicitly inspected tabs and Auto Dub's owned lookup tabs.
// This host observes controls; the separate discovery flow selects Dub.
const KEY = "languageDetectionTabs";
const watched = new Map<number, string | null>();
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
        (entry[1] === null || typeof entry[1] === "string")) watched.set(entry[0], entry[1]);
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

export async function inspectLanguage(tabId: number): Promise<LanguageDetection> {
  await restored;
  // A generation identifies a page lifecycle, not an inspection request.
  // Popup scans, navigation completion and Dub lookup can all ask together.
  const generation = generations.get(tabId) ?? 0;
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
    if (change.status === "loading" || change.url !== undefined) {
      generations.set(tabId, (generations.get(tabId) ?? 0) + 1);
      watched.set(tabId, null);
      await save();
      await broadcast(tabId, unknown(tab.url ?? "", "Page changed; checking language controls…"));
    }
    // A URL-only update covers SPA pushState/replaceState without patching the
    // site's history methods or polling. Full navigations wait for completion.
    if (change.status === "complete" || (change.url !== undefined && tab.status === "complete")) {
      try { await inspectLanguage(tabId); }
      catch (error) {
        if (error instanceof SupersededInspection || !watched.has(tabId)) return;
        await broadcast(tabId, unknown(tab.url ?? "", error instanceof Error ? error.message : "Detection unavailable."));
      }
    }
  }).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener(tabId => {
  void restored.then(async () => {
    generations.set(tabId, (generations.get(tabId) ?? 0) + 1);
    watched.delete(tabId);
    await save();
  }).catch(() => undefined);
});
