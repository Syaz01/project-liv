// The app icon (scripts/icon-head.mjs, written out by scripts/gen-icons.mjs):
// Liv's head, drawn from the app's own geometry. Where the figure sits in the
// icon at each size, what is drawn of it at each size, what the pixels are —
// and that the shading numbers the script repeats are still the ones the app
// paints with (src/robot/paint.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DETAIL, PAINT, iconPlace, renderIcon } from "../scripts/icon-head.mjs";
import {
  ROBOT_STATES, SHELL_ICE, VISOR_TOP, headRadius, lodFor, robotGeometry, stillPose,
} from "../src/robot/look.ts";
import { paintRobot } from "../src/robot/paint.ts";

/** Every size the icon is written at (gen-icons.mjs): the PNGs and the ICO's entries. */
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

/** Each size is drawn once for all the tests that look at it. */
const drawn = new Map();
function iconAt(size) {
  if (!drawn.has(size)) drawn.set(size, renderIcon(size));
  return drawn.get(size);
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The pixel of `icon` (of `size`) at `x`, `y`: its colour, 0…1, and its alpha, 0…255. */
function pixel(icon, size, x, y) {
  const o = (Math.floor(y) * size + Math.floor(x)) * 4;
  return { color: [icon[o] / 255, icon[o + 1] / 255, icon[o + 2] / 255], alpha: icon[o + 3] };
}

/** The box of the pixels that are not transparent. */
function inked(icon, size) {
  const box = { left: size, top: size, right: -1, bottom: -1 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (icon[(y * size + x) * 4 + 3] === 0) continue;
      box.left = Math.min(box.left, x);
      box.right = Math.max(box.right, x);
      box.top = Math.min(box.top, y);
      box.bottom = Math.max(box.bottom, y);
    }
  }
  return box;
}

// ── Where it sits ─────────────────────────────────────────────────────────────

test("at every size the whole figure is inside the icon, with a margin, the head in the middle", () => {
  for (const size of SIZES) {
    const { g, R, cx, cy, outline, margin } = iconPlace(size);
    const edge = outline * R;
    assert.ok(margin >= 0.5, `${size}: half a pixel at least`);
    assert.ok(margin <= size * 0.04, `${size}: a small margin`);
    assert.equal(cx, size / 2, `${size}: the head is centred`);
    const top = cy - (-g.ballY + g.ballR) * R - edge;
    const bottom = cy + R + edge;
    assert.ok(near(top, margin), `${size}: the antenna's ball reaches the top margin`);
    assert.ok(near(bottom, size - margin), `${size}: the head reaches the bottom margin`);
    assert.ok(cx - R - edge >= margin && cx + R + edge <= size - margin, `${size}: clear of the sides`);
    assert.ok(R * 2 >= size * 0.62, `${size}: and the head is most of the icon`);
  }
});

test("the outline is thin, and never less than a line that shows", () => {
  for (const size of SIZES) {
    const { R, outline } = iconPlace(size);
    const px = outline * R;
    assert.ok(px >= 0.7, `${size}: ${px} px`);
    assert.ok(px <= size * 0.05, `${size}: thin`);
  }
});

// ── What is drawn at each size ────────────────────────────────────────────────

test("up to 24 px the small robot, from 48 px the design's proportions, as in the app", () => {
  const small = robotGeometry(headRadius(DETAIL.slots[0]));
  const full = robotGeometry(headRadius(DETAIL.slots[1]));
  // The app's own levels are still where the icon takes them from.
  assert.equal(lodFor(headRadius(DETAIL.slots[0])), "small");
  assert.equal(small.detail, 0);
  assert.equal(full.detail, 1);
  for (const size of [16, 20, 24]) assert.deepEqual(iconPlace(size).g, small, `${size} px`);
  for (const size of [48, 64, 128, 256, 512]) assert.deepEqual(iconPlace(size).g, full, `${size} px`);
  // Simplified: bigger eyes, a shorter antenna with a bigger ball, no fine detail.
  assert.ok(small.eyeR > full.eyeR && small.ballR > full.ballR && -small.ballY < -full.ballY);
  const between = iconPlace(32).g;
  assert.ok(between.detail > 0 && between.detail < 1);
  assert.ok(between.eyeR < small.eyeR && between.eyeR > full.eyeR);
});

// ── The pixels ────────────────────────────────────────────────────────────────

test("the icon is the head: ice shell, dark visor, two bright eyes, the antenna's ball lit like them", () => {
  for (const size of SIZES) {
    const icon = iconAt(size);
    assert.equal(icon.length, size * size * 4);
    const { g, R, cx, cy } = iconPlace(size);
    const at = (x, y) => pixel(icon, size, cx + x * R, cy + y * R);

    const eyes = ROBOT_STATES.idle.eyeColor;
    for (const side of [-1, 1]) {
      const eye = at(side * g.eyeX, g.eyeY);
      assert.equal(eye.alpha, 255);
      assert.ok(luminance(eye.color) > 0.75, `${size}: an eye is bright (${eye.color})`);
    }
    if (size >= 32) assert.ok(at(g.eyeX, g.eyeY).color.every((c, i) => near(c, eyes[i], 0.02)), `${size}: the eyes' own colour`);

    // Between and under the eyes: the glass.
    const glass = at(0, g.visorY + g.visorH * 0.3);
    assert.ok(luminance(glass.color) < 0.3, `${size}: the visor is dark (${glass.color})`);
    assert.ok(glass.color[2] > glass.color[0], `${size}: and blue-green, not grey`);

    // The ring of shell above the visor, on the lit side.
    const shell = at(-0.45, -0.72);
    assert.equal(shell.alpha, 255);
    assert.ok(luminance(shell.color) > 0.6, `${size}: the shell is light (${shell.color})`);

    const ball = at(g.lean, g.ballY);
    assert.ok(ball.alpha > 200 && luminance(ball.color) > 0.6, `${size}: the antenna's ball is lit (${ball.color})`);
  }
});

test("nothing is drawn outside the figure: the corners are clear, and the ink ends at the margin", () => {
  for (const size of SIZES) {
    const icon = iconAt(size);
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
      assert.equal(pixel(icon, size, x, y).alpha, 0, `${size}: corner ${x},${y}`);
    }
    const { R, cx, outline, margin } = iconPlace(size);
    const box = inked(icon, size);
    const reach = R + outline * R;
    // To the pixel the figure ends in, or the one before when it only grazes that one.
    const starts = (first, edge) => first === Math.floor(edge) || first === Math.floor(edge) + 1;
    const ends = (last, edge) => last === Math.ceil(edge) - 1 || last === Math.ceil(edge) - 2;
    assert.ok(starts(box.top, margin), `${size}: top ${box.top}`);
    assert.ok(ends(box.bottom, size - margin), `${size}: bottom ${box.bottom}`);
    assert.ok(starts(box.left, cx - reach), `${size}: left ${box.left}`);
    assert.ok(ends(box.right, cx + reach), `${size}: right ${box.right}`);
    // As far from the left edge as from the right one.
    assert.equal(box.left, size - 1 - box.right, `${size}: centred`);
  }
});

test("a dark outline goes all around, so the light shell reads on a light taskbar", () => {
  for (const size of SIZES) {
    const icon = iconAt(size);
    const { R, cx, cy, outline } = iconPlace(size);
    // Half-way into the outline, at eight points of the head's edge away from the antenna.
    for (const angle of [0, 0.5, 1, 2.2, 2.7, 3.14, 3.6, -0.5]) {
      const d = R * (1 + outline / 2);
      const p = pixel(icon, size, cx + Math.cos(angle) * d, cy + Math.sin(angle) * d);
      assert.ok(p.alpha > 0, `${size}: inked at ${angle}`);
      assert.ok(luminance(p.color) < luminance(SHELL_ICE) - 0.3, `${size}: darker than the shell at ${angle} (${p.color})`);
    }
  }
  // What the tray's update tint leaves alone (src-tauri/src/tray.rs: tint_blue) is what is darker than 0.35.
  const icon = iconAt(256);
  const { R, cx, cy, outline } = iconPlace(256);
  const rim = pixel(icon, 256, cx + R * (1 + outline / 2), cy);
  assert.ok(luminance(rim.color) < 0.35, "the outline stays dark when the tray icon turns blue");
  assert.ok(luminance(VISOR_TOP) < 0.35, "and so does the visor");
  assert.ok(luminance(pixel(icon, 256, cx - 0.45 * R, cy - 0.72 * R).color) > 0.6, "while the shell takes the blue");
});

test("the small icons are the same on both sides", () => {
  // The small robot's antenna does not lean: the tray's 16 px is symmetric to the pixel.
  for (const size of [16, 24]) {
    const icon = iconAt(size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size / 2; x++) {
        const a = pixel(icon, size, x, y);
        const b = pixel(icon, size, size - 1 - x, y);
        assert.equal(a.alpha, b.alpha, `${size}: alpha at ${x},${y}`);
      }
    }
  }
});

// ── The same shading as the app ───────────────────────────────────────────────

/** A 2D context that paints nothing and keeps what the painters ask of it. */
function capture() {
  const seen = { radial: [], fills: [], ellipses: [], moves: [], curves: [], transforms: [] };
  const gradient = (at) => {
    const g = { at, stops: [], addColorStop: (offset, color) => g.stops.push([offset, color]) };
    return g;
  };
  let fillStyle = null;
  const ctx = new Proxy({}, {
    get(_, key) {
      switch (key) {
        case "getTransform": return () => ({ a: 1, b: 0 });
        case "createRadialGradient": return (...at) => {
          const g = gradient(at);
          seen.radial.push(g);
          return g;
        };
        case "createLinearGradient": return (...at) => gradient(at);
        case "ellipse": return (...args) => seen.ellipses.push(args);
        case "moveTo": return (...args) => seen.moves.push(args);
        case "quadraticCurveTo": return (...args) => seen.curves.push(args);
        case "translate": case "rotate": case "scale": return (...args) => seen.transforms.push([key, ...args]);
        case "fill": return () => seen.fills.push(fillStyle);
        default: return () => {};
      }
    },
    set(_, key, value) {
      if (key === "fillStyle") fillStyle = value;
      return true;
    },
  });
  return { ctx, seen };
}

/** The alpha of an `rgba(…)` colour. */
const alphaOf = (color) => Number(/,([\d.]+)\)$/.exec(color)[1]);

test("the numbers the icon repeats are the ones the app paints with", () => {
  const R = 100;
  const { ctx, seen } = capture();
  // Lit, as the icon's antenna is.
  paintRobot(ctx, R, stillPose({ state: "working" }));
  const g = robotGeometry(R);
  assert.equal(g.detail, 1);
  const radial = (at) => seen.radial.find((r) => r.at.every((v, i) => near(v, at[i] * R, 1e-6)));

  // paintShell: the body, the rim, the highlight.
  assert.ok(radial(PAINT.shell), "the shell's gradient");
  const rim = radial([0, 0, PAINT.rim.from, 0, 0, 1]);
  assert.ok(rim, "the rim starts where it does");
  assert.equal(alphaOf(rim.stops.at(-1)[1]), PAINT.rim.alpha);
  const h = PAINT.highlight;
  const moved = seen.transforms.findIndex((t) => t[0] === "translate" && near(t[1], h.x * R) && near(t[2], h.y * R));
  assert.ok(moved >= 0, "the highlight is where it is");
  assert.deepEqual(seen.transforms.slice(moved + 1, moved + 3), [["rotate", h.turn], ["scale", 1, h.flat]]);
  const light = radial([0, 0, 0, 0, 0, h.r]);
  assert.ok(light, "and as big");
  // glow: how every soft light falls off.
  assert.deepEqual(light.stops.map(([offset]) => offset), PAINT.glow.map(([offset]) => offset));
  light.stops.forEach(([, color], i) => assert.ok(near(alphaOf(color), h.alpha * PAINT.glow[i][1]), `stop ${i}`));

  // paintAntenna: the stem and the nub. paintLamp: the ball.
  const foot = seen.moves.find(([, y]) => near(y, PAINT.stem.footY * R));
  assert.ok(foot, "the stem leaves the head where it does");
  const top = g.stemW * R / 2;
  assert.ok(near(-foot[0], top * PAINT.stem.foot), "its foot as wide");
  const bend = seen.curves.find(([x]) => near(x, -top));
  assert.ok(near(bend[1], -R + (g.ballY * R + R) * PAINT.stem.bend), "bending as far up");
  assert.ok(seen.ellipses.some(([x, y, rx, ry]) => x === 0 && near(y, PAINT.nub.y * R) && near(rx, PAINT.nub.rx * R) && near(ry, PAINT.nub.ry * R)), "the nub");
  const ballR = g.ballR * R;
  const lamp = radial([g.lean + PAINT.lamp.x * g.ballR, g.ballY + PAINT.lamp.y * g.ballR, 0, g.lean, g.ballY, g.ballR]);
  assert.ok(lamp, "the ball is lightest where it is");
  assert.ok(ballR > 0);
  const lit = ROBOT_STATES.working.color;
  const white = lit.map((c) => Math.round((c + (1 - c) * PAINT.lamp.white) * 255));
  assert.equal(lamp.stops[0][1], `rgba(${white.join(",")},1)`, "and as white there");

  // paintVisor: the lip. paintEyes: the halo.
  assert.ok(seen.fills.some((f) => typeof f === "string" && f === "rgba(95,169,186,0.5)"), "the glass's lip");
  assert.equal(PAINT.lip, 0.5);
  const halo = radial([g.eyeX, g.eyeY, 0, g.eyeX, g.eyeY, g.eyeR * g.eyeHalo]);
  assert.ok(halo, "an eye's halo");
  assert.equal(alphaOf(halo.stops[0][1]), PAINT.eyeGlow);
});
