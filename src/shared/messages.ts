export const STORAGE_KEY = "activeSyncState";

export const CONTENT_SCRIPT_PATH = "content/content-entry.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


/** Extension pages allowed to drive Auto Dub and detection: the popup and its debug tools page. */
export const UI_PAGES = ["popup.html", "debug.html"];

export function isExtensionUiSender(sender: chrome.runtime.MessageSender): boolean {
  // Compare the page itself: the popup can carry a query (popup.html?tab=…).
  const page = sender.url?.split(/[?#]/, 1)[0];
  return sender.id === chrome.runtime.id && UI_PAGES.some(name => page === chrome.runtime.getURL(name));
}
