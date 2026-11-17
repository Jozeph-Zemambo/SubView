// Pure decisions for Auto Dub's hosted page: which video is the Dub episode,
// and which Server/Provider option to try next. No site-specific names.

import type { VideoDescriptor } from "./types";

/** Anything shorter is treated as an ad, intro card or preview, not an episode. */
export const MIN_EPISODE_MS = 60_000;
/** Dub cuts differ by credits or recaps, not by half the episode. */
const MIN_LENGTH_RATIO = 0.6;
const MAX_LENGTH_RATIO = 1.6;

export interface HostedVideoCandidate {
  frameKey: string;
  video: VideoDescriptor;
  /** When the video began loading; falls back to when its frame connected. */
  loadedAt: number;
}

/**
 * Choose the Dub episode video. Only videos that started loading after Dub was
 * selected count, so a late-finishing Sub load is never mistaken for Dub.
 */
export function chooseDubVideo(
  candidates: HostedVideoCandidate[],
  options: { since: number; primaryDurationMs: number | null },
): HostedVideoCandidate | null {
  const eligible = candidates.filter(({ video, loadedAt }) =>
    loadedAt >= options.since &&
    video.readyState >= 1 &&
    video.durationMs !== null && Number.isFinite(video.durationMs) &&
    video.durationMs >= MIN_EPISODE_MS &&
    (options.primaryDurationMs === null || options.primaryDurationMs < 2 * MIN_EPISODE_MS || (
      video.durationMs >= options.primaryDurationMs * MIN_LENGTH_RATIO &&
      video.durationMs <= options.primaryDurationMs * MAX_LENGTH_RATIO)));
  if (!eligible.length) return null;
  const distance = (candidate: HostedVideoCandidate) => options.primaryDurationMs === null
    ? -(candidate.video.durationMs ?? 0)
    : Math.abs((candidate.video.durationMs ?? 0) - options.primaryDurationMs);
  return [...eligible].sort((a, b) => distance(a) - distance(b) || b.loadedAt - a.loadedAt)[0];
}

/** The server family a label names: "alpha · embed · s-sub" and "alpha · embed" are both "alpha". */
export function providerFamily(label: string | null | undefined): string {
  return (label ?? "").toLowerCase().split(/[·•|,()[\]]/)[0].trim().split(/\s+/)[0] ?? "";
}

export interface ProviderChoice {
  label: string;
  selected: boolean;
}

/**
 * Pick the next Server/Provider to try for Dub: the preferred family first (the
 * server that worked here before, else the one the user watches Sub on, for
 * the closest timing), then the page's order. Servers that failed recently go
 * last rather than never, since the alternative is no Dub at all.
 */
export function nextProvider(
  options: ProviderChoice[],
  tried: Set<string>,
  preferredFamily: string,
  avoidFamilies: string[] = [],
): string | null {
  const untried = options.filter(option => !tried.has(option.label));
  const avoided = (option: ProviderChoice) => avoidFamilies.includes(providerFamily(option.label));
  const preferred = preferredFamily
    ? untried.find(option => providerFamily(option.label) === preferredFamily && !avoided(option))
    : undefined;
  return (preferred ?? untried.find(option => !avoided(option)) ?? untried[0])?.label ?? null;
}
