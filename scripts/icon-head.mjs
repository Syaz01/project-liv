// Liv's head as the app icon: the front view the app draws on a canvas
// (src/robot/paint.ts), rasterised here by hand so the icons need no browser.
// The ice shell with its shading, the dark visor, the two eyes and the
// antenna's ball in the eyes' resting white-cyan, and a thin dark outline all
// around so it reads on a light taskbar as well as on a dark one.
//
// What is drawn where is the app's own (src/robot/look.ts, imported: the
// geometry at each level of detail, the colours, the visor's outline). How it
// is shaded is paint.ts's, whose numbers are repeated in PAINT below — on a
// canvas they are arguments of gradients, here they are evaluated per sample;
// tests/icon.test.mjs holds the two together.
//
// Lengths are in R, the head's radius, from the head's centre, y down.

import {
  ROBOT_STATES, SCREEN, SHELL_ICE, STEM, VISOR, VISOR_BOTTOM, VISOR_EDGE, VISOR_TOP,
  headRadius, mix, robotGeometry, shellPalette,
} from "../src/robot/look.ts";

// ── paint.ts, in numbers ──────────────────────────────────────────────────────

export const PAINT = {
  /** paintShell: the body's radial gradient, from a small circle up and to the left to a large one. */
  shell: [-0.38, -0.44, 0.06, -0.14, -0.12, 1.3],
  /** paintShell: the darker rim, from this far out to the edge, this strong. */
  rim: { from: 0.8, alpha: 0.55 },
  /** paintShell: the highlight, a white glow of radius `r`, turned and flattened. */
  highlight: { x: -0.44, y: -0.62, turn: -0.62, flat: 0.46, r: 0.36, alpha: 0.8 },
  /** glow: how a soft light falls off, as [offset, share of its alpha]. */
  glow: [[0, 1], [0.45, 0.4], [1, 0]],
  /** paintAntenna: the stem leaves the head here, its foot this many times its top, bending this far up. */
  stem: { footY: -0.96, foot: 2, bend: 0.6 },
  /** paintAntenna: the nub the stem stands on. */
  nub: { y: -0.985, rx: 0.2, ry: 0.07 },
  /** paintLamp: where the ball is lightest, in ball radii, and how white it is there when lit. */
  lamp: { x: -0.3, y: -0.35, white: 0.75 },
  /** paintEyes: the halo around each eye. */
  eyeGlow: 0.5,
  /** paintVisor: the lighter lip of the glass. */
  lip: 0.5,
};

// ── The icon's own ────────────────────────────────────────────────────────────

/** The icon rests: the eyes' white-cyan, their cyan halo, and the antenna's ball lit in the eyes' colour. */
const EYES = ROBOT_STATES.idle.eyeColor;
const HALO = ROBOT_STATES.idle.color;
const LAMP = EYES;
/** The outline: the visor's ink, darker still. */
const OUTLINE = mix(VISOR_TOP, [0, 0, 0], 0.35);
const WHITE = [1, 1, 1];

/**
 * The levels of detail, by the icon's size: up to `small` px the app's small
 * robot (bigger eyes, a shorter antenna with a bigger ball, no highlight),
 * from `full` px the design's proportions, sliding in between. `slots` are
 * the slots at which the app draws those two (look.ts: SMALL_SLOT, FULL_SLOT).
 */
export const DETAIL = { small: 24, full: 48, slots: [24, 44] };

/** Around the figure, each side: this share of the icon, and never less than half a pixel. */
const MARGIN = 0.03;
/** The outline's width: this share of the icon, and never thinner than this many pixels. */
const OUTLINE_WIDTH = { share: 0.018, min: 0.7 };

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Where the head goes in an icon of `size` px and what is drawn of it: the
 * app's geometry for that size, the head's radius and centre in pixels, and
 * the outline's width in R. The whole figure — antenna, outline — is inside
 * the canvas with its margin, the head in the middle of the width.
 */
export function iconPlace(size) {
  const t = clamp01((size - DETAIL.small) / (DETAIL.full - DETAIL.small));
  const g = robotGeometry(headRadius(lerp(DETAIL.slots[0], DETAIL.slots[1], t)));
  const margin = Math.max(0.5, size * MARGIN);
  const outlinePx = Math.max(OUTLINE_WIDTH.min, size * OUTLINE_WIDTH.share);
  const top = -g.ballY + g.ballR;
  const R = (size - 2 * margin - 2 * outlinePx) / (top + 1);
  return { g, R, cx: size / 2, cy: margin + outlinePx + top * R, outline: outlinePx / R, margin };
}

// ── Shapes ────────────────────────────────────────────────────────────────────

/** Inside the visor's outline (look.ts: visorPoint), after it is scaled by `scale` about its middle and lifted by `lift`. */
function inVisor(g, x, y, scale = 1, lift = 0) {
  const u = Math.abs(x / scale) / (g.visorW / 2);
  const dy = (y - (g.visorY - lift)) / scale;
  const v = Math.abs(dy) / (g.visorH / 2);
  const power = dy < 0 ? VISOR.topPower : VISOR.bottomPower;
  return u ** power + v ** power <= 1;
}

/** The antenna's stem (paintAntenna): two curves from its foot in the head to its tip under the ball. */
function stemAt(g, px, y) {
  const top = Math.max(g.stemW, px) / 2;
  const foot = top * PAINT.stem.foot;
  const tipX = g.lean;
  const tipY = g.ballY;
  const y0 = PAINT.stem.footY;
  const y1 = lerp(-1, tipY, PAINT.stem.bend);
  if (y > y0 || y < tipY) return null;
  // Where along the curves this height is: they share their heights.
  const a = y0 - 2 * y1 + tipY;
  const b = 2 * (y1 - y0);
  const c = y0 - y;
  const t = Math.abs(a) < 1e-9 ? -c / b : (-b - Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a);
  const along = (x0, x1, x2) => (1 - t) ** 2 * x0 + 2 * (1 - t) * t * x1 + t ** 2 * x2;
  return [along(-foot, -top, tipX - top), along(foot, top, tipX + top)];
}

/** How far outside the figure's silhouette a point is (negative inside): the head, the stem and the ball. */
function outside(g, px, x, y) {
  const head = Math.hypot(x, y) - 1;
  const ball = Math.hypot(x - g.lean, y - g.ballY) - g.ballR;
  const stem = stemAt(g, px, y);
  return Math.min(head, ball, stem ? Math.max(stem[0] - x, x - stem[1]) : Infinity);
}

// ── Light ─────────────────────────────────────────────────────────────────────

/** Where a point falls in a canvas radial gradient between two circles, 0…1. */
function radial([x0, y0, r0, x1, y1, r1], x, y) {
  const cdx = x1 - x0;
  const cdy = y1 - y0;
  const dr = r1 - r0;
  const pdx = x - x0;
  const pdy = y - y0;
  const a = cdx * cdx + cdy * cdy - dr * dr;
  const b = -2 * (pdx * cdx + pdy * cdy + r0 * dr);
  const c = pdx * pdx + pdy * pdy - r0 * r0;
  return clamp01((-b - Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a));
}

/** The share of a glow's alpha at `d` of its radius (PAINT.glow). */
function glowAt(d) {
  for (let i = 1; i < PAINT.glow.length; i++) {
    const [from, a] = PAINT.glow[i - 1];
    const [to, b] = PAINT.glow[i];
    if (d <= to) return lerp(a, b, (d - from) / (to - from));
  }
  return 0;
}

/** `color` at `alpha` laid over `under` (both straight colours; `under` is opaque). */
const over = (under, color, alpha) => mix(under, color, clamp01(alpha));

/**
 * The colour of the figure at a point, or null outside it. `px` is one pixel
 * in R: lines are never thinner (look.ts: hairline).
 */
function colorAt(place, px, x, y) {
  const { g } = place;
  const d = outside(g, px, x, y);
  if (d > place.outline) return null;
  if (d > 0) return OUTLINE;

  const shell = shellPalette(SHELL_ICE);
  let color = OUTLINE;

  // The shell (paintShell).
  const r = Math.hypot(x, y);
  if (r <= 1) {
    const t = radial(PAINT.shell, x, y);
    color = t < 0.5 ? mix(shell.light, shell.mid, t * 2) : mix(shell.mid, shell.shadow, t * 2 - 1);
    if (g.detail > 0.01) {
      const rim = clamp01((r - PAINT.rim.from) / (1 - PAINT.rim.from));
      color = over(color, shell.rim, rim * PAINT.rim.alpha * g.detail);
      const h = PAINT.highlight;
      const dx = x - h.x;
      const dy = y - h.y;
      const along = dx * Math.cos(h.turn) + dy * Math.sin(h.turn);
      const across = (-dx * Math.sin(h.turn) + dy * Math.cos(h.turn)) / h.flat;
      color = over(color, WHITE, glowAt(Math.hypot(along, across) / h.r) * h.alpha * g.detail);
    }
  }

  // The antenna, over the shell (paintAntenna, paintLamp): the stem, the nub, the ball.
  const stem = stemAt(g, px, y);
  if (stem && x >= stem[0] && x <= stem[1]) color = STEM;
  if (g.detail > 0.01 && (x / PAINT.nub.rx) ** 2 + ((y - PAINT.nub.y) / PAINT.nub.ry) ** 2 <= 1) {
    color = over(color, shell.shadow, g.detail);
  }
  const bx = x - g.lean;
  const by = y - g.ballY;
  if (Math.hypot(bx, by) <= g.ballR) {
    const t = radial([PAINT.lamp.x, PAINT.lamp.y, 0, 0, 0, 1], bx / g.ballR, by / g.ballR);
    color = mix(mix(LAMP, WHITE, PAINT.lamp.white), LAMP, t);
  }

  // The visor and its screen (paintVisor), then the eyes behind the glass (paintEyes).
  if (!inVisor(g, x, y)) return color;
  const glass = (at) => mix(VISOR_TOP, VISOR_BOTTOM, clamp01((at - (g.visorY - g.visorH / 2)) / g.visorH));
  color = glass(y);
  if (g.detail > 0.01) {
    color = over(color, VISOR_EDGE, PAINT.lip * g.detail);
    if (inVisor(g, x, y, SCREEN.scale, SCREEN.lift)) {
      color = glass((y - (g.visorY - SCREEN.lift)) / SCREEN.scale + g.visorY);
    }
  }
  for (const side of [-1, 1]) {
    const far = Math.hypot(x - side * g.eyeX, y - g.eyeY);
    color = over(color, HALO, glowAt(far / (g.eyeR * g.eyeHalo)) * PAINT.eyeGlow);
    if (far <= g.eyeR) color = EYES;
  }
  return color;
}

// ── Pixels ────────────────────────────────────────────────────────────────────

/** Samples across each pixel, each way: more at the sizes where every pixel counts. */
const samplesFor = (size) => (size <= 64 ? 8 : 4);

/** The icon at `size` px: RGBA, straight alpha, row by row. */
export function renderIcon(size) {
  const place = iconPlace(size);
  const px = 1 / place.R;
  const n = samplesFor(size);
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      const sum = [0, 0, 0];
      let hits = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = (pxl + (sx + 0.5) / n - place.cx) / place.R;
          const y = (py + (sy + 0.5) / n - place.cy) / place.R;
          const color = colorAt(place, px, x, y);
          if (!color) continue;
          hits++;
          for (let i = 0; i < 3; i++) sum[i] += color[i];
        }
      }
      if (hits === 0) continue;
      const o = (py * size + pxl) * 4;
      for (let i = 0; i < 3; i++) out[o + i] = Math.round((sum[i] / hits) * 255);
      out[o + 3] = Math.round((hits / (n * n)) * 255);
    }
  }
  return out;
}
