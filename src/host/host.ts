// Fallback container: the same hosted page in a minimized extension window,
// for sites whose player will not start inside the offscreen document.
import { mountHostedPage } from "./mount";

const url = new URLSearchParams(location.search).get("url");
if (url && /^https?:\/\//.test(url)) {
  document.title = `SubView Dub · ${new URL(url).hostname}`;
  mountHostedPage(url);
}
