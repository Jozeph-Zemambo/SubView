// Zips dist/ into release/subview-<version>.zip, the file attached to a GitHub
// release. Run through `npm run package`, which builds first.
// Source maps stay out: they hold the full TypeScript source and triple the size.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const { version } = JSON.parse(await readFile(resolve(dist, "manifest.json"), "utf8"));
const target = resolve(root, "release", `subview-${version}.zip`);

await mkdir(resolve(root, "release"), { recursive: true });
await rm(target, { force: true });
// -X: no macOS extra attributes.
const zip = spawnSync("zip", ["-r", "-X", "-q", target, ".", "-x", "*.map", "-x", "*.DS_Store"], { cwd: dist, stdio: "inherit" });
if (zip.status !== 0) throw new Error("zip failed");
console.log(`Packaged ${target}`);
