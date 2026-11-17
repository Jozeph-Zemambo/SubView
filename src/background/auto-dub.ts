import type { AutoDubConfig, AutoDubState } from "../shared/auto-dub";
import type { LanguageDetection } from "../shared/language-detection";
import type {
  BackgroundResponse,
  HostContainer,
  ProbeTabResponse,
  StartHostedDubConfig,
  SyncState,
  VideoEndpoint,
} from "../shared/types";
import { isExtensionUiSender, isRecord } from "../shared/messages";
import {
  DEFAULT_SITE_SETTINGS, normalizeSiteSettings, recentlyFailed, rememberFailedServer, rememberWorkingServer, siteKey,
  type SiteSettings,
} from "../shared/auto-dub-sites";
import { inspectLanguage, onLanguageDetection } from "./language-detection-host";
import type { HostedDubRequest, HostedDubResult } from "./hosted-dub";

const KEY = "autoDubSession";
/** Sites with Auto Dub on, kept across browser restarts. */
const SITES_KEY = "autoDubSites";
const DUB_START_TIMEOUT_MS = 15_000;
/** The visible tab turning to Dub this soon after the hidden copy chose Dub means the setting leaked. */
const LEAK_WINDOW_MS = 20_000;
const LEAK_REASON = "Your tab switched to Dub right after the hidden copy selected Dub, so this site shares the setting between them. Auto Dub stopped for this episode to stop changing your page. Switch back to Sub to keep watching; Scan again retries.";

interface Hooks {
  enqueue<T>(work: () => Promise<T> | T): Promise<T>;
  getState(): SyncState | null;
  probe(tabId: number): Promise<ProbeTabResponse>;
  startHosted(config: StartHostedDubConfig): Promise<BackgroundResponse>;
  stop(): Promise<void>;
  findDub(request: HostedDubRequest): Promise<HostedDubResult>;
  /** A rebuilt <video> in the still-open hidden copy, or null. */
  findReplacement(previous: HostedDubResult, lostAt: number, primaryDurationMs: number | null): Promise<HostedDubResult | null>;
  closeHost(): Promise<void>;
}

function validConfig(value: unknown): value is AutoDubConfig {
  return isRecord(value) && Number.isInteger(value.tabId) && (value.tabId as number) >= 0 &&
    typeof value.volume === "number" && Number.isFinite(value.volume) && value.volume >= 0 && value.volume <= 1 &&
    typeof value.offsetMs === "number" && Number.isFinite(value.offsetMs) &&
    typeof value.muteOriginal === "boolean" &&
    (value.autoOffset === undefined || typeof value.autoOffset === "boolean");
}

function normalizeConfig(value: unknown): AutoDubConfig | null {
  return validConfig(value) ? { ...value, autoOffset: value.autoOffset ?? false } : null;
}

function validResult(value: unknown): value is HostedDubResult {
  return isRecord(value) && typeof value.pageUrl === "string" &&
    (value.container === "offscreen" || value.container === "window") &&
    (value.provider === null || typeof value.provider === "string") &&
    (value.fallbackReason === undefined || typeof value.fallbackReason === "string") &&
    isRecord(value.endpoint) && typeof value.endpoint.videoId === "string" &&
    typeof value.endpoint.documentId === "string" && Number.isInteger(value.endpoint.tabId);
}

function errorMessage(error: unknown, fallback: string): string {
  return isRecord(error) && typeof error.message === "string" && error.message ? error.message : fallback;
}

/**
 * The visible tab counts as Sub when it says so, or when it has Sub and Dub but
 * never says which is selected. Dub over a muted Dub tab is harmless, and the
 * hidden copy only accepts a video that loaded after its own Dub click.
 */
function watchingSub(detection: LanguageDetection): boolean {
  return detection.language === "sub" || (detection.language === "unknown" && detection.stateUnclear === true);
}

const UNCLEAR_NOTE = " This site doesn't say whether your tab is on Sub or Dub, so SubView plays Dub either way.";

function activeReason(result: HostedDubResult, detection?: LanguageDetection | null): string {
  const where = result.container === "offscreen" ? "a hidden copy of this page" : "a minimized Dub window";
  const why = result.container === "window" && result.fallbackReason ? ` The hidden copy didn't work: ${result.fallbackReason}` : "";
  const unclear = detection?.language === "unknown" && detection.stateUnclear ? UNCLEAR_NOTE : "";
  return `Dub audio is playing from ${where}${result.provider ? ` (server: ${result.provider})` : ""}.${why}${unclear}`;
}

/**
 * Auto Dub: while the armed tab shows Sub, host a copy of the same page with Dub
 * selected and sync its video to the visible one. The visible tab is never
 * changed. The hidden copy runs in the offscreen document; a minimized window
 * is the fallback for players that will not start there.
 */
export function setupAutoDub(hooks: Hooks) {
  let config: AutoDubConfig | null = null;
  let state: AutoDubState | null = null;
  let detection: LanguageDetection | null = null;
  let ownedPair: string | null = null;
  /** The hosted Dub video for the current episode, while its container is open. */
  let resolved: HostedDubResult | null = null;
  let job: { pageUrl: string; controller: AbortController } | null = null;
  /** Episodes whose lookup failed; retried only by Scan again or a new episode. */
  let failedPage = "";
  /** Episodes that already used their one automatic recovery. */
  let recoveredPage = "";
  /** Rebuilt-player reconnects used on this page, so a looping player can't spin forever. */
  let rebinds = { page: "", count: 0 };
  const MAX_REBINDS = 3;
  let lastPrimaryDurationMs: number | null = null;
  /** Why the hidden document's Dub failed to play, shown with the window fallback. */
  let windowOnlyReason = "";
  /** Episodes whose hidden-document Dub failed to play; use the window next. */
  let windowOnlyPage = "";
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  /**
   * A new episode's player frame is created after the page loads and has no
   * SubView script yet, so it can't announce its video. While waiting for the
   * visible video, look again on a short timer instead of relying on that.
   */
  let videoRecheck: ReturnType<typeof setTimeout> | null = null;
  let videoRechecks = 0;
  const VIDEO_RECHECK_MS = 2_000;
  const VIDEO_RECHECK_LIMIT = 150; // about five minutes
  function recheckSoon(): void {
    if (videoRecheck || videoRechecks >= VIDEO_RECHECK_LIMIT) return;
    videoRechecks += 1;
    const token = epoch;
    videoRecheck = setTimeout(() => {
      videoRecheck = null;
      if (epoch === token) void hooks.enqueue(reconcile).catch(() => undefined);
    }, VIDEO_RECHECK_MS);
  }
  /** When the hidden copy last changed its own language/server control. */
  let hostedSelectedAt = 0;
  /** Episode where the hidden copy's choice leaked into the visible tab. */
  let leakedPage = "";
  let epoch = 0;
  /** Per-site Auto Dub: hostname → settings and server memory. */
  let sites: Record<string, SiteSettings> = {};
  /** The site the armed tab belongs to. */
  let armedSite: string | null = null;
  /** Server already recorded as working for the current hosted Dub. */
  let rememberedFor: HostedDubResult | null = null;

  const sitesLoaded = chrome.storage.local.get(SITES_KEY).then(stored => {
    const saved = (stored as Record<string, unknown>)[SITES_KEY];
    if (!isRecord(saved)) return;
    for (const [site, settings] of Object.entries(saved)) sites[site] = normalizeSiteSettings(settings);
  }).catch(() => undefined);

  async function saveSites(): Promise<void> {
    try { await chrome.storage.local.set({ [SITES_KEY]: sites }); } catch { /* Keep working from memory. */ }
  }

  async function updateSite(site: string, change: (settings: SiteSettings) => SiteSettings): Promise<void> {
    if (!sites[site]) return;
    sites[site] = change(sites[site]);
    await saveSites();
  }

  function configFor(tabId: number, settings: SiteSettings): AutoDubConfig {
    return { tabId, volume: settings.volume, offsetMs: settings.offsetMs, muteOriginal: settings.muteOriginal, autoOffset: settings.autoOffset };
  }

  /** Attach Auto Dub to a tab on an enabled site. */
  async function arm(tabId: number, site: string): Promise<void> {
    if (config?.tabId === tabId && armedSite === site) return;
    await disable();
    config = configFor(tabId, sites[site]);
    armedSite = site;
    await status("waiting", "Checking this tab…");
    await inspect();
  }

  /** A session in progress keeps Auto Dub on its tab instead of following the user to another one. */
  function busy(): boolean {
    return Boolean(job) || Boolean(ownedPair && hooks.getState()?.pairId === ownedPair);
  }

  /** Follow the user: attach to their current tab when its site has Auto Dub on. */
  async function follow(tab: chrome.tabs.Tab): Promise<void> {
    await sitesLoaded;
    await restored;
    if (tab.id === undefined) return;
    const site = siteKey(tab.url);
    if (config?.tabId === tab.id) {
      if (!site || !sites[site]) await disable(); // The armed tab left the site.
      else if (site !== armedSite) await arm(tab.id, site);
      return;
    }
    if (!site || !sites[site] || busy()) return;
    await arm(tab.id, site);
  }

  async function followActiveTab(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab) await follow(tab);
    } catch { /* No window yet. */ }
  }

  const restored = chrome.storage.session.get(KEY).then(stored => {
    const saved = (stored as Record<string, unknown>)[KEY];
    const restoredConfig = isRecord(saved) ? normalizeConfig(saved.config) : null;
    if (!isRecord(saved) || !restoredConfig) return;
    config = restoredConfig;
    ownedPair = typeof saved.pairId === "string" ? saved.pairId : null;
    resolved = validResult(saved.resolved) ? saved.resolved : null;
    recoveredPage = typeof saved.recoveredPage === "string" ? saved.recoveredPage : "";
    windowOnlyPage = typeof saved.windowOnlyPage === "string" ? saved.windowOnlyPage : "";
    armedSite = typeof saved.site === "string" ? saved.site : null;
    state = { tabId: config.tabId, ...(armedSite ? { site: armedSite } : {}), status: "waiting", reason: "Checking this tab…" };
  }).catch(() => undefined);

  async function publish(): Promise<void> {
    await chrome.storage.session.set({ [KEY]: config ? { config, site: armedSite, pairId: ownedPair, resolved, recoveredPage, windowOnlyPage } : null });
    try { await chrome.runtime.sendMessage({ type: "AUTO_DUB_UPDATE", autoDub: state }); }
    catch { /* A closed popup does not stop Auto Dub. */ }
  }

  async function status(value: AutoDubState["status"], reason: string): Promise<void> {
    if (!config) return;
    if (state?.status === value && state.reason === reason) return;
    state = { tabId: config.tabId, ...(armedSite ? { site: armedSite } : {}), status: value, reason };
    await publish();
  }

  function cancelJob(): void {
    job?.controller.abort();
    job = null;
  }

  /**
   * Stop the owned sync pair. "close" also closes the hosted page; "next"
   * forgets this episode's Dub but leaves the container open for the next
   * episode to reuse (its video is muted once detached); "keep" keeps both.
   */
  async function stopOwned(mode: "close" | "next" | "keep" = "close"): Promise<void> {
    if (ownedPair && hooks.getState()?.pairId === ownedPair) await hooks.stop();
    ownedPair = null;
    clearWatchdog();
    if (mode === "keep") return;
    cancelJob();
    resolved = null;
    // Close even when no lookup finished: a cancelled lookup's page may be open.
    if (mode === "close") await hooks.closeHost();
  }

  function clearWatchdog(): void {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  }

  /**
   * True when the Dub should be audible now but isn't: Sub is playing and the
   * Dub's target is inside its media. A lead-in (negative target), a paused Sub
   * or a target past the Dub's end is intentional waiting, not a failure.
   */
  function dubOverdue(current: SyncState): boolean {
    if (!current.timeline.playing || current.primary.status !== "playing" ||
        current.secondary.status === "playing") return false;
    const target = current.timeline.positionMs + current.offsetMs;
    const duration = current.secondary.snapshot?.durationMs ?? null;
    return target >= 0 && (duration === null || target < duration);
  }

  /**
   * A Dub that never starts, without an error event, still needs recovery.
   * Derived from state on every commit (so it survives worker restarts); the
   * deadline restarts whenever waiting stops being overdue.
   */
  function updateWatchdog(current: SyncState): void {
    if (!dubOverdue(current)) { clearWatchdog(); return; }
    if (watchdog) return;
    const pair = current.pairId;
    watchdog = setTimeout(() => {
      watchdog = null;
      void hooks.enqueue(async () => {
        const latest = hooks.getState();
        if (ownedPair !== pair || latest?.pairId !== pair || !dubOverdue(latest)) return;
        await recover("The Dub never started playing.");
      }).catch(() => undefined);
    }, DUB_START_TIMEOUT_MS);
  }

  async function startLookup(pageUrl: string, provider: string | null, primaryDurationMs: number | null): Promise<void> {
    if (job?.pageUrl === pageUrl) return;
    lastPrimaryDurationMs = primaryDurationMs;
    cancelJob();
    const current = { pageUrl, controller: new AbortController() };
    job = current;
    await status("finding", "Loading a hidden copy of this episode…");
    const site = armedSite;
    const memory = site && sites[site] ? sites[site] : null;
    const attempt = (container: HostContainer) => hooks.findDub({
      pageUrl,
      preferredProvider: provider,
      rememberedServer: memory?.dubServer ?? null,
      avoidServers: memory ? recentlyFailed(memory, Date.now()) : [],
      onServerFailed: label => {
        if (site) void hooks.enqueue(() => updateSite(site, settings => rememberFailedServer(settings, label, Date.now()))).catch(() => undefined);
      },
      primaryDurationMs,
      container,
      signal: current.controller.signal,
      onSelected: () => { hostedSelectedAt = Date.now(); },
      onProgress: message => {
        void hooks.enqueue(async () => {
          if (job === current) await status("finding", message);
        }).catch(() => undefined);
      },
    });

    const windowOnly = windowOnlyPage === pageUrl;
    void (async () => {
      let result: HostedDubResult;
      try {
        // Keep the real cause (a blocked play(), a media error…) for the popup.
        if (windowOnly) throw new Error(`The hidden page could not play this Dub (${windowOnlyReason || "no reason given"}).`);
        result = await attempt("offscreen");
      } catch (hiddenError) {
        if (current.controller.signal.aborted) return;
        try {
          result = { ...await attempt("window"), fallbackReason: errorMessage(hiddenError, "unknown reason") };
        } catch (windowError) {
          if (current.controller.signal.aborted) return;
          await hooks.enqueue(async () => {
            if (job !== current) return;
            job = null;
            failedPage = pageUrl;
            await hooks.closeHost();
            await status("error", errorMessage(windowError, errorMessage(hiddenError, "Could not load Dub for this episode.")));
          });
          return;
        }
      }
      await hooks.enqueue(async () => {
        if (job !== current) return; // A newer episode or Disable owns the host now.
        job = null;
        resolved = result;
        await publish();
        await reconcile();
      });
    })().catch(() => undefined);
  }

  async function reconcile(): Promise<void> {
    await restored;
    if (!config || !detection) return;
    const token = epoch;
    const current = hooks.getState();

    if (ownedPair && current?.pairId === ownedPair) {
      if (watchingSub(detection) && resolved?.pageUrl === detection.pageUrl) {
        if (!["error", "degraded"].includes(current.status)) await status("active", activeReason(resolved, detection));
        return;
      }
      await stopOwned();
    } else if (ownedPair) {
      ownedPair = null; // The pair ended elsewhere (for example the visible video was replaced).
    }

    if (leakedPage === detection.pageUrl) {
      await stopOwned();
      await status("error", LEAK_REASON);
      return;
    }
    if (detection.language === "dub") {
      await stopOwned();
      await status("waiting", "Dub is selected on this page. Auto Dub resumes when you switch to Sub.");
      return;
    }
    if (!watchingSub(detection)) {
      await stopOwned();
      await status("unsupported", detection.reason);
      return;
    }
    if (!detection.available.includes("dub")) {
      await stopOwned();
      await status("unsupported", "This episode has no Dub option.");
      return;
    }
    if (current) {
      await status("waiting", "Stop the current sync session to use Auto Dub.");
      return;
    }
    if (resolved && resolved.pageUrl !== detection.pageUrl) await stopOwned();
    if (failedPage === detection.pageUrl) return;

    const probe = await hooks.probe(config.tabId);
    if (epoch !== token || !config) return;
    if (!probe.ok) { await status("error", probe.error ?? "Could not inspect the visible player."); return; }
    if (probe.videos.length !== 1) {
      await status(probe.videos.length ? "ambiguous" : "waiting", probe.videos.length
        ? "Multiple videos found. Use manual background audio to choose one."
        : "Waiting for a video in this tab.");
      if (!probe.videos.length) recheckSoon();
      return;
    }
    const video = probe.videos[0];
    if (!video.source || video.readyState < 1) {
      await status("waiting", "Waiting for the video to load.");
      recheckSoon();
      return;
    }
    videoRechecks = 0;

    if (!resolved) {
      await startLookup(detection.pageUrl, detection.provider, video.durationMs);
      return;
    }

    const primary: VideoEndpoint = { tabId: config.tabId, videoId: video.id, frameId: video.frameId, documentId: video.documentId };
    const result = await hooks.startHosted({
      primary,
      secondary: resolved.endpoint,
      pageUrl: resolved.pageUrl,
      provider: resolved.provider,
      container: resolved.container,
      volume: config.volume,
      offsetMs: config.offsetMs,
      muteOriginal: config.muteOriginal,
      autoOffset: config.autoOffset,
    });
    if (epoch !== token || !config) {
      if (result.ok && result.state?.pairId) { ownedPair = result.state.pairId; await stopOwned(); }
      return;
    }
    if (result.ok && result.state?.pairId) {
      ownedPair = result.state.pairId;
      updateWatchdog(result.state);
      await status("active", activeReason(resolved, detection));
      return;
    }
    await recover(result.error ?? "Dub audio could not start.");
  }

  /**
   * The Dub's <video> disappeared. Players often rebuild it in place, so look
   * for the new one in the same container before anything heavier.
   */
  async function reconnect(reason: string): Promise<void> {
    if (!config || !detection || !resolved) return;
    const pageUrl = detection.pageUrl;
    if (rebinds.page !== pageUrl) rebinds = { page: pageUrl, count: 0 };
    if (rebinds.count >= MAX_REBINDS) { await recover(reason); return; }
    rebinds.count += 1;
    const previous = resolved;
    const lostAt = Date.now();
    await stopOwned("keep");
    await status("finding", "The Dub player restarted; reconnecting…");
    void (async () => {
      const replacement = await hooks.findReplacement(previous, lostAt, lastPrimaryDurationMs).catch(() => null);
      await hooks.enqueue(async () => {
        if (resolved !== previous || !config) return; // Disabled, or a newer episode took over.
        if (!replacement) { await recover(reason); return; }
        resolved = replacement;
        await publish();
        await reconcile();
      });
    })().catch(() => undefined);
  }

  /** The hosted Dub failed. Reload it once per episode, then report the failure. */
  async function recover(reason: string): Promise<void> {
    if (!config || !detection) return;
    const pageUrl = detection.pageUrl;
    const failedContainer = resolved?.container;
    await stopOwned();
    if (failedContainer === "offscreen" && windowOnlyPage !== pageUrl) {
      // Found in the hidden document but would not play there: the window is the fallback.
      windowOnlyPage = pageUrl;
      windowOnlyReason = reason;
      await publish();
      await status("finding", "The hidden page couldn't play this Dub; trying a minimized Dub window…");
      await reconcile();
      return;
    }
    if (recoveredPage === pageUrl) {
      failedPage = pageUrl;
      await status("error", reason);
      return;
    }
    recoveredPage = pageUrl;
    await status("finding", "Dub stopped playing; reloading it…");
    await reconcile();
  }

  function accept(tabId: number, next: LanguageDetection): void {
    if (!config || config.tabId !== tabId) return;
    if (JSON.stringify(detection) === JSON.stringify(next)) return;
    if (detection?.language === "sub" && next.language === "dub" && detection.pageUrl === next.pageUrl &&
        hostedSelectedAt && Date.now() - hostedSelectedAt < LEAK_WINDOW_MS) {
      // Close the copy at once so it can't keep re-asserting Dub.
      leakedPage = next.pageUrl;
      failedPage = next.pageUrl;
    }
    if (detection && detection.pageUrl !== next.pageUrl) {
      failedPage = "";
      recoveredPage = "";
      windowOnlyPage = "";
      leakedPage = "";
    }
    detection = next;
    epoch += 1;
    videoRechecks = 0;
    void hooks.enqueue(reconcile).catch(() => undefined);
  }
  onLanguageDetection(accept);

  async function disable(): Promise<void> {
    await restored;
    epoch += 1;
    await stopOwned();
    failedPage = "";
    recoveredPage = "";
    windowOnlyPage = "";
    leakedPage = "";
    hostedSelectedAt = 0;
    config = null; state = null; detection = null; armedSite = null; rememberedFor = null;
    await publish();
  }

  async function inspect(): Promise<void> {
    if (!config) return;
    try { accept(config.tabId, await inspectLanguage(config.tabId)); }
    catch (error) {
      await stopOwned();
      await status("error", errorMessage(error, "Could not inspect this tab."));
    }
  }

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isRecord(message)) return false;
    if (message.type === "AUTO_DUB_MEDIA_CHANGED") {
      if (sender.id === chrome.runtime.id && sender.tab?.id === config?.tabId) {
        void hooks.enqueue(reconcile).catch(() => undefined);
      }
      return false;
    }
    if (message.type !== "GET_AUTO_DUB" && message.type !== "SET_AUTO_DUB_SITE") return false;
    if (!isExtensionUiSender(sender)) return false;
    const site = typeof message.site === "string" && /^[a-z0-9.-]{1,253}$/i.test(message.site) ? message.site.toLowerCase() : null;
    if (message.type === "SET_AUTO_DUB_SITE" && (!site || typeof message.enabled !== "boolean")) {
      sendResponse({ ok: false, error: "Invalid Auto Dub site." });
      return false;
    }
    if (message.type === "SET_AUTO_DUB_SITE") epoch += 1;
    void hooks.enqueue(async () => {
      await sitesLoaded;
      await restored;
      if (message.type === "SET_AUTO_DUB_SITE" && site) {
        if (message.enabled) {
          const settings = isRecord(message.settings) ? message.settings : {};
          sites[site] = normalizeSiteSettings({ ...DEFAULT_SITE_SETTINGS, ...sites[site], ...settings });
          await saveSites();
          const tabId = Number.isInteger(message.tabId) ? message.tabId as number : null;
          if (tabId !== null) {
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (tab && siteKey(tab.url) === site) await arm(tabId, site);
          }
        } else {
          delete sites[site];
          await saveSites();
          if (armedSite === site) await disable();
        }
      }
      return { ok: true, autoDub: state, sites: Object.keys(sites),
        ...(site ? { siteSettings: sites[site] ?? DEFAULT_SITE_SETTINGS } : {}) };
    }).then(sendResponse, error => sendResponse({ ok: false, error: String(error) }));
    return true;
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void hooks.enqueue(async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab) await follow(tab);
    }).catch(() => undefined);
  });

  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    // A page on an enabled site finished loading in the user's current tab.
    if (config?.tabId !== tabId && change.status === "complete" && tab.active) {
      void hooks.enqueue(() => follow(tab)).catch(() => undefined);
    }
    if (config?.tabId === tabId && change.url !== undefined && (!siteKey(change.url) || !sites[siteKey(change.url)!])) {
      epoch += 1;
      void hooks.enqueue(() => follow({ ...tab, url: change.url })).catch(() => undefined);
      return;
    }
    if (config?.tabId !== tabId || change.url === undefined) return;
    // A new URL is a new episode (or site). Its detection arrives separately.
    epoch += 1;
    detection = null;
    failedPage = "";
    recoveredPage = "";
    windowOnlyPage = "";
    leakedPage = "";
    void hooks.enqueue(async () => {
      await stopOwned("next");
      await status("waiting", "Page changed; checking for Sub/Dub…");
    }).catch(() => undefined);
  });

  chrome.tabs.onRemoved.addListener(tabId => {
    if (config?.tabId !== tabId) return;
    epoch += 1;
    void hooks.enqueue(async () => { await disable(); await followActiveTab(); }).catch(() => undefined);
  });

  void hooks.enqueue(async () => {
    await restored;
    await sitesLoaded;
    if (!resolved) await hooks.closeHost(); // A lookup cut short by a worker restart restarts below.
    if (config) await inspect();
    else await followActiveTab(); // After a browser restart: pick up an enabled site that's open.
  }).catch(() => undefined);

  return {
    disable,
    enabled: () => config !== null,
    /** Called by the worker after every committed sync state change. */
    async syncChanged(current: SyncState | null): Promise<void> {
      if (!config || !ownedPair) return;
      if (!current || current.pairId !== ownedPair) {
        // The pair ended (the visible video was replaced, for example). Keep the
        // hosted page: the next reconcile can relink it without reloading.
        ownedPair = null;
        await publish();
        void hooks.enqueue(reconcile).catch(() => undefined);
        return;
      }
      const dubFailed = current.secondary.status === "lost" || current.secondary.status === "play-failed";
      updateWatchdog(current);
      if (dubFailed) {
        const reason = current.message ?? "Dub audio stopped.";
        const pair = current.pairId;
        // commitState awaits this hook inside the worker queue; recover on the next turn.
        const lost = current.secondary.status === "lost";
        void hooks.enqueue(async () => {
          if (ownedPair === pair) await (lost ? reconnect(reason) : recover(reason));
        }).catch(() => undefined);
        return;
      }
      if (resolved && armedSite && rememberedFor !== resolved && current.secondary.status === "playing") {
        rememberedFor = resolved;
        const site = armedSite, provider = resolved.provider;
        void hooks.enqueue(() => updateSite(site, settings => rememberWorkingServer(settings, provider))).catch(() => undefined);
      }
      if (["error", "degraded"].includes(current.status)) {
        await status("error", current.message ?? "Dub playback needs attention.");
      } else if (resolved && state?.status !== "active") {
        await status("active", activeReason(resolved, detection));
      }
    },
    /** Scan again: forget failures for this tab and try again. */
    refresh(tabId: number) {
      if (config?.tabId !== tabId) return;
      void hooks.enqueue(async () => {
        if (config?.tabId !== tabId) return;
        failedPage = "";
        recoveredPage = "";
        windowOnlyPage = "";
        leakedPage = "";
        hostedSelectedAt = 0;
        if (!detection) await inspect();
        await reconcile();
      }).catch(() => undefined);
    },
    async updatePreferences(update: Partial<Pick<AutoDubConfig, "muteOriginal" | "volume" | "autoOffset" | "offsetMs">>) {
      await restored;
      if (config) { Object.assign(config, update); await publish(); }
      if (armedSite) await updateSite(armedSite, settings => ({ ...settings, ...update }));
    },
  };
}
