import type { Side } from "./types";

export interface AutoOffsetResolution {
  offsetMs: number;
  pending: boolean;
}

function knownDuration(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Derive the signed offset for the canonical relation
 * secondaryTime = primaryTime + offsetMs.
 *
 * A null result deliberately means "not enough metadata". In particular,
 * live media reports an infinite duration and must not be treated as zero.
 */
export function deriveAutoOffset(
  primaryDurationMs: number | null | undefined,
  secondaryDurationMs: number | null | undefined,
): number | null {
  if (!knownDuration(primaryDurationMs) || !knownDuration(secondaryDurationMs)) {
    return null;
  }
  return secondaryDurationMs - primaryDurationMs;
}

/** Resolve the effective offset without hiding an unresolved auto setting. */
export function resolveAutoOffset(
  manualOffsetMs: number,
  autoOffset: boolean | undefined,
  primaryDurationMs: number | null | undefined,
  secondaryDurationMs: number | null | undefined,
): AutoOffsetResolution {
  if (!autoOffset) return { offsetMs: manualOffsetMs, pending: false };
  const derived = deriveAutoOffset(primaryDurationMs, secondaryDurationMs);
  return derived === null
    ? { offsetMs: manualOffsetMs, pending: true }
    : { offsetMs: derived + manualOffsetMs, pending: false };
}

/**
 * Map an endpoint position to canonical primary time. Manual and pending
 * modes retain the existing signed-offset semantics; once auto offset is
 * resolved, a longer primary starts after its lead-in so the secondary never
 * has to wait at a negative target.
 */
export function canonicalPositionFor(
  sideTimeMs: number,
  offsetMs: number,
  side: Side,
  autoOffsetActive = false,
): number {
  const raw = side === "primary" ? sideTimeMs : sideTimeMs - offsetMs;
  if (!Number.isFinite(raw)) return 0;
  if (!autoOffsetActive) return raw;
  const minimum = offsetMs < 0 ? -offsetMs : 0;
  return Math.max(minimum, raw);
}
