// The island's size (src/core/scale.ts): the sizes Settings offers, what a
// stored value reads as, and the pixel ratio the canvases are painted at.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ISLAND_SCALES, canvasRatio, clampedScale, islandScale, scaleLabel } from "../src/core/scale.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the island is its usual size until Settings says otherwise", () => {
  assert.equal(DEFAULT_SETTINGS.islandScale, 1);
  assert.equal(islandScale(DEFAULT_SETTINGS.islandScale), 1);
  assert.equal(ISLAND_SCALES[0], 1);
});

test("a size is one of the four, the nearest one for anything else", () => {
  assert.deepEqual([...ISLAND_SCALES], [1, 1.1, 1.25, 1.5]);
  for (const size of ISLAND_SCALES) assert.equal(islandScale(size), size);
  assert.equal(islandScale(1.2), 1.25);
  assert.equal(islandScale(1.13), 1.1);
  assert.equal(islandScale(1.4), 1.5);
  assert.equal(islandScale(0.2), 1);
  assert.equal(islandScale(-3), 1);
  assert.equal(islandScale(9), 1.5);
});

test("a value that is not a number is the usual size", () => {
  for (const value of [undefined, null, "1.5", NaN, Infinity, -Infinity, {}, [], true]) {
    assert.equal(islandScale(value), 1, String(value));
  }
});

test("Rust offers the same sizes", () => {
  const rust = readFileSync(join(ROOT, "src-tauri/src/scale.rs"), "utf8");
  const allowed = rust.match(/pub const ALLOWED: \[f64; (\d+)\] = (\[[^;]+\]);/);
  assert.ok(allowed);
  assert.equal(Number(allowed[1]), ISLAND_SCALES.length);
  assert.deepEqual(JSON.parse(allowed[2]), [...ISLAND_SCALES]);
});

test("Settings shows a size as a percentage", () => {
  assert.deepEqual(ISLAND_SCALES.map(scaleLabel), ["100 %", "110 %", "125 %", "150 %"]);
});

test("Settings says which size a display holds the island to, only when it is less than the one picked", () => {
  // The island has the size picked: nothing to say.
  for (const size of ISLAND_SCALES) assert.equal(clampedScale(size, size), null, String(size));
  // 150 % picked on a display that only fits 125 %, or nothing but the usual size.
  assert.equal(clampedScale(1.5, 1.25), 1.25);
  assert.equal(clampedScale(1.5, 1), 1);
  assert.equal(clampedScale(1.1, 1), 1);
  assert.equal(scaleLabel(clampedScale(1.5, 1.25)), "125 %");
  // Not known yet (before Rust has said, or while a new size is on its way).
  assert.equal(clampedScale(1.5, null), null);
  // Never the other way round, and stored values read as islandScale reads them.
  assert.equal(clampedScale(1, 1.5), null);
  assert.equal(clampedScale("big", 1), null);
  assert.equal(clampedScale(1.49, 1.24), 1.25);
});

test("the size in force travels with boot and island-scale, under the names the page reads", () => {
  const lib = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
  const island = readFileSync(join(ROOT, "src-tauri/src/island.rs"), "utf8");
  // BootInfo is sent in camelCase: `scale_in_force` arrives as `scaleInForce`.
  assert.match(lib, /#\[serde\(rename_all = "camelCase"\)\]\s*pub struct BootInfo \{[^}]*\bscale_in_force: f64,/);
  assert.match(lib, /pub struct BootInfo \{[^}]*\bparked: bool,/);
  assert.match(island, /pub const SCALE_EVENT: &str = "island-scale";/);
  const settings = readFileSync(join(ROOT, "src/settings/main.ts"), "utf8");
  assert.ok(settings.includes('onEvent<number>("island-scale"'));
  assert.ok(settings.includes("boot.scaleInForce"));
});

test("at the usual size a canvas is painted as it always was: the display's ratio, 2 at most", () => {
  for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
    assert.equal(canvasRatio(dpr, 1), Math.min(2, dpr), String(dpr));
  }
  for (const nothing of [0, NaN, undefined, -1]) assert.equal(canvasRatio(nothing, 1), 1);
});

test("a bigger island is painted at the ratio its zoom gives, never stretched", () => {
  // The webview reports the display's scale times the island's size.
  for (const display of [1, 1.25, 1.5, 2]) {
    for (const size of ISLAND_SCALES) {
      assert.equal(canvasRatio(display * size, size), display * size, `${display} × ${size}`);
    }
  }
  // 150 % on a display at 150 %: 2.25, past the old cap of 2.
  assert.equal(canvasRatio(2.25, 1.5), 2.25);
  // The cap grows with the island and still holds on a denser display.
  assert.equal(canvasRatio(3 * 1.5, 1.5), 3);
  assert.equal(canvasRatio(4, 1.25), 2.5);
  // A size that is not one of the four counts as the nearest one.
  assert.equal(canvasRatio(4, "big"), 2);
  assert.equal(canvasRatio(4, 1.49), 3);
});
