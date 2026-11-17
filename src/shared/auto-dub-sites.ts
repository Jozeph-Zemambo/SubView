// Per-site Auto Dub: sites the user turned Auto Dub on for, with the settings
// and server memory learned there. Pure helpers; storage lives in the worker.

import { providerFamily } from "./hosted-selection";

/** A failed Dub server is skipped for this long, then tried again (servers recover). */
export const FAILED_SERVER_TTL_MS = 24 * 60 * 60 * 1000;

export interface SiteSettings {
  volume: number;
  offsetMs: number;
  muteOriginal: boolean;
  autoOffset: boolean;
  /** Family of the Dub server that last played here ("alpha"). */
  dubServer: string | null;
  /** Server family → when it last failed (epoch ms). */
  failedServers: Record<string, number>;
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  volume: 0.8,
  offsetMs: 0,
  muteOriginal: true,
  autoOffset: false,
  dubServer: null,
  failedServers: {},
};

/** The site key for a page: its hostname, without a leading "www.". */
export function siteKey(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeSiteSettings(value: unknown): SiteSettings {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const failed: Record<string, number> = {};
  if (typeof record.failedServers === "object" && record.failedServers !== null) {
    for (const [family, at] of Object.entries(record.failedServers as Record<string, unknown>)) {
      if (family && typeof at === "number" && Number.isFinite(at)) failed[family] = at;
    }
  }
  return {
    volume: Math.min(1, Math.max(0, finite(record.volume, DEFAULT_SITE_SETTINGS.volume))),
    offsetMs: finite(record.offsetMs, 0),
    muteOriginal: typeof record.muteOriginal === "boolean" ? record.muteOriginal : true,
    autoOffset: record.autoOffset === true,
    dubServer: typeof record.dubServer === "string" && record.dubServer ? record.dubServer : null,
    failedServers: failed,
  };
}

/** Server families that failed recently enough to skip. */
export function recentlyFailed(settings: SiteSettings, now: number): string[] {
  return Object.entries(settings.failedServers)
    .filter(([, at]) => now - at < FAILED_SERVER_TTL_MS)
    .map(([family]) => family);
}

/** Record a Dub server that played: remember it, and forget that it ever failed. */
export function rememberWorkingServer(settings: SiteSettings, label: string | null): SiteSettings {
  const family = providerFamily(label);
  if (!family) return settings;
  const failedServers = { ...settings.failedServers };
  delete failedServers[family];
  return { ...settings, dubServer: family, failedServers };
}

/** Record a Dub server that didn't load. A remembered server that fails is forgotten. */
export function rememberFailedServer(settings: SiteSettings, label: string | null, now: number): SiteSettings {
  const family = providerFamily(label);
  if (!family) return settings;
  return {
    ...settings,
    dubServer: settings.dubServer === family ? null : settings.dubServer,
    failedServers: { ...settings.failedServers, [family]: now },
  };
}
