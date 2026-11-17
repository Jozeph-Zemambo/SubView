// Page-world shim for frames inside a page SubView hosts (the hidden offscreen
// document or the minimized fallback window). It runs at document_start, before
// the site's own scripts, and is registered only while a hosted Dub page exists.
//
// Offscreen documents never lay out or paint, so players that wait for a size,
// for visibility or for an animation frame never start. This reports a visible,
// sized, painting page. It also gives the hosted copy private storage writes, so
// selecting Dub there never changes the user's own tabs.
//
// The page world cannot read chrome.runtime.id. Where a content script's stack
// names its extension URL, only frames under SubView's own pages change. Where
// it doesn't (stack formats differ across Chrome builds), any extension page
// ancestor qualifies: the script is registered only while SubView hosts a page,
// and without it the hosted copy could write the user's real storage.
//
// The shim marks the document once storage isolation is installed. The
// isolated-world agent refuses to change the page's Sub/Dub controls without it.

(() => {
  const ancestors = Array.from(location.ancestorOrigins ?? []);
  const top = ancestors[ancestors.length - 1];
  if (!top || !top.startsWith("chrome-extension://")) return;
  const own = /chrome-extension:\/\/[a-p]{32}/.exec(new Error().stack ?? "")?.[0];
  if (own && top !== own) return;
  const gate = own ? "exact" : "prefix";

  const WIDTH = 1280;
  const HEIGHT = 720;

  const getter = (target: object, key: string, get: () => unknown) =>
    Object.defineProperty(target, key, { configurable: true, get });

  // Visibility and focus.
  getter(Document.prototype, "visibilityState", () => "visible");
  getter(Document.prototype, "hidden", () => false);
  Document.prototype.hasFocus = () => true;

  // Sizes: keep real values, substitute a player-sized box only where layout reports zero.
  const withFallback = (proto: object, key: string, fallback: number) => {
    const native = Object.getOwnPropertyDescriptor(proto, key);
    if (!native?.get) return;
    const read = native.get;
    Object.defineProperty(proto, key, {
      configurable: true,
      get(this: unknown) { return read.call(this) || fallback; },
    });
  };
  for (const proto of [Element.prototype, HTMLElement.prototype]) {
    withFallback(proto, "clientWidth", WIDTH);
    withFallback(proto, "clientHeight", HEIGHT);
    withFallback(proto, "offsetWidth", WIDTH);
    withFallback(proto, "offsetHeight", HEIGHT);
  }
  for (const [key, fallback] of [["innerWidth", WIDTH], ["innerHeight", HEIGHT], ["outerWidth", WIDTH], ["outerHeight", HEIGHT]] as const) {
    const native = Object.getOwnPropertyDescriptor(window, key);
    if (native?.get) {
      const read = native.get;
      Object.defineProperty(window, key, { configurable: true, get: () => read.call(window) || fallback });
    }
  }
  const nativeRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const rect = nativeRect.call(this);
    return rect.width || rect.height ? rect : new DOMRect(0, 0, WIDTH, HEIGHT);
  };

  // Observers never fire without layout; report every target as on-screen and sized.
  const box = new DOMRect(0, 0, WIDTH, HEIGHT);
  const NativeIntersectionObserver = window.IntersectionObserver;
  if (NativeIntersectionObserver) {
    window.IntersectionObserver = class extends NativeIntersectionObserver {
      readonly #callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super(callback, options);
        this.#callback = callback;
      }
      override observe(target: Element): void {
        super.observe(target);
        queueMicrotask(() => this.#callback([{
          target, isIntersecting: true, intersectionRatio: 1, time: performance.now(),
          boundingClientRect: box, intersectionRect: box, rootBounds: box,
        } as IntersectionObserverEntry], this));
      }
    };
  }
  const NativeResizeObserver = window.ResizeObserver;
  if (NativeResizeObserver) {
    window.ResizeObserver = class extends NativeResizeObserver {
      readonly #callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        this.#callback = callback;
      }
      override observe(target: Element, options?: ResizeObserverOptions): void {
        super.observe(target, options);
        const size = [{ inlineSize: WIDTH, blockSize: HEIGHT }];
        queueMicrotask(() => this.#callback([{
          target, contentRect: box, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size,
        } as unknown as ResizeObserverEntry], this));
      }
    };
  }

  // Animation frames: a page that never paints never runs them. Drive them from a timer.
  const frames = new Map<number, ReturnType<typeof setTimeout>>();
  let nextFrame = 0;
  window.requestAnimationFrame = callback => {
    const handle = ++nextFrame;
    frames.set(handle, setTimeout(() => { frames.delete(handle); callback(performance.now()); }, 16));
    return handle;
  };
  window.cancelAnimationFrame = handle => {
    clearTimeout(frames.get(handle));
    frames.delete(handle);
  };

  // Storage: reads fall through to the real store; writes stay in this page's memory.
  const overlay = (real: Storage): Storage => {
    const writes = new Map<string, string | null>();
    let cleared = false;
    const keys = () => {
      const all = new Set(cleared ? [] : Object.keys(real));
      for (const [key, value] of writes) value === null ? all.delete(key) : all.add(key);
      return [...all];
    };
    const api = {
      getItem: (key: string) => {
        key = String(key);
        if (writes.has(key)) return writes.get(key) ?? null;
        return cleared ? null : real.getItem(key);
      },
      setItem: (key: string, value: string) => { writes.set(String(key), String(value)); },
      removeItem: (key: string) => { writes.set(String(key), null); },
      clear: () => { writes.clear(); cleared = true; },
      key: (index: number) => keys()[index] ?? null,
      get length() { return keys().length; },
    };
    return new Proxy(api, {
      get: (target, prop) => prop in target
        ? target[prop as keyof typeof target]
        : typeof prop === "string" ? target.getItem(prop) ?? undefined : undefined,
      set: (target, prop, value) => { target.setItem(String(prop), value); return true; },
      deleteProperty: (target, prop) => { target.removeItem(String(prop)); return true; },
      // Storage has no real property slots: defining one is a write, never a slot on the API object.
      // Accessors and non-configurable/non-writable slots are unsupported: reject
      // them before touching storage (Proxy invariants forbid reporting them).
      defineProperty: (target, prop, descriptor) => {
        if ("get" in descriptor || "set" in descriptor || descriptor.configurable === false ||
            descriptor.writable === false || !("value" in descriptor)) return false;
        target.setItem(String(prop), descriptor.value);
        return true;
      },
      has: (target, prop) => prop in target || target.getItem(String(prop)) !== null,
      ownKeys: () => keys(),
      getOwnPropertyDescriptor: (target, prop) => {
        const value = target.getItem(String(prop));
        return value === null ? undefined : { value, enumerable: true, configurable: true };
      },
    }) as unknown as Storage;
  };
  let isolated = true;
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const store = overlay(window[name]);
      getter(window, name, () => store);
      if (window[name] !== store) isolated = false;
    } catch {
      // Opaque origins have no storage to isolate; anything else is a failure.
      try { void window[name]; isolated = false; } catch { /* Storage unavailable. */ }
    }
  }
  if (isolated) {
    const ATTRIBUTE = "data-subview-isolation";
    const mark = () => {
      const root = document.documentElement;
      if (root && root.getAttribute(ATTRIBUTE) !== gate) root.setAttribute(ATTRIBUTE, gate);
    };
    if (document.documentElement) mark();
    else document.addEventListener("readystatechange", mark, { once: true });
    // Frameworks that hydrate or replace <html> drop unknown
    // attributes; the agent refuses to act without the mark, so keep it there.
    const keep = new MutationObserver(() => {
      mark();
      if (document.documentElement) keep.observe(document.documentElement, { attributes: true, attributeFilter: [ATTRIBUTE] });
    });
    keep.observe(document, { childList: true });
    if (document.documentElement) keep.observe(document.documentElement, { attributes: true, attributeFilter: [ATTRIBUTE] });
  }

  // Same-origin tabs can also sync over BroadcastChannel. Keep hosted channels private.
  const NativeBroadcastChannel = window.BroadcastChannel;
  if (NativeBroadcastChannel) {
    window.BroadcastChannel = class extends NativeBroadcastChannel {
      constructor(name: string) { super(`subview-hosted:${name}`); }
    };
  }
})();
