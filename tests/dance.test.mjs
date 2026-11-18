// Liv dancing to music (src/robot/dance.ts, and the engine in
// src/robot/robot.ts): the beat it keeps, where each part of it is at each
// moment of a beat, how the dance comes in and goes out, and when it dances
// at all. Liv's bits in the Liv window — a wave, a hop, typing — are the
// engine's too, and are here with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOUNCE, DANCE_BPM, DANCE_COLOR, DANCE_IN_MS, DANCE_OUT_MS, HANDS, NOD, STILL, SWAY, TAP,
  beatPhase, beatsAt, bounceAt, danceLevel, feetAt, groove, handsAt, nodAt, pulseAt, shouldDance, squashAt, stepDance,
  swayAt, wristsAt,
} from "../src/robot/dance.ts";
import { ANTENNA_OFF, ROBOT_STATES, hexToRGB, mix } from "../src/robot/look.ts";
import { BIT_MS, Robot } from "../src/robot/robot.ts";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** Steps the robot for `seconds`, 100 times a second; `each` sees it after every step. */
function run(robot, seconds, each = () => {}) {
  const steps = Math.round(seconds * 100);
  for (let i = 1; i <= steps; i++) {
    robot.update(0.01);
    each(robot, i * 10);
  }
}

// ── The beat ──────────────────────────────────────────────────────────────────

test("the groove keeps 116 beats a minute", () => {
  assert.equal(DANCE_BPM, 116);
  assert.equal(beatsAt(0), 0);
  assert.ok(near(beatsAt(60), 116));
  assert.ok(near(beatsAt(60 / 116), 1), "one beat lasts 517 ms");
  assert.ok(near(beatsAt(30 / 116), 0.5));
});

test("the phase is how far into its beat, and starts over on each", () => {
  assert.equal(beatPhase(0), 0);
  assert.ok(near(beatPhase(0.25), 0.25));
  assert.ok(near(beatPhase(7.75), 0.75));
  assert.equal(beatPhase(12), 0);
});

// ── The moves ─────────────────────────────────────────────────────────────────

test("it lands on the beat, stays down a moment, and is at the top in the middle of its time in the air", () => {
  assert.equal(bounceAt(0), 0);
  assert.equal(bounceAt(BOUNCE.ground / 2), 0, "still on the ground");
  assert.equal(bounceAt(BOUNCE.ground), 0, "leaving it");
  assert.ok(near(bounceAt((1 + BOUNCE.ground) / 2), 1), "the top");
  assert.ok(near(bounceAt(1), 0), "down again for the next beat");
  // Up, then down: one arc.
  let top = 0;
  for (let p = BOUNCE.ground; p <= 1; p += 0.01) {
    const h = bounceAt(p);
    assert.ok(h >= -1e-9 && h <= 1 + 1e-9);
    if (p < (1 + BOUNCE.ground) / 2) assert.ok(h >= top - 1e-9, `rising at ${p}`);
    top = Math.max(top, h);
  }
});

test("it squashes on the landing and is back by the time it leaves the ground; in the air it stretches a little", () => {
  assert.ok(near(squashAt(0), 0), "it touches down at its own height");
  assert.ok(near(squashAt(BOUNCE.ground / 2), -BOUNCE.squash), "the deepest of the squash");
  assert.ok(near(squashAt(BOUNCE.ground), 0), "at rest as it leaves");
  for (let p = 0.001; p < BOUNCE.ground; p += 0.01) assert.ok(squashAt(p) < 0, `squashed at ${p}`);
  for (let p = BOUNCE.ground; p <= 1; p += 0.01) {
    assert.ok(squashAt(p) >= 0 && squashAt(p) <= BOUNCE.stretch + 1e-9, `stretched at ${p}`);
  }
  assert.ok(near(squashAt((1 + BOUNCE.ground) / 2), 0), "at the top it is its own shape");
  assert.ok(near(squashAt(1), 0, 1e-9), "and when it lands");
});

test("the sway goes to one side and the other in two beats", () => {
  assert.equal(swayAt(0), 0);
  assert.ok(near(swayAt(0.5), 1), "all the way right");
  assert.ok(near(swayAt(1), 0));
  assert.ok(near(swayAt(1.5), -1), "all the way left");
  assert.ok(near(swayAt(2), 0));
  assert.ok(near(swayAt(6.5), swayAt(0.5)), "and again every two beats");
});

test("the hands go up in turn: one is up on every beat, the other down", () => {
  assert.deepEqual(handsAt(0), [0, 1]);
  const odd = handsAt(1);
  assert.ok(near(odd[0], 1) && near(odd[1], 0));
  const even = handsAt(2);
  assert.ok(near(even[0], 0) && near(even[1], 1));
  for (let b = 0; b < 4; b += 0.05) {
    const [left, right] = handsAt(b);
    assert.ok(near(left + right, 1), "what one goes up the other comes down");
    assert.ok(left >= -1e-9 && left <= 1 + 1e-9);
  }
});

test("each wrist trails its hand: bent back while the hand goes up, and still bent a moment after it turns", () => {
  // The left hand goes up through the first beat: its wrist is bent back for most of it.
  assert.ok(wristsAt(0.5)[0] < 0);
  // At the top the hand stops, the wrist has not yet.
  assert.ok(wristsAt(1)[0] < 0, "late");
  assert.ok(near(wristsAt(1 + HANDS.late)[0], 0), "it catches up this much of a beat later");
  for (let b = 0; b < 4; b += 0.05) {
    const [left, right] = wristsAt(b);
    assert.ok(near(left, -right), "the two hands mirror each other");
    assert.ok(Math.abs(left) <= 1);
  }
});

test("the feet tap in turn: one stays on the ground under the bouncing body, the other taps down on the beat", () => {
  for (const beat of [0, 1, 2, 3]) {
    assert.deepEqual(feetAt(beat).map((v) => near(v, 0)), [true, true], `both on the ground on beat ${beat}`);
    const mid = beat + (1 + BOUNCE.ground) / 2;
    const [left, right] = feetAt(mid);
    const [tapping, planted] = beat % 2 === 0 ? [left, right] : [right, left];
    // The body is up by the bounce: the planted foot is that far below it, on the ground.
    assert.ok(near(planted, BOUNCE.height), `the planted foot stays down on beat ${beat}`);
    assert.ok(tapping < 0 && tapping >= -TAP, "the other one is off the ground");
  }
  // On the ground the body has not left yet: neither has the planted foot.
  assert.equal(feetAt(BOUNCE.ground / 2)[1], 0);
});

test("the nod comes at the top of every eight beats and is over in a little more than half a beat", () => {
  assert.equal(nodAt(0), 0);
  assert.ok(near(nodAt(NOD.beats / 2), 1), "all the way down");
  assert.equal(nodAt(NOD.beats), 0);
  for (let b = NOD.beats; b < NOD.every; b += 0.1) assert.equal(nodAt(b), 0, `none at beat ${b}`);
  assert.ok(near(nodAt(NOD.every + NOD.beats / 2), 1), "again eight beats on");
  assert.ok(near(nodAt(3 * NOD.every + NOD.beats / 2), 1));
});

test("the lights come up on the beat and fade until the next", () => {
  assert.equal(pulseAt(0), 0);
  let peakAt = 0;
  let before = 0;
  for (let p = 0; p <= 1; p += 0.005) {
    const v = pulseAt(p);
    assert.ok(v >= 0 && v <= 1 + 1e-9);
    if (v > pulseAt(peakAt)) peakAt = p;
    if (p > 0.1) assert.ok(v <= before + 1e-9, "fading");
    before = v;
  }
  assert.ok(peakAt < 0.1, "brightest just after the beat");
  assert.ok(pulseAt(peakAt) > 0.9);
  assert.ok(near(pulseAt(1), 0));
});

// ── The whole groove ──────────────────────────────────────────────────────────

test("no level, no dance; and every offset grows with the level", () => {
  assert.equal(groove(3.3, 0), STILL);
  assert.deepEqual(STILL, { ox: 0, oy: 0, squash: 0, tilt: 0, reach: [0, 0], flick: [0, 0], step: [0, 0], nod: 0, light: 0 });
  for (const beats of [0.1, 0.5, 0.85, 1.4, 8.3]) {
    const full = groove(beats, 1);
    const half = groove(beats, 0.5);
    for (const key of ["ox", "oy", "squash", "tilt", "nod", "light"]) assert.ok(near(half[key], full[key] / 2), `${key} at ${beats}`);
    for (const key of ["reach", "flick", "step"]) {
      assert.ok(half[key].every((v, i) => near(v, full[key][i] / 2)), `${key} at ${beats}`);
    }
  }
});

test("at full level the groove is the moves at their sizes", () => {
  const mid = (1 + BOUNCE.ground) / 2;
  const top = groove(mid, 1);
  assert.ok(near(top.oy, -BOUNCE.height), "up by the bounce, no nod there");
  assert.ok(near(top.ox, SWAY.reach * swayAt(mid)));
  assert.ok(near(top.tilt, SWAY.tilt * swayAt(mid)), "the head leans the way it sways");
  assert.ok(near(top.reach[0] + top.reach[1], HANDS.reach));
  const landed = groove(BOUNCE.ground / 2, 1);
  assert.ok(near(landed.squash, -BOUNCE.squash));
  // The first beat of eight: the eyes dip, and the head a little with them.
  const nodding = groove(NOD.beats / 2, 1);
  assert.ok(near(nodding.nod, NOD.gaze));
  assert.ok(nodding.oy > -BOUNCE.height * bounceAt(NOD.beats / 2), "lower than the bounce alone");
  // The lights never go out between two beats, and are full on the beat.
  for (let b = 0; b < 2; b += 0.01) assert.ok(groove(b, 1).light >= 0.5 && groove(b, 1).light <= 1 + 1e-9);
});

test("nothing in the dance jumps: from one frame to the next every offset moves a little", () => {
  const dt = 1 / 120;
  let before = groove(0, 1);
  for (let s = dt; s < 10; s += dt) {
    const now = groove(beatsAt(s), 1);
    for (const key of ["ox", "oy", "squash", "tilt"]) {
      assert.ok(Math.abs(now[key] - before[key]) < 0.03, `${key} at ${s.toFixed(3)} s`);
    }
    // The eyes cross the visor in gaze units, a larger scale than the body's.
    assert.ok(Math.abs(now.nod - before.nod) < 0.08, `nod at ${s.toFixed(3)} s`);
    for (const key of ["reach", "flick", "step"]) {
      assert.ok(now[key].every((v, i) => Math.abs(v - before[key][i]) < 0.03), `${key} at ${s.toFixed(3)} s`);
    }
    before = now;
  }
});

// ── In and out ────────────────────────────────────────────────────────────────

test("the dance comes in over 300 ms and goes out over 450", () => {
  assert.deepEqual([DANCE_IN_MS, DANCE_OUT_MS], [300, 450]);
  assert.ok(near(stepDance(0, true, 150), 0.5));
  assert.equal(stepDance(0, true, 300), 1);
  assert.equal(stepDance(0.9, true, 5000), 1, "never past all of it");
  assert.ok(near(stepDance(1, false, 225), 0.5));
  assert.equal(stepDance(1, false, 450), 0);
  assert.equal(stepDance(0.1, false, 5000), 0, "never below none");
  // Music that stops half-way in: it turns back from where it is.
  assert.ok(near(stepDance(stepDance(0, true, 150), false, 90), 0.3));
});

test("its level eases at both ends", () => {
  assert.equal(danceLevel(0), 0);
  assert.equal(danceLevel(1), 1);
  assert.equal(danceLevel(0.5), 0.5);
  assert.ok(danceLevel(0.1) < 0.1 && danceLevel(0.9) > 0.9, "slow to start, slow to arrive");
  let before = 0;
  for (let p = 0; p <= 1; p += 0.02) {
    assert.ok(danceLevel(p) >= before);
    before = danceLevel(p);
  }
  assert.deepEqual([danceLevel(-1), danceLevel(2)], [0, 1]);
});

// ── When ──────────────────────────────────────────────────────────────────────

test("Liv dances while music plays on the open island with the Spotify pill in front, and only then", () => {
  const dancing = { playing: true, inFront: true, mode: "expanded", view: "overview", parked: false, paused: false, state: "idle" };
  assert.equal(shouldDance(dancing), true);
  assert.equal(shouldDance({ ...dancing, playing: false }), false, "paused or stopped");
  assert.equal(shouldDance({ ...dancing, inFront: false }), false, "another pill in front");
  for (const mode of ["hidden", "compact", "peek"]) assert.equal(shouldDance({ ...dancing, mode }), false, mode);
  for (const view of ["approval", "question", "chat", "upload", "finished"]) {
    assert.equal(shouldDance({ ...dancing, view }), false, `the ${view} card is up`);
  }
  assert.equal(shouldDance({ ...dancing, parked: true }), false, "nobody sees it");
  assert.equal(shouldDance({ ...dancing, paused: true }), false);
});

test("a state with a look of its own always comes before the dance", () => {
  const dancing = { playing: true, inFront: true, mode: "expanded", view: "overview", parked: false, paused: false, state: "idle" };
  for (const state of Object.keys(ROBOT_STATES)) {
    assert.equal(shouldDance({ ...dancing, state }), state === "idle", state);
  }
});

// ── The engine ────────────────────────────────────────────────────────────────

test("asked to dance, Liv is dancing 300 ms later: smiling, bouncing, its lights in the music's colour", () => {
  const robot = new Robot(() => 0.5);
  robot.setLimbs(true);
  run(robot, 1);
  assert.ok(!robot.changing, "at rest first");
  assert.equal(robot.pose().glow, 0);

  robot.setDancing(true);
  assert.ok(robot.changing);
  run(robot, 0.15);
  assert.ok(robot.danceIn > 0.45 && robot.danceIn < 0.55, "half-way in");
  run(robot, 0.16);
  assert.equal(robot.danceIn, 1);
  assert.equal(robot.pose().eyes.shape, "arc");

  // Over two beats: it leaves the ground, sways both ways, each hand goes up, each foot taps.
  const seen = { up: 0, left: 0, right: 0, squash: 0, reachL: 0, reachR: 0, tapL: 0, tapR: 0, glow: [] };
  run(robot, (2 * 60) / DANCE_BPM, () => {
    const g = robot.groove;
    const pose = robot.pose();
    seen.up = Math.min(seen.up, g.oy);
    seen.left = Math.min(seen.left, g.ox);
    seen.right = Math.max(seen.right, g.ox);
    seen.squash = Math.min(seen.squash, pose.stretch[1] - 1);
    seen.reachL = Math.max(seen.reachL, pose.reach[0]);
    seen.reachR = Math.max(seen.reachR, pose.reach[1]);
    seen.tapL = Math.min(seen.tapL, pose.step[0]);
    seen.tapR = Math.min(seen.tapR, pose.step[1]);
    seen.glow.push(pose.glow);
  });
  assert.ok(near(seen.up, -BOUNCE.height, 0.005));
  assert.ok(near(seen.right, SWAY.reach, 0.005) && near(seen.left, -SWAY.reach, 0.005));
  assert.ok(near(seen.squash, -BOUNCE.squash, 0.01));
  assert.ok(seen.reachL > HANDS.reach * 0.95 && seen.reachR > HANDS.reach * 0.95);
  assert.ok(seen.tapL < -TAP * 0.9 && seen.tapR < -TAP * 0.9);
  assert.ok(Math.max(...seen.glow) > 0.95 && Math.min(...seen.glow) > 0.5, "the antenna pulses, and never goes out");

  // Its lights are the music's colour, the eyes' lighter.
  const pose = robot.pose();
  const light = robot.groove.light;
  assert.deepEqual(pose.eyeHalo, mix(ROBOT_STATES.idle.color, DANCE_COLOR, light));
  assert.deepEqual(pose.eyeColor, mix(ROBOT_STATES.idle.eyeColor, mix(DANCE_COLOR, [1, 1, 1], 0.5), light));
});

test("the dance starts on a beat, whenever it starts", () => {
  const robot = new Robot(() => 0.5);
  run(robot, 0.37);
  robot.setDancing(true);
  robot.update(0.01);
  assert.ok(near(robot.danceS, 0.01), "its own clock, from the moment it starts");
  run(robot, 2);
  robot.setDancing(false);
  run(robot, 1);
  robot.setDancing(true);
  robot.update(0.01);
  assert.ok(near(robot.danceS, 0.01), "and again from rest");
});

test("the music stops: Liv is still 450 ms later, its own eyes and lights back, and it rests", () => {
  const robot = new Robot(() => 0.5);
  robot.setLimbs(true);
  robot.setDancing(true);
  run(robot, 2);
  robot.setDancing(false);
  run(robot, 0.22);
  assert.ok(robot.danceIn > 0.45 && robot.danceIn < 0.56, "half-way out");
  assert.ok(robot.changing);
  run(robot, 0.24);
  assert.equal(robot.danceIn, 0);
  assert.equal(robot.groove, STILL);
  assert.equal(robot.pose().eyes.shape, "round");
  assert.deepEqual(robot.pose().eyeColor, ROBOT_STATES.idle.eyeColor);
  assert.equal(robot.pose().glow, 0);
  // The antenna swings to rest, and then nothing moves: the frame loop can stop.
  run(robot, 2);
  assert.ok(!robot.changing);
});

test("the antenna swings behind the dance on its spring", () => {
  const robot = new Robot(() => 0.5);
  robot.setDancing(true);
  let trailed = 0;
  run(robot, 3, () => {
    const [sx, sy] = robot.pose().sway;
    trailed = Math.max(trailed, Math.abs(sx), Math.abs(sy));
  });
  assert.ok(trailed > 0.02, "its tip is not where the body is");
  assert.ok(trailed <= 0.3, "and never further than it may trail");
});

test("the lights pulse in the colour Liv is told: the pill's the music plays on", () => {
  const robot = new Robot(() => 0.5);
  const pink = hexToRGB("#FF6B9D");
  robot.danceColor = pink;
  robot.setDancing(true);
  run(robot, 1);
  assert.deepEqual(robot.pose().eyeHalo, mix(ROBOT_STATES.idle.color, pink, robot.groove.light));
  assert.deepEqual(robot.pose().antennaColor, mix(ANTENNA_OFF, pink, robot.groove.light), "the antenna, off at rest, lights up in it");
});

test("a mood of its own holds the dance back, and the dance comes back after it", () => {
  const robot = new Robot(() => 0.5);
  robot.setLimbs(true);
  robot.setDancing(true);
  run(robot, 1);
  robot.poke();
  assert.equal(robot.pose().eyes.shape, "arc", "the swap of eyes has only started");
  run(robot, 0.6);
  assert.equal(robot.pose().eyes.shape, "angry");
  assert.equal(robot.danceIn, 0, "annoyed, it does not dance");
  run(robot, 1.2);
  assert.equal(robot.danceIn, 1, "it is over: back to the music");
  assert.equal(robot.pose().eyes.shape, "arc");
});

test("dancing, the eyes that smile do not blink", () => {
  const robot = new Robot(() => 0.5);
  robot.alive = true;
  robot.setDancing(true);
  run(robot, 12, () => assert.equal(robot.blink, 0));
});

// ── Bits ──────────────────────────────────────────────────────────────────────

test("a wave: one hand up beside the head, three waves, a smile, and back to rest", () => {
  assert.equal(BIT_MS.wave, 1520);
  const robot = new Robot(() => 0.5);
  robot.setLimbs(true);
  run(robot, 1);
  assert.equal(robot.perform("wave"), true);
  let raised = 0;
  let swings = 0;
  let before = 0;
  let smiled = false;
  run(robot, 1.6, () => {
    raised = Math.max(raised, robot.raise);
    if (Math.sign(robot.swing) !== 0 && Math.sign(robot.swing) !== Math.sign(before)) swings++;
    if (robot.swing !== 0) before = robot.swing;
    smiled ||= robot.pose().eyes.shape === "arc";
    assert.equal(robot.oy, 0, "it does not drop in, as it does when it greets");
  });
  assert.ok(raised >= 1);
  assert.equal(swings, 6, "there and back three times");
  assert.ok(smiled);
  run(robot, 1);
  assert.deepEqual([robot.raise, robot.swing, robot.wrist, robot.ox, robot.wobble], [0, 0, 0, 0, 0]);
  assert.equal(robot.pose().eyes.shape, "round");
  assert.ok(!robot.changing, "and it rests");
});

test("a hop: a small bounce, over in half a second", () => {
  assert.equal(BIT_MS.hop, 560);
  const robot = new Robot(() => 0.5);
  robot.setLimbs(true);
  run(robot, 1);
  robot.perform("hop");
  let top = 0;
  run(robot, 0.6, () => (top = Math.min(top, robot.oy)));
  assert.ok(near(top, -0.14, 0.005));
  run(robot, 1);
  assert.deepEqual([robot.oy, robot.squash], [0, 0]);
  assert.ok(!robot.changing);
});

test("typing: both hands up a little, going down in turn, for a second and a bit", () => {
  assert.equal(BIT_MS.type, 1370);
  const robot = new Robot(() => 0.5);
  robot.setLimbs(true);
  run(robot, 1);
  robot.perform("type");
  let left = 0;
  let right = 0;
  let together = 0;
  let strokes = 0;
  let rising = false;
  run(robot, 1.3, (_, ms) => {
    if (ms >= 120 && ms <= 1190) assert.ok(near(robot.lift, 0.1, 1e-6), "held in front for as long as it types");
    const [l, r] = robot.pose().reach;
    left = Math.max(left, l);
    right = Math.max(right, r);
    if (l > 0.15 && r > 0.15) together++;
    if (l > 0.15 && !rising) strokes++;
    rising = l > 0.15;
  });
  assert.ok(near(left, 0.2, 0.01) && near(right, 0.2, 0.01));
  assert.equal(strokes, 8, "eight keys with the left hand");
  assert.equal(together, 0, "never the two hands up at once");
  run(robot, 1);
  assert.deepEqual([robot.lift, robot.reachL, robot.reachR], [0, 0, 0]);
  assert.ok(!robot.changing);
});

test("a bit waits for a mood to be over, and a click cuts a bit short", () => {
  const robot = new Robot(() => 0.5);
  robot.setLimbs(true);
  robot.poke();
  assert.equal(robot.perform("wave"), false, "annoyed: no wave");
  assert.equal(robot.raise, 0);
  run(robot, 2);
  assert.equal(robot.perform("wave"), true);
  assert.equal(robot.perform("hop"), false, "one bit at a time");
  run(robot, 0.5);
  assert.ok(robot.raise > 0.9);
  robot.poke();
  run(robot, 0.3);
  assert.equal(robot.raise, 0, "the hand comes down at once");
  assert.equal(robot.pose().eyes.shape, "angry");
});

test("robots given different ages breathe out of step, and their eyes rest where they are told", () => {
  const young = new Robot(() => 0.5);
  const old = new Robot(() => 0.5, 1.6);
  for (const robot of [young, old]) robot.alive = true;
  run(young, 2);
  run(old, 2);
  assert.notEqual(young.pose().stretch[0], old.pose().stretch[0]);
  // No pointer, no spot of the state's: the eyes go where they rest.
  young.restGaze = [0.7, 0];
  run(young, 1);
  assert.ok(near(young.pose().gaze[0], 0.7, 0.01));
  young.lookAt([-40, 0]);
  run(young, 1);
  assert.ok(young.pose().gaze[0] < -0.3, "a pointer nearby comes first");
  young.setState("thinking");
  run(young, 1);
  assert.ok(near(young.pose().gaze[1], -0.8, 0.01), "and the state's own spot before both");
});
