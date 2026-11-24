import { isRecord } from "../shared/messages";
import type { LanguageDetection } from "../shared/language-detection";
import type { AutoDubConfig, AutoDubState } from "../shared/auto-dub";
import { siteKey } from "../shared/auto-dub-sites";
import {
  DEFAULT_TOLERANCE_MS,
  formatDuration,
  formatOffset,
  parseOffset,
} from "../shared/time";
import type {
  BackgroundRequest,
  BackgroundResponse,
  StartBackgroundAudioConfig,
  StartSyncConfig,
  StateUpdateMessage,
  SyncState,
  SyncStatus,
  VideoDescriptor,
  VideoEndpoint,
} from "../shared/types";

type Side = "primary" | "secondary";
type SyncMode = "background" | "two-tabs";
type LoadState = "loading" | "ready" | "empty" | "error";
type Operation = "starting" | "stopping" | null;
type AutoDubOperation = "enabling" | "disabling" | null;
type StatusTone = "neutral" | "success" | "warning" | "error";
type BackgroundPlaybackMode = "offscreen" | "hosted" | "hosted-window";

type FrameAwareVideoDescriptor = VideoDescriptor & {
  frameId?: number;
  documentId?: string;
};

type FrameAwareVideoEndpoint = VideoEndpoint & {
  frameId?: number;
  documentId?: string;
};

type PopupSyncState = SyncState & {
  autoOffset?: boolean;
  autoOffsetPending?: boolean;
  manualOffsetMs?: number;
};

type PopupStartSyncConfig = StartSyncConfig & { autoOffset?: boolean };
type PopupStartBackgroundAudioConfig = StartBackgroundAudioConfig & {
  autoOffset?: boolean;
};
type PopupAutoDubConfig = AutoDubConfig & { autoOffset?: boolean };

type PopupBackgroundRequest =
  | BackgroundRequest
  | { type: "GET_AUTO_DUB" }
  | { type: "SET_AUTO_DUB_SITE"; site: string; enabled: boolean; tabId?: number; settings?: Omit<PopupAutoDubConfig, "tabId"> }
  | { type: "SET_AUTO_OFFSET"; enabled: boolean };

type PopupBackgroundResponse = BackgroundResponse & {
  autoDub?: AutoDubState | null;
  /** Sites with Auto Dub turned on. */
  sites?: string[];
};

type ValidatedStart =
  | { mode: "background"; config: PopupStartBackgroundAudioConfig }
  | { mode: "two-tabs"; config: PopupStartSyncConfig };

interface EndpointElements {
  tab: HTMLSelectElement;
  tabError: HTMLParagraphElement;
  video: HTMLSelectElement;
  videoMessage: HTMLParagraphElement;
  videoError: HTMLParagraphElement;
  rescan: HTMLButtonElement;
}

interface EndpointViewState {
  videos: FrameAwareVideoDescriptor[];
  loadState: LoadState;
  requestId: number;
}

interface StatusView {
  label: string;
  message: string;
  tone: StatusTone;
}

type LanguageViewState = "empty" | "loading" | "ready" | "error";

const form = requireElement<HTMLFormElement>("sync-form");
const configurationFields = requireElement<HTMLFieldSetElement>(
  "configuration-fields",
);
const modeSelect = requireElement<HTMLSelectElement>("sync-mode");
const swapRow = requireElement<HTMLDivElement>("swap-row");
const twoTabSecondary = requireElement<HTMLElement>("two-tab-secondary");
const backgroundSecondary = requireElement<HTMLElement>("background-secondary");
const autoDubSection = requireElement<HTMLElement>("auto-dub-section");
const autoDubStateElement = requireElement<HTMLElement>("auto-dub-state");
const autoDubDetail = requireElement<HTMLParagraphElement>("auto-dub-detail");
const autoDubAction = requireElement<HTMLButtonElement>("auto-dub-action");
const backgroundPlayback = requireElement<HTMLElement>("background-playback");
const backgroundPlaybackMode = requireElement<HTMLElement>(
  "background-playback-mode",
);
const backgroundPlaybackDetail = requireElement<HTMLParagraphElement>(
  "background-playback-detail",
);
const sourceUrlField = requireElement<HTMLDivElement>("source-url-field");
const sourceUrlInput = requireElement<HTMLInputElement>("source-url");
const sourceUrlError = requireElement<HTMLParagraphElement>("source-url-error");
const volumeInput = requireElement<HTMLInputElement>("background-volume");
const volumeValue = requireElement<HTMLOutputElement>("volume-value");
const muteOriginalInput = requireElement<HTMLInputElement>("mute-original");
const languagePanel = requireElement<HTMLElement>("language-detection");
const languageState = requireElement<HTMLElement>("language-detection-state");
const languageSummary = requireElement<HTMLParagraphElement>(
  "language-detection-summary",
);
const languageProvider = requireElement<HTMLParagraphElement>(
  "language-detection-provider",
);
const languageDetail = requireElement<HTMLParagraphElement>(
  "language-detection-detail",
);
const languageCandidates = requireElement<HTMLUListElement>(
  "language-detection-candidates",
);
const offsetInput = requireElement<HTMLInputElement>("offset");
const offsetStepButtons = document.querySelectorAll<HTMLButtonElement>("[data-offset-step]");
let offsetStepPending = false;
const offsetError = requireElement<HTMLParagraphElement>("offset-error");
const autoOffsetInput = requireElement<HTMLInputElement>("auto-offset");
const autoOffsetEffective = requireElement<HTMLParagraphElement>(
  "auto-offset-effective",
);
const swapButton = requireElement<HTMLButtonElement>("swap-tabs");
const startButton = requireElement<HTMLButtonElement>("start-sync");
const stopButton = requireElement<HTMLButtonElement>("stop-sync");
const actionError = requireElement<HTMLParagraphElement>("action-error");
const statusContent = requireElement<HTMLDivElement>("sync-status");
const statusLabel = requireElement<HTMLParagraphElement>("status-label");
const statusMessage = requireElement<HTMLParagraphElement>("status-message");
const retryButton = requireElement<HTMLButtonElement>("retry-load");

const endpoints: Record<Side, EndpointElements> = {
  primary: {
    tab: requireElement<HTMLSelectElement>("primary-tab"),
    tabError: requireElement<HTMLParagraphElement>("primary-tab-error"),
    video: requireElement<HTMLSelectElement>("primary-video"),
    videoMessage: requireElement<HTMLParagraphElement>("primary-video-message"),
    videoError: requireElement<HTMLParagraphElement>("primary-video-error"),
    rescan: requireElement<HTMLButtonElement>("primary-rescan"),
  },
  secondary: {
    tab: requireElement<HTMLSelectElement>("secondary-tab"),
    tabError: requireElement<HTMLParagraphElement>("secondary-tab-error"),
    video: requireElement<HTMLSelectElement>("secondary-video"),
    videoMessage: requireElement<HTMLParagraphElement>("secondary-video-message"),
    videoError: requireElement<HTMLParagraphElement>("secondary-video-error"),
    rescan: requireElement<HTMLButtonElement>("secondary-rescan"),
  },
};

const endpointViews: Record<Side, EndpointViewState> = {
  primary: { videos: [], loadState: "empty", requestId: 0 },
  secondary: { videos: [], loadState: "empty", requestId: 0 },
};

const rememberedVideos: Record<Side, Map<number, string>> = {
  primary: new Map<number, string>(),
  secondary: new Map<number, string>(),
};

let openTabs: chrome.tabs.Tab[] = [];
let tabsLoadState: LoadState = "loading";
let tabsLoadError: string | null = null;
let stateLoadError: string | null = null;
let stateLoaded = false;
let isBooting = true;
let operation: Operation = null;
let autoDubOperation: AutoDubOperation = null;
let currentState: PopupSyncState | null = null;
let autoDub: AutoDubState | null = null;
/** Sites with Auto Dub turned on (kept across browser restarts). */
let autoDubSites: string[] = [];

function readSites(response: PopupBackgroundResponse): void {
  if (Array.isArray(response.sites)) autoDubSites = response.sites.filter((site): site is string => typeof site === "string");
}

/** The site of the tab chosen in the popup, when it is a normal web page. */
function selectedSite(): string | null {
  const tabId = parseTabId(endpoints.primary.tab);
  return siteKey(openTabs.find((tab) => tab.id === tabId)?.url);
}
let stateUpdateVersion = 0;
let autoDubUpdateVersion = 0;
let initializationId = 0;
let hydratedConfigKey: string | null = null;
let offsetTouched = false;
let retainedManualOffsetMs = parseOffset(offsetInput.value) ?? 0;
let autoOffsetUpdateId = 0;
let autoOffsetPending = false;
let volumeUpdateId = 0;
let confirmedVolume = Number(volumeInput.value);
let muteOriginalUpdateId = 0;
let muteOriginalPending = false;
let languageDetection: LanguageDetection | null = null;
let languageLoadState: LanguageViewState = "empty";
let languageDetectionError: string | null = null;
let languageDetectionRequestId = 0;
let autoDubLoaded = false;
let autoDubLoadError: string | null = null;

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Popup element #${id} is missing.`);
  }
  return element as T;
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}

function isBackgroundResponse(value: unknown): value is BackgroundResponse {
  return isRecord(value) && typeof value.ok === "boolean";
}

function isAutoDubState(value: unknown): value is AutoDubState {
  return (
    isRecord(value) &&
    typeof value.tabId === "number" &&
    Number.isInteger(value.tabId) &&
    (value.status === "finding" ||
      value.status === "waiting" ||
      value.status === "active" ||
      value.status === "unsupported" ||
      value.status === "ambiguous" ||
      value.status === "error") &&
    typeof value.reason === "string"
  );
}

function parseAutoDubState(value: unknown): AutoDubState | null {
  if (value === null) return null;
  if (!isAutoDubState(value)) {
    throw new Error("The extension returned an invalid Auto Dub setting.");
  }
  return value;
}

function isLanguageDetection(value: unknown): value is LanguageDetection {
  if (
    !isRecord(value) ||
    typeof value.pageUrl !== "string" ||
    (value.language !== "sub" &&
      value.language !== "dub" &&
      value.language !== "unknown") ||
    !Array.isArray(value.available) ||
    !value.available.every((item) => item === "sub" || item === "dub") ||
    !Array.isArray(value.dubCandidates) ||
    !value.dubCandidates.every(
      (candidate) =>
        isRecord(candidate) &&
        typeof candidate.url === "string" &&
        (candidate.kind === "page" || candidate.kind === "media") &&
        typeof candidate.label === "string",
    ) ||
    (value.provider !== null && typeof value.provider !== "string") ||
    !Array.isArray(value.evidence) ||
    !value.evidence.every((item) => typeof item === "string") ||
    typeof value.reason !== "string"
  ) {
    return false;
  }
  return true;
}

async function sendBackgroundMessage(
  request: PopupBackgroundRequest,
): Promise<PopupBackgroundResponse> {
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage(request);
  } catch (error) {
    const detail = messageFromError(error, "No response was received.");
    throw new Error(`Couldn’t contact the extension. ${detail}`);
  }

  if (!isBackgroundResponse(response)) {
    throw new Error("The extension returned an invalid response.");
  }
  return response as PopupBackgroundResponse;
}

function responseError(response: BackgroundResponse, fallback: string): Error {
  return new Error(response.error?.trim() || fallback);
}

async function requestCurrentState(): Promise<SyncState | null> {
  const response = await sendBackgroundMessage({ type: "GET_STATE" });
  if (!response.ok) {
    throw responseError(response, "Couldn’t load the current sync state.");
  }
  return response.state ?? null;
}

async function requestAutoDubState(): Promise<AutoDubState | null> {
  const response = await sendBackgroundMessage({ type: "GET_AUTO_DUB" });
  if (!response.ok) {
    throw responseError(response, "Couldn’t load the Auto Dub setting.");
  }
  if (!("autoDub" in response)) {
    throw new Error("The extension returned no Auto Dub setting.");
  }
  readSites(response);
  return parseAutoDubState(response.autoDub);
}

function setFieldError(
  control: HTMLInputElement | HTMLSelectElement,
  errorElement: HTMLParagraphElement,
  message: string | null,
): void {
  control.setAttribute("aria-invalid", message ? "true" : "false");
  errorElement.textContent = message ?? "";
  errorElement.hidden = !message;
}

function clearActionError(): void {
  actionError.textContent = "";
  actionError.hidden = true;
}

function showActionError(message: string): void {
  actionError.textContent = message;
  actionError.hidden = false;
  renderStatus();
}

function selectedMode(): SyncMode {
  return modeSelect.value === "two-tabs" ? "two-tabs" : "background";
}

function isBackgroundState(state: SyncState | null): state is SyncState & {
  backgroundAudio: NonNullable<SyncState["backgroundAudio"]>;
} {
  return Boolean(state?.backgroundAudio);
}

function playbackModeForState(
  state: SyncState | null,
): BackgroundPlaybackMode | null {
  if (!isBackgroundState(state)) return null;
  const audio = state.backgroundAudio;
  if (audio.mode !== "hosted") return "offscreen";
  return audio.container === "window" ? "hosted-window" : "hosted";
}

function readVolume(): number {
  const volume = Number(volumeInput.value);
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.8;
}

function stateUsesAutoOffset(state: PopupSyncState | null): boolean {
  return state?.autoOffset === true;
}

function manualOffsetFromState(state: PopupSyncState): number {
  if (
    typeof state.manualOffsetMs === "number" &&
    Number.isFinite(state.manualOffsetMs)
  ) {
    return state.manualOffsetMs;
  }
  return stateUsesAutoOffset(state) ? retainedManualOffsetMs : state.offsetMs;
}

function formatPreciseOffset(milliseconds: number): string {
  const roundedMilliseconds = Math.round(Math.abs(milliseconds));
  const sign = milliseconds < 0 ? "-" : "+";
  const hours = Math.floor(roundedMilliseconds / 3_600_000);
  const minutes = Math.floor((roundedMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((roundedMilliseconds % 60_000) / 1_000);
  const remainder = roundedMilliseconds % 1_000;
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0",
  )}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

function renderTimingState(state: PopupSyncState | null): void {
  if (!state) {
    autoOffsetEffective.hidden = true;
    autoOffsetEffective.textContent = "";
    return;
  }

  const autoOffset = stateUsesAutoOffset(state);
  autoOffsetInput.checked = autoOffset;
  retainedManualOffsetMs = manualOffsetFromState(state);
  offsetInput.value = formatOffset(-retainedManualOffsetMs);
  offsetTouched = false;
  setFieldError(offsetInput, offsetError, null);

  autoOffsetEffective.hidden = !autoOffset;
  autoOffsetEffective.textContent = autoOffset
    ? state.autoOffsetPending === true
      ? "Waiting for video lengths"
      : `Effective offset: ${formatPreciseOffset(-state.offsetMs)}`
    : "";
}

function renderVolumeValue(): void {
  volumeValue.value = `${Math.round(readVolume() * 100)}%`;
}

function stateMuteOriginal(state: SyncState | null): boolean | null {
  if (!isBackgroundState(state)) return null;
  const backgroundAudio: unknown = state.backgroundAudio;
  return isRecord(backgroundAudio) &&
    typeof backgroundAudio.muteOriginal === "boolean"
    ? backgroundAudio.muteOriginal
    : null;
}

function safeCandidateHref(candidateUrl: string, pageUrl: string): string | null {
  try {
    const parsed = new URL(candidateUrl, pageUrl);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function clearLanguageDetection(
  summary = "Choose a primary tab to check its language options.",
): void {
  languageDetectionRequestId += 1;
  languageDetection = null;
  languageLoadState = "empty";
  languageDetectionError = null;
  languageState.textContent = "Unknown";
  languageSummary.textContent = summary;
  languageProvider.textContent = "";
  languageProvider.hidden = true;
  languageDetail.textContent = "";
  languageDetail.hidden = true;
  languageCandidates.replaceChildren();
  languageCandidates.hidden = true;
  languagePanel.setAttribute("aria-busy", "false");
  renderAutoDub();
}

function renderLanguageDetection(): void {
  languagePanel.setAttribute(
    "aria-busy",
    String(languageLoadState === "loading"),
  );
  languageProvider.textContent = "";
  languageProvider.hidden = true;
  languageDetail.textContent = "";
  languageDetail.hidden = true;
  languageCandidates.replaceChildren();
  languageCandidates.hidden = true;

  if (languageLoadState === "loading") {
    languageState.textContent = "Checking";
    languageSummary.textContent = "Checking this tab for language options…";
    renderAutoDub();
    return;
  }

  if (languageLoadState === "error") {
    languageState.textContent = "Unknown";
    languageSummary.textContent = "Language detection unavailable.";
    languageDetail.textContent =
      languageDetectionError || "This tab could not be checked.";
    languageDetail.hidden = false;
    renderAutoDub();
    return;
  }

  if (!languageDetection) {
    languageState.textContent = "Unknown";
    languageSummary.textContent =
      parseTabId(endpoints.primary.tab) === null
        ? "Choose a primary tab to check its language options."
        : "Language has not been detected for this tab.";
    renderAutoDub();
    return;
  }

  const detection = languageDetection;
  const dubAvailable =
    detection.language === "dub" || detection.available.includes("dub");
  const subAvailable =
    detection.language === "sub" || detection.available.includes("sub");

  languageState.textContent =
    detection.language === "unknown" ? "Unknown" : "Detected";
  if (detection.language === "sub") {
    languageSummary.textContent = dubAvailable
      ? "Sub detected · Dub available"
      : "Sub detected";
  } else if (detection.language === "dub") {
    languageSummary.textContent = subAvailable
      ? "Dub detected · Sub available"
      : "Dub detected";
  } else {
    languageSummary.textContent = dubAvailable
      ? "Language unknown · Dub available"
      : "Language unknown";
  }

  const provider = detection.provider?.trim();
  if (provider) {
    languageProvider.textContent = `Provider: ${provider}`;
    languageProvider.hidden = false;
  }

  const safeMediaCandidates = detection.dubCandidates.flatMap((candidate) => {
    if (candidate.kind !== "media") return [];
    const href = safeCandidateHref(candidate.url, detection.pageUrl);
    return href ? [{ ...candidate, href }] : [];
  });
  const details: string[] = [];
  const languageSite = selectedSite();
  if (detection.available.includes("dub") && !(languageSite && autoDubSites.includes(languageSite))) {
    details.push("Enable Auto Dub to hear this episode's Dub while you watch Sub.");
  }
  if (detection.language === "unknown" && detection.reason.trim()) {
    details.push(detection.reason.trim());
  }
  languageDetail.textContent = details.join(" ");
  languageDetail.hidden = details.length === 0;

  if (safeMediaCandidates.length > 0) {
    const fragment = document.createDocumentFragment();
    for (const candidate of safeMediaCandidates) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = candidate.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      link.textContent = candidate.label.trim() || "Dub media candidate";
      link.title = candidate.href;
      item.append(link);
      fragment.append(item);
    }
    languageCandidates.append(fragment);
    languageCandidates.hidden = false;
  }
  renderAutoDub();
}

async function requestLanguageDetection(tabId: number): Promise<void> {
  const requestId = ++languageDetectionRequestId;
  languageDetection = null;
  languageLoadState = "loading";
  languageDetectionError = null;
  renderLanguageDetection();

  try {
    const response = await sendBackgroundMessage({
      type: "GET_LANGUAGE_DETECTION",
      tabId,
    });
    if (!response.ok) {
      throw responseError(response, "Language detection could not be loaded.");
    }
    if (!isLanguageDetection(response.detection)) {
      throw new Error("The language detector returned an invalid response.");
    }
    if (
      requestId !== languageDetectionRequestId ||
      parseTabId(endpoints.primary.tab) !== tabId
    ) {
      return;
    }
    languageDetection = response.detection;
    languageLoadState = "ready";
    languageDetectionError = null;
    renderLanguageDetection();
  } catch (error) {
    if (
      requestId !== languageDetectionRequestId ||
      parseTabId(endpoints.primary.tab) !== tabId
    ) {
      return;
    }
    languageDetection = null;
    languageLoadState = "error";
    languageDetectionError = messageFromError(
      error,
      "Language detection could not be loaded.",
    );
    renderLanguageDetection();
  }
}

function renderModeFields(): void {
  const backgroundMode = selectedMode() === "background";
  const playbackMode = backgroundMode
    ? playbackModeForState(currentState)
    : null;
  backgroundSecondary.hidden = !backgroundMode;
  autoDubSection.hidden = !backgroundMode;
  twoTabSecondary.hidden = backgroundMode;
  swapRow.hidden = backgroundMode;
  backgroundPlayback.hidden = playbackMode === null;
  sourceUrlField.hidden = playbackMode === "hosted" || playbackMode === "hosted-window";

  if (playbackMode === null) {
    delete backgroundSecondary.dataset.playbackMode;
    return;
  }

  backgroundSecondary.dataset.playbackMode = playbackMode;
  backgroundPlaybackMode.textContent =
    playbackMode === "hosted" ? "Hidden Dub page"
      : playbackMode === "hosted-window" ? "Minimized Dub window"
        : "Hidden player";
  backgroundPlaybackDetail.textContent =
    playbackMode === "hosted" ? "Dub audio comes from a hidden copy of this page. Nothing to keep open."
      : playbackMode === "hosted-window" ? "This site needed a real window. Keep the minimized SubView Dub window open."
        : "Audio is playing without an extra tab.";
}

function parseTabId(select: HTMLSelectElement): number | null {
  if (!select.value) return null;
  const tabId = Number(select.value);
  return Number.isInteger(tabId) ? tabId : null;
}

function hasOption(select: HTMLSelectElement, value: string): boolean {
  return Array.from(select.options).some((option) => option.value === value);
}

function tabLabel(tab: chrome.tabs.Tab): string {
  const title = tab.title?.trim();
  let location = "";

  if (tab.url) {
    try {
      const parsed = new URL(tab.url);
      location = parsed.hostname || parsed.protocol.replace(":", "");
    } catch {
      location = tab.url;
    }
  }

  if (title && location && !title.toLocaleLowerCase().includes(location.toLocaleLowerCase())) {
    return `${title} — ${location}`;
  }
  return title || location || `Tab ${tab.id ?? ""}`.trim();
}

function httpTabId(tab: chrome.tabs.Tab | undefined): number | null {
  if (typeof tab?.id !== "number" || !tab.url) return null;
  try {
    const protocol = new URL(tab.url).protocol;
    return protocol === "http:" || protocol === "https:" ? tab.id : null;
  } catch {
    return null;
  }
}

function replaceOptions(
  select: HTMLSelectElement,
  options: Array<{ value: string; label: string }>,
): void {
  const fragment = document.createDocumentFragment();
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    fragment.append(option);
  }
  select.replaceChildren(fragment);
}

function renderTabOptions(preferred: Partial<Record<Side, number | null>> = {}): void {
  const selectableTabs = openTabs.filter(
    (tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === "number",
  );

  for (const side of ["primary", "secondary"] as const) {
    const elements = endpoints[side];
    const existingValue = elements.tab.value;

    if (tabsLoadState === "loading") {
      replaceOptions(elements.tab, [{ value: "", label: "Loading tabs…" }]);
      elements.tab.disabled = true;
      continue;
    }

    if (tabsLoadState === "error") {
      replaceOptions(elements.tab, [{ value: "", label: "Couldn’t load tabs" }]);
      elements.tab.disabled = true;
      continue;
    }

    if (selectableTabs.length === 0) {
      replaceOptions(elements.tab, [{ value: "", label: "No tabs available" }]);
      elements.tab.disabled = true;
      continue;
    }

    const options = [
      { value: "", label: "Choose a tab" },
      ...selectableTabs.map((tab) => ({
        value: String(tab.id),
        label: tabLabel(tab),
      })),
    ];

    const configuredEndpoint =
      side === "secondary" && isBackgroundState(currentState)
        ? null
        : currentState?.[side].endpoint;
    if (
      configuredEndpoint &&
      !selectableTabs.some((tab) => tab.id === configuredEndpoint.tabId)
    ) {
      options.push({
        value: String(configuredEndpoint.tabId),
        label: `Tab ${configuredEndpoint.tabId} (closed or unavailable)`,
      });
    }
    replaceOptions(elements.tab, options);

    const preferredValue = preferred[side];
    const nextValue =
      preferredValue !== null && preferredValue !== undefined
        ? String(preferredValue)
        : existingValue;
    if (nextValue && hasOption(elements.tab, nextValue)) {
      elements.tab.value = nextValue;
    }
    elements.tab.disabled = false;
  }
}

function resetVideoField(side: Side): void {
  const elements = endpoints[side];
  const view = endpointViews[side];
  view.requestId += 1;
  view.videos = [];
  view.loadState = "empty";
  replaceOptions(elements.video, [{ value: "", label: "Select a tab first" }]);
  elements.video.disabled = true;
  elements.videoMessage.textContent = "Choose a tab to detect videos.";
  delete elements.videoMessage.dataset.tone;
  elements.rescan.hidden = true;
  elements.rescan.disabled = true;
  setFieldError(elements.video, elements.videoError, null);
}

function videoFrameId(
  value: FrameAwareVideoDescriptor | FrameAwareVideoEndpoint,
): number | undefined {
  const frameId = value.frameId;
  return typeof frameId === "number" && Number.isInteger(frameId)
    ? frameId
    : undefined;
}

function videoDocumentId(
  value: FrameAwareVideoDescriptor | FrameAwareVideoEndpoint,
): string | undefined {
  return typeof value.documentId === "string" && value.documentId
    ? value.documentId
    : undefined;
}

function videoSelectionKey(video: FrameAwareVideoDescriptor): string {
  return JSON.stringify([
    videoFrameId(video) ?? null,
    videoDocumentId(video) ?? null,
    video.id,
  ]);
}

function endpointSelectionKey(endpoint: VideoEndpoint): string {
  const frameAwareEndpoint = endpoint as FrameAwareVideoEndpoint;
  return JSON.stringify([
    videoFrameId(frameAwareEndpoint) ?? null,
    videoDocumentId(frameAwareEndpoint) ?? null,
    endpoint.videoId,
  ]);
}

function videoIdFromSelectionKey(selectionKey: string): string {
  try {
    const parsed: unknown = JSON.parse(selectionKey);
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      typeof parsed[2] === "string"
    ) {
      return parsed[2];
    }
  } catch {
    // Older popup selections used the raw video ID.
  }
  return selectionKey;
}

function resolveVideoSelectionKey(
  videos: FrameAwareVideoDescriptor[],
  selectionKey: string | null,
): string | null {
  if (!selectionKey) return null;
  if (videos.some((video) => videoSelectionKey(video) === selectionKey)) {
    return selectionKey;
  }

  const videoId = videoIdFromSelectionKey(selectionKey);
  const matches = videos.filter((video) => video.id === videoId);
  return matches.length === 1 ? videoSelectionKey(matches[0]) : null;
}

function selectedVideo(side: Side): FrameAwareVideoDescriptor | null {
  const selectionKey = endpoints[side].video.value;
  return (
    endpointViews[side].videos.find(
      (video) => videoSelectionKey(video) === selectionKey,
    ) ?? null
  );
}

function endpointFromVideo(
  tabId: number,
  video: FrameAwareVideoDescriptor,
): FrameAwareVideoEndpoint {
  const endpoint: FrameAwareVideoEndpoint = { tabId, videoId: video.id };
  const frameId = videoFrameId(video);
  const documentId = videoDocumentId(video);
  if (frameId !== undefined) endpoint.frameId = frameId;
  if (documentId !== undefined) endpoint.documentId = documentId;
  return endpoint;
}

function videoLabel(
  video: FrameAwareVideoDescriptor,
  includeFrame = false,
): string {
  const name = video.label.trim() || `Video ${video.index + 1}`;
  const frameId = videoFrameId(video);
  const frameLabel = includeFrame
    ? frameId === 0
      ? " · main frame"
      : frameId !== undefined
        ? ` · frame ${frameId}`
        : " · embedded frame"
    : "";
  return `${name}${frameLabel} — ${formatDuration(video.durationMs)}`;
}

function configuredVideoSelectionKey(side: Side): string | null {
  if (!currentState || (side === "secondary" && isBackgroundState(currentState))) {
    return null;
  }
  return endpointSelectionKey(currentState[side].endpoint);
}

function renderDetectedVideos(
  side: Side,
  videos: FrameAwareVideoDescriptor[],
  preferredSelectionKey: string | null,
): void {
  const elements = endpoints[side];
  const view = endpointViews[side];
  view.videos = videos;

  if (videos.length === 0) {
    view.loadState = "empty";
    const activeSelectionKey = configuredVideoSelectionKey(side);
    const isConfiguredSelection =
      preferredSelectionKey !== null &&
      preferredSelectionKey === activeSelectionKey;
    replaceOptions(elements.video, [
      { value: "", label: "No videos found" },
      ...(isConfiguredSelection
        ? [
            {
              value: preferredSelectionKey,
              label: "Configured video (currently unavailable)",
            },
          ]
        : []),
    ]);
    if (isConfiguredSelection) elements.video.value = preferredSelectionKey;
    elements.video.disabled = true;
    elements.videoMessage.textContent =
      "No HTML5 videos found. Start the video, then scan again.";
    delete elements.videoMessage.dataset.tone;
    renderControls();
    return;
  }

  view.loadState = "ready";
  const activeSelectionKey = configuredVideoSelectionKey(side);
  const resolvedPreferredSelection = resolveVideoSelectionKey(
    videos,
    preferredSelectionKey,
  );
  const configuredVideoMissing =
    preferredSelectionKey !== null &&
    preferredSelectionKey === activeSelectionKey &&
    resolvedPreferredSelection === null;
  const duplicateVideoIds = new Set(
    videos
      .filter(
        (video, index) =>
          videos.findIndex((candidate) => candidate.id === video.id) !== index,
      )
      .map((video) => video.id),
  );
  replaceOptions(elements.video, [
    { value: "", label: videos.length === 1 ? "Choose the video" : "Choose a video" },
    ...videos.map((video) => ({
      value: videoSelectionKey(video),
      label: videoLabel(video, duplicateVideoIds.has(video.id)),
    })),
    ...(configuredVideoMissing
      ? [
          {
            value: preferredSelectionKey,
            label: "Configured video (currently unavailable)",
          },
        ]
      : []),
  ]);

  const tabId = parseTabId(elements.tab);
  const remembered = tabId === null ? null : rememberedVideos[side].get(tabId) ?? null;
  const selection =
    resolvedPreferredSelection ?? resolveVideoSelectionKey(videos, remembered);

  if (configuredVideoMissing) {
    elements.video.value = preferredSelectionKey;
  } else if (
    selection &&
    videos.some((video) => videoSelectionKey(video) === selection)
  ) {
    elements.video.value = selection;
  } else if (videos.length === 1) {
    elements.video.value = videoSelectionKey(videos[0]);
  }

  if (tabId !== null && elements.video.value) {
    rememberedVideos[side].set(tabId, elements.video.value);
  }

  elements.video.disabled = false;
  if (configuredVideoMissing) {
    elements.videoMessage.textContent =
      "The configured video is currently unavailable in this tab.";
    elements.videoMessage.dataset.tone = "error";
  } else {
    elements.videoMessage.textContent =
      videos.length === 1
        ? "1 video found."
        : `${videos.length} videos found${elements.video.value ? "." : "; choose one."}`;
    delete elements.videoMessage.dataset.tone;
  }
  renderControls();
}

async function probeSelectedTab(
  side: Side,
  preferredSelectionKey: string | null = null,
): Promise<void> {
  const elements = endpoints[side];
  const view = endpointViews[side];
  const tabId = parseTabId(elements.tab);
  if (tabId === null) {
    if (side === "primary") clearLanguageDetection();
    resetVideoField(side);
    renderControls();
    return;
  }

  if (side === "primary") void requestLanguageDetection(tabId);

  const requestId = ++view.requestId;
  const existingSelection =
    preferredSelectionKey || elements.video.value || null;
  view.loadState = "loading";
  view.videos = [];
  const activeSelectionKey = configuredVideoSelectionKey(side);
  const isConfiguredSelection =
    existingSelection !== null && existingSelection === activeSelectionKey;
  replaceOptions(elements.video, [
    { value: "", label: "Looking for videos…" },
    ...(isConfiguredSelection
      ? [
          {
            value: existingSelection,
            label: "Configured video (checking…)",
          },
        ]
      : []),
  ]);
  if (isConfiguredSelection) elements.video.value = existingSelection;
  elements.video.disabled = true;
  elements.videoMessage.textContent = "Inspecting the selected tab…";
  delete elements.videoMessage.dataset.tone;
  elements.rescan.hidden = false;
  elements.rescan.disabled = true;
  setFieldError(elements.video, elements.videoError, null);
  renderControls();

  try {
    const response = await sendBackgroundMessage({ type: "PROBE_TAB", tabId });
    if (!response.ok) {
      throw responseError(response, "The selected tab couldn’t be inspected.");
    }
    if (!response.probe) {
      throw new Error("The tab probe returned an invalid response.");
    }
    if (!response.probe.ok) {
      throw new Error(
        response.probe.error?.trim() || "The selected tab couldn’t be inspected.",
      );
    }
    if (response.probe.tabId !== tabId) {
      throw new Error("The tab probe returned results for a different tab.");
    }

    if (requestId !== view.requestId || parseTabId(elements.tab) !== tabId) return;
    renderDetectedVideos(
      side,
      response.probe.videos as FrameAwareVideoDescriptor[],
      existingSelection,
    );
  } catch (error) {
    if (requestId !== view.requestId || parseTabId(elements.tab) !== tabId) return;
    view.loadState = "error";
    view.videos = [];
    replaceOptions(elements.video, [
      { value: "", label: "Couldn’t inspect tab" },
      ...(isConfiguredSelection
        ? [
            {
              value: existingSelection,
              label: "Configured video (currently unavailable)",
            },
          ]
        : []),
    ]);
    if (isConfiguredSelection) elements.video.value = existingSelection;
    elements.video.disabled = true;
    const detail = messageFromError(error, "The selected tab couldn’t be inspected.");
    elements.videoMessage.textContent = `Couldn’t inspect this tab. ${detail}`;
    elements.videoMessage.dataset.tone = "error";
  } finally {
    if (requestId === view.requestId && parseTabId(elements.tab) === tabId) {
      elements.rescan.hidden = false;
      elements.rescan.disabled = false;
      renderControls();
    }
  }
}

function validateOffset(showError = true): number | null {
  const parsedOffset = parseOffset(offsetInput.value);
  const offsetMs = parsedOffset === null ? null : -parsedOffset;
  const message =
    offsetMs === null
      ? "Use hh:mm:ss or hh:mm:ss.sss, optionally starting with + or -; minutes and seconds must be 00–59."
      : null;
  if (showError) setFieldError(offsetInput, offsetError, message);
  if (offsetMs !== null) retainedManualOffsetMs = offsetMs;
  return offsetMs;
}

function validateTabRelationship(): void {
  if (selectedMode() === "background") {
    setFieldError(endpoints.secondary.tab, endpoints.secondary.tabError, null);
    return;
  }
  const primaryTabId = parseTabId(endpoints.primary.tab);
  const secondaryTabId = parseTabId(endpoints.secondary.tab);
  if (primaryTabId !== null && primaryTabId === secondaryTabId) {
    setFieldError(
      endpoints.secondary.tab,
      endpoints.secondary.tabError,
      "Choose a different tab from the primary.",
    );
  } else if (endpoints.secondary.tabError.textContent === "Choose a different tab from the primary.") {
    setFieldError(endpoints.secondary.tab, endpoints.secondary.tabError, null);
  }
}

function validatePrimaryEndpoint(): VideoEndpoint | null {
  const primaryTabId = parseTabId(endpoints.primary.tab);
  const primaryVideo = selectedVideo("primary");
  const primaryVideoReady =
    endpointViews.primary.loadState === "ready" &&
    primaryVideo !== null;

  setFieldError(
    endpoints.primary.tab,
    endpoints.primary.tabError,
    primaryTabId === null ? "Choose a primary tab." : null,
  );
  setFieldError(
    endpoints.primary.video,
    endpoints.primary.videoError,
    videoValidationMessage("primary", primaryVideoReady),
  );

  if (primaryTabId === null || primaryVideo === null || !primaryVideoReady) {
    return null;
  }
  return endpointFromVideo(primaryTabId, primaryVideo);
}

function validateSourceUrl(): string | null {
  const sourceUrl = sourceUrlInput.value.trim();
  let message: string | null = null;

  if (!sourceUrl) {
    message = "Enter a direct media URL.";
  } else {
    try {
      const parsed = new URL(sourceUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        message = "Use an http:// or https:// media URL.";
      }
    } catch {
      message = "Enter a valid http:// or https:// media URL.";
    }
  }

  setFieldError(sourceUrlInput, sourceUrlError, message);
  return message ? null : sourceUrl;
}

function validateForm(): ValidatedStart | null {
  const primary = validatePrimaryEndpoint();
  const offsetMs = validateOffset(true);

  if (selectedMode() === "background") {
    const sourceUrl = validateSourceUrl();
    setFieldError(endpoints.secondary.tab, endpoints.secondary.tabError, null);
    setFieldError(endpoints.secondary.video, endpoints.secondary.videoError, null);

    if (!primary || sourceUrl === null || offsetMs === null) {
      focusFirstInvalidControl();
      return null;
    }

    return {
      mode: "background",
      config: {
        primary,
        sourceUrl,
        volume: readVolume(),
        muteOriginal: muteOriginalInput.checked,
        offsetMs,
        autoOffset: autoOffsetInput.checked,
      },
    };
  }

  setFieldError(sourceUrlInput, sourceUrlError, null);
  const secondaryTabId = parseTabId(endpoints.secondary.tab);
  const secondaryVideo = selectedVideo("secondary");
  const secondaryVideoReady =
    endpointViews.secondary.loadState === "ready" &&
    secondaryVideo !== null;

  setFieldError(
    endpoints.secondary.tab,
    endpoints.secondary.tabError,
    secondaryTabId === null
      ? "Choose a secondary tab."
      : primary?.tabId === secondaryTabId
        ? "Choose a different tab from the primary."
        : null,
  );
  setFieldError(
    endpoints.secondary.video,
    endpoints.secondary.videoError,
    videoValidationMessage("secondary", secondaryVideoReady),
  );

  if (
    !primary ||
    secondaryTabId === null ||
    primary.tabId === secondaryTabId ||
    secondaryVideo === null ||
    !secondaryVideoReady ||
    offsetMs === null
  ) {
    focusFirstInvalidControl();
    return null;
  }

  return {
    mode: "two-tabs",
    config: {
      primary,
      secondary: endpointFromVideo(secondaryTabId, secondaryVideo),
      offsetMs,
      toleranceMs: DEFAULT_TOLERANCE_MS,
      autoOffset: autoOffsetInput.checked,
    },
  };
}

function videoValidationMessage(side: Side, isReady: boolean): string | null {
  if (isReady) return null;
  const sideName = side === "primary" ? "primary" : "secondary";

  switch (endpointViews[side].loadState) {
    case "loading":
      return `Wait for the ${sideName} tab scan to finish.`;
    case "error":
      return `Scan the ${sideName} tab again.`;
    case "empty":
      return endpoints[side].tab.value
        ? `No HTML5 video is available in the ${sideName} tab.`
        : `Choose a ${sideName} video.`;
    case "ready":
    default:
      return `Choose a ${sideName} video.`;
  }
}

function focusFirstInvalidControl(): void {
  const firstInvalid = form.querySelector<
    HTMLInputElement | HTMLSelectElement
  >('[aria-invalid="true"]');
  if (!firstInvalid) return;

  if (!firstInvalid.disabled) {
    firstInvalid.focus();
    return;
  }

  if (firstInvalid === endpoints.primary.video) {
    if (!endpoints.primary.rescan.disabled) endpoints.primary.rescan.focus();
    else endpoints.primary.tab.focus();
    return;
  }
  if (firstInvalid === endpoints.secondary.video) {
    if (!endpoints.secondary.rescan.disabled) endpoints.secondary.rescan.focus();
    else endpoints.secondary.tab.focus();
  }
}

function stateConfigKey(state: PopupSyncState): string {
  if (isBackgroundState(state)) {
    return [
      state.pairId,
      "background",
      playbackModeForState(state),
      state.primary.endpoint.tabId,
      endpointSelectionKey(state.primary.endpoint),
      state.backgroundAudio.mode === "offscreen" ? state.backgroundAudio.sourceUrl : state.backgroundAudio.pageUrl,
      stateUsesAutoOffset(state),
      manualOffsetFromState(state),
    ].join(":");
  }
  return [
    state.pairId,
    "two-tabs",
    state.primary.endpoint.tabId,
    endpointSelectionKey(state.primary.endpoint),
    state.secondary.endpoint.tabId,
    endpointSelectionKey(state.secondary.endpoint),
    stateUsesAutoOffset(state),
    manualOffsetFromState(state),
  ].join(":");
}

function hydrateStateConfiguration(state: PopupSyncState): void {
  const key = stateConfigKey(state);
  if (hydratedConfigKey === key) return;

  const backgroundMode = isBackgroundState(state);
  modeSelect.value = backgroundMode ? "background" : "two-tabs";
  renderModeFields();
  renderTimingState(state);
  if (backgroundMode) {
    if (state.backgroundAudio.mode === "offscreen") {
      sourceUrlInput.value = state.backgroundAudio.sourceUrl;
    }
    volumeInput.value = String(state.backgroundAudio.volume);
    confirmedVolume = state.backgroundAudio.volume;
    const muteOriginal = stateMuteOriginal(state);
    if (muteOriginal !== null) muteOriginalInput.checked = muteOriginal;
    renderVolumeValue();
    setFieldError(sourceUrlInput, sourceUrlError, null);
  }
  if (tabsLoadState !== "ready") return;
  hydratedConfigKey = key;

  const primaryTabValue = String(state.primary.endpoint.tabId);
  if (hasOption(endpoints.primary.tab, primaryTabValue)) {
    endpoints.primary.tab.value = primaryTabValue;
  }

  rememberedVideos.primary.set(
    state.primary.endpoint.tabId,
    endpointSelectionKey(state.primary.endpoint),
  );

  if (endpoints.primary.tab.value === primaryTabValue) {
    void probeSelectedTab(
      "primary",
      endpointSelectionKey(state.primary.endpoint),
    );
  } else {
    resetVideoField("primary");
  }

  if (backgroundMode) return;

  const secondaryTabValue = String(state.secondary.endpoint.tabId);
  if (hasOption(endpoints.secondary.tab, secondaryTabValue)) {
    endpoints.secondary.tab.value = secondaryTabValue;
  }
  rememberedVideos.secondary.set(
    state.secondary.endpoint.tabId,
    endpointSelectionKey(state.secondary.endpoint),
  );
  if (endpoints.secondary.tab.value === secondaryTabValue) {
    void probeSelectedTab(
      "secondary",
      endpointSelectionKey(state.secondary.endpoint),
    );
  } else {
    resetVideoField("secondary");
  }
}

function setCurrentState(state: PopupSyncState | null): void {
  const previousState = currentState;
  const previousKey = previousState ? stateConfigKey(previousState) : null;
  const nextKey = state ? stateConfigKey(state) : null;
  currentState = state;

  if (!state) {
    hydratedConfigKey = null;
    if (previousState && tabsLoadState === "ready") {
      renderTabOptions();
      for (const side of ["primary", "secondary"] as const) {
        if (parseTabId(endpoints[side].tab) === null) resetVideoField(side);
      }
    }
  } else if (previousKey !== nextKey || hydratedConfigKey !== nextKey) {
    hydrateStateConfiguration(state);
  } else {
    renderTimingState(state);
    if (isBackgroundState(state)) {
      volumeInput.value = String(state.backgroundAudio.volume);
      confirmedVolume = state.backgroundAudio.volume;
      const muteOriginal = stateMuteOriginal(state);
      if (muteOriginal !== null) muteOriginalInput.checked = muteOriginal;
      renderVolumeValue();
    }
  }

  if (!state) renderTimingState(null);

  renderModeFields();
  renderControls();
  renderStatus();
}


function autoDubTabLabel(tabId: number): string {
  const tab = openTabs.find((candidate) => candidate.id === tabId);
  return tab ? tabLabel(tab) : `tab ${tabId}`;
}

function renderAutoDub(): void {
  const backgroundMode = selectedMode() === "background";
  autoDubSection.hidden = !backgroundMode;

  const selectedTabId = parseTabId(endpoints.primary.tab);
  const site = selectedSite();
  const siteOn = site !== null && autoDubSites.includes(site);

  autoDubAction.textContent =
    autoDubOperation === "enabling"
      ? "Turning on Auto Dub…"
      : autoDubOperation === "disabling"
        ? "Turning off Auto Dub…"
        : !site
          ? "Auto Dub needs a website tab"
          : siteOn
            ? `Turn off Auto Dub on ${site}`
            : `Turn on Auto Dub for ${site}`;
  autoDubAction.setAttribute(
    "aria-busy",
    String(autoDubOperation === "enabling" || autoDubOperation === "disabling"),
  );
  autoDubAction.disabled = siteOn
    ? isBooting || !autoDubLoaded || autoDubOperation !== null
    : !backgroundMode ||
      !site ||
      isBooting ||
      !autoDubLoaded ||
      Boolean(autoDubLoadError) ||
      autoDubOperation !== null ||
      operation !== null ||
      (currentState !== null && currentState.backgroundAudio?.mode !== "hosted") ||
      tabsLoadState !== "ready" ||
      selectedTabId === null;


  delete autoDubDetail.dataset.tone;
  if (autoDubOperation === "enabling") {
    autoDubStateElement.textContent = "Enabling";
    autoDubDetail.textContent = "Enabling Auto Dub for the selected tab…";
    return;
  }
  if (autoDubOperation === "disabling") {
    autoDubStateElement.textContent = "Disabling";
    autoDubDetail.textContent = "Turning off Auto Dub…";
    return;
  }
  if (!autoDubLoaded) {
    autoDubStateElement.textContent = autoDubLoadError ? "Unavailable" : "Loading";
    autoDubDetail.textContent =
      autoDubLoadError || "Reading the current Auto Dub setting…";
    if (autoDubLoadError) autoDubDetail.dataset.tone = "error";
    return;
  }
  if (!siteOn) {
    autoDubStateElement.textContent = "Off";
    autoDubDetail.textContent = site
      ? `Turn it on to hear the Dub automatically while you watch Sub on any ${site} episode. It stays on until you turn it off.`
      : "Open an episode page to use Auto Dub.";
    return;
  }
  if (!autoDub || autoDub.tabId !== selectedTabId) {
    autoDubStateElement.textContent = "On";
    autoDubDetail.textContent = autoDub
      ? `Auto Dub is on for ${site}. It's currently attached to another tab${autoDub.site ? ` (${autoDub.site})` : ""}; stop or move it to use this tab.`
      : `Auto Dub is on for ${site}. It starts when you watch an episode here.`;
    return;
  }

  const tabName = autoDubTabLabel(autoDub.tabId);
  const reason = autoDub.reason.trim();
  switch (autoDub.status) {
    case "finding":
      autoDubStateElement.textContent = "Finding";
      autoDubDetail.textContent = reason || "Finding Dub audio…";
      break;
    case "waiting":
      autoDubStateElement.textContent = "Waiting";
      autoDubDetail.textContent =
        reason || `Waiting for exactly one playable video in ${tabName}.`;
      break;
    case "active":
      autoDubStateElement.textContent = "Active";
      autoDubDetail.textContent = reason || `Auto Dub is active in ${tabName}.`;
      break;
    case "ambiguous":
      autoDubStateElement.textContent = "Needs one video";
      autoDubDetail.textContent =
        reason || `More than one playable video was found in ${tabName}.`;
      autoDubDetail.dataset.tone = "warning";
      break;
    case "unsupported":
      autoDubStateElement.textContent = "Unavailable";
      autoDubDetail.textContent =
        reason || `Auto Dub is not supported in ${tabName}.`;
      autoDubDetail.dataset.tone = "warning";
      break;
    case "error":
      autoDubStateElement.textContent = "Error";
      autoDubDetail.textContent = reason || `Auto Dub failed in ${tabName}.`;
      autoDubDetail.dataset.tone = "error";
      break;
  }
}

function validateAutoDubConfig(): PopupAutoDubConfig | null {
  const tabId = parseTabId(endpoints.primary.tab);
  const offsetMs = validateOffset(true);
  setFieldError(
    endpoints.primary.tab,
    endpoints.primary.tabError,
    tabId === null ? "Choose a primary tab." : null,
  );

  if (tabId === null) {
    endpoints.primary.tab.focus();
    return null;
  }
  if (offsetMs === null) {
    offsetInput.focus();
    return null;
  }
  return {
    tabId,
    volume: readVolume(),
    offsetMs,
    muteOriginal: muteOriginalInput.checked,
    autoOffset: autoOffsetInput.checked,
  };
}

function applyAutoDubResponse(
  response: PopupBackgroundResponse,
  fallbackError: string,
): AutoDubState | null {
  readSites(response);
  if ("autoDub" in response) {
    const nextAutoDub = parseAutoDubState(response.autoDub);
    autoDub = nextAutoDub;
    autoDubLoaded = true;
    autoDubLoadError = null;
    renderLanguageDetection();
  }
  if (!response.ok) throw responseError(response, fallbackError);
  if (!("autoDub" in response)) {
    throw new Error("The extension did not confirm the Auto Dub setting.");
  }
  return parseAutoDubState(response.autoDub);
}

function statusForSyncState(state: SyncState): StatusView {
  const backgroundMode = isBackgroundState(state);
  const playbackMode = playbackModeForState(state);
  const dubSource = playbackMode === "hosted" ? "hidden Dub page"
    : playbackMode === "hosted-window" ? "minimized Dub window"
      : "hidden player";
  const fallbackByStatus: Record<SyncStatus, StatusView> = {
    idle: {
      label: "Sync ready",
      message: "The pair is ready.",
      tone: "neutral",
    },
    active: {
      label: "Sync active",
      message: backgroundMode
        ? `The video and ${dubSource} are being kept in sync.`
        : "Both videos are being kept in sync.",
      tone: "success",
    },
    paused: {
      label: "Sync paused",
      message: backgroundMode
        ? `Playback is paused; the ${dubSource} remains connected.`
        : "Playback is paused; the pair remains connected.",
      tone: "neutral",
    },
    buffering: {
      label: "Buffering",
      message: "Waiting for one of the videos to be ready.",
      tone: "warning",
    },
    degraded: {
      label: "Sync degraded",
      message: backgroundMode
        ? "Sync is running with limited control. Check the video and its Dub source."
        : "Sync is running with limited control. Check both video tabs.",
      tone: "warning",
    },
    "manual-play-required": {
      label: "Manual play needed",
      message: "Open the affected tab and press play once.",
      tone: "warning",
    },
    error: {
      label: "Sync error",
      message: backgroundMode
        ? `The ${dubSource} could not be kept in sync. Stop and try again.`
        : "The videos could not be kept in sync. Stop and check both tabs.",
      tone: "error",
    },
  };

  const view = { ...fallbackByStatus[state.status] };
  if (state.status === "manual-play-required") {
    view.message = backgroundMode
      ? "Open the primary tab and press play once."
      : state.manualPlayRequired
        ? `Open the ${state.manualPlayRequired} tab and press play once.`
        : view.message;
    if (state.message) view.message = `${view.message} ${state.message}`;
  } else if (state.message) {
    view.message = state.message;
  }
  return view;
}

function statusView(): StatusView {
  if (operation === "starting") {
    return {
      label: "Starting sync",
      message:
        selectedMode() === "background"
          ? "Connecting the video and background audio…"
          : "Connecting the selected videos…",
      tone: "neutral",
    };
  }
  if (operation === "stopping") {
    return {
      label: "Stopping sync",
      message: "Disconnecting the current video pair…",
      tone: "neutral",
    };
  }
  if (currentState) return statusForSyncState(currentState);
  if (!actionError.hidden) {
    return {
      label: "Action failed",
      message: actionError.textContent || "The action could not be completed.",
      tone: "error",
    };
  }
  if (stateLoadError) {
    return {
      label: "State unavailable",
      message: stateLoadError,
      tone: "error",
    };
  }
  if (tabsLoadState === "loading" || isBooting) {
    return {
      label: "Loading",
      message: "Reading open tabs and current sync state…",
      tone: "neutral",
    };
  }
  if (tabsLoadState === "error") {
    return {
      label: "Tabs unavailable",
      message: tabsLoadError || "Open tabs could not be read.",
      tone: "error",
    };
  }
  const tabCountNeeded = selectedMode() === "background" ? 1 : 2;
  if (openTabs.length < tabCountNeeded) {
    return {
      label: tabCountNeeded === 1 ? "Video tab needed" : "Two tabs needed",
      message:
        tabCountNeeded === 1
          ? "Open a tab with an HTML5 video, then reopen this popup."
          : "Open two tabs with HTML5 videos, then reopen this popup.",
      tone: "neutral",
    };
  }
  return {
    label: "Ready",
    message:
      selectedMode() === "background"
        ? "Choose a video and direct media URL, then start sync."
        : "Choose two tabs and videos, then start sync.",
    tone: "neutral",
  };
}

function renderStatus(): void {
  const view = statusView();
  if (statusLabel.textContent !== view.label) statusLabel.textContent = view.label;
  if (statusMessage.textContent !== view.message) {
    statusMessage.textContent = view.message;
  }
  if (statusContent.dataset.tone !== view.tone) {
    statusContent.dataset.tone = view.tone;
  }

  const canRetry =
    Boolean(autoDubLoadError) ||
    (!currentState && (Boolean(stateLoadError) || tabsLoadState === "error"));
  retryButton.hidden = !canRetry;
  retryButton.textContent = "Try again";
}

function renderControls(): void {
  const busy = operation !== null;
  const pairExists = currentState !== null;
  const backgroundMode = selectedMode() === "background";
  const backgroundActive = isBackgroundState(currentState);
  const lockConfiguration = isBooting || !stateLoaded || busy || pairExists;
  configurationFields.disabled = false;
  renderModeFields();

  modeSelect.disabled = lockConfiguration;
  offsetInput.disabled = lockConfiguration;
  for (const button of offsetStepButtons) {
    button.disabled = isBooting || !stateLoaded || busy || autoOffsetPending || offsetStepPending;
  }
  autoOffsetInput.disabled =
    offsetStepPending ||
    isBooting ||
    !stateLoaded ||
    busy ||
    autoOffsetPending ||
    autoDubOperation !== null;
  autoOffsetInput.setAttribute("aria-busy", String(autoOffsetPending));
  sourceUrlInput.disabled = !backgroundMode || lockConfiguration;
  volumeInput.disabled =
    !backgroundMode ||
    isBooting ||
    !stateLoaded ||
    busy ||
    (pairExists && !backgroundActive);
  muteOriginalInput.disabled =
    !backgroundMode ||
    isBooting ||
    !stateLoaded ||
    busy ||
    muteOriginalPending ||
    (pairExists && !backgroundActive);

  endpoints.primary.tab.disabled =
    lockConfiguration || tabsLoadState !== "ready" || openTabs.length === 0;
  endpoints.primary.video.disabled =
    lockConfiguration ||
    endpointViews.primary.loadState !== "ready" ||
    endpointViews.primary.videos.length === 0;
  endpoints.primary.rescan.disabled =
    lockConfiguration ||
    parseTabId(endpoints.primary.tab) === null ||
    endpointViews.primary.loadState === "loading";

  endpoints.secondary.tab.disabled =
    backgroundMode ||
    lockConfiguration ||
    tabsLoadState !== "ready" ||
    openTabs.length === 0;
  endpoints.secondary.video.disabled =
    backgroundMode ||
    lockConfiguration ||
    endpointViews.secondary.loadState !== "ready" ||
    endpointViews.secondary.videos.length === 0;
  endpoints.secondary.rescan.disabled =
    backgroundMode ||
    lockConfiguration ||
    parseTabId(endpoints.secondary.tab) === null ||
    endpointViews.secondary.loadState === "loading";

  sourceUrlInput.required = backgroundMode;
  endpoints.secondary.tab.required = !backgroundMode;
  endpoints.secondary.video.required = !backgroundMode;

  swapButton.disabled =
    backgroundMode ||
    lockConfiguration ||
    (parseTabId(endpoints.primary.tab) === null &&
      parseTabId(endpoints.secondary.tab) === null);
  startButton.disabled =
    isBooting ||
    !stateLoaded ||
    tabsLoadState !== "ready" ||
    openTabs.length < (backgroundMode ? 1 : 2) ||
    busy ||
    pairExists;
  stopButton.disabled = isBooting || busy || !pairExists;

  startButton.classList.toggle("is-busy", operation === "starting");
  stopButton.classList.toggle("is-busy", operation === "stopping");
  startButton.setAttribute("aria-busy", String(operation === "starting"));
  stopButton.setAttribute("aria-busy", String(operation === "stopping"));
  startButton.setAttribute(
    "aria-label",
    operation === "starting" ? "Start sync, starting" : "Start sync",
  );
  stopButton.setAttribute(
    "aria-label",
    operation === "stopping" ? "Stop sync, stopping" : "Stop sync",
  );
  renderAutoDub();
}

async function initialize(): Promise<void> {
  const requestId = ++initializationId;
  const versionAtStart = stateUpdateVersion;
  const autoDubVersionAtStart = autoDubUpdateVersion;
  const primaryTabId = parseTabId(endpoints.primary.tab);
  const secondaryTabId = parseTabId(endpoints.secondary.tab);

  isBooting = true;
  stateLoaded = false;
  autoDubLoaded = false;
  tabsLoadState = "loading";
  tabsLoadError = null;
  stateLoadError = null;
  autoDubLoadError = null;
  clearActionError();
  clearLanguageDetection("Loading open tabs…");
  renderTabOptions();
  renderControls();
  renderStatus();

  const [
    tabsResult,
    activeTabResult,
    stateResult,
    autoDubResult,
    muteOriginalResult,
    autoOffsetResult,
  ] =
    await Promise.allSettled([
      chrome.tabs.query({}),
      chrome.tabs.query({ active: true, currentWindow: true }),
      requestCurrentState(),
      requestAutoDubState(),
      chrome.storage.local.get("muteOriginal"),
      chrome.storage.local.get("autoOffset"),
    ]);
  if (requestId !== initializationId) return;

  if (tabsResult.status === "fulfilled") {
    openTabs = tabsResult.value.filter((tab) => typeof tab.id === "number");
    tabsLoadState = openTabs.length === 0 ? "empty" : "ready";
  } else {
    openTabs = [];
    tabsLoadState = "error";
    tabsLoadError = `Couldn’t read open tabs. ${messageFromError(
      tabsResult.reason,
      "Chrome did not return a tab list.",
    )}`;
  }

  if (stateResult.status === "fulfilled") {
    stateLoaded = true;
    if (stateUpdateVersion === versionAtStart) {
      currentState = stateResult.value;
      if (!currentState) hydratedConfigKey = null;
    }
  } else {
    if (stateUpdateVersion === versionAtStart) {
      stateLoaded = false;
      stateLoadError = messageFromError(
        stateResult.reason,
        "Couldn’t load the current sync state.",
      );
    }
  }

  if (autoDubResult.status === "fulfilled") {
    autoDubLoaded = true;
    if (autoDubUpdateVersion === autoDubVersionAtStart) {
      autoDub = autoDubResult.value;
    }
  } else if (autoDubUpdateVersion === autoDubVersionAtStart) {
    autoDubLoaded = false;
    autoDubLoadError = messageFromError(
      autoDubResult.reason,
      "Couldn’t load the Auto Dub setting.",
    );
  }

  if (muteOriginalResult.status === "fulfilled") {
    const storedMuteOriginal = muteOriginalResult.value.muteOriginal;
    muteOriginalInput.checked =
      typeof storedMuteOriginal === "boolean" ? storedMuteOriginal : true;
  } else {
    muteOriginalInput.checked = true;
    showActionError(
      `Couldn’t load the saved mute setting. ${messageFromError(
        muteOriginalResult.reason,
        "Using the default setting.",
      )}`,
    );
  }

  if (autoOffsetResult.status === "fulfilled") {
    const storedAutoOffset = autoOffsetResult.value.autoOffset;
    autoOffsetInput.checked =
      typeof storedAutoOffset === "boolean" ? storedAutoOffset : false;
  } else {
    autoOffsetInput.checked = false;
    showActionError(
      `Couldn’t load the saved Auto offset setting. ${messageFromError(
        autoOffsetResult.reason,
        "Using the default setting.",
      )}`,
    );
  }

  const activeHttpTabId =
    activeTabResult.status === "fulfilled"
      ? httpTabId(activeTabResult.value[0])
      : null;
  const preferredTabs: Partial<Record<Side, number | null>> = currentState
    ? {
        primary: currentState.primary.endpoint.tabId,
        secondary: currentState.secondary.endpoint.tabId,
      }
    : {
        primary: autoDub?.tabId ?? primaryTabId ?? activeHttpTabId,
        secondary: secondaryTabId,
      };
  renderTabOptions(preferredTabs);

  isBooting = false;
  if (currentState) {
    hydrateStateConfiguration(currentState);
  } else {
    const sidesToProbe: Side[] =
      selectedMode() === "background" ? ["primary"] : ["primary", "secondary"];
    for (const side of sidesToProbe) {
      if (parseTabId(endpoints[side].tab) === null) {
        resetVideoField(side);
        if (side === "primary") clearLanguageDetection();
      }
      else void probeSelectedTab(side);
    }
    if (selectedMode() === "background") resetVideoField("secondary");
  }
  renderControls();
  renderStatus();
}

function handleTabChange(side: Side): void {
  clearActionError();
  const elements = endpoints[side];
  if (side === "primary") {
    clearLanguageDetection(
      parseTabId(elements.tab) === null
        ? "Choose a primary tab to check its language options."
        : "Checking the newly selected tab…",
    );
  }
  setFieldError(elements.tab, elements.tabError, null);
  setFieldError(elements.video, elements.videoError, null);
  validateTabRelationship();

  const tabId = parseTabId(elements.tab);
  if (tabId === null) {
    resetVideoField(side);
  } else {
    void probeSelectedTab(side, rememberedVideos[side].get(tabId) ?? null);
  }
  renderControls();
  renderStatus();
}

function handleVideoChange(side: Side): void {
  clearActionError();
  const elements = endpoints[side];
  const view = endpointViews[side];
  const tabId = parseTabId(elements.tab);
  if (tabId !== null && elements.video.value) {
    rememberedVideos[side].set(tabId, elements.video.value);
  }
  if (view.loadState === "ready") {
    elements.videoMessage.textContent =
      view.videos.length === 1
        ? "1 video found."
        : `${view.videos.length} videos found${
            elements.video.value ? "." : "; choose one."
          }`;
    delete elements.videoMessage.dataset.tone;
  }
  setFieldError(elements.video, elements.videoError, null);
  renderStatus();
}

function handleModeChange(): void {
  clearActionError();
  setFieldError(sourceUrlInput, sourceUrlError, null);
  setFieldError(endpoints.secondary.tab, endpoints.secondary.tabError, null);
  setFieldError(endpoints.secondary.video, endpoints.secondary.videoError, null);
  renderModeFields();
  validateTabRelationship();
  renderControls();
  renderStatus();
}

async function handleVolumeChange(): Promise<void> {
  renderVolumeValue();
  const backgroundState = isBackgroundState(currentState) ? currentState : null;
  if (!backgroundState && autoDub === null) return;

  const requestId = ++volumeUpdateId;
  const volume = readVolume();
  const previousVolume =
    backgroundState?.backgroundAudio.volume ?? confirmedVolume;
  clearActionError();

  try {
    const response = await sendBackgroundMessage({
      type: "SET_BACKGROUND_VOLUME",
      volume,
    });
    if (!response.ok) {
      throw responseError(response, "Background volume could not be changed.");
    }
    if (requestId !== volumeUpdateId) return;
    if (response.state !== undefined) setCurrentState(response.state);
    confirmedVolume = volume;
  } catch (error) {
    if (requestId !== volumeUpdateId) return;
    volumeInput.value = String(previousVolume);
    renderVolumeValue();
    showActionError(
      messageFromError(error, "Background volume could not be changed."),
    );
  }
}

async function handleMuteOriginalChange(): Promise<void> {
  const requestId = ++muteOriginalUpdateId;
  const requestedMuteOriginal = muteOriginalInput.checked;
  const previousMuteOriginal =
    stateMuteOriginal(currentState) ?? !requestedMuteOriginal;
  const versionAtStart = stateUpdateVersion;
  muteOriginalPending = true;
  clearActionError();
  renderControls();

  try {
    const backgroundStateAtStart = isBackgroundState(currentState)
      ? currentState
      : null;
    if (backgroundStateAtStart || autoDub !== null) {
      const response = await sendBackgroundMessage({
        type: "SET_MUTE_ORIGINAL",
        muteOriginal: requestedMuteOriginal,
      });
      if (!response.ok) {
        if (response.state !== undefined) setCurrentState(response.state);
        throw responseError(response, "The original video sound could not be changed.");
      }
      if (requestId !== muteOriginalUpdateId) return;

      if (backgroundStateAtStart) {
        const nextState =
          stateUpdateVersion !== versionAtStart
            ? currentState
            : response.state !== undefined
              ? response.state
              : await requestCurrentState();
        if (requestId !== muteOriginalUpdateId) return;
        if (!isBackgroundState(nextState)) {
          throw new Error("The background audio session is no longer active.");
        }

        stateLoaded = true;
        stateLoadError = null;
        setCurrentState(nextState);
        const confirmedMuteOriginal = stateMuteOriginal(nextState);
        if (confirmedMuteOriginal !== requestedMuteOriginal) {
          throw new Error("The original video sound setting was not confirmed.");
        }
      } else if (response.state !== undefined) {
        setCurrentState(response.state);
      }
    }

    await chrome.storage.local.set({
      muteOriginal: requestedMuteOriginal,
    });
  } catch (error) {
    if (requestId !== muteOriginalUpdateId) return;
    muteOriginalInput.checked =
      stateMuteOriginal(currentState) ?? previousMuteOriginal;
    showActionError(
      messageFromError(
        error,
        "The original video sound setting could not be changed.",
      ),
    );
  } finally {
    if (requestId === muteOriginalUpdateId) {
      muteOriginalPending = false;
      renderControls();
      renderStatus();
    }
  }
}

async function handleAutoOffsetChange(): Promise<void> {
  const requestId = ++autoOffsetUpdateId;
  const requestedAutoOffset = autoOffsetInput.checked;
  const activeStateAtStart = currentState;
  const shouldUpdateBackend = activeStateAtStart !== null || autoDub !== null;
  const previousAutoOffset = activeStateAtStart
    ? stateUsesAutoOffset(activeStateAtStart)
    : !requestedAutoOffset;

  clearActionError();
  if (requestedAutoOffset && validateOffset(true) === null) {
    autoOffsetInput.checked = previousAutoOffset;
    offsetInput.focus();
    renderControls();
    return;
  }

  const versionAtStart = stateUpdateVersion;
  autoOffsetPending = true;
  renderControls();

  try {
    if (shouldUpdateBackend) {
      const response = await sendBackgroundMessage({
        type: "SET_AUTO_OFFSET",
        enabled: requestedAutoOffset,
      });
      if (!response.ok) {
        if (response.state !== undefined) setCurrentState(response.state);
        throw responseError(response, "Auto offset could not be changed.");
      }
      if (requestId !== autoOffsetUpdateId) return;

      if (activeStateAtStart) {
        const nextState =
          stateUpdateVersion !== versionAtStart
            ? currentState
            : response.state !== undefined
              ? response.state
              : await requestCurrentState();
        if (requestId !== autoOffsetUpdateId) return;
        if (!nextState) {
          throw new Error("The sync session is no longer active.");
        }

        stateLoaded = true;
        stateLoadError = null;
        setCurrentState(nextState);
        if (stateUsesAutoOffset(nextState) !== requestedAutoOffset) {
          throw new Error("The Auto offset setting was not confirmed.");
        }
      }
    }

    await chrome.storage.local.set({ autoOffset: requestedAutoOffset });
  } catch (error) {
    if (requestId !== autoOffsetUpdateId) return;
    autoOffsetInput.checked = currentState
      ? stateUsesAutoOffset(currentState)
      : previousAutoOffset;
    showActionError(
      messageFromError(error, "Auto offset could not be changed."),
    );
  } finally {
    if (requestId === autoOffsetUpdateId) {
      autoOffsetPending = false;
      renderControls();
      renderStatus();
    }
  }
}

function swapEndpoints(): void {
  clearActionError();
  const primaryTab = endpoints.primary.tab.value;
  const secondaryTab = endpoints.secondary.tab.value;
  const primaryVideo = endpoints.primary.video.value || null;
  const secondaryVideo = endpoints.secondary.video.value || null;

  endpoints.primary.tab.value = secondaryTab;
  endpoints.secondary.tab.value = primaryTab;
  setFieldError(endpoints.primary.tab, endpoints.primary.tabError, null);
  setFieldError(endpoints.secondary.tab, endpoints.secondary.tabError, null);
  setFieldError(endpoints.primary.video, endpoints.primary.videoError, null);
  setFieldError(endpoints.secondary.video, endpoints.secondary.videoError, null);

  const parsedOffset = parseOffset(offsetInput.value);
  const offsetMs = parsedOffset === null ? null : -parsedOffset;
  if (offsetMs !== null) {
    retainedManualOffsetMs = -offsetMs;
    offsetInput.value = formatOffset(-retainedManualOffsetMs);
    offsetTouched = true;
    setFieldError(offsetInput, offsetError, null);
  } else {
    validateOffset(true);
  }

  const newPrimaryTabId = parseTabId(endpoints.primary.tab);
  const newSecondaryTabId = parseTabId(endpoints.secondary.tab);
  if (newPrimaryTabId !== null && secondaryVideo) {
    rememberedVideos.primary.set(newPrimaryTabId, secondaryVideo);
  }
  if (newSecondaryTabId !== null && primaryVideo) {
    rememberedVideos.secondary.set(newSecondaryTabId, primaryVideo);
  }

  if (newPrimaryTabId === null) resetVideoField("primary");
  else void probeSelectedTab("primary", secondaryVideo);
  if (newSecondaryTabId === null) resetVideoField("secondary");
  else void probeSelectedTab("secondary", primaryVideo);

  validateTabRelationship();
  renderControls();
  renderStatus();
}

async function handleAutoDubAction(): Promise<void> {
  clearActionError();
  const site = selectedSite();
  if (!site) return;
  const disabling = autoDubSites.includes(site);
  const config = disabling ? null : validateAutoDubConfig();
  if (!disabling && !config) return;

  autoDubOperation = disabling ? "disabling" : "enabling";
  renderControls();

  try {
    const response = await sendBackgroundMessage(config
      ? { type: "SET_AUTO_DUB_SITE", site, enabled: true, tabId: config.tabId,
        settings: { volume: config.volume, offsetMs: config.offsetMs, muteOriginal: config.muteOriginal, autoOffset: config.autoOffset } }
      : { type: "SET_AUTO_DUB_SITE", site, enabled: false });
    applyAutoDubResponse(
      response,
      disabling ? "Auto Dub could not be turned off." : "Auto Dub could not be turned on.",
    );
    if (autoDubSites.includes(site) === disabling) {
      throw new Error(disabling ? "Auto Dub is still on for this site." : "Auto Dub was not turned on.");
    }
  } catch (error) {
    showActionError(
      messageFromError(
        error,
        disabling
          ? "Auto Dub could not be turned off."
          : "Auto Dub could not be turned on.",
      ),
    );
  } finally {
    autoDubOperation = null;
    renderControls();
    renderStatus();
  }
}

async function handleStart(): Promise<void> {
  clearActionError();
  const validated = validateForm();
  if (!validated) return;

  operation = "starting";
  const versionAtStart = stateUpdateVersion;
  renderControls();
  renderStatus();

  try {
    const request: PopupBackgroundRequest =
      validated.mode === "background"
        ? { type: "START_BACKGROUND_AUDIO", config: validated.config }
        : { type: "START_SYNC", config: validated.config };
    const response = await sendBackgroundMessage(request);
    if (!response.ok) throw responseError(response, "Sync could not be started.");
    autoDub = null;
    autoDubLoaded = true;
    autoDubLoadError = null;

    const nextState =
      stateUpdateVersion !== versionAtStart
        ? currentState
        : response.state !== undefined
          ? response.state
          : await requestCurrentState();
    if (!nextState) throw new Error("Sync did not start. Check both selected videos.");
    stateLoaded = true;
    stateLoadError = null;
    setCurrentState(nextState);
  } catch (error) {
    showActionError(messageFromError(error, "Sync could not be started."));
  } finally {
    operation = null;
    renderControls();
    renderStatus();
  }
}

async function handleStop(): Promise<void> {
  clearActionError();
  operation = "stopping";
  const versionAtStart = stateUpdateVersion;
  renderControls();
  renderStatus();

  try {
    const response = await sendBackgroundMessage({ type: "STOP_SYNC" });
    if (!response.ok) throw responseError(response, "Sync could not be stopped.");
    autoDub = null;
    autoDubLoaded = true;
    autoDubLoadError = null;

    const nextState =
      stateUpdateVersion !== versionAtStart
        ? currentState
        : response.state !== undefined
          ? response.state
          : await requestCurrentState();
    stateLoaded = true;
    stateLoadError = null;
    setCurrentState(nextState);
  } catch (error) {
    showActionError(messageFromError(error, "Sync could not be stopped."));
  } finally {
    operation = null;
    renderControls();
    renderStatus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void handleStart();
});

stopButton.addEventListener("click", () => void handleStop());
autoDubAction.addEventListener("click", () => void handleAutoDubAction());
swapButton.addEventListener("click", swapEndpoints);
retryButton.addEventListener("click", () => void initialize());
modeSelect.addEventListener("change", handleModeChange);

for (const side of ["primary", "secondary"] as const) {
  endpoints[side].tab.addEventListener("change", () => handleTabChange(side));
  endpoints[side].video.addEventListener("change", () => handleVideoChange(side));
  endpoints[side].rescan.addEventListener("click", () => {
    clearActionError();
    void probeSelectedTab(side, endpoints[side].video.value || null);
  });
}

for (const button of offsetStepButtons) {
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    const offsetMs = validateOffset(true);
    if (offsetMs === null) { offsetInput.focus(); return; }
    const nextOffsetMs = offsetMs - Number(button.dataset.offsetStep);
    clearActionError();
    offsetStepPending = true;
    renderControls();
    try {
      if (currentState || autoDub) {
        const response = await sendBackgroundMessage({ type: "SET_MANUAL_OFFSET", offsetMs: nextOffsetMs });
        if (!response.ok) throw responseError(response, "Dub timing could not be changed.");
        if (response.state !== undefined) setCurrentState(response.state);
      }
      if (!currentState) {
        retainedManualOffsetMs = nextOffsetMs;
        offsetInput.value = formatOffset(-nextOffsetMs);
        offsetTouched = true;
      }
    } catch (error) {
      showActionError(messageFromError(error, "Dub timing could not be changed."));
    } finally {
      offsetStepPending = false;
      renderControls();
      renderStatus();
    }
  });
}

offsetInput.addEventListener("input", () => {
  clearActionError();
  offsetTouched = true;
  if (offsetInput.getAttribute("aria-invalid") === "true") validateOffset(true);
  renderStatus();
});

offsetInput.addEventListener("blur", () => {
  const offsetMs = validateOffset(offsetTouched);
  if (offsetMs !== null) {
    offsetInput.value = formatOffset(-offsetMs);
    setFieldError(offsetInput, offsetError, null);
  }
});

sourceUrlInput.addEventListener("input", () => {
  clearActionError();
  if (sourceUrlInput.getAttribute("aria-invalid") === "true") {
    validateSourceUrl();
  }
  renderStatus();
});

sourceUrlInput.addEventListener("blur", () => {
  if (sourceUrlInput.value.trim()) validateSourceUrl();
});

volumeInput.addEventListener("input", renderVolumeValue);
volumeInput.addEventListener("change", () => void handleVolumeChange());
muteOriginalInput.addEventListener("change", () => {
  void handleMuteOriginalChange();
});
autoOffsetInput.addEventListener("change", () => {
  void handleAutoOffsetChange();
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (
    isRecord(message) &&
    message.type === "AUTO_DUB_UPDATE" &&
    "autoDub" in message &&
    (message.autoDub === null || isAutoDubState(message.autoDub))
  ) {
    autoDubUpdateVersion += 1;
    autoDub = message.autoDub;
    autoDubLoaded = true;
    autoDubLoadError = null;
    renderLanguageDetection();
    renderControls();
    renderStatus();
    return;
  }

  if (
    isRecord(message) &&
    message.type === "LANGUAGE_DETECTION_UPDATE" &&
    typeof message.tabId === "number" &&
    Number.isInteger(message.tabId) &&
    isLanguageDetection(message.detection)
  ) {
    if (parseTabId(endpoints.primary.tab) !== message.tabId) return;
    languageDetectionRequestId += 1;
    languageDetection = message.detection;
    languageLoadState = "ready";
    languageDetectionError = null;
    renderLanguageDetection();
    return;
  }

  if (
    !isRecord(message) ||
    message.type !== "STATE_UPDATE" ||
    !("state" in message)
  ) {
    return;
  }

  const update = message as unknown as StateUpdateMessage;
  stateUpdateVersion += 1;
  stateLoaded = true;
  stateLoadError = null;
  setCurrentState(update.state);
});

renderModeFields();
renderVolumeValue();
clearLanguageDetection();
void initialize();
