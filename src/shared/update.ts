// Update notice for copies installed from a GitHub release zip ("Load
// unpacked"), which Chrome never updates by itself. Pure helpers; the check
// itself lives in background/update-check.ts.

/** Where releases are published. The notice only ever links below this address. */
export const RELEASES_PAGE = "https://github.com/Jozeph-Zemambo/SubView/releases";
export const LATEST_RELEASE_API = "https://api.github.com/repos/Jozeph-Zemambo/SubView/releases/latest";

/** GitHub is asked at most this often. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After a failed check (offline, rate limit), wait this long before trying again. */
export const RETRY_INTERVAL_MS = 60 * 60 * 1000;

export interface UpdateNotice {
  version: string;
  url: string;
}

/** "v0.2.0" or "0.2.0" → [0, 2, 0]. Anything else (pre-release names, words) → null. */
export function parseVersion(value: unknown): number[] | null {
  if (typeof value !== "string") return null;
  const match = /^v?(\d{1,6}(?:\.\d{1,6}){0,3})$/.exec(value.trim());
  return match ? match[1].split(".").map(Number) : null;
}

/** True when `latest` is a higher version than `current`. Unreadable versions are never newer. */
export function isNewer(latest: unknown, current: unknown): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** The notice to show for a release GitHub reported, or null when there is nothing newer. */
export function noticeFor(release: { version?: unknown; url?: unknown } | null | undefined, current: string): UpdateNotice | null {
  const parsed = parseVersion(release?.version);
  if (!parsed || !isNewer(release?.version, current)) return null;
  // Only a page of this project's releases; anything else falls back to the list.
  const url = typeof release?.url === "string" && release.url.startsWith(`${RELEASES_PAGE}/`) ? release.url : RELEASES_PAGE;
  return { version: parsed.join("."), url };
}
