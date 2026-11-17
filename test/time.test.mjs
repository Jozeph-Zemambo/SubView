import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

// Import the implementation under test without maintaining a second copy of the
// TypeScript functions in the test suite. `esbuild` is already a dev dependency.
const sourceUrl = new URL("../src/shared/time.ts", import.meta.url);
const sourcePath = fileURLToPath(sourceUrl);
const source = await readFile(sourcePath, "utf8");
const { code } = await transform(source, {
  format: "esm",
  loader: "ts",
  sourcefile: sourcePath,
  target: "es2022",
});
const time = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("parseOffset accepts signed, padded offsets and rejects invalid fields", () => {
  assert.equal(time.parseOffset("00:00:00"), 0);
  assert.equal(time.parseOffset("1:02:03"), 3_723_000);
  assert.equal(time.parseOffset("  +01:02:03  "), 3_723_000);
  assert.equal(time.parseOffset("-12:34:56"), -45_296_000);

  for (const value of [
    "",
    "01:2:03",
    "01:02:3",
    "01:60:00",
    "01:00:60",
    "1000:00:00",
    "01:02:03.0000",
  ]) {
    assert.equal(time.parseOffset(value), null, `expected ${JSON.stringify(value)} to be invalid`);
  }
});

test("formatOffset emits a signed HH:MM:SS value and preserves subsecond precision", () => {
  assert.equal(time.formatOffset(0), "+00:00:00");
  assert.equal(time.formatOffset(3_723_000), "+01:02:03");
  assert.equal(time.formatOffset(-3_723_000), "-01:02:03");
  assert.equal(time.formatOffset(-3_723_999), "-01:02:03.999");
  assert.equal(time.formatOffset(100 * 60 * 60 * 1000), "+100:00:00");

  for (const milliseconds of [-3_723_999, -100, 0, 100, 3_723_000]) {
    assert.equal(time.parseOffset(time.formatOffset(milliseconds)), milliseconds);
  }
});

test("primary/secondary translation applies the signed offset in one direction", () => {
  assert.equal(time.translatePrimaryTime(12_345, 2_000, "primary"), 12_345);
  assert.equal(time.translatePrimaryTime(12_345, 2_000, "secondary"), 14_345);
  assert.equal(time.translatePrimaryTime(12_345, -2_000, "secondary"), 10_345);
  assert.equal(time.toPrimaryTime(14_345, 2_000, "secondary"), 12_345);
  assert.equal(time.toPrimaryTime(12_345, 2_000, "primary"), 12_345);

  for (const side of ["primary", "secondary"]) {
    for (const primaryTimeMs of [0, 1_234, -500]) {
      for (const offsetMs of [-2_000, 0, 3_500]) {
        const translated = time.translatePrimaryTime(primaryTimeMs, offsetMs, side);
        assert.equal(
          time.toPrimaryTime(translated, offsetMs, side),
          primaryTimeMs,
          `${side} translation should round-trip`,
        );
      }
    }
  }
});

test("clamp and clampToDuration enforce lower and upper bounds", () => {
  assert.equal(time.clamp(-1, 0, 10), 0);
  assert.equal(time.clamp(4, 0, 10), 4);
  assert.equal(time.clamp(11, 0, 10), 10);

  assert.equal(time.clampToDuration(-1, null), 0);
  assert.equal(time.clampToDuration(12_000, null), 12_000);
  assert.equal(time.clampToDuration(-1, 10_000), 0);
  assert.equal(time.clampToDuration(4_000, 10_000), 4_000);
  assert.equal(time.clampToDuration(12_000, 10_000), 10_000);
  assert.equal(time.clampToDuration(10_000, 10_000), 10_000);
});

test("targetIsPlayable excludes negative time and the exact finite-duration boundary", () => {
  assert.equal(time.targetIsPlayable(-1, null), false);
  assert.equal(time.targetIsPlayable(0, null), true);
  assert.equal(time.targetIsPlayable(1_000_000, null), true);

  assert.equal(time.targetIsPlayable(-1, 10_000), false);
  assert.equal(time.targetIsPlayable(0, 10_000), true);
  assert.equal(time.targetIsPlayable(9_999.999, 10_000), true);
  assert.equal(time.targetIsPlayable(10_000, 10_000), false);
  assert.equal(time.targetIsPlayable(10_001, 10_000), false);
  assert.equal(time.targetIsPlayable(0, 0), false);
});

test("pure helpers preserve finite-value and duration-format invariants", () => {
  assert.equal(time.finiteOrNull(0), 0);
  assert.equal(time.finiteOrNull(-3.5), -3.5);
  assert.equal(time.finiteOrNull(Number.NaN), null);
  assert.equal(time.finiteOrNull(Number.POSITIVE_INFINITY), null);
  assert.equal(time.finiteOrNull(Number.NEGATIVE_INFINITY), null);

  assert.equal(time.formatDuration(null), "Unknown length");
  assert.equal(time.formatDuration(Number.NaN), "Unknown length");
  assert.equal(time.formatDuration(Number.POSITIVE_INFINITY), "Unknown length");
  assert.equal(time.formatDuration(-1), "0:00");
  assert.equal(time.formatDuration(999), "0:01");
  assert.equal(time.formatDuration(90_000), "1:30");
  assert.equal(time.formatDuration(3_661_000), "1:01:01");

  assert.equal(time.isWithinTolerance(1_000, 1_350, 350), true);
  assert.equal(time.isWithinTolerance(1_000, 1_351, 350), false);
  assert.equal(time.isWithinTolerance(1_350, 1_000, 350), true);
});
