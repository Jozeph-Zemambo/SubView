import type { AutoDubConfig, AutoDubState } from "../shared/auto-dub";
import type { LanguageDetection } from "../shared/language-detection";
import type {
  BackgroundResponse,
  HostContainer,
  ProbeTabResponse,
  StartHostedDubConfig,
  SyncState,
  VideoDescriptor,
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
/** Outlives Disable: turning a site off and on again is one of the ways a second copy gets opened. */
const LAST_COPY_KEY = "autoDubLastCopy";
/** When SubView last reloaded a tab. Saved: the worker sleeps after half a minute idle, and a guard that forgets is no guard. */
const LAST_RELOAD_KEY = "autoDubLastReload";
/** Sites with Auto Dub on, kept across browser restarts. */
const SITES_KEY = "autoDubSites";
const DUB_START_TIMEOUT_MS = 15_000;
/** The visible tab turning to Dub this soon after the hidden copy chose Dub means the setting leaked. */
const LEAK_WINDOW_MS = 20_000;
const ALREADY_DUB_REASON = "This page is already playing audio in your language. Auto Dub starts when you switch the audio back to the original language.";
const RELOAD_OFFER_REASON = "Reload your tab and Dub starts right away.";
const RELOADING_REASON = "Reloading this tab so Dub can start right away…";
const RESTORING_REASON = "Putting your player back the way it was…";
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
  /** Pause every video in the open hidden copy; it stays loaded. */
  idleHost(): Promise<void>;
  /** Show the reload offer on the visible tab; `until` is when the wait ends by itself. */
  offerReload(tabId: number, until: number): Promise<void>;
  withdrawReloadOffer(tabId: number): Promise<void>;
  reloadTab(tabId: number): Promise<void>;
  /** Where the viewer is and what their player is set to; null when the page didn't say. */
  capturePlayer(tabId: number, video: VideoDescriptor): Promise<unknown>;
  /** Put back what capturePlayer answered, in the reloaded page's player. */
  restorePlayer(tabId: number, video: VideoDescriptor, state: unknown): Promise<void>;
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
  // An audio menu is read (and proved) in the hidden copy, so nothing was guessed.
  const unclear = detection?.language === "unknown" && detection.stateUnclear && !detection.audioControl ? UNCLEAR_NOTE : "";
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
  /** The visible video is copy-protected: its service counts streams (see COPY_COOLDOWN_MS). */
  let lastPrimaryProtected = false;
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
  /** Episode whose hidden copy opened already on the viewer's language (see AlreadyDubError). */
  let alreadyDubPage = "";
  /**
   * The hidden copy that opened on the viewer's language is kept open, paused,
   * for this episode. A service goes on counting a player for a minute or two
   * after it closes. Closing this copy and opening another when the viewer
   * switches their tab to the original language would make three players in
   * the service's eyes, and on a two-stream plan the one it stops is the
   * oldest: the viewer's own tab. Kept, the same copy becomes the Dub with
   * nothing new opened.
   */
  let standby: { page: string; until: number } | null = null;
  const STANDBY_MS = 10 * 60_000;
  let standbyTimer: ReturnType<typeof setTimeout> | null = null;
  function armStandbyTimer(): void {
    if (standbyTimer) clearTimeout(standbyTimer);
    standbyTimer = null;
    if (!standby) return;
    standbyTimer = setTimeout(() => {
      standbyTimer = null;
      void hooks.enqueue(expireStandby).catch(() => undefined);
    }, Math.max(0, standby.until - Date.now()));
  }
  /** Forget the kept copy. The caller decides what happens to the container. */
  function dropStandby(): void {
    standby = null;
    if (standbyTimer) clearTimeout(standbyTimer);
    standbyTimer = null;
  }
  async function expireStandby(): Promise<void> {
    if (!standby || Date.now() < standby.until) return;
    dropStandby();
    if (!job && !resolved) await closeCopy();
    await publish();
  }
  /**
   * Services that count streams go on counting a player for a while after it
   * closes, and when one too many starts they stop the oldest: the viewer's
   * own tab, if it has been playing since before the copy that just closed. So
   * a second hidden copy for the same playback waits until the first has been
   * forgotten. A new episode or a reloaded tab is a new playback, younger than
   * the old copy, and needs no wait. Only copy-protected video is treated this
   * way: that is the mark of a service that counts streams at all.
   */
  // Measured on a two-stream service (2026-11-21): a copy opened 15 s or 45 s
  // after the last one closed got the viewer's tab stopped about 20 s later;
  // 90 s after, it did not.
  const COPY_COOLDOWN_MS = 100_000;
  /** The copy that is open, and the visible playback it was opened for. */
  let openCopy: { page: string; playback: string } | null = null;
  let lastCopyClosed: { at: number; page: string; playback: string } | null = null;
  async function closeCopy(): Promise<void> {
    if (openCopy) {
      lastCopyClosed = { at: Date.now(), ...openCopy };
      openCopy = null;
      await chrome.storage.session.set({ [LAST_COPY_KEY]: lastCopyClosed }).catch(() => undefined);
    }
    await hooks.closeHost();
  }
  function playbackOf(video: VideoDescriptor): string {
    return `${video.documentId ?? video.frameId ?? ""}:${video.id}`;
  }
  /** How long a new copy for this playback must still wait; 0 when it need not. */
  function copyCooldownLeft(pageUrl: string, video: VideoDescriptor): number {
    if (video.protected !== true || !lastCopyClosed) return 0;
    if (lastCopyClosed.page !== pageUrl || lastCopyClosed.playback !== playbackOf(video)) return 0;
    return Math.max(0, lastCopyClosed.at + COPY_COOLDOWN_MS - Date.now());
  }
  /**
   * The wait above is for the same playback. A reloaded tab is a new one, so a
   * reload ends the wait at once. SubView offers it (in the popup and on the
   * page), and does it by itself on sites where the viewer allowed that
   * (`autoReload`). Never unasked otherwise: a reload drops fullscreen, and
   * some players come back on different audio and subtitle settings.
   */
  let offered: { tabId: number; until: number } | null = null;
  /** The reconcile in progress found the wait still on. */
  let offerLive = false;
  /** The closed copy (its closing time) the tab was already reloaded for: one reload per wait. */
  let reloadedFor = 0;
  /** Until then the reload is still landing, and the old page's video proves nothing. */
  let reloadGraceUntil = 0;
  const RELOAD_GRACE_MS = 10_000;
  async function withdrawOffer(): Promise<void> {
    if (!offered) return;
    const { tabId } = offered;
    offered = null;
    await hooks.withdrawReloadOffer(tabId);
  }
  /**
   * A reload SubView asked for must not cost the viewer anything: players
   * often come back from one somewhere else in the episode, paused, or on
   * their default audio and subtitles. So the position, whether it was
   * playing and what the player's menus had chosen are noted before the
   * reload and put back in the new page's player.
   */
  let resume: { page: string; playback: string; until: number; state: unknown } | null = null;
  const RESUME_WINDOW_MS = 60_000;
  /**
   * The put-back is pressing the reloaded player's menus. What those menus
   * show on the way (the player's default, before the viewer's choice is back)
   * is not the viewer's doing, so nothing is decided from it until it is done.
   */
  let restoring = false;
  /**
   * An automatic reload is never repeated soon after any reload SubView made.
   * Whatever goes wrong afterwards, the worst case is then a card asking, not
   * a tab reloading again and again (which a service can take for abuse).
   */
  let lastReloadAt = 0;
  const AUTO_RELOAD_GAP_MS = 5 * 60_000;
  async function reloadForDub(known?: VideoDescriptor): Promise<void> {
    if (!config || !lastCopyClosed) return;
    const tabId = config.tabId;
    reloadedFor = lastCopyClosed.at;
    lastReloadAt = Date.now();
    await chrome.storage.session.set({ [LAST_RELOAD_KEY]: lastReloadAt }).catch(() => undefined);
    reloadGraceUntil = Date.now() + RELOAD_GRACE_MS;
    await withdrawOffer();
    await status("waiting", RELOADING_REASON);
    resume = null;
    let video = known ?? null;
    if (!video) {
      const probe = await hooks.probe(tabId).catch(() => null);
      video = probe?.ok && probe.videos.length === 1 ? probe.videos[0] : null;
    }
    const page = detection?.pageUrl;
    if (video && page) {
      const state = await hooks.capturePlayer(tabId, video).catch(() => null);
      if (state) resume = { page, playback: playbackOf(video), until: Date.now() + RESUME_WINDOW_MS, state };
    }
    if (config?.tabId !== tabId) { resume = null; return; } // Turned off while the page was being read.
    reloadGraceUntil = Date.now() + RELOAD_GRACE_MS;
    await hooks.reloadTab(tabId).catch(() => undefined);
    recheckSoon();
  }
  /** Once the reloaded page has its video, hand it what was noted before the reload. */
  async function resumeAfterReload(): Promise<void> {
    if (!resume || !config || !detection) return;
    if (Date.now() > resume.until || resume.page !== detection.pageUrl) { resume = null; return; }
    const tabId = config.tabId;
    const probe = await hooks.probe(tabId).catch(() => null);
    if (!resume || config?.tabId !== tabId) return;
    const video = probe?.ok && probe.videos.length === 1 ? probe.videos[0] : null;
    // Still the old page, or the new one has no player yet: look again shortly.
    if (!video || playbackOf(video) === resume.playback) { recheckSoon(); return; }
    const { state } = resume;
    resume = null;
    restoring = true;
    void hooks.restorePlayer(tabId, video, state).catch(() => undefined)
      .then(() => hooks.enqueue(async () => { restoring = false; await reconcile(); }))
      .catch(() => undefined);
  }
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

  /** Auto Dub is on for this site (a site turned off keeps its settings, but is off). */
  function isSiteEnabled(site: string | null): boolean {
    return Boolean(site && sites[site]?.enabled === true);
  }

  /** Sites with Auto Dub on, for the popup. */
  function enabledSiteNames(): string[] {
    return Object.keys(sites).filter(name => sites[name]?.enabled === true);
  }

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
      if (!isSiteEnabled(site)) await disable(); // The armed tab left the site.
      else if (site !== armedSite) await arm(tab.id, site!);
      return;
    }
    if (!site || !isSiteEnabled(site) || busy()) return;
    await arm(tab.id, site);
  }

  async function followActiveTab(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab) await follow(tab);
    } catch { /* No window yet. */ }
  }

  const restored = chrome.storage.session.get([KEY, LAST_COPY_KEY, LAST_RELOAD_KEY]).then(stored => {
    const saved = (stored as Record<string, unknown>)[KEY];
    const closed = (stored as Record<string, unknown>)[LAST_COPY_KEY];
    const reloadedAt = (stored as Record<string, unknown>)[LAST_RELOAD_KEY];
    if (typeof reloadedAt === "number" && Number.isFinite(reloadedAt)) lastReloadAt = reloadedAt;
    if (isRecord(closed) && typeof closed.at === "number" && typeof closed.page === "string" && typeof closed.playback === "string") {
      lastCopyClosed = { at: closed.at, page: closed.page, playback: closed.playback };
    }
    const restoredConfig = isRecord(saved) ? normalizeConfig(saved.config) : null;
    if (!isRecord(saved) || !restoredConfig) return;
    config = restoredConfig;
    ownedPair = typeof saved.pairId === "string" ? saved.pairId : null;
    resolved = validResult(saved.resolved) ? saved.resolved : null;
    recoveredPage = typeof saved.recoveredPage === "string" ? saved.recoveredPage : "";
    windowOnlyPage = typeof saved.windowOnlyPage === "string" ? saved.windowOnlyPage : "";
    armedSite = typeof saved.site === "string" ? saved.site : null;
    standby = isRecord(saved.standby) && typeof saved.standby.page === "string" && typeof saved.standby.until === "number"
      ? { page: saved.standby.page, until: saved.standby.until } : null;
    alreadyDubPage = typeof saved.alreadyDubPage === "string" ? saved.alreadyDubPage : "";
    openCopy = isRecord(saved.openCopy) && typeof saved.openCopy.page === "string" && typeof saved.openCopy.playback === "string"
      ? { page: saved.openCopy.page, playback: saved.openCopy.playback } : null;
    state = { tabId: config.tabId, ...(armedSite ? { site: armedSite } : {}), status: "waiting", reason: "Checking this tab…" };
  }).catch(() => undefined);

  async function publish(): Promise<void> {
    await chrome.storage.session.set({ [KEY]: config ? { config, site: armedSite, pairId: ownedPair, resolved, recoveredPage, windowOnlyPage, standby, openCopy, alreadyDubPage } : null });
    try { await chrome.runtime.sendMessage({ type: "AUTO_DUB_UPDATE", autoDub: state }); }
    catch { /* A closed popup does not stop Auto Dub. */ }
  }

  async function status(value: AutoDubState["status"], reason: string, reloadOffer = false): Promise<void> {
    if (!config) return;
    if (state?.status === value && state.reason === reason && (state.reloadOffer === true) === reloadOffer) return;
    state = { tabId: config.tabId, ...(armedSite ? { site: armedSite } : {}), status: value, reason, ...(reloadOffer ? { reloadOffer: true as const } : {}) };
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
    dropStandby();
    // Close even when no lookup finished: a cancelled lookup's page may be open.
    if (mode === "close") await closeCopy();
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

  async function startLookup(pageUrl: string, provider: string | null, video: VideoDescriptor): Promise<void> {
    if (job?.pageUrl === pageUrl) return;
    const primaryDurationMs = video.durationMs;
    // On a service that counts streams, a second container is one more stream.
    const countsStreams = video.protected === true;
    lastPrimaryDurationMs = primaryDurationMs;
    lastPrimaryProtected = countsStreams;
    cancelJob();
    const current = { pageUrl, controller: new AbortController() };
    job = current;
    await status("finding", "Loading a hidden copy of this episode…");
    const site = armedSite;
    const memory = site && sites[site] ? sites[site] : null;
    // Only a menu that was actually read counts; an unread one says nothing about this tab.
    const visibleOnOriginal = detection?.audioControl === true && detection.language === "sub";
    const lenientKnown = memory?.lenientFrame === true;
    // A copy kept from this episode's earlier lookup is used as it is, once.
    const reuseOpenCopy = standby?.page === pageUrl;
    dropStandby();
    if (!reuseOpenCopy || !openCopy) openCopy = { page: pageUrl, playback: playbackOf(video) };
    await publish();
    const attempt = (container: HostContainer, lenientFrame = false, reuse = false, startMessage?: string) => hooks.findDub({
      pageUrl,
      preferredProvider: provider,
      rememberedServer: memory?.dubServer ?? null,
      avoidServers: memory ? recentlyFailed(memory, Date.now()) : [],
      onServerFailed: label => {
        if (site) void hooks.enqueue(() => updateSite(site, settings => rememberFailedServer(settings, label, Date.now()))).catch(() => undefined);
      },
      primaryDurationMs,
      container,
      lenientFrame,
      reuseOpenCopy: reuse,
      ...(startMessage ? { startMessage } : {}),
      visibleOnOriginal,
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
        try {
          result = await attempt("offscreen", lenientKnown, reuseOpenCopy);
        } catch (plainError) {
          // The copy blanked itself: the mark of a page that refuses to run
          // inside another page. Retry in the frame such pages tolerate, and
          // remember it so later episodes skip the failed first try.
          if (lenientKnown || current.controller.signal.aborted || !isRecord(plainError) || plainError.name !== "HostedPageGoneError") throw plainError;
          const learn = () => {
            if (site) void hooks.enqueue(() => updateSite(site, settings => ({ ...settings, lenientFrame: true }))).catch(() => undefined);
          };
          try {
            result = await attempt("offscreen", true, false, "This page resists hidden copies; trying another way…");
            learn();
          } catch (lenientError) {
            // The page ran far enough to say it is already on the viewer's language: the frame works.
            if (isRecord(lenientError) && lenientError.name === "AlreadyDubError") learn();
            throw lenientError;
          }
        }
      } catch (hiddenError) {
        if (current.controller.signal.aborted) return;
        if (isRecord(hiddenError) && hiddenError.name === "AlreadyDubError") {
          // Not a failure, and a second container would only find the same thing.
          // The copy stays open, paused (see `standby`).
          await hooks.enqueue(async () => {
            if (job !== current) return;
            job = null;
            alreadyDubPage = pageUrl;
            standby = { page: pageUrl, until: Date.now() + STANDBY_MS };
            armStandbyTimer();
            await hooks.idleHost();
            await publish();
            // The viewer's tab may have turned to the original language while this
            // lookup ran (SubView's own put-back after a reload does exactly that).
            // Then the kept copy is used straight away; otherwise this says "waiting".
            await reconcile();
          });
          return;
        }
        if (isRecord(hiddenError) && hiddenError.name === "HostedPageNoticeError") {
          // The page itself refused (a stream limit, a region block…). A window
          // would hear the same, and would count as one more stream.
          await hooks.enqueue(async () => {
            if (job !== current) return;
            job = null;
            failedPage = pageUrl;
            await closeCopy();
            await status("error", errorMessage(hiddenError, "The page in the hidden copy refused to play."));
          });
          return;
        }
        try {
          // The window is a second player. Where streams are counted, the copy
          // that just failed still counts too, and the viewer's tab is the oldest.
          if (countsStreams) throw hiddenError;
          result = { ...await attempt("window"), fallbackReason: errorMessage(hiddenError, "unknown reason") };
        } catch (windowError) {
          if (current.controller.signal.aborted) return;
          await hooks.enqueue(async () => {
            if (job !== current) return;
            job = null;
            failedPage = pageUrl;
            await closeCopy();
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
    offerLive = false;
    await reconcileNow();
    if (!offerLive) await withdrawOffer();
  }

  async function reconcileNow(): Promise<void> {
    await restored;
    if (!config || !detection) return;
    const token = epoch;
    const current = hooks.getState();
    await expireStandby();
    await resumeAfterReload();
    if (!config || !detection) return;
    // Between SubView's reload and the end of its put-back the page is not in a
    // state the viewer chose. Both end by themselves and reconcile again.
    if (resume || restoring) {
      await status("waiting", restoring ? RESTORING_REASON : RELOADING_REASON);
      return;
    }

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
      // Reading the menu is the first half of switching it: the kept copy stays for the second half.
      // So does a copy that is still loading: it ends up kept, where closing it
      // now would make the viewer's switch wait out a closed player.
      const loading = detection.audioControl === true && job?.pageUrl === detection.pageUrl;
      if (!resolved && (loading || (standby?.page === detection.pageUrl && !job))) { await status("waiting", ALREADY_DUB_REASON); return; }
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
    if (alreadyDubPage === detection.pageUrl) {
      // Only the page itself saying Sub (its audio menu read as the original language) reopens it.
      if (detection.language !== "sub") { await status("waiting", ALREADY_DUB_REASON); return; }
      alreadyDubPage = "";
    }

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
      const wait = standby?.page === detection.pageUrl ? 0 : copyCooldownLeft(detection.pageUrl, video);
      if (wait > 0 && lastCopyClosed) {
        const closedAt = lastCopyClosed.at;
        if (reloadedFor === closedAt && Date.now() < reloadGraceUntil) {
          await status("waiting", RELOADING_REASON);
          recheckSoon();
          return;
        }
        if (reloadedFor !== closedAt && armedSite && sites[armedSite]?.autoReload && Date.now() - lastReloadAt > AUTO_RELOAD_GAP_MS) {
          await reloadForDub(video);
          return;
        }
        offerLive = true;
        const until = closedAt + COPY_COOLDOWN_MS;
        if (offered?.tabId !== config.tabId || offered.until !== until) {
          offered = { tabId: config.tabId, until };
          await hooks.offerReload(config.tabId, until);
        }
        await status("waiting", RELOAD_OFFER_REASON, true);
        recheckSoon();
        return;
      }
      await startLookup(detection.pageUrl, detection.provider, video);
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
    if (failedContainer === "offscreen" && windowOnlyPage !== pageUrl && !lastPrimaryProtected) {
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

  /**
   * Some apps change the address and put it back within a moment: a route that
   * redirects to itself, a "back" that has nowhere to go. The episode and its
   * player never left. Treating that as a new page closes the hidden copy,
   * and on a service that counts streams the copy then has to be waited out
   * for the very episode that is still playing. So an address change in a page
   * that stays loaded gets a moment to settle; one that is back where it
   * started by then never happened. A page that really went away says so
   * itself: its placeholder reading is not marked `addressOnly`, and settles
   * the question at once.
   */
  let settling: { from: string; tabId: number; timer: ReturnType<typeof setTimeout>; held: LanguageDetection | null } | null = null;
  const ADDRESS_SETTLE_MS = 400;
  /** A new address is a new episode (or site). Its detection arrives separately. */
  function pageChanged(): void {
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
  }
  /** The address has settled on `now`: a new page, unless it is the one the tab started from. */
  function settle(now: string | undefined): void {
    if (!settling) return;
    const { from, timer, held, tabId } = settling;
    clearTimeout(timer);
    settling = null;
    if (now === from) return; // A reading of some address in between is dropped with it.
    pageChanged();
    if (held && held.pageUrl === now) accept(tabId, held);
  }

  function accept(tabId: number, next: LanguageDetection): void {
    if (!config || config.tabId !== tabId) return;
    // Says nothing yet: the address may come straight back (see `settling`).
    if (next.placeholder === "address") return;
    if (settling) {
      // The page that was there is gone, or the address is back where it started: settled either way.
      if (next.placeholder === "load" || next.pageUrl === settling.from) settle(next.pageUrl);
      // A reading of the new address. Keep it until the address has stayed.
      else { settling.held = next; return; }
    }
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
      alreadyDubPage = "";
      dropStandby(); // The next episode's lookup replaces the page in the container.
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
    alreadyDubPage = "";
    hostedSelectedAt = 0;
    await withdrawOffer();
    resume = null;
    restoring = false;
    if (settling) clearTimeout(settling.timer);
    settling = null;
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
    if (message.type === "AUTO_DUB_RELOAD") {
      // From the popup's button, or from the offer on the armed tab's own page.
      const fromOffer = sender.id === chrome.runtime.id && sender.frameId === 0 &&
        sender.tab?.id !== undefined && sender.tab.id === config?.tabId;
      if (!fromOffer && !isExtensionUiSender(sender)) return false;
      void hooks.enqueue(async () => {
        if (!config || state?.reloadOffer !== true) return { ok: false, error: "Dub isn't waiting on a reload any more." };
        if (message.always === true && armedSite) await updateSite(armedSite, settings => ({ ...settings, autoReload: true }));
        await reloadForDub();
        return { ok: true, autoDub: state, ...(armedSite && sites[armedSite] ? { siteSettings: sites[armedSite] } : {}) };
      }).then(sendResponse, error => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    if (message.type === "USE_AUTO_DUB_TAB") {
      // The popup's "Use this tab": move Auto Dub here from whichever tab it's on.
      // Only attaches; the site's saved settings are left exactly as they are.
      if (!isExtensionUiSender(sender)) return false;
      const site = typeof message.site === "string" && /^[a-z0-9.-]{1,253}$/i.test(message.site) ? message.site.toLowerCase() : null;
      const tabId = Number.isInteger(message.tabId) && (message.tabId as number) >= 0 ? message.tabId as number : null;
      if (!site || tabId === null) {
        sendResponse({ ok: false, error: "Invalid Auto Dub tab." });
        return false;
      }
      epoch += 1; // Let any lookup still running for the old tab give up.
      void hooks.enqueue(async () => {
        await sitesLoaded;
        await restored;
        if (!isSiteEnabled(site)) return { ok: false, error: `Auto Dub isn't on for ${site}.` };
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab || siteKey(tab.url) !== site) return { ok: false, error: `That tab isn't on ${site} any more.` };
        await arm(tabId, site);
        return { ok: true, autoDub: state, sites: enabledSiteNames(), siteSettings: sites[site] ?? DEFAULT_SITE_SETTINGS };
      }).then(sendResponse, error => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    if (message.type !== "GET_AUTO_DUB" && message.type !== "SET_AUTO_DUB_SITE" && message.type !== "SET_AUTO_DUB_RELOAD") return false;
    if (!isExtensionUiSender(sender)) return false;
    const site = typeof message.site === "string" && /^[a-z0-9.-]{1,253}$/i.test(message.site) ? message.site.toLowerCase() : null;
    if (message.type === "SET_AUTO_DUB_SITE" && (!site || typeof message.enabled !== "boolean")) {
      sendResponse({ ok: false, error: "Invalid Auto Dub site." });
      return false;
    }
    if (message.type === "SET_AUTO_DUB_RELOAD" && (!site || typeof message.enabled !== "boolean")) {
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
          // Keep what this site already has (learned servers, frame, reload choice)
          // and lay the popup's current settings over it.
          sites[site] = normalizeSiteSettings({ ...DEFAULT_SITE_SETTINGS, ...sites[site], ...settings, enabled: true });
          await saveSites();
          const tabId = Number.isInteger(message.tabId) ? message.tabId as number : null;
          if (tabId !== null) {
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (tab && siteKey(tab.url) === site) await arm(tabId, site);
          }
        } else {
          // Off, not forgotten: the site's settings come back when it's turned on again.
          if (sites[site]) {
            sites[site] = { ...sites[site], enabled: false };
            await saveSites();
          }
          if (armedSite === site) await disable();
        }
      }
      if (message.type === "SET_AUTO_DUB_RELOAD" && site) {
        const autoReload = message.enabled === true;
        await updateSite(site, settings => ({ ...settings, autoReload }));
        // Allowed in the middle of a wait: that is the go-ahead for this one too.
        if (armedSite === site) await reconcile();
      }
      return { ok: true, autoDub: state, sites: enabledSiteNames(),
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
    if (config?.tabId === tabId && change.url !== undefined && !isSiteEnabled(siteKey(change.url))) {
      epoch += 1;
      void hooks.enqueue(() => follow({ ...tab, url: change.url })).catch(() => undefined);
      return;
    }
    if (config?.tabId !== tabId || change.url === undefined) return;
    // Nothing known about this tab's page yet: nothing to keep.
    if (!detection) {
      if (settling) clearTimeout(settling.timer);
      settling = null;
      pageChanged();
      return;
    }
    // Chrome reports the app's own router and a real page load the same way
    // here. A real load announces itself through the detection host within
    // milliseconds (see `accept`); a router change gets a moment to stay changed.
    const from = settling?.from ?? detection.pageUrl;
    const held = settling?.held ?? null;
    if (settling) clearTimeout(settling.timer);
    settling = {
      from, tabId, held,
      timer: setTimeout(() => {
        void chrome.tabs.get(tabId).then(now => settle(now.url), () => settle(undefined));
      }, ADDRESS_SETTLE_MS),
    };
  });

  chrome.tabs.onRemoved.addListener(tabId => {
    if (config?.tabId !== tabId) return;
    epoch += 1;
    void hooks.enqueue(async () => { await disable(); await followActiveTab(); }).catch(() => undefined);
  });

  void hooks.enqueue(async () => {
    await restored;
    await sitesLoaded;
    if (standby && Date.now() >= standby.until) dropStandby();
    armStandbyTimer();
    if (!resolved && !standby) await closeCopy(); // A lookup cut short by a worker restart restarts below.
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
        alreadyDubPage = "";
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
