// Liv, the island's figure (src/robot): what each state looks like, how big
// the head is in the room it is given and what is drawn at each size, the
// shell's colours, the eyes' shapes, what moves and for how long, and when it
// is at rest — which is what lets the island's frame loop stop. And its own
// moods: annoyed by a click, dizzy after three, won over by a resting
// pointer, and the greeting; with the hearts and stars they send up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOSED_BOT_D, CLOSED_H } from "../src/core/closed.ts";
import { NOTCH_H, PEEK_BOT_D, PEEK_BOT_Y, PEEK_H, PEEK_W, VIEW_LAYOUTS, botPosition, islandSize } from "../src/core/layout.ts";
import { LIFE_MAX_MS, LIFE_MIN_MS, nextLife, seededRandom } from "../src/robot/life.ts";
import {
  ANTENNA_OFF, CANVAS_PER_SLOT, EYE_SHAPES, EYE_SWAP_MS, FOOT, GAZE_EYES, GAZE_VISOR, HAND, HEAD_FIT, HELLO, LOVE, LOVE_EYES,
  ROBOT_STATES, SHELL_ICE, SHELL_TEAL, SPIRAL, STAR, VISOR_TOP, WAVE,
  antennaColor, antennaHalo, eyeHalfHeight, eyeSwap, followColor, gazeFor, hairline, headRadius, hexToRGB, lodFor, mix,
  modelFor, placeInBox, placeInSlot, rgba, robotBounds, robotDrop, robotGeometry, shellPalette, stillPose, visorPoint,
} from "../src/robot/look.ts";
import { OUTFIT_IDS } from "../src/robot/outfits.ts";
import { paintBoxRobot, paintEye, paintParticle, paintRobot, paintSlotRobot } from "../src/robot/paint.ts";
import { HEARTS, STARS, ageParticles, fading, heart, particleShape, stars } from "../src/robot/particles.ts";
import { LOVE_TIMES, POKE, countPoke, onHead } from "../src/robot/react.ts";
import { GREETING_MS, Robot, pulseScale } from "../src/robot/robot.ts";
import { colours, recorder } from "./recorder.mjs";

const STATES = ["idle", "working", "thinking", "approval", "question", "error", "finished", "ratelimit"];
/** The slots the app rests the figure at: the grid, the closed island, the compact one, a pill, the cards. */
const SLOTS = [13, 18, 20, 24, 44, 46, 50, 52, 56, 58, 62, 66];

/** Steps the robot for `seconds`, 100 times a second; `each` sees it after every step. */
function run(robot, seconds, each = () => {}) {
  const steps = Math.round(seconds * 100);
  for (let i = 1; i <= steps; i++) {
    robot.update(0.01);
    each(robot, i * 10);
  }
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearAll = (a, b, eps = 1e-6) => a.every((v, i) => near(v, b[i], eps));

// ── States ────────────────────────────────────────────────────────────────────

test("every state has its lights, its eyes and its badge", () => {
  assert.deepEqual(Object.keys(ROBOT_STATES), STATES);
  const look = (state) => {
    const s = ROBOT_STATES[state];
    return [s.eyes.shape, s.antenna, s.pulse, s.badge?.kind ?? null];
  };
  assert.deepEqual(look("idle"), ["round", 0, 0, null]);
  assert.deepEqual(look("working"), ["narrow", 1, 1.4, "dots"]);
  assert.deepEqual(look("thinking"), ["round", 1, 2.4, "dots"]);
  assert.deepEqual(look("approval"), ["wide", 1, 0, "bang"]);
  assert.deepEqual(look("question"), ["round", 1, 0, "question"]);
  assert.deepEqual(look("error"), ["bar", 1, 0, "dot"]);
  assert.deepEqual(look("finished"), ["arc", 1, 0, "dot"]);
  assert.deepEqual(look("ratelimit"), ["half", 0.4, 3, "dot"]);
  // The colours the island has always given its states.
  assert.deepEqual(ROBOT_STATES.working.color, [0.231, 0.62, 1]);
  assert.deepEqual(ROBOT_STATES.thinking.color, [0.545, 0.361, 0.965]);
  assert.deepEqual(ROBOT_STATES.approval.color, [0.961, 0.647, 0.141]);
  assert.deepEqual(ROBOT_STATES.question.color, [0.133, 0.827, 0.933]);
  assert.deepEqual(ROBOT_STATES.error.color, [0.957, 0.314, 0.369]);
  assert.deepEqual(ROBOT_STATES.finished.color, [0.204, 0.831, 0.6]);
  assert.deepEqual(ROBOT_STATES.ratelimit.color, [0.984, 0.573, 0.235]);
  // A badge is in its state's colour.
  for (const s of Object.values(ROBOT_STATES)) {
    if (s.badge) assert.equal(s.badge.color, s.color);
  }
});

test("the eyes are the state's colour half way to white; at rest a soft white-cyan", () => {
  assert.equal(rgba(ROBOT_STATES.idle.eyeColor), "rgba(232,252,255,1)");
  for (const state of STATES.slice(1)) {
    const s = ROBOT_STATES[state];
    assert.ok(nearAll(s.eyeColor, mix(s.color, [1, 1, 1], 0.5)), state);
    assert.ok(s.eyeColor.every((v, i) => v >= s.color[i]), `${state}: lighter than the antenna`);
  }
});

test("the antenna is off at rest, dim when the limit is hit, the state's colour otherwise", () => {
  assert.deepEqual(antennaColor(ROBOT_STATES.idle), ANTENNA_OFF);
  assert.deepEqual(stillPose().glow, 0);
  for (const state of ["working", "thinking", "approval", "question", "error", "finished"]) {
    assert.ok(nearAll(antennaColor(ROBOT_STATES[state]), ROBOT_STATES[state].color), state);
    assert.equal(stillPose({ state }).glow, 1, state);
  }
  assert.equal(stillPose({ state: "ratelimit" }).glow, 0.4);
});

test("thinking looks up to one side, a question tilts the head and opens one eye wider", () => {
  const up = ROBOT_STATES.thinking.gaze;
  assert.ok(up[0] > 0 && up[1] < 0);
  const q = ROBOT_STATES.question;
  assert.ok(q.tilt > 0.05 && q.tilt < 0.2, "a few degrees");
  assert.ok(q.eyes.scale[1] > 1 && q.eyes.scale[0] < 1);
  for (const state of STATES.filter((s) => s !== "question")) {
    assert.equal(ROBOT_STATES[state].tilt, 0, state);
    assert.deepEqual(ROBOT_STATES[state].eyes.scale, [1, 1], state);
  }
  for (const state of STATES.filter((s) => s !== "thinking")) assert.equal(ROBOT_STATES[state].gaze, null, state);
});

// ── Colours ───────────────────────────────────────────────────────────────────

test("a colour is read from its hex", () => {
  assert.deepEqual(hexToRGB("#FF0080"), [1, 0, 128 / 255]);
  assert.deepEqual(hexToRGB("000000"), [0, 0, 0]);
});

test("the shell's tones come from its one colour, sinking into the visor's ink", () => {
  for (const base of [SHELL_ICE, SHELL_TEAL, hexToRGB("#3B9EFF"), hexToRGB("#F5A524")]) {
    const p = shellPalette(base);
    assert.equal(p.light, base, "the colour itself where the light falls");
    assert.ok(nearAll(p.mid, mix(base, VISOR_TOP, 0.18)));
    assert.ok(nearAll(p.shadow, mix(base, VISOR_TOP, 0.44)));
    assert.ok(nearAll(p.rim, mix(base, VISOR_TOP, 0.62)));
    const sum = (c) => c[0] + c[1] + c[2];
    assert.ok(sum(p.light) > sum(p.mid) && sum(p.mid) > sum(p.shadow) && sum(p.shadow) > sum(p.rim));
  }
  // The default: a near-white with a teal undertone, and its shadow a blue-grey.
  assert.equal(rgba(SHELL_ICE), "rgba(237,244,246,1)");
  assert.equal(rgba(shellPalette(SHELL_ICE).mid), "rgba(197,209,213,1)");
  assert.equal(rgba(shellPalette(SHELL_ICE).shadow), "rgba(139,159,166,1)");
  // The design's teal: its shadow lands by the design's own (#237B98).
  assert.equal(rgba(SHELL_TEAL), "rgba(46,207,212,1)");
  assert.equal(rgba(shellPalette(SHELL_TEAL).shadow), "rgba(32,138,147,1)");
});

test("the colour follower closes in on its target and never passes it", () => {
  const target = [0.231, 0.62, 1];
  let c = [0.902, 0.914, 0.933];
  let gap = Math.abs(c[0] - target[0]);
  for (let i = 0; i < 150; i++) {
    c = followColor(c, target, 0.01);
    const now = Math.abs(c[0] - target[0]);
    assert.ok(now < gap && c[0] >= target[0]);
    gap = now;
  }
  assert.ok(nearAll(c, target, 0.003), "there in a second and a half");
  assert.deepEqual(followColor(target, target, 0.016), target);
  assert.deepEqual(followColor(c, target, 0), c, "no time, no change");
});

// ── The fit ───────────────────────────────────────────────────────────────────

test("the head is 0.84 of the plain ball that stood in its slot before", () => {
  assert.ok(near(HEAD_FIT, 0.3696));
  // That ball's radius was 0.44 of its slot.
  for (const slot of SLOTS) assert.ok(near(headRadius(slot), slot * 0.44 * 0.84, 1e-9));
  assert.ok(near(headRadius(58), 21.437, 0.001));
  assert.ok(near(CANVAS_PER_SLOT, 1 / 0.6));
});

test("in the closed and the compact island the head and its antenna fit with room to spare", () => {
  const margins = (islandH, cy, slot) => {
    const size = slot * CANVAS_PER_SLOT;
    const place = placeInSlot(size, "head");
    const bounds = robotBounds(robotGeometry(place.R), "head");
    const headY = cy + (place.cy - size / 2);
    return { R: place.R, top: headY - bounds.top * place.R, bottom: islandH - (headY + bounds.bottom * place.R) };
  };
  // Closed: 24 px tall, the figure in the middle, in a slot of 18.
  const closed = margins(CLOSED_H, CLOSED_H / 2, CLOSED_BOT_D);
  assert.ok(near(closed.R, 6.653, 0.001));
  assert.ok(near(closed.top, 3.551, 0.01) && near(closed.bottom, 3.750, 0.01), JSON.stringify(closed));
  // Compact: 32 px tall, the figure at 16, in a slot of 20.
  const compact = botPosition("compact", "overview", NOTCH_H);
  const open = margins(NOTCH_H, compact.cy, compact.diameter);
  assert.ok(near(open.R, 7.392, 0.001));
  assert.ok(near(open.top, 6.612, 0.01) && near(open.bottom, 6.834, 0.01), JSON.stringify(open));
  for (const m of [closed, open]) assert.ok(m.top >= 2 && m.bottom >= 2);
  // Even at the top of the hop of a request the antenna stays inside the island.
  assert.ok(closed.top - 0.27 * closed.R > 1);
});

test("a still figure stands where the engine draws it", () => {
  for (const slot of SLOTS) {
    for (const model of ["head", "body"]) {
      const size = slot * CANVAS_PER_SLOT;
      const place = placeInSlot(size, model);
      const robot = new Robot();
      robot.setLimbs(model === "body");
      run(robot, 1);
      const ctx = recorder();
      robot.draw(ctx, size, size);
      const still = recorder();
      paintSlotRobot(still, size, { model });
      assert.ok(near(place.R, headRadius(slot)) && near(place.cx, size / 2));
      for (const side of ["left", "top", "right", "bottom"]) {
        assert.ok(near(ctx.box[side], still.box[side], 1e-6), `${model} ${slot} ${side}`);
      }
    }
  }
});

test("the head sits lower in its slot when it stands alone, and in the middle without an antenna", () => {
  const full = robotGeometry(headRadius(58));
  assert.ok(near(robotDrop(full, 0), 0.24) && near(robotDrop(full, 1), 0.09));
  assert.ok(near(robotDrop(full, 0.5), 0.165) && near(robotDrop(full, 1.2), 0.09), "between the two; an overshoot is not followed");
  assert.equal(robotDrop(robotGeometry(headRadius(13)), 0), 0);
});

test("a figure fitted in a box fills it, antenna to feet, and stays inside", () => {
  for (const model of ["head", "body"]) {
    for (const [w, h] of [[28, 28], [220, 220], [84, 84], [300, 120]]) {
      const place = placeInBox(w, h, model);
      const ctx = recorder();
      paintBoxRobot(ctx, w, h, { model, state: "working" });
      assert.ok(ctx.box.left >= 0 && ctx.box.top >= 0 && ctx.box.right <= w && ctx.box.bottom <= h, `${model} ${w}×${h}: ${JSON.stringify(ctx.box)}`);
      const fill = Math.max((ctx.box.right - ctx.box.left) / w, (ctx.box.bottom - ctx.box.top) / h);
      assert.ok(fill > 0.88 && fill <= 0.97, `${model} ${w}×${h} fills ${fill}`);
    }
  }
  // The sidebar's Liv: a head 18.6 px across in its 28 px canvas, where the plain ball was 14.8.
  assert.ok(near(placeInBox(28, 28, "head").R * 2, 18.6, 0.1));
});

test("the whole body is for the cards, the head alone for anything smaller", () => {
  for (const view of Object.values(VIEW_LAYOUTS)) {
    assert.equal(modelFor(view.botDiameter), view.botDiameter >= 44 ? "body" : "head", String(view.botDiameter));
  }
  for (const slot of [13, 18, 20, 24]) assert.equal(modelFor(slot), "head");
  for (const slot of [44, 58, 66]) assert.equal(modelFor(slot), "body");
});

// ── Levels of detail ──────────────────────────────────────────────────────────

test("tiny up to a slot of 14, small up to 24, full beyond", () => {
  const lod = (slot) => lodFor(headRadius(slot));
  assert.deepEqual([6, 13, 14].map(lod), ["tiny", "tiny", "tiny"]);
  assert.deepEqual([14.5, 18, 20, 24].map(lod), ["small", "small", "small", "small"]);
  assert.deepEqual([24.5, 44, 58, 66, 120, 400].map(lod), ["full", "full", "full", "full", "full", "full"]);
});

test("tiny has no antenna; small a short one with a bigger ball, bigger eyes and no fine detail; full has it all", () => {
  const tiny = robotGeometry(headRadius(13));
  assert.deepEqual([tiny.antenna, tiny.ballR, tiny.ballY, tiny.detail], [0, 0, -1, 0]);

  for (const slot of [18, 20, 24]) {
    const g = robotGeometry(headRadius(slot));
    assert.deepEqual([g.antenna, g.detail], [1, 0], String(slot));
    assert.deepEqual([g.ballR, g.ballY, g.lean, g.stemW], [0.2, -1.31, 0, 0.14]);
    assert.deepEqual([g.eyeR, g.eyeX], [0.25, 0.37]);
    assert.deepEqual([g.visorW, g.visorH, g.visorY], [1.44, 1.12, 0.06]);
  }
  for (const slot of [44, 58, 66, 120]) {
    const g = robotGeometry(headRadius(slot));
    assert.deepEqual([g.antenna, g.detail], [1, 1], String(slot));
    assert.ok(nearAll([g.ballR, g.ballY, g.lean, g.stemW], [0.13, -1.34, -0.03, 0.055]));
    assert.ok(nearAll([g.eyeR, g.eyeX], [0.2, 0.355]));
    assert.ok(nearAll([g.visorW, g.visorH, g.visorY], [1.54, 1.32, 0.03]));
  }
  // The antenna of the small robot is shorter, its ball bigger for its head.
  const small = robotGeometry(headRadius(20));
  const full = robotGeometry(headRadius(58));
  assert.ok(-small.ballY < -full.ballY && small.ballR > full.ballR && small.eyeR > full.eyeR);
});

test("between two levels the numbers slide: a figure growing never jumps", () => {
  let before = robotGeometry(headRadius(6));
  for (let slot = 6.05; slot <= 70; slot += 0.05) {
    const g = robotGeometry(headRadius(slot));
    for (const key of ["antenna", "detail", "ballR", "ballY", "lean", "stemW", "eyeR", "eyeX", "visorW", "visorH"]) {
      assert.ok(Math.abs(g[key] - before[key]) < 0.04, `${key} at ${slot}: ${before[key]} -> ${g[key]}`);
    }
    before = g;
  }
});

test("the visor stays well inside the shell, its ring thickest at the top", () => {
  for (const slot of [13, 20, 24, 44, 120]) {
    const g = robotGeometry(headRadius(slot));
    let reach = 0;
    for (let i = 0; i < 360; i++) reach = Math.max(reach, Math.hypot(...visorPoint(g, (i / 360) * Math.PI * 2)));
    assert.ok(reach < 0.86, `${slot}: the visor comes within ${1 - reach} R of the edge`);
    const [, top] = visorPoint(g, -Math.PI / 2);
    const [, bottom] = visorPoint(g, Math.PI / 2);
    const [right] = visorPoint(g, 0);
    assert.ok(near(right, g.visorW / 2) && near(bottom - top, g.visorH));
    assert.ok(1 + top > 1 - bottom && 1 + top > 1 - right, "more shell above the visor than below or beside it");
    assert.ok(g.visorW > g.visorH, "wider than tall");
    // The eyes are inside it, even the wide ones.
    assert.ok(g.eyeX + g.eyeR * EYE_SHAPES.wide.w < g.visorW / 2);
  }
});

test("a line is never thinner than a device pixel", () => {
  assert.equal(hairline(0.4, 1), 1);
  assert.equal(hairline(0.4, 0.5), 0.5);
  assert.equal(hairline(3, 1), 3);
  // The antenna's stem at the closed island's size is a sub-pixel line by its
  // proportions alone: it is drawn one device pixel wide at any pixel ratio.
  for (const dpr of [1, 1.25, 1.5, 2]) {
    for (const slot of [18, 24, 44]) {
      const ctx = recorder(dpr);
      const R = headRadius(slot);
      const g = robotGeometry(R);
      paintRobot(ctx, R, stillPose({ state: "finished" }));
      assert.ok(Math.max(g.stemW * R, 1 / dpr) * dpr >= 1 - 1e-9);
      // The happy eyes are strokes: never under a pixel either.
      assert.ok(ctx.lineWidths.length === 2 && ctx.lineWidths.every((w) => w >= 1 - 1e-9), `${slot} @${dpr}: ${ctx.lineWidths}`);
    }
  }
});

// ── The drawing ───────────────────────────────────────────────────────────────

test("tiny: a head, a visor and two dots, nothing else", () => {
  const ctx = recorder();
  const R = headRadius(13);
  paintRobot(ctx, R, stillPose());
  // The shell, the visor, and for each eye its halo and its dot.
  assert.equal(ctx.fills.length, 6);
  assert.deepEqual(ctx.ops.filter((o) => o[0] === "arc")[0], ["arc", 0, 0, R, 0, Math.PI * 2]);
  assert.equal(ctx.ops.filter((o) => o[0] === "ellipse").length, 2, "two eyes");
  assert.equal(ctx.strokes.length, 0);
  assert.ok(ctx.box.top >= -R - 1e-9 && ctx.box.bottom <= R + 1e-9, "nothing above the head: no antenna");
});

test("small: the antenna, and no highlight, rim or glass edge; full: all of them", () => {
  const small = recorder();
  paintRobot(small, headRadius(20), stillPose());
  const full = recorder();
  paintRobot(full, headRadius(58), stillPose());
  const count = (ctx, name) => ctx.ops.filter((o) => o[0] === name).length;
  // Small: shell, stem, ball, visor, two halos, two eyes.
  assert.equal(small.fills.length, 8);
  assert.equal(count(small, "clip"), 1, "only the eyes are clipped, to the visor");
  // Full adds the rim, the highlight, the nub, the glass's lip and the screen.
  assert.equal(full.fills.length, 13);
  assert.equal(count(full, "clip"), 3);
  assert.ok(colours(full).includes("rgba(255,255,255,0.8)"), "the highlight");
  assert.ok(!colours(small).some((c) => c.startsWith("rgba(255,255,255,0.8")));
  // Both reach above the head.
  const R = headRadius(20);
  assert.ok(near(small.box.top, -(1.31 + 0.2) * R, 1e-6));
});

test("the shell takes the colour it is given; the visor and the stem never do", () => {
  const paint = (shell) => {
    const ctx = recorder();
    paintRobot(ctx, headRadius(58), stillPose({ shell }));
    return colours(ctx);
  };
  const ice = paint(SHELL_ICE);
  const blue = paint(hexToRGB("#3B9EFF"));
  assert.ok(ice.includes("rgba(237,244,246,1)") && !blue.includes("rgba(237,244,246,1)"));
  assert.ok(blue.includes("rgba(59,158,255,1)"));
  for (const fixed of ["rgba(15,51,65,1)", "rgba(21,72,86,1)", "rgba(127,149,157,1)"]) {
    assert.ok(ice.includes(fixed) && blue.includes(fixed), fixed);
  }
  // The default shell is the ice.
  assert.deepEqual(paint(undefined), ice);
});

test("the body has two hands and two feet, apart from the head", () => {
  const head = recorder();
  const R = 100;
  paintRobot(head, R, stillPose());
  const body = recorder();
  paintRobot(body, R, stillPose({ model: "body" }));
  assert.equal(body.fills.length, head.fills.length + 4);
  const b = robotBounds(robotGeometry(R), "body");
  assert.ok(near(body.box.bottom, b.bottom * R, 0.03 * R) && near(-body.box.left, b.side * R, 0.03 * R));
  assert.ok(near(-body.box.left, body.box.right, 1e-6), "the same on both sides");
  // Detached: the hand's shoulder and the foot's top are off the head.
  assert.ok(Math.hypot(HAND.pivotX, HAND.pivotY) - HAND.topR > 1);
  assert.ok(Math.hypot(FOOT.x - FOOT.half * Math.cos(FOOT.angle), FOOT.y - FOOT.half * Math.sin(FOOT.angle)) > 1);
  assert.ok(Math.hypot(FOOT.x + FOOT.half * Math.cos(FOOT.angle), FOOT.y + FOOT.half * Math.sin(FOOT.angle)) > 1);
  assert.ok(near(b.top, 1.47) && robotBounds(robotGeometry(R), "head").bottom === 1);
});

test("the figure never leaves its canvas, whatever it is doing and whatever it wears", () => {
  for (const outfit of ["none", ...OUTFIT_IDS]) {
    for (const slot of [18, 20, 44, 58, 66]) {
      const size = slot * CANVAS_PER_SLOT;
      for (const state of STATES) {
        const robot = new Robot(seededRandom(slot));
        robot.alive = slot >= 44;
        robot.setLimbs(slot >= 44);
        robot.setOutfit(outfit, false);
        run(robot, 1);
        robot.setState(state);
        robot.lookAt([size, -size]);
        run(robot, 2.5, () => {
          const ctx = recorder();
          robot.draw(ctx, size, size);
          const { left, top, right, bottom } = ctx.box;
          assert.ok(
            left >= 0 && top >= 0 && right <= size && bottom <= size,
            `${state} in ${slot} wearing ${outfit}: ${JSON.stringify(ctx.box)} of ${size}`,
          );
        });
      }
    }
  }
});

// ── The eyes ──────────────────────────────────────────────────────────────────

test("the shapes an eye can take", () => {
  assert.deepEqual(Object.keys(EYE_SHAPES), ["round", "wide", "narrow", "bar", "arc", "half", "closed", "angry", "spiral", "heart"]);
  const of = (shape) => { const s = EYE_SHAPES[shape]; return [s.form, s.w, s.h, s.lid, s.blinks]; };
  assert.deepEqual(of("round"), ["ellipse", 1, 1, 0, true]);
  assert.deepEqual(of("wide"), ["ellipse", 1.2, 1.2, 0, true]);
  assert.deepEqual(of("narrow"), ["ellipse", 1, 0.8, 0, true]);
  assert.deepEqual(of("bar"), ["bar", 1.05, 0.3, 0, false]);
  assert.deepEqual(of("arc"), ["arc", 1, 0.62, 0, false]);
  assert.deepEqual(of("half"), ["ellipse", 1, 1, 0.5, true]);
  assert.deepEqual(of("closed"), ["bar", 1.05, 0.13, 0, false]);
});

test("a blink brings an open eye down to the closed bar's height", () => {
  assert.equal(eyeHalfHeight(EYE_SHAPES.round, 0), 1);
  assert.equal(eyeHalfHeight(EYE_SHAPES.round, 1), 0.13);
  assert.ok(near(eyeHalfHeight(EYE_SHAPES.wide, 0.5), (1.2 + 0.13) / 2));
  assert.equal(eyeHalfHeight(EYE_SHAPES.round, 7), 0.13, "no further than shut");
  // Eyes already shut or smiling do not blink.
  assert.equal(eyeHalfHeight(EYE_SHAPES.bar, 1), 0.3);
  assert.equal(eyeHalfHeight(EYE_SHAPES.arc, 1), 0.62);
});

test("one painter draws every shape", () => {
  const white = [1, 1, 1];
  const eye = (shape, blink = 0) => {
    const ctx = recorder();
    paintEye(ctx, 10, EYE_SHAPES[shape], blink, white, 1);
    return ctx;
  };
  // A round eye is a whole ellipse, a wide one a bigger one.
  assert.deepEqual(eye("round").ops, [["beginPath"], ["ellipse", 0, 0, 10, 10, 0, -Math.PI / 2, Math.PI * 1.5]]);
  assert.deepEqual(eye("wide").ops[1].slice(3, 5), [12, 12]);
  assert.deepEqual(eye("narrow").ops[1].slice(3, 5), [10, 8]);
  // Half-lidded: the lower half only, cut straight.
  assert.deepEqual(eye("half").ops[1], ["ellipse", 0, 0, 10, 10, 0, 0, Math.PI]);
  // Bars are bars with round ends.
  assert.deepEqual(eye("bar").ops[1], ["roundRect", -10.5, -3, 21, 6, 3]);
  assert.deepEqual(eye("closed").ops[1], ["roundRect", -10.5, -1.3, 21, 2.6, 1.3]);
  // The happy eye is a stroke that rises in the middle.
  const arc = eye("arc");
  assert.deepEqual([arc.fills.length, arc.strokes.length], [0, 1]);
  assert.ok(near(arc.lineWidths[0], 4.2) && arc.box.top < 0 && arc.box.bottom > 0);
  // A blink squeezes an open eye and leaves a bar alone.
  assert.deepEqual(eye("round", 1).ops[1].slice(3, 5), [10, 1.3]);
  assert.deepEqual(eye("bar", 1).ops, eye("bar").ops);
  // Never thinner than a pixel: a tiny eye, shut.
  const tiny = recorder();
  paintEye(tiny, 1.2, EYE_SHAPES.round, 1, white, 1);
  assert.equal(tiny.ops[1][4], 0.5);
});

test("one shape gives way to the next: the old shrinks and fades, the new grows in", () => {
  assert.deepEqual(eyeSwap(0), { old: true, scale: 1, alpha: 1 });
  const out = eyeSwap(0.2);
  assert.ok(out.old && out.scale < 1 && out.scale > 0.55 && near(out.alpha, 0.5));
  const turn = eyeSwap(0.4);
  assert.ok(!turn.old && near(turn.scale, 0.55) && near(turn.alpha, 0));
  const back = eyeSwap(0.7);
  assert.ok(!back.old && back.scale > 0.55 && back.scale < 1 && near(back.alpha, 0.5));
  assert.deepEqual(eyeSwap(1), { old: false, scale: 1, alpha: 1 });
  assert.ok(EYE_SWAP_MS >= 120 && EYE_SWAP_MS <= 180);
});

test("a new state swaps the eyes in 160 ms; the same eyes are left alone", () => {
  const robot = new Robot();
  const seen = [];
  const pose = () => {
    const ctx = recorder();
    robot.draw(ctx, 100, 100);
    return ctx.ops.filter((o) => o[0] === "ellipse" || o[0] === "roundRect").map((o) => o[0]);
  };
  robot.setState("error");
  assert.equal(robot.eyeT, 0);
  run(robot, 0.05, () => seen.push(pose()));
  assert.ok(seen.every((p) => p.includes("ellipse") && !p.includes("roundRect")), "the round eyes shrink first");
  run(robot, 0.11);
  assert.equal(robot.eyeT, 1);
  assert.ok(pose().filter((o) => o === "roundRect").length === 2, "then the bars are in");
  // Idle and thinking both have round eyes: nothing to swap.
  const calm = new Robot();
  calm.setState("thinking");
  assert.equal(calm.eyeT, 1);
  // A question keeps them round but not even: that is a swap.
  calm.setState("question");
  assert.equal(calm.eyeT, 0);
});

// ── The gaze ──────────────────────────────────────────────────────────────────

test("the eyes turn to a pointer that is near, and let go of one that is far", () => {
  assert.deepEqual(gazeFor(0, 0), [0, 0]);
  assert.ok(nearAll(gazeFor(90, 0), [1, 0]), "all the way over from 90 px");
  assert.ok(nearAll(gazeFor(45, 0), [0.5, 0]));
  assert.ok(nearAll(gazeFor(0, -200), [0, -1]));
  const diagonal = gazeFor(120, 120);
  assert.ok(near(Math.hypot(...diagonal), 1) && near(diagonal[0], diagonal[1]));
  // It fades from 260 px and is gone at 420.
  assert.ok(nearAll(gazeFor(260, 0), [1, 0]));
  assert.ok(nearAll(gazeFor(340, 0), [0.5, 0]));
  assert.deepEqual(gazeFor(420, 0), [0, 0]);
  assert.deepEqual(gazeFor(-10_000, -10_000), [0, 0]);
  assert.deepEqual(gazeFor(NaN, 3), [0, 0]);
  // The eyes move inside the visor, and the visor a little with them.
  assert.deepEqual([...GAZE_EYES, GAZE_VISOR], [0.14, 0.1, 0.05]);
});

test("the gaze follows smoothly and comes back to the middle", () => {
  const robot = new Robot();
  robot.lookAt([200, 0]);
  assert.equal(robot.changing, true);
  let before = 0;
  run(robot, 1.5, (r) => {
    assert.ok(r.gaze[0] >= before && r.gaze[0] <= 1, "towards it, never past it");
    before = r.gaze[0];
  });
  assert.ok(near(robot.gaze[0], 1, 0.004) && robot.gaze[1] === 0);
  assert.equal(robot.changing, false, "there: at rest again");
  robot.lookAt([-5000, 300]);
  assert.equal(robot.changing, true);
  run(robot, 1.5);
  assert.ok(near(robot.gaze[0], 0, 0.004));
  assert.equal(robot.changing, false);
  robot.lookAt([40, 40]);
  robot.lookAt(null);
  assert.equal(robot.changing, false, "nobody knows where the pointer is: straight ahead");
});

test("thinking looks at its own spot, whatever the pointer does", () => {
  const robot = new Robot();
  robot.setState("thinking");
  robot.lookAt([-200, 100]);
  run(robot, 2);
  assert.ok(nearAll(robot.gaze, ROBOT_STATES.thinking.gaze, 0.004));
  robot.setState("idle");
  run(robot, 2);
  assert.ok(robot.gaze[0] < -0.8, "back on the pointer");
});

// ── At rest, and changing ─────────────────────────────────────────────────────

test("a resting robot is not changing", () => {
  const robot = new Robot();
  assert.equal(robot.changing, false);
  run(robot, 8, (r) => assert.equal(r.changing, false, "idle, eyes open, pointer far: nothing, not even a blink"));
  assert.deepEqual([robot.ox, robot.oy, robot.squash, robot.tilt, robot.badgeS, robot.blink, robot.glance], [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([robot.hands, robot.feet, robot.lift, robot.lit, robot.flash, robot.glow, robot.breath], [0, 0, 0, 1, 0, 0, 0]);
  robot.setState("idle");
  robot.setLimbs(false);
  robot.setUpdateHint(null);
  assert.equal(robot.changing, false, "the same again starts nothing");
});

test("a tween is a change, and the robot comes back to rest", () => {
  const robot = new Robot();
  robot.setState("approval");
  assert.equal(robot.changing, true);
  let top = 0;
  run(robot, 0.45, (r) => (top = Math.min(top, r.oy)));
  assert.ok(near(top, -0.27, 0.01), `hops 0.27 R, the tenth of its slot it always hopped (${top})`);
  assert.equal(robot.oy, 0, "and lands in 150 + 300 ms");
  run(robot, 3);
  assert.equal(robot.changing, false);
  assert.deepEqual([robot.ox, robot.oy, robot.squash, robot.badgeS, robot.lit], [0, 0, 0, 1, 1]);
  assert.equal(robot.badge.kind, "bang");
});

test("the lights follow the state's colours, and the robot is changing until they are there", () => {
  const robot = new Robot();
  robot.setState("working");
  assert.notDeepEqual(robot.ledCol, ROBOT_STATES.working.color, "they follow, they do not jump");
  run(robot, 0.5);
  assert.equal(robot.changing, true);
  run(robot, 1.5);
  assert.equal(robot.changing, false);
  assert.ok(nearAll(robot.ledCol, ROBOT_STATES.working.color, 0.003));
  assert.ok(nearAll(robot.eyeCol, ROBOT_STATES.working.eyeColor, 0.003));
  assert.ok(nearAll(robot.haloCol, ROBOT_STATES.working.color, 0.003));
  assert.ok(near(robot.glow, 1, 0.003));
  // Back to rest: the antenna goes out.
  robot.setState("idle");
  run(robot, 2);
  assert.ok(nearAll(robot.ledCol, ANTENNA_OFF, 0.003) && near(robot.glow, 0, 0.003));
  assert.equal(robot.changing, false);
});

test("the shell never takes the state's colour, only a pill's", () => {
  const shell = (robot) => {
    const ctx = recorder();
    robot.draw(ctx, 100, 100);
    return ctx.fills[0].stops[0][1];
  };
  const robot = new Robot();
  for (const state of STATES) {
    robot.setState(state);
    run(robot, 2);
    assert.equal(shell(robot), "rgba(237,244,246,1)", state);
  }
  robot.bodyColor = hexToRGB("#3B9EFF");
  assert.equal(shell(robot), "rgba(59,158,255,1)");
  robot.bodyColor = null;
  robot.shell = SHELL_TEAL;
  assert.equal(shell(robot), "rgba(46,207,212,1)");
});

test("the working states move nothing: only the lights, the eyes and the badge change", () => {
  for (const state of ["working", "thinking", "ratelimit"]) {
    const robot = new Robot();
    robot.setState(state);
    run(robot, 2.5, (r) => assert.deepEqual([r.ox, r.oy, r.squash, r.tilt], [0, 0, 0, 0], state));
    assert.equal(robot.changing, false, `${state}: at rest once the lights, the eyes and the badge are in`);
  }
});

test("a question tilts the head in 220 ms, and leaving it straightens it", () => {
  const robot = new Robot();
  robot.setState("question");
  run(robot, 0.22);
  assert.equal(robot.tilt, 0.1);
  run(robot, 2);
  assert.equal(robot.changing, false);
  robot.setState("working");
  run(robot, 0.22);
  assert.equal(robot.tilt, 0);
});

test("an error shakes sideways, 0.11 R, and stops in 280 ms", () => {
  const robot = new Robot();
  robot.setState("error");
  let left = 0;
  let right = 0;
  run(robot, 0.28, (r) => {
    left = Math.min(left, r.ox);
    right = Math.max(right, r.ox);
    assert.deepEqual([r.oy, r.squash], [0, 0]);
  });
  assert.ok(near(right, 0.11, 0.005) && near(left, -0.11, 0.005), `${left} … ${right}`);
  assert.equal(robot.ox, 0);
});

test("a request hops, and the antenna blinks three times before it stays lit", () => {
  const robot = new Robot();
  robot.setState("approval");
  let dips = 0;
  let wasLow = false;
  run(robot, 0.54, (r) => {
    const low = r.lit < 0.3;
    if (low && !wasLow) dips++;
    wasLow = low;
  });
  assert.equal(dips, 3);
  assert.equal(robot.lit, 1);
  run(robot, 3, (r) => assert.equal(r.lit, 1, "steady from then on"));
});

test("finished: it gathers itself, hops stretched, lands squashed, and its hands go up", () => {
  const robot = new Robot();
  robot.setLimbs(true);
  run(robot, 1);
  robot.setState("finished");
  const at = {};
  let top = 0;
  let lifted = 0;
  let flashed = 0;
  run(robot, 0.75, (r, ms) => {
    at[ms] = [r.oy, r.squash];
    top = Math.min(top, r.oy);
    lifted = Math.max(lifted, r.lift);
    flashed = Math.max(flashed, r.flash);
    assert.equal(r.ox, 0);
  });
  // Anticipation: down before up, still on the ground.
  assert.ok(near(at[90][0], 0) && near(at[90][1], -0.09), `90 ms: ${at[90]}`);
  // In the air it is stretched.
  assert.ok(at[200][0] < -0.15 && at[200][1] > 0.05, `200 ms: ${at[200]}`);
  assert.ok(near(top, -0.26, 0.005));
  // Back on the ground at 410 ms, squashed just after.
  assert.ok(near(at[410][0], 0) && at[480][1] < -0.06, `landing: ${at[410]} ${at[480]}`);
  assert.deepEqual(at[750], [0, 0]);
  run(robot, 0.02);
  assert.ok(lifted >= 1, "the hands go all the way up");
  assert.ok(near(flashed, 1, 0.01), "the antenna flashes");
  run(robot, 3, (r) => assert.deepEqual([r.oy, r.squash, r.lift, r.flash], [0, 0, 0, 0], "once"));
  assert.equal(robot.changing, false);
  robot.setState("finished");
  run(robot, 0.2);
  assert.equal(robot.oy, 0, "still finished: nothing starts again");
});

// ── The pulse (the drop sequence's) ───────────────────────────────────────────

test("the pulse: up to 1.12 in 140 ms, back in 260 ms, 1 outside it", () => {
  assert.equal(pulseScale(-50), 1);
  assert.equal(pulseScale(0), 1);
  assert.ok(pulseScale(70) > 1.08 && pulseScale(70) < 1.12, "eased out: most of the way by half time");
  assert.ok(near(pulseScale(140), 1.12));
  assert.ok(pulseScale(270) < 1.03);
  assert.equal(pulseScale(400), 1);
  assert.equal(pulseScale(5000), 1);
});

// ── Hands and feet ────────────────────────────────────────────────────────────

test("hands and feet pop out when the island opens, and tuck away faster", () => {
  const robot = new Robot();
  robot.setLimbs(true);
  assert.equal(robot.changing, true);
  let feetOver = 0;
  let handsOver = 0;
  const at = {};
  run(robot, 0.33, (r, ms) => {
    at[ms] = [r.feet, r.hands];
    feetOver = Math.max(feetOver, r.feet);
    handsOver = Math.max(handsOver, r.hands);
  });
  assert.ok(near(at[70][1], 0), "the hands wait 70 ms");
  assert.ok(at[70][0] > 0.2, "the feet are already on their way");
  assert.equal(at[260][0], 1, "the feet are out in 260 ms");
  assert.equal(at[330][1], 1, "the hands 70 ms later");
  assert.ok(feetOver > 1.02 && handsOver > 1.02, "they pop: past their size and back");
  run(robot, 1);
  assert.equal(robot.changing, false);

  robot.setLimbs(false);
  run(robot, 0.16);
  assert.deepEqual([robot.feet, robot.hands], [0, 0], "tucked away in 160 ms");
  assert.equal(robot.changing, false);
});

// ── Life ──────────────────────────────────────────────────────────────────────

test("the next sign of life comes in 2.4 to 6 s: mostly a blink", () => {
  const fixed = (...values) => () => values.shift();
  assert.deepEqual(nextLife(fixed(0, 0.5)), { inMs: LIFE_MIN_MS, kind: "blink" });
  assert.deepEqual(nextLife(fixed(1, 0.99)), { inMs: LIFE_MAX_MS, kind: "blink" });
  assert.deepEqual(nextLife(fixed(0.5, 0)), { inMs: 4200, kind: "doubleBlink" });
  assert.equal(nextLife(fixed(0.5, 0.139)).kind, "doubleBlink");
  assert.equal(nextLife(fixed(0.5, 0.14)).kind, "glanceLeft");
  assert.equal(nextLife(fixed(0.5, 0.23)).kind, "glanceLeft");
  assert.equal(nextLife(fixed(0.5, 0.25)).kind, "glanceRight");
  assert.equal(nextLife(fixed(0.5, 0.33)).kind, "glanceRight");
  assert.equal(nextLife(fixed(0.5, 0.35)).kind, "blink");
  assert.deepEqual([LIFE_MIN_MS, LIFE_MAX_MS], [2400, 6000]);

  const random = seededRandom(7);
  const kinds = { blink: 0, doubleBlink: 0, glanceLeft: 0, glanceRight: 0 };
  for (let i = 0; i < 2000; i++) {
    const event = nextLife(random);
    assert.ok(event.inMs >= LIFE_MIN_MS && event.inMs < LIFE_MAX_MS);
    kinds[event.kind]++;
  }
  assert.ok(kinds.blink > 1200 && kinds.doubleBlink > 200 && kinds.glanceLeft > 130 && kinds.glanceRight > 130, JSON.stringify(kinds));
});

test("a seed gives the same life twice", () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const other = seededRandom(43);
  const run1 = Array.from({ length: 20 }, () => nextLife(a));
  const run2 = Array.from({ length: 20 }, () => nextLife(b));
  assert.deepEqual(run1, run2);
  assert.notDeepEqual(run1, Array.from({ length: 20 }, () => nextLife(other)));
  const draws = Array.from({ length: 1000 }, seededRandom(1));
  assert.ok(draws.every((v) => v >= 0 && v < 1));
});

test("a blink: shut in 70 ms, open again in 110; twice for a double", () => {
  const robot = new Robot();
  robot.act("blink");
  assert.equal(robot.changing, true);
  run(robot, 0.07);
  assert.equal(robot.blink, 1);
  run(robot, 0.11);
  assert.equal(robot.blink, 0);
  assert.equal(robot.changing, false, "and at rest again: the loop can stop");

  robot.act("doubleBlink");
  let shut = 0;
  let wasShut = false;
  run(robot, 0.45, (r) => {
    const now = r.blink > 0.95;
    if (now && !wasShut) shut++;
    wasShut = now;
  });
  assert.equal(shut, 2);
  assert.deepEqual([robot.blink, robot.changing], [0, false]);

  // Eyes that are bars or arcs have nothing to blink: no tween, no frame.
  for (const state of ["error", "finished"]) {
    const shut = new Robot();
    shut.setState(state);
    run(shut, 3);
    shut.act("blink");
    shut.act("doubleBlink");
    assert.equal(shut.changing, false, state);
  }
});

test("a glance: the eyes go to one side, stay a moment and come back in a second", () => {
  for (const [kind, side] of [["glanceLeft", -1], ["glanceRight", 1]]) {
    const robot = new Robot();
    robot.act(kind);
    run(robot, 0.5);
    assert.equal(robot.glance, side * 0.9);
    run(robot, 0.5);
    assert.deepEqual([robot.glance, robot.changing], [0, false]);
  }
});

test("alive, it breathes and blinks on its own; not alive, it does neither", () => {
  const robot = new Robot(() => 0.5);
  robot.alive = true;
  assert.equal(robot.changing, true, "breathing is a change: the loop goes on");
  const blinks = [];
  let wasShut = false;
  const stretches = [];
  run(robot, 13, (r, ms) => {
    const shut = r.blink > 0.95;
    if (shut && !wasShut) blinks.push(ms);
    wasShut = shut;
    assert.equal(r.changing, true);
    if (ms > 2000) {
      const ctx = recorder();
      r.draw(ctx, 100, 100);
      stretches.push(ctx.box.bottom - ctx.box.top);
    }
  });
  // With every draw at 0.5: a blink every 4.2 s, all but shut 40 ms into it.
  assert.deepEqual(blinks, [4240, 8440, 12640]);
  assert.ok(near(robot.breath, 1, 0.003));
  const swell = (Math.max(...stretches) - Math.min(...stretches)) / Math.max(...stretches);
  assert.ok(swell > 0.01 && swell < 0.06, `it swells and floats a little (${swell})`);

  // The island folds: the breath dies down and the robot comes to rest.
  robot.alive = false;
  assert.equal(robot.changing, true, "not at once");
  run(robot, 1.5);
  assert.equal(robot.changing, false);
  assert.ok(robot.breath < 0.003);
  run(robot, 12, (r) => assert.deepEqual([r.blink, r.changing], [0, false], "no clock of its own"));
});

test("the antenna's halo breathes only while alive: it never asks for a frame", () => {
  const glowOf = (robot) => {
    const ctx = recorder();
    robot.draw(ctx, 100, 100);
    // The antenna's halo: the one light in the antenna's colour, fading to nothing.
    const halo = ctx.fills.find((f) => f.kind === "radial" && f.stops[0][1].startsWith("rgba(59,158,255,0."));
    return Math.round(Number(halo.stops[0][1].match(/,([\d.]+)\)$/)[1]) * 100) / 100;
  };
  const still = new Robot();
  still.setState("working");
  run(still, 3);
  assert.equal(still.changing, false);
  const steady = new Set();
  run(still, 1.4, (r) => steady.add(glowOf(r)));
  assert.equal(steady.size, 1, "compact or closed: a steady light");

  const live = new Robot(() => 0.99);
  live.alive = true;
  live.setState("working");
  run(live, 3);
  const levels = [];
  run(live, 1.4, (r) => levels.push(glowOf(r)));
  assert.ok(Math.max(...levels) - Math.min(...levels) > 0.2, "open: it swells and fades every 1.4 s");
});

test("the antenna trails the body and catches up", () => {
  const robot = new Robot();
  robot.setState("error");
  const tips = [];
  run(robot, 1.2, (r) => {
    const ctx = recorder();
    r.draw(ctx, 100, 100);
    // The ball is the last arc drawn above the head.
    const ball = ctx.ops.filter((o) => o[0] === "arc").at(-3);
    tips.push(ball[1] / headRadius(60));
  });
  const lean = robotGeometry(headRadius(60)).lean;
  assert.ok(Math.max(...tips) - lean > 0.03 && lean - Math.min(...tips) > 0.03, "it sways both ways while the head shakes");
  run(robot, 2.5);
  assert.equal(robot.changing, false, "and settles");
});

// ── The badge ─────────────────────────────────────────────────────────────────

test("a badge goes in 90 ms and the next one pops in 10 ms later, over 280 ms", () => {
  const robot = new Robot();
  robot.setState("working");
  run(robot, 0.09);
  assert.equal(robot.badge, null, "nothing to show yet");
  run(robot, 0.02);
  assert.equal(robot.badge.kind, "dots");
  let over = 0;
  run(robot, 0.28, (r) => (over = Math.max(over, r.badgeS)));
  assert.ok(over > 1, "pops past its size");
  assert.equal(robot.badgeS, 1);

  robot.setState("approval");
  run(robot, 0.09);
  assert.equal(robot.badge.kind, "dots", "the old one shrinks first");
  assert.ok(robot.badgeS < 0.01);
  run(robot, 0.02);
  assert.equal(robot.badge.kind, "bang");

  robot.setState("idle");
  run(robot, 0.5);
  assert.equal(robot.badge, null);
  assert.equal(robot.badgeS, 0);
});

test("a state that keeps the same badge leaves it alone", () => {
  const robot = new Robot();
  robot.setState("error");
  run(robot, 2);
  assert.equal(robot.badgeS, 1);
  robot.setState("error", true);
  run(robot, 0.05);
  assert.equal(robot.badgeS, 1);
});

test("the update hint is an arrow badge in the hint's colour", () => {
  const blue = [0.231, 0.51, 0.965];
  const robot = new Robot();
  robot.setUpdateHint(blue);
  run(robot, 0.5);
  assert.deepEqual(robot.badge, { kind: "arrow", color: blue });
  robot.setState("working");
  run(robot, 0.5);
  assert.equal(robot.badge.kind, "dots");
});

test("the badge sits by the upper right of the head, clear of the antenna", () => {
  const robot = new Robot();
  robot.setState("approval");
  run(robot, 2);
  const size = 58 * CANVAS_PER_SLOT;
  const ctx = recorder();
  robot.draw(ctx, size, size);
  // Its sizes are in half-slots, as they always were: its ring, 0.3 of one,
  // is centred 0.85 to the right of the head's centre.
  const U = 29;
  assert.ok(near(ctx.box.right, size / 2 + U * (0.85 + 0.3), 1e-6));
  assert.ok(ctx.box.right <= size, "inside the canvas");
  assert.ok(colours(ctx).includes("rgba(245,165,36,1)"));
  // The widest badge, the working dots, is 0.72 of a half-slot across: its
  // left end is clear of the antenna's ball and of its halo at every size.
  for (const slot of SLOTS.filter((s) => s > 14)) {
    const R = headRadius(slot);
    const g = robotGeometry(R);
    assert.ok((0.85 - 0.36) * (slot / 2) > (Math.abs(g.lean) + g.ballR * antennaHalo(1)) * R, String(slot));
  }
});

// ── Moods: annoyed, dizzy, in love ────────────────────────────────────────────

/**
 * The eyes as drawn in a canvas of 100 (a head at full detail, its state
 * without the working dots): how many are bars, how many ellipses (the
 * antenna's nub, the one other ellipse, is left out), and how many strokes
 * there are (arcs or spirals); hearts are fills, found by their colour.
 */
function eyesDrawn(robot) {
  const ctx = recorder();
  robot.draw(ctx, 100, 100);
  return {
    bars: ctx.ops.filter((o) => o[0] === "roundRect").length,
    round: ctx.ops.filter((o) => o[0] === "ellipse").length - 1,
    strokes: ctx.strokes.length,
    colours: colours(ctx),
    ctx,
  };
}

/** A robot with its whole body, at rest. */
function whole(random) {
  const robot = new Robot(random);
  robot.setLimbs(true);
  run(robot, 1);
  return robot;
}

test("the eyes of its moods: slanted bars, spirals and hearts, none of which blinks", () => {
  const of = (shape) => { const s = EYE_SHAPES[shape]; return [s.form, s.w, s.h, s.lid, s.blinks, s.slant]; };
  assert.deepEqual(of("angry"), ["bar", 1.05, 0.26, 0, false, 0.42]);
  assert.deepEqual(of("spiral"), ["spiral", 1.1, 1.1, 0, false, 0]);
  assert.deepEqual(of("heart"), ["heart", 1.2, 1.1, 0, false, 0]);
  assert.deepEqual(SPIRAL, { turns: 1.75, stroke: 0.27 });
  // No other eye is slanted, and the states' eyes are the ones they were.
  for (const shape of ["round", "wide", "narrow", "bar", "arc", "half", "closed"]) assert.equal(EYE_SHAPES[shape].slant, 0, shape);
  // The love is a warm pink: red first, then blue, then green; the eyes a lighter one.
  assert.equal(rgba(LOVE), "rgba(255,107,157,1)");
  assert.ok(nearAll(LOVE_EYES, mix(LOVE, [1, 1, 1], 0.3)));
  assert.ok(LOVE[0] > LOVE[2] && LOVE[2] > LOVE[1]);
});

test("the painter draws the new shapes: a bar, a stroked spiral that stays in its eye, a filled heart", () => {
  const white = [1, 1, 1];
  const eye = (shape) => {
    const ctx = recorder();
    paintEye(ctx, 10, EYE_SHAPES[shape], 0.7, white, 1);
    return ctx;
  };
  // An angry eye is a bar; its slant is the face's (below).
  assert.deepEqual(eye("angry").ops[1], ["roundRect", -10.5, -2.6, 21, 5.2, 2.6]);
  // The spiral: one stroke 2.7 wide, winding out to the eye's edge and no further.
  const spiral = eye("spiral");
  assert.deepEqual([spiral.fills.length, spiral.strokes.length], [0, 1]);
  assert.ok(near(spiral.lineWidths[0], 2.7));
  const reach = Math.max(-spiral.box.left, spiral.box.right, -spiral.box.top, spiral.box.bottom);
  assert.ok(reach + 1.35 <= 11 + 1e-9 && reach > 8, `it reaches ${reach} of 11`);
  // The heart: one fill, as wide as its eye, its point at the bottom.
  const heart = eye("heart");
  assert.deepEqual([heart.fills.length, heart.strokes.length], [1, 0]);
  assert.ok(near(heart.box.left, -12) && near(heart.box.right, 12) && near(heart.box.bottom, 11));
  // Shut or not, none of them changes: they do not blink.
  for (const shape of ["angry", "spiral", "heart"]) {
    const open = recorder();
    paintEye(open, 10, EYE_SHAPES[shape], 0, white, 1);
    assert.deepEqual(eye(shape).box, open.box, shape);
  }
});

test("the angry bars slant inward, one the mirror of the other, and stay behind the glass", () => {
  const R = 100;
  const boxes = [];
  const ctx = recorder();
  const real = ctx.roundRect;
  // Each bar's own corners, as the transforms of that moment put them on the canvas.
  ctx.roundRect = (x, y, w, h, r) => {
    const m = ctx.getTransform();
    const at = (px, py) => [m.a * px + m.c * py + m.e, m.b * px + m.d * py + m.f];
    boxes.push({ inner: null, left: at(x, y + h / 2), right: at(x + w, y + h / 2) });
    real(x, y, w, h, r);
  };
  paintRobot(ctx, R, stillPose({ eyes: "angry" }));
  assert.equal(boxes.length, 2);
  // Each bar's end towards the middle of the face is the lower one.
  const ends = boxes.map((b) => [b.left, b.right].sort((p, q) => Math.abs(p[0]) - Math.abs(q[0])));
  for (const [inner, outer] of ends) assert.ok(inner[1] > outer[1] + 5, `inner end ${inner} below outer end ${outer}`);
  assert.ok(near(ends[0][0][0], -ends[1][0][0], 1e-6) && near(ends[0][0][1], ends[1][0][1], 1e-6), "mirrored");
  // The slant is 0.42 rad.
  const [inner, outer] = ends[0];
  assert.ok(near(Math.atan2(inner[1] - outer[1], Math.abs(inner[0] - outer[0])), 0.42, 1e-6));
});

test("the head is hit a little beyond its edge, where it stands in its slot", () => {
  const slot = 58;
  const R = headRadius(slot);
  // With its limbs out the head's centre is 0.09 R below the middle of the slot; alone, 0.24 R.
  assert.equal(onHead(0, 0.09 * R, slot, 1), true);
  assert.equal(onHead(R, 0.09 * R, slot, 1), true);
  assert.equal(onHead(R * 1.04, 0.09 * R, slot, 1), true, "a little beyond the edge");
  assert.equal(onHead(R * 1.06, 0.09 * R, slot, 1), false);
  assert.equal(onHead(0, 0.09 * R - R * 1.04, slot, 1), true);
  assert.equal(onHead(0, 0.09 * R - R * 1.06, slot, 1), false, "the antenna is not the head");
  assert.equal(onHead(0, 0.09 * R + R * 1.06, slot, 1), false, "nor are the feet");
  assert.equal(onHead(-R * 0.75, 0.09 * R - R * 0.75, slot, 1), false, "the corner of its square is off it");
  assert.equal(onHead(0, 0.24 * R + R * 1.04, slot, 0), true, "alone it sits lower");
  assert.equal(onHead(0, 0.24 * R + R * 1.04, slot, 1), false);
  // A pointer far away, or one nobody knows, is on nothing.
  assert.equal(onHead(-10_000, -10_000, slot, 1), false);
  assert.equal(onHead(NaN, 0, slot, 1), false);
  assert.equal(onHead(0, 0, 0, 1), false);
});

test("clicks add up: the third within 1.7 s makes Liv dizzy, and the count starts over", () => {
  assert.deepEqual(POKE, { dizzyAt: 3, withinMs: 1700, annoyedMs: 1200, dizzyMs: 3300 });
  assert.deepEqual(countPoke([], 100), { times: [100], dizzy: false });
  assert.deepEqual(countPoke([100], 900), { times: [100, 900], dizzy: false });
  assert.deepEqual(countPoke([100, 900], 1799), { times: [], dizzy: true });
  // 1.7 s after the first, the first no longer counts.
  assert.deepEqual(countPoke([100, 900], 1800), { times: [900, 1800], dizzy: false });
  assert.deepEqual(countPoke([100, 900], 9000), { times: [9000], dizzy: false });
});

test("a click annoys it: it flinches, frowns for 1.2 s and is itself again, at rest", () => {
  const robot = whole();
  robot.setState("approval");
  run(robot, 3);
  assert.equal(robot.changing, false);
  robot.poke(1);
  assert.equal(robot.changing, true);
  const at = {};
  let low = 0;
  let recoil = 0;
  run(robot, 0.18, (r, ms) => {
    at[ms] = [r.squash, r.ox, r.lift];
    low = Math.min(low, r.squash);
    recoil = Math.min(recoil, r.ox);
  });
  assert.ok(near(at[60][0], -0.13), `squashed in 60 ms (${at[60]})`);
  assert.ok(near(low, -0.13) && at[130][0] > 0.03, "and back up, a little past its height");
  assert.equal(robot.squash, 0, "at rest in 180 ms");
  assert.ok(near(recoil, -0.06), "it recoils from the finger");
  assert.ok(near(robot.lift, -0.12), "hands pulled in to its sides");
  // The eyes are two bars now, in the state's colours: nothing of the state changed.
  const frown = eyesDrawn(robot);
  assert.equal(frown.bars, 2);
  assert.equal(robot.state, "approval");
  assert.equal(robot.badge.kind, "bang");
  assert.ok(nearAll(robot.ledCol, ROBOT_STATES.approval.color, 0.003) && nearAll(robot.eyeCol, ROBOT_STATES.approval.eyeColor, 0.003));

  run(robot, 1.0);
  assert.equal(eyesDrawn(robot).bars, 2, "still frowning 1.18 s in");
  run(robot, 0.03 + 0.16);
  const after = eyesDrawn(robot);
  assert.deepEqual([after.bars, after.round], [0, 2], "1.2 s: the state's wide eyes are back, 160 ms later");
  run(robot, 1);
  assert.deepEqual([robot.squash, robot.ox, robot.lift, robot.wobble], [0, 0, 0, 0]);
  assert.equal(robot.changing, false, "and the frame loop can stop");
});

test("the click whips the antenna on its spring: its tip lags the recoil, then swings back past the middle", () => {
  for (const side of [-1, 1]) {
    const robot = whole();
    robot.poke(side);
    const tips = [];
    run(robot, 0.6, (r) => {
      const ctx = recorder();
      r.draw(ctx, 100, 100);
      // The ball is the last arc drawn above the head: after it, only the two eyes' halos.
      tips.push(ctx.ops.filter((o) => o[0] === "arc").at(-3)[1] / headRadius(60));
    });
    const lean = robotGeometry(headRadius(60)).lean;
    // Towards the side the click came from is ahead: the body recoils the other way.
    const swing = tips.map((x) => (x - lean) * side);
    assert.ok(Math.max(...swing) > 0.12, `${side}: it whips ${Math.max(...swing)} R`);
    assert.ok(Math.min(...swing) < -0.02, "and comes back past the middle");
    assert.ok(Math.max(...swing) <= 0.3 + 1e-9);
    run(robot, 2);
    assert.equal(robot.changing, false);
  }
});

test("three clicks in a row make it dizzy for 3.3 s: spirals that turn, a head that wobbles less and less, three stars", () => {
  const robot = whole();
  robot.poke();
  run(robot, 0.5);
  robot.poke();
  run(robot, 0.5);
  assert.equal(eyesDrawn(robot).bars, 2, "two clicks: only annoyed");
  robot.poke();

  const swings = [];
  let before = 0;
  let rising = true;
  let stars = 0;
  const turns = [];
  run(robot, 3.2, (r, ms) => {
    // Each extreme of the wobble.
    if (rising ? r.wobble < before : r.wobble > before) {
      swings.push(before);
      rising = !rising;
    }
    before = r.wobble;
    if (ms === 1000) {
      const drawn = eyesDrawn(r);
      stars = drawn.colours.filter((c) => c === rgba(STAR)).length;
      // Two spirals, stroked; no bars, no ellipses for eyes.
      assert.deepEqual([drawn.strokes, drawn.bars, drawn.round], [2, 0, 0]);
    }
    if (ms === 1000 || ms === 1010) {
      const ctx = recorder();
      const turn = [];
      const real = ctx.stroke;
      ctx.stroke = () => (turn.push(Math.atan2(ctx.getTransform().b, ctx.getTransform().a)), real());
      r.draw(ctx, 100, 100);
      turns.push(turn);
    }
  });
  assert.equal(stars, 3);
  assert.ok(swings.length >= 6, `it sways from side to side (${swings})`);
  assert.ok(near(swings[0], 0.2) && swings[1] < 0 && swings[2] > 0);
  for (let i = 1; i < swings.length; i++) assert.ok(Math.abs(swings[i]) < Math.abs(swings[i - 1]) + 1e-9, "each swing shorter than the last");
  // The spirals turn 7 rad a second, one the mirror of the other: in 10 ms
  // each has turned 0.07 against the head, in opposite directions.
  const turned = (i) => Math.atan2(Math.sin(turns[1][i] - turns[0][i]), Math.cos(turns[1][i] - turns[0][i]));
  assert.ok(near(Math.abs(turned(0) - turned(1)), 0.14, 1e-6), `${turned(0)} ${turned(1)}`);

  assert.equal(eyesDrawn(robot).strokes, 2, "3.2 s in: still dizzy");
  run(robot, 0.1 + 0.16);
  const after = eyesDrawn(robot);
  assert.deepEqual([after.strokes, after.round], [0, 2], "3.3 s: its own eyes again");
  assert.ok(!after.colours.includes(rgba(STAR)), "and the stars are gone");
  run(robot, 1);
  assert.deepEqual([robot.wobble, robot.ox], [0, 0]);
  assert.equal(robot.changing, false);
});

test("while it is dizzy it does not feel another click; afterwards the count starts over", () => {
  const robot = whole();
  for (let i = 0; i < 3; i++) robot.poke();
  run(robot, 1);
  for (let i = 0; i < 5; i++) {
    robot.poke();
    run(robot, 0.2);
    assert.equal(eyesDrawn(robot).strokes, 2, "still the spirals");
  }
  // 3.3 s from the third click, not from any of the later ones.
  run(robot, 1.3 + 0.2);
  assert.equal(eyesDrawn(robot).strokes, 0);
  run(robot, 1);
  assert.equal(robot.changing, false);
  robot.poke();
  run(robot, 0.2);
  assert.equal(eyesDrawn(robot).bars, 2, "one click again: annoyed");
  // Clicks more than 1.7 s apart never add up.
  for (let i = 0; i < 6; i++) {
    run(robot, 1.8);
    robot.poke();
    run(robot, 0.2);
    assert.equal(eyesDrawn(robot).bars, 2);
  }
});

test("the pointer resting on its head for 2 s wins it over: heart eyes in pink, five hearts, a bounce, hands up a little", () => {
  assert.deepEqual(LOVE_TIMES, { restMs: 2000, lastsMs: 1900, cooldownMs: 6000 });
  const robot = whole();
  robot.hover(true);
  assert.equal(robot.changing, true, "the wait is being timed: frames go on");
  run(robot, 1.99);
  assert.equal(eyesDrawn(robot).round, 2, "not yet");
  run(robot, 0.01);

  let hearts = 0;
  let top = 0;
  let low = 0;
  let lifted = 0;
  run(robot, 1.89, (r, ms) => {
    const drawn = eyesDrawn(r);
    hearts = Math.max(hearts, drawn.colours.filter((c) => c === rgba(LOVE)).length);
    top = Math.min(top, r.oy);
    low = Math.min(low, r.squash);
    lifted = Math.max(lifted, r.lift);
    if (ms === 600) {
      // Two filled hearts for eyes, turning pink, with a pink halo.
      assert.deepEqual([drawn.round, drawn.bars, drawn.strokes], [0, 0, 0]);
      assert.ok(r.eyeCol[0] > r.eyeCol[1] && r.haloCol[0] > r.haloCol[2] && r.haloCol[2] > r.haloCol[1]);
    }
  });
  assert.equal(hearts, 5, "all five in the air at once, at some point");
  assert.ok(near(top, -0.14, 0.005), "a small hop");
  assert.ok(near(low, -0.06, 0.005), "after gathering itself");
  assert.ok(lifted > 0.29 && lifted < 0.34, `hands lifted a little (${lifted})`);
  assert.ok(nearAll(robot.eyeCol, LOVE_EYES, 0.003) && nearAll(robot.haloCol, LOVE, 0.003));

  // 1.9 s: over. The eyes and their colour come back; the antenna never changed.
  run(robot, 0.01 + 0.16);
  const after = eyesDrawn(robot);
  assert.equal(after.round, 2);
  assert.ok(!after.colours.includes(rgba(LOVE)), "the hearts have faded");
  assert.ok(nearAll(robot.ledCol, ANTENNA_OFF, 0.003));
  robot.hover(false);
  run(robot, 2);
  assert.ok(nearAll(robot.eyeCol, ROBOT_STATES.idle.eyeColor, 0.003));
  assert.deepEqual([robot.oy, robot.squash, robot.lift], [0, 0, 0]);
  assert.equal(robot.changing, false);
});

test("leaving before the 2 s cancels the wait, not the hearts once they have started", () => {
  const robot = whole();
  robot.hover(true);
  run(robot, 1.9);
  robot.hover(false);
  assert.equal(robot.changing, false, "nothing is timed any more");
  robot.hover(true);
  run(robot, 1.9);
  assert.equal(eyesDrawn(robot).round, 2, "the wait starts over each time");
  run(robot, 0.2);
  assert.equal(eyesDrawn(robot).round, 0, "2 s in one go: hearts");
  // Away at once: the hearts go on to their end.
  robot.hover(false);
  run(robot, 0.6);
  assert.ok(eyesDrawn(robot).colours.includes(rgba(LOVE)));
  assert.equal(robot.changing, true);
  run(robot, 1.3 + 0.2);
  assert.equal(eyesDrawn(robot).round, 2);
  run(robot, 1.5);
  assert.equal(robot.changing, false);
});

test("after the hearts, six seconds before it can be won over again, then two more of rest", () => {
  const robot = whole();
  robot.hover(true);
  run(robot, 2 + 1.9);
  // The pointer never left. 7.9 s on (6 of cooldown, then 1.9 of the 2): nothing yet.
  run(robot, 7.9, (r, ms) => assert.ok(!eyesDrawn(r).colours.includes(rgba(LOVE)) || ms < 200, `no hearts at ${ms}`));
  assert.equal(eyesDrawn(robot).round, 2);
  run(robot, 0.2);
  assert.equal(eyesDrawn(robot).round, 0, "8 s after the first ended: again");
  // The cooldown runs whether or not the pointer stays; a pointer back within it waits it out.
  run(robot, 1.9);
  robot.hover(false);
  run(robot, 4);
  robot.hover(true);
  run(robot, 2.1);
  assert.equal(eyesDrawn(robot).round, 2, "6.1 s after the second: the rest only counts from the end of the cooldown");
  run(robot, 2);
  assert.equal(eyesDrawn(robot).round, 0);
});

test("a click while the pointer rests there annoys it instead, and the wait starts over", () => {
  const robot = whole();
  robot.hover(true);
  run(robot, 1.9);
  robot.poke();
  run(robot, 0.5);
  assert.equal(eyesDrawn(robot).bars, 2, "annoyed, not in love");
  // 1.2 s of frowning, then a fresh 2 s of rest.
  run(robot, 0.7 + 1.9);
  assert.equal(eyesDrawn(robot).round, 2);
  run(robot, 0.2);
  assert.equal(eyesDrawn(robot).round, 0);
});

// ── Hearts and stars ──────────────────────────────────────────────────────────

test("a heart pops to its size, rises about a head's radius swaying to its side, and fades away", () => {
  assert.deepEqual([HEARTS.seats.length, HEARTS.drifts.length, HEARTS.lifeMs, HEARTS.everyMs], [5, 5, 1150, 140]);
  for (let i = 0; i < 5; i++) {
    let p = heart(i);
    const start = particleShape(p);
    assert.deepEqual([start.kind, start.x, start.y, start.alpha], ["heart", HEARTS.seats[i], HEARTS.from, 1]);
    assert.ok(start.size < HEARTS.size * 0.4, "small as it leaves");
    let before = start.y;
    for (let ms = 10; ms < HEARTS.lifeMs; ms += 10) {
      [p] = ageParticles([p], 10);
      const shape = particleShape(p);
      assert.ok(shape.y < before, "always upward");
      assert.ok(Math.abs(shape.x - HEARTS.seats[i]) <= 0.16 + 1e-9);
      assert.ok(shape.alpha >= 0 && shape.alpha <= 1 && shape.size <= HEARTS.size * 1.2);
      if (ms === 300) assert.ok(near(shape.size, HEARTS.size, 0.01) && shape.alpha === 1, "whole by then");
      before = shape.y;
    }
    assert.ok(before > HEARTS.from - HEARTS.rise - 1e-9 && before < HEARTS.from - HEARTS.rise * 0.95);
    assert.ok(particleShape(p).alpha < 0.03, "nearly gone at the end of its life");
    assert.deepEqual(ageParticles([p], 10), [], "and then it is");
  }
});

test("three stars circle over the head, one turn every 1.1 s, in and out softly", () => {
  const ring = stars(3300);
  assert.equal(ring.length, 3);
  assert.deepEqual(ring.map((p) => p.seat), [0, 1 / 3, 2 / 3]);
  const first = particleShape(ring[0]);
  assert.deepEqual([first.x, first.y, first.alpha], [STARS.rx, STARS.y, 0]);
  const [quarter] = ageParticles([ring[0]], STARS.turnMs / 4);
  const near1 = particleShape(quarter);
  assert.ok(near(near1.x, 0, 1e-9) && near(near1.y, STARS.y + STARS.ry) && near1.alpha === 1);
  assert.ok(near1.size > STARS.size, "bigger on the near side");
  const [round] = ageParticles([ring[0]], STARS.turnMs);
  assert.ok(near(particleShape(round).x, STARS.rx, 1e-9), "back where it started");
  // The ring is over the head: around the antenna's stem, clear of the visor.
  assert.ok(STARS.y + STARS.ry + STARS.size * 1.22 < -0.9 && STARS.y - STARS.ry > -1.6);
  const [late] = ageParticles([ring[0]], 3300 - 160);
  assert.ok(near(particleShape(late).alpha, 0.5), "fading over its last 320 ms");
  assert.deepEqual(ageParticles(ring, 3300), []);
});

test("a particle cut short fades from where it is; one about to go is left alone", () => {
  const [p] = ageParticles([heart(0)], 300);
  assert.equal(fading(p, 160).lifeMs, 460);
  const [old] = ageParticles([heart(0)], 1100);
  assert.equal(fading(old, 160).lifeMs, 1150);
});

test("hearts and stars are drawn in their colours, and not at all once they have faded", () => {
  const ctx = recorder();
  paintParticle(ctx, 100, { kind: "heart", x: 0.5, y: -1.5, size: 0.16, alpha: 1, turn: 0 });
  assert.deepEqual(ctx.fills, [rgba(LOVE)]);
  assert.ok(near(ctx.box.left, 34) && near(ctx.box.right, 66) && near(ctx.box.bottom, -150 + 16 * 0.92));
  const star = recorder();
  paintParticle(star, 100, { kind: "star", x: 0, y: 0, size: 0.1, alpha: 0.5, turn: 0 });
  assert.deepEqual(star.fills, [rgba(STAR)]);
  assert.ok(near(star.box.top, -10), "a point up");
  const none = recorder();
  paintParticle(none, 100, { kind: "star", x: 0, y: 0, size: 0.1, alpha: 0, turn: 0 });
  assert.deepEqual(none.fills, []);
});

// ── The greeting ──────────────────────────────────────────────────────────────

test("the greeting: it drops in and bounces to rest, waves one hand three times with happy eyes, flashes, and is done in 2.4 s", () => {
  assert.equal(GREETING_MS, 2400);
  const robot = whole();
  robot.greet();
  assert.equal(robot.oy, -0.4, "it starts above its place");
  const at = {};
  const peaks = [];
  const wristPeaks = [];
  let before = { swing: 0, wrist: 0 };
  let flashed = 0;
  let smiling = [];
  run(robot, 2.4, (r, ms) => {
    at[ms] = { oy: r.oy, squash: r.squash, raise: r.raise, swing: r.swing, wrist: r.wrist };
    if (before.swing > 0.3 && r.swing < before.swing && at[ms - 20]?.swing < before.swing) peaks.push(ms - 10);
    if (before.wrist > 0.25 && r.wrist < before.wrist && at[ms - 20]?.wrist < before.wrist) wristPeaks.push(ms - 10);
    before = { swing: r.swing, wrist: r.wrist };
    flashed = Math.max(flashed, r.flash);
    if (eyesDrawn(r).strokes === 2) smiling.push(ms);
    if (ms < 2400) assert.equal(r.changing, true, `still greeting at ${ms}`);
  });
  // The entrance: falling stretched, on the ground at 260 ms, squashed at 320, one small hop, at rest by 800.
  assert.ok(at[130].oy < -0.2 && at[130].squash > 0.03, "falling, stretched");
  assert.ok(near(at[260].oy, 0) && near(at[320].squash, -0.12), JSON.stringify([at[260], at[320]]));
  assert.ok(near(at[440].oy, -0.13) && near(at[560].oy, 0), "the rebound");
  assert.deepEqual([at[800].oy, at[800].squash], [0, 0]);
  // The hand goes up from 640 ms, is up by 860, and comes down from 1900 to 2160.
  assert.ok(nearAll([at[640].raise, at[860].raise, at[1900].raise, at[2160].raise], [0, 1, 1, 0], 1e-9));
  assert.ok(Object.values(at).some((a) => a.raise > 1.02), "it pops up: past its place and back");
  // Three waves, 300 ms apart; the wrist does the same 70 ms later: overlap.
  assert.deepEqual(peaks, [950, 1250, 1550]);
  assert.deepEqual(wristPeaks, [1020, 1320, 1620]);
  assert.ok(near(at[950].swing, 0.36) && near(at[1100].swing, -0.288) && at[1840].swing === 0);
  // Happy arcs from 600 ms to 1960 (each way 160 ms of swap, the arcs in view for 100 of them).
  assert.ok(smiling[0] > 600 && smiling[0] <= 680 && smiling.at(-1) >= 1960 && smiling.at(-1) < 2040, `${smiling[0]}…${smiling.at(-1)}`);
  assert.ok(near(flashed, 1, 0.01), "the antenna flashes once");

  run(robot, 0.2);
  assert.deepEqual([robot.oy, robot.squash, robot.raise, robot.swing, robot.wrist, robot.wobble, robot.flash, robot.ox], [0, 0, 0, 0, 0, 0, 0, 0]);
  run(robot, 1.5);
  assert.equal(robot.changing, false, "and the frame loop can stop");
  assert.equal(eyesDrawn(robot).round, 2);
});

test("the greeting's flash is the white-cyan of its resting eyes, whatever the antenna's own light", () => {
  const robot = whole();
  robot.greet();
  let seen = false;
  run(robot, 1.3, (r, ms) => {
    if (ms !== 760) return;
    const lamp = eyesDrawn(r).ctx.fills.filter((f) => f.kind === "radial").map((f) => f.stops.at(-1)[1]);
    seen = lamp.includes(rgba(HELLO)) || lamp.includes(rgba(HELLO, 0));
  });
  assert.ok(seen, "at its brightest, 120 ms into the flash");
  assert.equal(rgba(HELLO), "rgba(232,252,255,1)");
});

test("the waving hand goes up beside the head, on the left, clear of the head and of the badge", () => {
  const R = 100;
  const rest = recorder();
  paintRobot(rest, R, stillPose({ model: "body" }));
  const up = recorder();
  paintRobot(up, R, { ...stillPose({ model: "body" }), raise: 1 });
  // Only the left side reaches further, and higher: the right hand has not moved.
  assert.ok(up.box.left < rest.box.left - 0.15 * R && near(up.box.right, rest.box.right, 1e-6));
  assert.deepEqual(WAVE, { dx: -0.1, dy: -0.72, turn: 2.45 });
  // Its middle is beside the upper half of the head, further from the centre than the head's edge.
  const angle = HAND.angle + WAVE.turn;
  const middle = [HAND.pivotX + WAVE.dx - Math.sin(angle) * HAND.arm, HAND.pivotY + WAVE.dy + Math.cos(angle) * HAND.arm];
  assert.ok(middle[0] < -1.2 && middle[1] < -0.4 && middle[1] > -1);
  assert.ok(Math.hypot(...middle) - HAND.half > 1.15, "it touches nothing");
  // The wrist turns the hand on its own middle: the hand's reach changes, its place does not.
  const bent = recorder();
  paintRobot(bent, R, { ...stillPose({ model: "body" }), raise: 1, wrist: 0.3 });
  assert.notDeepEqual(bent.box, up.box);
});

test("a mood never takes the figure out of its canvas, nor its hearts and stars", () => {
  const moods = {
    annoyed: (r) => r.react("annoyed", -1),
    dizzy: (r) => r.react("dizzy"),
    love: (r) => r.react("love"),
    greeting: (r) => r.greet(),
  };
  for (const slot of [44, 58, 66]) {
    const size = slot * CANVAS_PER_SLOT;
    for (const [name, start] of Object.entries(moods)) {
      for (const state of ["idle", "approval", "finished"]) {
        const robot = new Robot(seededRandom(slot));
        robot.alive = true;
        robot.setLimbs(true);
        robot.setState(state);
        run(robot, 2);
        start(robot);
        run(robot, 3.6, (r, ms) => {
          const ctx = recorder();
          r.draw(ctx, size, size);
          const { left, top, right, bottom } = ctx.box;
          assert.ok(left >= 0 && top >= 0 && right <= size && bottom <= size, `${name} ${state} in ${slot} at ${ms}: ${JSON.stringify(ctx.box)} of ${size}`);
        });
      }
    }
  }
});

test("a mood cut short is over at once: eyes back, at rest in 160 ms, what was in the air fades", () => {
  for (const start of [(r) => r.react("love"), (r) => r.react("dizzy"), (r) => r.greet(), (r) => r.poke()]) {
    const robot = whole();
    start(robot);
    run(robot, 0.9);
    robot.calm();
    run(robot, 0.16 + 0.01);
    assert.deepEqual([robot.ox, robot.oy, robot.squash, robot.lift, robot.wobble, robot.raise, robot.swing, robot.wrist, robot.flash], [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const drawn = eyesDrawn(robot);
    assert.equal(drawn.round, 2);
    assert.ok(!drawn.colours.includes(rgba(LOVE)) && !drawn.colours.includes(rgba(STAR)));
    run(robot, 1.5);
    assert.equal(robot.changing, false);
    // And nothing of it comes later: no cue left behind.
    run(robot, 5, (r) => assert.equal(r.changing, false));
  }
  // At rest there is nothing to cut, and nothing starts.
  const still = whole();
  still.calm();
  assert.equal(still.changing, false);
});

test("calm also means the pointer is no longer on it", () => {
  const robot = whole();
  robot.hover(true);
  run(robot, 1.5);
  robot.calm();
  assert.equal(robot.changing, false);
  run(robot, 3, (r) => assert.equal(r.changing, false));
});

test("what happens to the task comes first: a new state ends the mood and plays its own entrance", () => {
  const robot = whole();
  robot.react("dizzy");
  run(robot, 1);
  robot.setState("finished");
  let top = 0;
  run(robot, 0.75, (r) => (top = Math.min(top, r.oy)));
  assert.ok(near(top, -0.26, 0.005), "the happy hop, whole");
  const drawn = eyesDrawn(robot);
  assert.equal(drawn.strokes, 2, "happy arcs, not spirals");
  assert.ok(near(drawn.ctx.lineWidths[0], 0.42 * 0.2 * headRadius(60), 0.01), "arcs are drawn with the arc's pen");
  run(robot, 3);
  assert.deepEqual([robot.wobble, robot.ox], [0, 0]);
  assert.equal(robot.changing, false);
  // The same state again changes nothing of a mood.
  robot.react("love");
  run(robot, 0.5);
  robot.setState("finished");
  assert.ok(eyesDrawn(robot).colours.includes(rgba(LOVE)));
});

test("a mood shows over any state and gives its eyes back to the state it finds at its end", () => {
  const robot = whole();
  robot.setState("error");
  run(robot, 2);
  robot.react("love");
  run(robot, 1);
  assert.equal(eyesDrawn(robot).bars, 0, "hearts over the error's bars");
  run(robot, 1.2);
  assert.equal(eyesDrawn(robot).bars, 2, "the bars are back");
  run(robot, 2);
  assert.ok(nearAll(robot.eyeCol, ROBOT_STATES.error.eyeColor, 0.003));
  assert.equal(robot.changing, false);
});

test("in its pocket the whole figure fits with room around it: at rest, hopping, shaking and greeting", () => {
  assert.deepEqual([PEEK_W, PEEK_H, PEEK_BOT_D, PEEK_BOT_Y], [124, 116, 58, 62]);
  const place = botPosition("peek", "overview", PEEK_H);
  assert.deepEqual(place, { cx: 62, cy: 62, diameter: 58, opacity: 1 });
  assert.deepEqual(islandSize("peek", "overview"), { w: 124, h: 116 });
  assert.equal(modelFor(PEEK_BOT_D), "body");
  const size = PEEK_BOT_D * CANVAS_PER_SLOT;
  // What is drawn, in the pocket's own coordinates.
  const reach = (robot) => {
    const ctx = recorder();
    robot.draw(ctx, size, size);
    const dx = place.cx - size / 2;
    const dy = place.cy - size / 2;
    return { left: ctx.box.left + dx, right: ctx.box.right + dx, top: ctx.box.top + dy, bottom: ctx.box.bottom + dy };
  };
  const rest = reach(whole());
  // Its halos aside, antenna to feet it stands 32 px from the top and 24 from the bottom.
  const R = headRadius(PEEK_BOT_D);
  const bounds = robotBounds(robotGeometry(R), "body");
  const head = place.cy + 0.09 * R;
  assert.ok(near(head - bounds.top * R, 32.4, 0.1) && near(PEEK_H - (head + bounds.bottom * R), 24.1, 0.1));
  assert.ok(rest.left > 30 && rest.right < PEEK_W - 30, JSON.stringify(rest));

  const acts = {
    finished: (r) => r.setState("finished", true),
    error: (r) => r.setState("error", true),
    approval: (r) => r.setState("approval", true),
    greeting: (r) => r.greet(),
  };
  // In anything it wears: the pocket is where Liv is seen whole from the folded island.
  for (const outfit of ["none", ...OUTFIT_IDS]) {
    for (const [name, start] of Object.entries(acts)) {
      const robot = whole();
      robot.setOutfit(outfit, false);
      start(robot);
      run(robot, 3, (r, ms) => {
        const box = reach(r);
        // Never nearer than 8 px to the top edge (the screen's), 16 to a side, 18 to the bottom.
        assert.ok(
          box.top >= 8 && box.left >= 16 && box.right <= PEEK_W - 16 && box.bottom <= PEEK_H - 18,
          `${name} in ${outfit} at ${ms}: ${JSON.stringify(box)}`,
        );
      });
    }
  }
});
