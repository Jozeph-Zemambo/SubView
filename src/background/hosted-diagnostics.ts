// Debug tools: describe the page SubView is hosting right now, frame by frame.
// Read-only, and answered only to SubView's own pages.
//
// From the Debug tools page's console:
//   chrome.runtime.sendMessage({ type: "SET_HOSTED_DEBUG", enabled: true })   // record a trail in hosted pages
//   chrome.runtime.sendMessage({ type: "DESCRIBE_HOSTED" })                    // while a hidden copy is open

import { isExtensionUiSender, isRecord } from "../shared/messages";
import { currentHost, HOSTED_DEBUG_KEY, hostedFrames, hostedRequest, refusedConnections } from "./hosted-host";

const DESCRIBE_TIMEOUT_MS = 3_000;

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRecord(message) || (message.type !== "DESCRIBE_HOSTED" && message.type !== "SET_HOSTED_DEBUG")) return false;
  if (!isExtensionUiSender(sender)) return false;
  if (message.type === "SET_HOSTED_DEBUG") {
    // Takes effect for the next hidden copy that is opened.
    void chrome.storage.local.set({ [HOSTED_DEBUG_KEY]: message.enabled === true })
      .then(() => sendResponse({ ok: true, enabled: message.enabled === true }), error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  void (async () => {
    const host = currentHost();
    const frames = await Promise.all(hostedFrames().map(async frame => ({
      depth: frame.depth,
      connectedAt: frame.connectedAt,
      ...await hostedRequest(frame.key, { type: "DESCRIBE" }, DESCRIBE_TIMEOUT_MS)
        .then(response => isRecord(response) ? response : { ok: false, error: "No answer." })
        .catch(error => ({ ok: false, href: frame.href, error: error instanceof Error ? error.message : String(error) })),
    })));
    return { ok: true, host: host ? { kind: host.kind, pageUrl: host.pageUrl } : null, frames, refused: refusedConnections.slice(-5) };
  })().then(sendResponse, error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
