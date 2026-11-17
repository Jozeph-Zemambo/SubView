export type DetectedLanguage = "sub" | "dub" | "unknown";

export type AvailableLanguage = Exclude<DetectedLanguage, "unknown">;

export type DubCandidateKind = "page" | "media";

export interface DubCandidate {
  url: string;
  kind: DubCandidateKind;
  label: string;
}

export interface LanguageDetection {
  pageUrl: string;
  language: DetectedLanguage;
  available: AvailableLanguage[];
  dubCandidates: DubCandidate[];
  provider: string | null;
  evidence: string[];
  reason: string;
  /** Sub and Dub controls exist but the page doesn't say which is selected. */
  stateUnclear?: boolean;
}
