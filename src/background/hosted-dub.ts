import { isRecord } from "../shared/messages";
import { dubUrlFor } from "../shared/dub-url";
import type { LanguageDetection } from "../shared/language-detection";
import type { HostContainer, VideoDescriptor, VideoEndpoint } from "../shared/types";
import {
  chooseDubVideo, nextProvider, providerFamily,
  type HostedVideoCandidate, type ProviderChoice,
} from "../shared/hosted-selection";
import { guardSettingsWrites, HOSTED_TAB_ID, hostedFrames, hostedRequest, hostLostReason, onHostedChange, openHost, type HostedFrame } from "./hosted-host";

const PAGE_LOAD_TIMEOUT_MS = 30_000;
const CONTROLS_TIMEOUT_MS = 20_000;
/** A copy that moved off the episode onto a page with no player gets this long to come back. */
const LEFT_PAGE_TIMEOUT_MS = 4_000;
const SERVER_TIMEOUT_MS = 25_000;
/**
 * A selection that starts no load at all within this long did nothing (for
 * example a server whose Dub option leaves the Sub stream playing). Move on
 * instead of waiting out SERVER_TIMEOUT_MS.
 */
const NO_SWITCH_TIMEOUT_MS = 8_000;
/** How long to let the hidden copy's Sub finish loading before switching it to Dub. */
const SUB_SETTLE_TIMEOUT_MS = 12_000;
const RECHECK_MS = 500;
/** Opening a player menu and choosing from it takes longer than an ordinary request. */
const SELECT_TIMEOUT_MS = 20_000;
/** How long the settings guard outlives the press that needed it. */
const SETTINGS_GUARD_MS = 6_000;
/**
 * An audio switch the control itself confirmed, with no new video load this
 * long after it, happened in place: the same video now carries the Dub.
 */
const IN_PLACE_SETTLE_MS = 4_000;

/**
 * A player that is still starting can take the audio choice (and save it)
 * without acting on it: pressed while its video had only metadata, one
 * service saved the preference and never switched. Where the choice is an
 * audio menu inside the player, the video must be able to play first
 * (HAVE_FUTURE_DATA). No extra delay is needed beyond that.
 */
const PLAYABLE = 3;

/** The hidden copy opened on audio in the viewer's language: there is no Sub to add Dub to. */
export class AlreadyDubError extends Error {
  constructor() {
    super("This page is already playing audio in your language.");
    this.name = "AlreadyDubError";
  }
}

export interface HostedDubRequest {
  pageUrl: string;
  /** The Server/Provider label the user is watching Sub on, when the page exposes one. */
  preferredProvider: string | null;
  /** Server family that played Dub on this site before; tried first. */
  rememberedServer?: string | null;
  /** Server families that failed here recently; tried last. */
  avoidServers?: string[];
  /** A server was given up on (never loaded, or loaded nothing new). */
  onServerFailed?(label: string): void;
  primaryDurationMs: number | null;
  container: HostContainer;
  signal: AbortSignal;
  onProgress(message: string): void;
  /** Called after the hidden copy's language or server control changed. */
  onSelected?(): void;
  /**
   * The visible page's own audio menu read as the original language. A hidden
   * copy that opens on the viewer's language is then the Dub already: players
   * that start every page load on their default audio leave the fresh copy
   * there, while the visible tab was switched by hand.
   */
  visibleOnOriginal?: boolean;
  /** Hidden document only: let the page attempt to take over its window (see host/mount.ts). */
  lenientFrame?: boolean;
  /** A copy of this episode was kept open after an earlier lookup: use it instead of loading another. */
  reuseOpenCopy?: boolean;
  /** Shown while the hidden copy loads, in place of the usual line. */
  startMessage?: string;
}

/**
 * The hidden copy ended up with no player and no controls: the usual sign of a
 * page that refuses to run inside another page. A lenient frame is worth a try.
 */
export class HostedPageGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedPageGoneError";
  }
}

export interface HostedDubResult {
  pageUrl: string;
  container: HostContainer;
  provider: string | null;
  endpoint: VideoEndpoint;
  /** Why the hidden document didn't work, when this result came from the window fallback. */
  fallbackReason?: string;
}

function waitForChange(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { unsubscribe(); clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
    const abort = () => { unsubscribe(); clearTimeout(timer); reject(new Error("Dub lookup cancelled.")); };
    const unsubscribe = onHostedChange(done);
    const timer = setTimeout(done, RECHECK_MS);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function ok(value: unknown, fallback: string): Record<string, unknown> {
  if (isRecord(value) && value.ok === true) return value;
  throw new Error(isRecord(value) && typeof value.error === "string" ? value.error : fallback);
}

async function detect(frame: HostedFrame): Promise<LanguageDetection> {
  const response = ok(await hostedRequest(frame.key, { type: "DETECT" }), "The hidden page returned no language state.");
  return response.detection as LanguageDetection;
}

async function listOptions(frame: HostedFrame): Promise<ProviderChoice[]> {
  try {
    const response = ok(await hostedRequest(frame.key, { type: "LIST_PROVIDERS" }), "");
    return Array.isArray(response.options) ? response.options as ProviderChoice[] : [];
  } catch {
    return []; // No server control: the page's own Dub choice is the only attempt.
  }
}

async function candidates(): Promise<HostedVideoCandidate[]> {
  const results = await Promise.all(hostedFrames().map(async frame => {
    try {
      const response = ok(await hostedRequest(frame.key, { type: "PROBE" }), "");
      const videos = Array.isArray(response.videos) ? response.videos as VideoDescriptor[] : [];
      return videos.map(video => ({ frameKey: frame.key, video, loadedAt: video.loadStartedAt ?? frame.connectedAt }));
    } catch {
      return [];
    }
  }));
  return results.flat();
}

/** When the page's control actually changed, as reported by the agent that changed it. */
function selectionTime(response: Record<string, unknown>): number {
  return typeof response.at === "number" && Number.isFinite(response.at) ? response.at : Date.now();
}

function samePath(href: string, pageUrl: string): boolean {
  try { return new URL(href).pathname === new URL(pageUrl).pathname; } catch { return false; }
}

function sameSite(href: string, pageUrl: string): boolean {
  try { return new URL(href).origin === new URL(pageUrl).origin; } catch { return false; }
}

/**
 * The page in the hidden copy refused to play and said why. Another container
 * would be told the same thing, and on services that count streams it would
 * use up one more.
 */
export class HostedPageNoticeError extends Error {
  constructor(message: string, readonly notice: string) {
    super(`${message} The page in the hidden copy says: “${notice}”`);
    this.name = "HostedPageNoticeError";
  }
}

const NOTICE_TIMEOUT_MS = 2_000;

async function pageNotice(): Promise<string | null> {
  const top = hostedFrames().find(frame => frame.depth === 1);
  if (!top) return null;
  try {
    const response = ok(await hostedRequest(top.key, { type: "NOTICES" }, NOTICE_TIMEOUT_MS), "");
    const [first] = Array.isArray(response.notices) ? response.notices : [];
    return typeof first === "string" && first ? first : null;
  } catch {
    return null;
  }
}

/**
 * Load the episode page into a hosted container, select Dub with the page's own
 * controls, and return its Dub video. Tries other servers when one never loads.
 * A failure carries the page's own explanation when it shows one.
 */
export async function findHostedDub(request: HostedDubRequest): Promise<HostedDubResult> {
  try {
    return await lookUpHostedDub(request);
  } catch (error) {
    if (request.signal.aborted || error instanceof AlreadyDubError) throw error;
    // A copy that blanked itself may show its own error screen; that screen is
    // the symptom, not a refusal another attempt would also get.
    if (error instanceof HostedPageGoneError && request.lenientFrame !== true && request.container === "offscreen") throw error;
    const notice = await pageNotice();
    if (!notice) throw error;
    throw new HostedPageNoticeError(error instanceof Error ? error.message : String(error), notice);
  }
}

async function lookUpHostedDub(request: HostedDubRequest): Promise<HostedDubResult> {
  const { pageUrl, signal } = request;
  const started = Date.now();
  request.onProgress(request.container !== "offscreen" ? "Loading this episode in a minimized Dub window…"
    : request.startMessage ?? "Loading a hidden copy of this episode…");
  // When the address names the language, load the Dub address directly; its
  // controls (or address) then already say Dub and nothing needs clicking.
  const openedUrl = dubUrlFor(pageUrl) ?? pageUrl;
  await openHost(openedUrl, request.container, { lenient: request.lenientFrame === true, reuse: request.reuseOpenCopy === true });

  let topSeenAt = 0;
  let selectedAt = 0;
  let dubRequested = false;
  let forced = false;
  let confirmedByControl = false;
  let options: ProviderChoice[] | null = null;
  let attemptDeadline = 0;
  let provider: string | null = null;
  const tried = new Set<string>();
  const family = request.rememberedServer || providerFamily(request.preferredProvider);
  const avoid = request.avoidServers ?? [];

  const select = async (frame: HostedFrame, label: string) => {
    const response = ok(await hostedRequest(frame.key, { type: "SELECT_PROVIDER", provider: label }), `Could not select the “${label}” server.`);
    tried.add(label);
    provider = label;
    selectedAt = selectionTime(response);
    request.onSelected?.();
    attemptDeadline = Date.now() + SERVER_TIMEOUT_MS;
    request.onProgress(`Loading Dub from the “${label}” server…`);
  };

  for (;;) {
    signal.throwIfAborted();
    const top = hostedFrames().find(frame => frame.depth === 1);
    if (!top) {
      // The container went away by itself; there is nothing left to wait for.
      if (hostLostReason()) throw new Error(hostLostReason());
      if (Date.now() - started > PAGE_LOAD_TIMEOUT_MS) throw new Error("The episode page did not load in the hidden player.");
      await waitForChange(signal);
      continue;
    }
    if (!sameSite(top.href, pageUrl)) throw new Error("The hidden copy of the page navigated to a different site.");
    topSeenAt ||= Date.now();

    let detection: LanguageDetection;
    try {
      detection = await detect(top);
    } catch (error) {
      // The hidden copy navigated (a Dub link, or a page that reloads itself):
      // its old frame is gone and the new page's frame connects shortly.
      if (Date.now() - started > PAGE_LOAD_TIMEOUT_MS + SERVER_TIMEOUT_MS) throw error;
      await waitForChange(signal);
      continue;
    }
    signal.throwIfAborted();
    // The page never says which language is selected: click Dub anyway. Only a
    // video that starts loading after that click counts (chooseDubVideo's
    // "since"), so a click that changed nothing is never accepted. A site that
    // answers the click by reloading Sub (no Dub for this episode) would still
    // pass; that's the accepted cost of supporting sites that hide their state.
    const unclear = detection.language === "unknown" && detection.stateUnclear === true;
    const language = unclear ? (dubRequested ? "dub" : "sub") : detection.language;

    if (language === "unknown") {
      const waited = Date.now() - topSeenAt;
      const left = !samePath(detection.pageUrl, openedUrl);
      if ((left && waited > LEFT_PAGE_TIMEOUT_MS) || waited > CONTROLS_TIMEOUT_MS) {
        const reason = left
          ? "The hidden copy left the episode page."
          : `The hidden page never showed its Sub/Dub controls. ${detection.reason}`;
        // No player either: the page gave up on itself rather than on Dub.
        if ((await candidates()).length === 0) throw new HostedPageGoneError(reason);
        if (waited > CONTROLS_TIMEOUT_MS) throw new Error(reason);
      }
    } else if (language === "sub") {
      if (!detection.available.includes("dub")) throw new Error("This episode has no Dub option.");
      // Let Sub finish loading first: a lazy Sub player that starts just after
      // Dub is selected would otherwise look like a fresh Dub load.
      const subLoaded = chooseDubVideo(await candidates(), { since: 0, primaryDurationMs: request.primaryDurationMs });
      const playerReady = detection.audioControl !== true || (subLoaded !== null && subLoaded.video.readyState >= PLAYABLE);
      if (!dubRequested && (!subLoaded || !playerReady) && Date.now() - topSeenAt < SUB_SETTLE_TIMEOUT_MS) {
        request.onProgress("Waiting for the hidden copy to load…");
      } else if (!dubRequested) {
        const guarded = detection.audioControl === true;
        if (guarded) await guardSettingsWrites(true);
        let answer: unknown;
        try {
          answer = await hostedRequest(top.key, { type: "SELECT_DUB", force: unclear }, SELECT_TIMEOUT_MS);
        } finally {
          if (guarded) setTimeout(() => void guardSettingsWrites(false), SETTINGS_GUARD_MS);
        }
        if (isRecord(answer) && answer.already === true) {
          if (request.visibleOnOriginal !== true) throw new AlreadyDubError();
          // Nothing to press: the video this copy already loaded is the Dub.
          confirmedByControl = true;
          dubRequested = true;
          attemptDeadline = Date.now() + SERVER_TIMEOUT_MS;
          request.onProgress("The hidden copy opened on Dub…");
          continue;
        }
        const response = ok(answer, "Could not select Dub in the hidden page.");
        confirmedByControl = response.confirmed === true;
        dubRequested = true;
        forced = unclear;
        selectedAt = selectionTime(response);
        request.onSelected?.();
        attemptDeadline = Date.now() + SERVER_TIMEOUT_MS;
        request.onProgress("Selecting Dub in the hidden page…");
      } else if (Date.now() > attemptDeadline) {
        throw new Error("The hidden page did not switch to Dub.");
      }
    } else {
      // A copy found on the viewer's language with nothing pressed (a kept copy,
      // or one whose menu was open) is the Dub only if the viewer's tab is known
      // to be on the original language. Otherwise it says what the tab plays too.
      if (!dubRequested && detection.audioControl === true && request.visibleOnOriginal !== true) throw new AlreadyDubError();
      // Dub is selected. Settle which server to try first, once.
      if (options === null) {
        options = await listOptions(top);
        const current = options.find(option => option.selected)?.label ?? null;
        provider = current;
        if (current) tried.add(current);
        attemptDeadline ||= Date.now() + SERVER_TIMEOUT_MS;
        // Switch away from the page's default when a better server is known: the
        // preferred family, or anything but a server that failed here recently.
        const currentFamily = providerFamily(current);
        const better = currentFamily === family && !avoid.includes(currentFamily) ? null
          : nextProvider(options, tried, family, avoid);
        const switchTo = better && (providerFamily(better) === family || avoid.includes(currentFamily)) ? better : null;
        if (switchTo) await select(top, switchTo);
      }

      const all = await candidates();
      const found = chooseDubVideo(all, { since: selectedAt, primaryDurationMs: request.primaryDurationMs }) ??
        (confirmedByControl && Date.now() - selectedAt > IN_PLACE_SETTLE_MS && !all.some(candidate => candidate.loadedAt >= selectedAt)
          ? chooseDubVideo(all, { since: 0, primaryDurationMs: request.primaryDurationMs })
          : null);
      if (found) {
        return {
          pageUrl,
          container: request.container,
          provider,
          endpoint: { tabId: HOSTED_TAB_ID, videoId: found.video.id, documentId: found.frameKey },
        };
      }

      const switchedNothing = selectedAt > 0 && Date.now() - selectedAt > NO_SWITCH_TIMEOUT_MS &&
        !all.some(candidate => candidate.loadedAt >= selectedAt);
      if (Date.now() > attemptDeadline || switchedNothing) {
        if (provider) request.onServerFailed?.(provider);
        options = await listOptions(top);
        const next = nextProvider(options, tried, family, avoid);
        if (!next) {
          const names = [...tried].map(label => `“${label}”`).join(", ");
          throw new Error(names ? `No Dub server loaded a playable episode (tried ${names}).`
            : forced ? "Clicking Dub in the hidden copy didn't load a new episode, so SubView can't be sure it's the Dub."
            : "The Dub player never loaded a playable episode.");
        }
        await select(top, next);
      }
    }
    await waitForChange(signal);
  }
}

/** How long a rebuilt player gets to show its new video. */
const REPLACEMENT_TIMEOUT_MS = 12_000;

/**
 * Some players rebuild their <video> in place (after a big seek, a stream error
 * or a quality switch). Find the new one in the same hidden copy instead of
 * reloading the page: it must have started loading around or after the loss.
 */
export async function findReplacementDub(
  previous: HostedDubResult,
  lostAt: number,
  primaryDurationMs: number | null,
): Promise<HostedDubResult | null> {
  const deadline = Date.now() + REPLACEMENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // A rebuilt player may have fallen back to the site's default (Sub): only a
    // copy that still says it's on Dub, or never said either way, may reconnect.
    const top = hostedFrames().find(frame => frame.depth === 1);
    const detection = top ? await detect(top).catch(() => null) : null;
    if (detection?.language === "sub") return null;
    const found = chooseDubVideo(await candidates(), { since: lostAt - 5_000, primaryDurationMs });
    if (found) {
      return { ...previous, endpoint: { tabId: HOSTED_TAB_ID, videoId: found.video.id, documentId: found.frameKey } };
    }
    await new Promise(resolve => setTimeout(resolve, RECHECK_MS));
  }
  return null;
}
