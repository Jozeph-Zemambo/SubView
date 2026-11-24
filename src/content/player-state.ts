// Where the viewer was and what their player was set to, taken before a reload
// SubView asked for and put back after it (see `reloadForDub` in
// background/auto-dub.ts).

import { capturePlayerChoices, restorePlayerChoices, type PlayerChoice } from "./language-detection";
import { isBuffered, pageTimeline, seekThroughTimeline } from "./timeline-seek";
import { findVideoById } from "./video-probe";

export interface PlayerState {
  timeMs: number;
  playing: boolean;
  choices: PlayerChoice[];
}

const READY_TIMEOUT_MS = 30_000;
const SEEK_TIMEOUT_MS = 8_000;
/** Closer than this to where the viewer was is close enough to leave alone. */
const NEAR_S = 2;
/** HTMLMediaElement.HAVE_FUTURE_DATA: the video can play from where it is. */
const PLAYABLE = 3;

export function isPlayerState(value: unknown): value is PlayerState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return typeof state.timeMs === "number" && Number.isFinite(state.timeMs) && state.timeMs >= 0 &&
    typeof state.playing === "boolean" && Array.isArray(state.choices) && state.choices.length <= 12 &&
    state.choices.every(choice => typeof choice === "object" && choice !== null &&
      typeof (choice as PlayerChoice).group === "string" && (choice as PlayerChoice).group.length <= 200 &&
      typeof (choice as PlayerChoice).option === "string" && (choice as PlayerChoice).option.length <= 200);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function until(test: () => boolean, ms: number): Promise<boolean> {
  for (const started = Date.now(); !test() && Date.now() - started < ms;) await sleep(150);
  return test();
}

export async function capturePlayerState(doc: Document, videoId: string): Promise<PlayerState | null> {
  const video = findVideoById(videoId, doc);
  if (!video) return null;
  // The position first: reading the menus takes a moment.
  const timeMs = Math.round(video.currentTime * 1000);
  const playing = !video.paused && !video.ended;
  const choices = await capturePlayerChoices(doc).catch(() => []);
  return { timeMs, playing, choices };
}

export async function restorePlayerState(doc: Document, videoId: string, state: PlayerState): Promise<{ choices: string[]; seeked: boolean; playing: boolean }> {
  // Players often swap their <video> while they start up: always act on the one that is there now.
  const current = () => findVideoById(videoId, doc) ?? (doc.querySelectorAll("video").length === 1 ? doc.querySelector("video") : null);
  const playable = () => (current()?.readyState ?? 0) >= PLAYABLE;
  // Menus pressed before the player can play are saved by some players and never applied.
  await until(playable, READY_TIMEOUT_MS);
  const choices = await restorePlayerChoices(doc, state.choices).catch(() => []);
  if (choices.length) { await sleep(500); await until(playable, READY_TIMEOUT_MS); }

  const seconds = state.timeMs / 1000;
  let seeked = false;
  const video = current();
  if (video && Number.isFinite(video.duration) && seconds < video.duration - 1 && Math.abs(video.currentTime - seconds) > NEAR_S) {
    const timeline = isBuffered(video, seconds) ? null : pageTimeline(video);
    if (timeline) seekThroughTimeline(timeline, seconds); else video.currentTime = seconds;
    seeked = await until(() => { const now = current(); return Boolean(now) && !now!.seeking && Math.abs(now!.currentTime - seconds) <= NEAR_S + 1; }, SEEK_TIMEOUT_MS);
    // A timeline that ignores scripted input leaves the video where it was.
    const now = current();
    if (!seeked && now && timeline) { now.currentTime = seconds; seeked = true; }
  }
  const last = current();
  if (state.playing && last?.paused) {
    await last.play().catch(() => {
      // The browser refuses to start a video nobody has clicked in a tab that
      // is not being looked at. Try once more when the viewer comes back to it.
      const view = doc.defaultView;
      if (!view || doc.visibilityState === "visible") return;
      const again = () => {
        if (doc.visibilityState !== "visible") return;
        doc.removeEventListener("visibilitychange", again);
        const now = current();
        if (now?.paused) void now.play().catch(() => undefined);
      };
      doc.addEventListener("visibilitychange", again);
      view.setTimeout(() => doc.removeEventListener("visibilitychange", again), 120_000);
    });
  }
  return { choices, seeked, playing: Boolean(last && !last.paused) };
}
