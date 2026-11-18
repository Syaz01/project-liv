// The island itself (src/island/island.ts), built on the fake DOM and driven
// the way the app drives it: the pointer through onCursor, alerts and
// shortcuts through its own methods, hook events through the real bridge, and
// time and frames by hand. What it asks of Rust is read from the commands it
// invokes. Here: when the open island folds again, and what keeps it open;
// Liv popping out in its pocket, its greeting, and what the pointer does to it.

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { mock, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { calls, emit, internals, sent } from "./tauri.mjs";
import { installFakeDom } from "./fakedom.mjs";

// src/upload/sequence.ts declares a field in a constructor's parameters, which
// Node's type stripping refuses: that one file goes through the compiler.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith("/src/upload/sequence.ts")) return nextLoad(url, context);
    const compiled = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    return { format: "module", source: compiled.outputText, shortCircuit: true };
  },
});

const dom = installFakeDom();
// The island listens on `window`, which here is the bare global object, and
// takes dropped files through WebView2's own bridge, as on Windows. What it
// listens for is kept, so a key can be pressed.
const windowListeners = {};
globalThis.addEventListener = (type, fn) => (windowListeners[type] ??= []).push(fn);
globalThis.chrome = { webview: { postMessageWithAdditionalObjects() {} } };

// One clock for everything: the timers, performance.now() (the state
// machine's deadlines) and the frames, which only run when time is passed.
let now = 10_000;
let frames = [];
mock.timers.enable({ apis: ["setTimeout"] });
mock.method(performance, "now", () => now);
globalThis.requestAnimationFrame = (fn) => frames.push(fn);

/** Lets `seconds` go by: timers fire, and a frame runs every 16 ms while the island asks for one. */
function pass(seconds) {
  const end = now + seconds * 1000;
  while (now < end) {
    const step = Math.min(16, end - now);
    now += step;
    mock.timers.tick(step);
    const due = frames;
    frames = [];
    for (const frame of due) frame(now);
  }
}
/** The frame loop has stopped: nothing is waiting for the next frame. */
const asleep = () => frames.length === 0;

const { Island } = await import("../src/island/island.ts");
const { registerHookHandlers } = await import("../src/island/hooks.ts");
const { runGlobalShortcut, runIslandKey } = await import("../src/island/shortcuts.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { IDLE_SPOTIFY, SPOTIFY_ID, Spotify } = await import("../src/core/spotify.ts");
const { setLanguage } = await import("../src/i18n/i18n.ts");

const root = dom.root();
// Liv's small signs of life are timed by chance: here every draw is 0.5, so
// the next one is always a blink, 4.2 s away.
const island = new Island(root, () => 0.5);
registerHookHandlers(island);

const byId = (id) => [...root.walk()].find((el) => el.getAttribute("id") === id);
const islandEl = byId("island");
const countdown = byId("countdown");
// Liv is only stepped when it has something to paint on: a context that
// takes every call and paints nothing (and says it draws at one pixel per
// unit), so it settles as it does on screen.
const paint = new Proxy(() => {}, {
  get: (_, key) => (key === "getTransform" ? () => ({ a: 1, b: 0 }) : paint),
  set: () => true,
  apply: () => paint,
});
byId("bot-canvas").getContext = () => paint;
/** The launch card's text field (the chat has one of the same class). */
const launchInput = root.find(".launch-bar")[0].find(".chat-input")[0];
// A real field starts empty.
for (const field of root.find(".chat-input")) field.value = "";

const FAR = [-10_000, -10_000];
const ON_ISLAND = [360, 10];
const pointer = ([x, y]) => island.onCursor(x, y);
const mousedown = (button) => {
  for (const fn of islandEl.listeners.get("mousedown")) fn({ button });
};
const barWidth = () => Number.parseFloat(countdown.style.width);
/** What Rust was asked about the keyboard, in order: true takes it, false gives it back. */
const keyboard = () => sent("focus_window").map((args) => args.focused);
const resume = () => { State.paused = false; };
const hook = (payload) => emit("hook", payload);
/**
 * A permission request, under an id of its own: each one arms a 110 s timer
 * that outlives its test, and must never meet a later request.
 */
let requests = 0;
function permission(command = "ls", session_id = "s1") {
  const request_id = `r${++requests}`;
  hook({ hook_event_name: "PermissionRequest", request_id, session_id, tool_name: "Bash", tool_input: { command } });
  return request_id;
}
/** A button of the card on screen, by its label. */
const cardButton = (label) =>
  root.find("button").find((b) => (b.firstElementChild?.textContent ?? b.textContent) === label);
/** The pointer goes down on `button`, then comes up on it: a click as the webview delivers one. */
const pointerDown = (button) => button.fire("pointerdown");
const press = (button) => {
  pointerDown(button);
  button.fire("click");
};

beforeEach(() => {
  // Whatever the last test left open, held or waiting is put away.
  State.pendingApproval = null;
  State.approvalQueue = [];
  State.focusBeforeApproval = null;
  State.paused = false;
  launchInput.value = "";
  launchInput.fire("input");
  island.setParked(false);
  State.setPinned(false);
  pointer(FAR);
  island.fsm.forceHidden();
  State.view = "overview";
  State.settings = { ...DEFAULT_SETTINGS };
  island.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
  State.loadIntegrationTasks();
  pass(2);
  calls.length = 0;
  assert.deepEqual([State.mode, island.fsm.state, island.fsm.pinned, State.isPinned], ["hidden", "hidden", false, false]);
});

/** The two pin flags never part: what the island shows and what its state machine obeys. */
const pinsAgree = (what) => assert.equal(island.fsm.pinned, State.isPinned, what);

// ── The open island folds again ───────────────────────────────────────────────

test("the open island folds 15 s after the pointer leaves", () => {
  island.alert("overview");
  assert.deepEqual([State.mode, island.fsm.state], ["expanded", "home"]);
  pass(14.9);
  assert.equal(island.fsm.state, "home");
  pass(0.2);
  assert.deepEqual([State.mode, island.fsm.state], ["compact", "petit"]);
});

test("an alert on an island that is already open lets it fold again", () => {
  // The next-pill shortcut pressed twice, the tray's recap item on an open island.
  island.alert("overview");
  pass(5);
  island.alert("overview");
  assert.notEqual(island.fsm.homeCollapseDueAt, null, "the countdown starts over");
  pass(14.9);
  assert.equal(island.fsm.state, "home", "from the second alert, not the first");
  pass(0.2);
  assert.equal(island.fsm.state, "petit");

  // Through the shortcut itself.
  runGlobalShortcut(island, "nextPill", resume);
  runGlobalShortcut(island, "nextPill", resume);
  runGlobalShortcut(island, "prevPill", resume);
  assert.equal(island.fsm.state, "home");
  pass(15.1);
  assert.equal(island.fsm.state, "petit");
});

test("an alert on an open island starts no countdown under the pointer, nor past a pin", () => {
  island.alert("overview");
  pointer(ON_ISLAND);
  island.alert("recap");
  assert.equal(island.fsm.homeCollapseDueAt, null);
  pass(60);
  assert.equal(island.fsm.state, "home");
  pointer(FAR);
  pass(15.1);
  assert.equal(island.fsm.state, "petit");

  island.alert("overview");
  island.setPinned(true);
  island.alert("recap");
  assert.equal(island.fsm.homeCollapseDueAt, null);
  pass(60);
  assert.equal(island.fsm.state, "home");
});

// ── Text left in the launch card ──────────────────────────────────────────────

test("text in the launch card holds the island open, until another view replaces the card", () => {
  island.alert("launch");
  pass(1);
  launchInput.value = "fix the login bug";
  launchInput.fire("input");
  pass(120);
  assert.equal(island.fsm.state, "home", "held while it is being typed");
  assert.equal(State.isPinned, false, "held, not pinned: Escape still closes it");

  // Another tab: the text stays in its field, the hold does not outlive the card.
  island.setView("overview");
  assert.equal(island.fsm.pinned, false);
  pass(14.9);
  assert.equal(island.fsm.state, "home");
  pass(0.2);
  assert.equal(island.fsm.state, "petit");
  assert.equal(launchInput.value, "fix the login bug");
});

test("back on the launch card, the text left there holds the island again", () => {
  island.alert("launch");
  pass(1);
  launchInput.value = "fix the login bug";
  launchInput.fire("input");
  island.setView("overview");
  pass(1);
  island.setView("launch");
  pass(60);
  assert.equal(island.fsm.state, "home");
  // Cleared: the island folds as usual.
  launchInput.value = "";
  launchInput.fire("input");
  pass(15.1);
  assert.equal(island.fsm.state, "petit");
});

test("a card that is no longer on screen cannot hold the island", () => {
  island.alert("launch");
  pass(1);
  island.setView("overview");
  // The folder picker closing, or a key event landing late, after the view changed.
  launchInput.value = "typed before the switch";
  launchInput.fire("input");
  assert.equal(island.fsm.pinned, false);
  pass(15.1);
  assert.equal(island.fsm.state, "petit");
});

test("folding the island lets go of the hold, and the compact island hides as usual", () => {
  island.alert("launch");
  pass(1);
  launchInput.value = "fix the login bug";
  launchInput.fire("input");
  island.collapse();
  assert.deepEqual([island.fsm.state, island.fsm.pinned], ["petit", false]);
  pass(60.1);
  assert.equal(island.fsm.state, "hidden");
});

// ── The chat's keyboard ───────────────────────────────────────────────────────

test("the open-chat shortcut gives the chat the keyboard every time, not only the first", () => {
  runGlobalShortcut(island, "openChat", resume);
  pass(1);
  assert.deepEqual([State.view, keyboard().at(-1)], ["prompt", true]);
  island.collapse();
  pass(1);
  assert.equal(keyboard().at(-1), false, "folded, the keyboard goes back");
  // Folded with the chat as its last view: it does not take the keyboard from there.
  assert.equal(State.view, "prompt");

  calls.length = 0;
  runGlobalShortcut(island, "openChat", resume);
  pass(1);
  assert.deepEqual(keyboard(), [true], "the second time too");
});

test("leaving the chat for another view gives the keyboard back, coming back takes it again", () => {
  island.alert("prompt");
  pass(1);
  calls.length = 0;
  island.setView("overview");
  pass(1);
  assert.deepEqual(keyboard(), [false]);
  island.setView("prompt");
  pass(1);
  assert.deepEqual(keyboard(), [false, true]);
});

// ── One pin ───────────────────────────────────────────────────────────────────

test("pinned with Ctrl+P, paused from the tray and resumed: the island folds again", () => {
  island.alert("overview");
  runIslandKey(island, { kind: "pin" });
  assert.deepEqual([State.isPinned, island.fsm.pinned], [true, true]);
  pass(120);
  assert.equal(island.fsm.state, "home", "pinned, it stays");

  // Tray → Pause, then Pause again (main.ts).
  island.fsm.forceHidden();
  assert.deepEqual([State.isPinned, island.fsm.pinned], [false, false], "the pin goes with the island");
  island.reveal();
  island.alert("overview");
  pass(15.1);
  assert.equal(island.fsm.state, "petit");
  pass(60.1);
  assert.equal(island.fsm.state, "hidden");
});

test("the two pin flags move together through everything that pins and unpins", () => {
  island.alert("overview");
  pinsAgree("open");
  island.setPinned(true);
  pinsAgree("Ctrl+P");
  island.setPinned(false);
  pinsAgree("Ctrl+P again");
  assert.equal(State.isPinned, false);

  // A permission card pins the island the moment it comes up…
  const requestId = permission();
  assert.deepEqual([State.isPinned, island.fsm.pinned, State.view], [true, true, "approval"]);
  pass(30);
  assert.equal(island.fsm.state, "home");
  // …stays pinned folded away…
  island.collapse();
  assert.deepEqual([island.fsm.state, State.isPinned, island.fsm.pinned], ["petit", true, true]);
  pass(65);
  assert.equal(island.fsm.state, "petit", "a waiting card keeps the compact island on screen");
  // …and reopened…
  pointer(ON_ISLAND);
  mousedown(0);
  pinsAgree("reopened");
  assert.deepEqual([island.fsm.state, State.view, State.isPinned], ["home", "approval", true]);
  // …until it is answered, by a click on Allow and nothing else.
  pass(2);
  assert.deepEqual(sent("approval_decision"), []);
  press(cardButton("Allow"));
  assert.deepEqual(sent("approval_decision"), [{ requestId, decision: "allow" }]);
  pinsAgree("answered");
  assert.equal(State.isPinned, false);

  // Escape, the ✕, the tray's Pause: the pin never outlives the open island.
  pointer(FAR);
  island.alert("overview");
  island.setPinned(true);
  island.collapse();
  pinsAgree("closed");
  assert.equal(State.isPinned, false);
  island.alert("overview");
  island.setPinned(true);
  island.fsm.forceHidden();
  pinsAgree("hidden");
  assert.equal(State.isPinned, false);
});

test("nothing can write the pin behind the state machine's back", () => {
  assert.throws(() => { State.isPinned = true; }, TypeError);
  assert.equal(State.isPinned, false);
});

// ── A press answers the request it was made on ────────────────────────────────

const QUESTION = { questions: [{ question: "Which one?", options: [{ label: "A" }, { label: "B" }] }] };
function question(session_id = "s1") {
  const request_id = `r${++requests}`;
  hook({ hook_event_name: "PermissionRequest", request_id, session_id, tool_name: "AskUserQuestion", tool_input: QUESTION });
  return request_id;
}

test("a button answers the request it was pressed on, never the one that took the card meanwhile", () => {
  const first = permission("ls", "s1");
  const second = permission("rm -rf build", "s2");
  pass(2);
  assert.equal(State.pendingApproval.requestId, first);
  // The pointer goes down on Allow, for the first request…
  const allow = cardButton("Allow");
  pointerDown(allow);
  // …which goes away under it: the second takes the card, and the very same button.
  emit("approval-expired", first);
  pass(1);
  assert.equal(State.pendingApproval.requestId, second);
  assert.equal(cardButton("Allow"), allow);
  allow.fire("click");
  assert.deepEqual(sent("approval_decision"), [], "the press was for the first request");
  assert.equal(State.pendingApproval.requestId, second, "the second still waits");
  // One click is one answer: the same press cannot be spent twice.
  press(allow);
  assert.deepEqual(sent("approval_decision"), [{ requestId: second, decision: "allow" }]);
  allow.fire("click");
  assert.equal(sent("approval_decision").length, 1);
});

test("a request that takes the card ignores the first 600 ms of clicks, counted from when it took it", () => {
  const first = permission("ls", "s1");
  const second = permission("rm -rf build", "s2");
  pass(2);
  emit("approval-expired", first);
  assert.equal(State.pendingApproval.requestId, second);
  // Before the card is even drawn again, and for 600 ms after: nothing.
  press(cardButton("Deny"));
  pass(0.55);
  press(cardButton("Allow"));
  assert.deepEqual(sent("approval_decision"), []);
  assert.equal(State.pendingApproval.requestId, second);
  // A press that started inside those 600 ms does not count when it ends after them.
  pointerDown(cardButton("Allow"));
  pass(0.2);
  cardButton("Allow").fire("click");
  assert.deepEqual(sent("approval_decision"), []);
  press(cardButton("Deny"));
  assert.deepEqual(sent("approval_decision"), [{ requestId: second, decision: "deny" }]);
});

test("a button pressed with the keyboard answers the request on the card, after the same 600 ms", () => {
  /** Enter or Space on a focused button: a click with no pointer before it. */
  const keyboardClick = (button) => {
    for (const fn of button.listeners.get("click")) fn({ type: "click", detail: 0 });
  };
  const requestId = permission("ls");
  pass(0.3);
  keyboardClick(cardButton("Allow"));
  assert.deepEqual(sent("approval_decision"), []);
  pass(1);
  keyboardClick(cardButton("Allow"));
  assert.deepEqual(sent("approval_decision"), [{ requestId, decision: "allow" }]);
});

test("the question card has the same guard, and answers the question it was pressed on", () => {
  const first = question("s1");
  const second = question("s2");
  // A click meant for the window underneath, as the card comes up: no answer.
  pass(0.3);
  press(cardButton("A"));
  press(cardButton("Answer in terminal"));
  assert.deepEqual([sent("approval_answer"), sent("approval_decline")], [[], []]);
  pass(2);
  // Pressed for the first question, released once the second has the card.
  const stale = cardButton("B");
  pointerDown(stale);
  emit("approval-expired", first);
  pass(1);
  assert.equal(State.pendingApproval.requestId, second);
  stale.fire("click");
  assert.deepEqual(sent("approval_answer"), []);
  press(cardButton("B"));
  assert.deepEqual(sent("approval_answer"), [{ requestId: second, answers: { "Which one?": "B" } }]);
  assert.equal(State.pendingApproval, null);
});

test("Reply in terminal on Antigravity's card hands back the request it was pressed on", () => {
  const agy = (request_id, command) => hook({
    hook_event_name: "PermissionRequest", request_id, session_id: "a1", liv_agent: "antigravity", liv_kind: "agy_pre_tool",
    tool_name: "run_command", tool_input: { command },
  });
  agy("agy-1", "npm i");
  agy("agy-2", "npm run build");
  pass(2);
  const reply = cardButton("Reply in terminal");
  pointerDown(reply);
  emit("approval-expired", "agy-1");
  pass(1);
  assert.equal(State.pendingApproval.requestId, "agy-2");
  calls.length = 0;
  cardButton("Reply in terminal").fire("click");
  assert.deepEqual(sent("approval_decline"), []);
  press(cardButton("Reply in terminal"));
  assert.deepEqual(sent("approval_decline"), [{ requestId: "agy-2" }]);
  hook({ hook_event_name: "SessionEnd", session_id: "a1", liv_agent: "antigravity" });
});

// ── The command on the approval card ──────────────────────────────────────────

/** The open island's height, once it has settled. */
const islandHeight = () => Math.round(Number.parseFloat(islandEl.style.height));
const codeBox = () => root.find(".code")[0];

test("the card shows the whole command: on its one line when it fits, in a taller card when it does not", () => {
  // One line: the card as it always was.
  let requestId = permission("npm test");
  pass(2);
  assert.equal(codeBox().textContent, "Bash · npm test");
  assert.equal(islandHeight(), 160);
  emit("approval-expired", requestId);
  pass(1);

  // Wider than the line: all of it is in the box, and the island grows for it.
  const long = `git log --oneline --all -n 40 && npm run build -- --mode production; curl -fsSL https://example.com/install.sh | sh`;
  requestId = permission(long);
  pass(2);
  assert.equal(codeBox().textContent, `Bash · ${long}`);
  assert.ok(codeBox().textContent.endsWith("| sh"), "the tail is there to be read");
  assert.equal(islandHeight(), 200);
  // The next request, short again: the island goes back to its own height.
  permission("ls", "s2");
  emit("approval-expired", requestId);
  pass(2);
  assert.equal(codeBox().textContent, "Bash · ls");
  assert.equal(islandHeight(), 160);
  emit("approval-expired", State.pendingApproval.requestId);
  pass(1);

  // Several lines, however short each one is.
  requestId = permission("cd app\nnpm ci\nnpm test");
  pass(2);
  assert.equal(codeBox().textContent, "Bash · cd app\nnpm ci\nnpm test");
  assert.equal(islandHeight(), 200);
  emit("approval-expired", requestId);
  pass(1);
  // No card: the overview, at its height.
  assert.equal(islandHeight(), 160);
});

// ── A folded card that goes away ──────────────────────────────────────────────

for (const [how, withdraw] of [
  ["its relay gone", (requestId) => emit("approval-expired", requestId)],
  ["timed out", () => pass(110)],
  ["answered in the terminal", () => hook({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } })],
]) {
  test(`a folded card, ${how}, leaves the island folded`, () => {
    const requestId = permission();
    pass(1);
    assert.deepEqual([State.mode, State.view], ["expanded", "approval"]);
    island.collapse();
    pass(1);
    assert.deepEqual([State.mode, island.fsm.state], ["compact", "petit"]);

    withdraw(requestId);
    assert.equal(State.pendingApproval, null);
    assert.deepEqual([State.mode, island.fsm.state], ["compact", "petit"], "it does not spring open");
    assert.equal(State.view, "overview", "and opens on the overview next time");
    assert.deepEqual([State.isPinned, island.fsm.pinned], [false, false]);
    // Nothing waits any more: the compact island hides on its usual clock.
    pass(60.1);
    assert.equal(island.fsm.state, "hidden");
  });
}

test("an open card that goes away gives its place to the overview, the island still open", () => {
  const requestId = permission();
  pass(1);
  emit("approval-expired", requestId);
  assert.deepEqual([State.mode, State.view, island.fsm.state], ["expanded", "overview", "home"]);
  // And it folds again, now that nothing waits.
  pass(15.1);
  assert.equal(island.fsm.state, "petit");
});

// ── The countdown bar ─────────────────────────────────────────────────────────

// On the open island Liv breathes, and that alone keeps the frame loop going
// (see "Liv's life" below). Paused from the tray it holds still: what is left
// of the open island's frames is the countdown's own, which these count.
const holdStill = () => { State.paused = true; };

test("the countdown bar shrinks through its last nine seconds, and costs no frame before or after", () => {
  island.alert("overview");
  holdStill();
  pass(3);
  assert.equal(barWidth(), 0);
  assert.ok(asleep(), "nothing moves: the loop has stopped, three seconds in");
  pass(2.9);
  assert.equal(barWidth(), 0, "5.9 s in: not in view yet");
  assert.ok(asleep());

  // 15 s to fold, the bar in view for the last 9: it wakes the loop by itself.
  pass(0.2);
  const first = barWidth();
  assert.ok(first > 155 && first <= 160, `6.1 s in: nearly whole (${first})`);
  assert.ok(!asleep(), "and it keeps the loop going");
  pass(4.4);
  const half = barWidth();
  assert.ok(Math.abs(half - 80) < 2, `10.5 s in: half of it (${half})`);
  pass(4);
  const last = barWidth();
  assert.ok(last > 0 && last < 12, `14.5 s in: nearly gone (${last})`);
  assert.ok(!asleep());

  pass(0.6);
  assert.equal(island.fsm.state, "petit");
  assert.equal(barWidth(), 0);
  pass(3);
  assert.ok(asleep(), "folded, the loop stops again");
});

test("the pointer coming back takes the bar away and lets the loop stop", () => {
  island.alert("overview");
  holdStill();
  pass(10);
  assert.ok(barWidth() > 0);
  pointer(ON_ISLAND);
  pass(3);
  assert.equal(barWidth(), 0);
  assert.ok(asleep());
  // The pointer has been on it: leaving folds it at once, no countdown to wait for.
  pointer(FAR);
  pass(0.5);
  assert.equal(State.mode, "expanded", "the short grace, for a pointer that slips past the edge");
  pass(0.2);
  assert.equal(State.mode, "compact");
  pass(3);
  assert.ok(asleep(), "folded, the loop stops again");
});

test("a pinned island shows no countdown and asks for no frame", () => {
  island.alert("overview");
  holdStill();
  pass(8);
  assert.ok(barWidth() > 0);
  island.setPinned(true);
  pass(3);
  assert.equal(barWidth(), 0);
  assert.ok(asleep());
  pass(60);
  assert.ok(asleep());
});

test("parked off-screen, the countdown asks for no frame", () => {
  island.alert("overview");
  pass(3);
  island.setParked(true);
  assert.equal(State.parked, true);
  assert.ok(root.classList.contains("parked"));
  pass(5);
  assert.ok(asleep(), "8 s in, the bar would be in view: nobody sees it");
  island.setParked(false);
  assert.equal(State.parked, false);
  pass(0.1);
  assert.ok(barWidth() > 0, "back on screen with time left, the bar is where it should be");
  assert.ok(!asleep());
});

// ── Liv's life ────────────────────────────────────────────────────────────────

/** Liv's timer starts counting afresh: parked there is none, and back on screen the next frame arms it. */
function restartLife() {
  island.setParked(true);
  pass(0.1);
  island.setParked(false);
  pass(0.1);
}

test("Liv breathes on the open island, and only there: folded, parked or paused the loop stops", () => {
  island.alert("overview");
  island.setPinned(true);
  pass(5);
  assert.ok(!asleep(), "open: it breathes, and the loop runs");
  pass(20);
  assert.ok(!asleep(), "for as long as the island is open");

  island.setParked(true);
  pass(2);
  assert.ok(asleep(), "parked off-screen: nobody sees it");
  island.setParked(false);
  pass(1);
  assert.ok(!asleep(), "back on screen, it breathes again");

  State.paused = true;
  pass(2);
  assert.ok(asleep(), "paused: it holds still");
  State.paused = false;
  island.ensureRunning();
  pass(1);
  assert.ok(!asleep());

  island.setPinned(false);
  island.collapse();
  assert.equal(State.mode, "compact");
  pass(2);
  assert.ok(asleep(), "folded: the breath dies down and the loop stops");
});

// ── Liv dances ────────────────────────────────────────────────────────────────

/** Spotify declared and in front, a track playing (or not), as island/spotify.ts leaves it after a report. */
function music(playing) {
  State.settings.activeIntegrations = [SPOTIFY_ID];
  State.loadIntegrationTasks();
  State.setFocus(SPOTIFY_ID);
  Spotify.state = {
    ...IDLE_SPOTIFY, running: true, installed: true, playing,
    track: { id: "spotify:track:abc", title: "Get Lucky", artist: "Daft Punk", album: "", duration: 180, artUrl: null },
  };
  State.notify();
}

test("music playing with the Spotify pill in front: Liv dances on the open island, in the pill's colour", () => {
  const liv = island.engine;
  try {
    music(true);
    island.alert("overview");
    island.setPinned(true);
    pass(1);
    assert.equal(liv.dancing, true);
    assert.equal(liv.danceIn, 1, "all the way in after 300 ms");
    assert.equal(liv.pose().eyes.shape, "arc");
    assert.deepEqual(liv.danceColor.map((c) => Math.round(c * 255)), [0x1d, 0xb9, 0x54]);
    assert.ok(!asleep());

    // Paused in Spotify: it eases out, and breathes on as the open island's Liv does.
    music(false);
    pass(0.2);
    assert.ok(!liv.dancing && liv.danceIn > 0 && liv.danceIn < 1, "on its way out");
    pass(0.4);
    assert.equal(liv.danceIn, 0);
    assert.equal(liv.pose().eyes.shape, "round");
    music(true);
    pass(0.5);
    assert.equal(liv.danceIn, 1, "and back in when it plays again");

    // Another pill in front: its card is not the one showing.
    State.setFocus(State.settings.mainPill);
    pass(0.6);
    assert.ok(!liv.dancing && liv.danceIn === 0);
    State.setFocus(SPOTIFY_ID);
    pass(0.5);
    assert.equal(liv.danceIn, 1);

    // A request comes first: its look, not the dance.
    permission();
    pass(0.6);
    assert.equal(State.view, "approval");
    assert.ok(!liv.dancing && liv.danceIn === 0);
    assert.equal(liv.state, "approval");
    assert.equal(liv.pose().eyes.shape, "wide");
  } finally {
    Spotify.state = { ...IDLE_SPOTIFY };
  }
});

test("the island folds, parks or pauses: the dance eases out and the frame loop stops", () => {
  const liv = island.engine;
  try {
    music(true);
    island.alert("overview");
    island.setPinned(true);
    pass(1);
    assert.equal(liv.danceIn, 1);

    island.setPinned(false);
    island.collapse();
    assert.equal(State.mode, "compact");
    pass(0.3);
    assert.ok(!liv.dancing && liv.danceIn > 0, "easing out as the island folds");
    assert.ok(!asleep());
    pass(2.5);
    assert.equal(liv.danceIn, 0);
    assert.ok(asleep(), "folded, with music still playing: not a frame");
    pass(3);
    assert.ok(asleep());

    // Open again, parked off-screen: nobody sees it.
    island.alert("overview");
    island.setPinned(true);
    pass(1);
    assert.equal(liv.danceIn, 1);
    island.setParked(true);
    pass(2);
    assert.ok(!liv.dancing);
    assert.ok(asleep());
    island.setParked(false);
    pass(1);
    assert.equal(liv.danceIn, 1, "back on screen, back to the music");

    // Paused from the tray.
    State.paused = true;
    pass(3);
    assert.ok(!liv.dancing && liv.danceIn === 0);
    assert.ok(asleep());
  } finally {
    Spotify.state = { ...IDLE_SPOTIFY };
  }
});

test("without the Spotify pill declared, or with nothing playing, Liv does not dance", () => {
  const liv = island.engine;
  try {
    music(false);
    island.alert("overview");
    island.setPinned(true);
    pass(1);
    assert.ok(!liv.dancing && liv.danceIn === 0, "a track loaded, not playing");
    // Playing, but the pill was taken off the island: the front is the main pill's.
    Spotify.state = { ...Spotify.state, playing: true };
    State.settings.activeIntegrations = [];
    State.loadIntegrationTasks();
    pass(1);
    assert.ok(!liv.dancing && liv.danceIn === 0);
  } finally {
    Spotify.state = { ...IDLE_SPOTIFY };
  }
});

test("closed, Liv blinks every few seconds: one timer wakes the loop for it, and the loop stops again", () => {
  assert.deepEqual([State.mode, State.settings.closedIsland], ["hidden", "robot"]);
  restartLife();
  assert.ok(asleep());
  // The timer was armed 16 ms after the island came back; the next blink is 4.2 s after that.
  pass(4);
  assert.ok(asleep(), "4.1 s on: not a frame since");
  pass(0.2);
  assert.ok(!asleep(), "4.3 s on: the blink");
  pass(0.4);
  assert.ok(asleep(), "and it is over: nothing runs until the next one");
  pass(3.6);
  assert.ok(asleep());
  pass(0.2);
  assert.ok(!asleep(), "4.2 s after the first");
  pass(0.4);
  assert.ok(asleep());
});

test("compact, Liv has the same life; parked, paused or with something else in the closed island, none", () => {
  island.reveal();
  assert.equal(State.mode, "compact");
  pass(1);
  restartLife();
  pass(4);
  assert.ok(asleep());
  pass(0.2);
  assert.ok(!asleep(), "compact: the blink, 4.2 s on");
  pass(0.4);
  assert.ok(asleep());

  /** No frame at all for ten seconds. */
  const still = (why) => {
    for (let i = 0; i < 100; i++) {
      pass(0.1);
      assert.ok(asleep(), why);
    }
  };
  island.setParked(true);
  pass(1);
  still("parked");
  island.setParked(false);
  State.paused = true;
  pass(1);
  still("paused");
  State.paused = false;

  island.fsm.forceHidden();
  State.settings = { ...DEFAULT_SETTINGS, closedIsland: "time" };
  State.notify();
  pass(2);
  still("the closed island shows the time: Liv is not there");
});

// ── Only the main button opens the island ─────────────────────────────────────

test("a right or middle click neither opens the island nor counts as using it", () => {
  island.reveal();
  pointer(ON_ISLAND);
  assert.equal(island.fsm.state, "petit");
  for (const button of [1, 2, 3, 4]) {
    mousedown(button);
    assert.equal(island.fsm.state, "petit", `button ${button}`);
  }
  mousedown(0);
  assert.deepEqual([island.fsm.state, State.mode], ["home", "expanded"]);
});

// ── The error card ────────────────────────────────────────────────────────────

/** The card on screen (`.view.on`), its red line and its buttons as [class, label]. */
function shownCard() {
  const view = root.find(".view").find((el) => el.classList.contains("on"));
  return {
    detail: view.find(".detail")[0]?.textContent,
    row: view.find(".actions")[0],
    buttons: view.find(".actions")[0].find("button").map((b) => [b.className, b.textContent]),
    click: (label) => view.find(".actions")[0].find("button").find((b) => b.textContent === label).fire("click"),
  };
}

test("a session's error card offers what the finished card does: its terminal, and OK", () => {
  hook({ hook_event_name: "PreToolUse", session_id: "s1", cwd: "C:\code\proj", tool_name: "Bash", tool_input: { command: "npm test" } });
  hook({ hook_event_name: "StopFailure", session_id: "s1", cwd: "C:\code\proj", last_assistant_message: "API Error: Rate limit reached" });
  pass(0.1);
  // Liv pops out of the folded island; a click on it opens the card.
  assert.equal(State.mode, "peek");
  mousedown(0);
  pass(0.1);
  assert.deepEqual([State.mode, State.view], ["expanded", "error"]);
  const card = shownCard();
  assert.equal(card.detail, "API Error: Rate limit reached", "the error, not the last step");
  assert.deepEqual(card.buttons, [["btn primary", "Open terminal"], ["btn secondary", "OK"]]);

  calls.length = 0;
  card.click("Open terminal");
  assert.deepEqual(sent("open_session"), [{ sessionId: "s1", path: "C:\code\proj" }]);
  assert.deepEqual(sent("open_url"), [], "nothing is opened in a browser");
  assert.deepEqual(sent("open_n8n"), []);
  card.click("OK");
  assert.equal(State.mode, "compact");
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("an error that says nothing shows the last step, as before", () => {
  hook({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" } });
  hook({ hook_event_name: "StopFailure", session_id: "s1" });
  pass(0.1);
  mousedown(0);
  pass(0.1);
  assert.equal(shownCard().detail, "Runs · npm test");
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("the error card's buttons are not rebuilt under the pointer", () => {
  hook({ hook_event_name: "StopFailure", session_id: "s1", error: "server_error" });
  pass(0.1);
  mousedown(0);
  pass(0.1);
  const before = shownCard().row.find("button");
  State.notify();
  pass(0.1);
  assert.deepEqual(shownCard().row.find("button"), before);
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("only the n8n pill's error card opens n8n; the Claude app's opens the Claude app", () => {
  State.settings.activeIntegrations = ["integration_n8n"];
  State.loadIntegrationTasks();
  State.setFocus("integration_n8n");
  island.alert("error");
  pass(0.1);
  let card = shownCard();
  assert.deepEqual(card.buttons, [["btn primary", "Open in n8n"], ["btn secondary", "OK"]]);
  calls.length = 0;
  card.click("Open in n8n");
  assert.equal(sent("open_n8n").length, 1);
  assert.deepEqual(sent("open_url"), []);

  hook({ hook_event_name: "SessionStart", session_id: "d1", liv_agent: "claude-desktop" });
  hook({ hook_event_name: "StopFailure", session_id: "d1", liv_agent: "claude-desktop" });
  State.setFocus("agent_claude-desktop");
  island.alert("error");
  pass(0.1);
  card = shownCard();
  assert.deepEqual(card.buttons, [["btn primary", "Open Claude"], ["btn secondary", "OK"]]);
  calls.length = 0;
  card.click("Open Claude");
  assert.equal(sent("open_claude_desktop").length, 1);
  assert.deepEqual(sent("open_session"), []);
  hook({ hook_event_name: "SessionEnd", session_id: "d1", liv_agent: "claude-desktop" });
});

// ── A fresh install: the main pill alone ──────────────────────────────────────

test("with no other pill the overview's right card offers the way to add some", () => {
  const pills = () => root.find(".pills")[0];
  assert.deepEqual(State.tasks.map((t) => t.id), ["integration_claude"], "nothing is declared for the user");
  island.alert("overview");
  pass(0.1);
  assert.deepEqual(pills().children.map((el) => [el.className, el.textContent]), [["link-btn", "Add pills…"]]);
  calls.length = 0;
  pills().children[0].fire("click");
  assert.deepEqual(sent("open_settings_window"), [{ page: "pills#pills.active" }]);
  // The compact island shows Liv alone: no minis for pills that are not there.
  assert.equal(byId("mini-grid").children.length, 0);

  // A pill declared in Settings takes the link's place.
  State.settings.activeIntegrations = ["integration_github"];
  State.loadIntegrationTasks();
  pass(0.1);
  assert.deepEqual(pills().children.map((el) => el.className), ["pill"]);
});

// ── The island's own settings card ────────────────────────────────────────────

/** The status badges of the settings card: [label, the colour of its dot]. */
function badges() {
  const view = root.find(".view").find((el) => el.classList.contains("on"));
  return view.find(".status-badge").map((b) => [b.textContent, b.find(".dot")[0].getAttribute("style").match(/background:(#\w+)/)[1]]);
}

test("the API dot says whether the chat can answer, asked each time the card is shown", async (context) => {
  let ready = false;
  const invoke = internals.invoke;
  context.mock.method(internals, "invoke", (cmd, args) => (cmd === "claude_ready" ? Promise.resolve(ready) : invoke(cmd, args)));
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    pass(0.1);
  };

  island.alert("settings");
  await settle();
  assert.deepEqual(badges(), [["Claude Code", "#F4505E"], ["API", "#F4505E"]], "no key, no Claude Code: it cannot");
  assert.equal(sent("claude_ready").length, 0, "answered by the stand-in, never by guessing");

  // A key is saved in Settings meanwhile: the next showing asks again.
  ready = true;
  island.setView("overview");
  pass(0.1);
  island.setView("settings");
  await settle();
  assert.deepEqual(badges()[1], ["API", "#22C55E"]);

  // Another provider without its key: red again, whatever Claude can do.
  island.setView("overview");
  State.settings.chatProvider = "openai";
  island.setView("settings");
  await settle();
  assert.deepEqual(badges()[1], ["API", "#F4505E"]);
});

test("the auto-close choices show the delay in force, even one only Settings offers", () => {
  const seg = () => root.find(".seg")[0].find("button").map((b) => [b.textContent, b.classList.contains("on")]);
  island.alert("settings");
  pass(0.1);
  assert.deepEqual(seg(), [["10s", false], ["15s", true], ["30s", false]]);

  // 5 s, picked in Settings → General: it joins the choices, and is the one picked.
  State.settings.autoCloseInterval = 5;
  State.notify();
  pass(0.1);
  assert.deepEqual(seg(), [["5s", true], ["10s", false], ["15s", false], ["30s", false]]);

  root.find(".seg")[0].find("button")[3].fire("click");
  pass(0.1);
  assert.equal(State.settings.autoCloseInterval, 30);
  assert.deepEqual(seg(), [["10s", false], ["15s", false], ["30s", true]]);
});

// ── Text built once follows the language ──────────────────────────────────────

test("the launch card's placeholder follows a change of language", () => {
  assert.equal(launchInput.getAttribute("placeholder"), "What should Claude do?");
  setLanguage("es");
  try {
    assert.equal(launchInput.getAttribute("placeholder"), "¿Qué debe hacer Claude?");
  } finally {
    setLanguage("en");
  }
  assert.equal(launchInput.getAttribute("placeholder"), "What should Claude do?");
});

// ── Liv pops out: the pocket ──────────────────────────────────────────────────

const engine = island.engine;
const stop = (extra = {}) => hook({ hook_event_name: "Stop", session_id: "s1", cwd: "C:\\code\\proj", last_assistant_message: "Done.", ...extra });
const fail = (extra = {}) => hook({ hook_event_name: "StopFailure", session_id: "s1", cwd: "C:\\code\\proj", last_assistant_message: "API Error", ...extra });
/** The island's shape as Rust last heard it. */
const shape = () => {
  const { width, height } = sent("set_island_rect").at(-1);
  return [Math.round(width), Math.round(height)];
};
const opacity = (id) => byId(id).style.opacity;
/** The middle of the pocket, in the page (the panel is 720 wide). */
const ON_POCKET = [360, 60];
/** Liv's head on the open island's overview: its slot is centred 68 px in, on the card's middle. */
const ON_LIV = [40 + 68, 103];

test("a session finishing while the island is compact: Liv alone pops out, in the finished colours, and goes back in", () => {
  island.reveal();
  pass(1);
  assert.deepEqual([State.mode, shape()], ["compact", [288, 32]]);
  stop();
  pass(1.5);
  assert.deepEqual([State.mode, island.fsm.state], ["peek", "peek"]);
  assert.deepEqual(shape(), [124, 116], "a pocket just big enough for it, where clicks stop passing through");
  assert.equal(corner(), 22, "with the open island's corners");
  // Nothing else is drawn: no header, no card, no pills, no clock, no plan gauge.
  assert.deepEqual([opacity("content"), opacity("mini-grid"), opacity("island-clock"), opacity("compact-plan")], ["0", "0", "0", "0"]);
  assert.equal(byId("content").style.pointerEvents, "none");
  // Liv whole, in the state's look, its glow behind it.
  assert.deepEqual([engine.state, engine.feet, engine.hands], ["finished", 1, 1]);
  assert.equal(byId("bot-canvas").style.opacity, "1");
  assert.deepEqual([byId("bot-glow").style.display, byId("bot-glow").style.opacity], ["block", "0.65"]);
  assert.ok(byId("bot-glow").style.background.includes("#34D399"));
  // In the middle of the pocket, 62 px down, in a canvas of 97 px (a slot of 58).
  const at = ["left", "top"].map((side) => Number.parseFloat(byId("bot-canvas").style[side]) + 97 / 2);
  assert.ok(at.every((v) => Math.abs(v - 62) < 0.01), String(at));
  assert.equal(byId("bot-canvas").style.width, "97px");

  pass(1);
  assert.ok(asleep(), "its hop over, it waits there without a frame");
  pass(1);
  assert.equal(State.mode, "peek", "3.5 s in");
  pass(0.2);
  assert.deepEqual([State.mode, island.fsm.state], ["compact", "petit"], "3.6 s: compact again, never unfolded");
  pass(1);
  assert.deepEqual(shape(), [288, 32]);
  assert.equal(byId("bot-glow").style.display, "none");
  assert.equal(engine.feet, 0, "the head alone again");
  // From there the compact island hides on its usual clock: 60 s after Liv went back in.
  pass(58.8);
  assert.equal(island.fsm.state, "petit");
  pass(0.2);
  assert.equal(island.fsm.state, "hidden");
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("on its way out Liv keeps the look it had; out, it plays the state's entrance, and the loop stops after it", () => {
  hook({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" } });
  pass(3);
  assert.equal(engine.state, "working");
  stop();
  pass(0.2);
  assert.deepEqual([State.mode, engine.state], ["peek", "working"], "200 ms: the pocket is opening, Liv as it was");
  pass(0.1);
  assert.equal(engine.state, "finished", "out: green, and the happy hop starts");
  let top = 0;
  let lifted = 0;
  for (let i = 0; i < 50; i++) {
    pass(0.016);
    top = Math.min(top, engine.oy);
    lifted = Math.max(lifted, engine.lift);
  }
  assert.ok(top < -0.25 && lifted >= 1, `the whole hop, hands up (${top}, ${lifted})`);
  pass(1.5);
  assert.ok(asleep());
  // It blinks while it waits, on the island's one timer, and the loop stops again.
  // (Finished, its eyes are smiling arcs: the timer plays, and there is nothing to blink.)
  pass(1);
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("a session failing while the island is closed: Liv pops out in the error's colours for 5 s", () => {
  assert.equal(State.mode, "hidden");
  fail();
  pass(1);
  assert.deepEqual([State.mode, shape(), engine.state], ["peek", [124, 116], "error"]);
  assert.ok(byId("bot-glow").style.background.includes("#F4505E"));
  assert.equal(sent("set_collapsed").at(-1)?.collapsed, false, "the folded window was grown back for it");
  pass(1.5);
  assert.ok(asleep(), "the shake over, no frame");
  pass(2.4);
  assert.equal(State.mode, "peek", "4.9 s in");
  pass(0.2);
  assert.equal(State.mode, "compact");
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("the pocket's glow waits for the pocket to be open around it", () => {
  stop();
  pass(0.1);
  assert.deepEqual([State.mode, byId("bot-glow").style.display, byId("bot-glow").style.opacity], ["peek", "block", "0"]);
  pass(1);
  assert.equal(byId("bot-glow").style.opacity, "0.65");
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("the pointer resting on the pocket holds Liv there; leaving runs the rest of the hold", () => {
  stop();
  pass(2);
  pointer(ON_POCKET);
  pass(60);
  assert.equal(State.mode, "peek", "for as long as the pointer rests on it");
  // The eyes follow the pointer while it is there, as on the compact island.
  pointer(FAR);
  pass(1.5);
  assert.equal(State.mode, "peek", "1.6 s were left");
  pass(0.2);
  assert.equal(State.mode, "compact");
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("a pointer already where the pocket opens holds it from the start", () => {
  island.reveal();
  pointer(ON_ISLAND);
  pass(1);
  stop();
  pass(30);
  assert.equal(State.mode, "peek");
  pointer(FAR);
  pass(3.5);
  assert.equal(State.mode, "peek");
  pass(0.2);
  assert.equal(State.mode, "compact");

  // On the compact island but beside where the pocket opens: it does not hold it.
  pointer([360 + 130, 10]);
  pass(1);
  stop();
  pass(3.7);
  assert.equal(State.mode, "compact", "3.6 s and it is back in");
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("a click on the pocket opens the island on the card Liv came out for", () => {
  stop();
  pass(1);
  pointer(ON_POCKET);
  mousedown(2);
  assert.equal(State.mode, "peek", "the left button only");
  mousedown(0);
  pass(1);
  assert.deepEqual([State.mode, State.view, island.fsm.state], ["expanded", "finished", "home"]);
  assert.deepEqual(shape(), [640, 160]);
  assert.equal(opacity("content"), "1");
  // It is an open island like any other: it folds 15 s after the pointer leaves.
  pointer(FAR);
  pass(15.1);
  assert.equal(State.mode, "compact");

  fail();
  pass(1);
  mousedown(0);
  pass(0.5);
  assert.deepEqual([State.mode, State.view], ["expanded", "error"]);
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("Escape folds the pocket to the compact island", () => {
  stop();
  pass(1);
  for (const fn of windowListeners.keydown) fn({ key: "Enter" });
  assert.equal(State.mode, "peek");
  for (const fn of windowListeners.keydown) fn({ key: "Escape" });
  assert.deepEqual([State.mode, island.fsm.state], ["compact", "petit"]);
  pass(60.1);
  assert.equal(island.fsm.state, "hidden");
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("a permission request takes over from the pocket at once, and its card is not folded by the pocket's hold", () => {
  stop();
  pass(1);
  assert.equal(State.mode, "peek");
  const requestId = permission();
  pass(1);
  assert.deepEqual([State.mode, State.view, island.fsm.state, State.isPinned], ["expanded", "approval", "home", true]);
  pass(30);
  assert.equal(State.mode, "expanded");
  emit("approval-expired", requestId);
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("a second event while Liv is out gives it the new look at once and starts the hold over", () => {
  stop();
  pass(3);
  assert.deepEqual([State.mode, engine.state], ["peek", "finished"]);
  fail();
  pass(0.05);
  assert.equal(engine.state, "error", "no second way out to wait for");
  assert.notEqual(engine.ox, 0, "and it shakes");
  pass(4.8);
  assert.equal(State.mode, "peek", "5 s from the failure, not 3.6 from the stop");
  pass(0.3);
  assert.equal(State.mode, "compact");

  // The same thing again plays its entrance again.
  stop();
  pass(1.5);
  stop();
  let top = 0;
  for (let i = 0; i < 40; i++) {
    pass(0.016);
    top = Math.min(top, engine.oy);
  }
  assert.ok(top < -0.25, "it hops again");
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("on the open island a finished or failed session shows its card, as before; Liv does not pop out", () => {
  island.alert("overview");
  pass(1);
  stop();
  pass(0.5);
  assert.deepEqual([State.mode, State.view, island.fsm.state], ["expanded", "finished", "home"]);
  fail();
  pass(0.5);
  assert.deepEqual([State.mode, State.view], ["expanded", "error"]);
  assert.equal(island.peek("finished", "finished"), false);
  assert.equal(State.mode, "expanded");
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("parked off-screen Liv does not pop out: the card opens as it did; and a folded card keeps the compact island", () => {
  island.setParked(true);
  stop();
  pass(0.5);
  assert.deepEqual([State.mode, State.view], ["expanded", "finished"]);
  island.setParked(false);
  island.fsm.forceHidden();
  pass(1);

  // A card folded away while it waits: nothing pops out over it.
  const requestId = permission();
  pass(1);
  island.collapse();
  pass(1);
  assert.deepEqual([State.mode, island.fsm.pinned], ["compact", true]);
  assert.equal(island.peek("error", "error"), false);
  assert.equal(island.greet(), false);
  assert.equal(State.mode, "compact");
  emit("approval-expired", requestId);
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("another pill's alert borrows the front while Liv is out, and gives it back when Liv goes back in", () => {
  State.settings.activeIntegrations = ["integration_n8n"];
  State.settings.alertsFromAllPills = true;
  State.loadIntegrationTasks();
  State.setFocus("integration_n8n");
  for (const [event, seconds] of [[fail, 5], [stop, 3.6]]) {
    event();
    pass(1);
    assert.deepEqual([State.mode, State.focusId], ["peek", "integration_claude"], "Liv wears the look of the pill that alerted");
    pass(seconds - 0.9);
    assert.deepEqual([State.mode, State.focusId], ["compact", "integration_n8n"], "back in: the pill you had");
    pass(2);
  }
  // Opened by a click, the card keeps its pill; closing the island gives the front back.
  stop();
  pass(1);
  mousedown(0);
  pass(6);
  assert.deepEqual([State.mode, State.view, State.focusId], ["expanded", "finished", "integration_claude"]);
  island.collapse();
  assert.equal(State.focusId, "integration_n8n");
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

test("a work event while Liv is out changes nothing of the pocket", () => {
  stop();
  pass(1);
  hook({ hook_event_name: "SessionStart", session_id: "s2", cwd: "C:\\code\\other" });
  island.reveal();
  assert.equal(State.mode, "peek");
  pass(2.7);
  assert.equal(State.mode, "compact");
  hook({ hook_event_name: "SessionEnd", session_id: "s1" });
});

// ── The greeting at launch ────────────────────────────────────────────────────

test("at launch Liv pops out, waves for 2.4 s and the island is compact; the loop stops", () => {
  const greeted = mock.method(engine, "greet");
  try {
    island.appear(false);
    assert.deepEqual([State.mode, island.fsm.state], ["peek", "peek"]);
    assert.equal(greeted.mock.callCount(), 1);
    pass(1);
    assert.deepEqual(shape(), [124, 116]);
    assert.equal(engine.state, "idle", "in the state it has: nothing to wear");
    assert.ok(!asleep() && engine.raise > 0.9, "waving");
    pass(1.3);
    assert.equal(State.mode, "peek", "2.3 s in");
    pass(0.2);
    assert.deepEqual([State.mode, island.fsm.state], ["compact", "petit"]);
    pass(2);
    assert.ok(asleep(), "and nothing runs after it");
    assert.deepEqual([engine.raise, engine.oy, engine.changing], [0, 0, false]);
    // A click during the greeting opens the island on what it always opens on.
    island.fsm.forceHidden();
    pass(1);
    island.appear(false);
    pass(1);
    mousedown(0);
    pass(1);
    assert.deepEqual([State.mode, State.view], ["expanded", "overview"]);
    assert.equal(engine.raise, 0, "and the wave ends with the pocket");
    assert.equal(greeted.mock.callCount(), 2);
  } finally {
    greeted.mock.restore();
  }
});

test("started with the computer, parked off-screen or paused: no greeting, the island only shows itself compact", () => {
  const greeted = mock.method(engine, "greet");
  try {
    island.appear(true);
    assert.deepEqual([State.mode, island.fsm.state], ["compact", "petit"], "at login");
    for (const away of [() => island.setParked(true), () => { State.paused = true; }]) {
      island.fsm.forceHidden();
      pass(1);
      away();
      island.appear(false);
      assert.deepEqual([State.mode, island.fsm.state], ["compact", "petit"]);
      assert.equal(island.greet(), false);
      island.setParked(false);
      State.paused = false;
    }
    assert.equal(greeted.mock.callCount(), 0);
    // Back in sight, it can greet.
    island.fsm.forceHidden();
    assert.equal(island.greet(), true);
  } finally {
    greeted.mock.restore();
  }
});

test("the page is told whether Liv started with the computer, and greets from that", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const lib = read("../src-tauri/src/lib.rs");
  // BootInfo is sent in camelCase: `at_login` arrives as `atLogin`.
  assert.match(lib, /#\[serde\(rename_all = "camelCase"\)\]\s*pub struct BootInfo \{[^}]*\bat_login: bool,/);
  assert.match(lib, /at_login: launched_at_login\(\),/);
  assert.match(lib, /const AUTOSTART_ARG: &str = "--autostart";/);
  assert.match(read("../src/core/bridge.ts"), /atLogin: boolean;/);
  assert.match(read("../src/main.ts"), /island\.appear\(boot\?\.atLogin === true\);/);
});

// ── The pointer on Liv ────────────────────────────────────────────────────────

test("a left click on Liv's head pokes it, from the side it lands on; anywhere else it does not", () => {
  const poked = mock.method(engine, "poke");
  try {
    island.alert("overview");
    pass(1);
    pointer(ON_LIV);
    mousedown(0);
    assert.deepEqual(poked.mock.calls.map((c) => c.arguments), [[1]], "on the middle counts as the right");
    pointer([ON_LIV[0] - 10, ON_LIV[1]]);
    mousedown(0);
    assert.deepEqual(poked.mock.calls.at(-1).arguments, [-1]);
    for (const button of [1, 2]) mousedown(button);
    assert.equal(poked.mock.callCount(), 2, "the left button only");
    // Beside the head: the antenna, the card, the header.
    for (const at of [[ON_LIV[0], ON_LIV[1] - 28], [ON_LIV[0] + 30, ON_LIV[1]], [300, 100], [300, 20]]) {
      pointer(at);
      mousedown(0);
    }
    assert.equal(poked.mock.callCount(), 2);
    // Never while a control of the card is under the pointer.
    pointer(ON_LIV);
    const button = root.find("button")[0];
    for (const fn of islandEl.listeners.get("mousedown")) fn({ button: 0, target: button });
    for (const fn of islandEl.listeners.get("mousedown")) fn({ button: 0, target: button.firstElementChild ?? button });
    assert.equal(poked.mock.callCount(), 2);
    for (const fn of islandEl.listeners.get("mousedown")) fn({ button: 0, target: byId("views") });
    assert.equal(poked.mock.callCount(), 3, "the card itself is not a control");

    // Folded, the click opens the island: it is not a poke.
    island.collapse();
    pass(1);
    pointer([40 + 216 + 40, 16]);
    mousedown(0);
    assert.equal(State.mode, "expanded");
    assert.equal(poked.mock.callCount(), 3);
  } finally {
    poked.mock.restore();
  }
});

test("a click annoys Liv, three make it dizzy, and each time the frame loop stops again", () => {
  island.alert("overview");
  island.setPinned(true);
  pass(1);
  // Paused it does not breathe: the only frames are the reaction's own.
  holdStill();
  pass(3);
  assert.ok(asleep());

  pointer(ON_LIV);
  mousedown(0);
  pointer(FAR);
  pass(0.1);
  assert.ok(!asleep() && engine.squash !== 0, "it flinches");
  pass(1);
  assert.ok(!asleep(), "frowning for 1.2 s");
  pass(1.5);
  assert.ok(asleep(), "over: no frame");
  assert.equal(State.mode, "expanded", "and nothing of the island changed");

  pointer(ON_LIV);
  for (let i = 0; i < 3; i++) {
    mousedown(0);
    pass(0.3);
  }
  pointer(FAR);
  assert.notEqual(engine.wobble, 0, "dizzy");
  pass(2.5);
  assert.ok(!asleep(), "for 3.3 s");
  pass(2);
  assert.ok(asleep());
  assert.deepEqual([State.view, State.mode], ["overview", "expanded"], "no card, no view of its own");
});

test("the pointer resting on Liv for 2 s wins it over, and when it leaves the loop stops", () => {
  island.alert("overview");
  island.setPinned(true);
  pass(1);
  holdStill();
  pass(3);
  assert.ok(asleep());
  pointer(ON_LIV);
  pass(1.9);
  assert.ok(!asleep(), "the rest is being timed");
  assert.equal(engine.lift, 0);
  pass(0.5);
  assert.ok(engine.lift > 0.25, "hearts: its hands are up a little");
  pointer(FAR);
  pass(1);
  assert.ok(!asleep(), "leaving does not cut it short");
  pass(2);
  assert.ok(asleep());

  // Leaving before the two seconds: nothing happens, and nothing is left running.
  pointer(ON_LIV);
  pass(1.5);
  pointer(FAR);
  pass(1);
  assert.ok(asleep());
  assert.equal(engine.lift, 0);
});

test("no reaction where Liv is not the island's own figure: folded, in its pocket, or during the drop sequence", () => {
  const poked = mock.method(engine, "poke");
  const hovered = mock.method(engine, "hover");
  try {
    // In the pocket a click opens the island; resting there only holds it.
    stop();
    pass(1);
    pointer(ON_POCKET);
    assert.ok(hovered.mock.calls.every((c) => c.arguments[0] === false));
    mousedown(0);
    assert.equal(poked.mock.callCount(), 0);
    pass(1);
    assert.equal(State.mode, "expanded");
    // Open: now the pointer on its head counts.
    pointer([40 + 62, 103]);
    assert.equal(hovered.mock.calls.at(-1).arguments[0], true);
    // The island folds: whatever it was doing ends, and the pointer is off it.
    const calmed = mock.method(engine, "calm");
    island.collapse();
    assert.equal(calmed.mock.callCount(), 1);
    calmed.mock.restore();
    pointer(ON_ISLAND);
    assert.equal(hovered.mock.calls.at(-1).arguments[0], false);
  } finally {
    poked.mock.restore();
    hovered.mock.restore();
    hook({ hook_event_name: "SessionEnd", session_id: "s1" });
  }
});

// ── The open island's shape (Settings → General → Appearance) ─────────────────

/** Settings says so: the four numbers reach the island as a saved setting does. */
const reshape = (look) => {
  State.settings = { ...State.settings, ...look };
  island.applyAppearance();
};
/** Back to the inherited island, for the tests that follow. */
const inherit = () => reshape({ islandWidth: 640, islandExtraHeight: 0, islandRadius: 22, islandOpacity: 100 });
const islandWidth = () => Math.round(Number.parseFloat(islandEl.style.width));
/** The radius of the island's lower corners, once it has settled. */
const corner = () => Math.round(Number.parseFloat(islandEl.style.borderRadius.split(" ")[2]) * 100) / 100;
/** How far the island is from the left edge of its window, as Rust last heard it. */
const rectX = () => Math.round(sent("set_island_rect").at(-1).x);
/** Where the island draws Liv: the middle of its canvas, from the island's corner. */
const livAt = () => {
  const { left, top, width } = byId("bot-canvas").style;
  const half = Number.parseFloat(width) / 2;
  return [Math.round(Number.parseFloat(left) + half), Math.round(Number.parseFloat(top) + half)];
};

test("an island nobody reshaped opens as it always did, fully opaque", () => {
  island.applyAppearance();
  island.alert("overview");
  pass(2);
  assert.deepEqual(shape(), [640, 160]);
  assert.deepEqual([islandEl.style.width, islandEl.style.height], ["640px", "160px"]);
  assert.equal(corner(), 22);
  // In the middle of the 720 px panel.
  assert.equal(rectX(), 40);
  assert.equal(islandEl.style["--island-opacity"], "1");
  assert.equal(islandEl.style["--island-extra-h"], "0px");
  assert.deepEqual(livAt(), [68, 101]);
  island.collapse();
  pass(1);
  assert.deepEqual(shape(), [288, 32]);
  assert.equal(corner(), 14);
  island.fsm.forceHidden();
  pass(1);
  assert.equal(corner(), 10, "the closed island, Liv in it");
});

test("made wider, taller and rounder in Settings, the island opens at that size in the middle of its wider panel", () => {
  try {
    reshape({ islandWidth: 800, islandExtraHeight: 40, islandRadius: 30, islandOpacity: 60 });
    island.alert("overview");
    pass(2);
    assert.deepEqual(shape(), [800, 200]);
    assert.deepEqual([islandEl.style.width, islandEl.style.height], ["800px", "200px"]);
    assert.equal(corner(), 30);
    // The panel is 880 wide for it (Rust resizes the window; here the page has no window to measure).
    assert.equal(rectX(), 40);
    assert.equal(islandEl.style["--island-opacity"], "0.6");
    assert.equal(islandEl.style["--island-extra-h"], "40px");
    // Liv: as far from the left edge as ever, and on the middle of the taller card.
    assert.deepEqual(livAt(), [68, 121]);

    // Every view gets the same extra: the tools, the taller cards.
    island.setView("tools");
    pass(1);
    assert.deepEqual(shape(), [800, 276]);
    assert.deepEqual(livAt(), [28, 58], "in the heading of the left card, which stays at the top");
    island.setView("recap");
    pass(1);
    assert.deepEqual(shape(), [800, 224]);

    // Folded it is the island it always was, its corners in proportion and no rounder than a half circle.
    island.collapse();
    pass(1);
    assert.deepEqual(shape(), [288, 32]);
    assert.equal(rectX(), (880 - 288) / 2);
    assert.equal(corner(), 16);
    assert.equal(islandEl.style["--island-opacity"], "0.6", "see-through in every mode");
    // Liv's pocket has the open island's corners.
    stop();
    pass(1);
    assert.equal(State.mode, "peek");
    assert.deepEqual(shape(), [124, 116]);
    assert.equal(corner(), 30);
    // And the closed island its own, in the same proportion (10 for 22), capped at half its height.
    island.fsm.forceHidden();
    pass(1);
    assert.equal(corner(), 12);
  } finally {
    hook({ hook_event_name: "SessionEnd", session_id: "s1" });
    inherit();
  }
});

test("a change saved while the island is open is reached with the island's usual motion, not a jump", () => {
  try {
    island.alert("overview");
    island.setPinned(true);
    pass(2);
    assert.deepEqual(shape(), [640, 160]);

    // Wider and taller: the spring it opens with.
    reshape({ islandWidth: 900, islandExtraHeight: 80 });
    pass(0.1);
    const growing = [Number.parseFloat(islandEl.style.width), Number.parseFloat(islandEl.style.height)];
    assert.ok(growing[0] > 640 && growing[0] < 900, `width ${growing[0]} on its way`);
    assert.ok(growing[1] > 160 && growing[1] < 240, `height ${growing[1]} on its way`);
    pass(2);
    assert.deepEqual(shape(), [900, 240]);
    assert.equal(rectX(), 40, "980 px of panel for 900 of island");
    assert.deepEqual(livAt(), [68, 141]);

    // Narrower again: the curve it folds with, 340 ms and no overshoot.
    reshape({ islandWidth: 700 });
    pass(0.1);
    const shrinking = Number.parseFloat(islandEl.style.width);
    assert.ok(shrinking > 700 && shrinking < 900, `width ${shrinking} on its way`);
    pass(0.3);
    assert.equal(islandWidth(), 700);
    assert.equal(islandHeight(), 240);

    // The corners alone.
    reshape({ islandRadius: 0 });
    pass(1);
    assert.equal(corner(), 0);
    assert.deepEqual(shape(), [700, 240]);

    // The opacity alone moves nothing: it is the stylesheet's.
    calls.length = 0;
    reshape({ islandOpacity: 45 });
    pass(0.5);
    assert.equal(islandEl.style["--island-opacity"], "0.45");
    assert.deepEqual(sent("set_island_rect"), [], "the island's shape did not change");

    // What Settings cannot offer is brought into range: the widest, the most see-through.
    reshape({ islandWidth: 4000, islandExtraHeight: -50, islandRadius: Number.NaN, islandOpacity: 3 });
    pass(2);
    assert.deepEqual(shape(), [960, 160]);
    assert.equal(corner(), 22);
    assert.equal(islandEl.style["--island-opacity"], "0.4");

    // Reset: the inherited island again.
    inherit();
    pass(2);
    assert.deepEqual(shape(), [640, 160]);
    assert.equal(corner(), 22);
    assert.equal(islandEl.style["--island-opacity"], "1");
    assert.deepEqual(livAt(), [68, 101]);
  } finally {
    inherit();
  }
});

test("a change saved while the island is folded waits for it to open; the compact island keeps its size", () => {
  try {
    island.reveal();
    pass(1);
    assert.deepEqual(shape(), [288, 32]);
    reshape({ islandWidth: 960, islandExtraHeight: 160 });
    pass(1);
    assert.deepEqual([islandWidth(), islandHeight()], [288, 32]);
    assert.equal(rectX(), (1040 - 288) / 2, "in the middle of the wider panel");
    pointer(ON_ISLAND);
    mousedown(0);
    pass(2);
    assert.equal(State.mode, "expanded");
    assert.deepEqual(shape(), [960, 320]);
  } finally {
    inherit();
  }
});

test("the page hears its window was resized and tells Rust where the island is in it", () => {
  island.reveal();
  pass(1);
  calls.length = 0;
  // Rust resized the window for a wider island: the compact island is in the middle of another width.
  globalThis.innerWidth = 1040;
  try {
    for (const fn of windowListeners.resize) fn();
    assert.equal(rectX(), (1040 - 288) / 2);
    assert.deepEqual(shape(), [288, 32]);
  } finally {
    delete globalThis.innerWidth;
    for (const fn of windowListeners.resize) fn();
  }
});

test("a card that asks for a height of its own gets the extra on top, and the wider island's line holds a longer command", () => {
  // 72 characters and the tool's name: more than the 640 island's one line, less than the 960 island's.
  const command = "x".repeat(72);
  let requestId = permission(command);
  pass(2);
  assert.equal(islandHeight(), 200, "the taller card, on the inherited island");
  emit("approval-expired", requestId);
  pass(1);
  try {
    reshape({ islandExtraHeight: 50 });
    requestId = permission(command, "s2");
    pass(2);
    assert.deepEqual(shape(), [640, 250]);
    emit("approval-expired", requestId);
    pass(1);
    assert.equal(islandHeight(), 210, "the overview, with the same extra");

    reshape({ islandWidth: 960, islandExtraHeight: 0 });
    requestId = permission(command, "s3");
    pass(2);
    assert.deepEqual(shape(), [960, 160], "it fits the one line now");
    emit("approval-expired", requestId);
    pass(1);
  } finally {
    inherit();
  }
});

/** A slider of Settings → Appearance moves: the four numbers reach the island before they are saved. */
const drag = (look) => {
  State.settings = { ...State.settings, ...look };
  island.previewAppearance();
};

test("a slider dragged in Settings opens the folded island to show the shape, and it folds on its usual clock after the last move", () => {
  try {
    // Closed: it opens on what it has to show, at the size being chosen.
    drag({ islandWidth: 700 });
    pass(2);
    assert.deepEqual([State.mode, State.view, island.fsm.state], ["expanded", "overview", "home"]);
    assert.deepEqual(shape(), [700, 160]);
    // Dragged on, ten seconds later: the island follows, and the countdown starts over.
    pass(10);
    drag({ islandWidth: 760, islandExtraHeight: 20 });
    pass(2);
    assert.deepEqual(shape(), [760, 180]);
    pass(8);
    assert.equal(State.mode, "expanded", "18 s after the first move, 10 after the last");
    pass(5.2);
    assert.equal(State.mode, "compact", "15 s after the last move");

    // Open on another view, it keeps that view.
    island.alert("tools");
    pass(1);
    drag({ islandRadius: 4 });
    pass(1);
    assert.deepEqual([State.mode, State.view], ["expanded", "tools"]);
    assert.equal(corner(), 4);
    // Pinned, or with the pointer on it, nothing starts a countdown.
    island.setPinned(true);
    drag({ islandOpacity: 70 });
    pass(20);
    assert.equal(State.mode, "expanded");
    island.setPinned(false);
    pointer(ON_ISLAND);
    drag({ islandOpacity: 80 });
    pass(20);
    assert.equal(State.mode, "expanded");
    assert.equal(islandEl.style["--island-opacity"], "0.8");
    pointer(FAR);
    pass(15.2);
    assert.equal(State.mode, "compact");

    // A card that waits is what opens, and it stays pinned as it always is.
    island.fsm.forceHidden();
    pass(1);
    const requestId = permission();
    pass(1);
    island.foldApproval();
    pass(1);
    assert.equal(State.mode, "compact");
    drag({ islandWidth: 800 });
    pass(2);
    assert.deepEqual([State.mode, State.view, State.isPinned], ["expanded", "approval", true]);
    assert.deepEqual(shape(), [800, 180]);
    emit("approval-expired", requestId);
    pass(1);

    // Paused, or parked for a full-screen app: nobody would see it. It takes the shape and stays shut.
    island.fsm.forceHidden();
    pass(1);
    State.paused = true;
    drag({ islandWidth: 900 });
    pass(1);
    assert.equal(State.mode, "hidden");
    State.paused = false;
    island.setParked(true);
    drag({ islandWidth: 910 });
    pass(1);
    assert.equal(State.mode, "hidden");
    island.setParked(false);
    island.alert("overview");
    pass(2);
    assert.deepEqual(shape(), [910, 180], "the shape was taken all the same");
  } finally {
    inherit();
  }
});
