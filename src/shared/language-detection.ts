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
  /**
   * The player chooses audio by language (Japanese / English…) rather than
   * Sub/Dub. Dub then means audio in the viewer's own language. Some services
   * save that choice to the account, so the hidden copy presses it under a
   * guard (see hosted-host.ts).
   */
  audioControl?: boolean;
  /**
   * Not a reading of the page but a notice that one is coming. "load": the
   * page that was there is gone (a navigation or a reload). "address": only
   * the address changed and the page stays loaded (the app's own router); such
   * a change can come straight back, so it says nothing yet.
   */
  placeholder?: "load" | "address";
}
