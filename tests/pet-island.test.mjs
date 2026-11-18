// Liv leaving the island and coming home, on the island's side
// (src/island/island.ts with src/island/pet.ts), built on the fake DOM and
// driven the way the app drives it: the pointer through onCursor and the
// page's mouse events, Rust through the bridge's stand-in — whose answers to
// the window's commands are given here — and time and frames by hand. What
// the island asks of Rust and tells Liv's window is read from what it invokes.

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
const windowListeners = {};
globalThis.addEventListener = (type, fn) => (windowListeners[type] ??= []).push(fn);
globalThis.chrome = { webview: { postMessageWithAdditionalObjects() {} } };

// Rust's side of Liv's window: what each command answers. A way (`pet_travel`)
// only ends when the test says so.
const rust = {
  pickUp: true,
  appear: true,
  route: { from: [909, -52], to: [1810, 915], unit: 1 },
  ways: [],
};
const answer = {
  pet_pick_up: () => rust.pickUp,
  pet_appear: () => rust.appear,
  pet_route: () => rust.route,
  pet_travel: (args) => new Promise((resolve) => rust.ways.push({ ...args, resolve })),
  // A dropped file, copied into the inbox.
  ingest_file: ({ path }) => ({ name: path.split("\\").pop(), path: `C:\\inbox\\${path.split("\\").pop()}`, size: 5 }),
};
const invoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const plain = await invoke(cmd, args);
  return cmd in answer ? answer[cmd](args) : plain;
};

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
const asleep = () => frames.length === 0;
/** Lets what was asked of Rust be answered, and what follows from it happen. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
};
/** The way under way ends: Liv got there, or the way was overtaken. */
async function arrive(there = true) {
  assert.ok(rust.ways.length > 0, "no way is under way");
  rust.ways.shift().resolve(there);
  await settle();
}

const { Island } = await import("../src/island/island.ts");
const { registerHookHandlers } = await import("../src/island/hooks.ts");
const { runGlobalShortcut } = await import("../src/island/shortcuts.ts");
const { registerToolsHandlers } = await import("../src/island/tools.ts");
const { Tools } = await import("../src/core/tools.ts");
const { Sound } = await import("../src/core/sound.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { PEEK_HOLD } = await import("../src/island/fsm.ts");
const { DRAG_THRESHOLD } = await import("../src/pet/drag.ts");
const { callsHome } = await import("../src/pet/outing.ts");
const { TRAVEL, travelPath } = await import("../src/pet/travel.ts");
const { HELLO_FRESH_MS, PET_EVENTS, PET_WINDOW_LABEL } = await import("../src/pet/wire.ts");
const { seasonalOutfit } = await import("../src/robot/outfits.ts");

const root = dom.root();
const island = new Island(root, () => 0.5);
registerHookHandlers(island);
registerToolsHandlers(island);
const engine = island.engine;
const outing = island.pet.outing;

const byId = (id) => [...root.walk()].find((el) => el.getAttribute("id") === id);
const islandEl = byId("island");
const paint = new Proxy(() => {}, {
  get: (_, key) => (key === "getTransform" ? () => ({ a: 1, b: 0 }) : paint),
  set: () => true,
  apply: () => paint,
});
byId("bot-canvas").getContext = () => paint;
for (const field of root.find(".chat-input")) field.value = "";

const FAR = [-10_000, -10_000];
/** Liv's head on the open island's overview: its slot is centred 68 px in, on the card's middle. */
const ON_LIV = [40 + 68, 103];
const pointer = ([x, y]) => island.onCursor(x, y);
const mousedown = (button = 0) => {
  for (const fn of islandEl.listeners.get("mousedown")) fn({ button });
};
const mouseup = () => {
  for (const fn of windowListeners.mouseup) fn({ button: 0 });
};
const resume = () => { State.paused = false; };
const hook = (payload) => emit("hook", payload);
const stop = () => hook({ hook_event_name: "Stop", session_id: "s1", cwd: "C:\\code\\proj", last_assistant_message: "Done." });
const fail = () => hook({ hook_event_name: "StopFailure", session_id: "s1", cwd: "C:\\code\\proj", last_assistant_message: "API Error" });
let requests = 0;
function permission() {
  const request_id = `p${++requests}`;
  hook({ hook_event_name: "PermissionRequest", request_id, session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });
  return request_id;
}
/** What Liv's window was told it looks like, oldest first. */
const looks = () =>
  sent("plugin:event|emit_to")
    .filter((args) => args.event === PET_EVENTS.look)
    .map((args) => {
      assert.equal(args.target.label, PET_WINDOW_LABEL, "to Liv's window and no other");
      return args.payload;
    });
/** Whether the island draws Liv: its canvas, and the glow behind it. */
const figure = () => [byId("bot-canvas").style.opacity, byId("bot-glow").style.display];

/** Liv goes out to its spot by the shortcut, and lands. */
async function sendOut() {
  runGlobalShortcut(island, "desktopToggle", resume);
  await settle();
  await arrive();
  assert.equal(outing.phase, "out");
}

beforeEach(async () => {
  // Whatever the last test left: Liv home, the island folded, nothing waiting.
  mouseup();
  State.pendingApproval = null;
  State.approvalQueue = [];
  State.focusBeforeApproval = null;
  State.paused = false;
  island.setParked(false);
  State.setPinned(false);
  pointer(FAR);
  island.fsm.forceHidden();
  State.view = "overview";
  State.settings = { ...DEFAULT_SETTINGS };
  State.loadIntegrationTasks();
  for (let i = 0; i < 6 && (outing.phase !== "home" || rust.ways.length > 0); i++) {
    rust.ways.splice(0).forEach((way) => way.resolve(false));
    await settle();
    if (outing.phase === "carried") outing.dropped("home");
    else if (outing.phase === "out" || outing.phase === "visiting") outing.toggle();
    await settle();
  }
  outing.supported = true;
  Object.assign(rust, { pickUp: true, appear: true, route: { from: [909, -52], to: [1810, 915], unit: 1 } });
  pass(2);
  await settle();
  calls.length = 0;
  assert.deepEqual([outing.phase, State.petAway, State.mode], ["home", false, "hidden"]);
});

// ── Where Liv cannot leave ────────────────────────────────────────────────────

test("without a window of its own Liv stays in the island, and the island is as it always was", async () => {
  outing.supported = false;
  island.alert("overview");
  island.setPinned(true);
  pass(1);
  pointer(ON_LIV);
  mousedown();
  pointer([ON_LIV[0] + 60, ON_LIV[1] + 40]);
  mouseup();
  runGlobalShortcut(island, "desktopToggle", resume);
  State.settings.petOut = true;
  island.fsm.forceHidden();
  island.appear(false);
  await settle();
  pass(0.5);
  assert.deepEqual([outing.phase, State.petAway], ["home", false]);
  assert.equal(State.mode, "peek", "it greets from its pocket, as before");
  assert.deepEqual(calls.filter(([cmd]) => cmd.startsWith("pet_")), []);
  assert.deepEqual(looks(), []);
});

test("the island's page tells Rust whether Liv's window exists before it shows itself", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../src-tauri/src/lib.rs"), /#\[serde\(rename_all = "camelCase"\)\]\s*pub struct BootInfo \{[^}]*\bpet: bool,/);
  assert.match(read("../src/core/bridge.ts"), /\bpet: boolean;/);
  const main = read("../src/main.ts");
  const init = main.indexOf("await island.pet.init(boot?.pet === true);");
  assert.ok(init > 0 && init < main.indexOf("island.appear("));
});

// ── Dragged out of the island ─────────────────────────────────────────────────

test("a click on Liv is a click: it is annoyed, and stays in the island", async () => {
  await island.pet.init(true);
  const poked = mock.method(engine, "poke");
  try {
    island.alert("overview");
    island.setPinned(true);
    pass(1);
    pointer(ON_LIV);
    mousedown();
    assert.equal(poked.mock.callCount(), 1, "annoyed as it is pressed, as it always was");
    // A hand that is not perfectly still.
    pointer([ON_LIV[0] + 3, ON_LIV[1] - 2]);
    pointer([ON_LIV[0] + DRAG_THRESHOLD, ON_LIV[1]]);
    mouseup();
    // The pointer goes on its way, the button up.
    pointer([ON_LIV[0] + 200, ON_LIV[1] + 100]);
    await settle();
    assert.deepEqual(sent("pet_pick_up"), []);
    assert.deepEqual([outing.phase, State.petAway], ["home", false]);
  } finally {
    poked.mock.restore();
  }
});

test("pressed and dragged, Liv is picked up: its window comes under the pointer and its slot empties", async () => {
  island.alert("overview");
  island.setPinned(true);
  pass(1);
  assert.deepEqual(figure(), ["1", "block"]);
  pointer(ON_LIV);
  mousedown();
  pointer([ON_LIV[0] + DRAG_THRESHOLD + 1, ON_LIV[1]]);
  assert.deepEqual([outing.phase, State.petAway], ["carried", true], "at once");
  await settle();
  assert.deepEqual(sent("pet_pick_up").length, 1);
  // The pointer keeps moving, the button still held: it is picked up once.
  pointer([ON_LIV[0] + 80, ON_LIV[1] + 50]);
  pointer([400, 260]);
  await settle();
  assert.deepEqual(sent("pet_pick_up").length, 1);

  // The island keeps its card and its layout, without its figure.
  pass(0.5);
  assert.deepEqual(figure(), ["0", "none"]);
  assert.deepEqual([State.mode, State.view], ["expanded", "overview"]);
  const stepped = mock.method(engine, "update");
  pass(3);
  assert.equal(stepped.mock.callCount(), 0, "nothing of Liv is stepped or painted here while it is away");
  stepped.mock.restore();
  assert.ok(asleep(), "and the open island, with nothing breathing in it, asks for no frame");
  // Its head is no longer there to be clicked.
  const poked = mock.method(engine, "poke");
  pointer(ON_LIV);
  mousedown();
  mouseup();
  assert.equal(poked.mock.callCount(), 0);
  poked.mock.restore();

  // Dropped far from the island: it stays there, and that is its spot.
  mouseup();
  emit(PET_EVENTS.dropped, { x: 500, y: 290, from: "island" });
  await settle();
  assert.deepEqual([outing.phase, State.petAway, outing.lives], ["out", true, true]);
  assert.equal(sent("pet_settle").length, 1);
  assert.deepEqual(sent("pet_hide"), []);
});

test("dropped back on the island, Liv is simply there again", async () => {
  island.alert("overview");
  island.setPinned(true);
  pass(1);
  pointer(ON_LIV);
  mousedown();
  pointer([ON_LIV[0] + 30, ON_LIV[1] + 10]);
  await settle();
  pass(0.3);
  assert.deepEqual(figure(), ["0", "none"]);
  emit(PET_EVENTS.dropped, { x: 300, y: 120, from: "island" });
  await settle();
  pass(0.3);
  assert.deepEqual([outing.phase, State.petAway, outing.lives], ["home", false, false]);
  assert.deepEqual(sent("pet_hide"), [{ forget: true }]);
  assert.deepEqual(sent("pet_settle"), []);
  assert.deepEqual(figure(), ["1", "block"]);
});

test("a window that does not come leaves Liv where it was", async () => {
  rust.pickUp = false;
  island.alert("overview");
  island.setPinned(true);
  pass(1);
  pointer(ON_LIV);
  mousedown();
  pointer([ON_LIV[0] + 30, ON_LIV[1]]);
  await settle();
  pass(0.3);
  assert.deepEqual([outing.phase, State.petAway], ["home", false]);
  assert.deepEqual(figure(), ["1", "block"]);
});

test("Liv is only picked up from the open island, by its head", async () => {
  // Compact: a press opens the island.
  island.reveal();
  pass(1);
  pointer([40 + 216 + 40, 16]);
  mousedown();
  pointer([40 + 216 + 90, 60]);
  mouseup();
  // Open, beside the head; and a press that the island folding leaves behind.
  pointer([300, 100]);
  mousedown();
  pointer([400, 140]);
  mouseup();
  pointer(ON_LIV);
  mousedown();
  island.fsm.forcePetit();
  pointer([ON_LIV[0] + 60, ON_LIV[1]]);
  await settle();
  assert.deepEqual(sent("pet_pick_up"), []);
  assert.equal(outing.phase, "home");
});

// ── Sent out, and called home ─────────────────────────────────────────────────

test("the shortcut sends Liv to its spot along its way, and calls it home again", async () => {
  island.reveal();
  pass(1);
  runGlobalShortcut(island, "desktopToggle", resume);
  assert.deepEqual([outing.phase, State.petAway], ["leaving", true]);
  await settle();
  // From where Liv is in the compact island, to its spot, or one of Rust's choosing.
  const rect = sent("set_island_rect").at(-1);
  const [asked] = sent("pet_route");
  assert.deepEqual([sent("pet_route").length, asked.to, asked.anywhere], [1, "spot", true]);
  assert.ok(Math.abs(asked.x - (rect.x + 40)) < 0.5 && Math.abs(asked.y - 16) < 0.5, `${asked.x},${asked.y}`);
  // The way is drawn here and handed over whole.
  const path = travelPath({ x: 909, y: -52 }, { x: 1810, y: 915 }, 1);
  const way = rust.ways[0];
  assert.deepEqual([way.to, way.ms, way.points.length], ["spot", path.ms, path.points.length]);
  assert.deepEqual([way.points[0], way.points.at(-1)], [[909, -52], [1810, 915]]);
  assert.ok(way.ms >= TRAVEL.minMs && way.ms <= TRAVEL.maxMs);
  await arrive();
  assert.deepEqual([outing.phase, State.petAway, outing.lives], ["out", true, true]);

  calls.length = 0;
  runGlobalShortcut(island, "desktopToggle", resume);
  await settle();
  assert.equal(sent("pet_route")[0].to, "home");
  assert.equal(rust.ways[0].to, "home");
  assert.equal(State.petAway, true, "its slot stays empty until it lands");
  await arrive();
  assert.deepEqual([outing.phase, State.petAway, outing.lives], ["home", false, false]);
  assert.deepEqual(sent("pet_hide"), [{ forget: true }], "it lives in the island again");
});

test("from a hidden island Liv leaves from the middle of the top edge", async () => {
  State.settings.closedIsland = "hidden";
  State.notify();
  pass(1);
  runGlobalShortcut(island, "desktopToggle", resume);
  await settle();
  // The page is 720 px wide, the island glued to the middle of its top edge.
  const [{ x, y }] = sent("pet_route");
  assert.ok(Math.abs(x - 360) < 1 && y === 0, `${x},${y}`);
});

test("with nowhere to go the shortcut leaves Liv in the island", async () => {
  rust.route = null;
  island.reveal();
  pass(1);
  runGlobalShortcut(island, "desktopToggle", resume);
  await settle();
  pass(0.3);
  assert.deepEqual([outing.phase, State.petAway], ["home", false]);
  assert.deepEqual(sent("pet_travel"), []);
  assert.equal(byId("bot-canvas").style.opacity, "1");
});

test("the switch in Settings and a double click on Liv do what the shortcut does", async () => {
  await island.pet.init(true);
  emit(PET_EVENTS.ask, false);
  await settle();
  assert.deepEqual(sent("pet_route"), [], "already home");
  emit(PET_EVENTS.ask, true);
  await settle();
  await arrive();
  assert.equal(outing.phase, "out");
  emit(PET_EVENTS.ask, true);
  await settle();
  assert.equal(rust.ways.length, 0, "already out");

  emit(PET_EVENTS.home);
  await settle();
  assert.equal(rust.ways[0].to, "home");
  await arrive();
  assert.deepEqual([outing.phase, State.petAway], ["home", false]);
});

test("picked up on the desktop and dropped on the island, Liv is home and the island shows it", async () => {
  await island.pet.init(true);
  await sendOut();
  island.fsm.forceHidden();
  pass(1);
  calls.length = 0;
  emit(PET_EVENTS.grabbed);
  assert.equal(outing.phase, "carried");
  assert.equal(State.mode, "compact", "the island shows itself: a place to drop Liv on");
  // Let go on the compact island (288 × 32, in the middle of the 720 px page).
  emit(PET_EVENTS.dropped, { x: 360, y: 20, from: "desktop" });
  await settle();
  pass(0.5);
  assert.deepEqual([outing.phase, State.petAway], ["home", false]);
  assert.deepEqual(sent("pet_hide"), [{ forget: true }]);
  assert.equal(byId("bot-canvas").style.opacity, "1");

  // Dropped elsewhere it has a new spot.
  await sendOut();
  calls.length = 0;
  emit(PET_EVENTS.grabbed);
  emit(PET_EVENTS.dropped, { x: 900, y: 400, from: "desktop" });
  await settle();
  assert.deepEqual([outing.phase, sent("pet_settle").length], ["out", 1]);
});

// ── While Liv is out ──────────────────────────────────────────────────────────

test("while Liv is out the island shows no figure, compact, closed or open, and nothing blinks in it", async () => {
  await sendOut();
  // Compact: its minis and its clock, no head.
  island.reveal();
  pass(3);
  assert.deepEqual([State.mode, ...figure()], ["compact", "0", "none"]);
  assert.ok(asleep());
  const acted = mock.method(engine, "act");
  pass(30);
  assert.equal(acted.mock.callCount(), 0, "no sign of life is played for a figure that is not there");
  assert.ok(asleep(), "and no timer wakes the frame loop");

  // Closed, with Liv as what the closed island shows: the small island alone.
  State.settings.closedIsland = "robot";
  island.fsm.forceHidden();
  pass(30);
  assert.deepEqual([State.mode, ...figure()], ["hidden", "0", "none"]);
  assert.equal(acted.mock.callCount(), 0);
  acted.mock.restore();
  assert.ok(asleep());

  // Opened by hand: the card as it is, its slot empty; Liv stays where it is.
  island.reveal();
  pass(1);
  pointer([360, 16]);
  mousedown();
  mouseup();
  pass(1);
  assert.deepEqual([State.mode, ...figure()], ["expanded", "0", "none"]);
  assert.equal(rust.ways.length, 0, "a click of the user's is not the island needing them");
  assert.equal(outing.phase, "out");
});

test("Liv's window is told what Liv looks like only while it is out, and only when that changes", async () => {
  State.settings.livOutfit = "none";
  hook({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "C:\\code\\proj", prompt: "hello" });
  pass(1);
  assert.deepEqual(looks(), [], "home: nothing is said");
  runGlobalShortcut(island, "desktopToggle", resume);
  await settle();
  const first = looks();
  assert.equal(first.length, 1, "as it sets off");
  assert.deepEqual(first[0], { state: State.effectiveState, shell: null, hint: null, outfit: "none", beat: 0, hello: 0 });
  assert.notEqual(first[0].state, "idle");
  await arrive();
  // Nothing new: nothing said, however often the state is published.
  State.notify();
  State.notify();
  pass(2);
  assert.equal(looks().length, 1);
  hook({ hook_event_name: "PreToolUse", session_id: "s1", cwd: "C:\\code\\proj", tool_name: "Bash", tool_input: { command: "ls" } });
  pass(1);
  State.stateOverride = "thinking";
  State.notify();
  assert.equal(looks().at(-1).state, "thinking");
  State.stateOverride = null;
  State.notify();
  // The window's page came up late, or again: it is told afresh.
  await island.pet.init(true);
  const before = looks().length;
  emit(PET_EVENTS.ready);
  assert.equal(looks().length, before + 1);
});

test("a task that finishes or fails while Liv is out is celebrated where it stands, not in the pocket", async () => {
  await sendOut();
  island.fsm.forceHidden();
  pass(1);
  calls.length = 0;
  stop();
  pass(0.5);
  assert.equal(State.mode, "compact", "the island only shows itself: no pocket");
  assert.equal(byId("bot-canvas").style.opacity, "0");
  let last = looks().at(-1);
  assert.deepEqual([last.state, last.beat], ["finished", 1], "its entrance is played on the desktop");
  assert.equal(rust.ways.length, 0, "and it stays where it is");
  // It wears the state for as long as it would have stayed out of the island.
  pass(PEEK_HOLD.finished - 0.6);
  assert.equal(looks().at(-1).beat, 1);
  assert.notEqual(State.mode, "peek");

  // Again while it still celebrates: the entrance is played again.
  fail();
  pass(0.5);
  last = looks().at(-1);
  assert.deepEqual([last.state, last.beat], ["error", 2]);
  assert.notEqual(State.mode, "peek");
  // The island says so itself: peek() answers that Liv came out.
  assert.equal(island.peek("finished", "finished"), true);
  assert.equal(looks().at(-1).beat, 3);
  assert.notEqual(State.mode, "peek");
});

test("when something needs the user Liv flies home for the card, and back out once the island folds", async () => {
  await sendOut();
  island.fsm.forceHidden();
  pass(1);
  calls.length = 0;

  const id = permission();
  assert.deepEqual([State.mode, State.view], ["expanded", "approval"], "the card is up at once: it does not wait for Liv");
  assert.deepEqual(sent("approval_ack"), [{ requestId: id }]);
  await settle();
  assert.deepEqual([outing.phase, sent("pet_route").at(-1).to, rust.ways[0].to], ["returning", "home", "home"]);
  pass(0.3);
  assert.deepEqual(figure(), ["0", "none"], "the slot is empty while Liv is in the air");
  await arrive();
  pass(0.5);
  assert.deepEqual([outing.phase, State.petAway, outing.lives], ["visiting", false, true]);
  assert.deepEqual(figure(), ["1", "block"], "the card has its robot");
  assert.equal(engine.state, "approval");
  assert.deepEqual(sent("pet_hide"), [], "its window was put away by the way home: nothing is forgotten");
  // It stays for as long as the card does.
  pass(60);
  assert.equal(outing.phase, "visiting");

  // Answered in the terminal: the card goes, the island folds 15 s after, and
  // Liv goes back to its spot.
  calls.length = 0;
  emit("approval-expired", id);
  assert.equal(State.pendingApproval, null);
  assert.equal(outing.phase, "visiting", "for as long as the island is open");
  pass(16);
  assert.notEqual(State.mode, "expanded");
  await settle();
  assert.deepEqual([outing.phase, State.petAway], ["leaving", true]);
  assert.deepEqual(sent("pet_route").at(-1), { ...sent("pet_route").at(-1), to: "spot", anywhere: false });
  await arrive();
  assert.deepEqual([outing.phase, State.petAway, outing.lives], ["out", true, true]);
});

test("only what waits for the user, or a file to catch, brings Liv home", async () => {
  await sendOut();
  island.fsm.forceHidden();
  pass(1);
  // The chat by its shortcut, the tray's Open, a recap: the island opens, Liv stays out.
  for (const view of ["prompt", "overview", "recap"]) {
    island.alert(view);
    await settle();
    assert.equal(outing.phase, "out", view);
    island.collapse();
    await settle();
  }
  assert.equal(rust.ways.length, 0);
  // A file dragged onto the island: Liv comes home to catch it.
  island.alert("upload");
  await settle();
  assert.equal(outing.phase, "returning");
  await arrive();
  assert.equal(outing.phase, "visiting");
  // Folded by hand: back out.
  island.collapse();
  await settle();
  assert.equal(outing.phase, "leaving");
  await arrive();
  assert.equal(outing.phase, "out");
  // The pointer opening the compact island: Liv stays out.
  pointer([360, 16]);
  mousedown();
  mouseup();
  pass(1);
  await settle();
  assert.deepEqual([State.mode, outing.phase], ["expanded", "out"]);
});

test("the rule for calling Liv home", () => {
  assert.deepEqual(
    ["approval", "question", "upload", "overview", "prompt", "recap", "finished"].map((view) => callsHome(view, false)),
    [true, true, true, false, false, false, false],
  );
  // The wardrobe waits for nobody: Liv tries things on where it stands.
  assert.equal(callsHome("wardrobe", false), false);
  assert.equal(callsHome("wardrobe", true), false);
  // The office asking: its card is the overview with its pill in front.
  assert.equal(callsHome("overview", true), true);
});

// ── Liv starts ────────────────────────────────────────────────────────────────

test("Liv starts on the desktop when that is where it was left, and waves from its spot", async () => {
  State.settings.petOut = true;
  island.appear(false);
  assert.equal(State.petAway, true, "its slot is empty from the start: it never shows in the island first");
  await settle();
  pass(0.5);
  assert.equal(sent("pet_appear").length, 1);
  assert.deepEqual([outing.phase, State.petAway, outing.lives], ["out", true, true]);
  assert.equal(State.mode, "compact", "the island shows itself compact: no pocket");
  assert.equal(rust.ways.length, 0, "no way there: it is at its spot at once");
  const last = looks().at(-1);
  assert.ok(Date.now() - last.hello < HELLO_FRESH_MS && last.hello > 0, "the greeting is a wave, there");
});

test("started with the computer Liv is at its spot without a greeting; with its spot gone it greets from the island", async () => {
  State.settings.petOut = true;
  // The last greeting asked for, if any: none is asked for now.
  const greeted = island.pet.hello;
  island.appear(true);
  await settle();
  pass(0.5);
  assert.deepEqual([outing.phase, State.mode], ["out", "compact"]);
  assert.ok(looks().length > 0 && looks().every((look) => look.hello === greeted));
  outing.toggle();
  await settle();
  await arrive();
  island.fsm.forceHidden();
  pass(1);

  // Its display was unplugged: Rust says no, and Liv greets from its pocket as ever.
  rust.appear = false;
  calls.length = 0;
  island.appear(false);
  await settle();
  pass(0.5);
  assert.deepEqual([outing.phase, State.petAway], ["home", false]);
  assert.equal(State.mode, "peek");
  assert.deepEqual(sent("pet_hide"), [{ forget: true }]);
});

// ── The wardrobe ──────────────────────────────────────────────────────────────

/** Liv's head on the wardrobe card: its slot is centred 62 px in. */
const ON_LIV_DRESSING = [40 + 62, 103];
const wardrobe = island.views.get("wardrobe").el;
const CHOICES = ["auto", "none", "glasses", "scarf", "headphones", "beanie", "star"];
const chip = (id) => wardrobe.find(".picker-chip")[CHOICES.indexOf(id)];
/** What the island's own Liv has on, and how far on. */
const wears = () => [engine.worn, engine.wear];

test("a right-click on Liv's head on the open island opens its wardrobe, and another one goes back", () => {
  State.settings.livOutfit = "none";
  island.alert("overview");
  island.setPinned(true);
  pass(1);
  const usual = State.view;
  // Anywhere else on the island the other button does nothing, as before.
  pointer([360, 100]);
  mousedown(2);
  pass(0.5);
  assert.equal(State.view, usual);
  pointer(ON_LIV);
  mousedown(2);
  mouseup();
  pass(1);
  assert.deepEqual([State.mode, State.view], ["expanded", "wardrobe"]);
  // It is not a click on Liv: it does not mind, and it is not picked up.
  assert.equal(engine.mood, null);
  pointer([ON_LIV[0] + 60, ON_LIV[1] + 40]);
  pass(0.5);
  assert.deepEqual([outing.phase, State.petAway], ["home", false]);
  assert.equal(State.view, "wardrobe");
  // Nothing is saved, and nothing is asked of the keyboard, by opening it.
  assert.deepEqual(sent("save_settings"), []);
  assert.deepEqual(sent("focus_window"), []);

  // On Liv again, where it stands on this card: back to the usual view.
  pointer(ON_LIV_DRESSING);
  mousedown(2);
  pass(1);
  assert.deepEqual([State.mode, State.view], ["expanded", usual]);

  // Escape folds the wardrobe as it folds any card.
  mousedown(2);
  pass(0.5);
  assert.equal(State.view, "wardrobe");
  island.setPinned(false);
  for (const fn of windowListeners.keydown) fn({ key: "Escape", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  pass(1);
  assert.equal(State.mode, "compact");
});

test("on the folded island the other button does nothing: no wardrobe, and the island does not open", () => {
  island.reveal();
  pass(1);
  assert.equal(State.mode, "compact");
  pointer([40 + (640 - 288) / 2 + 40, 16]);
  mousedown(2);
  pass(1);
  assert.deepEqual([State.mode, State.view], ["compact", "overview"]);
  // In its pocket neither.
  island.fsm.forceHidden();
  pass(1);
  assert.ok(island.greet());
  pass(1);
  mousedown(2);
  pass(0.5);
  assert.equal(State.mode, "peek");
});

test("in the wardrobe a chip tries its outfit on Liv at once, leaving puts back what it wears, a click keeps it", () => {
  State.settings.livOutfit = "none";
  island.openWardrobe();
  island.setPinned(true);
  pass(1);
  assert.deepEqual([State.mode, State.view], ["expanded", "wardrobe"]);
  assert.deepEqual(wears(), ["none", 0]);
  assert.ok(chip("none").classList.contains("on"));

  chip("scarf").fire("mouseenter");
  assert.equal(State.outfitPreview, "scarf");
  pass(0.1);
  assert.equal(engine.worn, "scarf", "at once: it is already coming on");
  pass(0.4);
  assert.deepEqual(wears(), ["scarf", 1]);
  assert.deepEqual(sent("save_settings"), [], "trying is not keeping");

  chip("scarf").fire("mouseleave");
  pass(0.4);
  assert.deepEqual(wears(), ["none", 0]);

  // Across the chips: the one in place leaves before the next arrives.
  chip("glasses").fire("mouseenter");
  pass(0.5);
  chip("glasses").fire("mouseleave");
  chip("beanie").fire("mouseenter");
  pass(0.1);
  assert.equal(engine.worn, "glasses");
  assert.ok(engine.wear < 1);
  pass(0.5);
  assert.deepEqual(wears(), ["beanie", 1]);

  // A click keeps it: saved, marked, and still on once the pointer leaves.
  chip("beanie").fire("click");
  assert.equal(State.settings.livOutfit, "beanie");
  assert.equal(sent("save_settings").at(-1).settings.livOutfit, "beanie");
  pass(0.1);
  assert.ok(chip("beanie").classList.contains("on") && !chip("none").classList.contains("on"));
  chip("beanie").fire("mouseleave");
  pass(0.5);
  assert.deepEqual(wears(), ["beanie", 1]);

  // The island folds with the pointer still on a chip: Liv is back in what it wears.
  chip("star").fire("mouseenter");
  pass(0.5);
  assert.deepEqual(wears(), ["star", 1]);
  island.setPinned(false);
  island.collapse();
  pass(1);
  assert.equal(State.outfitPreview, null);
  assert.equal(State.mode, "compact");
  assert.equal(engine.worn, "beanie");
  // And nothing it wears keeps a frame going: the compact island is at rest.
  pass(2);
  assert.ok(asleep());
});

test("what Liv wears follows the setting wherever it is changed, and Auto the day the island last showed itself", () => {
  State.settings.closedIsland = "robot";
  State.settings.livOutfit = "headphones";
  State.notify();
  island.alert("overview");
  island.setPinned(true);
  pass(1);
  assert.deepEqual(wears(), ["headphones", 1]);
  // Settings picks another one (`settings-changed`): it changes in front of you.
  State.settings = { ...State.settings, livOutfit: "glasses" };
  State.notify();
  pass(0.1);
  assert.equal(engine.worn, "headphones");
  pass(0.5);
  assert.deepEqual(wears(), ["glasses", 1]);
  // A word this build does not have: Auto.
  State.settings = { ...State.settings, livOutfit: "cape" };
  State.notify();
  pass(0.6);
  assert.equal(engine.worn, seasonalOutfit(new Date()));

  // Auto dresses Liv for the day it last looked at the calendar.
  State.settings = { ...State.settings, livOutfit: "auto" };
  island.today = new Date(2027, 0, 20);
  State.notify();
  pass(0.6);
  assert.deepEqual(wears(), ["scarf", 1]);
  island.today = new Date(2026, 11, 31);
  State.notify();
  pass(0.6);
  assert.deepEqual(wears(), ["star", 1]);
  // It looks again when the island next shows itself: no timer does.
  island.setPinned(false);
  island.fsm.forceHidden();
  pass(2);
  assert.ok(asleep(), "folded, nothing runs");
  const before = island.today;
  pass(100);
  assert.equal(island.today, before, "however long it stays folded");
  island.reveal();
  assert.notEqual(island.today, before);
  pass(1);
  assert.equal(engine.worn, seasonalOutfit(new Date()));
  // And when the settings change, as they do when the app starts.
  const stale = (island.today = new Date(2020, 5, 1));
  island.applySettings();
  // The clock's one timer is a real one here: left running, this file would never end.
  clearInterval(island.clockTimer);
  island.clockTimer = undefined;
  assert.notEqual(island.today, stale);
});

test("folded with nothing of Liv in sight, a change of clothes is not played: it simply has it on", () => {
  State.settings.closedIsland = "time";
  State.settings.livOutfit = "none";
  State.notify();
  pass(2);
  assert.equal(State.mode, "hidden");
  assert.ok(asleep());
  State.settings = { ...State.settings, livOutfit: "scarf" };
  State.notify();
  pass(0.05);
  assert.deepEqual(wears(), ["scarf", 1], "no pop that nobody would see");
  pass(1);
  assert.ok(asleep());
  // Parked off-screen for a full-screen app: the same.
  island.reveal();
  pass(1);
  island.setParked(true);
  State.settings = { ...State.settings, livOutfit: "beanie" };
  State.notify();
  pass(0.05);
  assert.deepEqual(wears(), ["beanie", 1]);
  pass(1);
  assert.ok(asleep());
});

test("the wardrobe never opens over a card that waits: the card comes up instead", () => {
  permission();
  pass(1);
  assert.equal(State.view, "approval");
  island.openWardrobe();
  pass(0.5);
  assert.equal(State.view, "approval");
  pointer([40 + 62, 103]);
  mousedown(2);
  pass(0.5);
  assert.equal(State.view, "approval");
  // Folded away, still waiting: the shortcut brings the card back, not the wardrobe.
  island.foldApproval();
  pass(1);
  runGlobalShortcut(island, "wardrobeToggle", resume);
  pass(0.5);
  assert.deepEqual([State.mode, State.view], ["expanded", "approval"]);
  assert.ok(State.pendingApproval, "nothing was answered");
  assert.deepEqual(sent("approval_decision"), []);
});

test("the shortcut opens the wardrobe from the folded island, with the keyboard for Esc, and closes it again", () => {
  State.paused = true;
  runGlobalShortcut(island, "wardrobeToggle", resume);
  pass(1);
  assert.deepEqual([State.paused, State.mode, State.view], [false, "expanded", "wardrobe"]);
  assert.deepEqual(sent("focus_window").at(-1), { focused: true });
  runGlobalShortcut(island, "wardrobeToggle", resume);
  pass(0.5);
  assert.deepEqual([State.mode, State.view], ["expanded", State.defaultView()]);
});

// ── The tools ─────────────────────────────────────────────────────────────────

const tools = island.views.get("tools").el;
const copied = (id, preview) => ({ id, kind: "text", preview, chars: preview.length, at: Date.now() });

test("the tools shortcut opens the island on the tools, with the keyboard for Esc, and folds it again", () => {
  State.paused = true;
  runGlobalShortcut(island, "toolsToggle", resume);
  pass(1);
  assert.deepEqual([State.paused, State.mode, State.view], [false, "expanded", "tools"]);
  assert.deepEqual(sent("focus_window").at(-1), { focused: true });
  assert.ok(tools.classList.contains("on"));
  assert.ok(root.find(".tab")[4].classList.contains("on"), "its tab is the one lit in the header");
  // Liv is there, small, in the clipboard card's heading.
  assert.deepEqual(figure(), ["1", "block"]);
  assert.deepEqual([island.botCx.target, island.botCy.target], [28, 58]);
  // Nothing is saved, and nothing asked of the clipboard, by opening it.
  assert.deepEqual(calls.filter(([cmd]) => cmd === "save_settings" || cmd.startsWith("clipboard_")), []);

  // The shortcut again: the island folds, and whoever had the keyboard has it back.
  runGlobalShortcut(island, "toolsToggle", resume);
  pass(1);
  assert.equal(State.mode, "compact");
  assert.deepEqual(sent("focus_window").at(-1), { focused: false });

  // From the header's tab, with the mouse: the tools, and the keyboard stays where it is.
  island.alert("overview");
  pass(1);
  calls.length = 0;
  root.find(".tab")[4].fire("click");
  pass(1);
  assert.deepEqual([State.mode, State.view], ["expanded", "tools"]);
  assert.deepEqual(sent("focus_window"), []);
  // Escape folds it as it folds any card.
  for (const fn of windowListeners.keydown) fn({ key: "Escape", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  pass(1);
  assert.equal(State.mode, "compact");
});

test("the tools never open over a card that waits: the card comes up instead", () => {
  permission();
  pass(1);
  island.foldApproval();
  pass(1);
  runGlobalShortcut(island, "toolsToggle", resume);
  pass(0.5);
  assert.deepEqual([State.mode, State.view], ["expanded", "approval"]);
  assert.ok(State.pendingApproval, "nothing was answered");
  assert.deepEqual(sent("approval_decision"), []);
});

test("something copied while the island is shut shows nothing, plays nothing and asks for no frame", () => {
  const played = mock.method(Sound, "play");
  try {
    pass(2);
    assert.equal(State.mode, "hidden");
    assert.ok(asleep());
    calls.length = 0;
    emit("clipboard-history", [copied(1, "one")]);
    assert.ok(asleep(), "no frame is asked for");
    pass(1);
    assert.equal(State.mode, "hidden");
    assert.equal(played.mock.callCount(), 0);
    assert.deepEqual(calls, [], "and nothing is asked of Rust: no window, no keyboard");
    assert.equal(tools.find(".clip-row").length, 0, "nothing is drawn where nobody looks");

    // Open on another view: the same.
    island.alert("overview");
    island.setPinned(true);
    pass(1);
    const before = played.mock.callCount();
    emit("clipboard-history", [copied(2, "two"), copied(1, "one")]);
    pass(0.5);
    assert.equal(State.view, "overview");
    assert.equal(played.mock.callCount(), before);
    assert.equal(tools.find(".clip-row").length, 0);

    // The tools come up: the list that came meanwhile is there.
    root.find(".tab")[4].fire("click");
    pass(0.5);
    assert.deepEqual(tools.find(".clip-label").map((label) => label.textContent), ["two", "one"]);
    // And one that comes while they are up is drawn at once, without a sound.
    const shown = played.mock.callCount();
    emit("clipboard-history", [copied(3, "three"), copied(2, "two"), copied(1, "one")]);
    pass(0.1);
    assert.deepEqual(tools.find(".clip-label").map((label) => label.textContent), ["three", "two", "one"]);
    assert.equal(played.mock.callCount(), shown);
    assert.deepEqual([State.mode, State.view], ["expanded", "tools"]);
  } finally {
    played.mock.restore();
    emit("clipboard-history", []);
  }
});

// ── The shelf: where a dropped file goes, and what a screenshot opens ─────────

const shelfCard = tools.find(".shelf")[0];
const onShelf = (id, name) => ({ id, path: `C:\\files\\${name}`, name, size: 1200, isDir: false, addedAt: Date.now(), thumb: "", missing: false });
/** A file dragged over the island, as the page's own drag events and Rust tell it. */
const drag = (type, paths) => emit("file-drag", paths ? { type, paths } : { type });

test("a file dragged over the tools stays on them and lights the shelf; dropped, every path goes on the shelf and none is taken in", async () => {
  State.droppedFile = null;
  island.alert("tools");
  island.setPinned(true);
  pass(1);
  calls.length = 0;

  drag("enter");
  drag("over");
  pass(0.3);
  assert.deepEqual([State.mode, State.view], ["expanded", "tools"], "the drop card does not take the tools' place");
  assert.ok(shelfCard.classList.contains("drop"));
  assert.ok(tools.classList.contains("on"));
  // Nothing is asked of Rust until the file is let go.
  assert.deepEqual(calls.filter(([cmd]) => cmd === "shelf_add" || cmd === "ingest_file"), []);

  // It leaves without being dropped: the card goes dark, and the tools are still there a second later.
  drag("leave");
  pass(1.2);
  assert.ok(!shelfCard.classList.contains("drop"));
  assert.deepEqual([State.mode, State.view], ["expanded", "tools"]);

  // It comes back, and is let go: two files at once.
  drag("enter");
  pass(0.1);
  assert.ok(shelfCard.classList.contains("drop"));
  drag("drop", ["C:\\a\\one.txt", "C:\\a\\two.png"]);
  await settle();
  pass(0.3);
  assert.deepEqual(sent("shelf_add"), [{ path: "C:\\a\\one.txt" }, { path: "C:\\a\\two.png" }], "each path, in the order they came");
  assert.deepEqual(sent("ingest_file"), [], "Liv takes none of them in");
  assert.deepEqual(sent("chat_reset"), []);
  assert.equal(State.droppedFile, null);
  assert.deepEqual([State.mode, State.view], ["expanded", "tools"], "no upload, no other card");
  assert.ok(!shelfCard.classList.contains("drop"));
  assert.equal(State.fileDragOver, false);

  // Rust answers with the shelf: the files are there.
  emit("shelf", [onShelf(2, "two.png"), onShelf(1, "one.txt")]);
  pass(0.1);
  assert.deepEqual(tools.find(".shelf-name").map((name) => name.textContent), ["two.png", "one.txt"]);
  // A drop that brought no file at all adds nothing.
  drag("enter");
  drag("drop", []);
  await settle();
  assert.equal(sent("shelf_add").length, 2);
  emit("shelf", []);
});

test("a file dragged over any other view is Liv's, as it always was: the drop card, then the upload", async () => {
  State.droppedFile = null;
  island.alert("overview");
  island.setPinned(true);
  pass(1);
  calls.length = 0;
  try {
    drag("enter");
    pass(0.5);
    assert.deepEqual([State.mode, State.view], ["expanded", "upload"]);
    assert.equal(Tools.dropOver, false);
    assert.ok(!shelfCard.classList.contains("drop"));
    drag("drop", ["C:\\a\\one.txt", "C:\\a\\two.png"]);
    assert.equal(State.view, "uploading");
    await settle();
    assert.deepEqual(sent("ingest_file"), [{ path: "C:\\a\\one.txt" }], "the first file, copied into the inbox");
    assert.deepEqual(sent("shelf_add"), [], "the page shelves nothing: Rust puts the original there itself");
    assert.deepEqual(State.droppedFile, { name: "one.txt", path: "C:\\inbox\\one.txt" });

    // The same from the folded island, and from the tools once they are folded away.
    island.setView("tools");
    island.setPinned(false);
    island.collapse();
    pass(1);
    assert.deepEqual([State.mode, State.view], ["compact", "tools"]);
    drag("enter");
    pass(0.5);
    assert.deepEqual([State.mode, State.view], ["expanded", "upload"]);
    drag("leave");
    pass(1.2);
    assert.notEqual(State.view, "upload");
  } finally {
    State.droppedFile = null;
    State.fileDragOver = false;
    island.setView("overview");
    pass(0.5);
  }
});

test("an item of the shelf dragged out and back over the island is not a file being brought in", async () => {
  island.alert("tools");
  island.setPinned(true);
  pass(1);
  emit("shelf", [onShelf(1, "one.txt")]);
  pass(0.1);
  calls.length = 0;
  const main = tools.find(".shelf-main")[0];
  main.fire("pointerdown", { button: 0, clientX: 500, clientY: 120, pointerId: 1 });
  main.fire("pointermove", { clientX: 520, clientY: 140 });
  assert.deepEqual(sent("shelf_drag"), [{ id: 1 }]);
  // The drag passes over the island again, and is even let go on it.
  drag("enter");
  pass(0.1);
  assert.ok(!shelfCard.classList.contains("drop"));
  assert.equal(State.fileDragOver, false);
  await settle();
  // Rust says the drag is over; the drop's own news comes just after.
  drag("drop", ["C:\\files\\one.txt"]);
  await settle();
  pass(0.2);
  assert.deepEqual(sent("shelf_add"), []);
  assert.deepEqual(sent("ingest_file"), []);
  assert.deepEqual([State.mode, State.view], ["expanded", "tools"]);
  // A moment later a file dragged in is a file again.
  pass(1.1);
  drag("enter");
  pass(0.1);
  assert.ok(shelfCard.classList.contains("drop"));
  drag("leave");
  pass(0.1);
  emit("shelf", []);
});

test("a screenshot opens the real island on the tools, silently, its item lit; paused or parked it stays shut", async () => {
  const played = mock.method(Sound, "play");
  const shot = onShelf(7, "Captura 2026-11-17 15.53.07.png");
  try {
    // The shortcut, with the island shut: Rust is asked, and nothing else moves.
    runGlobalShortcut(island, "captureScreen", resume);
    pass(0.5);
    assert.equal(sent("capture_screen").length, 1);
    assert.equal(State.mode, "hidden");
    assert.deepEqual(sent("focus_window"), [], "the keyboard stays where it is");
    // Rust saved it: the shelf, then the news.
    emit("shelf", [shot]);
    emit("capture", { ok: true, id: 7, name: shot.name, width: 1920, height: 1080 });
    pass(1);
    assert.deepEqual([State.mode, State.view], ["expanded", "tools"]);
    assert.ok(tools.find(".shelf-item")[0].classList.contains("fresh"));
    assert.equal(played.mock.calls.filter((c) => c.arguments[0] !== "open").length, 0, "no sound of its own");
    assert.deepEqual(sent("focus_window"), []);
    // The light goes out by itself, and the loop stops.
    pass(3.2);
    assert.ok(!tools.find(".shelf-item")[0].classList.contains("fresh"));

    // Paused from the tray, or parked off-screen for a full-screen app: taken, shelved, and the island stays as it is.
    island.fsm.forceHidden();
    pass(1);
    State.paused = true;
    runGlobalShortcut(island, "captureArea", resume);
    assert.equal(sent("capture_area").length, 1);
    assert.equal(State.paused, true, "a screenshot does not lift Pause");
    emit("capture", { ok: true, id: 7, name: shot.name, width: 10, height: 10 });
    pass(0.5);
    assert.equal(State.mode, "hidden");
    State.paused = false;
    island.setParked(true);
    emit("capture", { ok: false });
    pass(0.5);
    assert.equal(State.mode, "hidden");
    island.setParked(false);
    // A card that waits keeps the screen.
    permission();
    pass(1);
    emit("capture", { ok: true, id: 7, name: shot.name, width: 10, height: 10 });
    pass(0.5);
    assert.deepEqual([State.mode, State.view], ["expanded", "approval"]);
    assert.ok(State.pendingApproval, "nothing was answered");
  } finally {
    played.mock.restore();
    pass(5);
    emit("shelf", []);
  }
});

test("out on the desktop, a right-click on Liv opens its wardrobe in the island: Liv stays out and tries things on there", async () => {
  State.settings.livOutfit = "none";
  await island.pet.init(true);
  await sendOut();
  island.fsm.forceHidden();
  pass(1);
  assert.equal(looks().at(-1).outfit, "none");

  emit(PET_EVENTS.wardrobe);
  await settle();
  pass(1);
  assert.deepEqual([State.mode, State.view], ["expanded", "wardrobe"]);
  // Nothing here waits for the user: Liv is not called home, and its slot in the card is empty.
  assert.equal(rust.ways.length, 0);
  assert.deepEqual([outing.phase, State.petAway], ["out", true]);
  assert.deepEqual(figure(), ["0", "none"]);

  // The chips dress the Liv on the desktop: its window is told at once.
  chip("headphones").fire("mouseenter");
  assert.equal(looks().at(-1).outfit, "headphones");
  chip("headphones").fire("mouseleave");
  assert.equal(looks().at(-1).outfit, "none");
  chip("auto").fire("mouseenter");
  assert.equal(looks().at(-1).outfit, seasonalOutfit(new Date()));
  chip("auto").fire("mouseleave");
  chip("star").fire("mouseenter");
  chip("star").fire("click");
  assert.equal(looks().at(-1).outfit, "star");
  assert.equal(sent("save_settings").at(-1).settings.livOutfit, "star");
  chip("star").fire("mouseleave");
  assert.equal(looks().at(-1).outfit, "star");

  // The island folds: Liv keeps what was kept, and was never moved.
  island.collapse();
  pass(1);
  assert.equal(looks().at(-1).outfit, "star");
  assert.deepEqual([outing.phase, rust.ways.length], ["out", 0]);

  // Home again, the island's own Liv has it on already: it did not put it on in front of anybody.
  outing.toggle();
  await settle();
  await arrive();
  pass(0.05);
  assert.deepEqual([outing.phase, ...wears()], ["home", "star", 1]);

  // A second right-click out there closes the wardrobe it opened.
  await sendOut();
  emit(PET_EVENTS.wardrobe);
  pass(0.5);
  assert.equal(State.view, "wardrobe");
  emit(PET_EVENTS.wardrobe);
  pass(0.5);
  assert.deepEqual([State.mode, State.view], ["expanded", State.defaultView()]);
});

// ── The open island's shape (Settings → General → Appearance) ─────────────────

const { UploadSeq } = await import("../src/upload/sequence.ts");
const { dropTargets, dropTargetsLayout } = await import("../src/core/launch.ts");

/** Settings says so: the four numbers reach the island as they do while a slider is dragged. */
const reshape = (look) => {
  State.settings = { ...State.settings, ...look };
  island.applyAppearance();
};
/** Back to the inherited island, for the tests that follow. */
const inherit = () => reshape({ islandWidth: 640, islandExtraHeight: 0, islandRadius: 22, islandOpacity: 100 });
/** An element whose id was set as a property, as the upload canvas sets its own. */
const named = (id) => [...root.walk()].find((el) => el.id === id);

test("from a wider, taller island Liv leaves from where it stands there, and a drop anywhere on it is home", async () => {
  await island.pet.init(true);
  try {
    reshape({ islandWidth: 960, islandExtraHeight: 160 });
    island.alert("overview");
    island.setPinned(true);
    pass(2);
    calls.length = 0;
    runGlobalShortcut(island, "desktopToggle", resume);
    await settle();
    // The island is 960 wide in a panel of 1040: 40 px in, Liv 68 px further,
    // on the middle of the taller card (320 / 2 + 21).
    const [{ x, y }] = sent("pet_route");
    assert.ok(Math.abs(x - (40 + 68)) < 1 && Math.abs(y - 181) < 1, `${x},${y}`);
    await arrive();
    assert.equal(outing.phase, "out");

    // Let go on the far right of the open island, well past where the inherited one ends.
    emit(PET_EVENTS.grabbed);
    assert.equal(outing.phase, "carried");
    emit(PET_EVENTS.dropped, { x: 40 + 940, y: 300, from: "desktop" });
    await settle();
    pass(0.5);
    assert.deepEqual([outing.phase, State.petAway], ["home", false]);

    // The same place on the inherited island is the desktop: a new spot.
    inherit();
    pass(1);
    await sendOut();
    calls.length = 0;
    emit(PET_EVENTS.grabbed);
    emit(PET_EVENTS.dropped, { x: 40 + 940, y: 300, from: "desktop" });
    await settle();
    assert.deepEqual([outing.phase, sent("pet_settle").length], ["out", 1]);
  } finally {
    inherit();
  }
});

test("the drop sequence keeps its own size in the middle of a bigger island: the pointer and the sessions are read in its points", async () => {
  State.droppedFile = null;
  // A session a file can go to.
  stop();
  try {
    reshape({ islandWidth: 960, islandExtraHeight: 160 });
    island.alert("overview");
    island.setPinned(true);
    pass(1);
    const [target] = dropTargets(State.tasks);
    assert.ok(target, "a session to drop on");
    drag("enter");
    pass(1);
    assert.deepEqual([State.mode, State.view], ["expanded", "upload"]);

    // The layer is the open island's size, 960 × (176 + 160), and the drawing's
    // own 640 × 176 box is 160 px in and 80 px down.
    const layer = named("upload-layer");
    const stage = named("upload-stage");
    assert.deepEqual([layer.style.width, layer.style.height], ["960px", "336px"]);
    assert.deepEqual([stage.style.left, stage.style.top], ["160px", "80px"]);
    assert.ok(Math.abs(Number.parseFloat(layer.style.left)) < 0.5, "corner on corner with the island");
    // The sessions are listed in that box, in the drawing's points.
    assert.equal(byId("session-drop").parentNode, stage);

    // The pointer, 40 px of panel before the island: the sequence hears it in its own points.
    pointer([40 + 160 + 300, 80 + 100]);
    assert.deepEqual([Math.round(UploadSeq.cursorX), Math.round(UploadSeq.cursorY)], [300, 100]);

    // The session's row is where the drawing has it.
    const [row] = dropTargetsLayout(1).rows;
    const mid = [row.x + row.w / 2, row.y + row.h / 2];
    pointer([40 + 160 + mid[0], 80 + mid[1]]);
    assert.equal(State.dropSessionTarget, target.id);
    // Where that row is on the inherited island there is only the card now.
    pointer([40 + mid[0], mid[1]]);
    assert.equal(State.dropSessionTarget, null);

    // On the inherited island the same points are the island's own.
    inherit();
    pass(1);
    assert.deepEqual([layer.style.width, layer.style.height], ["640px", "176px"]);
    assert.deepEqual([stage.style.left, stage.style.top], ["0px", "0px"]);
    pointer([40 + mid[0], mid[1]]);
    assert.equal(State.dropSessionTarget, target.id);
    assert.deepEqual([Math.round(UploadSeq.cursorX), Math.round(UploadSeq.cursorY)], mid.map(Math.round));
  } finally {
    drag("leave");
    pass(1);
    hook({ hook_event_name: "SessionEnd", session_id: "s1" });
    inherit();
  }
});
