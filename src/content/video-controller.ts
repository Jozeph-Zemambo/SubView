import {
  clampToDuration,
  DEFAULT_TOLERANCE_MS,
  finiteOrNull,
  targetIsPlayable,
} from "../shared/time";
import type {
  ContentEventMessage,
  ContentEventName,
  MediaSnapshot,
  Side,
  VideoDescriptor,
  VideoCommand,
} from "../shared/types";
import { findVideoById, probeVideos } from "./video-probe";

const MEDIA_EVENT_NAMES = [
  "play",
  "pause",
  "seeking",
  "seeked",
  "ratechange",
  "playing",
  "waiting",
  "stalled",
  "ended",
  "timeupdate",
  "loadedmetadata",
  "canplay",
  "durationchange",
  "error",
] as const;

type MediaEventName = (typeof MEDIA_EVENT_NAMES)[number];

const TIME_MATCH_EPSILON_MS = 1;
const RATE_MATCH_EPSILON = 0.000001;

export interface ContentControllerResponse {
  ok: boolean;
  error?: string;
  videoId?: string;
  pairId?: string;
  side?: Side;
  appliedRevision?: number;
  snapshot?: MediaSnapshot | null;
  commandId?: string;
}

export type ContentMessageSender = (message: ContentEventMessage) => unknown;

export interface VideoControllerOptions {
  sendMessage?: ContentMessageSender;
}

interface ActiveSelection {
  pairId: string;
  side: Side;
  videoId: string;
  element: HTMLVideoElement;
  originalMuted: boolean | null;
}

interface ExpectedRemoteState {
  command: VideoCommand;
  commandId: string;
  revision: number;
  expectedTimeMs: number | null;
  expectedPlaying: boolean;
  expectedPlaybackRate: number;
  timePending: boolean;
  playbackPending: boolean;
  ratePending: boolean;
  metadataPending: boolean;
  readyToClear: boolean;
}

interface Acknowledgement {
  commandId: string;
  revision: number;
}

interface ExpectedEventResult {
  matched: boolean;
  acknowledgement: Acknowledgement | null;
}

function sendRuntimeMessage(message: ContentEventMessage): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

  try {
    const result = chrome.runtime.sendMessage(message);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // A service worker can be asleep or have no receiver. Content events are
    // best-effort; a later command or activation can establish the connection.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const candidate = error as { message?: unknown; name?: unknown };
    if (typeof candidate.message === "string" && candidate.message) {
      return candidate.message;
    }
    if (typeof candidate.name === "string" && candidate.name) return candidate.name;
  }
  try {
    return String(error);
  } catch {
    return "Unknown error";
  }
}

function sameTime(left: number, right: number): boolean {
  return Math.abs(left - right) <= TIME_MATCH_EPSILON_MS;
}

function sameRate(left: number, right: number): boolean {
  return Math.abs(left - right) <= RATE_MATCH_EPSILON;
}

function isPlaying(snapshot: MediaSnapshot): boolean {
  return !snapshot.paused && !snapshot.ended;
}

function mediaSnapshot(video: HTMLVideoElement): MediaSnapshot {
  const duration = finiteOrNull(video.duration);
  return {
    currentTimeMs: Number.isFinite(video.currentTime)
      ? Math.max(0, Math.round(video.currentTime * 1000))
      : 0,
    durationMs: duration === null ? null : Math.max(0, Math.round(duration * 1000)),
    paused: video.paused,
    ended: video.ended,
    playbackRate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
    readyState: video.readyState,
    canPlay: video.readyState >= 3,
    capturedAt: performance.timeOrigin + performance.now(),
  };
}

function elementIsPresent(video: HTMLVideoElement): boolean {
  if (video.isConnected === false) return false;
  if (typeof document.contains === "function") return document.contains(video);
  return true;
}

export class VideoController {
  private readonly sendMessage: ContentMessageSender;
  private activeSelection: ActiveSelection | null = null;
  private mutationObserver: MutationObserver | null = null;
  private readonly mediaListeners = new Map<MediaEventName, EventListener>();
  private muteGuard: EventListener | null = null;
  private expectedRemoteState: ExpectedRemoteState | null = null;
  private appliedRevision = 0;
  private lastCommandRevision: number | null = null;
  private lastCommandId: string | null = null;
  private localSequence = 0;
  private userSeeking = false;
  private readonly handlePageHide = (): void => {
    // A frame leaving its document loses the selected endpoint even when its
    // parent tab does not navigate. Release mute and stop its hidden partner.
    this.reportElementLost();
  };

  public constructor(
    optionsOrSender: VideoControllerOptions | ContentMessageSender = {},
  ) {
    this.sendMessage =
      typeof optionsOrSender === "function"
        ? optionsOrSender
        : optionsOrSender.sendMessage ?? sendRuntimeMessage;

    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", this.handlePageHide);
    }
  }

  public probe(): VideoDescriptor[] {
    return probeVideos();
  }

  public activate(
    pairId: string,
    side: Side,
    videoId: string,
    revision: number,
  ): ContentControllerResponse {
    if (!Number.isFinite(revision)) {
      return { ok: false, error: "Activation revision must be finite" };
    }

    const found = findVideoById(videoId);
    if (!found) {
      return { ok: false, error: `Video not found: ${videoId}` };
    }

    if (
      this.activeSelection &&
      this.activeSelection.pairId === pairId &&
      this.activeSelection.side === side &&
      this.activeSelection.videoId === videoId &&
      this.activeSelection.element === found
    ) {
      this.appliedRevision = Math.max(this.appliedRevision, revision);
      this.expectedRemoteState = null;
      this.lastCommandRevision = null;
      this.lastCommandId = null;
      return this.activationResponse();
    }

    this.detachActiveElement();
    this.activeSelection = {
      pairId,
      side,
      videoId,
      element: found,
      originalMuted: null,
    };
    this.appliedRevision = revision;
    this.expectedRemoteState = null;
    this.lastCommandRevision = null;
    this.lastCommandId = null;
    this.userSeeking = false;
    this.attachActiveElement(found);
    return this.activationResponse();
  }

  public setMuted(pairId: string, muted: boolean): ContentControllerResponse {
    const active = this.activeSelection;
    if (!active) return { ok: false, error: "No video is active" };
    if (active.pairId !== pairId) {
      return { ok: false, error: "Mute pair does not match the active pair" };
    }

    if (!elementIsPresent(active.element)) {
      this.reportElementLost();
      return { ok: false, error: "The active video element is no longer present" };
    }

    if (muted) {
      if (active.originalMuted === null) {
        active.originalMuted = active.element.muted;
      }
      active.element.muted = true;
    } else if (active.originalMuted !== null) {
      active.element.muted = active.originalMuted;
      active.originalMuted = null;
    }

    return {
      ok: true,
      pairId: active.pairId,
      side: active.side,
      videoId: active.videoId,
      appliedRevision: this.appliedRevision,
      snapshot: mediaSnapshot(active.element),
    };
  }

  public setVolume(pairId: string, volume: number): ContentControllerResponse {
    const active = this.activeSelection;
    if (!active) return { ok: false, error: "No video is active" };
    if (active.pairId !== pairId) {
      return { ok: false, error: "Volume pair does not match the active pair" };
    }
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      return { ok: false, error: "Volume must be a number from 0 to 1" };
    }

    if (!elementIsPresent(active.element)) {
      this.reportElementLost();
      return { ok: false, error: "The active video element is no longer present" };
    }

    active.element.volume = volume;
    // The retained Dub tab is intentionally muted while it is being
    // discovered. Once the coordinator has activated this secondary
    // endpoint, volume configuration is the ownership boundary at which it
    // becomes audible. Never alter a primary element's mute preference here.
    if (active.side === "secondary") active.element.muted = false;
    return {
      ok: true,
      pairId: active.pairId,
      side: active.side,
      videoId: active.videoId,
      appliedRevision: this.appliedRevision,
      snapshot: mediaSnapshot(active.element),
    };
  }

  public deactivate(pairId: string): ContentControllerResponse {
    if (!this.activeSelection) return { ok: true, pairId };
    if (this.activeSelection.pairId !== pairId) {
      return { ok: false, error: "A different sync pair is active" };
    }

    this.detachActiveElement();
    this.activeSelection = null;
    this.expectedRemoteState = null;
    this.lastCommandRevision = null;
    this.lastCommandId = null;
    this.userSeeking = false;
    return { ok: true, pairId };
  }

  public applyCommand(command: VideoCommand): ContentControllerResponse {
    const active = this.activeSelection;
    if (!active) return { ok: false, error: "No video is active" };
    if (active.pairId !== command.pairId) {
      return { ok: false, error: "Command pair does not match the active pair" };
    }
    if (active.side !== command.side) {
      return { ok: false, error: "Command side does not match the active side" };
    }
    if (!Number.isFinite(command.revision)) {
      return { ok: false, error: "Command revision must be finite" };
    }
    if (!Number.isFinite(command.playbackRate) || command.playbackRate <= 0) {
      return { ok: false, error: "Command playback rate must be positive and finite" };
    }
    if (
      command.targetTimeMs !== null &&
      (!Number.isFinite(command.targetTimeMs) || command.targetTimeMs < 0)
    ) {
      return { ok: false, error: "Command target time must be null or a non-negative number" };
    }

    if (this.isDuplicateCommand(command)) {
      return this.commandResponse(command.commandId);
    }
    if (this.isStaleCommand(command)) {
      return { ok: false, error: "Command revision is older than the applied revision" };
    }

    if (!elementIsPresent(active.element)) {
      this.reportElementLost();
      return { ok: false, error: "The active video element is no longer present" };
    }

    const video = active.element;
    const before = mediaSnapshot(video);
    const durationMs = before.durationMs;
    const effectiveTargetMs =
      command.targetTimeMs === null
        ? null
        : Math.round(clampToDuration(command.targetTimeMs, durationMs));
    const targetCanPlay =
      effectiveTargetMs === null || targetIsPlayable(effectiveTargetMs, durationMs);
    const expectedPlaying = command.shouldPlay && targetCanPlay;
    const metadataPending = command.targetTimeMs !== null && video.readyState < 1;
    const previousExpected = this.expectedRemoteState;
    const ratePending = !sameRate(before.playbackRate, command.playbackRate);
    const timePending = Boolean(
      effectiveTargetMs !== null &&
        (command.forceSeek || !sameTime(before.currentTimeMs, effectiveTargetMs)),
    ) || Boolean(
      previousExpected?.timePending &&
        previousExpected.expectedTimeMs !== null &&
        effectiveTargetMs !== null &&
        sameTime(previousExpected.expectedTimeMs, effectiveTargetMs),
    );
    const playbackPending =
      isPlaying(before) !== expectedPlaying ||
      Boolean(
        previousExpected?.playbackPending &&
          previousExpected.expectedPlaying === expectedPlaying,
      );
    const carriedRatePending = Boolean(
      previousExpected?.ratePending &&
        sameRate(previousExpected.expectedPlaybackRate, command.playbackRate),
    );
    const expected: ExpectedRemoteState = {
      command,
      commandId: command.commandId,
      revision: command.revision,
      expectedTimeMs: effectiveTargetMs,
      expectedPlaying,
      expectedPlaybackRate: command.playbackRate,
      timePending,
      playbackPending,
      ratePending: ratePending || carriedRatePending,
      metadataPending,
      readyToClear: false,
    };

    this.appliedRevision = command.revision;
    this.lastCommandRevision = command.revision;
    this.lastCommandId = command.commandId;
    this.expectedRemoteState = expected;

    if (metadataPending) {
      // A media element with HAVE_NOTHING cannot accept a reliable seek yet.
      // Keep the complete desired command until loadedmetadata supplies the
      // duration and makes currentTime writable.
      return this.commandResponse(command.commandId, before);
    }

    try {
      this.applyExpectedState(video, active, expected);
    } catch (error) {
      this.expectedRemoteState = null;
      return {
        ok: false,
        error: errorMessage(error),
        commandId: command.commandId,
        appliedRevision: this.appliedRevision,
      };
    }

    this.clearCompletedExpectedState(expected);
    // If all requested state was already present, no native event may fire.
    // A synchronous acknowledgement keeps the worker's pending-command state
    // from waiting for an unrelated future timeupdate.
    if (this.expectedRemoteState === null && this.expectedStateIsComplete(expected)) {
      this.emit("remote-ack", mediaSnapshot(video), command.commandId);
    }
    return this.commandResponse(command.commandId, mediaSnapshot(video));
  }

  private activationResponse(): ContentControllerResponse {
    const active = this.activeSelection;
    return {
      ok: true,
      pairId: active?.pairId,
      side: active?.side,
      videoId: active?.videoId,
      appliedRevision: this.appliedRevision,
      snapshot: active ? mediaSnapshot(active.element) : null,
    };
  }

  private commandResponse(
    commandId: string,
    snapshot: MediaSnapshot | null = this.activeSelection
      ? mediaSnapshot(this.activeSelection.element)
      : null,
  ): ContentControllerResponse {
    return {
      ok: true,
      commandId,
      videoId: this.activeSelection?.videoId,
      appliedRevision: this.appliedRevision,
      snapshot,
    };
  }

  private isDuplicateCommand(command: VideoCommand): boolean {
    return (
      this.lastCommandRevision === command.revision &&
      this.lastCommandId === command.commandId
    );
  }

  private isStaleCommand(command: VideoCommand): boolean {
    if (this.lastCommandRevision !== null) {
      return command.revision < this.lastCommandRevision;
    }
    return command.revision < this.appliedRevision;
  }

  private attachActiveElement(video: HTMLVideoElement): void {
    for (const eventName of MEDIA_EVENT_NAMES) {
      const listener: EventListener = (event) => {
        this.handleMediaEvent(video, eventName, event);
      };
      this.mediaListeners.set(eventName, listener);
      video.addEventListener(eventName, listener);
    }

    // Players re-apply their own volume (after a seek, a quality switch or an
    // ad). While SubView mutes the original, keep it muted; the popup's mute
    // switch is how a user hears it again.
    this.muteGuard = () => {
      const active = this.activeSelection;
      if (active?.element === video && active.originalMuted !== null && !video.muted) video.muted = true;
    };
    video.addEventListener("volumechange", this.muteGuard);

    if (typeof MutationObserver === "function") {
      this.mutationObserver = new MutationObserver(() => {
        if (this.activeSelection?.element !== video) return;
        if (!elementIsPresent(video)) this.reportElementLost();
      });
      this.mutationObserver.observe(document, { childList: true, subtree: true });
    }
  }

  private detachActiveElement(): void {
    const active = this.activeSelection;
    if (active) {
      this.restoreOriginalMute(active);
      for (const [eventName, listener] of this.mediaListeners) {
        active.element.removeEventListener(eventName, listener);
      }
      if (this.muteGuard) active.element.removeEventListener("volumechange", this.muteGuard);
    }
    this.muteGuard = null;
    this.mediaListeners.clear();
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.expectedRemoteState = null;
  }

  private restoreOriginalMute(active: ActiveSelection): void {
    if (active.originalMuted === null) return;
    active.element.muted = active.originalMuted;
    active.originalMuted = null;
  }

  private reportElementLost(): void {
    const active = this.activeSelection;
    if (!active) return;

    const appliedRevision = this.appliedRevision;
    this.detachActiveElement();
    this.activeSelection = null;
    this.lastCommandRevision = null;
    this.lastCommandId = null;
    this.emitForSelection(active, appliedRevision, "element-lost", null);
  }

  private handleMediaEvent(
    video: HTMLVideoElement,
    eventName: MediaEventName,
    event?: Event,
  ): void {
    const active = this.activeSelection;
    if (!active || active.element !== video) return;
    if (!elementIsPresent(video)) {
      this.reportElementLost();
      return;
    }

    const snapshot = mediaSnapshot(video);
    switch (eventName) {
      case "play": {
        // Native media events are queued. A stale play event can arrive after
        // a newer pause command has already taken effect; the current
        // snapshot, not the event name alone, is authoritative.
        if (snapshot.paused || snapshot.ended) return;
        const acknowledgement = this.acknowledgeExpected("playback", snapshot);
        if (acknowledgement.matched) {
          if (acknowledgement.acknowledgement) {
            this.emitAcknowledgement(acknowledgement.acknowledgement, snapshot);
          }
          return;
        }
        this.cancelExpectedRemoteState();
        this.emit("intent-play", snapshot);
        return;
      }
      case "pause": {
        // Likewise, do not turn an obsolete pause event into an intent to
        // pause a video that is already playing again.
        if (!snapshot.paused) return;
        // Reaching the end can produce a pause event as part of the media
        // lifecycle. It is a terminal state, not a user pause, so never
        // propagate it as an instruction to stop the partner video.
        if (snapshot.ended) {
          const acknowledgement = this.acknowledgeExpected("playback", snapshot);
          if (acknowledgement.matched) {
            if (acknowledgement.acknowledgement) {
              this.emitAcknowledgement(acknowledgement.acknowledgement, snapshot);
            } else {
              this.emitStatus("ended", snapshot, null);
            }
            return;
          }
          this.emitStatus("ended", snapshot, null);
          return;
        }
        const acknowledgement = this.acknowledgeExpected("playback", snapshot);
        if (acknowledgement.matched) {
          if (acknowledgement.acknowledgement) {
            this.emitAcknowledgement(acknowledgement.acknowledgement, snapshot);
          }
          return;
        }
        this.cancelExpectedRemoteState();
        this.emit("intent-pause", snapshot);
        return;
      }
      case "seeking":
        // A seek is only a candidate here. Commit it at seeked so drag events
        // do not become a stream of user intents.
        this.userSeeking = true;
        return;
      case "seeked": {
        // A queued seek completion is not a committed position while another
        // seek is still active. Wait for the native completion that observes
        // the settled currentTime.
        if (video.seeking) return;
        this.userSeeking = false;
        const acknowledgement = this.acknowledgeExpected("time", snapshot);
        if (acknowledgement.matched) {
          if (acknowledgement.acknowledgement) {
            this.emitAcknowledgement(acknowledgement.acknowledgement, snapshot);
          }
          return;
        }
        this.cancelExpectedRemoteState();
        this.emit("intent-seek", snapshot);
        return;
      }
      case "ratechange": {
        const acknowledgement = this.acknowledgeExpected("rate", snapshot);
        if (acknowledgement.matched) {
          if (acknowledgement.acknowledgement) {
            this.emitAcknowledgement(acknowledgement.acknowledgement, snapshot);
          }
          return;
        }
        this.cancelExpectedRemoteState();
        this.emit("intent-ratechange", snapshot);
        return;
      }
      case "playing": {
        if (snapshot.paused || snapshot.ended) return;
        const acknowledgement = this.acknowledgeExpected("playback", snapshot);
        if (
          !acknowledgement.matched &&
          this.expectedRemoteState?.playbackPending &&
          !this.expectedRemoteState.expectedPlaying
        ) {
          this.cancelExpectedRemoteState();
        }
        this.emitStatus("playing", snapshot, acknowledgement.acknowledgement);
        return;
      }
      case "waiting":
      case "stalled":
        this.emit("buffering", snapshot);
        return;
      case "error": {
        this.reportMediaFailure(active, this.mediaErrorMessage(video, event));
        return;
      }
      case "ended": {
        if (!snapshot.ended) return;
        const acknowledgement = this.acknowledgeExpected("playback", snapshot);
        if (
          !acknowledgement.matched &&
          this.expectedRemoteState?.playbackPending &&
          this.expectedRemoteState.expectedPlaying
        ) {
          this.cancelExpectedRemoteState();
        }
        this.emitStatus("ended", snapshot, acknowledgement.acknowledgement);
        return;
      }
      case "timeupdate":
        // During a scrub, intermediate timeupdate events describe the drag,
        // not a committed user position. The seeked event is the intent.
        if (video.seeking || this.userSeeking) return;
        this.emit("observation", snapshot);
        return;
      case "loadedmetadata":
        this.resumePendingCommand(video, active);
        if (!this.activeSelection || this.activeSelection.element !== video) return;
        this.emit("observation", mediaSnapshot(video));
        return;
      case "canplay":
      case "durationchange":
        if (video.readyState >= 1) this.resumePendingCommand(video, active);
        if (!this.activeSelection || this.activeSelection.element !== video) return;
        this.emit("observation", mediaSnapshot(video));
        return;
    }
  }

  private acknowledgeExpected(
    kind: "time" | "playback" | "rate",
    snapshot: MediaSnapshot,
  ): ExpectedEventResult {
    const expected = this.expectedRemoteState;
    if (!expected) return { matched: false, acknowledgement: null };

    let matched = false;
    if (kind === "time" && expected.expectedTimeMs !== null) {
      matched = expected.expectedPlaying && isPlaying(snapshot)
        ? Math.abs(snapshot.currentTimeMs - expected.expectedTimeMs) <= DEFAULT_TOLERANCE_MS
        : sameTime(snapshot.currentTimeMs, expected.expectedTimeMs);
      if (matched) expected.timePending = false;
    }
    if (kind === "rate") {
      matched = sameRate(snapshot.playbackRate, expected.expectedPlaybackRate);
      if (matched) expected.ratePending = false;
    }
    if (kind === "playback") {
      matched = isPlaying(snapshot) === expected.expectedPlaying;
      if (matched) expected.playbackPending = false;
    }

    if (!matched) return { matched: false, acknowledgement: null };
    const completed =
      !expected.timePending &&
      !expected.playbackPending &&
      !expected.ratePending &&
      expected.readyToClear;
    if (!completed) return { matched: true, acknowledgement: null };

    const acknowledgement: Acknowledgement = {
      commandId: expected.commandId,
      revision: expected.revision,
    };
    this.clearCompletedExpectedState(expected);
    return { matched: true, acknowledgement };
  }

  private clearCompletedExpectedState(expected: ExpectedRemoteState): void {
    if (this.expectedStateIsComplete(expected) && this.expectedRemoteState === expected) {
      this.expectedRemoteState = null;
    }
  }

  private expectedStateIsComplete(expected: ExpectedRemoteState): boolean {
    return (
      !expected.metadataPending &&
      !expected.timePending &&
      !expected.playbackPending &&
      !expected.ratePending &&
      expected.readyToClear
    );
  }

  private cancelExpectedRemoteState(): void {
    this.expectedRemoteState = null;
  }

  private applyExpectedState(
    video: HTMLVideoElement,
    active: ActiveSelection,
    expected: ExpectedRemoteState,
  ): void {
    const command = expected.command;
    if (expected.metadataPending) return;

    if (expected.ratePending) {
      video.playbackRate = command.playbackRate;
      const afterRate = mediaSnapshot(video).playbackRate;
      expected.expectedPlaybackRate = afterRate;
    }

    if (expected.timePending && expected.expectedTimeMs !== null) {
      video.currentTime = expected.expectedTimeMs / 1000;
    }

    const afterSeek = mediaSnapshot(video);
    const currentPlaying = isPlaying(afterSeek);
    if (currentPlaying !== expected.expectedPlaying) {
      if (expected.expectedPlaying) {
        this.startPlayback(video, command, active);
      } else {
        // A target at/beyond the known duration is deliberately left paused or
        // ended; calling play() there can restart an ended media element.
        video.pause();
      }
    }

    expected.readyToClear = true;
  }

  private resumePendingCommand(
    video: HTMLVideoElement,
    active: ActiveSelection,
  ): void {
    const expected = this.expectedRemoteState;
    if (!expected?.metadataPending || expected.command.targetTimeMs === null) return;
    if (this.activeSelection !== active || active.element !== video) return;
    if (video.readyState < 1) return;

    const snapshot = mediaSnapshot(video);
    const durationMs = snapshot.durationMs;
    const effectiveTargetMs = Math.round(
      clampToDuration(expected.command.targetTimeMs, durationMs),
    );
    const targetCanPlay = targetIsPlayable(effectiveTargetMs, durationMs);
    expected.expectedTimeMs = effectiveTargetMs;
    expected.expectedPlaying = expected.command.shouldPlay && targetCanPlay;
    expected.timePending =
      expected.command.forceSeek || !sameTime(snapshot.currentTimeMs, effectiveTargetMs);
    expected.playbackPending = isPlaying(snapshot) !== expected.expectedPlaying;
    expected.ratePending = !sameRate(
      snapshot.playbackRate,
      expected.command.playbackRate,
    );
    expected.metadataPending = false;
    expected.readyToClear = false;

    try {
      this.applyExpectedState(video, active, expected);
    } catch (error) {
      // A page can report loadedmetadata while still transitioning the media
      // resource. Keep the desired command until a later native readiness
      // event instead of turning it into a lost command or user intent.
      if (video.readyState < 1) {
        expected.metadataPending = true;
        expected.readyToClear = false;
        return;
      }
      this.expectedRemoteState = null;
      this.emitForSelection(
        active,
        expected.revision,
        "play-failed",
        mediaSnapshot(video),
        expected.commandId,
        errorMessage(error),
      );
      return;
    }

    this.clearCompletedExpectedState(expected);
    if (this.expectedRemoteState === null && this.expectedStateIsComplete(expected)) {
      this.emit("remote-ack", mediaSnapshot(video), expected.commandId);
    }
  }

  private startPlayback(
    video: HTMLVideoElement,
    command: VideoCommand,
    active: ActiveSelection,
  ): void {
    let playResult: Promise<void> | void;
    try {
      playResult = video.play();
    } catch (error) {
      this.reportPlayFailure(command, active, error);
      return;
    }

    if (playResult && typeof (playResult as PromiseLike<void>).then === "function") {
      void Promise.resolve(playResult).catch((error: unknown) => {
        this.reportPlayFailure(command, active, error);
      });
    }
  }

  private reportPlayFailure(
    command: VideoCommand,
    active: ActiveSelection,
    error: unknown,
  ): void {
    if (
      this.activeSelection !== active ||
      active.element !== this.activeSelection?.element
    ) {
      return;
    }

    if (this.expectedRemoteState?.commandId === command.commandId) {
      this.expectedRemoteState = null;
    }
    this.emitForSelection(
      active,
      command.revision,
      "play-failed",
      mediaSnapshot(active.element),
      command.commandId,
      errorMessage(error),
    );
  }

  private reportMediaFailure(active: ActiveSelection, error: string): void {
    if (
      this.activeSelection !== active ||
      active.element !== this.activeSelection?.element
    ) {
      return;
    }

    // Native/HLS source failure is terminal for this element, independent of
    // any playback command whose promise may still be outstanding.
    this.expectedRemoteState = null;
    this.emitForSelection(
      active,
      this.appliedRevision,
      "play-failed",
      mediaSnapshot(active.element),
      undefined,
      error,
    );
  }

  private mediaErrorMessage(video: HTMLVideoElement, event?: Event): string {
    if (event && "message" in event && typeof event.message === "string" && event.message) {
      return event.message;
    }

    const mediaError = video.error as (MediaError & { message?: unknown }) | null;
    if (mediaError?.message && typeof mediaError.message === "string") {
      return mediaError.message;
    }
    if (mediaError && Number.isFinite(mediaError.code)) {
      return `Media error (code ${mediaError.code})`;
    }
    return "Media failed to load";
  }

  private emitAcknowledgement(
    acknowledgement: Acknowledgement,
    snapshot: MediaSnapshot,
  ): void {
    this.emit("remote-ack", snapshot, acknowledgement.commandId);
  }

  private emitStatus(
    event: Extract<ContentEventName, "playing" | "ended">,
    snapshot: MediaSnapshot,
    acknowledgement: Acknowledgement | null,
  ): void {
    this.emit(event, snapshot, acknowledgement?.commandId);
  }

  private emit(
    event: ContentEventName,
    snapshot: MediaSnapshot | null,
    commandId?: string,
    error?: string,
  ): void {
    const active = this.activeSelection;
    if (!active) return;
    this.emitForSelection(active, this.appliedRevision, event, snapshot, commandId, error);
  }

  private emitForSelection(
    active: ActiveSelection,
    appliedRevision: number,
    event: ContentEventName,
    snapshot: MediaSnapshot | null,
    commandId?: string,
    error?: string,
  ): void {
    const message: ContentEventMessage = {
      type: "VIDEO_EVENT",
      pairId: active.pairId,
      side: active.side,
      videoId: active.videoId,
      event,
      snapshot,
      localSequence: ++this.localSequence,
      appliedRevision,
    };
    if (commandId !== undefined) message.commandId = commandId;
    if (error !== undefined) message.error = error;

    try {
      const result = this.sendMessage(message);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Event delivery is best-effort when the MV3 worker is restarting.
    }
  }
}
