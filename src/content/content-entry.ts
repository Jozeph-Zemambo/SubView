import type { ContentRequest, SelectProviderContentRequest, Side, VideoCommand } from "../shared/types";
import { probeVideos } from "./video-probe";
import { VideoController, type ContentControllerResponse } from "./video-controller";
import { detectLanguage, observeLanguage, selectDub, selectSub, selectProvider } from "./language-detection";
import { capturePlayerState, isPlayerState, restorePlayerState } from "./player-state";

const CONTENT_STATE_KEY = "__subview4dub_content_entry_state_v1";

interface ContentEntryState {
  controller: VideoController;
  listenerInstalled: boolean;
  stopLanguageObserver?: () => void;
  /**
   * The worker let this page go (STOP_LANGUAGE_DETECTION_CONTENT): nothing here
   * is watched any more, so this frame's media changes have no one to tell.
   */
  released?: boolean;
}

type SetMutedContentRequest = {
  type: "SET_MUTED";
  pairId: string;
  muted: boolean;
};

type SelectDubContentRequest = {
  type: "SELECT_DUB_CONTENT";
};

type SelectSubContentRequest = {
  type: "SELECT_SUB_CONTENT";
};

type ContentEntryRequest = ContentRequest | SetMutedContentRequest | SelectDubContentRequest | SelectSubContentRequest | SelectProviderContentRequest;

type GlobalWithContentState = typeof globalThis & {
  [CONTENT_STATE_KEY]?: ContentEntryState;
};

function isSide(value: unknown): value is Side {
  return value === "primary" || value === "secondary";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isVideoCommand(value: unknown): value is VideoCommand {
  return (
    isRecord(value) &&
    typeof value.commandId === "string" &&
    typeof value.pairId === "string" &&
    isSide(value.side) &&
    typeof value.revision === "number" &&
    (value.targetTimeMs === null || typeof value.targetTimeMs === "number") &&
    typeof value.playbackRate === "number" &&
    typeof value.shouldPlay === "boolean" &&
    typeof value.forceSeek === "boolean"
  );
}

function isVolume(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isContentRequest(value: unknown): value is ContentEntryRequest {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "PROBE") return true;
  if (value.type === "DEACTIVATE") return typeof value.pairId === "string";
  if (value.type === "SET_MUTED") {
    return typeof value.pairId === "string" && typeof value.muted === "boolean";
  }
  if (value.type === "SET_VOLUME") {
    return typeof value.pairId === "string" && isVolume(value.volume);
  }
  if (value.type === "SELECT_DUB_CONTENT") return true;
  if (value.type === "SELECT_SUB_CONTENT") return true;
  if (value.type === "SELECT_PROVIDER_CONTENT") return typeof value.provider === "string" && value.provider.trim().length > 0 && value.provider.length <= 512;
  if (value.type === "COMMAND") return isVideoCommand(value.command);
  return (
    value.type === "ACTIVATE" &&
    typeof value.pairId === "string" &&
    isSide(value.side) &&
    typeof value.videoId === "string" &&
    typeof value.revision === "number"
  );
}

function responseForRequest(request: ContentEntryRequest, controller: VideoController): ContentControllerResponse | { ok: boolean; videos?: ReturnType<typeof probeVideos>; error?: string } {
  switch (request.type) {
    case "PROBE":
      return { ok: true, videos: probeVideos() };
    case "ACTIVATE":
      return controller.activate(request.pairId, request.side, request.videoId, request.revision);
    case "DEACTIVATE":
      return controller.deactivate(request.pairId);
    case "SET_MUTED":
      return controller.setMuted(request.pairId, request.muted);
    case "SET_VOLUME":
      return controller.setVolume(request.pairId, request.volume);
    case "SELECT_DUB_CONTENT":
      return selectDub(document);
    case "SELECT_SUB_CONTENT":
      return selectSub(document);
    case "SELECT_PROVIDER_CONTENT":
      return selectProvider(document, request.provider);
    case "COMMAND":
      return controller.applyCommand(request.command);
    default:
      return { ok: false, error: "Unsupported content request" };
  }
}

function installContentEntry(): ContentEntryState {
  const globalScope = globalThis as GlobalWithContentState;
  const existing = globalScope[CONTENT_STATE_KEY];
  const state =
    existing ??
    ({
      controller: new VideoController(),
      listenerInstalled: false,
    } satisfies ContentEntryState);
  globalScope[CONTENT_STATE_KEY] = state;

  if (state.listenerInstalled) return state;

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    // Readiness is event-driven: Auto Dub may be armed before an embedded
    // player has loaded metadata. No polling or arbitrary retry delay.
    const mediaChanged = (event: Event) => {
      if (state.released) return;
      if (!(event.target instanceof HTMLVideoElement) && !(event.target instanceof HTMLIFrameElement)) return;
      try {
        void chrome.runtime.sendMessage({ type: "AUTO_DUB_MEDIA_CHANGED", event: event.type }).catch(() => undefined);
      } catch { /* An extension reload invalidates this context. */ }
    };
    for (const event of ["loadedmetadata", "canplay", "emptied", "load"]) {
      document.addEventListener(event, mediaChanged, true);
    }
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (isRecord(message) && message.type === "STOP_LANGUAGE_DETECTION_CONTENT") {
        if (sender.id !== chrome.runtime.id || sender.tab !== undefined) {
          sendResponse({ ok: false, error: "Unauthorized content request" });
          return false;
        }
        state.stopLanguageObserver?.();
        state.stopLanguageObserver = undefined;
        state.released = true;
        sendResponse({ ok: true });
        return false;
      }
      if (isRecord(message) && message.type === "GET_LANGUAGE_DETECTION_CONTENT") {
        state.released = false;
        if (!state.stopLanguageObserver) {
          state.stopLanguageObserver = observeLanguage(document, detection => {
            try {
              void chrome.runtime.sendMessage({ type: "LANGUAGE_DETECTION_EVENT", detection }).catch(() => {
                // Extension reload invalidates old content contexts.
                if (!chrome.runtime?.id) state.stopLanguageObserver?.();
              });
            } catch { state.stopLanguageObserver?.(); }
          });
        }
        sendResponse({ ok: true, detection: detectLanguage(document) });
        return false;
      }
      if (isRecord(message) && (message.type === "SELECT_DUB_CONTENT" || message.type === "SELECT_SUB_CONTENT" || message.type === "SELECT_PROVIDER_CONTENT") &&
          (sender.id !== chrome.runtime.id || sender.tab !== undefined)) {
        sendResponse({ ok: false, error: "Unauthorized content request" });
        return false;
      }
      // Worker only, and answered later: reading or pressing the player's menus takes a moment.
      if (isRecord(message) && (message.type === "CAPTURE_PLAYER_STATE" || message.type === "RESTORE_PLAYER_STATE")) {
        if (sender.id !== chrome.runtime.id || sender.tab !== undefined || typeof message.videoId !== "string") {
          sendResponse({ ok: false, error: "Unauthorized content request" });
          return false;
        }
        const work = message.type === "CAPTURE_PLAYER_STATE"
          ? capturePlayerState(document, message.videoId).then(found => ({ ok: found !== null, state: found }))
          : isPlayerState(message.state)
            ? restorePlayerState(document, message.videoId, message.state).then(result => ({ ok: true, ...result }))
            : Promise.resolve({ ok: false, error: "Nothing to put back." });
        void work.then(sendResponse, error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        return true;
      }
      if (!isContentRequest(message)) {
        sendResponse({ ok: false, error: "Unsupported content request" });
        return false;
      }

      try {
        sendResponse(responseForRequest(message, state.controller));
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return false;
    });
    state.listenerInstalled = true;
  }

  return state;
}

export const contentController = installContentEntry().controller;
