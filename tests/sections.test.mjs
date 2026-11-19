// Where the island opens again, and how soon it closes (src/core/sections.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPACT_CLOSE_CHOICES, DEFAULT_COMPACT_CLOSE, compactCloseDelay, reopensOn, sectionToRemember,
} from "../src/core/sections.ts";

test("a section of its own is remembered as the island folds; an alert's card is not", () => {
  for (const view of ["prompt", "upload", "launch", "tools", "settings"]) assert.equal(sectionToRemember(view), view, view);
  // The overview is where it opens anyway; the rest come up for what happened and go with it.
  for (const view of ["overview", "empty", "approval", "question", "finished", "error", "note", "update", "whatsNew", "recap", "wardrobe", "uploading", "choose"]) {
    assert.equal(sectionToRemember(view), null, view);
  }
});

test("the island opens on the section it was folded on, a waiting card first", () => {
  assert.equal(reopensOn("tools", "overview", false), "tools");
  assert.equal(reopensOn(null, "overview", false), "overview");
  assert.equal(reopensOn(null, "empty", false), "empty");
  // A permission or a question waits: its card, whatever was remembered.
  assert.equal(reopensOn("tools", "approval", true), "approval");
  assert.equal(reopensOn("prompt", "question", true), "question");
});

test("the compact island closes after the delay chosen, at once included", () => {
  assert.deepEqual(COMPACT_CLOSE_CHOICES, [0, 5, 15, 30, 60, 300]);
  assert.equal(DEFAULT_COMPACT_CLOSE, 60);
  for (const seconds of COMPACT_CLOSE_CHOICES) assert.equal(compactCloseDelay(seconds), seconds);
  assert.equal(compactCloseDelay(0), 0, "at once is a choice, not a missing value");
  assert.equal(compactCloseDelay(45), 45, "one written by hand counts too");
  // A settings file from before the choice existed, or one that says nonsense: the usual minute.
  for (const bad of [undefined, null, "5", NaN, -1, 601, Infinity]) assert.equal(compactCloseDelay(bad), 60);
});
