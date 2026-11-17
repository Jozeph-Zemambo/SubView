export type Side = "primary" | "secondary";

export type BackgroundAudioMode = "offscreen" | "hosted";

/** Where a hosted Dub page runs: the invisible offscreen document, or a minimized extension window. */
export type HostContainer = "offscreen" | "window";

export type SyncStatus =
  | "idle"
  | "active"
  | "paused"
  | "buffering"
  | "degraded"
  | "manual-play-required"
  | "error";

export interface VideoEndpoint {
  tabId: number;
  videoId: string;
  /** Frame containing the video. Omitted legacy endpoints target frame 0. */
  frameId?: number;
  /** Exact document containing the video when Chrome provided one. */
  documentId?: string;
}

export interface VideoDescriptor {
  id: string;
  /** Frame containing the video. Omitted only when the probe lacks metadata. */
  frameId?: number;
  /** Exact document containing the video when Chrome provided one. */
  documentId?: string;
  index: number;
  label: string;
  source: string;
  /** Direct/current and child-source URLs exposed by the media element. */
  mediaSources?: string[];
  /** Hosted pages only: when this element last started loading media (epoch ms). */
  loadStartedAt?: number;
  durationMs: number | null;
  currentTimeMs: number;
  paused: boolean;
  ended: boolean;
  playbackRate: number;
  readyState: number;
  width: number;
  height: number;
}

export interface MediaSnapshot {
  currentTimeMs: number;
  durationMs: number | null;
  paused: boolean;
  ended: boolean;
  playbackRate: number;
  readyState: number;
  canPlay: boolean;
  /** When the snapshot was read (epoch ms, sub-millisecond), so positions can be compared across frames. */
  capturedAt?: number;
}

export interface CanonicalTimeline {
  revision: number;
  /** Position on the primary timeline, in milliseconds. */
  positionMs: number;
  playing: boolean;
  playbackRate: number;
  authority: Side;
}

export type EndpointStatus =
  | "unknown"
  | "ready"
  | "playing"
  | "paused"
  | "buffering"
  | "ended"
  | "lost"
  | "play-failed";

export interface PendingCommand {
  commandId: string;
  revision: number;
  targetTimeMs: number | null;
  shouldPlay: boolean;
  playbackRate: number;
}

export interface EndpointRuntime {
  endpoint: VideoEndpoint;
  status: EndpointStatus;
  snapshot: MediaSnapshot | null;
  lastAppliedRevision: number;
  pendingCommand: PendingCommand | null;
}

export type BackgroundAudioState =
  | {
      /** A media URL the user supplied, played by the extension's own video element. */
      mode: "offscreen";
      sourceUrl: string;
      volume: number;
      muteOriginal: boolean;
    }
  | {
      /** The episode page itself, hosted invisibly with Dub selected. */
      mode: "hosted";
      pageUrl: string;
      /** Server/provider label the hosted page settled on, when the page exposes one. */
      provider: string | null;
      container: HostContainer;
      volume: number;
      muteOriginal: boolean;
    };

export interface SyncState {
  /** Present when the secondary endpoint is automatic/manual background audio. */
  backgroundAudio?: BackgroundAudioState;
  pairId: string;
  /** The currently effective offset. Auto offset adds the duration difference to the manual correction. */
  offsetMs: number;
  /** The user-supplied correction, added to the duration difference in auto mode. */
  manualOffsetMs?: number;
  /** Whether the effective offset should follow the endpoint durations. */
  autoOffset?: boolean;
  /** True while auto offset is enabled but either duration is unavailable. */
  autoOffsetPending?: boolean;
  toleranceMs: number;
  /**
   * Background Dub only: a small speed multiplier (about ±4%) that closes
   * sub-tolerance drift without an audible seek. 1 when in sync.
   */
  secondaryRateTrim?: number;
  timeline: CanonicalTimeline;
  primary: EndpointRuntime;
  secondary: EndpointRuntime;
  status: SyncStatus;
  message: string | null;
  manualPlayRequired: Side | null;
}

export interface StartSyncConfig {
  primary: VideoEndpoint;
  secondary: VideoEndpoint;
  /** Manual fallback/configured offset in milliseconds. */
  offsetMs: number;
  toleranceMs?: number;
  autoOffset?: boolean;
}

export interface StartBackgroundAudioConfig {
  primary: VideoEndpoint;
  sourceUrl: string;
  volume: number;
  offsetMs: number;
  muteOriginal?: boolean;
  autoOffset?: boolean;
}

/** Internal Auto Dub handoff: the Dub video inside a hosted copy of the page. */
export interface StartHostedDubConfig {
  primary: VideoEndpoint;
  secondary: VideoEndpoint;
  pageUrl: string;
  provider: string | null;
  container: HostContainer;
  volume: number;
  offsetMs: number;
  muteOriginal?: boolean;
  autoOffset?: boolean;
}

export interface VideoCommand {
  commandId: string;
  pairId: string;
  side: Side;
  revision: number;
  targetTimeMs: number | null;
  playbackRate: number;
  shouldPlay: boolean;
  forceSeek: boolean;
}

export type ContentEventName =
  | "intent-play"
  | "intent-pause"
  | "intent-seek"
  | "intent-ratechange"
  | "observation"
  | "buffering"
  | "playing"
  | "ended"
  | "remote-ack"
  | "play-failed"
  | "element-lost";

export interface ContentEventMessage {
  type: "VIDEO_EVENT";
  pairId: string;
  side: Side;
  videoId: string;
  event: ContentEventName;
  snapshot: MediaSnapshot | null;
  localSequence: number;
  appliedRevision: number;
  commandId?: string;
  error?: string;
}

export type ContentRequest =
  | { type: "PROBE" }
  | { type: "SET_MUTED"; pairId: string; muted: boolean }
  | { type: "SET_VOLUME"; pairId: string; volume: number }
  | {
      type: "ACTIVATE";
      pairId: string;
      side: Side;
      videoId: string;
      revision: number;
    }
  | { type: "DEACTIVATE"; pairId: string }
  | { type: "COMMAND"; command: VideoCommand };

export type BackgroundRequest =
  | { type: "GET_STATE" }
  | { type: "PROBE_TAB"; tabId: number }
  | { type: "GET_LANGUAGE_DETECTION"; tabId: number }
  | { type: "START_SYNC"; config: StartSyncConfig }
  | { type: "START_BACKGROUND_AUDIO"; config: StartBackgroundAudioConfig }
  | { type: "SET_BACKGROUND_VOLUME"; volume: number }
  | { type: "SET_MUTE_ORIGINAL"; muteOriginal: boolean }
  | { type: "SET_MANUAL_OFFSET"; offsetMs: number }
  | { type: "SET_AUTO_OFFSET"; enabled: boolean }
  | { type: "STOP_SYNC" };

export interface ProbeTabResponse {
  ok: boolean;
  tabId: number;
  videos: VideoDescriptor[];
  error?: string;
}

export interface BackgroundResponse {
  ok: boolean;
  state?: SyncState | null;
  probe?: ProbeTabResponse;
  detection?: import("./language-detection").LanguageDetection;
  error?: string;
}

export interface StateUpdateMessage {
  type: "STATE_UPDATE";
  state: SyncState | null;
}

/** Worker-only request selecting an exact Provider/Server option label. */
export interface SelectProviderContentRequest {
  type: "SELECT_PROVIDER_CONTENT";
  provider: string;
}
