// When the island's frame loop may stop (src/core/frames.ts): open, closed,
// and parked off-screen while another app is full screen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { breathes, countdownShare, countdownWindow, livInSight, livesOnTimer, needsFrame } from "../src/core/frames.ts";

const still = {
  settling: false, botMoving: false, robotChanging: false, uploading: false, viewAnimating: false,
  countingDown: false,
};
const work = (over) => ({ ...still, ...over });
const scene = (mode, over = {}) => ({ mode, closedRobot: true, parked: false, paused: false, ...over });

test("nothing moving asks for no frame, wherever the island is", () => {
  for (const mode of ["hidden", "compact", "expanded"]) {
    for (const parked of [false, true]) assert.equal(needsFrame(scene(mode, { parked }), still), false);
  }
});

test("an island on screen runs for anything that moves", () => {
  for (const mode of ["compact", "expanded"]) {
    for (const key of Object.keys(still)) {
      // The countdown bar only exists under the open island (below).
      if (key === "countingDown" && mode !== "expanded") continue;
      assert.equal(needsFrame(scene(mode), work({ [key]: true })), true, `${mode} ${key}`);
    }
  }
});

// ── The countdown bar ─────────────────────────────────────────────────────────

test("the countdown bar keeps the open island's loop going, and only that one", () => {
  const counting = work({ countingDown: true });
  assert.equal(needsFrame(scene("expanded"), counting), true);
  // Folded or closed there is no bar, and parked nobody sees it.
  assert.equal(needsFrame(scene("compact"), counting), false);
  assert.equal(needsFrame(scene("hidden"), counting), false);
  assert.equal(needsFrame(scene("expanded", { parked: true }), counting), false);
  // Once it is over, nothing is left to draw: the loop stops.
  assert.equal(needsFrame(scene("expanded"), still), false);
});

test("the bar comes into view for the last ten seconds, or less with a short delay", () => {
  assert.equal(countdownWindow(15), 9);
  assert.equal(countdownWindow(30), 10);
  assert.equal(countdownWindow(120), 10);
  assert.equal(countdownWindow(5), 3);
  assert.equal(countdownWindow(0), 0);
});

test("nothing of the bar shows before its window, then it shrinks to nothing", () => {
  // 15 s to fold: out of view for the first six.
  assert.equal(countdownShare(15, 15), 0);
  assert.equal(countdownShare(9.01, 15), 0);
  assert.equal(countdownShare(9, 15), 0, "the window opens just under nine seconds");
  assert.ok(Math.abs(countdownShare(8.99, 15) - 8.99 / 9) < 1e-12);
  assert.equal(countdownShare(4.5, 15), 0.5);
  assert.equal(countdownShare(0, 15), 0);
  // Late (the timer has not fired yet): nothing, so nothing asks for a frame.
  assert.equal(countdownShare(-0.2, 15), 0);
  // A long delay: the last ten seconds.
  assert.equal(countdownShare(11, 60), 0);
  assert.equal(countdownShare(5, 60), 0.5);
  // An island opened by a hover folds 0.6 s after the pointer leaves: the bar
  // is in view at once, as far along as that leaves it.
  assert.ok(Math.abs(countdownShare(0.6, 15) - 0.6 / 9) < 1e-12);
  // A share is a share, whatever comes in.
  for (const [left, delay] of [[3, 0], [NaN, 15], [3, NaN], [-5, 0]]) {
    const share = countdownShare(left, delay);
    assert.ok(share >= 0 && share <= 1, `${left} ${delay} -> ${share}`);
  }
});

test("closed, a ticker or a drop sequence costs nothing", () => {
  assert.equal(needsFrame(scene("hidden"), work({ viewAnimating: true, uploading: true })), false);
  assert.equal(needsFrame(scene("hidden"), work({ settling: true })), true);
  // Liv in the closed island gets to its place and takes its state's lights.
  assert.equal(needsFrame(scene("hidden"), work({ botMoving: true })), true);
  assert.equal(needsFrame(scene("hidden"), work({ robotChanging: true })), true);
  // With something else in the closed island, Liv is not there to move.
  assert.equal(needsFrame(scene("hidden", { closedRobot: false }), work({ botMoving: true, robotChanging: true })), false);
  assert.equal(needsFrame(scene("hidden", { closedRobot: false }), work({ settling: true })), true);
});

test("parked for a full-screen app, only what is settling finishes", () => {
  const moving = work({ robotChanging: true, uploading: true, viewAnimating: true });
  for (const mode of ["hidden", "compact", "expanded"]) {
    const parked = scene(mode, { parked: true });
    // Liv breathing, a ticker, a card open on a permission request: no frame.
    assert.equal(needsFrame(parked, moving), false, mode);
    // The island folding or opening meanwhile ends where it should be.
    assert.equal(needsFrame(parked, work({ settling: true })), true, mode);
    assert.equal(needsFrame(parked, work({ botMoving: true })), true, mode);
  }
});

test("back on screen, the island animates as before", () => {
  const changing = work({ robotChanging: true });
  assert.equal(needsFrame(scene("compact", { parked: true }), changing), false);
  assert.equal(needsFrame(scene("compact", { parked: false }), changing), true);
});

test("Liv is in sight wherever the island draws it, and a change of clothes is only played there", () => {
  for (const mode of ["compact", "peek", "expanded"]) {
    assert.equal(livInSight(scene(mode)), true, mode);
    assert.equal(livInSight(scene(mode, { closedRobot: false })), true, mode);
    assert.equal(livInSight(scene(mode, { parked: true })), false, `${mode}, parked`);
  }
  // Folded: only when the closed island is the one that shows Liv.
  assert.equal(livInSight(scene("hidden")), true);
  assert.equal(livInSight(scene("hidden", { closedRobot: false })), false);
  assert.equal(livInSight(scene("hidden", { parked: true })), false);
  // Wherever it is not in sight, a robot that is changing asks for no frame: the change must not be a tween there.
  const changing = work({ robotChanging: true });
  for (const where of [scene("hidden", { closedRobot: false }), scene("expanded", { parked: true }), scene("hidden", { parked: true })]) {
    assert.equal(livInSight(where), false);
    assert.equal(needsFrame(where, changing), false);
  }
});

test("Liv breathes only on the open island, in sight and not paused", () => {
  assert.equal(breathes(scene("expanded")), true);
  assert.equal(breathes(scene("expanded", { closedRobot: false })), true, "whatever the closed island shows");
  assert.equal(breathes(scene("compact")), false);
  assert.equal(breathes(scene("hidden")), false);
  assert.equal(breathes(scene("expanded", { parked: true })), false);
  assert.equal(breathes(scene("expanded", { paused: true })), false);
});

test("closed with Liv in it, or compact, its life runs on one timer; never parked or paused", () => {
  assert.equal(livesOnTimer(scene("compact")), true);
  assert.equal(livesOnTimer(scene("compact", { closedRobot: false })), true);
  assert.equal(livesOnTimer(scene("hidden")), true);
  assert.equal(livesOnTimer(scene("hidden", { closedRobot: false })), false, "nothing to blink in a closed island that shows the time");
  // Open, it breathes: the frames are running anyway and it blinks by them.
  assert.equal(livesOnTimer(scene("expanded")), false);
  for (const mode of ["hidden", "compact", "expanded"]) {
    assert.equal(livesOnTimer(scene(mode, { parked: true })), false, mode);
    assert.equal(livesOnTimer(scene(mode, { paused: true })), false, mode);
    // Never both: one clock for Liv's life at a time.
    assert.ok(!(livesOnTimer(scene(mode)) && breathes(scene(mode))), mode);
  }
});

// ── Liv's pocket ──────────────────────────────────────────────────────────────

test("out in its pocket Liv moves like anywhere on screen, and the loop stops once it is at rest", () => {
  const pocket = scene("peek");
  assert.equal(needsFrame(pocket, still), false, "waiting there costs no frame");
  for (const key of ["settling", "botMoving", "robotChanging"]) {
    assert.equal(needsFrame(pocket, work({ [key]: true })), true, key);
  }
  // No countdown bar under a pocket, and parked nobody sees it.
  assert.equal(needsFrame(pocket, work({ countingDown: true })), false);
  assert.equal(needsFrame(scene("peek", { parked: true }), work({ robotChanging: true })), false);
});

test("in its pocket Liv does not breathe; it blinks and glances on the island's one timer", () => {
  assert.equal(breathes(scene("peek")), false);
  assert.equal(livesOnTimer(scene("peek")), true);
  assert.equal(livesOnTimer(scene("peek", { closedRobot: false })), true, "whatever the closed island shows");
  assert.equal(livesOnTimer(scene("peek", { parked: true })), false);
  assert.equal(livesOnTimer(scene("peek", { paused: true })), false);
});
