import { build } from "esbuild";
import { cp, mkdtemp, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

// A failed compile must not erase an extension already loaded in Chrome.
const staging = await mkdtemp(resolve(root, ".subview-build-"));

try {

const sharedBuildOptions = {
  absWorkingDir: root,
  bundle: true,
  legalComments: "none",
  logLevel: "info",
  minify: false,
  outdir: staging,
  platform: "browser",
  sourcemap: true,
  target: "es2022",
};

// Service workers and the popup explicitly opt into modules. Files injected
// through chrome.scripting.executeScript are classic scripts, so the content
// entry must be wrapped as an IIFE rather than ending in an `export` statement.
await build({
  ...sharedBuildOptions,
  format: "esm",
  entryPoints: {
    "background/service-worker": "src/background/service-worker.ts",
    "popup/popup": "src/popup/popup.ts",
    "popup/debug": "src/popup/debug.ts",
    "offscreen/offscreen": "src/offscreen/offscreen.ts",
    "host/host": "src/host/host.ts",
  },
});

await build({
  ...sharedBuildOptions,
  format: "iife",
  entryPoints: {
    "content/content-entry": "src/content/content-entry.ts",
    // Registered only while Auto Dub hosts an episode page (background/hosted-host.ts).
    "hosted/hosted-shim": "src/hosted/hosted-shim.ts",
    "hosted/hosted-agent": "src/hosted/hosted-agent.ts",
  },
});

await cp(resolve(root, "manifest.json"), resolve(staging, "manifest.json"));
await cp(resolve(root, "src/popup/popup.html"), resolve(staging, "popup.html"));
await cp(resolve(root, "src/popup/popup.css"), resolve(staging, "popup.css"));
await cp(resolve(root, "src/popup/debug.html"), resolve(staging, "debug.html"));
await cp(resolve(root, "src/popup/debug.css"), resolve(staging, "debug.css"));
await cp(resolve(root, "src/popup/fonts"), resolve(staging, "fonts"), { recursive: true });
await cp(resolve(root, "src/icons"), resolve(staging, "icons"), { recursive: true });
await cp(resolve(root, "src/offscreen/offscreen.html"), resolve(staging, "offscreen.html"));
await cp(resolve(root, "src/host/host.html"), resolve(staging, "host.html"));

await rm(dist, { recursive: true, force: true });
await rename(staging, dist);

console.log(`Built extension into ${dist}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
