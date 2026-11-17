import { finiteOrNull } from "../shared/time";
import type { VideoDescriptor } from "../shared/types";

const PROBE_STATE_KEY = "__subview4dub_video_probe_state_v1";

interface ProbeState {
  ids: WeakMap<HTMLVideoElement, string>;
  nextId: number;
}

type GlobalWithProbeState = typeof globalThis & {
  [PROBE_STATE_KEY]?: ProbeState;
};

function getProbeState(): ProbeState {
  const globalScope = globalThis as GlobalWithProbeState;
  if (globalScope[PROBE_STATE_KEY]) return globalScope[PROBE_STATE_KEY];

  const state: ProbeState = {
    ids: new WeakMap<HTMLVideoElement, string>(),
    nextId: 1,
  };
  globalScope[PROBE_STATE_KEY] = state;
  return state;
}

const probeState = getProbeState();

function firstNonEmpty(values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return "";
}

function sourceLabel(source: string): string {
  const withoutQuery = source.split(/[?#]/, 1)[0];
  const lastSegment = withoutQuery.split("/").pop()?.trim();
  return lastSegment ?? "";
}

export function getVideoId(video: HTMLVideoElement): string {
  const existing = probeState.ids.get(video);
  if (existing) return existing;

  const id = `video-${probeState.nextId}`;
  probeState.nextId += 1;
  probeState.ids.set(video, id);
  return id;
}

export function getVideoSource(video: HTMLVideoElement): string {
  const sourceElement = video.querySelector("source[src]") as HTMLSourceElement | null;
  return firstNonEmpty([
    video.currentSrc,
    video.src,
    video.getAttribute("src"),
    sourceElement?.src,
    sourceElement?.getAttribute("src"),
  ]);
}

export function getVideoLabel(video: HTMLVideoElement, index: number): string {
  const source = getVideoSource(video);
  const sourceName = sourceLabel(source);
  return firstNonEmpty([
    video.getAttribute("aria-label"),
    video.getAttribute("title"),
    video.getAttribute("data-title"),
    video.id,
    video.getAttribute("name"),
    sourceName,
    `Video ${index + 1}`,
  ]);
}

function positiveFiniteOrZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function durationToMilliseconds(video: HTMLVideoElement): number | null {
  const duration = finiteOrNull(video.duration);
  return duration === null ? null : Math.max(0, Math.round(duration * 1000));
}

function currentTimeToMilliseconds(video: HTMLVideoElement): number {
  return Number.isFinite(video.currentTime)
    ? Math.max(0, Math.round(video.currentTime * 1000))
    : 0;
}

function playbackRateOrDefault(video: HTMLVideoElement): number {
  return Number.isFinite(video.playbackRate) ? video.playbackRate : 1;
}

export function describeVideo(video: HTMLVideoElement, index: number): VideoDescriptor {
  const width = positiveFiniteOrZero(
    video.videoWidth || video.width || video.clientWidth || video.offsetWidth,
  );
  const height = positiveFiniteOrZero(
    video.videoHeight || video.height || video.clientHeight || video.offsetHeight,
  );

  return {
    id: getVideoId(video),
    index,
    label: getVideoLabel(video, index),
    source: getVideoSource(video),
    mediaSources: [...new Set([
      video.currentSrc, video.src,
      ...Array.from(video.querySelectorAll<HTMLSourceElement>("source[src]"), element => element.src),
    ].filter(Boolean))],
    durationMs: durationToMilliseconds(video),
    currentTimeMs: currentTimeToMilliseconds(video),
    paused: video.paused,
    ended: video.ended,
    playbackRate: playbackRateOrDefault(video),
    readyState: video.readyState,
    width,
    height,
  };
}

/** Probe videos in this document; the worker aggregates frame results. */
export function probeVideos(root?: Document): VideoDescriptor[] {
  const documentRoot = root ?? document;
  const videos = documentRoot.querySelectorAll<HTMLVideoElement>("video");
  return Array.from(videos, (video, index) => describeVideo(video, index));
}

/** Find a previously probed or currently discoverable video in this document. */
export function findVideoById(videoId: string, root?: Document): HTMLVideoElement | null {
  const documentRoot = root ?? document;
  const videos = documentRoot.querySelectorAll<HTMLVideoElement>("video");
  for (const video of videos) {
    if (getVideoId(video) === videoId) return video;
  }
  return null;
}
