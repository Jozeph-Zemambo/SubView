// Tells the popup when a newer SubView release exists. Only for copies loaded
// from a folder: a store-installed copy is updated by the browser.
//
// The only thing sent is a plain request for this project's latest release
// (no identifiers, nothing about the user), at most once a day, and only when
// the popup is opened.

import { isExtensionUiSender, isRecord } from "../shared/messages";
import { CHECK_INTERVAL_MS, LATEST_RELEASE_API, noticeFor, RETRY_INTERVAL_MS, type UpdateNotice } from "../shared/update";

const KEY = "updateCheck";
const REQUEST_TIMEOUT_MS = 8_000;

interface Stored {
  /** When GitHub may be asked again (epoch ms). */
  nextCheckAt: number;
  version: string | null;
  url: string | null;
}

function normalize(value: unknown): Stored {
  const record = isRecord(value) ? value : {};
  return {
    nextCheckAt: typeof record.nextCheckAt === "number" && Number.isFinite(record.nextCheckAt) ? record.nextCheckAt : 0,
    version: typeof record.version === "string" ? record.version : null,
    url: typeof record.url === "string" ? record.url : null,
  };
}

async function latestRelease(): Promise<{ version: string; url: string } | null> {
  const response = await fetch(LATEST_RELEASE_API, {
    headers: { accept: "application/vnd.github+json" },
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.tag_name !== "string" || typeof body.html_url !== "string") return null;
  return { version: body.tag_name, url: body.html_url };
}

let running: Promise<UpdateNotice | null> | null = null;

async function check(): Promise<UpdateNotice | null> {
  const self = await chrome.management.getSelf();
  if (self.installType !== "development") return null;
  const current = chrome.runtime.getManifest().version;
  let stored = normalize((await chrome.storage.local.get(KEY) as Record<string, unknown>)[KEY]);
  const now = Date.now();
  // A clock moved backwards must not postpone the check forever.
  if (now >= stored.nextCheckAt || stored.nextCheckAt > now + CHECK_INTERVAL_MS) {
    const release = await latestRelease().catch(() => null);
    stored = release
      ? { nextCheckAt: now + CHECK_INTERVAL_MS, version: release.version, url: release.url }
      : { ...stored, nextCheckAt: now + RETRY_INTERVAL_MS };
    await chrome.storage.local.set({ [KEY]: stored }).catch(() => undefined);
  }
  return noticeFor(stored, current);
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRecord(message) || message.type !== "GET_UPDATE") return false;
  if (!isExtensionUiSender(sender)) return false;
  // Two popups opened together share one check.
  running ??= check().finally(() => { running = null; });
  running.then(
    update => sendResponse({ ok: true, update }),
    () => sendResponse({ ok: true, update: null }),
  );
  return true;
});
