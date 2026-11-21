import {
  clamp,
  clampToDuration,
  DEFAULT_TOLERANCE_MS,
  isWithinTolerance,
  targetIsPlayable,
  translatePrimaryTime,
} from "../shared/time";
import {
  canonicalPositionFor,
  resolveAutoOffset,
} from "../shared/auto-offset";
import {
  CONTENT_SCRIPT_PATH,
  isRecord,
  STORAGE_KEY,
} from "../shared/messages";
import type {
  BackgroundRequest,
  BackgroundAudioState,
  BackgroundResponse,
  ContentEventMessage,
  ContentEventName,
  ContentRequest,
  EndpointRuntime,
  MediaSnapshot,
  ProbeTabResponse,
  Side,
  StartHostedDubConfig,
  StartSyncConfig,
  StartBackgroundAudioConfig,
  StateUpdateMessage,
  SyncState,
  VideoDescriptor,
  VideoEndpoint,
  VideoCommand,
} from "../shared/types";
import {
  OFFSCREEN_TAB_ID, OFFSCREEN_PATH, validMediaUrl, hasOffscreenPlayer,
  createOffscreenPlayer, offscreenRequest, closeOffscreenPlayer,
} from "./offscreen-host";
import "./language-detection-host";
import { setupAutoDub } from "./auto-dub";
import "./update-check";
import "./hosted-diagnostics";
import { findHostedDub, findReplacementDub } from "./hosted-dub";
import { closeHost, currentHost, HOSTED_TAB_ID, hostedFrames, refusedConnections, hostedRequest, isHostedSender, onHostedVideoEvent, onHostLost } from "./hosted-host";

const TOP_LEVEL_FRAME_ID = 0;
const INITIAL_REVISION = 0;
const RATE_EPSILON = 0.001;
// Fine sync for background Dub: speed up or slow down slightly instead of seeking.
const MAX_RATE_TRIM = 0.04;
const TRIM_START_MS = 45;
const TRIM_STOP_MS = 15;
/** Close the measured drift over roughly this long. */
const TRIM_HORIZON_MS = 2500;
const TRIM_STEP = 0.005;

const sides: Side[] = ["primary", "secondary"];

let activeState: SyncState | null = null;
const injectedTargets = new Set<string>();
let commandSequence = 0;

// Events and state writes are serialized independently. The first queue keeps
// two simultaneous popup/content messages from losing a state transition; the
// second makes each storage write complete before the next one starts.
let operationQueue: Promise<void> = Promise.resolve();
let storageWriteQueue: Promise<void> = Promise.resolve();
const lastLocalSequences = new Map<string, number>();
const lastLocalEventSignatures = new Map<string, string>();

const restored = restoreState();

interface ContentResponse {
  ok?: boolean;
  error?: string;
  snapshot?: unknown;
  videos?: unknown;
  probe?: unknown;
}

interface ActivationResult {
  ok: boolean;
  snapshot: MediaSnapshot | null;
  error?: string;
}

interface CommandResult {
  command: VideoCommand;
  ok: boolean;
  error?: string;
}

interface FrameTarget {
  frameId?: number;
  documentId?: string;
}

interface InjectionFrameTarget {
  frameId: number;
  documentId: string;
}

function enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
  const result = operationQueue.then(() => restored).then(operation);
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function restoreState(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    const value = (stored as Record<string, unknown>)[STORAGE_KEY];
    const restoredState = normalizeSyncState(value);
    if (restoredState) activeState = restoredState;
  } catch {
    // A missing/unavailable session area should leave the worker safely idle.
    activeState = null;
  }
}

function persistState(state: SyncState | null): Promise<void> {
  const snapshot = cloneState(state);
  const write = storageWriteQueue.then(async () => {
    try {
      await chrome.storage.session.set({ [STORAGE_KEY]: snapshot });
    } catch {
      // Keep the in-memory state usable if the browser rejects a storage write.
    }
  });
  storageWriteQueue = write.then(
    () => undefined,
    () => undefined,
  );
  return write;
}

async function commitState(state: SyncState | null): Promise<void> {
  activeState = state;
  await persistState(state);
  await broadcastState(state);
  await autoDub.syncChanged(state);
}

async function broadcastState(state: SyncState | null): Promise<void> {
  const update: StateUpdateMessage = {
    type: "STATE_UPDATE",
    state: cloneState(state),
  };

  try {
    await chrome.runtime.sendMessage(update);
  } catch {
    // Popup contexts are transient; no popup is not an error in the worker.
  }
}

function cloneSnapshot(snapshot: MediaSnapshot | null): MediaSnapshot | null {
  if (!snapshot) return null;
  return { ...snapshot };
}

function cloneEndpoint(endpoint: EndpointRuntime): EndpointRuntime {
  return {
    endpoint: { ...endpoint.endpoint },
    status: endpoint.status,
    snapshot: cloneSnapshot(endpoint.snapshot),
    lastAppliedRevision: endpoint.lastAppliedRevision,
    pendingCommand: endpoint.pendingCommand
      ? { ...endpoint.pendingCommand }
      : null,
  };
}

function cloneState(state: SyncState | null): SyncState | null {
  if (!state) return null;
  return {
    ...(state.backgroundAudio ? { backgroundAudio: { ...state.backgroundAudio } } : {}),
    pairId: state.pairId,
    offsetMs: state.offsetMs,
    manualOffsetMs: state.manualOffsetMs ?? state.offsetMs,
    autoOffset: state.autoOffset ?? false,
    autoOffsetPending: state.autoOffsetPending ?? false,
    toleranceMs: state.toleranceMs,
    ...(state.secondaryRateTrim !== undefined ? { secondaryRateTrim: state.secondaryRateTrim } : {}),
    timeline: { ...state.timeline },
    primary: cloneEndpoint(state.primary),
    secondary: cloneEndpoint(state.secondary),
    status: state.status,
    message: state.message,
    manualPlayRequired: state.manualPlayRequired,
  };
}

function normalizeSnapshot(value: unknown): MediaSnapshot | null {
  if (!isRecord(value)) return null;

  const currentTimeMs = numberValue(value.currentTimeMs);
  const durationValue = value.durationMs;
  const durationMs =
    durationValue === null
      ? null
      : numberValue(durationValue);
  const playbackRate = numberValue(value.playbackRate);
  const readyState = numberValue(value.readyState);

  if (
    currentTimeMs === null ||
    (durationValue !== null && durationMs === null) ||
    playbackRate === null ||
    readyState === null ||
    typeof value.paused !== "boolean" ||
    typeof value.ended !== "boolean" ||
    typeof value.canPlay !== "boolean"
  ) {
    return null;
  }

  const capturedAt = numberValue(value.capturedAt);
  return {
    currentTimeMs: Math.max(0, currentTimeMs),
    durationMs:
      durationMs === null ? null : Math.max(0, durationMs),
    paused: value.paused,
    ended: value.ended,
    playbackRate: playbackRate > 0 ? playbackRate : 1,
    readyState: Math.max(0, readyState),
    canPlay: value.canPlay,
    ...(capturedAt !== null ? { capturedAt } : {}),
  };
}

function normalizeSyncState(value: unknown): SyncState | null {
  if (!isRecord(value)) return null;
  if (typeof value.pairId !== "string" || value.pairId.length === 0) {
    return null;
  }

  const offsetMs = numberValue(value.offsetMs);
  const manualOffsetMs =
    value.manualOffsetMs === undefined
      ? offsetMs
      : numberValue(value.manualOffsetMs);
  const autoOffset =
    value.autoOffset === undefined
      ? false
      : value.autoOffset;
  const storedAutoOffsetPending =
    value.autoOffsetPending === undefined
      ? false
      : value.autoOffsetPending;
  const toleranceMs = numberValue(value.toleranceMs);
  const timelineValue = value.timeline;
  if (!isRecord(timelineValue)) return null;

  const revision = numberValue(timelineValue.revision);
  const positionMs = numberValue(timelineValue.positionMs);
  const playbackRate = numberValue(timelineValue.playbackRate);
  if (
    offsetMs === null ||
    manualOffsetMs === null ||
    typeof autoOffset !== "boolean" ||
    typeof storedAutoOffsetPending !== "boolean" ||
    toleranceMs === null ||
    revision === null ||
    positionMs === null ||
    playbackRate === null ||
    typeof timelineValue.playing !== "boolean" ||
    !isSide(timelineValue.authority)
  ) {
    return null;
  }

  const primary = normalizeEndpointRuntime(value.primary);
  const secondary = normalizeEndpointRuntime(value.secondary);
  if (!primary || !secondary) return null;

  const status = value.status;
  if (!isSyncStatus(status)) return null;
  if (value.message !== null && typeof value.message !== "string") {
    return null;
  }
  if (value.manualPlayRequired !== null && !isSide(value.manualPlayRequired)) {
    return null;
  }

  let backgroundAudio: SyncState["backgroundAudio"];
  if (value.backgroundAudio !== undefined) {
    if (!isRecord(value.backgroundAudio) ||
        !validVolume(value.backgroundAudio.volume) ||
        (value.backgroundAudio.muteOriginal !== undefined &&
          typeof value.backgroundAudio.muteOriginal !== "boolean")) return null;

    // The mode field was added after the original offscreen-only state.
    const mode = value.backgroundAudio.mode === undefined &&
      secondary.endpoint.tabId === OFFSCREEN_TAB_ID
      ? "offscreen"
      : value.backgroundAudio.mode;
    if (mode === "offscreen") {
      if (!validMediaUrl(value.backgroundAudio.sourceUrl) || secondary.endpoint.tabId !== OFFSCREEN_TAB_ID) return null;
      backgroundAudio = {
        mode: "offscreen",
        sourceUrl: value.backgroundAudio.sourceUrl,
        volume: value.backgroundAudio.volume,
        // Sessions written before the preference existed default to the safe
        // behavior: mute the visible video once background audio is playing.
        muteOriginal: value.backgroundAudio.muteOriginal ?? true,
      };
    } else if (mode === "hosted") {
      const container = value.backgroundAudio.container;
      const provider = value.backgroundAudio.provider;
      if (secondary.endpoint.tabId !== HOSTED_TAB_ID || !secondary.endpoint.documentId ||
          !isHttpUrl(value.backgroundAudio.pageUrl) ||
          (container !== "offscreen" && container !== "window") ||
          (provider !== null && typeof provider !== "string")) return null;
      backgroundAudio = {
        mode: "hosted",
        pageUrl: value.backgroundAudio.pageUrl,
        provider,
        container,
        volume: value.backgroundAudio.volume,
        muteOriginal: value.backgroundAudio.muteOriginal ?? true,
      };
    } else {
      return null;
    }
  } else if (secondary.endpoint.tabId === OFFSCREEN_TAB_ID || secondary.endpoint.tabId === HOSTED_TAB_ID) return null;

  const resolvedOffset = resolveAutoOffset(
    manualOffsetMs,
    autoOffset,
    primary.snapshot?.durationMs ?? null,
    secondary.snapshot?.durationMs ?? null,
  );

  return {
    ...(backgroundAudio ? { backgroundAudio } : {}),
    pairId: value.pairId,
    offsetMs: resolvedOffset.offsetMs,
    manualOffsetMs,
    autoOffset,
    autoOffsetPending: resolvedOffset.pending,
    toleranceMs: Math.max(0, toleranceMs),
    ...(backgroundAudio && numberValue(value.secondaryRateTrim) !== null &&
      Math.abs((value.secondaryRateTrim as number) - 1) <= MAX_RATE_TRIM
      ? { secondaryRateTrim: value.secondaryRateTrim as number } : {}),
    timeline: {
      revision: Math.max(INITIAL_REVISION, Math.floor(revision)),
      positionMs: canonicalPositionFor(
        positionMs,
        resolvedOffset.offsetMs,
        "primary",
        autoOffset && !resolvedOffset.pending,
      ),
      playing: timelineValue.playing,
      playbackRate: playbackRate > 0 ? playbackRate : 1,
      authority: backgroundAudio ? "primary" : timelineValue.authority,
    },
    primary,
    secondary,
    status,
    message: value.message,
    manualPlayRequired: value.manualPlayRequired,
  };
}

function normalizeEndpointRuntime(value: unknown): EndpointRuntime | null {
  if (!isRecord(value) || !isRecord(value.endpoint)) return null;
  const tabId = numberValue(value.endpoint.tabId);
  const videoId = value.endpoint.videoId;
  const lastAppliedRevision = numberValue(value.lastAppliedRevision);
  const metadata = normalizeEndpointMetadata(value.endpoint);
  if (
    tabId === null ||
    !Number.isInteger(tabId) ||
    typeof videoId !== "string" ||
    videoId.length === 0 ||
    !metadata ||
    lastAppliedRevision === null ||
    !isEndpointStatus(value.status)
  ) {
    return null;
  }

  const pendingCommand = normalizePendingCommand(value.pendingCommand);
  if (value.pendingCommand !== null && !pendingCommand) return null;

  return {
    endpoint: { tabId, videoId, ...metadata },
    status: value.status,
    snapshot: normalizeSnapshot(value.snapshot),
    lastAppliedRevision: Math.max(-1, Math.floor(lastAppliedRevision)),
    pendingCommand,
  };
}

function normalizePendingCommand(value: unknown): EndpointRuntime["pendingCommand"] {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  const revision = numberValue(value.revision);
  const targetTimeMs =
    value.targetTimeMs === null
      ? null
      : numberValue(value.targetTimeMs);
  const playbackRate = numberValue(value.playbackRate);
  if (
    typeof value.commandId !== "string" ||
    revision === null ||
    (value.targetTimeMs !== null && targetTimeMs === null) ||
    typeof value.shouldPlay !== "boolean" ||
    playbackRate === null
  ) {
    return null;
  }
  return {
    commandId: value.commandId,
    revision: Math.floor(revision),
    targetTimeMs,
    shouldPlay: value.shouldPlay,
    playbackRate: playbackRate > 0 ? playbackRate : 1,
  };
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isFrameId(value: unknown): value is number {
  const number = numberValue(value);
  return number !== null && Number.isInteger(number) && number >= 0;
}

function isDocumentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeEndpointMetadata(
  value: Record<string, unknown>,
): Pick<VideoEndpoint, "frameId" | "documentId"> | null {
  const frameId = value.frameId;
  const documentId = value.documentId;
  if (frameId !== undefined && !isFrameId(frameId)) return null;
  if (documentId !== undefined && !isDocumentId(documentId)) return null;

  return {
    ...(frameId !== undefined ? { frameId } : {}),
    ...(documentId !== undefined ? { documentId } : {}),
  };
}

function isVideoEndpoint(value: unknown): value is VideoEndpoint {
  if (!isRecord(value)) return false;
  const tabId = numberValue(value.tabId);
  return (
    tabId !== null &&
    Number.isInteger(tabId) &&
    tabId >= 0 &&
    typeof value.videoId === "string" &&
    value.videoId.length > 0 &&
    normalizeEndpointMetadata(value) !== null
  );
}

function isSide(value: unknown): value is Side {
  return value === "primary" || value === "secondary";
}

function isSyncStatus(value: unknown): value is SyncState["status"] {
  return (
    value === "idle" ||
    value === "active" ||
    value === "paused" ||
    value === "buffering" ||
    value === "degraded" ||
    value === "manual-play-required" ||
    value === "error"
  );
}

function isEndpointStatus(value: unknown): value is EndpointRuntime["status"] {
  return (
    value === "unknown" ||
    value === "ready" ||
    value === "playing" ||
    value === "paused" ||
    value === "buffering" ||
    value === "ended" ||
    value === "lost" ||
    value === "play-failed"
  );
}

function isContentEventName(value: unknown): value is ContentEventName {
  return (
    value === "intent-play" ||
    value === "intent-pause" ||
    value === "intent-seek" ||
    value === "intent-ratechange" ||
    value === "observation" ||
    value === "buffering" ||
    value === "playing" ||
    value === "ended" ||
    value === "remote-ack" ||
    value === "play-failed" ||
    value === "element-lost"
  );
}

function isContentEvent(value: unknown): value is ContentEventMessage {
  return (
    isRecord(value) &&
    value.type === "VIDEO_EVENT" &&
    typeof value.pairId === "string" &&
    isSide(value.side) &&
    typeof value.videoId === "string" &&
    isContentEventName(value.event) &&
    numberValue(value.localSequence) !== null &&
    numberValue(value.appliedRevision) !== null
  );
}

function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "GET_STATE" || value.type === "STOP_SYNC") return true;
  if (value.type === "PROBE_TAB") {
    return numberValue(value.tabId) !== null && Number.isInteger(value.tabId);
  }
  if (value.type === "START_SYNC") return isStartSyncConfig(value.config);
  if (value.type === "SET_BACKGROUND_VOLUME") return validVolume(value.volume);
  if (value.type === "SET_MUTE_ORIGINAL") return typeof value.muteOriginal === "boolean";
  if (value.type === "SET_MANUAL_OFFSET") return numberValue(value.offsetMs) !== null;
  if (value.type === "SET_AUTO_OFFSET") return typeof value.enabled === "boolean";
  if (value.type === "START_BACKGROUND_AUDIO") {
    const config = value.config;
    return isRecord(config) && validMediaUrl(config.sourceUrl) && validVolume(config.volume) &&
      (config.muteOriginal === undefined || typeof config.muteOriginal === "boolean") &&
      isStartSyncConfig({ ...config, secondary: { tabId: 0, videoId: "offscreen" } });
  }
  return false;
}

function validVolume(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

function isStartSyncConfig(value: unknown): value is StartSyncConfig {
  if (!isRecord(value) || !isVideoEndpoint(value.primary) || !isVideoEndpoint(value.secondary)) {
    return false;
  }
  const offsetMs = numberValue(value.offsetMs);
  const toleranceMs =
    value.toleranceMs === undefined
      ? DEFAULT_TOLERANCE_MS
      : numberValue(value.toleranceMs);
  const autoOffset = value.autoOffset;
  return (
    offsetMs !== null &&
    toleranceMs !== null &&
    toleranceMs >= 0 &&
    (autoOffset === undefined || typeof autoOffset === "boolean")
  );
}

function endpointFor(state: SyncState, side: Side): EndpointRuntime {
  return side === "primary" ? state.primary : state.secondary;
}

function otherSide(side: Side): Side {
  return side === "primary" ? "secondary" : "primary";
}

function isSnapshotPlaying(snapshot: MediaSnapshot | null): boolean {
  return Boolean(snapshot && !snapshot.paused && !snapshot.ended && snapshot.canPlay);
}

function isRuntimePlaying(endpoint: EndpointRuntime): boolean {
  return endpoint.status === "playing" || isSnapshotPlaying(endpoint.snapshot);
}

function statusForSnapshot(snapshot: MediaSnapshot | null): EndpointRuntime["status"] {
  if (!snapshot) return "unknown";
  if (snapshot.ended) return "ended";
  if (!snapshot.canPlay && !snapshot.paused) return "buffering";
  if (!snapshot.paused) return "playing";
  return "paused";
}

function sideLabel(side: Side): string {
  return side === "primary" ? "Primary" : "Secondary";
}

function waitingForDubAudio(state: SyncState): boolean {
  return Boolean(state.backgroundAudio && state.timeline.playing &&
    endpointTarget(state, "secondary").playable &&
    !isSnapshotPlaying(state.secondary.snapshot));
}

function syncStatusFor(state: SyncState): SyncState["status"] {
  if (state.manualPlayRequired) return "manual-play-required";
  if (state.primary.status === "play-failed" || state.secondary.status === "play-failed") return "error";
  if (state.primary.status === "lost" || state.secondary.status === "lost") {
    return "degraded";
  }
  if (
    state.primary.status === "buffering" ||
    state.secondary.status === "buffering" ||
    waitingForDubAudio(state)
  ) {
    return "buffering";
  }
  return state.timeline.playing ? "active" : "paused";
}

function updateSyncStatus(state: SyncState): void {
  state.status = syncStatusFor(state);
  if (state.status === "buffering" && waitingForDubAudio(state)) {
    state.message = "Waiting for Dub audio.";
  } else if (state.message === "Waiting for Dub audio.") {
    state.message = null;
  }
}

function nextCommandId(): string {
  commandSequence += 1;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${crypto.randomUUID()}-${commandSequence}`;
  }
  return `command-${commandSequence}`;
}

function newPairId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  commandSequence += 1;
  return `pair-${commandSequence}`;
}

function contentError(value: unknown, fallback: string): string {
  if (isRecord(value) && typeof value.error === "string" && value.error.length > 0) {
    return value.error;
  }
  if (value instanceof Error && value.message) return value.message;
  return fallback;
}

function injectedTargetKey(tabId: number, target: FrameTarget): string {
  return target.documentId !== undefined
    ? `${tabId}:document:${target.documentId}`
    : `${tabId}:frame:${target.frameId ?? TOP_LEVEL_FRAME_ID}`;
}

function clearInjectedTargets(tabId: number): void {
  const prefix = `${tabId}:`;
  for (const key of injectedTargets) {
    if (key.startsWith(prefix)) injectedTargets.delete(key);
  }
}

function messageOptionsForTarget(target: FrameTarget): chrome.tabs.MessageSendOptions {
  const options: chrome.tabs.MessageSendOptions = {};
  if (target.frameId !== undefined) options.frameId = target.frameId;
  if (target.documentId !== undefined) options.documentId = target.documentId;
  if (target.frameId === undefined && target.documentId === undefined) {
    options.frameId = TOP_LEVEL_FRAME_ID;
  }
  return options;
}

async function injectContentIntoFrame(
  tabId: number,
  target: FrameTarget,
): Promise<void> {
  const key = injectedTargetKey(tabId, target);
  if (injectedTargets.has(key)) return;

  if (target.documentId !== undefined) {
    await chrome.scripting.executeScript({
      target: { tabId, documentIds: [target.documentId] },
      files: [CONTENT_SCRIPT_PATH],
    });
  } else {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [target.frameId ?? TOP_LEVEL_FRAME_ID] },
      files: [CONTENT_SCRIPT_PATH],
    });
  }
  injectedTargets.add(key);
}

function injectionFrameTarget(value: unknown): InjectionFrameTarget | null {
  if (!isRecord(value) || !isFrameId(value.frameId) || !isDocumentId(value.documentId)) return null;
  return {
    frameId: value.frameId,
    documentId: value.documentId,
  };
}

async function injectContentIntoAllFrames(tabId: number): Promise<InjectionFrameTarget[]> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: [CONTENT_SCRIPT_PATH],
  });
  const targets = new Map<string, InjectionFrameTarget>();
  for (const result of results) {
    const target = injectionFrameTarget(result);
    if (!target) continue;
    targets.set(injectedTargetKey(tabId, target), target);
  }
  if (targets.size === 0) throw new Error("The tab has no accessible frames.");
  for (const target of targets.values()) injectedTargets.add(injectedTargetKey(tabId, target));
  return [...targets.values()];
}

async function sendContentRequest(
  tabId: number,
  request: ContentRequest,
  target: FrameTarget = { frameId: TOP_LEVEL_FRAME_ID },
): Promise<unknown> {
  if (tabId === OFFSCREEN_TAB_ID) return offscreenRequest({ type: "OFFSCREEN_CONTENT", request });
  if (tabId === HOSTED_TAB_ID) {
    if (!target.documentId) throw new Error("The hidden Dub page video has no frame identity.");
    return hostedRequest(target.documentId, request);
  }
  await injectContentIntoFrame(tabId, target);
  return chrome.tabs.sendMessage(tabId, request, messageOptionsForTarget(target));
}

function annotateProbeVideos(
  source: unknown[],
  target: FrameTarget,
): VideoDescriptor[] {
  return source.map((value) => {
    if (!isRecord(value)) return value as VideoDescriptor;
    return {
      ...value,
      ...(target.frameId !== undefined ? { frameId: target.frameId } : {}),
      ...(target.documentId !== undefined ? { documentId: target.documentId } : {}),
    } as VideoDescriptor;
  });
}

function normalizeProbeResponse(
  tabId: number,
  value: unknown,
  target: FrameTarget = { frameId: TOP_LEVEL_FRAME_ID },
): ProbeTabResponse {
  if (!isRecord(value)) {
    return { ok: false, tabId, videos: [], error: "The content script returned no probe." };
  }
  if (value.ok === false) {
    return {
      ok: false,
      tabId,
      videos: [],
      error: contentError(value, "The tab could not be probed."),
    };
  }

  const source = Array.isArray(value.videos)
    ? value.videos
    : isRecord(value.probe) && Array.isArray(value.probe.videos)
      ? value.probe.videos
      : null;
  if (!source) {
    return { ok: false, tabId, videos: [], error: "The tab returned no video list." };
  }

  return {
    ok: true,
    tabId,
    videos: annotateProbeVideos(source, target),
  };
}

async function probeTab(tabId: number): Promise<ProbeTabResponse> {
  try {
    if (tabId === OFFSCREEN_TAB_ID) {
      const response = await sendContentRequest(tabId, { type: "PROBE" });
      return normalizeProbeResponse(tabId, response);
    }

    const targets = await injectContentIntoAllFrames(tabId);
    const frameProbes = await Promise.all(targets.map(async (target) => {
      try {
        const response = await sendContentRequest(tabId, { type: "PROBE" }, target);
        return normalizeProbeResponse(tabId, response, target);
      } catch (error) {
        return {
          ok: false,
          tabId,
          videos: [],
          error: contentError(error, "The frame could not be reached."),
        } satisfies ProbeTabResponse;
      }
    }));
    const successful = frameProbes.filter((probe) => probe.ok);
    if (successful.length > 0) {
      const videos = successful.flatMap((probe) => probe.videos);
      return { ok: true, tabId, videos };
    }

    return {
      ok: false,
      tabId,
      videos: [],
      error: frameProbes.find((probe) => probe.error)?.error ?? "The tab could not be probed.",
    };
  } catch (error) {
    return {
      ok: false,
      tabId,
      videos: [],
      error: contentError(error, "The tab could not be reached."),
    };
  }
}

function activationSnapshot(value: unknown): ActivationResult {
  if (!isRecord(value)) {
    return { ok: false, snapshot: null, error: "The video did not return a snapshot." };
  }
  if (value.ok === false) {
    return {
      ok: false,
      snapshot: null,
      error: contentError(value, "The video could not be activated."),
    };
  }

  const snapshot = normalizeSnapshot(value.snapshot ?? value.mediaSnapshot ?? value);
  if (!snapshot) {
    return { ok: false, snapshot: null, error: "The video returned an invalid snapshot." };
  }
  return { ok: true, snapshot };
}

async function activateEndpoint(
  pairId: string,
  side: Side,
  endpoint: VideoEndpoint,
): Promise<ActivationResult> {
  try {
    const request: ContentRequest = {
      type: "ACTIVATE",
      pairId,
      side,
      videoId: endpoint.videoId,
      revision: INITIAL_REVISION,
    };
    const response = await sendContentRequest(endpoint.tabId, request, endpoint);
    return activationSnapshot(response);
  } catch (error) {
    return {
      ok: false,
      snapshot: null,
      error: contentError(error, `${sideLabel(side)} video could not be activated.`),
    };
  }
}

async function deactivateEndpoint(
  endpoint: EndpointRuntime,
  pairId: string,
): Promise<void> {
  try {
    await sendContentRequest(endpoint.endpoint.tabId, {
      type: "DEACTIVATE",
      pairId,
    }, endpoint.endpoint);
  } catch {
    // Deactivation is best effort, especially when a tab has already closed.
  }
}

function runtimeForStart(
  endpoint: VideoEndpoint,
  snapshot: MediaSnapshot,
): EndpointRuntime {
  return {
    endpoint: { ...endpoint },
    status: statusForSnapshot(snapshot),
    snapshot: cloneSnapshot(snapshot),
    lastAppliedRevision: INITIAL_REVISION,
    pendingCommand: null,
  };
}

function autoOffsetIsActive(state: SyncState): boolean {
  return state.autoOffset === true && state.autoOffsetPending !== true;
}

/** Re-evaluate auto offset only from metadata already observed by both sides. */
function refreshAutoOffset(state: SyncState): boolean {
  const manualOffsetMs = state.manualOffsetMs ?? state.offsetMs;
  const enabled = state.autoOffset === true;
  const resolved = resolveAutoOffset(
    manualOffsetMs,
    enabled,
    state.primary.snapshot?.durationMs ?? null,
    state.secondary.snapshot?.durationMs ?? null,
  );
  const changed =
    state.offsetMs !== resolved.offsetMs ||
    state.autoOffsetPending !== resolved.pending ||
    state.manualOffsetMs !== manualOffsetMs ||
    state.autoOffset !== enabled;
  const positionMs = canonicalPositionFor(
    state.timeline.positionMs,
    resolved.offsetMs,
    "primary",
    enabled && !resolved.pending && (!state.backgroundAudio || changed),
  );
  const positionChanged = state.timeline.positionMs !== positionMs;

  state.manualOffsetMs = manualOffsetMs;
  state.autoOffset = enabled;
  state.offsetMs = resolved.offsetMs;
  state.autoOffsetPending = resolved.pending;

  if (!changed && !positionChanged) return false;
  state.timeline = {
    ...state.timeline,
    positionMs,
    revision: state.timeline.revision + 1,
  };
  state.primary.pendingCommand = null;
  state.secondary.pendingCommand = null;
  return true;
}

function initialTimeline(
  primary: MediaSnapshot,
  secondary: MediaSnapshot,
  offsetMs: number,
  autoOffsetActive: boolean,
): SyncState["timeline"] {
  const authority: Side =
    primary.ended && isSnapshotPlaying(secondary) ? "secondary" : "primary";
  const snapshot = authority === "primary" ? primary : secondary;
  return {
    revision: INITIAL_REVISION,
    positionMs: canonicalPositionFor(
      snapshot.currentTimeMs,
      offsetMs,
      authority,
      autoOffsetActive,
    ),
    playing: isSnapshotPlaying(snapshot),
    playbackRate: snapshot.playbackRate,
    authority,
  };
}

async function stopExistingSync(): Promise<void> {
  const previous = activeState;
  if (!previous) return;

  await commitState(null);
  await Promise.all([
    deactivateEndpoint(previous.primary, previous.pairId),
    deactivateEndpoint(previous.secondary, previous.pairId),
  ]);
  if (previous.backgroundAudio?.mode === "offscreen") await closeOffscreenPlayer();
  lastLocalSequences.clear();
  lastLocalEventSignatures.clear();
}

async function startSync(config: StartSyncConfig, backgroundAudio?: SyncState["backgroundAudio"]): Promise<BackgroundResponse> {
  if (config.primary.tabId === config.secondary.tabId) {
    return { ok: false, state: cloneState(activeState), error: "Choose two different tabs." };
  }

  if (activeState) await stopExistingSync();

  const pairId = newPairId();
  const [primaryResult, secondaryResult] = await Promise.all([
    activateEndpoint(pairId, "primary", config.primary),
    activateEndpoint(pairId, "secondary", config.secondary),
  ]);

  if (!primaryResult.ok || !secondaryResult.ok || !primaryResult.snapshot || !secondaryResult.snapshot) {
    await Promise.all([
      deactivateEndpoint(
        {
          endpoint: { ...config.primary },
          status: "unknown",
          snapshot: null,
          lastAppliedRevision: -1,
          pendingCommand: null,
        },
        pairId,
      ),
      deactivateEndpoint(
        {
          endpoint: { ...config.secondary },
          status: "unknown",
          snapshot: null,
          lastAppliedRevision: -1,
          pendingCommand: null,
        },
        pairId,
      ),
    ]);
    const error = primaryResult.error ?? secondaryResult.error ?? "Sync could not be started.";
    return { ok: false, state: null, error };
  }

  const toleranceMs =
    config.toleranceMs === undefined
      ? DEFAULT_TOLERANCE_MS
      : Math.max(0, config.toleranceMs);
  const autoOffset = config.autoOffset === true;
  const manualOffsetMs = config.offsetMs;
  const resolvedOffset = resolveAutoOffset(
    manualOffsetMs,
    autoOffset,
    primaryResult.snapshot.durationMs,
    secondaryResult.snapshot.durationMs,
  );
  const state: SyncState = {
    ...(backgroundAudio ? { backgroundAudio } : {}),
    pairId,
    offsetMs: resolvedOffset.offsetMs,
    manualOffsetMs,
    autoOffset,
    autoOffsetPending: resolvedOffset.pending,
    toleranceMs,
    timeline: initialTimeline(
      primaryResult.snapshot,
      secondaryResult.snapshot,
      resolvedOffset.offsetMs,
      autoOffset && !resolvedOffset.pending,
    ),
    primary: runtimeForStart(config.primary, primaryResult.snapshot),
    secondary: runtimeForStart(config.secondary, secondaryResult.snapshot),
    status: "paused",
    message: null,
    manualPlayRequired: null,
  };
  if (backgroundAudio) {
    state.timeline.authority = "primary";
    state.timeline.positionMs = canonicalPositionFor(primaryResult.snapshot.currentTimeMs,
      state.offsetMs, "primary", autoOffset && !resolvedOffset.pending);
    state.timeline.playing = isSnapshotPlaying(primaryResult.snapshot);
    state.timeline.playbackRate = primaryResult.snapshot.playbackRate;
  }
  updateSyncStatus(state);
  lastLocalSequences.clear();
  lastLocalEventSignatures.clear();

  await commitState(state);
  await reconcile(state, true, true);
  return { ok: true, state: cloneState(activeState) };
}

async function loadBackgroundSource(audio: Extract<BackgroundAudioState, { mode: "offscreen" }>): Promise<string> {
  await createOffscreenPlayer();
  const result = await offscreenRequest({ type: "OFFSCREEN_LOAD", url: audio.sourceUrl, volume: audio.volume });
  if (!isRecord(result) || result.ok !== true || typeof result.videoId !== "string") {
    throw new Error(contentError(result, "Background audio could not be loaded."));
  }
  return result.videoId;
}

async function startBackgroundAudio(config: StartBackgroundAudioConfig): Promise<BackgroundResponse> {
  await stopExistingSync();
  const audio: Extract<BackgroundAudioState, { mode: "offscreen" }> = {
    mode: "offscreen",
    sourceUrl: config.sourceUrl,
    volume: config.volume,
    muteOriginal: config.muteOriginal ?? true,
  };
  try {
    const videoId = await loadBackgroundSource(audio);
    const result = await startSync({
      primary: config.primary,
      secondary: { tabId: OFFSCREEN_TAB_ID, videoId },
      offsetMs: config.offsetMs,
      autoOffset: config.autoOffset,
    }, audio);
    if (!result.ok) await closeOffscreenPlayer();
    return result;
  } catch (error) {
    await stopExistingSync();
    await closeOffscreenPlayer();
    return { ok: false, state: cloneState(activeState), error: contentError(error, "Background audio failed.") };
  }
}

/** Link Auto Dub's hosted Dub video to the visible video. Dub follows; it never leads. */
async function startHostedDub(config: StartHostedDubConfig): Promise<BackgroundResponse> {
  // Auto Dub checks this before starting. Keep the worker-side guard so an
  // asynchronous lookup can never replace a manual pair.
  if (activeState) {
    return { ok: false, state: cloneState(activeState), error: "Stop the current session before enabling Auto Dub." };
  }
  const audio: BackgroundAudioState = {
    mode: "hosted",
    pageUrl: config.pageUrl,
    provider: config.provider,
    container: config.container,
    volume: config.volume,
    muteOriginal: config.muteOriginal ?? true,
  };
  let result: BackgroundResponse;
  try {
    result = await startSync({
      primary: config.primary,
      secondary: config.secondary,
      offsetMs: config.offsetMs,
      autoOffset: config.autoOffset,
    }, audio);
  } catch (error) {
    return { ok: false, state: cloneState(activeState), error: contentError(error, "Dub sync could not be started.") };
  }
  if (!result.ok) return result;
  const state = activeState as SyncState | null;
  if (!state || state.backgroundAudio?.mode !== "hosted") {
    return { ok: false, state: cloneState(activeState), error: "Dub sync became unavailable." };
  }
  if (hasFatalPlaybackFailure(state)) {
    const error = state.message ?? "The hosted Dub video could not play.";
    await stopExistingSync();
    return { ok: false, state: cloneState(activeState), error };
  }
  // Setting the volume is also what unmutes the hosted video (see VideoController.setVolume).
  const volumeResult = await setBackgroundVolume(config.volume);
  if (!volumeResult.ok) {
    await stopExistingSync();
    return volumeResult;
  }
  return { ok: true, state: cloneState(activeState) };
}

// Chrome closes an AUDIO_PLAYBACK document after audio inactivity. Recreate on
// the next real media event; never keep it alive with silent audio or timers.
async function restoreBackgroundPlayer(state: SyncState): Promise<void> {
  if (!state.backgroundAudio || state.backgroundAudio.mode !== "offscreen" || await hasOffscreenPlayer()) return;
  const videoId = await loadBackgroundSource(state.backgroundAudio);
  const result = await offscreenRequest({ type: "OFFSCREEN_CONTENT", request: {
    type: "ACTIVATE", pairId: state.pairId, side: "secondary", videoId,
    revision: state.timeline.revision,
  } });
  const activation = activationSnapshot(result);
  if (!activation.ok || !activation.snapshot) throw new Error(activation.error ?? "Background audio could not resume.");
  state.secondary = runtimeForStart({ tabId: OFFSCREEN_TAB_ID, videoId }, activation.snapshot);
  state.secondary.lastAppliedRevision = state.timeline.revision;
  refreshAutoOffset(state);
  lastLocalSequences.delete(`${state.pairId}:secondary:${videoId}`);
  lastLocalEventSignatures.delete(`${state.pairId}:secondary:${videoId}`);
}

interface MuteOwnershipResult {
  ok: boolean;
  error?: string;
}

async function setVisibleMuted(state: SyncState, muted: boolean): Promise<MuteOwnershipResult> {
  if (!state.backgroundAudio) return { ok: true };
  try {
    const result = await sendContentRequest(state.primary.endpoint.tabId, {
      type: "SET_MUTED", pairId: state.pairId, muted,
    }, state.primary.endpoint);
    if (isRecord(result) && result.ok === false) throw new Error(contentError(result, "Could not mute the visible video."));
    return { ok: true };
  } catch (error) {
    if (muted) {
      if (state.backgroundAudio.mode === "offscreen") await closeOffscreenPlayer();
      state.secondary.status = "play-failed";
      state.message = contentError(error, "Could not mute the visible video; background audio stopped.");
      updateSyncStatus(state);
    } else {
      state.message = contentError(error, "Could not restore the visible video's original mute state.");
    }
    return { ok: false, error: state.message ?? "Could not update the visible video's mute state." };
  }
}

async function setMuteOriginal(muteOriginal: boolean): Promise<BackgroundResponse> {
  const state = activeState;
  if (!state?.backgroundAudio) {
    return { ok: false, state: cloneState(state), error: "Background audio is not active." };
  }

  const previousPreference = state.backgroundAudio.muteOriginal;
  state.backgroundAudio.muteOriginal = muteOriginal;

  // Turning the preference off releases only the mute owned by this session.
  // SET_MUTED false restores the controller's captured original value, so an
  // originally muted video stays muted.
  if (!muteOriginal) {
    const result = await setVisibleMuted(state, false);
    if (!result.ok) {
      state.backgroundAudio.muteOriginal = previousPreference;
      await commitState(state);
      return { ok: false, state: cloneState(state), error: result.error };
    }
  } else if (isRuntimePlaying(state.secondary)) {
    // A live enable should take effect immediately when secondary audio is
    // already playing. Paused/background-not-yet-started sessions stay quiet
    // until the normal secondary "playing" event arrives.
    const result = await setVisibleMuted(state, true);
    if (!result.ok) {
      state.backgroundAudio.muteOriginal = previousPreference;
      await commitState(state);
      return { ok: false, state: cloneState(state), error: result.error };
    }
  }

  await commitState(state);
  return { ok: true, state: cloneState(state) };
}

async function setBackgroundVolume(volume: number): Promise<BackgroundResponse> {
  const state = activeState;
  if (!state?.backgroundAudio) return { ok: false, error: "Background audio is not active." };
  if (state.backgroundAudio.mode === "offscreen" && await hasOffscreenPlayer()) {
    const result = await offscreenRequest({ type: "OFFSCREEN_VOLUME", volume });
    if (!isRecord(result) || result.ok !== true) return { ok: false, error: "Could not set background volume." };
  }
  if (state.backgroundAudio.mode === "hosted") {
    try {
      const result = await sendContentRequest(state.secondary.endpoint.tabId, {
        type: "SET_VOLUME",
        pairId: state.pairId,
        volume,
      }, state.secondary.endpoint);
      if (isRecord(result) && result.ok === false) {
        return { ok: false, state: cloneState(state), error: contentError(result, "Could not set background volume.") };
      }
    } catch (error) {
      return { ok: false, state: cloneState(state), error: contentError(error, "Could not set background volume.") };
    }
  }
  state.backgroundAudio.volume = volume;
  await commitState(state);
  return { ok: true, state: cloneState(state) };
}

async function setAutoOffset(enabled: boolean): Promise<BackgroundResponse> {
  const state = activeState;
  if (!state) {
    return { ok: false, state: null, error: "Sync is not active." };
  }

  const manualOffsetMs = state.manualOffsetMs ?? state.offsetMs;
  const resolved = resolveAutoOffset(
    manualOffsetMs,
    enabled,
    state.primary.snapshot?.durationMs ?? null,
    state.secondary.snapshot?.durationMs ?? null,
  );
  const positionMs = canonicalPositionFor(
    state.timeline.positionMs,
    resolved.offsetMs,
    "primary",
    enabled && !resolved.pending,
  );

  state.manualOffsetMs = manualOffsetMs;
  state.autoOffset = enabled;
  state.offsetMs = resolved.offsetMs;
  state.autoOffsetPending = resolved.pending;
  state.timeline = {
    ...state.timeline,
    positionMs,
    revision: state.timeline.revision + 1,
  };
  state.primary.pendingCommand = null;
  state.secondary.pendingCommand = null;
  updateSyncStatus(state);

  await commitState(state);
  await reconcile(state, false, true);
  return { ok: true, state: cloneState(state) };
}

function endpointTarget(state: SyncState, side: Side): {
  rawMs: number;
  targetMs: number;
  playable: boolean;
} {
  const endpoint = endpointFor(state, side);
  const rawMs = translatePrimaryTime(
    state.timeline.positionMs,
    state.offsetMs,
    side,
  );
  const durationMs = endpoint.snapshot?.durationMs ?? null;
  return {
    rawMs,
    targetMs: clampToDuration(rawMs, durationMs),
    playable: targetIsPlayable(rawMs, durationMs),
  };
}

function commandMatchesSnapshot(
  endpoint: EndpointRuntime,
  targetMs: number,
  shouldPlay: boolean,
  playbackRate: number,
  toleranceMs: number,
): boolean {
  const snapshot = endpoint.snapshot;
  if (!snapshot) return false;
  const playing = isSnapshotPlaying(snapshot);
  return (
    isWithinTolerance(snapshot.currentTimeMs, targetMs, toleranceMs) &&
    playing === shouldPlay &&
    Math.abs(snapshot.playbackRate - playbackRate) <= RATE_EPSILON
  );
}

function commandRateFor(state: SyncState, side: Side): number {
  const trim = side === "secondary" && state.backgroundAudio ? state.secondaryRateTrim ?? 1 : 1;
  return state.timeline.playbackRate * trim;
}

/** Position of a playing snapshot extrapolated to `now` from its capture time. */
function projectedPositionMs(snapshot: MediaSnapshot, now: number): number | null {
  if (snapshot.capturedAt === undefined) return null;
  const elapsed = isSnapshotPlaying(snapshot) ? (now - snapshot.capturedAt) * snapshot.playbackRate : 0;
  return snapshot.currentTimeMs + elapsed;
}

/**
 * Background Dub fine sync. Within the seek tolerance, nudge the Dub's speed
 * (at most ±4%, pitch preserved by the browser) until it lines up, then return
 * to normal speed. Returns true when the trim changed.
 */
function updateSecondaryRateTrim(state: SyncState): boolean {
  if (!state.backgroundAudio) return false;
  const current = state.secondaryRateTrim ?? 1;
  const setTrim = (value: number) => {
    if (Math.abs(value - current) < RATE_EPSILON) return false;
    state.secondaryRateTrim = value;
    return true;
  };
  const primary = state.primary.snapshot;
  const secondary = state.secondary.snapshot;
  const settled = state.timeline.playing && primary && secondary &&
    isSnapshotPlaying(primary) && isSnapshotPlaying(secondary) &&
    state.primary.status === "playing" && state.secondary.status === "playing" &&
    !state.primary.pendingCommand && !state.secondary.pendingCommand;
  if (!settled) return setTrim(1);
  const now = performance.timeOrigin + performance.now();
  const primaryMs = projectedPositionMs(primary, now);
  const secondaryMs = projectedPositionMs(secondary, now);
  if (primaryMs === null || secondaryMs === null) return false;
  const driftMs = secondaryMs - translatePrimaryTime(primaryMs, state.offsetMs, "secondary");
  const magnitude = Math.abs(driftMs);
  if (magnitude >= state.toleranceMs) return setTrim(1); // Seeking handles large gaps.
  const trimming = Math.abs(current - 1) >= RATE_EPSILON;
  if (magnitude <= TRIM_STOP_MS || (!trimming && magnitude < TRIM_START_MS)) return setTrim(1);
  // Ahead (positive drift) slows down; behind speeds up. Quantized to limit command churn.
  const raw = clamp(-driftMs / TRIM_HORIZON_MS, -MAX_RATE_TRIM, MAX_RATE_TRIM);
  const stepped = Math.round(raw / TRIM_STEP) * TRIM_STEP || Math.sign(raw) * TRIM_STEP;
  return setTrim(1 + stepped);
}

function commandForEndpoint(
  state: SyncState,
  side: Side,
  force: boolean,
  alignPrimary = false,
): VideoCommand | null {
  const endpoint = endpointFor(state, side);
  // Background audio follows the visible video, never corrects it. The sole
  // automatic playback write is Auto Offset lead-in alignment on setup.
  if (state.backgroundAudio && side === "primary" && !(alignPrimary &&
      autoOffsetIsActive(state) && state.offsetMs < 0 && endpoint.snapshot &&
      endpoint.snapshot.currentTimeMs < -state.offsetMs)) return null;
  if (endpoint.status === "lost" || endpoint.status === "play-failed") return null;
  // An ended stream must not be restarted by a slightly older partner
  // snapshot. A new user intent advances the revision and permits rejoining.
  if (!force && endpoint.snapshot?.ended && endpoint.lastAppliedRevision === state.timeline.revision) return null;

  const target = endpointTarget(state, side);
  const shouldPlay =
    state.timeline.playing &&
    target.playable &&
    state.manualPlayRequired !== side;
  const playbackRate = commandRateFor(state, side);

  if (endpoint.pendingCommand?.revision === state.timeline.revision) {
    return null;
  }
  if (endpoint.pendingCommand) endpoint.pendingCommand = null;

  // Don't repeatedly seek an already-running stream while it buffers. A new
  // user revision (or a paused element) still needs its play command delivered.
  if (!force && endpoint.status === "buffering" && shouldPlay &&
      endpoint.snapshot?.paused === false && endpoint.lastAppliedRevision === state.timeline.revision) return null;

  const matches = commandMatchesSnapshot(
    endpoint,
    target.targetMs,
    shouldPlay,
    playbackRate,
    state.toleranceMs,
  );
  if (!force && matches && endpoint.lastAppliedRevision === state.timeline.revision) return null;

  // Only the fine-sync speed differs: change speed without an audible seek.
  const rateOnly = !force && endpoint.lastAppliedRevision === state.timeline.revision &&
    endpoint.snapshot !== null && commandMatchesSnapshot(
      endpoint, target.targetMs, shouldPlay, endpoint.snapshot.playbackRate, state.toleranceMs,
    );

  return {
    commandId: nextCommandId(),
    pairId: state.pairId,
    side,
    revision: state.timeline.revision,
    targetTimeMs: rateOnly ? null : target.targetMs,
    playbackRate,
    shouldPlay,
    forceSeek: force || !isWithinTolerance(
      endpoint.snapshot?.currentTimeMs ?? Number.NaN,
      target.targetMs,
      state.toleranceMs,
    ),
  };
}

function pendingFromCommand(command: VideoCommand): EndpointRuntime["pendingCommand"] {
  return {
    commandId: command.commandId,
    revision: command.revision,
    targetTimeMs: command.targetTimeMs,
    shouldPlay: command.shouldPlay,
    playbackRate: command.playbackRate,
  };
}

function isAutoplayFailure(message: string | undefined): boolean {
  // A rejected play() is not inherently an autoplay failure: interrupted
  // requests and unavailable media also mention play(). Keep only the
  // browser-policy signals that can be resolved by a real user gesture.
  return Boolean(message && /autoplay|notallowed|not allowed|user (?:has(?:n't| not)|did(?:n't| not)) interact|user gesture|interaction required|playback was prevented/i.test(message));
}

function isManualPlayBlocked(state: SyncState, side: Side): boolean {
  return state.manualPlayRequired === side && endpointFor(state, side).status === "play-failed";
}

function hasFatalPlaybackFailure(state: SyncState): boolean {
  return state.primary.status === "lost" || state.secondary.status === "lost" ||
    (state.primary.status === "play-failed" && !isManualPlayBlocked(state, "primary")) ||
    (state.secondary.status === "play-failed" && !isManualPlayBlocked(state, "secondary"));
}

async function sendCommand(command: VideoCommand): Promise<CommandResult> {
  const endpoint = endpointFor(activeState as SyncState, command.side);
  try {
    const response = await sendContentRequest(endpoint.endpoint.tabId, {
      type: "COMMAND",
      command,
    }, endpoint.endpoint);
    if (isRecord(response) && response.ok === false) {
      return {
        command,
        ok: false,
        error: contentError(response, "The video rejected the command."),
      };
    }
    return { command, ok: true };
  } catch (error) {
    return {
      command,
      ok: false,
      error: contentError(error, "The content script could not be reached."),
    };
  }
}

function markCommandFailure(state: SyncState, result: CommandResult): void {
  const endpoint = endpointFor(state, result.command.side);
  if (endpoint.pendingCommand?.commandId !== result.command.commandId) return;

  endpoint.pendingCommand = null;
  if (result.command.shouldPlay && isAutoplayFailure(result.error)) {
    endpoint.status = "play-failed";
    state.manualPlayRequired = result.command.side;
    state.message = `${sideLabel(result.command.side)} video needs manual play permission.`;
  } else {
    endpoint.status = "lost";
    state.message = `${sideLabel(result.command.side)} video is unavailable.`;
  }
  updateSyncStatus(state);
}

async function reconcile(state: SyncState, force: boolean, alignPrimary = false): Promise<void> {
  if (activeState !== state) return;

  const commands: VideoCommand[] = [];
  let pendingChanged = false;
  for (const side of sides) {
    const endpoint = endpointFor(state, side);
    const hadStalePending =
      endpoint.pendingCommand !== null &&
      endpoint.pendingCommand.revision !== state.timeline.revision;
    const command = commandForEndpoint(state, side, force, alignPrimary);
    pendingChanged = pendingChanged || hadStalePending;
    if (!command) continue;
    endpoint.pendingCommand = pendingFromCommand(command);
    commands.push(command);
  }
  if (commands.length === 0) {
    if (pendingChanged) await commitState(state);
    return;
  }

  await commitState(state);
  const results = await Promise.all(commands.map(sendCommand));
  let failed = false;
  for (const result of results) {
    if (!result.ok) {
      failed = true;
      markCommandFailure(state, result);
    }
  }
  if (failed) {
    if (state.backgroundAudio) {
      await setVisibleMuted(state, false);
      if (state.backgroundAudio.mode === "offscreen") await closeOffscreenPlayer();
    }
    maybePromoteUnavailableAuthority(state, "command failure");
    updateSyncStatus(state);
    await commitState(state);
  }
}

function eventKey(event: ContentEventMessage): string {
  return `${event.pairId}:${event.side}:${event.videoId}`;
}

function eventSignature(event: ContentEventMessage): string {
  return JSON.stringify({
    event: event.event,
    commandId: event.commandId ?? null,
    error: event.error ?? null,
    snapshot: event.snapshot,
    appliedRevision: event.appliedRevision,
  });
}

function isIntent(event: ContentEventMessage): boolean {
  return event.event.startsWith("intent-");
}

function validEndpointEvent(
  state: SyncState,
  event: ContentEventMessage,
  sender: chrome.runtime.MessageSender,
): boolean {
  const endpoint = endpointFor(state, event.side);
  if (event.pairId !== state.pairId || event.videoId !== endpoint.endpoint.videoId) {
    return false;
  }
  if (endpoint.endpoint.tabId === OFFSCREEN_TAB_ID) {
    return sender.id === chrome.runtime.id &&
      sender.url === chrome.runtime.getURL(OFFSCREEN_PATH) &&
      !sender.tab;
  }
  if (endpoint.endpoint.tabId === HOSTED_TAB_ID) {
    return isHostedSender(sender) && sender.documentId === endpoint.endpoint.documentId;
  }

  const expectedFrameId = endpoint.endpoint.frameId ??
    (endpoint.endpoint.documentId === undefined ? TOP_LEVEL_FRAME_ID : undefined);
  const senderFrameId = sender.frameId ?? TOP_LEVEL_FRAME_ID;
  return sender.id === chrome.runtime.id &&
    sender.tab?.id === endpoint.endpoint.tabId &&
    (expectedFrameId === undefined || senderFrameId === expectedFrameId) &&
    (endpoint.endpoint.documentId === undefined || sender.documentId === endpoint.endpoint.documentId);
}

function acceptLocalSequence(event: ContentEventMessage): boolean {
  const key = eventKey(event);
  const signature = eventSignature(event);
  const previous = lastLocalSequences.get(key);
  if (
    previous !== undefined &&
    event.localSequence < previous
  ) {
    return false;
  }
  if (
    previous !== undefined &&
    event.localSequence === previous &&
    lastLocalEventSignatures.get(key) === signature
  ) {
    return false;
  }
  lastLocalSequences.set(key, event.localSequence);
  lastLocalEventSignatures.set(key, signature);
  return true;
}

function timelinePositionFromEvent(
  state: SyncState,
  side: Side,
  snapshot: MediaSnapshot | null,
): number {
  if (!snapshot) return state.timeline.positionMs;
  return canonicalPositionFor(
    snapshot.currentTimeMs,
    state.offsetMs,
    side,
    !state.backgroundAudio && autoOffsetIsActive(state),
  );
}

function applyIntent(
  state: SyncState,
  event: ContentEventMessage,
  snapshot: MediaSnapshot | null,
): void {
  const endpoint = endpointFor(state, event.side);
  if (state.backgroundAudio && event.side === "secondary") {
    // A real Play click may unlock autoplay, but may not move the leader.
    endpoint.snapshot = cloneSnapshot(snapshot ?? endpoint.snapshot);
    endpoint.status = statusForSnapshot(endpoint.snapshot);
    endpoint.pendingCommand = null;
    if (event.event === "intent-play") state.manualPlayRequired = null;
    updateSyncStatus(state);
    return;
  }
  const currentSnapshot = snapshot ?? endpoint.snapshot;
  const revision = state.timeline.revision + 1;
  let playing = state.timeline.playing;
  let playbackRate = state.timeline.playbackRate;

  switch (event.event) {
    case "intent-play":
      playing = true;
      break;
    case "intent-pause":
      playing = false;
      break;
    case "intent-seek":
      playing = Boolean(currentSnapshot && isSnapshotPlaying(currentSnapshot));
      break;
    case "intent-ratechange":
      playing = Boolean(currentSnapshot && isSnapshotPlaying(currentSnapshot));
      break;
    default:
      return;
  }

  if (currentSnapshot) playbackRate = currentSnapshot.playbackRate;
  state.timeline = {
    revision,
    positionMs: timelinePositionFromEvent(state, event.side, currentSnapshot),
    playing,
    playbackRate,
    authority: event.side,
  };
  endpoint.snapshot = cloneSnapshot(currentSnapshot);
  endpoint.status = statusForSnapshot(currentSnapshot);
  endpoint.pendingCommand = null;
  state.primary.pendingCommand = null;
  state.secondary.pendingCommand = null;
  if (state.backgroundAudio) state.secondaryRateTrim = 1;
  if (event.event === "intent-play" && state.manualPlayRequired === event.side) {
    state.manualPlayRequired = null;
  }
  state.message = null;
  updateSyncStatus(state);
}

function eventAcknowledgesPending(
  state: SyncState,
  endpoint: EndpointRuntime,
  event: ContentEventMessage,
  snapshot: MediaSnapshot | null,
): boolean {
  const pending = endpoint.pendingCommand;
  if (!pending || pending.revision !== state.timeline.revision) return false;
  if (event.commandId) {
    if (event.commandId !== pending.commandId || !snapshot) return false;
    // The content controller acknowledges the requested media state. Do not
    // require HAVE_FUTURE_DATA here: a successful play() can be acknowledged
    // just before a separate native playing/buffering transition.
    const playing = !snapshot.paused && !snapshot.ended;
    return (
      isWithinTolerance(
        snapshot.currentTimeMs,
        pending.targetTimeMs ?? snapshot.currentTimeMs,
        state.toleranceMs,
      ) &&
      playing === pending.shouldPlay &&
      Math.abs(snapshot.playbackRate - pending.playbackRate) <= RATE_EPSILON
    );
  }
  if (!snapshot) return event.event === "remote-ack";

  const playing = isSnapshotPlaying(snapshot);
  return (
    isWithinTolerance(
      snapshot.currentTimeMs,
      pending.targetTimeMs ?? snapshot.currentTimeMs,
      state.toleranceMs,
    ) &&
    playing === pending.shouldPlay &&
    Math.abs(snapshot.playbackRate - pending.playbackRate) <= RATE_EPSILON
  );
}

function maybePromoteUnavailableAuthority(
  state: SyncState,
  reason: string,
): boolean {
  if (state.backgroundAudio) return false;
  // A user pause is authoritative even while the partner's pause command is
  // still in flight. Its previous playing snapshot cannot undo that intent.
  if (!state.timeline.playing) return false;
  const authority = state.timeline.authority;
  const authorityRuntime = endpointFor(state, authority);
  if (
    authorityRuntime.status !== "lost" &&
    authorityRuntime.status !== "ended" &&
    authorityRuntime.status !== "buffering" &&
    authorityRuntime.status !== "play-failed"
  ) {
    return false;
  }

  const replacementSide = otherSide(authority);
  const replacement = endpointFor(state, replacementSide);
  if (isRuntimePlaying(replacement)) {
    const replacementPosition = replacement.snapshot
      ? canonicalPositionFor(
          replacement.snapshot.currentTimeMs,
          state.offsetMs,
          replacementSide,
          autoOffsetIsActive(state),
        )
      : state.timeline.positionMs;
    const replacementRate =
      replacement.snapshot?.playbackRate ?? state.timeline.playbackRate;
    state.timeline = {
      ...state.timeline,
      positionMs: replacementPosition,
      playing: true,
      playbackRate: replacementRate,
      authority: replacementSide,
    };
    state.primary.pendingCommand = null;
    state.secondary.pendingCommand = null;
    state.message = `${sideLabel(authority)} ${reason}; ${sideLabel(replacementSide)} is now authoritative.`;
    return true;
  }

  if (authorityRuntime.status === "lost" || authorityRuntime.status === "ended") {
    state.timeline = { ...state.timeline, playing: false };
  }
  return false;
}

function applyNonIntentEvent(
  state: SyncState,
  event: ContentEventMessage,
  snapshot: MediaSnapshot | null,
): void {
  const endpoint = endpointFor(state, event.side);
  if (endpoint.status === "play-failed" && (event.event === "observation" || event.event === "remote-ack")) return;

  if (event.event === "remote-ack" && event.commandId) {
    if (
      !endpoint.pendingCommand ||
      endpoint.pendingCommand.commandId !== event.commandId
    ) {
      return;
    }
  }
  if (
    event.event === "play-failed" &&
    event.commandId &&
    endpoint.pendingCommand &&
    endpoint.pendingCommand.commandId !== event.commandId
  ) {
    return;
  }

  if (snapshot) endpoint.snapshot = cloneSnapshot(snapshot);
  endpoint.lastAppliedRevision = Math.max(
    endpoint.lastAppliedRevision,
    event.appliedRevision,
  );

  switch (event.event) {
    case "buffering":
      endpoint.status = "buffering";
      if (
        endpoint.pendingCommand &&
        (!event.commandId || endpoint.pendingCommand.commandId === event.commandId)
      ) {
        endpoint.pendingCommand = null;
      }
      break;
    case "playing":
      endpoint.status = "playing";
      break;
    case "ended":
      endpoint.status = "ended";
      if (
        endpoint.pendingCommand &&
        (!event.commandId || endpoint.pendingCommand.commandId === event.commandId)
      ) {
        endpoint.pendingCommand = null;
      }
      break;
    case "play-failed":
      endpoint.status = "play-failed";
      endpoint.pendingCommand = null;
      state.manualPlayRequired = isAutoplayFailure(event.error) ? event.side : null;
      state.message = event.error ?? `${sideLabel(event.side)} media failed to play.`;
      break;
    case "element-lost":
      endpoint.status = "lost";
      endpoint.snapshot = null;
      endpoint.pendingCommand = null;
      break;
    case "remote-ack":
    case "observation":
      endpoint.status = statusForSnapshot(snapshot ?? endpoint.snapshot);
      if (eventAcknowledgesPending(state, endpoint, event, snapshot)) {
        endpoint.pendingCommand = null;
      }
      break;
    default:
      break;
  }

  const authority = state.timeline.authority;
  if (state.backgroundAudio && event.side === "primary" && snapshot &&
      ["observation", "playing", "buffering", "ended"].includes(event.event)) {
    state.timeline.positionMs = snapshot.currentTimeMs;
    state.timeline.playing = isSnapshotPlaying(snapshot);
    state.timeline.playbackRate = snapshot.playbackRate;
  }
  if (
    event.side === authority &&
    snapshot &&
    (event.event === "observation" ||
      event.event === "playing" ||
      event.event === "remote-ack" ||
      event.event === "buffering" ||
      event.event === "ended") &&
    state.timeline.playing
  ) {
    state.timeline.positionMs = canonicalPositionFor(
      snapshot.currentTimeMs,
      state.offsetMs,
      event.side,
      !state.backgroundAudio && autoOffsetIsActive(state),
    );
  }

  // A partner can already be playing when the current authority starts
  // buffering or ends. In that case its next native observation is the first
  // usable signal that it should become authoritative, so promotion must also
  // run for observations and acknowledgements—not only lifecycle events from
  // the authority itself.
  const promoted = maybePromoteUnavailableAuthority(
    state,
    event.event === "observation" || event.event === "remote-ack"
      ? "is still available"
      : event.event,
  );

  if (event.event === "ended" && !promoted) {
    state.message =
      event.side === state.timeline.authority
        ? `${sideLabel(event.side)} ended; sync is paused until the canonical target returns to range.`
        : `${sideLabel(event.side)} ended; it will rejoin when the canonical target returns to range.`;
  }
  if (event.event === "buffering" && !promoted) {
    state.message = `${sideLabel(event.side)} is buffering; the other video was not paused.`;
  }
  if (event.event === "element-lost") {
    state.message = `${sideLabel(event.side)} video element is unavailable.`;
  }
  if (event.event === "playing" && state.manualPlayRequired === event.side) {
    state.manualPlayRequired = null;
  }
  if (state.primary.status === "playing" && state.secondary.status === "playing") {
    state.message = null;
  }
  updateSyncStatus(state);
}

async function handleContentEvent(
  event: ContentEventMessage,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const state = activeState;
  if (!state || !validEndpointEvent(state, event, sender)) return;
  if (state.backgroundAudio && event.side === "primary" &&
      event.event !== "element-lost" && event.event !== "play-failed" &&
      (state.secondary.status !== "play-failed" || isIntent(event))) {
    try { await restoreBackgroundPlayer(state); }
    catch (error) {
      await closeOffscreenPlayer();
      state.secondary.status = "play-failed";
      state.message = contentError(error, "Background audio could not resume.");
      await setVisibleMuted(state, false);
      updateSyncStatus(state);
      await commitState(state);
      return;
    }
  }
  if (!acceptLocalSequence(event)) return;

  const snapshot = event.snapshot === null ? null : normalizeSnapshot(event.snapshot);
  if (event.snapshot !== null && !snapshot) return;

  // A terminal error belongs to the verified media element, not its playback
  // position. It can arrive from a recreated player while Sub advances the
  // timeline revision; dropping it strands the pair in buffering forever.
  const sourceFailed = event.event === "play-failed" && !event.commandId;
  if (!isIntent(event) && event.event !== "element-lost" && !sourceFailed &&
      !(state.backgroundAudio && event.side === "primary" && !state.primary.pendingCommand)) {
    if (event.appliedRevision < state.timeline.revision) return;
    if (event.appliedRevision > state.timeline.revision) return;
  }

  if (isIntent(event)) {
    applyIntent(state, event, snapshot);
  } else {
    applyNonIntentEvent(state, event, snapshot);
  }

  const autoOffsetChanged = refreshAutoOffset(state);
  if (
    autoOffsetChanged &&
    snapshot &&
    ((isIntent(event) && (!state.backgroundAudio || event.side === "primary")) ||
      (state.timeline.authority === event.side && state.timeline.playing))
  ) {
    state.timeline.positionMs = canonicalPositionFor(
      snapshot.currentTimeMs,
      state.offsetMs,
      event.side,
      autoOffsetIsActive(state),
    );
  }

  if (state.backgroundAudio) {
    if ((event.event === "element-lost" || event.event === "play-failed") && event.side === "primary") {
      await stopExistingSync();
      return;
    }
    if (
      event.side === "secondary" &&
      // A user Play gesture on the Dub tab advances the sync revision before
      // its following `playing` event may arrive. Use accepted ready/playing
      // state, not that one event name, to restore mute after autoplay recovery.
      isSnapshotPlaying(snapshot) &&
      event.event !== "play-failed" &&
      state.backgroundAudio.muteOriginal
    ) {
      await setVisibleMuted(state, true);
    }
    if (event.event === "play-failed" || event.event === "element-lost") {
      if (state.backgroundAudio.mode === "offscreen") await closeOffscreenPlayer();
      await setVisibleMuted(state, false);
      if (event.side === "secondary") {
        state.message = event.error ?? (state.backgroundAudio.mode === "hosted"
          ? "The hidden Dub page stopped playing."
          : "Background audio failed. Check the media URL or use the two-tab fallback.");
      }
    }
  }

  if (!isIntent(event)) updateSecondaryRateTrim(state);
  await commitState(state);
  if (event.event !== "play-failed" && event.event !== "element-lost") {
    await reconcile(state, false, autoOffsetChanged);
  }
}

async function stopSync(): Promise<BackgroundResponse> {
  await stopExistingSync();
  await closeOffscreenPlayer();
  await commitState(null);
  return { ok: true, state: null };
}

function unavailableEndpointForTab(state: SyncState, tabId: number): Side | null {
  if (state.primary.endpoint.tabId === tabId) return "primary";
  if (state.secondary.endpoint.tabId === tabId) return "secondary";
  return null;
}

async function handleTabUnavailable(
  tabId: number,
  reason: "closed" | "navigated",
): Promise<void> {
  clearInjectedTargets(tabId);
  const state = activeState;
  if (!state) return;
  const side = unavailableEndpointForTab(state, tabId);
  if (!side) return;
  if (state.backgroundAudio) { await stopExistingSync(); return; }

  const endpoint = endpointFor(state, side);
  endpoint.status = "lost";
  endpoint.snapshot = null;
  endpoint.pendingCommand = null;
  state.message = `${sideLabel(side)} tab ${reason}; sync is degraded.`;
  maybePromoteUnavailableAuthority(state, `tab ${reason}`);
  updateSyncStatus(state);
  await commitState(state);
}

const autoDub = setupAutoDub({
  enqueue, getState: () => activeState, probe: probeTab,
  startHosted: startHostedDub, stop: stopExistingSync,
  findDub: findHostedDub, findReplacement: findReplacementDub, closeHost,
});

// Hosted frames have no tab, so their media events arrive over the host channel.
onHostedVideoEvent((message, sender) => {
  if (!isContentEvent(message)) return;
  void enqueue(() => handleContentEvent(message, sender)).catch(() => undefined);
});

onHostLost(reason => {
  void enqueue(async () => {
    const state = activeState;
    if (state?.backgroundAudio?.mode !== "hosted") return;
    state.secondary.status = "lost";
    state.secondary.snapshot = null;
    state.secondary.pendingCommand = null;
    state.message = reason;
    await setVisibleMuted(state, false);
    updateSyncStatus(state);
    await commitState(state);
  }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    // Runtime messages reach every extension context. Only the offscreen
    // document must answer these; replying here races its actual response.
    if (isRecord(message) && message.target === "offscreen") return false;
    if (!isContentEvent(message) && !isBackgroundRequest(message)) return false;
    if (isContentEvent(message)) {
      void enqueue(async () => {
        await handleContentEvent(message, sender);
        return { ok: true };
      }).then(
        (response) => sendResponse(response),
        (error) => sendResponse({ ok: false, error: contentError(error, "Event rejected.") }),
      );
      return true;
    }

    void enqueue(async (): Promise<BackgroundResponse> => {
      if (!isBackgroundRequest(message)) {
        return { ok: false, error: "Unknown background request." };
      }

      switch (message.type) {
        case "GET_STATE":
          return { ok: true, state: cloneState(activeState) };
        case "PROBE_TAB": {
          const probe = await probeTab(message.tabId);
          autoDub.refresh(message.tabId);
          return { ok: probe.ok, probe, error: probe.error };
        }
        case "START_SYNC":
          await autoDub.disable();
          return startSync(message.config);
        case "START_BACKGROUND_AUDIO":
          await autoDub.disable();
          return startBackgroundAudio(message.config);
        case "SET_BACKGROUND_VOLUME": {
          if (!activeState?.backgroundAudio && autoDub.enabled()) {
            await autoDub.updatePreferences({ volume: message.volume });
            return { ok: true, state: cloneState(activeState) };
          }
          const result = await setBackgroundVolume(message.volume);
          if (result.ok) await autoDub.updatePreferences({ volume: message.volume });
          return result;
        }
        case "SET_MUTE_ORIGINAL": {
          if (!activeState?.backgroundAudio && autoDub.enabled()) {
            await autoDub.updatePreferences({ muteOriginal: message.muteOriginal });
            return { ok: true, state: cloneState(activeState) };
          }
          const result = await setMuteOriginal(message.muteOriginal);
          if (result.ok) await autoDub.updatePreferences({ muteOriginal: message.muteOriginal });
          return result;
        }
        case "SET_MANUAL_OFFSET": {
          const state = activeState;
          if (!state) {
            if (autoDub.enabled()) {
              await autoDub.updatePreferences({ offsetMs: message.offsetMs });
              return { ok: true, state: null };
            }
            return { ok: false, error: "Sync is not active." };
          }
          const resolved = resolveAutoOffset(
            message.offsetMs,
            state.autoOffset,
            state.primary.snapshot?.durationMs,
            state.secondary.snapshot?.durationMs,
          );
          state.offsetMs = resolved.offsetMs;
          state.autoOffsetPending = resolved.pending;
          state.manualOffsetMs = message.offsetMs;
          // A timing correction changes Dub's target, never the visible Sub position.
          state.timeline = { ...state.timeline, revision: state.timeline.revision + 1 };
          state.secondary.pendingCommand = null;
          await commitState(state);
          await reconcile(state, true);
          await autoDub.updatePreferences({ offsetMs: message.offsetMs });
          return { ok: true, state: cloneState(state) };
        }
        case "SET_AUTO_OFFSET": {
          if (!activeState && autoDub.enabled()) {
            await autoDub.updatePreferences({ autoOffset: message.enabled });
            return { ok: true, state: null };
          }
          const result = await setAutoOffset(message.enabled);
          if (result.ok) await autoDub.updatePreferences({ autoOffset: message.enabled });
          return result;
        }
        case "STOP_SYNC":
          await autoDub.disable();
          return stopSync();
        default:
          // GET_LANGUAGE_DETECTION is intentionally left to the dedicated
          // detection listener; this worker's validator does not claim it.
          return { ok: false, error: "Unknown background request." };
      }
    }).then(
      (response) => sendResponse(response),
      (error) => sendResponse({ ok: false, error: contentError(error, "Request failed.") }),
    );
    return true;
  },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueue(() => handleTabUnavailable(tabId, "closed")).catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading" && changeInfo.url === undefined) return;
  void enqueue(() => handleTabUnavailable(tabId, "navigated")).catch(() => undefined);
});

// Diagnostics for automated tests (not reachable from web pages): sample both
// endpoints concurrently and estimate the Dub's drift from its target position.
async function sampleSyncDrift(): Promise<unknown> {
  const state = activeState;
  if (!state) return null;
  const sample = async (endpoint: VideoEndpoint) => {
    const sent = performance.now();
    const response = await sendContentRequest(endpoint.tabId, { type: "PROBE" }, endpoint);
    const received = performance.now();
    const videos = isRecord(response) && Array.isArray(response.videos) ? response.videos as VideoDescriptor[] : [];
    const video = videos.find(item => item.id === endpoint.videoId);
    return video ? { video, at: (sent + received) / 2, rtt: received - sent } : null;
  };
  const [primary, secondary] = await Promise.all([sample(state.primary.endpoint), sample(state.secondary.endpoint)]);
  if (!primary || !secondary) return { ok: false, primary: Boolean(primary), secondary: Boolean(secondary) };
  const at = (primary.at + secondary.at) / 2;
  const project = (s: NonNullable<typeof primary>) =>
    s.video.currentTimeMs + (s.video.paused ? 0 : (at - s.at) * s.video.playbackRate);
  const primaryMs = project(primary);
  const secondaryMs = project(secondary);
  return {
    ok: true,
    primaryMs, secondaryMs,
    offsetMs: state.offsetMs,
    driftMs: secondaryMs - (primaryMs + state.offsetMs),
    primaryPaused: primary.video.paused, secondaryPaused: secondary.video.paused,
    rate: [primary.video.playbackRate, secondary.video.playbackRate],
    rttMs: [primary.rtt, secondary.rtt],
    status: state.status,
  };
}
(globalThis as typeof globalThis & { subviewDiagnostics?: unknown }).subviewDiagnostics = {
  sampleSyncDrift,
  host: () => ({ container: currentHost(), frames: hostedFrames(), refused: refusedConnections }),
  /** Every video in the hidden copy, as its agents see them. */
  hostedVideos: () => Promise.all(hostedFrames().map(frame =>
    hostedRequest(frame.key, { type: "PROBE" }).then(response => ({ href: frame.href, response }), error => ({ href: frame.href, error: String(error) })))),
};
