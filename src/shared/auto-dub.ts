export interface AutoDubConfig {
  tabId: number;
  volume: number;
  /** Manual fallback/configured offset in milliseconds. */
  offsetMs: number;
  muteOriginal: boolean;
  autoOffset?: boolean;
}

export interface AutoDubState {
  tabId: number;
  /** The site (hostname) this tab's Auto Dub belongs to. */
  site?: string;
  status: "waiting" | "finding" | "active" | "unsupported" | "ambiguous" | "error";
  reason: string;
}
