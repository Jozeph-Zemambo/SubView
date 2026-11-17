/** The secondary media endpoint lives in an extension document, not a tab. */
export const OFFSCREEN_TAB_ID = -1;
export const OFFSCREEN_PATH = "offscreen.html";

export function validMediaUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

export async function hasOffscreenPlayer(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

// Calls are serialized by the worker's operation queue.
export async function createOffscreenPlayer(): Promise<void> {
  if (await hasOffscreenPlayer()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    // IFRAME_SCRIPTING: Auto Dub hosts the episode page here. With only
    // AUDIO_PLAYBACK, Chrome closes the document after 30 s without audio,
    // which a paused hosted page would hit.
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.IFRAME_SCRIPTING],
    justification: "Play Dub audio synchronized with the user's visible video, from a media URL or a hosted copy of the episode page.",
  });
}

export async function offscreenRequest(message: object): Promise<unknown> {
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

export async function closeOffscreenPlayer(): Promise<void> {
  if (await hasOffscreenPlayer()) await chrome.offscreen.closeDocument();
}
