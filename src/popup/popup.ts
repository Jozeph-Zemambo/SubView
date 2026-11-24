// SubView popup: one power button per site, what's playing, and the mix.
// The full manual tooling lives on the Debug tools page (debug.html).

import type { AutoDubState } from "../shared/auto-dub";
import { DEFAULT_SITE_SETTINGS, normalizeSiteSettings, siteKey, type SiteSettings } from "../shared/auto-dub-sites";
import { isRecord } from "../shared/messages";
import type { SyncState } from "../shared/types";

type View = "loading" | "unavailable" | "off" | "standby" | "searching" | "live" | "fault";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

const ui = {
  site: element<HTMLParagraphElement>("site"),
  power: element<HTMLButtonElement>("power"),
  powerLabel: element<HTMLSpanElement>("power-label"),
  tallyText: element<HTMLSpanElement>("tally-text"),
  status: element<HTMLParagraphElement>("status"),
  server: element<HTMLSpanElement>("server"),
  source: element<HTMLSpanElement>("source"),
  volume: element<HTMLInputElement>("volume"),
  volumeOut: element<HTMLOutputElement>("volume-out"),
  mute: element<HTMLButtonElement>("mute"),
  offset: element<HTMLInputElement>("offset"),
  autoOffset: element<HTMLButtonElement>("auto-offset"),
  autoReload: element<HTMLButtonElement>("auto-reload"),
  reload: element<HTMLButtonElement>("reload"),
  useTab: element<HTMLButtonElement>("use-tab"),
  error: element<HTMLParagraphElement>("error"),
  debug: element<HTMLButtonElement>("debug"),
  update: element<HTMLButtonElement>("update"),
  mixer: document.querySelector<HTMLElement>(".mixer")!,
};

let tab: chrome.tabs.Tab | null = null;
let site: string | null = null;
let sites: string[] = [];
let autoDub: AutoDubState | null = null;
let sync: SyncState | null = null;
let settings: SiteSettings = { ...DEFAULT_SITE_SETTINGS };
let busy = false;

async function send(message: object): Promise<Record<string, unknown>> {
  const response: unknown = await chrome.runtime.sendMessage(message);
  if (!isRecord(response)) throw new Error("SubView didn't answer. Reload the extension and try again.");
  if (response.ok === false) throw new Error(typeof response.error === "string" ? response.error : "That didn't work.");
  return response;
}

function showError(error: unknown): void {
  ui.error.textContent = error instanceof Error ? error.message : String(error);
  ui.error.hidden = false;
}

function clearError(): void {
  ui.error.hidden = true;
}

function absorbAutoDub(response: Record<string, unknown>): void {
  if ("autoDub" in response) autoDub = isRecord(response.autoDub) ? response.autoDub as unknown as AutoDubState : null;
  if (Array.isArray(response.sites)) sites = response.sites.filter((item): item is string => typeof item === "string");
  if (isRecord(response.siteSettings)) settings = normalizeSiteSettings(response.siteSettings);
}

const siteOn = () => site !== null && sites.includes(site);
/** Auto Dub is attached to the tab this popup was opened over. */
const attachedHere = () => Boolean(autoDub && tab?.id === autoDub.tabId);
const hostedHere = () => sync?.backgroundAudio?.mode === "hosted" && sync.primary.endpoint.tabId === tab?.id;

function view(): View {
  if (!tab) return "loading";
  if (!site) return "unavailable";
  if (!siteOn()) return "off";
  if (!attachedHere() || !autoDub) return "standby";
  if (autoDub.status === "finding") return "searching";
  if (autoDub.status === "active" && hostedHere()) return "live";
  if (autoDub.status === "error") return "fault";
  return "standby";
}

function statusText(current: View): string {
  switch (current) {
    case "loading": return "Checking this tab…";
    case "unavailable": return "Open an episode page to use Auto Dub.";
    case "off": return `Sub plays as usual. Tap the burst to hear the Dub on every ${site} episode!`;
    case "standby":
      if (!attachedHere()) return autoDub
        ? `On for ${site}. Auto Dub is ${elsewhereActivity(autoDub)} another tab${autoDub.site ? ` (${autoDub.site})` : ""}.`
        : `On for ${site}. It starts when you play an episode in Sub.`;
      return autoDub?.reason || "Waiting for the episode…";
    case "live":
      // The window fallback explains itself (why the hidden copy didn't work).
      return sync?.backgroundAudio?.mode === "hosted" && sync.backgroundAudio.container === "window" && autoDub?.reason
        ? autoDub.reason
        : "Dub's playing in sync! Your tab stays on Sub.";
    default: return autoDub?.reason || "";
  }
}

/** What Auto Dub is doing on the tab it's attached to, when that isn't this one. */
function elsewhereActivity(other: AutoDubState): string {
  if (other.status === "finding") return "starting in";
  if (other.status !== "active") return "attached to"; // Waiting, unsupported, ambiguous or stuck: not playing.
  if (sync?.primary.endpoint.tabId === other.tabId && (sync.status === "paused" || !sync.timeline.playing)) return "paused in";
  return "playing in";
}

// The burst's lettering and caption for each state.
const POWER_WORD: Record<View, string> = {
  loading: "…", unavailable: "—", off: "OFF", standby: "ON", searching: "...?!", live: "DUB!!", fault: "UH-OH",
};
const TALLY: Record<View, string> = {
  loading: "Loading", unavailable: "No episode", off: "Tap to dub", standby: "Standby",
  searching: "Searching", live: "On air", fault: "Why? See below",
};

function serverReadout(): { server: string; source: string; dim: boolean } {
  if (hostedHere() && sync?.backgroundAudio?.mode === "hosted") {
    return {
      server: sync.backgroundAudio.provider ?? "Page default",
      source: sync.backgroundAudio.container === "offscreen" ? "Hidden copy" : "Mini window",
      dim: false,
    };
  }
  if (attachedHere() && autoDub?.status === "finding") return { server: "Searching…", source: "Loading…", dim: true };
  if (settings.dubServer && siteOn()) return { server: `${settings.dubServer} · last worked`, source: "—", dim: true };
  return { server: "—", source: "—", dim: true };
}

function renderSettings(): void {
  // Live values win while a Dub is playing in this tab; otherwise the site's saved ones.
  const audio = hostedHere() ? sync?.backgroundAudio : undefined;
  const volume = Math.round((audio?.volume ?? settings.volume) * 100);
  if (document.activeElement !== ui.volume) ui.volume.value = String(volume);
  ui.volume.style.setProperty("--fill", `${ui.volume.value}%`);
  ui.volumeOut.value = `${ui.volume.value}%`;
  ui.mute.setAttribute("aria-checked", String(audio?.muteOriginal ?? settings.muteOriginal));
  const offsetMs = hostedHere() ? sync?.manualOffsetMs ?? sync?.offsetMs ?? settings.offsetMs : settings.offsetMs;
  if (document.activeElement !== ui.offset) ui.offset.value = String(Math.round(offsetMs / 100) / 10);
  ui.autoOffset.setAttribute("aria-checked", String(hostedHere() ? sync?.autoOffset === true : settings.autoOffset));
  ui.autoReload.setAttribute("aria-checked", String(settings.autoReload));
}

function render(): void {
  const current = view();
  document.body.dataset.state = current;
  ui.site.textContent = site ?? (tab ? "Not a website" : "—");
  ui.site.title = site ?? "";
  ui.powerLabel.textContent = POWER_WORD[current];
  ui.tallyText.textContent = TALLY[current];
  ui.status.textContent = statusText(current);
  ui.reload.hidden = !(attachedHere() && autoDub?.reloadOffer === true);
  ui.useTab.hidden = !(siteOn() && !attachedHere() && Boolean(autoDub));
  ui.useTab.disabled = busy;
  ui.power.setAttribute("aria-pressed", String(siteOn()));
  ui.power.setAttribute("aria-label", site
    ? siteOn() ? `Turn off Auto Dub on ${site}` : `Turn on Auto Dub for ${site}`
    : "Auto Dub needs a website tab");
  ui.power.disabled = busy || current === "loading" || current === "unavailable";
  const readout = serverReadout();
  ui.server.textContent = readout.server;
  ui.server.classList.toggle("dim", readout.dim);
  ui.source.textContent = readout.source;
  ui.source.classList.toggle("dim", readout.dim);
  ui.mixer.classList.toggle("locked", !site);
  renderSettings();
}

async function refresh(): Promise<void> {
  const [autoDubResponse, stateResponse] = await Promise.all([
    send({ type: "GET_AUTO_DUB", ...(site ? { site } : {}) }),
    send({ type: "GET_STATE" }),
  ]);
  absorbAutoDub(autoDubResponse);
  sync = isRecord(stateResponse.state) ? stateResponse.state as unknown as SyncState : null;
  render();
}

/** The mixer as shown. Learned fields (servers, frame) stay out: the worker keeps the site's own. */
function currentSettings(): Omit<SiteSettings, "enabled" | "dubServer" | "failedServers" | "lenientFrame"> {
  return {
    volume: Number(ui.volume.value) / 100,
    offsetMs: Math.round((Number(ui.offset.value) || 0) * 1000),
    muteOriginal: ui.mute.getAttribute("aria-checked") === "true",
    autoOffset: ui.autoOffset.getAttribute("aria-checked") === "true",
    autoReload: ui.autoReload.getAttribute("aria-checked") === "true",
  };
}

async function togglePower(): Promise<void> {
  if (!site || !tab?.id || busy) return;
  clearError();
  busy = true;
  render();
  try {
    absorbAutoDub(await send(siteOn()
      ? { type: "SET_AUTO_DUB_SITE", site, enabled: false }
      : { type: "SET_AUTO_DUB_SITE", site, enabled: true, tabId: tab.id, settings: currentSettings() }));
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    render();
  }
}

/**
 * Apply one setting. While Auto Dub is attached here the worker applies it live
 * (and saves it for the site); otherwise it's saved for the site, or kept until
 * the site is turned on.
 */
async function applySetting(live: object): Promise<void> {
  clearError();
  try {
    if (attachedHere()) await send(live);
    else if (siteOn() && site) absorbAutoDub(await send({ type: "SET_AUTO_DUB_SITE", site, enabled: true, settings: currentSettings() }));
  } catch (error) {
    showError(error);
  }
}

function toggleSwitch(button: HTMLButtonElement): boolean {
  const next = button.getAttribute("aria-checked") !== "true";
  button.setAttribute("aria-checked", String(next));
  return next;
}

let volumeTimer: ReturnType<typeof setTimeout> | undefined;
ui.volume.addEventListener("input", () => {
  ui.volume.style.setProperty("--fill", `${ui.volume.value}%`);
  ui.volumeOut.value = `${ui.volume.value}%`;
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => void applySetting({ type: "SET_BACKGROUND_VOLUME", volume: Number(ui.volume.value) / 100 }), 120);
});

ui.mute.addEventListener("click", () => {
  const muteOriginal = toggleSwitch(ui.mute);
  void applySetting({ type: "SET_MUTE_ORIGINAL", muteOriginal });
});

ui.autoOffset.addEventListener("click", () => {
  const enabled = toggleSwitch(ui.autoOffset);
  void applySetting({ type: "SET_AUTO_OFFSET", enabled });
});

// Saved for the site; before the site is on, the switch just holds the choice for when it is.
ui.autoReload.addEventListener("click", () => {
  const enabled = toggleSwitch(ui.autoReload);
  settings = { ...settings, autoReload: enabled };
  clearError();
  if (!siteOn() || !site) return;
  void send({ type: "SET_AUTO_DUB_RELOAD", site, enabled }).then(response => { absorbAutoDub(response); render(); }, showError);
});

ui.reload.addEventListener("click", () => {
  clearError();
  void send({ type: "AUTO_DUB_RELOAD" }).then(response => { absorbAutoDub(response); render(); }, showError);
});

/** Move Auto Dub from the tab it's on to this one; the site's saved settings stay as they are. */
async function useThisTab(): Promise<void> {
  if (!site || tab?.id === undefined || busy) return;
  clearError();
  busy = true;
  render();
  try {
    absorbAutoDub(await send({ type: "USE_AUTO_DUB_TAB", site, tabId: tab.id }));
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    render();
  }
}
ui.useTab.addEventListener("click", () => void useThisTab());

function commitOffset(): void {
  const seconds = Number(ui.offset.value);
  if (!Number.isFinite(seconds) || Math.abs(seconds) > 3600) {
    showError("Enter a timing between −3600 and 3600 seconds.");
    return;
  }
  ui.offset.value = String(Math.round(seconds * 10) / 10);
  void applySetting({ type: "SET_MANUAL_OFFSET", offsetMs: Math.round(seconds * 1000) });
}
ui.offset.addEventListener("change", commitOffset);
ui.offset.addEventListener("keydown", event => { if (event.key === "Enter") ui.offset.blur(); });
for (const step of document.querySelectorAll<HTMLButtonElement>(".nudge-step")) {
  step.addEventListener("click", () => {
    ui.offset.value = String(Math.round(((Number(ui.offset.value) || 0) + Number(step.dataset.step)) * 10) / 10);
    commitOffset();
  });
}

ui.power.addEventListener("click", () => void togglePower());
ui.debug.addEventListener("click", () => void chrome.tabs.create({ url: chrome.runtime.getURL("debug.html") }));

/** Copies loaded from a release zip don't update themselves; say when a newer one is out. */
async function showUpdateNotice(): Promise<void> {
  const response = await send({ type: "GET_UPDATE" });
  const update = isRecord(response.update) ? response.update : null;
  if (!update || typeof update.version !== "string" || typeof update.url !== "string") return;
  const url = update.url;
  ui.update.textContent = `v${update.version} is out · Get it ▸`;
  ui.update.title = "Opens the download page. Replace this folder's files, then press Reload on SubView in chrome://extensions.";
  ui.update.addEventListener("click", () => void chrome.tabs.create({ url }));
  ui.update.hidden = false;
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isRecord(message)) return false;
  if (message.type === "AUTO_DUB_UPDATE") {
    autoDub = isRecord(message.autoDub) ? message.autoDub as unknown as AutoDubState : null;
    render();
  } else if (message.type === "STATE_UPDATE") {
    sync = isRecord(message.state) ? message.state as unknown as SyncState : null;
    render();
  }
  return false;
});

void (async () => {
  try {
    // ?tab=<id> lets tests and the debug page open the popup for a specific tab.
    const requested = Number(new URLSearchParams(location.search).get("tab"));
    tab = Number.isInteger(requested) && requested > 0
      ? await chrome.tabs.get(requested).catch(() => null)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0] ?? null;
    site = siteKey(tab?.url);
    await refresh();
  } catch (error) {
    tab ??= null;
    render();
    showError(error);
  }
  // Never in the way: a failed check just shows nothing.
  void showUpdateNotice().catch(() => undefined);
})();
