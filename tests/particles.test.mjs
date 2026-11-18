// The specks that drift behind Liv (src/core/particles.ts): how many, where
// they start, how they move, twinkle and give way to the pointer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { paintParticles, particleCount, seedParticles, stepParticle } from "../src/core/particles.ts";

/** A random source that goes through `values` again and again. */
const cycle = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const speck = (over = {}) => ({ x: 50, y: 50, vx: 0, vy: 0, r: 1, depth: 1, phase: 0, white: false, ...over });

test("a wide band gets more of them than a narrow strip, within limits", () => {
  assert.equal(particleCount(900, 150), 52);
  assert.equal(particleCount(100, 100), 24);
  assert.equal(particleCount(4000, 400), 90);
  // The strip beside the chat: its own, sparser rule.
  assert.equal(particleCount(92, 240, 1100, 10, 40), 20);
  assert.equal(particleCount(40, 40, 1100, 10, 40), 10);
});

test("they start anywhere in the room, drifting up, a third of them white", () => {
  const field = seedParticles(200, 100, 300);
  assert.equal(field.length, 300);
  for (const p of field) {
    assert.ok(p.x >= 0 && p.x <= 200 && p.y >= 0 && p.y <= 100);
    assert.ok(p.vy <= -2 && p.vy >= -8 && Math.abs(p.vx) <= 3);
    assert.ok(p.r >= 0.5 && p.r <= 1.9 && p.depth >= 0.35 && p.depth <= 1);
  }
  const white = field.filter((p) => p.white).length;
  assert.ok(white > 60 && white < 150, `${white} white of 300`);
  // The same numbers give the same field.
  assert.deepEqual(seedParticles(200, 100, 3, cycle(0.5, 0.25)), seedParticles(200, 100, 3, cycle(0.5, 0.25)));
});

test("each drifts at the pace of its depth and comes back in on the other side", () => {
  const near = speck({ vy: -6, depth: 1 });
  const far = speck({ vy: -6, depth: 0.5 });
  stepParticle(near, 1, 0, 100, 100, null, 0);
  stepParticle(far, 1, 0, 100, 100, null, 0);
  assert.equal(near.y, 44);
  assert.equal(far.y, 47);

  const leaving = speck({ y: -3, vy: -6 });
  stepParticle(leaving, 1, 0, 100, 100, null, 0);
  assert.equal(leaving.y, 104);
  const sideways = speck({ x: 103, vx: 3 });
  stepParticle(sideways, 1, 0, 100, 100, null, 0);
  assert.equal(sideways.x, -4);
});

test("each twinkles on its own clock, the far ones fainter, never more than opaque", () => {
  const seen = (p, t) => stepParticle({ ...p }, 0, t, 100, 100, null, 0).alpha;
  const p = speck();
  const levels = [0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.4].map((t) => seen(p, t));
  assert.ok(Math.max(...levels) - Math.min(...levels) > 0.3);
  for (const level of levels) assert.ok(level >= 0.22 - 1e-9 && level <= 0.72 + 1e-9);
  assert.ok(seen(speck({ depth: 0.4 }), 0.5) < seen(p, 0.5));
  assert.notEqual(seen(speck({ phase: 2 }), 0.5), seen(p, 0.5));
});

test("the pointer pushes the near ones away and lights them", () => {
  const p = speck({ x: 60, y: 50 });
  const calm = stepParticle({ ...p }, 0.05, 1, 200, 200, null, 1);
  const shown = stepParticle(p, 0.05, 1, 200, 200, { x: 50, y: 50 }, 1);
  assert.ok(p.x > 60, "away from the pointer");
  assert.equal(p.y, 50);
  assert.ok(shown.alpha > calm.alpha && shown.r > calm.r);
  assert.ok(shown.alpha <= 1);

  // Out of reach, or with the pointer not counting yet: as if it were not there.
  const away = speck({ x: 380, y: 50 });
  assert.deepEqual(stepParticle(away, 0.05, 1, 400, 200, { x: 50, y: 50 }, 1), stepParticle(speck({ x: 380 }), 0.05, 1, 400, 200, null, 0));
  const ignored = speck({ x: 60 });
  stepParticle(ignored, 0.05, 1, 200, 200, { x: 50, y: 50 }, 0);
  assert.equal(ignored.x, 60);
});

test("a frame draws a dot for each, and a halo round the bigger ones", () => {
  const drawn = [];
  const ctx = {
    fillStyle: "",
    beginPath() {},
    arc(x, y, r) {
      drawn.push({ r, fill: this.fillStyle });
    },
    fill() {},
  };
  const field = [speck({ r: 0.8 }), speck({ r: 1.6, white: true })];
  paintParticles(ctx, field, 0, 0, 100, 100, null, 0, (white, alpha) => `${white ? "white" : "tint"}@${alpha.toFixed(3)}`);
  assert.deepEqual(drawn.map((d) => d.r), [0.8, 1.6 * 2.6, 1.6]);
  assert.match(drawn[0].fill, /^tint@/);
  assert.match(drawn[1].fill, /^white@/);
  // The halo is the dot's colour, much fainter.
  const [, halo, dot] = drawn.map((d) => Number(d.fill.split("@")[1]));
  assert.ok(Math.abs(halo - dot * 0.12) < 0.001);
});
