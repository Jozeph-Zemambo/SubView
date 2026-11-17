import type { Side } from "./types";

export const DEFAULT_TOLERANCE_MS = 350;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function translatePrimaryTime(
  primaryTimeMs: number,
  offsetMs: number,
  side: Side,
): number {
  return side === "primary" ? primaryTimeMs : primaryTimeMs + offsetMs;
}

export function toPrimaryTime(
  sideTimeMs: number,
  offsetMs: number,
  side: Side,
): number {
  return side === "primary" ? sideTimeMs : sideTimeMs - offsetMs;
}

export function clampToDuration(
  targetTimeMs: number,
  durationMs: number | null,
): number {
  if (targetTimeMs < 0) return 0;
  if (durationMs === null) return targetTimeMs;
  return clamp(targetTimeMs, 0, durationMs);
}

export function targetIsPlayable(
  targetTimeMs: number,
  durationMs: number | null,
): boolean {
  if (targetTimeMs < 0) return false;
  if (durationMs === null) return true;
  return targetTimeMs < durationMs;
}

export function parseOffset(value: string): number | null {
  const normalized = value.trim();
  const match = normalized.match(/^([+-])?(\d{1,3}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;

  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (minutes > 59 || seconds > 59) return null;

  const milliseconds = ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number((match[5] ?? "").padEnd(3, "0"));
  return match[1] === "-" ? -milliseconds : milliseconds;
}

export function formatOffset(milliseconds: number): string {
  const sign = milliseconds < 0 ? "-" : "+";
  const absoluteMs = Math.round(Math.abs(milliseconds));
  const fraction = absoluteMs % 1000;
  const suffix = fraction ? `.${String(fraction).padStart(3, "0").replace(/0+$/, "")}` : "";
  const totalSeconds = Math.floor(absoluteMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0",
  )}:${String(seconds).padStart(2, "0")}${suffix}`;
}

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "Unknown length";
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
      2,
      "0",
    )}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function isWithinTolerance(actualMs: number, targetMs: number, toleranceMs: number): boolean {
  return Math.abs(actualMs - targetMs) <= toleranceMs;
}

