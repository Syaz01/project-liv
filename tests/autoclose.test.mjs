// The auto-close delays the island's own settings card offers (src/core/autoclose.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_CLOSE_PRESETS, autoCloseChoices } from "../src/core/autoclose.ts";

test("the usual delays, as they are, while one of them is in force", () => {
  for (const preset of AUTO_CLOSE_PRESETS) assert.deepEqual(autoCloseChoices(preset), [10, 15, 30]);
});

test("a delay only Settings offers joins the choices, in its place", () => {
  assert.deepEqual(autoCloseChoices(5), [5, 10, 15, 30]);
  assert.deepEqual(autoCloseChoices(20), [10, 15, 20, 30]);
  assert.deepEqual(autoCloseChoices(120), [10, 15, 30, 120]);
});

test("what is not a delay adds nothing, and the presets are never changed", () => {
  for (const odd of [0, -5, NaN, Infinity, undefined]) assert.deepEqual(autoCloseChoices(odd), [10, 15, 30]);
  autoCloseChoices(5).push(99);
  assert.deepEqual([...AUTO_CLOSE_PRESETS], [10, 15, 30]);
});
