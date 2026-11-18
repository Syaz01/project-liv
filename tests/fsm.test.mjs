// Island open/close state machine (src/island/fsm.ts).

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { IslandStateMachine, PEEK_HOLD } from "../src/island/fsm.ts";

let fsm;
let transitions;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  fsm = new IslandStateMachine();
  transitions = [];
  fsm.onTransition = (from, to) => transitions.push(`${from}>${to}`);
});

afterEach(() => mock.timers.reset());

const seconds = (n) => mock.timers.tick(n * 1000);

test("starts hidden and shows itself compact at launch, as for a work event", () => {
  assert.equal(fsm.state, "hidden");
  fsm.reveal();
  assert.equal(fsm.state, "petit");
  assert.deepEqual(transitions, ["hidden>petit"]);
});

test("the mouse wakes a hidden island, which stays while it is hovered", () => {
  fsm.mouseEntered();
  assert.equal(fsm.state, "petit");
  seconds(600);
  assert.equal(fsm.state, "petit");
});

test("the compact island hides 60 s after the mouse leaves", () => {
  fsm.mouseEntered();
  fsm.mouseLeft();
  seconds(59);
  assert.equal(fsm.state, "petit");
  seconds(1);
  assert.equal(fsm.state, "hidden");
});

test("coming back before the 60 s are up cancels the hide", () => {
  fsm.mouseEntered();
  fsm.mouseLeft();
  seconds(59);
  fsm.mouseEntered();
  seconds(600);
  assert.equal(fsm.state, "petit");
});

test("a click opens the compact island, and only the compact island", () => {
  fsm.click();
  assert.equal(fsm.state, "hidden");
  fsm.mouseEntered();
  fsm.click();
  assert.equal(fsm.state, "home");
  fsm.click();
  assert.equal(fsm.state, "home");
  assert.deepEqual(transitions, ["hidden>petit", "petit>home"]);
});

test("the open island collapses 15 s after the mouse leaves", () => {
  fsm.forceHome();
  fsm.mouseLeft();
  seconds(14);
  assert.equal(fsm.state, "home");
  seconds(1);
  assert.equal(fsm.state, "petit");
});

test("coming back to the open island cancels the collapse", () => {
  fsm.forceHome();
  fsm.mouseLeft();
  seconds(14);
  fsm.mouseEntered();
  seconds(600);
  assert.equal(fsm.state, "home");
});

test("a pinned island stays open when the mouse leaves", () => {
  fsm.forceHome();
  fsm.pinned = true;
  fsm.mouseLeft();
  seconds(600);
  assert.equal(fsm.state, "home");
});

test("the collapse delay is the configured one", () => {
  fsm.homeToPetitDelay = 5;
  fsm.forceHome();
  fsm.mouseLeft();
  seconds(5);
  assert.equal(fsm.state, "petit");
});

test("reveal shows the compact island from hidden and hides it again after 60 s", () => {
  fsm.reveal();
  assert.equal(fsm.state, "petit");
  seconds(60);
  assert.equal(fsm.state, "hidden");
});

test("reveal leaves an island that is already showing alone", () => {
  fsm.forceHome();
  fsm.reveal();
  assert.equal(fsm.state, "home");
  assert.deepEqual(transitions, ["hidden>home"]);
});

test("forcing the island open cancels a pending hide", () => {
  fsm.reveal();
  fsm.forceHome();
  seconds(600);
  assert.equal(fsm.state, "home");
});

test("an explicit close goes to the compact island and cancels the collapse", () => {
  fsm.forceHome();
  fsm.mouseLeft();
  fsm.forcePetit();
  assert.equal(fsm.state, "petit");
  seconds(600);
  assert.equal(fsm.state, "petit");
});

test("forceHidden hides from any state", () => {
  fsm.forceHome();
  fsm.forceHidden();
  assert.equal(fsm.state, "hidden");
});

test("a transition to the current state is not reported", () => {
  fsm.forceHome();
  fsm.forceHome();
  assert.deepEqual(transitions, ["hidden>home"]);
});

// ── Auto-close delay from Settings (IslandAutoCloseTests.swift) ──────────────

/**
 * Opened on its own (an alert, a shortcut), the pointer elsewhere: the one
 * case the auto-close delay counts for.
 */
function opened(delay) {
  fsm.homeToPetitDelay = delay;
  fsm.forceHome();
  assert.equal(fsm.state, "home");
}

test("a configured 2-second delay replaces the default 15 seconds", () => {
  opened(2);
  fsm.mouseLeft();
  seconds(1.9);
  assert.equal(fsm.state, "home");
  seconds(0.1);
  assert.equal(fsm.state, "petit");
});

test("editing the delay during a countdown replaces its timer", () => {
  opened(15);
  fsm.mouseLeft();
  fsm.homeToPetitDelay = 0.05;
  seconds(0.05);
  assert.equal(fsm.state, "petit");
});

test("a longer delay also cancels the shorter timer that was running", () => {
  opened(0.05);
  fsm.mouseLeft();
  fsm.homeToPetitDelay = 0.25;
  seconds(0.1);
  assert.equal(fsm.state, "home");
  seconds(0.15);
  assert.equal(fsm.state, "petit");
});

test("the pointer coming cancels the countdown; once it has been on the island, leaving folds it", () => {
  opened(30);
  fsm.mouseLeft();
  fsm.mouseEntered();
  seconds(600);
  assert.equal(fsm.state, "home");
  // No 30 seconds now: the short grace, and it folds.
  fsm.mouseLeft();
  seconds(0.5);
  assert.equal(fsm.state, "home");
  seconds(0.1);
  assert.equal(fsm.state, "petit");
});

test("a delay edit while the island is hovered starts no countdown", () => {
  opened(15);
  fsm.mouseEntered();
  fsm.homeToPetitDelay = 0.05;
  seconds(600);
  assert.equal(fsm.state, "home");
  fsm.mouseLeft();
  seconds(0.6);
  assert.equal(fsm.state, "petit");
});

// ── Leaving folds the island, clicked or not ─────────────────────────────────

test("opened by a click, the island folds as soon as the pointer leaves", () => {
  fsm.homeToPetitDelay = 15;
  fsm.mouseEntered();
  fsm.click();
  assert.equal(fsm.state, "home");
  fsm.mouseLeft();
  seconds(0.5);
  assert.equal(fsm.state, "home");
  seconds(0.1);
  assert.equal(fsm.state, "petit");
});

test("a click inside keeps nothing open: it still folds as the pointer leaves", () => {
  fsm.homeToPetitDelay = 15;
  fsm.mouseEntered();
  fsm.click();
  fsm.userInteracted(); // a tab, a button, a field
  fsm.mouseLeft();
  seconds(0.6);
  assert.equal(fsm.state, "petit");
  // And the countdown bar reads that short deadline, not the 15 seconds.
  fsm.mouseEntered();
  fsm.click();
  fsm.mouseLeft();
  assert.ok(fsm.homeCollapseDueAt - performance.now() <= 600);
});

test("the pointer slipping past the edge and back keeps the island open", () => {
  fsm.mouseEntered();
  fsm.click();
  fsm.mouseLeft();
  seconds(0.3);
  fsm.mouseEntered();
  seconds(600);
  assert.equal(fsm.state, "home");
});

test("an island that opened on its own and the pointer never touched waits the auto-close delay", () => {
  fsm.homeToPetitDelay = 5;
  fsm.forceHome();
  fsm.mouseLeft(); // what the island says when it opens with the pointer elsewhere
  seconds(4.9);
  assert.equal(fsm.state, "home");
  seconds(0.1);
  assert.equal(fsm.state, "petit");
  // Opened again by an alert after a visit: the visit does not carry over.
  fsm.mouseEntered();
  fsm.click();
  fsm.mouseLeft();
  seconds(0.6);
  assert.equal(fsm.state, "petit");
  fsm.forceHome();
  fsm.mouseLeft();
  seconds(4.9);
  assert.equal(fsm.state, "home");
});

test("asked to open with the pointer already on it (a tab, a button), it folds as the pointer leaves", () => {
  fsm.homeToPetitDelay = 15;
  fsm.mouseEntered();
  fsm.click();
  fsm.forceHome(); // the chat tab, the plan gauge: an explicit open from inside
  fsm.mouseLeft();
  seconds(0.6);
  assert.equal(fsm.state, "petit");
  // The same from the compact island: the pointer is on it when it opens.
  fsm.mouseEntered();
  fsm.forceHome();
  fsm.mouseLeft();
  seconds(0.6);
  assert.equal(fsm.state, "petit");
});

test("a waiting card still holds the island open after a click, whatever the pointer does", () => {
  fsm.mouseEntered();
  fsm.click();
  fsm.pinned = true;
  fsm.mouseLeft();
  seconds(600);
  assert.equal(fsm.state, "home");
});

test("an alert waiting for an answer stays open through a delay edit", () => {
  opened(0.05);
  fsm.pinned = true;
  fsm.mouseLeft();
  fsm.homeToPetitDelay = 0.01;
  seconds(600);
  assert.equal(fsm.state, "home");
  fsm.pinned = false;
  fsm.mouseLeft();
  seconds(0.01);
  assert.equal(fsm.state, "petit");
});

test("an alert pinned during a countdown blocks the old timer and its replacement", () => {
  opened(0.2);
  fsm.mouseLeft();
  fsm.pinned = true;
  fsm.homeToPetitDelay = 0.01;
  seconds(600);
  assert.equal(fsm.state, "home");
  fsm.pinned = false;
  fsm.mouseLeft();
  seconds(0.01);
  assert.equal(fsm.state, "petit");
});

test("a pin that arrives after the timer was armed still holds the island", () => {
  opened(1);
  fsm.mouseLeft();
  fsm.pinned = true;
  seconds(600);
  assert.equal(fsm.state, "home");
});

test("the deadline the countdown bar reads follows the delay and clears with the timer", () => {
  opened(15);
  assert.equal(fsm.homeCollapseDueAt, null);
  fsm.mouseLeft();
  const first = fsm.homeCollapseDueAt;
  assert.ok(first != null);
  fsm.homeToPetitDelay = 5;
  assert.ok(fsm.homeCollapseDueAt < first);
  fsm.mouseEntered();
  assert.equal(fsm.homeCollapseDueAt, null);
});

// ── A card folded away while it waits ─────────────────────────────

test("a folded card keeps the compact island on screen until it is answered", () => {
  fsm.forceHome();
  fsm.pinned = true;
  fsm.forcePetit();
  fsm.mouseLeft();
  seconds(600);
  assert.equal(fsm.state, "petit");
  // Reopening brings it back open, and the mouse leaving does not fold it.
  fsm.mouseEntered();
  fsm.click();
  fsm.mouseLeft();
  seconds(600);
  assert.equal(fsm.state, "home");
  // Answered: the usual timers again.
  fsm.pinned = false;
  fsm.mouseLeft();
  seconds(15);
  assert.equal(fsm.state, "petit");
  fsm.mouseLeft();
  seconds(60);
  assert.equal(fsm.state, "hidden");
});

test("an unusable delay is ignored", () => {
  for (const bad of [NaN, -1, Infinity]) fsm.homeToPetitDelay = bad;
  assert.equal(fsm.homeToPetitDelay, 15);
});

// ── Open on hover (IslandHoverTests.swift) ────────────────────────────────────

test("open on hover off: hovering only peeks", () => {
  fsm.mouseEntered();
  assert.equal(fsm.state, "petit");
});

test("open on hover: the closed island only peeks, resting on the compact one opens it", () => {
  fsm.openOnHover = true;
  fsm.mouseEntered();
  assert.equal(fsm.state, "petit");
  seconds(0.4);
  assert.equal(fsm.state, "petit");
  seconds(0.1);
  assert.equal(fsm.state, "home");
});

test("open on hover: passing over the closed island doesn't open it", () => {
  fsm.openOnHover = true;
  fsm.mouseEntered();
  seconds(0.2);
  fsm.mouseLeft();
  seconds(5);
  assert.equal(fsm.state, "petit");
});

test("open on hover: leaving folds after the short grace period, resting opens again", () => {
  fsm.openOnHover = true;
  fsm.mouseEntered();
  seconds(0.5);
  assert.equal(fsm.state, "home");
  fsm.mouseLeft();
  seconds(0.5);
  assert.equal(fsm.state, "home");
  seconds(0.1);
  assert.equal(fsm.state, "petit");
  // From the compact island it opens again, once the pointer rests.
  fsm.mouseEntered();
  seconds(0.5);
  assert.equal(fsm.state, "home");
});

test("open on hover: coming back before the grace period keeps it open", () => {
  fsm.openOnHover = true;
  fsm.mouseEntered();
  seconds(0.5);
  fsm.mouseLeft();
  seconds(0.3);
  fsm.mouseEntered();
  seconds(5);
  assert.equal(fsm.state, "home");
});

test("open on hover: a click inside changes nothing, it folds as the pointer leaves", () => {
  fsm.openOnHover = true;
  fsm.homeToPetitDelay = 3;
  fsm.mouseEntered();
  seconds(0.5);
  fsm.userInteracted();
  fsm.mouseLeft();
  seconds(0.5);
  assert.equal(fsm.state, "home");
  seconds(0.1);
  assert.equal(fsm.state, "petit");
});

test("open on hover: a waiting card holds the island, hover neither opens nor folds it", () => {
  fsm.openOnHover = true;
  fsm.pinned = true;
  fsm.mouseEntered();
  assert.equal(fsm.state, "petit");
  fsm.forceHome();
  fsm.mouseLeft();
  seconds(5);
  assert.equal(fsm.state, "home");
});

test("open on hover: an island opened by an alert keeps the normal delay until the pointer comes", () => {
  fsm.openOnHover = true;
  fsm.homeToPetitDelay = 3;
  fsm.forceHome();
  fsm.mouseLeft();
  seconds(1);
  assert.equal(fsm.state, "home");
  seconds(2);
  assert.equal(fsm.state, "petit");
});

// ── Liv's pocket: the island grown just enough for the figure ─────────────────

/**
 * The pocket's hold is paused and resumed on the performance.now() clock: here
 * that clock moves with the timers.
 */
function clocked(t) {
  let now = 50_000;
  t.mock.method(performance, "now", () => now);
  return (n) => {
    now += n * 1000;
    mock.timers.tick(n * 1000);
  };
}

test("Liv pops out from a hidden island, holds, and leaves the island compact, which hides after its 60 s", () => {
  assert.equal(fsm.peek(PEEK_HOLD.finished), true);
  assert.equal(fsm.state, "peek");
  seconds(3.5);
  assert.equal(fsm.state, "peek");
  seconds(0.1);
  assert.equal(fsm.state, "petit");
  assert.deepEqual(transitions, ["hidden>peek", "peek>petit"]);
  // The compact island's own timer takes over from there.
  seconds(59.9);
  assert.equal(fsm.state, "petit");
  seconds(0.1);
  assert.equal(fsm.state, "hidden");
});

test("the pocket holds 3.6 s for a task that finished, 5 s for one that failed, and as long as it is told", () => {
  assert.deepEqual(PEEK_HOLD, { finished: 3.6, error: 5 });
  fsm.peek(PEEK_HOLD.error);
  seconds(4.9);
  assert.equal(fsm.state, "peek");
  seconds(0.1);
  assert.equal(fsm.state, "petit");
  // A greeting: for as long as it takes.
  fsm.forceHidden();
  fsm.peek(2.4);
  seconds(2.3);
  assert.equal(fsm.state, "peek");
  seconds(0.1);
  assert.equal(fsm.state, "petit");
});

test("Liv pops out from the compact island too, and its 60 s start again afterwards", () => {
  fsm.reveal();
  seconds(50);
  assert.equal(fsm.peek(3.6), true);
  assert.deepEqual(transitions, ["hidden>petit", "petit>peek"]);
  // The compact island's hide, 10 s away when Liv came out, no longer counts.
  seconds(3.6);
  assert.equal(fsm.state, "petit");
  seconds(59.9);
  assert.equal(fsm.state, "petit");
  seconds(0.1);
  assert.equal(fsm.state, "hidden");
});

test("an open island keeps what it shows: Liv does not pop out of it", () => {
  fsm.forceHome();
  fsm.mouseLeft();
  assert.equal(fsm.peek(3.6), false);
  assert.equal(fsm.state, "home");
  // And its own countdown was left running.
  seconds(15);
  assert.equal(fsm.state, "petit");
  assert.deepEqual(transitions, ["hidden>home", "home>petit"]);
});

test("the pointer resting on the pocket pauses the hold; leaving runs what was left of it", (t) => {
  const wait = clocked(t);
  fsm.peek(3.6);
  wait(2);
  fsm.mouseEntered();
  wait(600);
  assert.equal(fsm.state, "peek", "held for as long as the pointer rests there");
  fsm.mouseLeft();
  wait(1.5);
  assert.equal(fsm.state, "peek", "1.6 s were left");
  wait(0.1);
  assert.equal(fsm.state, "petit");
});

test("told again that the pointer is elsewhere, the hold is not started over", (t) => {
  const wait = clocked(t);
  fsm.peek(3.6);
  wait(3);
  fsm.mouseLeft();
  fsm.mouseLeft();
  wait(0.6);
  assert.equal(fsm.state, "petit");
});

test("the pointer coming and going twice only ever pauses the same hold", (t) => {
  const wait = clocked(t);
  fsm.peek(5);
  wait(1);
  fsm.mouseEntered();
  wait(10);
  fsm.mouseLeft();
  wait(2);
  fsm.mouseEntered();
  fsm.mouseEntered();
  wait(10);
  fsm.mouseLeft();
  wait(1.9);
  assert.equal(fsm.state, "peek");
  wait(0.1);
  assert.equal(fsm.state, "petit");
});

test("hovering the pocket never opens it, even with open on hover", () => {
  fsm.openOnHover = true;
  fsm.peek(3.6);
  fsm.mouseEntered();
  seconds(30);
  assert.equal(fsm.state, "peek");
});

test("a click on the pocket opens the island, which then folds on its usual delay", () => {
  fsm.peek(3.6);
  fsm.click();
  assert.equal(fsm.state, "home");
  assert.deepEqual(transitions, ["hidden>peek", "peek>home"]);
  // The pocket's hold is gone with the pocket.
  seconds(10);
  assert.equal(fsm.state, "home");
  fsm.mouseLeft();
  seconds(15);
  assert.equal(fsm.state, "petit");
});

test("Escape folds the pocket to the compact island, and its hold is over", () => {
  fsm.peek(5);
  seconds(1);
  fsm.forcePetit();
  assert.equal(fsm.state, "petit");
  assert.deepEqual(transitions, ["hidden>peek", "peek>petit"]);
  seconds(600);
  assert.equal(fsm.state, "petit", "nothing of the pocket is left to fire; the island says when the pointer is away");
  fsm.mouseLeft();
  seconds(60);
  assert.equal(fsm.state, "hidden");
});

test("an alert that opens the island takes over from the pocket at once", () => {
  fsm.peek(5);
  seconds(1);
  fsm.forceHome();
  assert.equal(fsm.state, "home");
  seconds(600);
  assert.equal(fsm.state, "home", "the pocket's hold does not fold it");
});

test("pausing from the tray hides the pocket, and nothing of it fires later", () => {
  fsm.peek(5);
  fsm.forceHidden();
  assert.equal(fsm.state, "hidden");
  seconds(600);
  assert.deepEqual(transitions, ["hidden>peek", "peek>hidden"]);
});

test("Liv does not pop out of an island nobody sees: parked off-screen, or paused", () => {
  fsm.away = true;
  assert.equal(fsm.peek(3.6), false);
  assert.equal(fsm.state, "hidden");
  fsm.reveal();
  assert.equal(fsm.peek(3.6), false);
  assert.equal(fsm.state, "petit");
  assert.deepEqual(transitions, ["hidden>petit"]);
  // And the compact island's own timer was not touched.
  seconds(60);
  assert.equal(fsm.state, "hidden");
  // Back in sight, it does.
  fsm.away = false;
  assert.equal(fsm.peek(3.6), true);
});

test("a card folded away while it waits keeps the compact island: Liv does not pop out over it", () => {
  fsm.forceHome();
  fsm.pinned = true;
  fsm.forcePetit();
  assert.equal(fsm.peek(3.6), false);
  assert.equal(fsm.state, "petit");
});

test("a second event while Liv is out starts the hold over, without a transition", () => {
  fsm.peek(3.6);
  seconds(3);
  assert.equal(fsm.peek(5), true);
  assert.deepEqual(transitions, ["hidden>peek"]);
  seconds(4.9);
  assert.equal(fsm.state, "peek", "5 s from the second event, not 3.6 from the first");
  seconds(0.1);
  assert.equal(fsm.state, "petit");
});

test("a second event starts the hold over under a resting pointer too, and it runs once the pointer leaves", (t) => {
  const wait = clocked(t);
  fsm.peek(3.6);
  wait(1);
  fsm.mouseEntered();
  fsm.peek(5);
  // The island tells the state machine again where the pointer is (island.ts).
  fsm.mouseEntered();
  wait(60);
  assert.equal(fsm.state, "peek");
  fsm.mouseLeft();
  wait(4.9);
  assert.equal(fsm.state, "peek");
  wait(0.1);
  assert.equal(fsm.state, "petit");
});

test("the mouse waking the island, a work event and the open-on-hover timer mean nothing to the pocket", () => {
  fsm.openOnHover = true;
  fsm.mouseEntered();
  assert.equal(fsm.state, "petit");
  // Open on hover was about to open the compact island: Liv popping out cancels it.
  seconds(0.3);
  fsm.peek(3.6);
  seconds(1);
  assert.equal(fsm.state, "peek");
  fsm.reveal();
  assert.equal(fsm.state, "peek");
});
