// Mounts the episode page SubView hosts for Dub audio. The frame is the site's
// own page; the worker's session rules and the hosted shim make it load and
// play inside an extension document.

const FRAME_ID = "subview-hosted-page";

/**
 * Some pages refuse to run inside another page: they try to take over the
 * whole window, and when the browser refuses, they replace themselves with an
 * error screen. A lenient frame is allowed to make that attempt. The hidden
 * document cannot be navigated, so the attempt does nothing and the page
 * carries on. Lenient is a retry, never the default: a sandbox attribute is
 * itself something other players look for and refuse, and in a window the
 * takeover would succeed.
 */
const LENIENT_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-presentation allow-pointer-lock allow-orientation-lock allow-downloads allow-top-navigation";

export function mountHostedPage(url: string, lenient = false): void {
  unmountHostedPage();
  const frame = document.createElement("iframe");
  frame.id = FRAME_ID;
  frame.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
  if (lenient) frame.setAttribute("sandbox", LENIENT_SANDBOX);
  frame.style.cssText = "width:1280px;height:720px;border:0";
  frame.src = url;
  document.body.append(frame);
}

export function unmountHostedPage(): void {
  document.getElementById(FRAME_ID)?.remove();
}
