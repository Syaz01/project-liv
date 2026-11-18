// Liv, drawn: a glossy ball with a dark visor, two glowing eyes and an antenna,
// and for the whole body two hands and two feet that touch nothing. Vector
// shapes on a 2D context, after the front view of the design sheets
// (design/robot-cabeza.png, design/robot-cuerpo.png). No image, no shadow
// blur: every glow is a radial gradient.
//
// The numbers are in look.ts; these functions only put them on the canvas.
// What Liv wears is drawn by its own painters (outfits.ts), in their places
// between the layers here.

import { clamp, lerp } from "../core/anim";
import {
  ARC_STROKE, EYE_SHAPES, FOOT, GAZE_EYES, GAZE_VISOR, HAND, LOVE, SCREEN, SPIRAL, STAR, STEM, VISOR_BOTTOM, VISOR_EDGE,
  VISOR_TOP, WAVE,
  antennaHalo, eyeHalfHeight, hairline, mix, placeInBox, placeInSlot, rgba, robotBounds, robotGeometry, shellPalette, stillPose,
  visorPoint,
  type EyeParams, type RGB, type RobotGeometry, type RobotPlace, type RobotPose, type ShellPalette, type StillLook,
} from "./look";
import { paintOutfit, wornBy, type Worn } from "./outfits";
import type { ParticleShape } from "./particles";

type Ctx = CanvasRenderingContext2D;

const TAU = Math.PI * 2;
const WHITE: RGB = [1, 1, 1];
/** The stem's foot is this many times as wide as its top, and starts here, inside the head. */
const STEM_FOOT = 2;
const STEM_FROM = -0.96;
/** Left, then right. */
const SIDES = [-1, 1] as const;

/** One device pixel, in the units the context draws in. */
function devicePixel(x: Ctx): number {
  const m = x.getTransform();
  return 1 / Math.max(1e-6, Math.hypot(m.a, m.b));
}

function disc(x: Ctx, cx: number, cy: number, r: number) {
  x.beginPath();
  x.arc(cx, cy, r, 0, TAU);
}

/** A soft light: `color` at `alpha` in the middle, nothing at `r`. */
function glow(x: Ctx, cx: number, cy: number, r: number, color: RGB, alpha: number) {
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.45, rgba(color, alpha * 0.4));
  g.addColorStop(1, rgba(color, 0));
  x.fillStyle = g;
  disc(x, cx, cy, r);
  x.fill();
}

/** The shell's colours across a limb `r` around the point `cx`, `cy`, lit from the upper left like the head. */
function limbFill(x: Ctx, cx: number, cy: number, r: number, shell: ShellPalette): CanvasGradient {
  const g = x.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  g.addColorStop(0, rgba(shell.light));
  g.addColorStop(0.5, rgba(shell.mid));
  g.addColorStop(1, rgba(shell.shadow));
  return g;
}

// ── Limbs ─────────────────────────────────────────────────────────────────────

// Each limb is drawn as the left one and mirrored on the right; its colours are
// laid over it afterwards, unmirrored, so the light comes from the same side.

/**
 * One foot, grown from nothing under the body to its place (`out`, 0…1 and a
 * little over), and `step` from there (in R, down positive): a foot tapping.
 */
function paintFoot(x: Ctx, R: number, side: number, out: number, step: number, shell: ShellPalette) {
  const at = clamp(out, 0, 1);
  x.save();
  x.translate(side * -lerp(FOOT.x * 0.7, FOOT.x, at) * R, (lerp(FOOT.y - 0.2, FOOT.y, at) + step) * R);
  x.save();
  x.scale(-side * out, out);
  x.rotate(FOOT.angle);
  // Along its top, down its inner side to the tip, and round the outside back up.
  const half = FOOT.half * R;
  const tipX = FOOT.tipX * R;
  const tipY = FOOT.tipY * R;
  x.beginPath();
  x.moveTo(-half, 0);
  x.lineTo(half, 0);
  x.bezierCurveTo(half * 1.15, tipY * 0.5, half, tipY, tipX, tipY);
  x.bezierCurveTo(0, tipY, -half, tipY * 0.55, -half, 0);
  x.closePath();
  x.restore();
  x.fillStyle = limbFill(x, 0, (FOOT.tipY / 2) * R, FOOT.half * R, shell);
  x.fill();
  x.restore();
}

/** The waving hand's own motion (look.ts: WAVE); the other hand has none. */
interface HandWave {
  raise: number;
  swing: number;
  wrist: number;
}

const NO_WAVE: HandWave = { raise: 0, swing: 0, wrist: 0 };

/**
 * One hand: a paddle hanging from its shoulder, swung up and out by `lift`.
 * Waving, its shoulder floats up beside the head, the arm swings there and
 * the hand turns on its own middle: the wrist, bent by `flick` besides.
 */
function paintHand(
  x: Ctx, R: number, side: number, out: number, lift: number, wave: HandWave, flick: number, shell: ShellPalette,
) {
  const at = clamp(out, 0, 1);
  const angle = HAND.angle + HAND.lift * lift + WAVE.turn * wave.raise + wave.swing;
  x.save();
  x.translate(
    side * -(lerp(HAND.pivotX * 0.82, HAND.pivotX, at) + WAVE.dx * wave.raise) * R,
    (HAND.pivotY + WAVE.dy * wave.raise) * R,
  );
  x.save();
  x.scale(-side, 1);
  x.rotate(angle);
  x.translate(0, HAND.arm * R);
  x.rotate(wave.wrist + flick);
  x.scale(out, out);
  const top = -HAND.half * R;
  const bottom = HAND.half * R;
  x.beginPath();
  x.arc(0, top, HAND.topR * R, Math.PI, 0);
  x.lineTo(HAND.bottomR * R, bottom);
  x.arc(0, bottom, HAND.bottomR * R, 0, Math.PI);
  x.closePath();
  x.restore();
  // The light falls across the hand wherever it has swung to.
  x.fillStyle = limbFill(
    x, side * Math.sin(angle) * HAND.arm * R, Math.cos(angle) * HAND.arm * R, (HAND.half + HAND.bottomR) * R, shell,
  );
  x.fill();
  x.restore();
}

// ── Head ──────────────────────────────────────────────────────────────────────

function paintShell(x: Ctx, R: number, g: RobotGeometry, shell: ShellPalette) {
  disc(x, 0, 0, R);
  const body = x.createRadialGradient(-0.38 * R, -0.44 * R, 0.06 * R, -0.14 * R, -0.12 * R, 1.3 * R);
  body.addColorStop(0, rgba(shell.light));
  body.addColorStop(0.5, rgba(shell.mid));
  body.addColorStop(1, rgba(shell.shadow));
  x.fillStyle = body;
  x.fill();
  if (g.detail < 0.01) return;

  // The darker rim, then the highlight near the top left: both inside the ball.
  x.save();
  x.clip();
  const rim = x.createRadialGradient(0, 0, 0.8 * R, 0, 0, R);
  rim.addColorStop(0, rgba(shell.rim, 0));
  rim.addColorStop(1, rgba(shell.rim, 0.55 * g.detail));
  x.fillStyle = rim;
  x.fill();
  x.translate(-0.44 * R, -0.62 * R);
  x.rotate(-0.62);
  x.scale(1, 0.46);
  glow(x, 0, 0, 0.36 * R, WHITE, 0.8 * g.detail);
  x.restore();
}

/** The visor's outline: enough straight steps to read as a curve at any size. */
const VISOR_STEPS = 56;

function visorPath(x: Ctx, R: number, g: RobotGeometry) {
  x.beginPath();
  for (let i = 0; i < VISOR_STEPS; i++) {
    const [px, py] = visorPoint(g, (i / VISOR_STEPS) * TAU);
    if (i === 0) x.moveTo(px * R, py * R);
    else x.lineTo(px * R, py * R);
  }
  x.closePath();
}

function paintVisor(x: Ctx, R: number, g: RobotGeometry) {
  const glass = x.createLinearGradient(0, (g.visorY - g.visorH / 2) * R, 0, (g.visorY + g.visorH / 2) * R);
  glass.addColorStop(0, rgba(VISOR_TOP));
  glass.addColorStop(1, rgba(VISOR_BOTTOM));
  visorPath(x, R, g);
  x.fillStyle = glass;
  x.fill();
  if (g.detail < 0.01) return;

  // The lip of the glass: a lighter visor, and the screen again inside it,
  // a little smaller and a little higher.
  x.save();
  x.clip();
  x.fillStyle = rgba(VISOR_EDGE, 0.5 * g.detail);
  x.fill();
  x.translate(0, (g.visorY - SCREEN.lift) * R);
  x.scale(SCREEN.scale, SCREEN.scale);
  x.translate(0, -g.visorY * R);
  visorPath(x, R, g);
  x.fillStyle = glass;
  x.fill();
  x.restore();
}

/** The straight steps in one turn of the spiral. */
const SPIRAL_STEPS = 20;

/** A heart around the origin, `hw` and `hh` its half width and half height: its point down. */
function heartPath(x: Ctx, hw: number, hh: number) {
  x.moveTo(0, hh);
  x.bezierCurveTo(-hw * 0.55, hh * 0.55, -hw, hh * 0.1, -hw, -hh * 0.35);
  x.bezierCurveTo(-hw, -hh * 1.05, -hw * 0.1, -hh * 1.05, 0, -hh * 0.42);
  x.bezierCurveTo(hw * 0.1, -hh * 1.05, hw, -hh * 1.05, hw, -hh * 0.35);
  x.bezierCurveTo(hw, hh * 0.1, hw * 0.55, hh * 0.55, 0, hh);
  x.closePath();
}

/**
 * One eye, centred on the origin, `r` its radius at rest: the one painter of
 * every shape. A new shape is a new row in EYE_SHAPES, or a new `form` here.
 */
export function paintEye(x: Ctx, r: number, shape: EyeParams, blink: number, color: RGB, px: number) {
  const hw = shape.w * r;
  const hh = Math.max(eyeHalfHeight(shape, blink) * r, px / 2);
  x.beginPath();
  if (shape.form === "spiral") {
    // Dizzy: a line winding out from the middle, drawn with a round pen.
    const stroke = hairline(SPIRAL.stroke * r, px);
    const reach = hw - stroke / 2;
    const steps = Math.round(SPIRAL.turns * SPIRAL_STEPS);
    x.moveTo(0, 0);
    for (let i = 1; i <= steps; i++) {
      const a = (i / SPIRAL_STEPS) * TAU;
      const d = (i / steps) * reach;
      x.lineTo(Math.cos(a) * d, Math.sin(a) * d);
    }
    x.strokeStyle = rgba(color);
    x.lineWidth = stroke;
    x.lineCap = "round";
    x.lineJoin = "round";
    x.stroke();
    return;
  }
  if (shape.form === "heart") {
    heartPath(x, hw, hh);
    x.fillStyle = rgba(color);
    x.fill();
    return;
  }
  if (shape.form === "arc") {
    // A happy eye: ^, drawn with a round pen.
    x.moveTo(-hw, hh * 0.6);
    x.quadraticCurveTo(0, -hh * 1.9, hw, hh * 0.6);
    x.strokeStyle = rgba(color);
    x.lineWidth = hairline(ARC_STROKE * r, px);
    x.lineCap = "round";
    x.stroke();
    return;
  }
  if (shape.form === "bar") {
    x.roundRect(-hw, -hh, hw * 2, hh * 2, hh);
  } else {
    // The lid cuts the top off straight: what is left starts lower on each side.
    const from = Math.asin(clamp(shape.lid * 2 - 1, -1, 1));
    x.ellipse(0, 0, hw, hh, 0, from, Math.PI - from);
    x.closePath();
  }
  x.fillStyle = rgba(color);
  x.fill();
}

function paintEyes(x: Ctx, R: number, g: RobotGeometry, pose: RobotPose, px: number) {
  const shape = EYE_SHAPES[pose.eyes.shape];
  const alpha = clamp(pose.eyeAlpha, 0, 1);
  // The eyes are lights behind the glass: nothing of them shows outside it.
  x.save();
  visorPath(x, R, g);
  x.clip();
  SIDES.forEach((side, i) => {
    const r = g.eyeR * R * pose.eyes.scale[i] * pose.eyeScale;
    const ex = (side * g.eyeX + pose.gaze[0] * GAZE_EYES[0]) * R;
    const ey = (g.eyeY + pose.gaze[1] * GAZE_EYES[1]) * R;
    glow(x, ex, ey, r * g.eyeHalo * Math.max(shape.w, 1), pose.eyeHalo, 0.5 * alpha);
    x.save();
    x.translate(ex, ey);
    // A slanted or a turning eye is the mirror image of the other one.
    const turn = shape.slant + (shape.form === "spiral" ? pose.eyeTurn : 0);
    if (turn !== 0) {
      x.scale(-side, 1);
      x.rotate(turn);
    }
    x.globalAlpha = alpha;
    paintEye(x, r, shape, pose.blink, pose.eyeColor, px);
    x.restore();
  });
  x.restore();
}

/**
 * The antenna. `worn` is what Liv has on: a cap the stem comes out through
 * raises its foot and hides the nub, and a light of another shape takes the
 * ball's place — each by as much as the thing is on.
 */
function paintAntenna(
  x: Ctx, R: number, g: RobotGeometry, pose: RobotPose, shell: ShellPalette, px: number, worn: Worn | null,
) {
  const tipX = (g.lean + pose.sway[0]) * R;
  const tipY = (g.ballY + pose.sway[1]) * R;
  const ballR = g.ballR * R;
  const on = worn ? clamp(worn.on, 0, 1) : 0;
  const through = worn?.def.antennaFrom;
  const capped = through == null ? 0 : on;

  // The stem, from inside the head, wider at its foot: it bends when its tip trails the body.
  const top = hairline(g.stemW * R, px) / 2;
  const foot = top * STEM_FOOT;
  const from = (through == null ? STEM_FROM : lerp(STEM_FROM, through, capped)) * R;
  const bendY = lerp(-R, tipY, 0.6);
  x.beginPath();
  x.moveTo(-foot, from);
  x.quadraticCurveTo(-top, bendY, tipX - top, tipY);
  x.lineTo(tipX + top, tipY);
  x.quadraticCurveTo(top, bendY, foot, from);
  x.closePath();
  x.fillStyle = rgba(STEM);
  x.fill();

  // The nub it stands on, part of the shell.
  const nub = g.detail * (1 - capped);
  if (nub > 0.01) {
    x.save();
    x.globalAlpha = nub;
    x.beginPath();
    x.ellipse(0, -0.985 * R, 0.2 * R, 0.07 * R, 0, 0, TAU);
    x.fillStyle = rgba(shell.shadow);
    x.fill();
    x.restore();
  }

  const lamp = worn?.def.lamp;
  if (!worn || !lamp) {
    paintLamp(x, tipX, tipY, ballR, pose.antennaColor, pose.glow);
    return;
  }
  // The same light in another shape, under the ball's own halo: the ball
  // shrinks away as the shape grows out of it.
  lampHalo(x, tipX, tipY, ballR, pose.antennaColor, pose.glow);
  if (on < 0.99) lampBody(x, tipX, tipY, ballR * (1 - on), pose.antennaColor, pose.glow, disc);
  lampBody(x, tipX, tipY, ballR * lamp.reach(g.detail) * worn.on, pose.antennaColor, pose.glow, lamp.path);
}

/** The halo of the antenna's light when it glows (0 off … 1 lit, more for a flash), for a ball of `r`. */
function lampHalo(x: Ctx, cx: number, cy: number, r: number, color: RGB, light: number) {
  if (light > 0.01) glow(x, cx, cy, r * antennaHalo(light), color, 0.6 * Math.min(1.4, light));
}

/** The light itself: `path` around `cx`, `cy` out to `r`, lighter towards its upper left, more so when lit. */
function lampBody(
  x: Ctx, cx: number, cy: number, r: number, color: RGB, light: number,
  path: (x: Ctx, cx: number, cy: number, r: number) => void,
) {
  const lit = clamp(light, 0, 1);
  const ball = x.createRadialGradient(cx - r * 0.3, cy - r * 0.35, 0, cx, cy, r);
  ball.addColorStop(0, rgba(mix(color, WHITE, 0.25 + 0.5 * lit)));
  ball.addColorStop(1, rgba(color));
  x.fillStyle = ball;
  path(x, cx, cy, r);
  x.fill();
}

/**
 * The antenna's light: a ball of `r` around `cx`, `cy` in `color`, with its
 * halo when it glows (0 off … 1 lit, more for a flash). The drop sequence
 * draws it alone, riding the progress bar (upload/canvas.ts).
 */
export function paintLamp(x: Ctx, cx: number, cy: number, r: number, color: RGB, light: number) {
  lampHalo(x, cx, cy, r, color, light);
  lampBody(x, cx, cy, r, color, light, disc);
}

// ── Hearts and stars ──────────────────────────────────────────────────────────

/** The points of a star, and how deep it is cut between them. */
const STAR_POINTS = 5;
const STAR_WAIST = 0.46;

/** A heart or a star that has left Liv (particles.ts), around a head of radius `R` centred on the origin. */
export function paintParticle(x: Ctx, R: number, p: ParticleShape) {
  if (p.alpha <= 0.01) return;
  const size = p.size * R;
  x.save();
  x.translate(p.x * R, p.y * R);
  x.rotate(p.turn);
  x.globalAlpha = clamp(p.alpha, 0, 1);
  x.beginPath();
  if (p.kind === "heart") {
    heartPath(x, size, size * 0.92);
    x.fillStyle = rgba(LOVE);
  } else {
    for (let i = 0; i < STAR_POINTS * 2; i++) {
      const a = (i / (STAR_POINTS * 2)) * TAU - Math.PI / 2;
      const d = i % 2 === 0 ? size : size * STAR_WAIST;
      if (i === 0) x.moveTo(Math.cos(a) * d, Math.sin(a) * d);
      else x.lineTo(Math.cos(a) * d, Math.sin(a) * d);
    }
    x.closePath();
    x.fillStyle = rgba(STAR);
  }
  x.fill();
  x.restore();
}

// ── The whole robot ───────────────────────────────────────────────────────────

/** The robot in `pose`, its head of radius `R` px centred on the origin. */
export function paintRobot(x: Ctx, R: number, pose: RobotPose) {
  const g = robotGeometry(R);
  const px = devicePixel(x);
  const shell = shellPalette(pose.shell);
  const worn = wornBy(pose, R, g, px);

  x.save();
  // Squash and stretch from the ground up: the feet stay where they stand.
  const ground = lerp(1, robotBounds(g, "body").bottom, clamp(pose.feet, 0, 1)) * R;
  x.translate(0, ground);
  x.scale(pose.stretch[0], pose.stretch[1]);
  x.translate(0, -ground);

  if (pose.feet > 0.01) SIDES.forEach((side, i) => paintFoot(x, R, side, pose.feet, pose.step[i], shell));
  if (pose.hands > 0.01) {
    SIDES.forEach((side, i) => {
      paintHand(x, R, side, pose.hands, pose.lift + pose.reach[i], side < 0 ? pose : NO_WAVE, pose.flick[i], shell);
    });
  }

  x.rotate(pose.tilt);
  paintShell(x, R, g, shell);
  if (worn) paintOutfit(x, worn, "behind");
  // A cap goes on over the glass and the antenna comes out through it: with
  // one on, the antenna is painted after it. Otherwise the two never overlap.
  const through = worn?.def.antennaFrom != null;
  if (g.antenna > 0.01 && !through) paintAntenna(x, R, g, pose, shell, px, worn);
  // The visor turns a little with the eyes: the head turning.
  x.save();
  x.translate(pose.gaze[0] * GAZE_VISOR * R, pose.gaze[1] * GAZE_VISOR * R);
  paintVisor(x, R, g);
  if (pose.eyeAlpha > 0.01) paintEyes(x, R, g, pose, px);
  if (worn) paintOutfit(x, worn, "onVisor");
  x.restore();
  if (worn) paintOutfit(x, worn, "over");
  if (g.antenna > 0.01 && through) paintAntenna(x, R, g, pose, shell, px, worn);
  x.restore();
}

function paintAt(x: Ctx, place: RobotPlace, look: StillLook) {
  x.save();
  x.translate(place.cx, place.cy);
  paintRobot(x, place.R, stillPose(look));
  x.restore();
}

/** A still robot in a square of `size`, placed as the engine places it: its slot is 0.6 of the square. */
export function paintSlotRobot(x: Ctx, size: number, look: StillLook = {}) {
  paintAt(x, placeInSlot(size, look.model ?? "head"), look);
}

/** A still robot as big as it goes in a box of `w` × `h`. */
export function paintBoxRobot(x: Ctx, w: number, h: number, look: StillLook = {}) {
  paintAt(x, placeInBox(w, h, look.model ?? "head"), look);
}
