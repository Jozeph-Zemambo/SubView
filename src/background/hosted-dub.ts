import { isRecord } from "../shared/messages";
import { dubUrlFor } from "../shared/dub-url";
import type { LanguageDetection } from "../shared/language-detection";
import type { HostContainer, VideoDescriptor, VideoEndpoint } from "../shared/types";
import {
  chooseDubVideo, nextProvider, providerFamily,
  type HostedVideoCandidate, type ProviderChoice,
} from "../shared/hosted-selection";
import { HOSTED_TAB_ID, hostedFrames, hostedRequest, onHostedChange, openHost, type HostedFrame } from "./hosted-host";

const PAGE_LOAD_TIMEOUT_MS = 30_000;
const CONTROLS_TIMEOUT_MS = 20_000;
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

function sameSite(href: string, pageUrl: string): boolean {
  try { return new URL(href).origin === new URL(pageUrl).origin; } catch { return false; }
}

/**
 * Load the episode page into a hosted container, select Dub with the page's own
 * controls, and return its Dub video. Tries other servers when one never loads.
 */
export async function findHostedDub(request: HostedDubRequest): Promise<HostedDubResult> {
  const { pageUrl, signal } = request;
  const started = Date.now();
  request.onProgress(request.container === "offscreen"
    ? "Loading a hidden copy of this episode…"
    : "Loading this episode in a minimized Dub window…");
  // When the address names the language, load the Dub address directly; its
  // controls (or address) then already say Dub and nothing needs clicking.
  await openHost(dubUrlFor(pageUrl) ?? pageUrl, request.container);

  let topSeenAt = 0;
  let selectedAt = 0;
  let dubRequested = false;
  let forced = false;
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
      if (Date.now() - topSeenAt > CONTROLS_TIMEOUT_MS) {
        throw new Error(`The hidden page never showed its Sub/Dub controls. ${detection.reason}`);
      }
    } else if (language === "sub") {
      if (!detection.available.includes("dub")) throw new Error("This episode has no Dub option.");
      // Let Sub finish loading first: a lazy Sub player that starts just after
      // Dub is selected would otherwise look like a fresh Dub load.
      const subLoaded = chooseDubVideo(await candidates(), { since: 0, primaryDurationMs: request.primaryDurationMs });
      if (!dubRequested && !subLoaded && Date.now() - topSeenAt < SUB_SETTLE_TIMEOUT_MS) {
        request.onProgress("Waiting for the hidden copy to load…");
      } else if (!dubRequested) {
        const response = ok(await hostedRequest(top.key, { type: "SELECT_DUB", force: unclear }), "Could not select Dub in the hidden page.");
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
      const found = chooseDubVideo(all, { since: selectedAt, primaryDurationMs: request.primaryDurationMs });
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
