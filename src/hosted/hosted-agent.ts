// Isolated-world agent for frames inside a page SubView hosts. It exposes the
// frame's videos and Sub/Dub controls to the worker over a runtime port, since
// frames without a tab cannot receive chrome.tabs.sendMessage.

import { HOSTED_PORT, type HostedAgentMessage, type HostedRequest, type HostedWorkerMessage } from "../shared/hosted";
import { isRecord } from "../shared/messages";
import type { ContentEventMessage, VideoDescriptor } from "../shared/types";
import { describeAudioControls, detectLanguage, listProviders, pageNotices, selectDubInteractive, selectProvider, useLayoutIndependentVisibility } from "../content/language-detection";
import { VideoController } from "../content/video-controller";
import { findVideoById, getVideoId, probeVideos } from "../content/video-probe";

const AGENT_KEY = "__subview4dub_hosted_agent_v1";
const ISOLATION_ERROR = "The hidden copy's storage isolation is not active, so Auto Dub won't change its language: that would switch your own tab to Dub too.";

/** Set by hosted-shim.ts once the page's storage writes are isolated. */
function isolated(): boolean {
  return Boolean(document.documentElement?.getAttribute("data-subview-isolation"));
}

(() => {
  const ancestors = Array.from(location.ancestorOrigins ?? []);
  // Exact ownership check: only frames whose top-most ancestor is this extension.
  if (ancestors[ancestors.length - 1] !== `chrome-extension://${chrome.runtime.id}`) return;
  const scope = globalThis as typeof globalThis & { [AGENT_KEY]?: true };
  if (scope[AGENT_KEY]) return;
  scope[AGENT_KEY] = true;
  useLayoutIndependentVisibility();

  const frameKey = crypto.randomUUID();
  let port: chrome.runtime.Port | null = null;
  const post = (message: HostedAgentMessage) => {
    try { port?.postMessage(message); } catch { /* Reconnect handles a stale port. */ }
  };

  const controller = new VideoController({
    sendMessage: (message: ContentEventMessage) => post({ type: "video-event", message }),
  });

  // Every video stays muted until the worker activates the one it chose. A site
  // that autoplays (or plays an ad) must not be heard out of sync.
  let activeVideoId: string | null = null;
  const loadStartedAt = new WeakMap<HTMLVideoElement, number>();
  const silence = (event: Event) => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (event.type === "loadstart" || event.type === "emptied") loadStartedAt.set(video, Date.now());
    if (getVideoId(video) !== activeVideoId && !video.muted) video.muted = true;
    if (["loadedmetadata", "canplay", "emptied"].includes(event.type)) post({ type: "media-changed" });
  };
  for (const type of ["loadstart", "emptied", "play", "playing", "volumechange", "loadedmetadata", "canplay"]) {
    document.addEventListener(type, silence, true);
  }

  const probe = (): VideoDescriptor[] => probeVideos().map(video => {
    const element = findVideoById(video.id);
    const started = element ? loadStartedAt.get(element) : undefined;
    return started === undefined ? video : { ...video, loadStartedAt: started };
  });

  async function handle(request: HostedRequest): Promise<unknown> {
    switch (request.type) {
      case "PROBE":
        return { ok: true, videos: probe() };
      case "DETECT":
        return { ok: true, detection: detectLanguage(document) };
      case "SELECT_DUB": {
        if (!isolated()) return { ok: false, error: ISOLATION_ERROR };
        // Popup menus report their own "at": the moment the Dub option was chosen.
        const at = Date.now();
        return { at, ...await selectDubInteractive(document, request.force === true) };
      }
      case "IDLE":
        for (const video of Array.from(document.querySelectorAll("video"))) video.pause();
        return { ok: true };
      case "LIST_PROVIDERS":
        return listProviders(document);
      case "NOTICES":
        return { ok: true, notices: pageNotices(document) };
      case "DESCRIBE": {
        const squash = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
        // The page-world shim keeps the trail; events are the only bridge between the two worlds.
        let trail: unknown = [];
        document.addEventListener("subview-trail", event => {
          try { trail = JSON.parse((event as CustomEvent<string>).detail); } catch { /* No trail. */ }
        }, { once: true });
        document.dispatchEvent(new CustomEvent("subview-trail-request"));
        return {
          ok: true,
          href: location.href,
          title: document.title,
          isolated: isolated(),
          text: squash(document.body?.textContent).slice(0, 400),
          videos: probe().map(video => ({ id: video.id, readyState: video.readyState, durationMs: video.durationMs, currentTimeMs: video.currentTimeMs, paused: video.paused, source: Boolean(video.source), loadStartedAt: video.loadStartedAt ?? null })),
          frames: Array.from(document.querySelectorAll("iframe")).map(frame => squash(frame.getAttribute("src")).slice(0, 120)),
          menus: Array.from(document.querySelectorAll('button,[role="button"]'))
            .filter(element => element.hasAttribute("aria-haspopup") || element.hasAttribute("aria-expanded"))
            .map(element => squash(element.getAttribute("aria-label") || element.textContent).slice(0, 60)).slice(0, 20),
          detection: detectLanguage(document),
          notices: pageNotices(document),
          audio: describeAudioControls(document),
          trail,
        };
      }
      case "SELECT_PROVIDER": {
        if (!isolated()) return { ok: false, error: ISOLATION_ERROR };
        const at = Date.now();
        return { ...selectProvider(document, request.provider), at };
      }
      case "ACTIVATE": {
        const response = controller.activate(request.pairId, request.side, request.videoId, request.revision);
        if (response.ok) activeVideoId = request.videoId;
        return response;
      }
      case "DEACTIVATE": {
        const response = controller.deactivate(request.pairId);
        if (response.ok && activeVideoId) {
          const element = findVideoById(activeVideoId);
          activeVideoId = null;
          if (element) element.muted = true;
        }
        return response;
      }
      case "COMMAND":
        return controller.applyCommand(request.command);
      case "SET_VOLUME":
        return controller.setVolume(request.pairId, request.volume);
      case "SET_MUTED":
        return controller.setMuted(request.pairId, request.muted);
      default:
        return { ok: false, error: "Unsupported hosted request" };
    }
  }

  function connect(): void {
    try {
      port = chrome.runtime.connect({ name: HOSTED_PORT });
    } catch {
      port = null; // The extension was reloaded; this context is orphaned.
      return;
    }
    port.onMessage.addListener((message: HostedWorkerMessage) => {
      if (!isRecord(message) || message.type !== "request" || typeof message.id !== "number") return;
      void handle(message.request)
        .catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        .then(response => post({ type: "response", id: message.id, response }));
    });
    port.onDisconnect.addListener(() => {
      port = null;
      // The worker stops when idle. Reconnecting wakes it, so a hosted session
      // survives worker restarts. A reloaded extension has no runtime id.
      if (chrome.runtime?.id) setTimeout(connect, 100);
    });
    post({ type: "hello", frame: frameKey, href: location.href, depth: ancestors.length });
  }
  connect();
})();
