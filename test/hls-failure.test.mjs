import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const sourcePath = fileURLToPath(new URL("../src/offscreen/hls-failure.ts", import.meta.url));
const source = await readFile(sourcePath, "utf8");
const { code } = await transform(source, {
  format: "esm",
  loader: "ts",
  sourcefile: sourcePath,
  target: "es2022",
});
const { formatHlsFailure } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`,
);

test("formats a manifest HTTP failure without exposing arbitrary error data", () => {
  const message = formatHlsFailure({
    details: "manifestLoadError",
    response: { code: 403, text: "token=manifest-secret" },
    url: "https://media.example.test/live.m3u8?token=url-secret",
    headers: { authorization: "Bearer header-secret" },
    error: new Error("token=message-secret"),
    reason: "token=reason-secret",
  });

  assert.equal(
    message,
    "HLS playback failed: details=manifestLoadError; stage=manifest; kind=load; HTTP 403",
  );
  assert.doesNotMatch(message, /secret|token|media\.example|authorization/i);
});

test("formats a segment HTTP failure with the segment stage", () => {
  assert.equal(
    formatHlsFailure({ details: "fragLoadError", response: { code: 404 } }),
    "HLS playback failed: details=fragLoadError; stage=segment; kind=load; HTTP 404",
  );
});

test("describes response code zero as no HTTP response without guessing why", () => {
  const message = formatHlsFailure({ details: "manifestLoadError", response: { code: 0 } });
  assert.match(message, /manifest/);
  assert.match(message, /no HTTP response/);
  assert.doesNotMatch(message, /cors/i);
});

test("distinguishes timeout, decode, and codec failures", () => {
  const cases = [
    ["fragLoadTimeOut", "stage=segment; kind=timeout"],
    ["fragParsingError", "stage=segment; kind=decode"],
    ["bufferIncompatibleCodecsError", "stage=codec; kind=codec"],
  ];

  for (const [details, expected] of cases) {
    assert.match(formatHlsFailure({ details }), new RegExp(expected));
  }
});

test("uses an allowlisted unknown result and redacts all unknown fields", () => {
  const message = formatHlsFailure({
    details: "totally-secret-detail",
    type: "networkError",
    response: { code: 500, text: "header-secret" },
    url: "https://media.example.test/secret.m3u8?token=url-secret",
    headers: { authorization: "Bearer header-secret" },
    error: { message: "message-secret" },
    reason: "reason-secret",
  });

  assert.equal(message, "HLS playback failed: details=unknown; stage=unknown; kind=unknown; HTTP 500");
  assert.doesNotMatch(message, /secret|token|media\.example|authorization/i);
});
