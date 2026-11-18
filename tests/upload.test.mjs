// The drop sequence (src/upload): its timeline, which is the reference's and
// must stay so, and what Liv does on it (src/upload/liv.ts) — it follows the
// file, catches it in its visor, shrinks into its antenna's light, which rides
// the progress bar, and grows back out of it by the choose card.

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { mock, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

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

// The sequence reads the wall clock: here it is this one.
let now = 0;
mock.method(performance, "now", () => now);

const { USC, UploadSeq, progressAt, uploadProgressCurve } = await import("../src/upload/sequence.ts");
const { uploadLiv } = await import("../src/upload/liv.ts");
const { ANTENNA_OFF, ROBOT_STATES, headRadius, robotBounds, robotGeometry } = await import("../src/robot/look.ts");
const { pulseScale } = await import("../src/robot/robot.ts");

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearAll = (a, b, eps = 1e-6) => a.every((v, i) => near(v, b[i], eps));

/** The pointer the tests drag the file with: well to the right of Liv's place, above the card's middle. */
const AWAY = [520, 60];

/** `ms` go by, the pointer where it is. */
function wait(ms) {
  now += ms;
  return UploadSeq.frame();
}

/** A file comes over the island at `at` and is dragged there for `ms`. */
function hover(at = AWAY, ms = 0) {
  UploadSeq.deactivate();
  UploadSeq.enterZone(at[0], at[1]);
  return wait(ms);
}

/** The frame `seconds` after a drop that followed 400 ms of hovering at `at`. */
function dropped(seconds, at = AWAY, duration = 2.4) {
  hover(at, 400);
  UploadSeq.performDrop(duration);
  return wait(seconds * 1000);
}

/** The frame at reference time `t` (the drop is at 1.95). */
const atRef = (t, at, duration) => dropped(t - USC.T_DROP, at, duration);

beforeEach(() => {
  now = 100_000;
  UploadSeq.deactivate();
});

// ── The timeline is the reference's ───────────────────────────────────────────

test("every constant of the sequence is the reference's", () => {
  assert.deepEqual({ ...USC }, {
    W: 640, ISL_H: 176,
    CARD_X: 10, CARD_Y: 42, CARD_W: 620, CARD_H: 124, CARD_R: 20,
    REST_X: 140, REST_Y: 104, D_REST: 62,
    FOLLOW_MIN: 60, FOLLOW_MAX: 580,
    TEXT_X: 196, TEXT_Y: 94,
    BAR_X0: 46, BAR_X1: 520, BAR_Y: 118,
    CHOOSE_X: 60, CHOOSE_Y: 101, CHOOSE_D: 62,
    LOCK_IN: 60, LOCK_OUT: 90,
    T_DROP: 1.95, T_SUCK_START: 2.03, T_SUCK_END: 2.33,
    T_SHRINK_START: 2.88, T_SHRINK_END: 3.23, T_BAR_IN: 3.0, T_PROG_START: 3.25,
    DT: 1 / 240, ENTRY_T_REF: 1.95 - 0.4,
  });
});

test("the progress curve: quick to 60 %, an unhurried middle, a last push", () => {
  assert.deepEqual([uploadProgressCurve(0), uploadProgressCurve(0.4), uploadProgressCurve(0.85), uploadProgressCurve(1)], [0, 0.6, 0.92, 1]);
  assert.ok(near(uploadProgressCurve(0.2), 0.6 * (1 - 0.5 ** 3)));
  assert.ok(near(uploadProgressCurve(0.625), 0.6 + 0.32 * 0.5));
  assert.equal(progressAt(3.2, 3.25, 5.65), 0);
  assert.ok(near(progressAt(3.25 + 0.4 * 2.4, 3.25, 5.65), 0.6));
});

test("while a file hovers nothing of the drop's timeline shows, however long", () => {
  for (const ms of [0, 400, 3000, 60_000]) {
    const f = hover(AWAY, ms);
    assert.deepEqual(
      [f.fileVisible, f.suck, f.zoneOver, f.zoneAlpha, f.barReveal, f.barAlpha, f.progress, f.check, f.chooseAlpha, f.d, f.scale],
      [true, 0, true, 1, 0, 0, 0, 0, 0, 62, 1], String(ms),
    );
    assert.ok(near(f.y, USC.REST_Y, 0.01));
    assert.equal(f.greenWash, 0.22);
  }
  // Liv follows the pointer across, no further than the card lets it.
  assert.ok(near(hover([400, 60], 3000).x, 400, 0.05));
  assert.ok(near(hover([10_000, 60], 3000).x, USC.FOLLOW_MAX, 0.05));
  assert.ok(near(hover([-50, 60], 3000).x, USC.FOLLOW_MIN, 0.05));
});

test("the follow locks on within 60 px of a slow file, and lets go beyond 90", () => {
  // Far away: it follows on x only, and never locks (the file is 80 px above its line).
  assert.equal(hover([300, 10], 2000).lockAge, null);
  // Close and still: locked, and the frame says for how long.
  hover([150, 96], 0);
  let f = wait(500);
  assert.ok(f.lockAge > 0.3 && f.lockAge <= 0.5, String(f.lockAge));
  assert.ok(near(wait(100).lockAge, f.lockAge + 0.1, 1e-6));
  // Pulled 100 px above its line: let go.
  UploadSeq.updateCursor(150, -10);
  assert.equal(wait(50).lockAge, null);
  // A file moving fast does not lock on, however close.
  hover([150, 96], 0);
  now += 10;
  UploadSeq.updateCursor(152, 96);
  assert.equal(wait(100).lockAge, null, "200 px/s");
});

test("the phases start and end when they always did", () => {
  const f0 = dropped(0);
  assert.ok(near(f0.t, 1.95) && f0.fileVisible && f0.suck === 0 && f0.lockAge === null);
  // The file goes in from 2.03 to 2.33; Liv pulses as it lands.
  assert.equal(atRef(2.03).suck, 0);
  assert.ok(near(atRef(2.18).suck, 0.5));
  assert.equal(atRef(2.32).fileVisible, true);
  const landed = atRef(2.33 + 1e-6);
  assert.deepEqual([landed.fileVisible, landed.suck], [false, 1]);
  assert.ok(near(atRef(2.47).scale, 1.12, 1e-4) && near(atRef(2.47).scale, pulseScale(140), 1e-4));
  assert.equal(atRef(2.75).scale, 1);

  // It shrinks to the bar's start from 2.88 to 3.23, to a slot of 14.
  assert.equal(atRef(2.87).d, 62);
  const half = atRef(2.88 + 0.175);
  assert.ok(near(half.d, 38, 1e-4) && near(half.y, (USC.REST_Y + USC.BAR_Y) / 2, 0.05), JSON.stringify([half.d, half.y]));
  const small = atRef(3.24);
  assert.ok(nearAll([small.x, small.y, small.d], [USC.BAR_X0, USC.BAR_Y, 14]));
  // The drop zone fades from 2.88 to 3.08, the bar comes in from 3.0 to 3.25.
  assert.ok(near(atRef(2.98).zoneAlpha, 0.5, 1e-4) && atRef(3.09).zoneAlpha === 0);
  assert.equal(atRef(2.99).barReveal, 0);
  assert.ok(near(atRef(3.26).barReveal, 1) && near(atRef(3.26).barAlpha, 1));

  // The upload: 3.25 to 5.65 for 2.4 s, the dot on the bar's own curve.
  assert.equal(atRef(3.25).progress, 0);
  const mid = atRef(3.25 + 0.4 * 2.4);
  assert.ok(near(mid.progress, 0.6, 1e-4) && near(mid.x, USC.BAR_X0 + 0.6 * (USC.BAR_X1 - USC.BAR_X0), 0.05) && mid.y === USC.BAR_Y && mid.d === 14);
  const done = atRef(5.65 + 1e-6);
  assert.deepEqual([done.progress, done.x, done.progEnd, done.growStart, done.growEnd].map((v) => Math.round(v * 1000) / 1000), [1, 520, 5.65, 5.9, 6.35]);
  // The check pops in over 250 ms with a flash, and the dot hops 8 px.
  assert.ok(atRef(5.64).check === 0 && near(atRef(5.9).check, 1, 1e-4) && atRef(5.8).check > 1);
  assert.ok(near(atRef(5.8).flash, 1, 1e-3));
  assert.ok(near(atRef(5.75).y, USC.BAR_Y - 8, 1e-3) && near(atRef(5.86).y, USC.BAR_Y, 1e-3));

  // It grows back from 5.9 to 6.35, by the choose card, which fades in from 6.05.
  const growing = atRef(6.125);
  assert.ok(near(growing.x, (USC.BAR_X1 + USC.CHOOSE_X) / 2, 0.05) && growing.d > 38);
  const back = atRef(6.36);
  assert.ok(nearAll([back.x, back.y, back.d], [USC.CHOOSE_X, USC.CHOOSE_Y, USC.CHOOSE_D]));
  assert.equal(atRef(6.05).chooseAlpha, 0);
  assert.equal(back.chooseAlpha, 1);
  assert.ok(near(atRef(6.65).greenWash, atRef(6.35).greenWash / 2, 0.01), "the wash fades over 0.6 s from there");
});

test("another upload duration moves the end of the upload and what follows it, nothing before", () => {
  const f = atRef(4, AWAY, 5);
  assert.deepEqual([f.progEnd, f.growStart, f.growEnd].map((v) => Math.round(v * 100) / 100), [8.25, 8.5, 8.95]);
  assert.ok(near(atRef(3.24, AWAY, 5).d, 14) && atRef(3.25, AWAY, 5).progress === 0);
  assert.ok(near(atRef(8.25 + 1e-6, AWAY, 5).progress, 1));
});

// ── Liv on that timeline ──────────────────────────────────────────────────────

const R0 = headRadius(62);
const G0 = robotGeometry(R0);

test("while a file hovers Liv is whole, looks at it wide-eyed and raises its hands to catch it", () => {
  // The file is drawn 14 px under the pointer: here up and to the right of Liv.
  const f = hover([400, 10], 0);
  const start = uploadLiv(f);
  assert.equal(start.lamp, null);
  assert.deepEqual([start.body.x, start.body.share, start.body.alpha, start.body.R], [f.x, 1, 1, R0]);
  assert.ok(near(start.body.y, f.y + 0.09 * R0), "its head where the island's own stands in a slot");
  assert.ok(nearAll([start.body.pose.hands, start.body.pose.feet, start.body.pose.lift], [1, 1, 0], 1e-12));
  assert.equal(start.body.pose.eyes.shape, "wide");
  assert.ok(start.body.pose.gaze[0] > 0.5 && start.body.pose.gaze[1] < -0.2, `towards the file (${start.body.pose.gaze})`);

  // The hands go up in 260 ms, past their place and back.
  let top = 0;
  for (let ms = 0; ms < 260; ms += 10) top = Math.max(top, uploadLiv(wait(10)).body.pose.lift);
  assert.ok(top > 0.72);
  const up = uploadLiv(wait(10));
  assert.ok(near(up.body.pose.lift, 0.7));
  // It goes on looking at the file wherever that goes, as it follows it.
  UploadSeq.updateCursor(20, 150);
  const left = uploadLiv(wait(3000));
  assert.ok(left.body.pose.gaze[0] < -0.3 && left.body.pose.gaze[1] > 0.3);
  assert.ok(near(left.body.x, USC.FOLLOW_MIN, 0.05));
  assert.deepEqual(left.body.pose.stretch, [1, 1]);
});

test("the sequence's Liv wears what the island's own has on, start to end; nothing unless told", () => {
  // Hovering, caught, shrinking into its light, on the bar, and grown back.
  const frames = [hover([400, 10], 0), wait(300), dropped(0.05), dropped(0.4), dropped(1.5), dropped(4.2), dropped(5)];
  let bodies = 0;
  for (const f of frames) {
    const bare = uploadLiv(f);
    const dressed = uploadLiv(f, "beanie");
    assert.equal(dressed.body == null, bare.body == null);
    assert.deepEqual(dressed.lamp, bare.lamp);
    if (!bare.body) continue;
    bodies++;
    assert.deepEqual([bare.body.pose.outfit, bare.body.pose.wear], ["none", 1]);
    assert.deepEqual([dressed.body.pose.outfit, dressed.body.pose.wear], ["beanie", 1], "already on: it is the same Liv");
    // Nothing else of what it does changes with it.
    assert.deepEqual({ ...dressed.body.pose, outfit: "none" }, bare.body.pose);
  }
  assert.ok(bodies >= 4, `${bodies} frames with Liv whole or shrinking`);
});

test("the whole of it stays inside the card, hands up included, wherever it follows the file", () => {
  for (const x of [-100, 140, 330, 2000]) {
    const liv = uploadLiv(hover([x, 60], 3000));
    const b = robotBounds(G0, "body");
    assert.ok(liv.body.y - (b.top + 0.4) * R0 > USC.CARD_Y, "antenna and its halo under the card's top");
    assert.ok(liv.body.y + b.bottom * R0 < USC.CARD_Y + USC.CARD_H - 20);
    // Hands raised reach 1.65 R to each side.
    assert.ok(liv.body.x - 1.65 * R0 > USC.CARD_X && liv.body.x + 1.65 * R0 < USC.CARD_X + USC.CARD_W, String(x));
  }
  // At its resting place, hands up, it stays clear of the drop text.
  assert.ok(USC.REST_X + 1.65 * R0 < USC.TEXT_X);
});

test("when the follow locks on, a small eager bounce: up 0.1 R in a quarter of a second, a soft landing", () => {
  hover([150, 96], 0);
  let f = wait(100);
  while (f.lockAge == null) f = wait(10);
  const ground = f.y + 0.09 * R0;
  const heights = [];
  const stretches = [];
  for (let ms = 0; ms < 500; ms += 10) {
    const frame = wait(10);
    const liv = uploadLiv(frame);
    heights.push([frame.lockAge, (frame.y + 0.09 * R0 - liv.body.y) / R0]);
    stretches.push([frame.lockAge, liv.body.pose.stretch[1] - 1]);
    assert.ok(near(liv.body.pose.stretch[0], 1 - (liv.body.pose.stretch[1] - 1) * 0.7));
  }
  const highest = Math.max(...heights.map((h) => h[1]));
  assert.ok(near(highest, 0.1, 0.002), `it hops ${highest} R`);
  assert.ok(heights.filter((h) => h[0] > 0.24).every((h) => near(h[1], 0, 1e-9)), "down after 240 ms");
  assert.ok(Math.max(...stretches.map((s) => s[1])) > 0.045, "stretched in the air");
  assert.ok(Math.min(...stretches.map((s) => s[1])) < -0.04, "squashed as it lands");
  assert.ok(stretches.filter((s) => s[0] > 0.4).every((s) => near(s[1], 0, 1e-9)), "at rest 400 ms after the lock");
  assert.ok(ground > 0);
});

test("the file goes into the visor, and Liv's eyes turn happy as it comes", () => {
  // The file's way ends in the middle of the visor, not of the slot.
  const coming = atRef(2.18);
  const liv = uploadLiv(coming);
  assert.deepEqual(liv.mouth, { x: liv.body.x, y: liv.body.y + G0.visorY * R0 });
  assert.ok(near(liv.mouth.y, coming.y + (0.09 + 0.03) * R0));
  // Hands still up for it; the eyes follow it in.
  assert.equal(liv.body.pose.lift, 0.7);
  const far = uploadLiv(atRef(2.03)).body.pose.gaze;
  const closer = uploadLiv(atRef(2.32)).body.pose.gaze;
  assert.ok(Math.hypot(...closer) < Math.hypot(...far) * 0.2, "straight ahead as it arrives");

  // Wide eyes shrink away in 64 ms, happy arcs are whole 160 ms after the file starts in.
  const turning = uploadLiv(atRef(2.03 + 0.03)).body.pose;
  assert.equal(turning.eyes.shape, "wide");
  assert.ok(turning.eyeScale < 1 && turning.eyeAlpha < 1);
  const turned = uploadLiv(atRef(2.03 + 0.1)).body.pose;
  assert.equal(turned.eyes.shape, "arc");
  const happy = uploadLiv(atRef(2.03 + 0.161)).body.pose;
  assert.deepEqual([happy.eyes.shape, happy.eyeScale, happy.eyeAlpha], ["arc", 1, 1]);
});

test("as the file lands Liv gulps: a small squash on top of the sequence's pulse, and its hands come down", () => {
  const before = uploadLiv(atRef(2.32)).body;
  assert.deepEqual(before.pose.stretch, [1, 1]);
  const gulp = uploadLiv(atRef(2.33 + 0.06)).body;
  assert.ok(near(gulp.pose.stretch[1], 1 - 0.11, 1e-3) && gulp.pose.stretch[0] > 1.07, `squashed 0.11 in 60 ms (${gulp.pose.stretch})`);
  // The pulse is in its size, as before: 1.12 at 140 ms.
  assert.ok(near(uploadLiv(atRef(2.47)).body.R, headRadius(62 * 1.12), 1e-3));
  assert.ok(Math.abs(uploadLiv(atRef(2.47)).body.pose.stretch[1] - 1) < 0.04, "most of the way back by then");
  const after = uploadLiv(atRef(2.33 + 0.31)).body;
  assert.deepEqual(after.pose.stretch, [1, 1]);
  assert.equal(after.pose.eyes.shape, "arc");
  assert.equal(after.pose.lift, 0, "hands down 240 ms after the catch");
  assert.ok(uploadLiv(atRef(2.33 + 0.12)).body.pose.lift > 0.3);
});

test("Liv shrinks into the light of its antenna, where the figure shrank to a dot", () => {
  // Until 2.88 there is no light of its own.
  assert.equal(uploadLiv(atRef(2.87)).lamp, null);
  let before = { share: 1, r: 0, light: -1 };
  for (let t = 2.89; t < 3.23; t += 0.02) {
    const f = atRef(t);
    const { body, lamp } = uploadLiv(f);
    const share = (f.d - 14) / 48;
    assert.ok(share < before.share);
    // The light is where the body's antenna ends: the body is drawn `share` of its size around its head.
    const tip = [body.x + share * G0.lean * R0, body.y + share * G0.ballY * R0];
    assert.ok(nearAll([lamp.x, lamp.y], tip, 1e-9), `the light is on the antenna's end at ${t}`);
    assert.ok(near(body.share, share) && body.alpha <= 1 && body.alpha >= 0);
    // It grows from the antenna's ball to the dot's size, lighting up in the working blue.
    assert.ok(lamp.r > before.r && lamp.light > before.light);
    before = { share, r: lamp.r, light: lamp.light };
  }
  const start = uploadLiv(atRef(2.881)).lamp;
  assert.ok(near(start.r, G0.ballR * R0, 0.01) && near(start.light, 0, 0.001) && nearAll(start.color, ANTENNA_OFF, 0.001));
  // Small, the body is out of sight before it is nothing.
  const faint = uploadLiv(atRef(3.12));
  assert.ok(faint.body.share < 0.3 && faint.body.alpha < 1 && faint.body.alpha > 0);

  const end = uploadLiv(atRef(3.24));
  assert.equal(end.body, null);
  assert.deepEqual(end.lamp, { x: USC.BAR_X0, y: USC.BAR_Y, r: headRadius(14), color: ROBOT_STATES.working.color, light: 1 });
});

test("the light rides the bar where the dot did, the same size, blue; and turns green at the check", () => {
  for (const t of [3.3, 3.8, 4.5, 5.2, 5.64]) {
    const f = atRef(t);
    const { body, lamp } = uploadLiv(f);
    assert.equal(body, null);
    assert.deepEqual([lamp.x, lamp.y, lamp.r, lamp.light], [f.x, f.y, headRadius(14), 1], String(t));
    assert.ok(near(lamp.x, USC.BAR_X0 + progressAt(t, 3.25, 5.65) * (USC.BAR_X1 - USC.BAR_X0), 0.01));
    assert.deepEqual(lamp.color, ROBOT_STATES.working.color);
  }
  // The dot was the head at a slot of 14: 5.2 px of radius.
  assert.ok(near(headRadius(14), 5.1744));
  const turning = uploadLiv(atRef(5.7)).lamp;
  assert.ok(turning.color[1] > ROBOT_STATES.working.color[1] && turning.color[2] < 1, "on its way to green");
  const green = uploadLiv(atRef(5.89));
  assert.ok(nearAll(green.lamp.color, ROBOT_STATES.finished.color, 0.01));
  assert.ok(near(uploadLiv(atRef(5.75)).lamp.y, USC.BAR_Y - 8, 1e-3), "it hops with the check, as the dot did");
});

test("Liv grows back out of the light by the choose card, still smiling, then is itself again", () => {
  const sprouting = uploadLiv(atRef(5.91));
  assert.ok(sprouting.body.share > 0 && sprouting.body.share < 0.3 && sprouting.lamp.light > 0.7);
  let before = 0;
  for (let t = 5.92; t < 6.14; t += 0.02) {
    const f = atRef(t);
    const { body, lamp } = uploadLiv(f);
    assert.ok(body.share > before);
    before = body.share;
    if (lamp) assert.ok(nearAll([lamp.x, lamp.y], [body.x + body.share * G0.lean * R0, body.y + body.share * G0.ballY * R0], 1e-9));
    assert.equal(body.pose.eyes.shape, "arc");
  }
  // It pops: a little past its size on the way, as the figure did.
  assert.ok(uploadLiv(atRef(6.25)).body.share > 1.02);
  assert.equal(uploadLiv(atRef(6.25)).lamp, null, "whole again: its antenna is its own");
  const back = uploadLiv(atRef(6.36));
  assert.ok(nearAll([back.body.x, back.body.y, back.body.share, back.body.alpha], [USC.CHOOSE_X, USC.CHOOSE_Y + 0.09 * R0, 1, 1]));
  assert.deepEqual([back.body.pose.eyes.shape, back.body.pose.lift, back.body.pose.glow], ["arc", 0, 0]);
  // 300 ms later the smile gives way to its resting eyes, and it stays so for as long as the card is up.
  assert.equal(uploadLiv(atRef(6.64)).body.pose.eyes.shape, "arc");
  for (const t of [6.35 + 0.3 + 0.161, 8, 30]) {
    const pose = uploadLiv(atRef(t)).body.pose;
    assert.deepEqual([pose.eyes.shape, pose.eyeScale, pose.eyeAlpha, pose.gaze], ["round", 1, 1, [0, 0]], String(t));
  }
  // By the choose card it stands clear of the card's edge and of its text.
  assert.ok(USC.CHOOSE_X - 1.3 * R0 > USC.CARD_X && USC.CHOOSE_X + 1.3 * R0 < 114);
});
