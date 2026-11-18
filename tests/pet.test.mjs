// Liv on the desktop (src/pet): the window it needs and which part of it is
// Liv, when a press becomes a drag and what a drop means, its way between the
// island and its spot, when it hovers and when it sleeps, when its frame loop
// stops, and its outings — home, out, and home again for as long as the
// island needs it. And what the engine does out there: it is carried, lands,
// hovers and sleeps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMPACT_W, NOTCH_H } from "../src/core/layout.ts";
import { HEAD_FIT, robotBounds, robotGeometry } from "../src/robot/look.ts";
import { GREETING_MS, HOVER_FLOAT, Robot } from "../src/robot/robot.ts";
import { DRAG_THRESHOLD, HOME_MARGIN, dropOutcome, homeZone, isDrag } from "../src/pet/drag.ts";
import { petLivesOnTimer, petNeedsFrame } from "../src/pet/frames.ts";
import { Outing, whileOut } from "../src/pet/outing.ts";
import { LINGER_MS, NEAR_PX, SLEEP_AFTER_MS, hovers, nextChangeAt, pointerNear, sleeps } from "../src/pet/rest.ts";
import { PET_R, PET_SLOT, PET_WINDOW, hitShape, onPetHead, onShape, petWindow } from "../src/pet/shape.ts";
import { AT_REST, TRAVEL, travelMs, travelPath, travelPoint, travelPose } from "../src/pet/travel.ts";
import { HELLO_FRESH_MS, ISLAND_WINDOW, PET_EVENTS, PET_WINDOW_LABEL } from "../src/pet/wire.ts";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const PET_RS = read("../src-tauri/src/pet.rs");

/** Steps the robot for `seconds`, 100 times a second; `each` sees it after every step. */
function run(robot, seconds, each = () => {}) {
  const steps = Math.round(seconds * 100);
  for (let i = 1; i <= steps; i++) {
    robot.update(0.01);
    each(robot, i * 10);
  }
}

/**
 * A 2D context that paints nothing and notes how far the shapes reach,
 * following the transforms like a real one, and every angle it is turned by.
 */
function recorder() {
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  const turns = [];
  const at = (x, y) => {
    const px = m[0] * x + m[2] * y + m[4];
    const py = m[1] * x + m[3] * y + m[5];
    box.left = Math.min(box.left, px);
    box.right = Math.max(box.right, px);
    box.top = Math.min(box.top, py);
    box.bottom = Math.max(box.bottom, py);
  };
  const around = (x, y, rx, ry = rx) => {
    for (const [dx, dy] of [[-rx, -ry], [rx, -ry], [rx, ry], [-rx, ry]]) at(x + dx, y + dy);
  };
  const mul = (n) => {
    m = [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  };
  const gradient = () => ({ addColorStop() {} });
  return {
    box,
    turns,
    save: () => stack.push(m),
    restore: () => (m = stack.pop()),
    translate: (x, y) => mul([1, 0, 0, 1, x, y]),
    scale: (x, y) => mul([x, 0, 0, y, 0, 0]),
    rotate: (a) => (turns.push(a), mul([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0])),
    getTransform: () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }),
    beginPath() {},
    closePath() {},
    clip() {},
    fill() {},
    stroke() {},
    fillText() {},
    moveTo: at,
    lineTo: at,
    quadraticCurveTo: (cx, cy, x, y) => (at(cx, cy), at(x, y)),
    bezierCurveTo: (ax, ay, bx, by, x, y) => (at(ax, ay), at(bx, by), at(x, y)),
    arc: (x, y, r) => around(x, y, r),
    ellipse: (x, y, rx, ry) => around(x, y, Math.max(rx, ry)),
    roundRect: (x, y, w, h) => (at(x, y), at(x + w, y + h)),
    createLinearGradient: gradient,
    createRadialGradient: gradient,
  };
}

/** Liv as its window draws it: whole, hovering, where the window puts it. */
function petRobot() {
  const robot = new Robot(() => 0.5);
  robot.float = HOVER_FLOAT;
  robot.setLimbs(true);
  robot.alive = true;
  run(robot, 1);
  return robot;
}

/** How far a robot reaches in the window while `seconds` go by, drawn 100 times a second. */
function reachOver(robot, seconds, size = 1) {
  const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  run(robot, seconds, () => {
    const ctx = recorder();
    robot.drawAt(ctx, PET_R * size, PET_WINDOW.cx, PET_WINDOW.cy);
    box.left = Math.min(box.left, ctx.box.left);
    box.top = Math.min(box.top, ctx.box.top);
    box.right = Math.max(box.right, ctx.box.right);
    box.bottom = Math.max(box.bottom, ctx.box.bottom);
  });
  return box;
}

// ── The window ────────────────────────────────────────────────────────────────

test("the window is a whole number of pixels around a 72 px Liv, its head in the middle", () => {
  assert.equal(PET_SLOT, 72);
  assert.ok(near(PET_R, 72 * HEAD_FIT));
  const { w, h, cx, cy } = PET_WINDOW;
  for (const v of [w, h, cx, cy]) assert.ok(Number.isInteger(v), `${v}`);
  assert.equal(cx * 2, w, "as much room on the left as on the right");
  // The figure at rest, antenna to feet, is well inside.
  const body = robotBounds(robotGeometry(PET_R), "body");
  assert.ok(cy - body.top * PET_R > 15, "room above for a hop and the hearts");
  assert.ok(cy + body.bottom * PET_R < h - 2);
  assert.ok(cx - body.side * PET_R > 8, "room beside for a raised hand and the badge");
  // Small enough to be a companion, not a panel.
  assert.ok(w <= 120 && h <= 120, `${w}×${h}`);
  // A bigger Liv gets a bigger window, in proportion.
  const big = petWindow(PET_R * 2);
  assert.ok(Math.abs(big.w - w * 2) <= 2 && Math.abs(big.h - h * 2) <= 2);
});

test("Rust creates the window at the size the page draws in", () => {
  const constant = (name) => Number(PET_RS.match(new RegExp(`pub const ${name}: f64 = ([\\d.]+);`))[1]);
  assert.deepEqual(
    { w: constant("PAGE_W"), h: constant("PAGE_H"), cx: constant("HEAD_X"), cy: constant("HEAD_Y") },
    PET_WINDOW,
  );
  // And the two pages and Rust call the windows and the events the same.
  assert.match(PET_RS, new RegExp(`pub const LABEL: &str = "${PET_WINDOW_LABEL}";`));
  assert.match(read("../src-tauri/src/island.rs"), new RegExp(`pub const WINDOW_LABEL: &str = "${ISLAND_WINDOW}";`));
  for (const name of ["cursor", "shown", "travel", "held", "grabbed", "dropped", "ask", "out"]) {
    assert.ok(PET_RS.includes(`"${PET_EVENTS[name]}"`), `${name}: ${PET_EVENTS[name]}`);
  }
  assert.match(read("../src-tauri/capabilities/default.json"), /"windows": \["island", "settings", "pet"\]/);
});

test("nothing of Liv is ever cut by its window, whatever it does", () => {
  const inside = (box, what) => {
    assert.ok(
      box.left >= 0 && box.top >= 0 && box.right <= PET_WINDOW.w && box.bottom <= PET_WINDOW.h,
      `${what}: ${JSON.stringify(box)} in ${PET_WINDOW.w}×${PET_WINDOW.h}`,
    );
  };
  // Every state, coming in from every other: its hop or its shake, its badge popping in.
  for (const state of ["idle", "working", "thinking", "approval", "question", "error", "finished", "ratelimit"]) {
    const robot = petRobot();
    robot.setState(state, true);
    inside(reachOver(robot, 3), state);
    robot.setUpdateHint([0.23, 0.51, 0.96]);
    inside(reachOver(robot, 1), `${state} with the update's arrow`);
  }
  // Its own moods, and the hearts and stars they send up.
  const moods = {
    annoyed: (r) => r.poke(-1),
    dizzy: (r) => r.react("dizzy", 1),
    love: (r) => r.react("love"),
    greeting: (r) => r.greet(),
    wave: (r) => r.perform("wave"),
    hop: (r) => r.perform("hop"),
    typing: (r) => r.perform("type"),
    "picked up and put down": (r) => (r.hold(), run(r, 0.3), r.land()),
    asleep: (r) => r.sleep(true),
  };
  for (const [name, play] of Object.entries(moods)) {
    const robot = petRobot();
    play(robot);
    inside(reachOver(robot, 4), name);
  }
  // A task finishing in the middle of a greeting, at the top of its hover.
  const robot = petRobot();
  robot.greet();
  run(robot, 0.9);
  robot.setState("finished", true);
  inside(reachOver(robot, 3), "finished while greeting");
  // On its way: leaning as far as it leans, its antenna as far back as it goes, every way.
  for (const [dx, dy] of [[900, 500], [-900, 500], [900, -500], [-900, -500], [0, 700], [700, 0]]) {
    const flying = petRobot();
    const box = reachOver(flying, 0.6, 1);
    for (let i = 0; i <= 60; i++) {
      const pose = travelPose(i / 60, dx, dy, "out");
      flying.fly(pose.lean, pose.trail);
      const part = reachOver(flying, 0.01, pose.size);
      for (const side of ["left", "top"]) box[side] = Math.min(box[side], part[side]);
      for (const side of ["right", "bottom"]) box[side] = Math.max(box[side], part[side]);
    }
    flying.fly(0, [0, 0]);
    flying.land();
    const landing = reachOver(flying, 1);
    inside(box, `flying ${dx},${dy}`);
    inside(landing, `landing after ${dx},${dy}`);
  }
});

// ── The silhouette ────────────────────────────────────────────────────────────

test("Liv's silhouette is its head, its hands and its feet, and nothing of the window around them", () => {
  const shape = hitShape();
  const { w, h, cx, cy } = PET_WINDOW;
  const on = (x, y) => onShape(x, y, shape);
  assert.equal(shape.length, 5, "a head, two hands, two feet");
  assert.ok(on(cx, cy), "the middle of the head");
  assert.ok(on(cx + PET_R, cy) && on(cx, cy - PET_R) && on(cx - PET_R * 0.7, cy + PET_R * 0.7), "its edge");
  assert.ok(!on(cx + PET_R * 1.12, cy - PET_R * 0.4) && !on(cx, cy - PET_R * 1.12), "just past it");
  // The hands hang beside the head, the feet stand under it.
  const [, leftHand, leftFoot, rightHand, rightFoot] = shape;
  for (const d of [leftHand, leftFoot, rightHand, rightFoot]) assert.ok(on(d.x, d.y));
  assert.ok(leftHand.x < cx - PET_R && rightHand.x > cx + PET_R, "outside the head");
  assert.ok(leftFoot.y > cy + PET_R && rightFoot.y > cy + PET_R, "below it");
  assert.ok(near(leftHand.x + rightHand.x, cx * 2) && near(leftFoot.x + rightFoot.x, cx * 2), "the same on both sides");
  // Everything around Liv belongs to what is underneath: the corners, the air
  // above it where the antenna and the hearts go, the room for the badge.
  for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [cx, 4], [cx, cy - PET_R * 1.4], [w - 6, cy - 20], [4, cy]]) {
    assert.ok(!on(x, y), `${x},${y}`);
  }
  // The discs stay inside the window (Rust refuses any that do not) and never
  // reach more than two pixels past the figure at rest.
  const body = robotBounds(robotGeometry(PET_R), "body");
  for (const d of shape) {
    assert.ok(d.x - d.r >= 0 && d.y - d.r >= 0 && d.x + d.r <= w && d.y + d.r <= h);
    assert.ok(Math.abs(d.x - cx) + d.r <= body.side * PET_R + 2, "beside");
    assert.ok(d.y + d.r <= cy + body.bottom * PET_R + 2, "below");
  }
  // The head alone is where a click annoys and a rest wins it over.
  assert.ok(onPetHead(cx, cy) && onPetHead(cx + PET_R, cy));
  assert.ok(!onPetHead(leftHand.x, leftHand.y) && !onPetHead(cx, cy - PET_R * 1.2));
  // No shape: nothing is Liv.
  assert.ok(!onShape(cx, cy, []));
});

// ── Picking up and dropping ───────────────────────────────────────────────────

test("a press becomes a drag only past a few pixels", () => {
  const press = { x: 68, y: 100 };
  assert.equal(DRAG_THRESHOLD, 6);
  assert.ok(!isDrag(press, press), "a click");
  assert.ok(!isDrag(press, { x: 71, y: 104 }), "a hand that is not perfectly still: 5 px");
  assert.ok(!isDrag(press, { x: 74, y: 100 }), "exactly the threshold");
  assert.ok(isDrag(press, { x: 74.5, y: 100 }));
  assert.ok(isDrag(press, { x: 68, y: 93 }), "any way");
  assert.ok(isDrag(press, { x: 63, y: 104.5 }), "diagonally: 6.7 px");
});

test("a drop on the island brings Liv home; anywhere else it stays there", () => {
  // The open island: 640 × 160 in a 720 px page.
  const open = { x: 40, y: 0, w: 640, h: 160 };
  assert.equal(dropOutcome({ x: 360, y: 80 }, open), "home", "back where it came from");
  assert.equal(dropOutcome({ x: 45, y: 155 }, open), "home", "its corner");
  assert.equal(dropOutcome({ x: 360, y: 160 + HOME_MARGIN }, open), "home", "just under it");
  assert.equal(dropOutcome({ x: 360, y: 160 + HOME_MARGIN + 1 }, open), "stay");
  assert.equal(dropOutcome({ x: 40 - HOME_MARGIN - 1, y: 80 }, open), "stay", "just beside it");
  assert.equal(dropOutcome({ x: 360, y: 600 }, open), "stay");
  assert.equal(dropOutcome({ x: -10_000, y: -10_000 }, open), "stay", "the island is not on screen");
  // A pointer pushed against the top edge of the screen is on the island.
  assert.equal(dropOutcome({ x: 360, y: -3 }, open), "home");

  // The compact island: 288 × 32.
  const compact = { x: 216, y: 0, w: COMPACT_W, h: NOTCH_H };
  assert.equal(dropOutcome({ x: 360, y: 20 }, compact), "home");
  assert.equal(dropOutcome({ x: 360, y: NOTCH_H + HOME_MARGIN + 1 }, compact), "stay");

  // Hidden, or closed and small: it can still be aimed at, as big as the compact one.
  for (const small of [{ x: 268, y: 0, w: 184, h: 0 }, { x: 0, y: 0, w: 120, h: 24 }]) {
    const zone = homeZone(small);
    assert.equal(zone.w, COMPACT_W + HOME_MARGIN * 2);
    assert.ok(near(zone.x + zone.w / 2, small.x + small.w / 2), "around its middle");
    assert.equal(dropOutcome({ x: small.x + small.w / 2, y: 10 }, small), "home");
    assert.equal(dropOutcome({ x: small.x + small.w / 2 + COMPACT_W / 2 + 10, y: 10 }, small), "home");
    assert.equal(dropOutcome({ x: small.x + small.w / 2, y: NOTCH_H + HOME_MARGIN + 5 }, small), "stay");
    assert.equal(dropOutcome({ x: small.x + small.w / 2 + COMPACT_W, y: 10 }, small), "stay");
  }
});

// ── The way ───────────────────────────────────────────────────────────────────

test("a way takes between 450 and 600 ms, longer the further it goes", () => {
  assert.equal(travelMs(0), 450);
  assert.equal(travelMs(TRAVEL.farPx), 600);
  assert.equal(travelMs(50_000), 600);
  assert.equal(travelMs(TRAVEL.farPx / 2), 525);
  let last = 0;
  for (let px = 0; px <= 3000; px += 100) {
    assert.ok(travelMs(px) >= last);
    last = travelMs(px);
  }
});

test("the way starts and ends where asked, and comes home the way it went out", () => {
  const island = { x: 960, y: -52 };
  const spot = { x: 1810, y: 915 };
  assert.deepEqual(travelPoint(island, spot, 0), island);
  assert.deepEqual(travelPoint(island, spot, 1), spot);
  assert.deepEqual(travelPoint(island, spot, -1), island);
  assert.deepEqual(travelPoint(island, spot, 9), spot);
  for (let i = 0; i <= 20; i++) {
    const out = travelPoint(island, spot, i / 20);
    const home = travelPoint(spot, island, 1 - i / 20);
    assert.ok(near(out.x, home.x, 1e-6) && near(out.y, home.y, 1e-6), `${i}`);
    // Never outside the box of its two ends: nothing swings off the display.
    assert.ok(out.x >= island.x - 1e-9 && out.x <= spot.x + 1e-9 && out.y >= island.y - 1e-9 && out.y <= spot.y + 1e-9);
  }
  // No way at all: it stays put.
  assert.deepEqual(travelPoint(spot, spot, 0.4), spot);
});

test("Liv drops out of the island before it crosses the screen, slow at both ends", () => {
  const island = { x: 960, y: 0 };
  for (const spot of [{ x: 1800, y: 900 }, { x: 100, y: 900 }]) {
    const share = (p) => [Math.abs(p.x - island.x) / Math.abs(spot.x - island.x), (p.y - island.y) / (spot.y - island.y)];
    const [acrossEarly, downEarly] = share(travelPoint(island, spot, 0.35));
    assert.ok(downEarly > acrossEarly * 1.5, `early on it has gone down more than across: ${downEarly} / ${acrossEarly}`);
    const [acrossLate, downLate] = share(travelPoint(island, spot, 0.8));
    assert.ok(1 - acrossLate > (1 - downLate) * 1.5, "the last stretch is across");
    // The steps are short at the ends and long in the middle.
    const step = (t) => {
      const a = travelPoint(island, spot, t);
      const b = travelPoint(island, spot, t + 0.02);
      return Math.hypot(b.x - a.x, b.y - a.y);
    };
    assert.ok(step(0) < step(0.2) && step(0.2) < step(0.49));
    assert.ok(step(0.98) < step(0.78) && step(0.78) < step(0.49));
    assert.ok(step(0) < step(0.49) / 20, "it sets off gently");
  }
});

test("the way is handed to Rust as a point every 16 ms, timed by how long it looks", () => {
  const from = { x: 1819, y: -104 };
  const to = { x: 3500, y: 1700 };
  const path = travelPath(from, to, 2);
  // 2466 physical px on a display at 200 %: 1233 page px, the longest time.
  assert.equal(path.ms, 600);
  assert.equal(path.points.length, Math.ceil(600 / TRAVEL.stepMs) + 1);
  assert.deepEqual(path.points[0], [from.x, from.y]);
  assert.deepEqual(path.points.at(-1), [to.x, to.y]);
  for (const [x, y] of path.points) assert.ok(Number.isFinite(x) && Number.isFinite(y));
  // The same way on a display at 100 % looks twice as long.
  assert.equal(travelPath({ x: 0, y: 0 }, { x: 300, y: 400 }, 1).ms, travelMs(500));
  assert.equal(travelPath({ x: 0, y: 0 }, { x: 300, y: 400 }, 2).ms, travelMs(250));
  // A unit that is nonsense is taken for one.
  assert.equal(travelPath({ x: 0, y: 0 }, { x: 300, y: 400 }, 0).ms, travelMs(500));
  // Short enough for Rust to take (pet.rs: MAX_WAY_POINTS, MAX_WAY_MS).
  const limit = (name) => Number(PET_RS.match(new RegExp(`const ${name}: \\w+ = (\\d+);`))[1]);
  assert.ok(path.points.length <= limit("MAX_WAY_POINTS") && TRAVEL.maxMs <= limit("MAX_WAY_MS"));
});

test("on its way Liv leans where it goes, its antenna trails and its eyes are ahead; it lands upright", () => {
  for (const [dx, dy] of [[900, 500], [-900, 500], [600, -700], [-40, 800]]) {
    for (const end of [0, 1, -0.2, 1.4]) {
      const pose = travelPose(end, dx, dy, "move");
      assert.deepEqual(pose, AT_REST, `${dx},${dy} at ${end}`);
    }
    let most = 0;
    for (let i = 1; i < 40; i++) {
      const t = i / 40;
      const pose = travelPose(t, dx, dy, "move");
      const here = travelPoint({ x: 0, y: 0 }, { x: dx, y: dy }, t);
      const next = travelPoint({ x: 0, y: 0 }, { x: dx, y: dy }, t + 0.001);
      const going = [next.x - here.x, next.y - here.y];
      // It leans the way it is moving, and never more than it leans.
      assert.ok(pose.lean * going[0] >= -1e-12, `${dx},${dy} at ${t}: leaning ${pose.lean} going ${going[0]}`);
      assert.ok(Math.abs(pose.lean) <= TRAVEL.lean + 1e-12);
      // The antenna's tip is pushed back, against the way; the eyes look along it.
      assert.ok(pose.trail[0] * going[0] <= 1e-12 && pose.trail[1] * going[1] <= 1e-12);
      assert.ok(Math.hypot(...pose.trail) <= TRAVEL.trail + 1e-12);
      assert.ok(pose.gaze[0] * going[0] >= -1e-12 && pose.gaze[1] * going[1] >= -1e-12);
      assert.ok(Math.hypot(...pose.gaze) <= 1 + 1e-12);
      most = Math.max(most, Math.hypot(...pose.trail));
    }
    assert.ok(near(most, TRAVEL.trail, 1e-9), "all the way back at its fastest, half way");
    // Straightening as it slows down.
    assert.ok(Math.abs(travelPose(0.95, dx, dy, "move").lean) < Math.abs(travelPose(0.5, dx, dy, "move").lean) / 10 + 1e-12);
  }
  // Straight down, it does not lean.
  assert.ok(near(travelPose(0.5, 0, 800, "move").lean, 0));
  // Going nowhere: upright, and no number that is not one.
  const still = travelPose(0.5, 0, 0, "move");
  assert.deepEqual([still.lean, ...still.trail, ...still.gaze], [0, 0, 0, 0, 0]);
});

test("Liv comes out of the island small and grows; going home it is small again at the end", () => {
  assert.equal(travelPose(0, 500, 500, "out").size, TRAVEL.small);
  assert.equal(travelPose(TRAVEL.grow, 500, 500, "out").size, 1);
  assert.equal(travelPose(0.9, 500, 500, "out").size, 1);
  assert.equal(travelPose(1, 500, 500, "out").size, 1);
  assert.equal(travelPose(0, -500, -500, "home").size, 1);
  assert.equal(travelPose(1 - TRAVEL.grow, -500, -500, "home").size, 1);
  assert.equal(travelPose(1, -500, -500, "home").size, TRAVEL.small);
  // Once there it stays small until its window is put away.
  assert.equal(travelPose(1.3, -500, -500, "home").size, TRAVEL.small);
  let last = TRAVEL.small;
  for (let i = 0; i <= 20; i++) {
    const size = travelPose(i / 20, 500, 500, "out").size;
    assert.ok(size >= last - 1e-12 && size <= 1);
    last = size;
  }
  // A move on the desktop: whole all the way.
  for (const t of [0, 0.3, 1]) assert.equal(travelPose(t, 300, 0, "move").size, 1);
  // Small, it is about as big as it is in the compact island.
  assert.ok(Math.abs(PET_SLOT * TRAVEL.small - 30) < 4);
});

// ── Rest ──────────────────────────────────────────────────────────────────────

test("Liv hovers while the pointer is near and for a few seconds after anything happens to it", () => {
  assert.ok(pointerNear(0) && pointerNear(NEAR_PX));
  assert.ok(!pointerNear(NEAR_PX + 1) && !pointerNear(null), "far, or nobody knows where");
  assert.ok(hovers({ near: true, quietMs: 0 }));
  assert.ok(hovers({ near: true, quietMs: 10 * 60_000 }), "for as long as the pointer stays");
  assert.ok(hovers({ near: false, quietMs: 0 }), "just clicked, just landed");
  assert.ok(hovers({ near: false, quietMs: LINGER_MS - 1 }));
  assert.ok(!hovers({ near: false, quietMs: LINGER_MS }), "then it is a still picture");
  assert.ok(!hovers({ near: false, quietMs: SLEEP_AFTER_MS + 5 }));
  assert.ok(LINGER_MS >= 2000 && LINGER_MS <= 8000, "a few seconds");
});

test("left alone for two minutes Liv falls asleep, and anything wakes it", () => {
  assert.equal(SLEEP_AFTER_MS, 120_000);
  assert.ok(!sleeps({ near: false, quietMs: 0 }));
  assert.ok(!sleeps({ near: false, quietMs: SLEEP_AFTER_MS - 1 }));
  assert.ok(sleeps({ near: false, quietMs: SLEEP_AFTER_MS }));
  assert.ok(sleeps({ near: false, quietMs: 8 * 3600_000 }), "all night");
  // The pointer near: never, and it wakes.
  assert.ok(!sleeps({ near: true, quietMs: SLEEP_AFTER_MS * 3 }));
  // A click, a drag, a landing or a change of state starts the count again.
  assert.ok(!sleeps({ near: false, quietMs: 0 }));
});

test("one timer is enough: for the end of the hover, then for sleep, and none after", () => {
  assert.equal(nextChangeAt({ near: true, quietMs: 0 }), null, "the pointer is near: nothing changes by itself");
  assert.equal(nextChangeAt({ near: true, quietMs: SLEEP_AFTER_MS }), null);
  assert.equal(nextChangeAt({ near: false, quietMs: 0 }), LINGER_MS);
  assert.equal(nextChangeAt({ near: false, quietMs: LINGER_MS - 1 }), LINGER_MS);
  assert.equal(nextChangeAt({ near: false, quietMs: LINGER_MS }), SLEEP_AFTER_MS);
  assert.equal(nextChangeAt({ near: false, quietMs: SLEEP_AFTER_MS - 1 }), SLEEP_AFTER_MS);
  assert.equal(nextChangeAt({ near: false, quietMs: SLEEP_AFTER_MS }), null, "asleep: no timer at all");
  // Each change it announces is a change.
  for (const at of [LINGER_MS, SLEEP_AFTER_MS]) {
    const before = { near: false, quietMs: at - 1 };
    const after = { near: false, quietMs: at };
    assert.ok(hovers(before) !== hovers(after) || sleeps(before) !== sleeps(after));
  }
});

// ── Frames ────────────────────────────────────────────────────────────────────

test("the window's frame loop runs only while something of Liv moves and somebody sees it", () => {
  const still = { travelling: false, robotChanging: false };
  const moving = { travelling: false, robotChanging: true };
  const flying = { travelling: true, robotChanging: false };
  const shown = { shown: true, hovering: false, asleep: false };
  assert.ok(!petNeedsFrame(shown, still), "a still picture");
  assert.ok(petNeedsFrame(shown, moving) && petNeedsFrame(shown, flying));
  assert.ok(!petNeedsFrame({ ...shown, asleep: true }, still), "asleep");
  assert.ok(petNeedsFrame({ ...shown, asleep: true }, moving), "its eyes are still closing");
  // Home, parked for a full-screen app or paused: nothing, whatever is going on.
  for (const work of [still, moving, flying]) {
    assert.ok(!petNeedsFrame({ shown: false, hovering: true, asleep: false }, work));
  }
});

test("Liv blinks on the page's one timer only while it stands still, awake and in sight", () => {
  assert.ok(petLivesOnTimer({ shown: true, hovering: false, asleep: false }));
  assert.ok(!petLivesOnTimer({ shown: true, hovering: true, asleep: false }), "hovering, the engine blinks itself");
  assert.ok(!petLivesOnTimer({ shown: true, hovering: false, asleep: true }), "asleep, its eyes are shut");
  assert.ok(!petLivesOnTimer({ shown: false, hovering: false, asleep: false }), "nobody sees it");
});

// ── What the island says while Liv is out ─────────────────────────────────────

test("only what needs the user brings Liv home; a task that ends is celebrated on the spot", () => {
  assert.equal(whileOut("alert"), "flyHome");
  assert.equal(whileOut("finished"), "celebrate");
  assert.equal(whileOut("error"), "celebrate");
  assert.equal(whileOut("greeting"), "wave");
  assert.equal(whileOut("work"), "nothing");
});

// ── Outings ───────────────────────────────────────────────────────────────────

/** A stand-in for the windows: every way waits until the test says how it ends. */
function world({ supported = true } = {}) {
  const did = [];
  const waiting = [];
  const way = (name) => (...args) => {
    did.push(args.length ? `${name}:${args.join(",")}` : name);
    return new Promise((resolve) => waiting.push({ name, resolve }));
  };
  const host = {
    needed: false,
    away: false,
  };
  const outing = new Outing({
    goOut: way("goOut"),
    goHome: way("goHome"),
    appear: way("appear"),
    pickUp: way("pickUp"),
    settle: () => did.push("settle"),
    hide: (forget) => did.push(`hide:${forget}`),
    setAway: (away) => (host.away = away),
    needed: () => host.needed,
  });
  outing.supported = supported;
  /** The oldest way still going ends: Liv got there, or did not. */
  const end = async (name, there = true) => {
    const i = waiting.findIndex((w) => w.name === name);
    assert.ok(i >= 0, `no ${name} is under way: ${waiting.map((w) => w.name)}`);
    waiting.splice(i, 1)[0].resolve(there);
    await new Promise((resolve) => setImmediate(resolve));
  };
  /** Where Liv is, whether the island's slot is empty, and whether the desktop is where it lives. */
  const is = (phase, away, lives, what) => {
    assert.deepEqual([outing.phase, outing.away, host.away, outing.lives], [phase, away, away, lives], what);
  };
  return { outing, host, did, end, is };
}

test("the shortcut sends Liv out to its spot, and calls it home again", async () => {
  const { outing, did, end, is } = world();
  is("home", false, false);
  outing.toggle();
  is("leaving", true, true, "its slot in the island is empty as soon as it sets off");
  assert.deepEqual(did, ["goOut:true"], "to its spot, or one of its own choosing");
  outing.toggle();
  assert.deepEqual(did, ["goOut:true"], "on its way, the shortcut waits");
  await end("goOut");
  is("out", true, true);

  outing.toggle();
  is("returning", true, false);
  await end("goHome");
  is("home", false, false);
  assert.deepEqual(did, ["goOut:true", "goHome", "hide:true"], "home for good: it is forgotten on the desktop");
});

test("where Liv cannot leave the island nothing happens", async () => {
  const { outing, did, is } = world({ supported: false });
  outing.toggle();
  outing.ask(true);
  await outing.pickUp();
  assert.equal(await outing.startOut(), false);
  outing.summon();
  outing.folded();
  outing.sendHome();
  is("home", false, false);
  assert.deepEqual(did, []);
});

test("with nowhere to go Liv stays in the island", async () => {
  const { outing, did, end, is } = world();
  outing.toggle();
  await end("goOut", false);
  is("home", false, false);
  assert.deepEqual(did, ["goOut:true", "hide:true"]);
});

test("the switch in Settings asks for one or the other, and asking twice changes nothing", async () => {
  const { outing, did, end, is } = world();
  outing.ask(false);
  assert.deepEqual(did, []);
  outing.ask(true);
  await end("goOut");
  is("out", true, true);
  outing.ask(true);
  assert.deepEqual(did, ["goOut:true"]);
  outing.ask(false);
  await end("goHome");
  is("home", false, false);
});

test("a double click on Liv sends it home, from the desktop only", async () => {
  const { outing, did, end, is } = world();
  outing.sendHome();
  assert.deepEqual(did, []);
  outing.toggle();
  outing.sendHome();
  assert.deepEqual(did, ["goOut:true"], "not on its way");
  await end("goOut");
  outing.sendHome();
  is("returning", true, false);
  await end("goHome");
  is("home", false, false);
});

test("when the island needs the user Liv flies home, and back to its spot once it folds", async () => {
  const { outing, host, did, end, is } = world();
  outing.toggle();
  await end("goOut");
  did.length = 0;

  host.needed = true;
  outing.summon();
  is("returning", true, true, "still away until it lands");
  await end("goHome");
  is("visiting", false, true, "in the island's card, and the desktop is still where it lives");
  assert.deepEqual(did, ["goHome"], "its window was put away by the way home itself: nothing is forgotten");
  // Asked again while it is here: nothing.
  outing.summon();
  assert.deepEqual(did, ["goHome"]);

  host.needed = false;
  outing.folded();
  is("leaving", true, true);
  assert.deepEqual(did, ["goHome", "goOut:false"], "to the spot it had, and nowhere else");
  await end("goOut");
  is("out", true, true);
});

test("an island that folds before Liv gets home sends it straight back", async () => {
  const { outing, host, did, end, is } = world();
  outing.toggle();
  await end("goOut");
  did.length = 0;
  host.needed = true;
  outing.summon();
  // Answered at once: the island folds while Liv is in the air. A visit only
  // starts once it lands, so the fold itself asks nothing of it.
  host.needed = false;
  outing.folded();
  is("returning", true, true);
  await end("goHome");
  is("leaving", true, true);
  assert.deepEqual(did, ["goHome", "goOut:false"]);
  await end("goOut");
  is("out", true, true);
});

test("called home on its way out, Liv turns round, and the way it was on changes nothing", async () => {
  const { outing, host, did, end, is } = world();
  outing.toggle();
  host.needed = true;
  outing.summon();
  is("returning", true, true);
  assert.deepEqual(did, ["goOut:true", "goHome"]);
  // The first way was overtaken: it ends without having got there.
  await end("goOut", false);
  is("returning", true, true);
  await end("goHome");
  is("visiting", false, true, "the desktop is where it was going to live");
  host.needed = false;
  outing.folded();
  await end("goOut");
  is("out", true, true);
});

test("a visit can become a stay, and a spot that is gone keeps Liv home", async () => {
  // The shortcut while Liv is visiting: it simply stays.
  let w = world();
  w.outing.toggle();
  await w.end("goOut");
  w.host.needed = true;
  w.outing.summon();
  await w.end("goHome");
  w.did.length = 0;
  w.outing.toggle();
  w.is("home", false, false);
  assert.deepEqual(w.did, ["hide:true"]);
  w.outing.folded();
  assert.deepEqual(w.did, ["hide:true"], "the island folding moves nothing any more");

  // The shortcut while it is still on its way to the visit: it arrives, and stays.
  w = world();
  w.outing.toggle();
  await w.end("goOut");
  w.host.needed = true;
  w.outing.summon();
  w.outing.toggle();
  w.is("returning", true, true, "in the air the shortcut waits");
  await w.end("goHome");
  w.is("visiting", false, true);

  // Its display was unplugged during the visit: no way back, it lives in the island again.
  w = world();
  w.outing.toggle();
  await w.end("goOut");
  w.host.needed = true;
  w.outing.summon();
  await w.end("goHome");
  w.host.needed = false;
  w.did.length = 0;
  w.outing.folded();
  await w.end("goOut", false);
  w.is("home", false, false);
  assert.deepEqual(w.did, ["goOut:false", "hide:true"]);

  // The way home itself fails: its window is put away all the same.
  w = world();
  w.outing.toggle();
  await w.end("goOut");
  w.host.needed = true;
  w.outing.summon();
  w.did.length = 0;
  await w.end("goHome", false);
  w.is("visiting", false, true);
  assert.deepEqual(w.did, ["hide:false"]);
});

test("dragged out of the island Liv stays where it is dropped; dropped back on the island it is home", async () => {
  let w = world();
  const picking = w.outing.pickUp();
  w.is("carried", true, false, "the island's slot empties as it is picked up");
  await w.end("pickUp");
  await picking;
  // Nothing else moves it while the pointer holds it.
  w.outing.toggle();
  w.outing.summon();
  w.outing.sendHome();
  assert.deepEqual(w.did, ["pickUp"]);
  w.outing.dropped("stay");
  w.is("out", true, true);
  assert.deepEqual(w.did, ["pickUp", "settle"]);
  // A second drop that never was: nothing.
  w.outing.dropped("home");
  w.is("out", true, true);

  w = world();
  void w.outing.pickUp();
  await w.end("pickUp");
  w.outing.dropped("home");
  w.is("home", false, false, "cancelled: it is in the island again");
  assert.deepEqual(w.did, ["pickUp", "hide:true"]);

  // The window could not come: the island has its Liv back.
  w = world();
  void w.outing.pickUp();
  await w.end("pickUp", false);
  w.is("home", false, false);
  assert.deepEqual(w.did, ["pickUp", "hide:false"]);

  // Only a Liv that is in the island can be picked up from it.
  w = world();
  w.outing.toggle();
  await w.outing.pickUp();
  assert.deepEqual(w.did, ["goOut:true"]);
});

test("picked up on the desktop Liv moves to where it is dropped, or home when that is the island", async () => {
  let w = world();
  w.outing.grabbed();
  w.is("home", false, false, "nothing to grab while it is home");
  w.outing.toggle();
  await w.end("goOut");
  w.did.length = 0;
  w.outing.grabbed();
  w.is("carried", true, true);
  w.outing.dropped("stay");
  w.is("out", true, true);
  assert.deepEqual(w.did, ["settle"]);

  w.outing.grabbed();
  w.outing.dropped("home");
  w.is("home", false, false);
  assert.deepEqual(w.did, ["settle", "hide:true"]);

  // Dropped while the island waits for the user: it lands, then flies home for it.
  w = world();
  w.outing.toggle();
  await w.end("goOut");
  w.outing.grabbed();
  w.host.needed = true;
  w.outing.summon();
  w.is("carried", true, true, "not out of the pointer's hand");
  w.did.length = 0;
  w.outing.dropped("stay");
  w.is("returning", true, true);
  assert.deepEqual(w.did, ["settle", "goHome"]);
});

test("Liv starts where it was left, or in the island when its spot is gone", async () => {
  let w = world();
  let started = w.outing.startOut();
  w.is("out", true, true);
  await w.end("appear");
  assert.equal(await started, true);
  w.is("out", true, true);
  assert.deepEqual(w.did, ["appear"], "at its spot at once: no way there");

  w = world();
  started = w.outing.startOut();
  await w.end("appear", false);
  assert.equal(await started, false);
  w.is("home", false, false);
  assert.deepEqual(w.did, ["appear", "hide:true"]);

  // A request already waiting as Liv starts: it goes straight to the island for it.
  w = world();
  w.host.needed = true;
  started = w.outing.startOut();
  await w.end("appear");
  assert.equal(await started, true);
  w.is("returning", true, true);
});

// ── The engine, out of the island ─────────────────────────────────────────────

test("on the desktop Liv hovers: it floats four times as far as it does in the island", () => {
  const tops = (float) => {
    const robot = new Robot(() => 0.5);
    if (float != null) robot.float = float;
    robot.setLimbs(true);
    robot.alive = true;
    run(robot, 2);
    const box = reachOver(robot, 3.2);
    const still = new Robot(() => 0.5);
    still.setLimbs(true);
    run(still, 2);
    const ctx = recorder();
    still.drawAt(ctx, PET_R, PET_WINDOW.cx, PET_WINDOW.cy);
    return [ctx.box.top - box.top, box.bottom - ctx.box.bottom];
  };
  const [upIsland, downIsland] = tops(null);
  const [up, down] = tops(HOVER_FLOAT);
  assert.ok(up > upIsland + 1 && down > downIsland + 1, `${up} / ${upIsland}`);
  assert.ok(up > 1.5 && up < 4, `about ${HOVER_FLOAT * PET_R} px each way: ${up}`);
  // Not alive, it is a still picture: nothing asks for a frame.
  const robot = petRobot();
  robot.alive = false;
  run(robot, 2);
  assert.ok(!robot.changing);
});

test("carried through the air Liv leans and its antenna trails, then swings back and is still", () => {
  const robot = petRobot();
  robot.alive = false;
  run(robot, 2);
  assert.ok(!robot.changing);
  const drawn = () => {
    const ctx = recorder();
    robot.drawAt(ctx, PET_R, PET_WINDOW.cx, PET_WINDOW.cy);
    return ctx;
  };
  const upright = drawn();
  assert.ok(!upright.turns.includes(0.17));

  robot.fly(0.17, [-0.3, 0]);
  robot.update(0.01);
  assert.ok(robot.changing, "the antenna is on its way back");
  assert.ok(drawn().turns.includes(0.17), "its head leans at once");
  run(robot, 1.5);
  assert.ok(!robot.changing, "the tip has reached where the air holds it");
  assert.ok(Math.abs(drawn().box.top - upright.box.top) > 0.3, "its antenna no longer stands as it did");

  robot.fly(0, [0, 0]);
  robot.update(0.01);
  assert.ok(robot.changing, "it swings back");
  run(robot, 2);
  assert.ok(!robot.changing);
  const again = drawn();
  assert.ok(near(again.box.left, upright.box.left, 0.05) && near(again.box.top, upright.box.top, 0.05), "as it stood before");
});

test("picked up Liv stretches and lifts its hands; put down it squashes and is at rest", () => {
  const robot = petRobot();
  robot.alive = false;
  run(robot, 2);
  robot.react("love");
  run(robot, 0.3);
  robot.hold();
  run(robot, 0.5);
  assert.ok(near(robot.squash, 0.05) && near(robot.lift, 0.2), `${robot.squash} ${robot.lift}`);
  run(robot, 3);
  assert.ok(!robot.changing, "hanging there, nothing moves: no hearts, no frame");
  assert.ok(near(robot.squash, 0.05), "for as long as it is held");

  robot.land();
  let lowest = 0;
  run(robot, 0.2, (r) => (lowest = Math.min(lowest, r.squash)));
  assert.ok(lowest < -0.08, `it squashes as it touches down: ${lowest}`);
  run(robot, 1);
  assert.ok(!robot.changing);
  assert.deepEqual([robot.squash, robot.lift], [0, 0]);

  // Landing at the end of a way, with nothing to put down.
  robot.land();
  run(robot, 1);
  assert.ok(!robot.changing && robot.squash === 0 && robot.lift === 0);
});

test("asleep its eyes are shut and its antenna is off, whatever the state, and nothing moves", () => {
  const shapes = (robot) => {
    const widths = [];
    const ctx = recorder();
    const real = ctx.roundRect;
    ctx.roundRect = (x, y, w, h) => (widths.push(h / w), real(x, y, w, h));
    robot.drawAt(ctx, PET_R, PET_WINDOW.cx, PET_WINDOW.cy);
    return widths;
  };
  for (const state of ["idle", "working", "approval"]) {
    const robot = petRobot();
    robot.alive = false;
    robot.setState(state, true);
    run(robot, 3);
    assert.equal(robot.lit, 1);

    robot.sleep(true);
    assert.ok(robot.changing, "its eyes are closing");
    run(robot, 1);
    assert.equal(robot.lit, 0, `${state}: the antenna is out`);
    assert.ok(!robot.changing, `${state}: a still picture`);
    // Two thin bars where its eyes were.
    assert.ok(shapes(robot).filter((ratio) => ratio < 0.2).length >= 2, state);
    // Asked again: nothing.
    robot.sleep(true);
    assert.ok(!robot.changing);
    // It does not blink in its sleep.
    robot.act("blink");
    assert.equal(robot.blink, 0);

    robot.sleep(false);
    run(robot, 1);
    assert.equal(robot.lit, 1, "awake: lit as its state says");
    assert.ok(!robot.changing);
  }
  // Falling asleep ends whatever it was doing for itself.
  const robot = petRobot();
  robot.alive = false;
  robot.react("dizzy");
  run(robot, 0.5);
  robot.sleep(true);
  run(robot, 1.5);
  assert.ok(!robot.changing, "no stars left turning");
  // A state that arrives wakes it in the window (main.ts); the engine plays it awake.
  robot.sleep(false);
  robot.setState("finished", true);
  run(robot, 0.2);
  assert.ok(robot.oy < 0, "it hops");
});

test("the greeting is over before a late page could play it twice", () => {
  assert.ok(HELLO_FRESH_MS > GREETING_MS, "long enough for a page that comes up a moment late");
  assert.ok(HELLO_FRESH_MS < 10_000, "and short enough that a reload does not greet again");
});
