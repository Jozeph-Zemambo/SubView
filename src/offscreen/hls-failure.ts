import type { ErrorData } from "hls.js";

export type HlsFailureData = Partial<Pick<ErrorData, "details" | "response">>;

interface DetailInfo {
  stage: string;
  kind: string;
}

// Keep this list aligned with hls.js 1.7.3. Values not in this allowlist are
// intentionally rendered as unknown so arbitrary event data cannot reach UI.
const DETAIL_INFO: Readonly<Record<string, DetailInfo>> = Object.freeze({
  keySystemNoKeys: { stage: "drm", kind: "key" },
  keySystemNoAccess: { stage: "drm", kind: "key" },
  keySystemNoSession: { stage: "drm", kind: "key" },
  keySystemNoConfiguredLicense: { stage: "drm", kind: "key" },
  keySystemLicenseRequestFailed: { stage: "drm", kind: "key" },
  keySystemServerCertificateRequestFailed: { stage: "drm", kind: "key" },
  keySystemServerCertificateUpdateFailed: { stage: "drm", kind: "key" },
  keySystemSessionUpdateFailed: { stage: "drm", kind: "key" },
  keySystemStatusOutputRestricted: { stage: "drm", kind: "key" },
  keySystemStatusInternalError: { stage: "drm", kind: "key" },
  keySystemDestroyMediaKeysError: { stage: "drm", kind: "key" },
  keySystemDestroyCloseSessionError: { stage: "drm", kind: "key" },
  keySystemDestroyRemoveSessionError: { stage: "drm", kind: "key" },
  manifestLoadError: { stage: "manifest", kind: "load" },
  manifestLoadTimeOut: { stage: "manifest", kind: "timeout" },
  manifestParsingError: { stage: "manifest", kind: "decode" },
  manifestIncompatibleCodecsError: { stage: "manifest", kind: "codec" },
  levelEmptyError: { stage: "level", kind: "playlist" },
  playlistUnchangedError: { stage: "level", kind: "playlist" },
  levelLoadError: { stage: "level", kind: "load" },
  levelLoadTimeOut: { stage: "level", kind: "timeout" },
  levelParsingError: { stage: "level", kind: "decode" },
  levelSwitchError: { stage: "level", kind: "switch" },
  audioTrackLoadError: { stage: "audio", kind: "load" },
  audioTrackLoadTimeOut: { stage: "audio", kind: "timeout" },
  subtitleTrackLoadError: { stage: "subtitle", kind: "load" },
  subtitleTrackLoadTimeOut: { stage: "subtitle", kind: "timeout" },
  fragLoadError: { stage: "segment", kind: "load" },
  fragLoadTimeOut: { stage: "segment", kind: "timeout" },
  fragDecryptError: { stage: "segment", kind: "decrypt" },
  fragParsingError: { stage: "segment", kind: "decode" },
  fragGap: { stage: "segment", kind: "gap" },
  remuxAllocError: { stage: "remux", kind: "memory" },
  keyLoadError: { stage: "key", kind: "load" },
  keyLoadTimeOut: { stage: "key", kind: "timeout" },
  bufferAddCodecError: { stage: "codec", kind: "codec" },
  bufferIncompatibleCodecsError: { stage: "codec", kind: "codec" },
  bufferAppendError: { stage: "buffer", kind: "append" },
  bufferAppendingError: { stage: "buffer", kind: "append" },
  bufferAppendNoProgress: { stage: "buffer", kind: "stalled" },
  bufferStalledError: { stage: "buffer", kind: "stalled" },
  bufferFullError: { stage: "buffer", kind: "full" },
  bufferSeekOverHole: { stage: "buffer", kind: "seek" },
  bufferNudgeOnStall: { stage: "buffer", kind: "stalled" },
  assetListLoadError: { stage: "asset-list", kind: "load" },
  assetListLoadTimeout: { stage: "asset-list", kind: "timeout" },
  assetListParsingError: { stage: "asset-list", kind: "decode" },
  interstitialAssetItemError: { stage: "interstitial", kind: "load" },
  internalException: { stage: "internal", kind: "exception" },
  aborted: { stage: "internal", kind: "aborted" },
  attachMediaError: { stage: "media", kind: "attach" },
  mediaSourceRequiresReset: { stage: "media", kind: "reset" },
  unknown: { stage: "unknown", kind: "unknown" },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readResponseCode(data: unknown): number | undefined {
  if (!isRecord(data) || !isRecord(data.response)) return undefined;
  const code = data.response.code;
  return typeof code === "number" && Number.isSafeInteger(code) && code >= 0
    ? code
    : undefined;
}

export function formatHlsFailure(data: HlsFailureData): string {
  const details = isRecord(data) && typeof data.details === "string"
    ? data.details
    : undefined;
  const detailInfo = details && Object.prototype.hasOwnProperty.call(DETAIL_INFO, details)
    ? DETAIL_INFO[details]
    : undefined;
  const fields = [
    `details=${detailInfo ? details : "unknown"}`,
    `stage=${detailInfo?.stage ?? "unknown"}`,
    `kind=${detailInfo?.kind ?? "unknown"}`,
  ];
  const responseCode = readResponseCode(data);
  if (responseCode === 0) fields.push("no HTTP response");
  else if (responseCode !== undefined) fields.push(`HTTP ${responseCode}`);
  return `HLS playback failed: ${fields.join("; ")}`;
}
