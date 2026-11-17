import { isRecord } from "../shared/messages";
import Hls, { type ErrorData } from "hls.js";
import { formatHlsFailure } from "./hls-failure";
import type {
  ContentEventMessage,
  ContentRequest,
  Side,
  VideoCommand,
} from "../shared/types";
import { mountHostedPage, unmountHostedPage } from "../host/mount";
import { probeVideos } from "../content/video-probe";
import { VideoController, type ContentControllerResponse } from "../content/video-controller";

const OFFSCREEN_TARGET = "offscreen" as const;

interface ActiveSelection {
  pairId: string;
  side: Side;
  videoId: string;
  revision: number;
}

interface OffscreenLoadMessage {
  target: typeof OFFSCREEN_TARGET;
  type: "OFFSCREEN_LOAD";
  url: string;
  volume: number;
}

interface OffscreenContentMessage {
  target: typeof OFFSCREEN_TARGET;
  type: "OFFSCREEN_CONTENT";
  request: ContentRequest;
}

interface OffscreenVolumeMessage {
  target: typeof OFFSCREEN_TARGET;
  type: "OFFSCREEN_VOLUME";
  volume: number;
}

interface OffscreenStopMessage {
  target: typeof OFFSCREEN_TARGET;
  type: "OFFSCREEN_STOP";
}

/** Host an episode page for Auto Dub (see host/mount.ts). */
interface OffscreenHostMessage {
  target: typeof OFFSCREEN_TARGET;
  type: "OFFSCREEN_HOST";
  url: string;
}

interface OffscreenUnhostMessage {
  target: typeof OFFSCREEN_TARGET;
  type: "OFFSCREEN_UNHOST";
}

type OffscreenMessage =
  | OffscreenLoadMessage
  | OffscreenContentMessage
  | OffscreenVolumeMessage
  | OffscreenStopMessage
  | OffscreenHostMessage
  | OffscreenUnhostMessage;

interface OffscreenResponse {
  ok: boolean;
  error?: string;
  videoId?: string;
  videos?: ReturnType<typeof probeVideos>;
}

function isSide(value: unknown): value is Side {
  return value === "primary" || value === "secondary";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isVideoCommand(value: unknown): value is VideoCommand {
  return (
    isRecord(value) &&
    typeof value.commandId === "string" &&
    typeof value.pairId === "string" &&
    isSide(value.side) &&
    isFiniteNumber(value.revision) &&
    (value.targetTimeMs === null || isFiniteNumber(value.targetTimeMs)) &&
    isFiniteNumber(value.playbackRate) &&
    typeof value.shouldPlay === "boolean" &&
    typeof value.forceSeek === "boolean"
  );
}

function isVolume(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isContentRequest(value: unknown): value is ContentRequest {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "PROBE") return true;
  if (value.type === "DEACTIVATE") return typeof value.pairId === "string";
  if (value.type === "SET_MUTED") {
    return typeof value.pairId === "string" && typeof value.muted === "boolean";
  }
  if (value.type === "SET_VOLUME") {
    return typeof value.pairId === "string" && isVolume(value.volume);
  }
  if (value.type === "COMMAND") return isVideoCommand(value.command);
  return (
    value.type === "ACTIVATE" &&
    typeof value.pairId === "string" &&
    isSide(value.side) &&
    typeof value.videoId === "string" &&
    isFiniteNumber(value.revision)
  );
}

function isHttpMediaUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function isHlsUrl(value: string): boolean {
  try {
    return /\.m3u8$/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function isOffscreenMessage(value: unknown): value is OffscreenMessage {
  if (!isRecord(value) || value.target !== OFFSCREEN_TARGET || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "OFFSCREEN_LOAD":
      return typeof value.url === "string" && typeof value.volume === "number";
    case "OFFSCREEN_CONTENT":
      return isContentRequest(value.request);
    case "OFFSCREEN_VOLUME":
      return typeof value.volume === "number";
    case "OFFSCREEN_STOP":
    case "OFFSCREEN_UNHOST":
      return true;
    case "OFFSCREEN_HOST":
      return isHttpMediaUrl(value.url);
    default:
      return false;
  }
}

function runtimeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  return "Offscreen media request failed";
}

function requireVideo(): HTMLVideoElement {
  const video = document.querySelector<HTMLVideoElement>("#offscreen-video");
  if (!video) throw new Error("The offscreen video element is missing");
  return video;
}

const video = requireVideo();

let activeSelection: ActiveSelection | null = null;

function mediaErrorMessage(): string {
  const mediaError = video.error as (MediaError & { message?: unknown }) | null;
  if (mediaError?.message && typeof mediaError.message === "string") {
    return mediaError.message;
  }
  if (mediaError && Number.isFinite(mediaError.code)) {
    return `Media error (code ${mediaError.code})`;
  }
  return "Media failed to load";
}

function sendRuntimeMessage(message: ContentEventMessage): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

  try {
    const result = chrome.runtime.sendMessage(message);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // The service worker may be asleep or stopping; event delivery is best effort.
  }
}

const controller = new VideoController({ sendMessage: sendRuntimeMessage });

let hlsPlayer: Hls | null = null;
let hlsFailure: string | null = null;

function destroyHlsPlayer(): void {
  const player = hlsPlayer;
  hlsPlayer = null;
  try {
    player?.destroy();
  } catch {
    // The source element is reset immediately afterwards. Do not let a
    // teardown exception strand the offscreen player or its old source.
  }
}

function dispatchMediaError(message: string): void {
  const event = new Event("error") as Event & { message?: string };
  event.message = message;
  video.dispatchEvent(event);
}

function handleHlsError(player: Hls, _event: string, data: ErrorData): void {
  if (player !== hlsPlayer || !data.fatal) return;

  const message = formatHlsFailure(data);
  hlsFailure = message;
  destroyHlsPlayer();
  // VideoController owns the offscreen selection and emits its normal
  // play-failed event, which lets the worker release visible-video mute.
  dispatchMediaError(message);
}

function resetVideoSource(): void {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

function loadHlsSource(url: string): OffscreenResponse | null {
  if (Hls.isSupported()) {
    const player = new Hls({ enableWorker: false });
    hlsPlayer = player;
    try {
      player.on(Hls.Events.ERROR, (event, data) => handleHlsError(player, event, data));
      player.attachMedia(video);
      player.loadSource(url);
    } catch (error) {
      destroyHlsPlayer();
      return { ok: false, error: runtimeError(error) };
    }
    return null;
  }

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    video.load();
    return null;
  }

  return { ok: false, error: "HLS playback is not supported in the offscreen player" };
}

function clearActiveSelection(pairId: string): void {
  if (activeSelection?.pairId === pairId) activeSelection = null;
}

function loadMedia(message: OffscreenLoadMessage): OffscreenResponse {
  if (!isHttpMediaUrl(message.url)) {
    return { ok: false, error: "The offscreen media URL must use http or https" };
  }
  if (!isVolume(message.volume)) {
    return { ok: false, error: "Offscreen volume must be a number from 0 to 1" };
  }

  if (activeSelection) {
    controller.deactivate(activeSelection.pairId);
    activeSelection = null;
  }

  destroyHlsPlayer();
  hlsFailure = null;
  resetVideoSource();
  video.volume = message.volume;
  try {
    if (isHlsUrl(message.url)) {
      const hlsResult = loadHlsSource(message.url);
      if (hlsResult) { destroyHlsPlayer(); return hlsResult; }
    } else {
      // Keep non-HLS media as a native source. Do not fetch, proxy, or blob-wrap it.
      video.src = message.url;
      video.load();
    }
  } catch (error) {
    destroyHlsPlayer();
    return { ok: false, error: runtimeError(error) };
  }

  const descriptor = probeVideos()[0];
  if (!descriptor) {
    destroyHlsPlayer();
    return { ok: false, error: "The offscreen video could not be probed" };
  }
  return { ok: true, videoId: descriptor.id };
}

function routeContentRequest(request: ContentRequest): OffscreenResponse | ContentControllerResponse {
  switch (request.type) {
    case "PROBE":
      return { ok: true, videos: controller.probe() };
    case "ACTIVATE": {
      if (hlsFailure) {
        return { ok: false, error: hlsFailure };
      }
      if (video.error) {
        return { ok: false, error: mediaErrorMessage() };
      }
      const response = controller.activate(
        request.pairId,
        request.side,
        request.videoId,
        request.revision,
      );
      if (response.ok) {
        activeSelection = {
          pairId: request.pairId,
          side: request.side,
          videoId: request.videoId,
          revision: response.appliedRevision ?? request.revision,
        };
      }
      return response;
    }
    case "DEACTIVATE": {
      const response = controller.deactivate(request.pairId);
      if (response.ok) clearActiveSelection(request.pairId);
      return response;
    }
    case "COMMAND": {
      const response = controller.applyCommand(request.command);
      if (response.ok && activeSelection?.pairId === request.command.pairId) {
        activeSelection.revision = response.appliedRevision ?? request.command.revision;
      }
      return response;
    }
    case "SET_MUTED":
      return {
        ok: false,
        error: "SET_MUTED is not supported by the offscreen player",
      };
    case "SET_VOLUME":
      return controller.setVolume(request.pairId, request.volume);
  }
}

function stopMedia(): OffscreenResponse {
  let deactivationError: string | undefined;
  if (activeSelection) {
    const response = controller.deactivate(activeSelection.pairId);
    if (!response.ok) deactivationError = response.error;
    activeSelection = null;
  }

  destroyHlsPlayer();
  hlsFailure = null;
  resetVideoSource();

  return deactivationError
    ? { ok: false, error: deactivationError }
    : { ok: true };
}

function handleOffscreenMessage(message: OffscreenMessage): OffscreenResponse | ContentControllerResponse {
  switch (message.type) {
    case "OFFSCREEN_LOAD":
      return loadMedia(message);
    case "OFFSCREEN_CONTENT":
      return routeContentRequest(message.request);
    case "OFFSCREEN_VOLUME":
      if (!isVolume(message.volume)) {
        return { ok: false, error: "Offscreen volume must be a number from 0 to 1" };
      }
      video.volume = message.volume;
      return { ok: true };
    case "OFFSCREEN_STOP":
      return stopMedia();
    case "OFFSCREEN_HOST":
      mountHostedPage(message.url);
      return { ok: true };
    case "OFFSCREEN_UNHOST":
      unmountHostedPage();
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((_message, _sender, sendResponse) => {
  if (!isRecord(_message) || _message.target !== OFFSCREEN_TARGET) return false;

  if (!isOffscreenMessage(_message)) {
    sendResponse({ ok: false, error: "Unsupported offscreen request" });
    return false;
  }

  try {
    sendResponse(handleOffscreenMessage(_message));
  } catch (error) {
    sendResponse({ ok: false, error: runtimeError(error) });
  }
  return false;
});
