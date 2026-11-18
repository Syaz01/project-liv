// The troupe of Livs in the band of each page of the Liv window
// (src/hub/troupe.ts): who is in it on each page, where they stand in the
// room the title leaves, who is under the pointer, and the small thing one of
// them does now and then. Then the band itself (src/hub/hero.ts), on the fake
// DOM: the Livs ride on the bands' loop and never keep it going, a click on a
// head pokes it, a pointer on one is timed, and the bits come when they are due.

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { PILL_CATALOG, pillDefinition } from "../src/core/pills.ts";
import { SETTINGS_PAGES } from "../src/core/settings-target.ts";
import { seededRandom } from "../src/robot/life.ts";
import { ROBOT_STATES, headRadius, robotBounds, robotGeometry } from "../src/robot/look.ts";
import { BIT_MS, Robot } from "../src/robot/robot.ts";
import { CASTS, TROUPE, castFor, memberAt, nextBit, troupeLayout } from "../src/hub/troupe.ts";

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** The band is 170 px tall, and the troupe's canvas 340 px wide (hub.css). */
const BAND_H = 170;
const STAGE_W = 340;
/** A title that ends well before the canvas starts. */
const NO_TEXT = -100;

// ── The cast ──────────────────────────────────────────────────────────────────

test("every page of the window has a cast, and any other page General's", () => {
  for (const page of SETTINGS_PAGES) assert.ok(CASTS[page], page);
  assert.deepEqual(Object.keys(CASTS).sort(), [...SETTINGS_PAGES].sort(), "and no cast without a page");
  for (const page of SETTINGS_PAGES) assert.equal(castFor(page), CASTS[page]);
  assert.equal(castFor("a page yet to come"), CASTS.general);
});

test("every cast can be drawn: known pills, known states, slots of 46 to 64 px, eyes that rest in the visor", () => {
  for (const [page, cast] of Object.entries(CASTS)) {
    assert.ok(cast.members.length >= 1 && cast.members.length <= 4, `${page}: one to four`);
    for (const member of cast.members) {
      if (member.pill != null) assert.ok(pillDefinition(member.pill), `${page}: ${member.pill} is in the catalog`);
      assert.ok(ROBOT_STATES[member.state], `${page}: ${member.state}`);
      assert.ok(member.slot >= 46 && member.slot <= 64, `${page}: a slot of ${member.slot}`);
      assert.ok(member.gaze.every((v) => Math.abs(v) <= 1), `${page}: its gaze`);
    }
    assert.ok(cast.bits.length > 0, `${page}: something to do`);
    for (const bit of cast.bits) assert.ok(bit === "glance" || bit in BIT_MS, `${page}: ${bit}`);
    assert.ok(cast.every[0] > 0 && cast.every[0] < cast.every[1], `${page}: now and then`);
    // One at a time: the longest bit is over before the next can start.
    assert.ok(Math.max(...Object.values(BIT_MS)) < cast.every[0], `${page}: never two at once`);
  }
});

test("each page reads differently", () => {
  // General: Liv itself, the largest of all.
  assert.deepEqual(CASTS.general.members, [{ pill: null, state: "idle", slot: 64, gaze: [0, 0], dressed: true }]);
  // It alone is Liv itself, in what Liv wears: the others are pills' figures and states, and wear nothing.
  const others = Object.entries(CASTS).filter(([page]) => page !== "general").flatMap(([, cast]) => cast.members);
  assert.ok(others.length > 10 && others.every((m) => m.dressed === false));
  const largest = Math.max(...Object.values(CASTS).flatMap((cast) => cast.members.map((m) => m.slot)));
  assert.equal(CASTS.general.members[0].slot, largest);

  // Active pills: a line-up of four, each in another pill's colour, smaller.
  const lineUp = CASTS.pills.members;
  assert.equal(lineUp.length, 4);
  const colors = lineUp.map((m) => pillDefinition(m.pill).color);
  assert.equal(new Set(colors).size, 4, "four colours");
  assert.ok(lineUp.every((m) => m.state === "idle" && m.slot <= 50));

  // Agents: working, thinking, asking — in Liv's own shell, the state on its lights.
  assert.deepEqual(CASTS.agents.members.map((m) => [m.pill, m.state]), [[null, "working"], [null, "thinking"], [null, "approval"]]);
  assert.equal(ROBOT_STATES.approval.badge.kind, "bang");

  // Chat: two that face each other, one of them with the typing dots.
  const [asks, answers] = CASTS.chat.members;
  assert.equal(CASTS.chat.members.length, 2);
  assert.ok(asks.gaze[0] > 0.5 && answers.gaze[0] < -0.5, "the left one looks right, the right one left");
  assert.equal(ROBOT_STATES[answers.state].badge.kind, "dots");
  assert.equal(ROBOT_STATES[answers.state].gaze, null, "a state that lets it look at the other");
  assert.equal(ROBOT_STATES[asks.state].badge, null);

  // Integrations: three services' colours, the office's among them.
  assert.deepEqual(
    CASTS.integrations.members.map((m) => m.pill),
    ["integration_github", "integration_vercel", "integration_office"],
  );
  for (const m of CASTS.integrations.members) {
    assert.equal(PILL_CATALOG.find((p) => p.id === m.pill).category, "service");
  }

  // Shortcuts: one at a keyboard — it looks down, and all it does is type, often.
  const [typist] = CASTS.shortcuts.members;
  assert.equal(CASTS.shortcuts.members.length, 1);
  assert.ok(typist.gaze[1] > 0.5 && typist.gaze[0] === 0);
  assert.deepEqual(CASTS.shortcuts.bits, ["type"]);
  assert.ok(CASTS.shortcuts.every[1] < CASTS.general.every[0], "in bursts, not now and then");
  // Everyone else: a wave, a hop or a glance, every 6 to 12 s.
  for (const page of ["general", "pills", "agents", "chat", "integrations"]) {
    assert.deepEqual(CASTS[page].bits, ["wave", "hop", "glance"], page);
    assert.deepEqual(CASTS[page].every, [6000, 12000], page);
  }
});

// ── Where they stand ──────────────────────────────────────────────────────────

/** Where the figure of a standing reaches, each way. */
function reach(s) {
  const b = robotBounds(robotGeometry(s.R), "body");
  return { left: s.cx - b.side * s.R, right: s.cx + b.side * s.R, top: s.cy - b.top * s.R, bottom: s.cy + b.bottom * s.R };
}

test("with room, the whole cast stands at its sizes, feet on the floor, in the middle of its canvas", () => {
  for (const [page, cast] of Object.entries(CASTS)) {
    const standing = troupeLayout(cast, STAGE_W, BAND_H, NO_TEXT);
    assert.deepEqual(standing.map((s) => s.member), cast.members.map((_, i) => i), `${page}: everyone, left to right`);
    standing.forEach((s, i) => {
      assert.ok(near(s.R, headRadius(cast.members[i].slot)), `${page}: its own size`);
      const r = reach(s);
      assert.ok(near(r.bottom, s.floor), `${page}: its feet are on its floor`);
      assert.ok(r.top > 0, `${page}: its antenna is inside the band`);
      assert.ok(r.left >= 0 && r.right <= STAGE_W - TROUPE.edge, `${page}: clear of the edges`);
      if (i > 0) assert.ok(r.left > reach(standing[i - 1]).right, `${page}: clear of its neighbour`);
    });
    const span = [reach(standing[0]).left, reach(standing.at(-1)).right];
    assert.ok(near((span[0] + span[1]) / 2, STAGE_W / 2, 3), `${page}: centred`);
  }
});

test("the largest stand in front, the smaller ones a little further back", () => {
  const standing = troupeLayout(CASTS.agents, STAGE_W, BAND_H, NO_TEXT);
  const slots = CASTS.agents.members.map((m) => m.slot);
  const front = standing[slots.indexOf(Math.max(...slots))];
  assert.equal(front.floor, BAND_H - TROUPE.floor);
  standing.forEach((s, i) => {
    assert.ok(near(s.floor, front.floor - (Math.max(...slots) - slots[i]) * TROUPE.back));
    assert.ok(front.floor - s.floor < 8, "a few pixels, no more");
  });
});

test("short of room they shrink together, never into the text, and never below four fifths of their size", () => {
  const cast = CASTS.pills;
  const natural = cast.members.reduce((sum, m) => sum + m.slot * TROUPE.pitch, 0);
  // Text that leaves nine tenths of what the four need.
  const textRight = STAGE_W - TROUPE.edge - TROUPE.gap - natural * 0.9;
  const standing = troupeLayout(cast, STAGE_W, BAND_H, textRight);
  assert.equal(standing.length, 4);
  standing.forEach((s, i) => assert.ok(near(s.R, headRadius(cast.members[i].slot * 0.9)), "all by the same share"));
  assert.ok(reach(standing[0]).left >= textRight + TROUPE.gap, "clear of the text");
  assert.ok(reach(standing[3]).right <= STAGE_W - TROUPE.edge);
  assert.equal(TROUPE.smallest, 0.8);
});

test("shorter still, the one nearest the text leaves, then the next, and at last nobody stands", () => {
  const cast = CASTS.pills;
  const needs = (from) => cast.members.slice(from).reduce((sum, m) => sum + m.slot * TROUPE.pitch, 0) * TROUPE.smallest;
  const textFor = (room) => STAGE_W - TROUPE.edge - TROUPE.gap - room;
  assert.deepEqual(troupeLayout(cast, STAGE_W, BAND_H, textFor(needs(0) + 1)).map((s) => s.member), [0, 1, 2, 3]);
  assert.deepEqual(troupeLayout(cast, STAGE_W, BAND_H, textFor(needs(0) - 1)).map((s) => s.member), [1, 2, 3]);
  assert.deepEqual(troupeLayout(cast, STAGE_W, BAND_H, textFor(needs(1) - 1)).map((s) => s.member), [2, 3]);
  assert.deepEqual(troupeLayout(cast, STAGE_W, BAND_H, textFor(needs(2) - 1)).map((s) => s.member), [3]);
  assert.deepEqual(troupeLayout(cast, STAGE_W, BAND_H, textFor(needs(3) - 1)), []);
  assert.deepEqual(troupeLayout(cast, STAGE_W, BAND_H, STAGE_W + 50), [], "text across the whole canvas");
});

test("whatever the text and the window, nobody stands on the text or outside the band", () => {
  for (const [page, cast] of Object.entries(CASTS)) {
    let before = Infinity;
    for (let textRight = -60; textRight <= STAGE_W; textRight += 3) {
      const standing = troupeLayout(cast, STAGE_W, BAND_H, textRight);
      assert.ok(standing.length <= before, `${page}: less room never brings one back`);
      before = standing.length;
      for (const s of standing) {
        const r = reach(s);
        assert.ok(r.left >= Math.max(0, textRight + TROUPE.gap), `${page} at ${textRight}: clear of the text`);
        assert.ok(r.right <= STAGE_W - TROUPE.edge + 1e-9, `${page} at ${textRight}: inside`);
        assert.ok(r.top > 0 && r.bottom < BAND_H, `${page} at ${textRight}: inside, top and bottom`);
      }
    }
  }
});

test("at the window's smallest, a short title keeps its troupe and a long one keeps the room it needs", () => {
  // 820 px wide: the band is 512 px, the canvas its last 340. A subtitle may run to 446 px (hub.css).
  const bandW = 820 - 228 - 12 - 2 - 56 - 10;
  const inCanvas = (textRight) => textRight - (bandW - STAGE_W);
  // "General", "How the island looks and behaves.": the text ends near 260 px.
  assert.equal(troupeLayout(CASTS.general, STAGE_W, BAND_H, inCanvas(260)).length, 1);
  assert.equal(troupeLayout(CASTS.chat, STAGE_W, BAND_H, inCanvas(300)).length, 2);
  // A line that fills its 420 px: nobody fits beside it, and nobody is drawn over it.
  for (const cast of Object.values(CASTS)) assert.deepEqual(troupeLayout(cast, STAGE_W, BAND_H, inCanvas(446)), []);
});

// ── Under the pointer ─────────────────────────────────────────────────────────

test("the one whose head is under the pointer", () => {
  const standing = troupeLayout(CASTS.agents, STAGE_W, BAND_H, NO_TEXT);
  standing.forEach((s, i) => {
    assert.equal(memberAt(standing, s.cx, s.cy), i, "the middle of its head");
    assert.equal(memberAt(standing, s.cx - s.R * 0.9, s.cy), i, "near its edge");
    assert.equal(memberAt(standing, s.cx, s.cy - s.R * 1.3), null, "its antenna is not its head");
    assert.equal(memberAt(standing, s.cx, s.floor), null, "nor its feet");
  });
  const between = (standing[0].cx + standing[1].cx) / 2;
  assert.equal(memberAt(standing, between, standing[0].cy - standing[0].R), null, "between two heads");
  assert.equal(memberAt(standing, 2, 2), null);
  assert.equal(memberAt([], 100, 100), null, "nobody standing");
});

// ── Now and then ──────────────────────────────────────────────────────────────

/** A random source that gives `draws` in turn. */
const scripted = (...draws) => () => draws.shift();

test("the next bit is four draws: when, who, what, and which neighbour", () => {
  const cast = CASTS.agents;
  assert.deepEqual(nextBit(scripted(0, 0, 0, 0), cast, 3), { inMs: 6000, who: 0, bit: "wave", toward: 1 });
  assert.deepEqual(nextBit(scripted(0.5, 0.4, 0.4, 0.9), cast, 3), { inMs: 9000, who: 1, bit: "hop", toward: 1 });
  assert.deepEqual(nextBit(scripted(0.5, 0.4, 0.9, 0.1), cast, 3), { inMs: 9000, who: 1, bit: "glance", toward: -1 });
  // The one at an end has one neighbour, whatever is drawn.
  assert.equal(nextBit(scripted(0, 0, 0.9, 0.1), cast, 3).toward, 1);
  assert.equal(nextBit(scripted(0, 0.99, 0.9, 0.9), cast, 3).toward, -1);
  const last = nextBit(scripted(0.999999, 0.999999, 0.999999, 0.999999), cast, 3);
  assert.ok(last.inMs < 12000 && last.inMs > 11999);
  assert.deepEqual([last.who, last.bit], [2, "glance"]);
});

test("alone there is nobody to glance at; with nobody standing, nothing happens", () => {
  for (let draw = 0; draw < 1; draw += 0.05) {
    const cue = nextBit(scripted(0.5, 0.5, draw, 0.5), CASTS.general, 1);
    assert.ok(cue.bit === "wave" || cue.bit === "hop", `a draw of ${draw}`);
    assert.equal(cue.who, 0);
  }
  assert.equal(nextBit(scripted(0, 0, 0, 0), CASTS.agents, 0), null);
});

test("the typist types, in bursts a few seconds apart", () => {
  const random = seededRandom(7);
  for (let i = 0; i < 100; i++) {
    const cue = nextBit(random, CASTS.shortcuts, 1);
    assert.deepEqual([cue.who, cue.bit], [0, "type"]);
    assert.ok(cue.inMs >= 2600 && cue.inMs <= 4200);
    assert.ok(cue.inMs - BIT_MS.type > 1000, "a pause between two bursts");
  }
});

test("over a long while everyone has its turn, at every 6 to 12 s, and does all three things", () => {
  const random = seededRandom(3);
  const who = new Set();
  const bits = new Set();
  for (let i = 0; i < 300; i++) {
    const cue = nextBit(random, CASTS.pills, 4);
    assert.ok(cue.inMs >= 6000 && cue.inMs <= 12000);
    assert.ok(cue.who >= 0 && cue.who < 4);
    who.add(cue.who);
    bits.add(cue.bit);
  }
  assert.deepEqual([...who].sort(), [0, 1, 2, 3]);
  assert.deepEqual([...bits].sort(), ["glance", "hop", "wave"]);
});

// ── The band, on the fake DOM ─────────────────────────────────────────────────

const dom = installFakeDom();
document.visibilityState = "visible";
document.addEventListener = () => {};
globalThis.addEventListener = () => {};
// The loop's frames are run by hand; its stand-in timer never fires.
mock.timers.enable({ apis: ["setTimeout"] });
let frames = [];
globalThis.requestAnimationFrame = (fn) => frames.push(fn);
globalThis.cancelAnimationFrame = () => (frames = []);
let now = 1000;
mock.method(performance, "now", () => now);

/** Runs the loop for `seconds`, a frame every 16 ms while it asks for one. */
function pass(seconds) {
  const end = now + seconds * 1000;
  while (now < end) {
    now += 16;
    const due = frames;
    frames = [];
    for (const frame of due) frame(now);
  }
}

/** A context that takes every call and paints nothing. */
const paint = new Proxy(() => {}, {
  get: (_, key) => (key === "getTransform" ? () => ({ a: 1, b: 0 }) : paint),
  set: () => true,
  apply: () => paint,
});

/** Lays a fake canvas out at `box` (left, top, width, height) in the window. */
function layOut(canvas, [left, top, width, height]) {
  canvas.isConnected = true;
  canvas.clientWidth = width;
  canvas.clientHeight = height;
  canvas.getContext = () => paint;
  canvas.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height });
}

globalThis.innerWidth = 1100;
globalThis.innerHeight = 720;
globalThis.devicePixelRatio = 1;
/** Where the band's text ends, in the window: what a Range over a line of the copy measures. */
let textEnds = 400;
document.createRange = () => ({ selectNodeContents() {}, getBoundingClientRect: () => ({ right: textEnds }) });

const { brandRobot, dressTroupe, hero, setWindowShown } = await import("../src/hub/hero.ts");

/** A band of 800 px at 260, 30 in the window, laid out: its troupe's canvas is its last 340 px. */
function band(page) {
  const el = hero(page, "Title", "Subtitle");
  const [backdrop, stage] = el.find("CANVAS");
  el.clientWidth = 800;
  layOut(backdrop, [260, 30, 800, BAND_H]);
  layOut(stage, [260 + 800 - STAGE_W, 30, STAGE_W, BAND_H]);
  return { el, stage, fire: (type, event) => el.listeners.get(type).forEach((fn) => fn(event)) };
}

test("Liv's head in the sidebar rides the bands' loop: alone it asks for no frame", () => {
  setWindowShown(true);
  const logo = dom.root();
  layOut(logo, [20, 20, 28, 28]);
  const updated = mock.method(Robot.prototype, "update");
  try {
    brandRobot(logo);
    assert.equal(frames.length, 0, "no band, no loop");
    pass(1);
    assert.equal(updated.mock.callCount(), 0);

    // A band comes on screen: its loop draws the head too.
    const { el } = band("general");
    assert.equal(frames.length, 1);
    pass(0.5);
    const robots = new Set(updated.mock.calls.map((c) => c.this));
    assert.equal(robots.size, 2, "the head and the page's one Liv");
    assert.equal(frames.length, 1, "one loop for all of them");

    // The window hides: everything stops at once. Shown again, it starts again.
    setWindowShown(false);
    assert.equal(frames.length, 0);
    const before = updated.mock.callCount();
    pass(1);
    assert.equal(updated.mock.callCount(), before);
    setWindowShown(true);
    assert.equal(frames.length, 1);

    // The page goes away: its band and its troupe are dropped, and the head rides nothing.
    for (const canvas of el.find("CANVAS")) canvas.isConnected = false;
    pass(0.5);
    assert.equal(frames.length, 0, "the loop has stopped");
    const after = updated.mock.callCount();
    pass(1);
    assert.equal(updated.mock.callCount(), after, "and the head with it");
    // The sidebar goes too: the tests below are about the bands alone.
    logo.isConnected = false;
  } finally {
    updated.mock.restore();
  }
});

test("the troupe stands clear of the text, and stands again when the window is resized", () => {
  const drawn = mock.method(Robot.prototype, "drawAt");
  try {
    textEnds = 400;
    const { el, stage } = band("agents");
    pass(0.1);
    const places = () => new Map(drawn.mock.calls.slice(-3).map((c) => [c.this, c.arguments[2]]));
    assert.equal(places().size, 3, "the three of them");
    const expected = troupeLayout(CASTS.agents, STAGE_W, BAND_H, 400 - 720).map((s) => s.cx);
    assert.deepEqual([...places().values()], expected);

    // A narrower window: the text now runs into the canvas, and only one fits beside it.
    textEnds = 950;
    el.clientWidth = 640;
    layOut(stage, [720, 30, STAGE_W, BAND_H]);
    drawn.mock.resetCalls();
    pass(0.05);
    const still = troupeLayout(CASTS.agents, STAGE_W, BAND_H, 950 - 720);
    assert.equal(still.length, 1);
    assert.ok(drawn.mock.calls.every((c) => c.arguments[2] === still[0].cx), "the one that fits, where it fits");
    for (const canvas of el.find("CANVAS")) canvas.isConnected = false;
    pass(0.1);
  } finally {
    drawn.mock.restore();
  }
});

test("a click on a head pokes it from the side it lands on; a pointer on one is timed, and off it is not", () => {
  const poked = mock.method(Robot.prototype, "poke");
  const hovered = mock.method(Robot.prototype, "hover");
  const looked = mock.method(Robot.prototype, "lookAt");
  try {
    textEnds = 400;
    const { el, fire } = band("agents");
    pass(0.1);
    const standing = troupeLayout(CASTS.agents, STAGE_W, BAND_H, 400 - 720);
    const at = (s, dx = 0, dy = 0) => ({ button: 0, clientX: 720 + s.cx + dx, clientY: 30 + s.cy + dy });

    fire("pointerdown", at(standing[1], 4));
    assert.deepEqual(poked.mock.calls.map((c) => c.arguments), [[1]]);
    fire("pointerdown", at(standing[1], -4));
    assert.deepEqual(poked.mock.calls.at(-1).arguments, [-1]);
    assert.equal(poked.mock.calls[0].this, poked.mock.calls[1].this, "the same Liv");
    fire("pointerdown", at(standing[2]));
    assert.notEqual(poked.mock.calls.at(-1).this, poked.mock.calls[0].this, "another one");
    fire("pointerdown", { ...at(standing[1]), button: 2 });
    fire("pointerdown", at(standing[1], 0, -standing[1].R * 2));
    fire("pointerdown", { button: 0, clientX: 300, clientY: 60 });
    assert.equal(poked.mock.callCount(), 3, "the left button, on a head");

    // The pointer over a head: that one is being timed for its love, the others are not.
    hovered.mock.resetCalls();
    fire("pointermove", at(standing[0]));
    assert.deepEqual(hovered.mock.calls.map((c) => c.arguments[0]), [true, false, false]);
    assert.equal(el.style.cursor, "pointer");
    fire("pointermove", { clientX: 300, clientY: 60 });
    assert.ok(hovered.mock.calls.slice(-3).every((c) => c.arguments[0] === false));
    assert.equal(el.style.cursor, "");

    // Over the band, they all look at the pointer; when it leaves, ahead again.
    looked.mock.resetCalls();
    pass(0.05);
    assert.ok(looked.mock.calls.every((c) => Array.isArray(c.arguments[0])));
    // The pointer is far to the left: as far as their eyes follow, and no further.
    assert.ok(looked.mock.calls.every((c) => c.arguments[0][0] < 0 && Math.hypot(...c.arguments[0]) <= 240 + 1e-9));
    fire("pointerleave", {});
    looked.mock.resetCalls();
    pass(0.05);
    assert.ok(looked.mock.calls.length > 0 && looked.mock.calls.every((c) => c.arguments[0] === null));
    for (const canvas of el.find("CANVAS")) canvas.isConnected = false;
    pass(0.1);
  } finally {
    poked.mock.restore();
    hovered.mock.restore();
    looked.mock.restore();
  }
});

test("now and then one of them does its bit: one at a time, 6 to 12 s apart", () => {
  const { perform, act } = Robot.prototype;
  /** When each bit started, and who did it. */
  const bits = [];
  const performed = mock.method(Robot.prototype, "perform", function (bit) {
    bits.push({ at: now, who: this, bit });
    return perform.call(this, bit);
  });
  // The engine blinks through act() too: only the glances are the troupe's.
  const acted = mock.method(Robot.prototype, "act", function (kind) {
    if (kind.startsWith("glance")) bits.push({ at: now, who: this, bit: "glance" });
    return act.call(this, kind);
  });
  try {
    textEnds = 400;
    const { el } = band("pills");
    const start = now;
    pass(180);
    assert.ok(bits.length >= 14 && bits.length <= 30, `${bits.length} bits in three minutes`);
    assert.ok(bits[0].at - start >= 6000, "none before six seconds");
    for (let i = 1; i < bits.length; i++) {
      const apart = bits[i].at - bits[i - 1].at;
      assert.ok(apart >= 6000 && apart <= 12032, `${apart} ms apart`);
    }
    assert.deepEqual([...new Set(bits.map((b) => b.bit))].sort(), ["glance", "hop", "wave"]);
    assert.ok(new Set(bits.map((b) => b.who)).size >= 3, "not always the same one");
    for (const canvas of el.find("CANVAS")) canvas.isConnected = false;
    pass(0.1);
  } finally {
    performed.mock.restore();
    acted.mock.restore();
  }
});

test("on the shortcuts page the one Liv types in bursts", () => {
  const performed = mock.method(Robot.prototype, "perform");
  try {
    textEnds = 400;
    const { el } = band("shortcuts");
    pass(30);
    const bursts = performed.mock.calls.map((c) => c.arguments[0]);
    assert.ok(bursts.length >= 7 && bursts.length <= 11, `${bursts.length} bursts in 30 s`);
    assert.ok(bursts.every((bit) => bit === "type"));
    for (const canvas of el.find("CANVAS")) canvas.isConnected = false;
    pass(0.1);
  } finally {
    performed.mock.restore();
  }
});

test("the Liv of the General page wears what Liv wears: dressed as it comes on, changed in front of you", () => {
  const told = mock.method(Robot.prototype, "setOutfit");
  const wearing = () => told.mock.calls.at(-1).this;
  try {
    textEnds = 400;
    dressTroupe("scarf");
    const { el } = band("general");
    // Built already in its scarf: nobody saw it put that on.
    assert.deepEqual(told.mock.calls.map((c) => c.arguments), [["scarf", false]]);
    assert.deepEqual([wearing().worn, wearing().wear], ["scarf", 1]);
    pass(0.2);
    assert.ok(told.mock.calls.slice(1).every((c) => c.arguments[0] === "scarf" && c.arguments[1] === undefined));
    assert.deepEqual([wearing().worn, wearing().wear], ["scarf", 1]);

    // Settings picks another: the one in place goes, the new one pops on, on the band's own frames.
    dressTroupe("beanie");
    pass(0.1);
    assert.equal(wearing().worn, "scarf");
    assert.ok(wearing().wear < 1);
    pass(0.5);
    assert.deepEqual([wearing().worn, wearing().wear], ["beanie", 1]);
    dressTroupe("none");
    pass(0.3);
    assert.deepEqual([wearing().worn, wearing().wear], ["none", 0]);
    for (const canvas of el.find("CANVAS")) canvas.isConnected = false;
    pass(0.1);

    // The pills' figures, the agents' states and the typist are not Liv itself: they are never dressed.
    dressTroupe("glasses");
    for (const page of ["pills", "agents", "chat", "integrations", "shortcuts"]) {
      told.mock.resetCalls();
      const other = band(page);
      pass(0.2);
      assert.equal(told.mock.callCount(), 0, page);
      for (const canvas of other.el.find("CANVAS")) canvas.isConnected = false;
      pass(0.1);
    }
    // Nor the head in the sidebar, which is Liv's mark.
    told.mock.resetCalls();
    const logo = dom.root();
    layOut(logo, [20, 20, 28, 28]);
    brandRobot(logo);
    const general = band("general");
    pass(0.2);
    assert.ok(told.mock.callCount() > 0 && told.mock.calls.every((c) => c.this === told.mock.calls[0].this), "only the General page's Liv");
    for (const canvas of general.el.find("CANVAS")) canvas.isConnected = false;
    logo.isConnected = false;
    pass(0.1);
  } finally {
    dressTroupe("none");
    told.mock.restore();
  }
});
