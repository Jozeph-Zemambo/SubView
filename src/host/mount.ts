// Mounts the episode page SubView hosts for Dub audio. The frame is the site's
// own page; the worker's session rules and the hosted shim make it load and
// play inside an extension document.

const FRAME_ID = "subview-hosted-page";

export function mountHostedPage(url: string): void {
  unmountHostedPage();
  const frame = document.createElement("iframe");
  frame.id = FRAME_ID;
  frame.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
  frame.style.cssText = "width:1280px;height:720px;border:0";
  frame.src = url;
  document.body.append(frame);
}

export function unmountHostedPage(): void {
  document.getElementById(FRAME_ID)?.remove();
}
