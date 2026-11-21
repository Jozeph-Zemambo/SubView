// Debug tools only. A page-world script for frames inside a page SubView hosts,
// registered (before the shim) only while "hosted debug" is switched on. It
// records what went wrong while the copy loaded: failed requests, script
// errors, the connections the page opens, and where a redirect was started
// from. Nothing is recorded, and no page function is wrapped, unless a
// developer turned it on.
//
// The trail stays in the frame's memory, addresses without their query
// strings, and is handed to SubView's agent only when it asks (DESCRIBE).

(() => {
  const ancestors = Array.from(location.ancestorOrigins ?? []);
  const top = ancestors[ancestors.length - 1];
  if (!top || !top.startsWith("chrome-extension://")) return;
  const own = /chrome-extension:\/\/[a-p]{32}/.exec(new Error().stack ?? "")?.[0];
  if (own && top !== own) return;

  const trail: string[] = [];
  const note = (entry: string) => { if (trail.length < 600) trail.push(`${Math.round(performance.now())}ms ${entry}`); };
  const where = (input: unknown) => {
    try { const url = new URL(String(input), location.href); return `${url.host}${url.pathname}`.slice(0, 120); }
    catch { return String(input).slice(0, 60); }
  };

  // A copy that sends itself to another page (an error screen, say) would lose
  // the reason with the old document. The frame's own session storage, which no
  // tab of the viewer's shares, carries the trail across that one hop.
  const TRAIL_KEY = "__subview_hosted_trail";
  let carried: Storage | null = null;
  try {
    carried = window.sessionStorage;
    const previous = carried.getItem(TRAIL_KEY);
    carried.removeItem(TRAIL_KEY);
    if (previous) trail.push(...(JSON.parse(previous) as string[]).slice(-200), "--- the page then moved to this address ---");
  } catch { carried = null; }
  window.addEventListener("pagehide", () => {
    try { carried?.setItem(TRAIL_KEY, JSON.stringify([...trail, `${Math.round(performance.now())}ms leaving ${location.host}${location.pathname}`])); } catch { /* Storage unavailable. */ }
  });
  try {
    note(`start ${location.host}${location.pathname} online=${navigator.onLine} cookies=${document.cookie.length}ch stored-keys=${Object.keys(window.localStorage).length} frames-above=${ancestors.length}`);
  } catch { note(`start ${location.host}${location.pathname} (storage unavailable)`); }

  const nativeFetch = window.fetch;
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const target = where(input instanceof Request ? input.url : input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    note(`> ${method} ${target}`);
    return nativeFetch.call(this, input, init).then(
      response => { if (response.status >= 400) note(`${method} ${target} -> ${response.status}`); return response; },
      error => { note(`${method} ${target} failed: ${String((error as Error)?.message ?? error).slice(0, 80)}`); throw error; },
    );
  } as typeof window.fetch;
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    note(`> ${String(method).toUpperCase()} ${where(url)}`);
    this.addEventListener("loadend", () => {
      if (this.status === 0 || this.status >= 400) note(`${String(method).toUpperCase()} ${where(url)} -> ${this.status || "failed"}`);
    });
    return (nativeOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  window.addEventListener("error", event => note(`error: ${String(event.message).slice(0, 140)}`));
  window.addEventListener("unhandledrejection", event => note(`rejected: ${String((event.reason as Error)?.message ?? event.reason).slice(0, 140)}`));

  const NativeWebSocket = window.WebSocket;
  if (NativeWebSocket) {
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        note(`socket ${where(url)} opening`);
        this.addEventListener("error", () => note(`socket ${where(url)} error`));
        this.addEventListener("close", event => note(`socket ${where(url)} closed (${event.code})`));
      }
    };
  }
  // Other ways a page keeps a connection or coordinates with its own tabs.
  for (const name of ["EventSource", "SharedWorker", "Worker"] as const) {
    const Native = window[name] as unknown as (new (...args: unknown[]) => object) | undefined;
    if (!Native) continue;
    (window as unknown as Record<string, unknown>)[name] = class extends Native {
      constructor(...args: unknown[]) { super(...args); note(`${name} ${where(args[0])}`); }
    };
  }
  window.addEventListener("storage", event => { if (event.key !== TRAIL_KEY) note(`storage event ${String(event.key).slice(0, 40)}`); });

  // Where a navigation was started from: the first frames of the call stack.
  const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
  navigation?.addEventListener("navigate", event => {
    const details = event as unknown as { destination?: { url?: string }; navigationType?: string };
    const stack = (new Error().stack ?? "").split("\n").slice(2, 7)
      .map(line => line.trim().replace(/^at /, "").replace(/https?:\/\/[^/]+/, "").slice(0, 90)).join(" < ");
    note(`navigate (${details.navigationType}) to ${where(details.destination?.url)} from ${stack || "no script"}`);
  });

  // The player's own milestones, to line presses and requests up against.
  let ticks = 0;
  for (const type of ["loadstart", "loadedmetadata", "canplay", "playing", "waiting", "emptied", "seeking", "pause", "timeupdate"]) {
    document.addEventListener(type, event => {
      const video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      if (type === "timeupdate" && (video.currentTime <= 0 || ++ticks > 4)) return;
      note(`video ${type} at ${video.currentTime.toFixed(2)}s ready=${video.readyState}${video.paused ? " paused" : ""}`);
    }, true);
  }

  document.addEventListener("subview-trail-request", () => {
    document.dispatchEvent(new CustomEvent("subview-trail", { detail: JSON.stringify(trail) }));
  });
})();
