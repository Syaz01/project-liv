// Liv's look, in numbers: the shell's colours, what each state shows on the
// antenna and in the eyes, how big the head is in the room it is given, what
// is drawn at each size, the shapes an eye can take and where the eyes look.
// No canvas here: the painters (paint.ts) and the engine (robot.ts) read these.
//
// Every length is in units of R, the head's radius, from the head's centre.

import { clamp, lerp, seg } from "../core/anim";
import type { BotStateName } from "../core/layout";
import type { Outfit } from "./outfits";

// ── Colours ───────────────────────────────────────────────────────────────────

export type RGB = readonly [number, number, number]; // components 0…1

export function hexToRGB(hex: string): RGB {
  const h = hex.replace("#", "");
  const v = parseInt(h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export const rgba = (c: RGB, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

export const mix = (a: RGB, b: RGB, t: number): RGB => [
  lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t),
];

/** How much of the way a follower covers in `dt` seconds: nearly all of it in half a second. */
export const followShare = (dt: number) => 1 - Math.pow(0.002, dt);

/** `color` after `dt` seconds on its way to `target`: an exponential follower. */
export function followColor(color: RGB, target: RGB, dt: number): RGB {
  return mix(color, target, followShare(dt));
}

const WHITE: RGB = [1, 1, 1];

// ── The shell ─────────────────────────────────────────────────────────────────

/** The shell's default colour, "ice": a near-white with a teal undertone. */
export const SHELL_ICE = hexToRGB("#EDF4F6");
/** The teal of the design sheets, kept for comparison (dev/robot-preview.html). */
export const SHELL_TEAL = hexToRGB("#2ECFD4");

/** The visor's glass, top and bottom: it never takes the shell's colour. */
export const VISOR_TOP = hexToRGB("#0F3341");
export const VISOR_BOTTOM = hexToRGB("#154856");
/** The lighter edge at the top of the visor, where the glass catches the light. */
export const VISOR_EDGE = hexToRGB("#5FA9BA");
/** The antenna's stem, and its ball while it is off: neutrals that suit any shell. */
export const STEM = hexToRGB("#7F959D");
export const ANTENNA_OFF = hexToRGB("#66797F");

export interface ShellPalette {
  /** Where the light falls, the upper left. */
  light: RGB;
  mid: RGB;
  /** The side away from the light. */
  shadow: RGB;
  /** The darker edge all around. */
  rim: RGB;
}

/**
 * The shell's tones from its one colour: the colour itself where the light
 * falls, then the same colour sinking into the visor's ink — which darkens it
 * and cools it at once, as the design's teal does on its shadow side.
 */
export function shellPalette(base: RGB): ShellPalette {
  return {
    light: base,
    mid: mix(base, VISOR_TOP, 0.18),
    shadow: mix(base, VISOR_TOP, 0.44),
    rim: mix(base, VISOR_TOP, 0.62),
  };
}

// ── The eyes' shapes ──────────────────────────────────────────────────────────

export type EyeShape =
  | "round" | "wide" | "narrow" | "bar" | "arc" | "half" | "closed"
  // What Liv's eyes do for itself, whatever the state: annoyed, dizzy, in love.
  | "angry" | "spiral" | "heart";

export interface EyeParams {
  /**
   * What is drawn: a filled ellipse, a filled bar with round ends, a stroked
   * arc (^), a stroked spiral, or a filled heart.
   */
  form: "ellipse" | "bar" | "arc" | "spiral" | "heart";
  /** Half its width and half its height, in eye radii. For an arc, `h` is how far it rises. */
  w: number;
  h: number;
  /** How much of the top the lid covers, 0…1: a straight cut. */
  lid: number;
  /** An open eye blinks; one already shut or smiling does not. */
  blinks: boolean;
  /** How far it is turned, radians, its inner end down: the two eyes mirror each other. */
  slant: number;
}

export const EYE_SHAPES: Record<EyeShape, EyeParams> = {
  round: { form: "ellipse", w: 1, h: 1, lid: 0, blinks: true, slant: 0 },
  wide: { form: "ellipse", w: 1.2, h: 1.2, lid: 0, blinks: true, slant: 0 },
  narrow: { form: "ellipse", w: 1, h: 0.8, lid: 0, blinks: true, slant: 0 },
  bar: { form: "bar", w: 1.05, h: 0.3, lid: 0, blinks: false, slant: 0 },
  arc: { form: "arc", w: 1, h: 0.62, lid: 0, blinks: false, slant: 0 },
  half: { form: "ellipse", w: 1, h: 1, lid: 0.5, blinks: true, slant: 0 },
  closed: { form: "bar", w: 1.05, h: 0.13, lid: 0, blinks: false, slant: 0 },
  // Two bars slanted inward: a frown.
  angry: { form: "bar", w: 1.05, h: 0.26, lid: 0, blinks: false, slant: 0.42 },
  spiral: { form: "spiral", w: 1.1, h: 1.1, lid: 0, blinks: false, slant: 0 },
  heart: { form: "heart", w: 1.2, h: 1.1, lid: 0, blinks: false, slant: 0 },
};

/** The stroke of the arc, in eye radii. */
export const ARC_STROKE = 0.42;
/** The spiral: how many times it goes round from its middle to its edge, and its stroke in eye radii. */
export const SPIRAL = { turns: 1.75, stroke: 0.27 } as const;

/** Half the height of an eye `blink` of the way shut (0 open … 1 shut), in eye radii. */
export function eyeHalfHeight(shape: EyeParams, blink: number): number {
  return shape.blinks ? lerp(shape.h, EYE_SHAPES.closed.h, clamp(blink, 0, 1)) : shape.h;
}

/** The eyes of a face: their shape, and each one's size (left, right). */
export interface EyeLook {
  shape: EyeShape;
  scale: readonly [number, number];
}

export const eyeKey = (e: EyeLook) => `${e.shape}|${e.scale[0]}|${e.scale[1]}`;

/** One shape gives way to the next in this long: no hard cut, no slow morph. */
export const EYE_SWAP_MS = 160;
/** The share of the swap in which the old shape shrinks away. */
const EYE_SWAP_OUT = 0.4;
const EYE_SWAP_SMALL = 0.55;

/**
 * Where a swap of shapes stands `t` of the way through (0…1): the old shape
 * shrinks and fades, then the new one grows in.
 */
export function eyeSwap(t: number): { old: boolean; scale: number; alpha: number } {
  if (t < EYE_SWAP_OUT) {
    const k = t / EYE_SWAP_OUT;
    return { old: true, scale: lerp(1, EYE_SWAP_SMALL, k), alpha: 1 - k };
  }
  const k = clamp((t - EYE_SWAP_OUT) / (1 - EYE_SWAP_OUT), 0, 1);
  return { old: false, scale: lerp(EYE_SWAP_SMALL, 1, k), alpha: k };
}

// ── The states ────────────────────────────────────────────────────────────────

export type BadgeKind = "dots" | "bang" | "question" | "dot" | "arrow";

export interface Badge {
  kind: BadgeKind;
  color: RGB;
}

export interface RobotLook {
  /** The state's colour: the antenna's ball, the eyes' halo, the badge. */
  color: RGB;
  /** The eyes' own colour: the state's, lightened so they stay bright. */
  eyeColor: RGB;
  /** How lit the antenna is, 0 (off: a dim neutral ball, no halo) … 1. */
  antenna: number;
  /** Seconds for one breath of the antenna's halo while Liv is alive; 0 = steady. */
  pulse: number;
  eyes: EyeLook;
  /** Where the eyes rest, in gaze units (−1…1); null = on the pointer. */
  gaze: readonly [number, number] | null;
  /** The head's tilt, radians. */
  tilt: number;
  badge: Badge | null;
}

const C = {
  working: [0.231, 0.62, 1] as RGB,
  thinking: [0.545, 0.361, 0.965] as RGB,
  approval: [0.961, 0.647, 0.141] as RGB,
  question: [0.133, 0.827, 0.933] as RGB,
  error: [0.957, 0.314, 0.369] as RGB,
  finished: [0.204, 0.831, 0.6] as RGB,
  ratelimit: [0.984, 0.573, 0.235] as RGB,
};

/** The resting eyes: a soft white-cyan, with a cyan halo. */
const IDLE_EYES = hexToRGB("#E8FCFF");
const IDLE_HALO = hexToRGB("#5FD9EE");

/** Love: a warm pink for the hearts that float up and for the eyes' halo, and the eyes' own lighter pink. */
export const LOVE = hexToRGB("#FF6B9D");
export const LOVE_EYES = mix(LOVE, WHITE, 0.3);
/** Dizzy: the stars that circle over the head. */
export const STAR = hexToRGB("#FFD15C");
/** The antenna's short flash as Liv greets: the white-cyan of its resting eyes. */
export const HELLO = IDLE_EYES;
/** How far a state's colour goes to white in the eyes. */
const EYE_TINT = 0.5;

const EVEN: readonly [number, number] = [1, 1];

function lit(
  color: RGB,
  eyes: EyeShape,
  badge: BadgeKind,
  more: Partial<Pick<RobotLook, "antenna" | "pulse" | "gaze" | "tilt">> & { eyeScale?: readonly [number, number] } = {},
): RobotLook {
  return {
    color,
    eyeColor: mix(color, WHITE, EYE_TINT),
    antenna: more.antenna ?? 1,
    pulse: more.pulse ?? 0,
    eyes: { shape: eyes, scale: more.eyeScale ?? EVEN },
    gaze: more.gaze ?? null,
    tilt: more.tilt ?? 0,
    badge: { kind: badge, color },
  };
}

export const ROBOT_STATES: Record<BotStateName, RobotLook> = {
  idle: {
    color: IDLE_HALO,
    eyeColor: IDLE_EYES,
    antenna: 0,
    pulse: 0,
    eyes: { shape: "round", scale: EVEN },
    gaze: null,
    tilt: 0,
    badge: null,
  },
  working: lit(C.working, "narrow", "dots", { pulse: 1.4 }),
  thinking: lit(C.thinking, "round", "dots", { pulse: 2.4, gaze: [0.7, -0.8] }),
  approval: lit(C.approval, "wide", "bang"),
  question: lit(C.question, "round", "question", { eyeScale: [0.9, 1.16], tilt: 0.1 }),
  error: lit(C.error, "bar", "dot"),
  finished: lit(C.finished, "arc", "dot"),
  ratelimit: lit(C.ratelimit, "half", "dot", { antenna: 0.4, pulse: 3 }),
};

/** The antenna's colour in a state: the state's once it is lit at all, a dim neutral when off. */
export const antennaColor = (look: RobotLook): RGB => mix(ANTENNA_OFF, look.color, Math.min(1, look.antenna * 2));

// ── The fit ───────────────────────────────────────────────────────────────────

/**
 * The head's radius for each pixel of the slot the layout gives the figure
 * (core/layout.ts: `botDiameter`). The plain ball that stood there before Liv
 * was 0.88 of the slot across; the head is 0.84 of that, which leaves the
 * antenna its room.
 */
export const HEAD_FIT = 0.84 * 0.44;

export const headRadius = (slot: number) => slot * HEAD_FIT;

/**
 * The figure is drawn in a square canvas this many times its slot, centred on
 * it: the antenna, the feet, the hands and the badge overflow the slot.
 */
export const CANVAS_PER_SLOT = 1 / 0.6;

// ── Levels of detail ──────────────────────────────────────────────────────────

export type Lod = "tiny" | "small" | "full";

/** Up to this slot: a head, a visor and two dots. */
const TINY_SLOT = 14;
/** From this slot the antenna is whole. */
const ANTENNA_SLOT = 16;
/** Up to this slot: the small robot, its antenna short and its eyes big. */
export const SMALL_SLOT = 24;
/** From this slot everything is drawn at the design's proportions. */
const FULL_SLOT = 44;
/** Sizes are compared this loosely: 24 × HEAD_FIT ÷ HEAD_FIT is not exactly 24. */
const EPS = 1e-6;

export function lodFor(R: number): Lod {
  const slot = R / HEAD_FIT;
  return slot <= TINY_SLOT + EPS ? "tiny" : slot <= SMALL_SLOT + EPS ? "small" : "full";
}

export interface RobotGeometry {
  /** How much of the antenna there is, 0 (tiny) … 1. */
  antenna: number;
  /** How much of the fine detail shows (highlight, rim, glass edge, nub), 0 (small) … 1 (full). */
  detail: number;
  /** The antenna's ball: its radius, how high its centre is (negative = up), how far it leans. */
  ballR: number;
  ballY: number;
  lean: number;
  stemW: number;
  /** The visor: width, height, how far its centre is below the head's. */
  visorW: number;
  visorH: number;
  visorY: number;
  /** The eyes: radius at rest, how far each is from the middle, how far below the head's centre. */
  eyeR: number;
  eyeX: number;
  eyeY: number;
  /** The eyes' halo, in eye radii. */
  eyeHalo: number;
}

/**
 * The visor: a superellipse, wider than tall, a little below the head's
 * centre so the ring of shell around it is thickest at the top. Its top half
 * is rounder than its bottom half, as in the design.
 */
export const VISOR = { topPower: 2.6, bottomPower: 3.4 } as const;

/**
 * The screen inside the visor: the same outline, this much smaller and this
 * far up (in R), which leaves a lighter lip of glass around it — a line at
 * the top, the thickest part at the bottom.
 */
export const SCREEN = { scale: 0.95, lift: 0.022 } as const;

/** The point of the visor's outline at angle `a` (0 = right, a quarter turn = bottom), in R. */
export function visorPoint(g: RobotGeometry, a: number): readonly [number, number] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const power = 2 / (s < 0 ? VISOR.topPower : VISOR.bottomPower);
  return [
    Math.sign(c) * Math.pow(Math.abs(c), power) * (g.visorW / 2),
    g.visorY + Math.sign(s) * Math.pow(Math.abs(s), power) * (g.visorH / 2),
  ];
}

/**
 * What differs between the small robot and the full one. The full one has the
 * design's proportions. The small one has a shorter antenna with a bigger
 * ball, bigger eyes, and a smaller visor: on a pill the shell is the pill's
 * colour, and at that size it takes a thicker ring of it to tell which.
 */
const SMALL = {
  ballR: 0.2, ballY: -1.31, lean: 0, stemW: 0.14,
  visorW: 1.44, visorH: 1.12, visorY: 0.06,
  eyeR: 0.25, eyeX: 0.37, eyeHalo: 1.5,
};
const FULL = {
  ballR: 0.13, ballY: -1.34, lean: -0.03, stemW: 0.055,
  visorW: 1.54, visorH: 1.32, visorY: 0.03,
  eyeR: 0.2, eyeX: 0.355, eyeHalo: 1.9,
};

/**
 * What is drawn for a head of radius `R` px, and where. The three levels are
 * exact at the sizes the app rests at (slots of 13, 18, 20, 24 and 44 up);
 * between them the numbers slide, so a figure growing from the compact
 * island into a card never jumps.
 */
export function robotGeometry(R: number): RobotGeometry {
  const slot = R / HEAD_FIT;
  const lod = lodFor(R);
  const antenna = lod === "tiny" ? 0 : seg(slot, TINY_SLOT, ANTENNA_SLOT);
  const t = lod === "full" ? seg(slot, SMALL_SLOT, FULL_SLOT) : 0;
  const detail = t * t * (3 - 2 * t);
  const between = (key: keyof typeof SMALL) => lerp(SMALL[key], FULL[key], detail);
  return {
    antenna,
    detail,
    ballR: between("ballR") * antenna,
    ballY: lerp(-1, between("ballY"), antenna),
    lean: between("lean") * antenna,
    stemW: between("stemW"),
    visorW: between("visorW"),
    visorH: between("visorH"),
    visorY: between("visorY"),
    eyeR: between("eyeR"),
    eyeX: between("eyeX"),
    eyeY: between("visorY") - 0.02,
    eyeHalo: between("eyeHalo"),
  };
}

/** The radius of the antenna's halo, in ball radii, for a glow of `glow` (1 = lit, more for a flash). */
export const antennaHalo = (glow: number) => 2.4 + 0.5 * glow;

/** A line is never thinner than one device pixel (`px`, in the units it is drawn in). */
export const hairline = (width: number, px: number) => Math.max(width, px);

// ── The two models ────────────────────────────────────────────────────────────

/** Model 1 is the head alone; model 2 has two hands and two feet, detached. */
export type RobotModel = "head" | "body";

/** The slot from which the island's cards show the whole body. */
const BODY_SLOT = 40;

export const modelFor = (slot: number): RobotModel => (slot >= BODY_SLOT ? "body" : "head");

/** A hand: a paddle hanging from its shoulder, leaning outward. On the left; mirrored on the right. */
export const HAND = {
  /** The shoulder it swings from. */
  pivotX: -1.07,
  pivotY: 0.3,
  /** From the shoulder to the paddle's middle. */
  arm: 0.25,
  /** The paddle: its narrow end towards the shoulder, its wide end away from it, and half the way between them. */
  topR: 0.1,
  bottomR: 0.135,
  half: 0.2,
  /** Its angle at rest, and how much further it swings when it is lifted. */
  angle: 0.2,
  lift: 1.75,
} as const;

/**
 * The hand that waves — the one on the left of the picture, clear of the
 * badge. Raised, it floats up beside the head: how far its shoulder moves, in
 * R, and how much further the hand turns, which leaves it pointing up and out.
 */
export const WAVE = { dx: -0.1, dy: -0.72, turn: 2.45 } as const;

/**
 * A foot: a cup tucked under the body, its flat top following the body's
 * curve, round below, its lowest point towards the middle. `x`, `y` is the
 * middle of its top; the tip is given from there, before the foot is turned
 * by `angle`. On the left; mirrored on the right.
 */
export const FOOT = {
  x: -0.4,
  y: 1,
  /** Half the width of its top. */
  half: 0.2,
  tipX: 0.12,
  tipY: 0.28,
  angle: 0.31,
} as const;

/** How far the figure reaches from the head's centre at rest, lights' halos aside. */
export interface RobotBounds {
  top: number;
  bottom: number;
  side: number;
}

export function robotBounds(g: RobotGeometry, model: RobotModel): RobotBounds {
  const top = -g.ballY + g.ballR;
  if (model === "head") return { top, bottom: 1, side: 1 };
  const handReach = HAND.arm + HAND.half;
  const side = -HAND.pivotX + handReach * Math.sin(HAND.angle) + HAND.bottomR;
  const bottom = FOOT.y + FOOT.tipX * Math.sin(FOOT.angle) + FOOT.tipY * Math.cos(FOOT.angle);
  return { top, bottom, side };
}

/** How far below the middle of its slot the head sits: the antenna above it is balanced. */
const DROP_HEAD = 0.24;
const DROP_BODY = 0.09;

/**
 * The head's centre below the middle of its slot, in R, with `limbs` of the
 * hands and feet out (0…1). The head alone carries an antenna and nothing
 * under it, so it sits lower; with feet under it the figure is nearly even.
 * A head too small for an antenna stays in the middle.
 */
export function robotDrop(g: RobotGeometry, limbs: number): number {
  return g.antenna * lerp(DROP_HEAD, DROP_BODY, clamp(limbs, 0, 1));
}

/** Where a figure stands: its head's radius and its head's centre. */
export interface RobotPlace {
  R: number;
  cx: number;
  cy: number;
}

/** In a square of `size`, as the engine places it: the slot is 0.6 of the square. */
export function placeInSlot(size: number, model: RobotModel): RobotPlace {
  const R = headRadius(size / CANVAS_PER_SLOT);
  return { R, cx: size / 2, cy: size / 2 + robotDrop(robotGeometry(R), model === "body" ? 1 : 0) * R };
}

/** The share of a box the figure fills, its antenna's halo included. */
const BOX_FILL = 0.96;

/** The whole figure in a box of `w` × `h`, as big as it goes, in the middle. */
export function placeInBox(w: number, h: number, model: RobotModel): RobotPlace {
  const b = robotBounds(robotGeometry(headRadius(FULL_SLOT)), model);
  // Above the ball there is its halo, as wide as when it is lit: the higher
  // of the small robot's and the full one's, whichever the box turns out to hold.
  const top = Math.max(...[SMALL, FULL].map((a) => -a.ballY + a.ballR * antennaHalo(1)));
  const R = Math.min(w / (2 * b.side), h / (top + b.bottom)) * BOX_FILL;
  return { R, cx: w / 2, cy: h / 2 + ((top - b.bottom) / 2) * R };
}

// ── The gaze ──────────────────────────────────────────────────────────────────

/** How far the eyes move in the visor at full gaze, and the visor with them: the head turning. */
export const GAZE_EYES: readonly [number, number] = [0.14, 0.1];
export const GAZE_VISOR = 0.05;

/** A pointer this close to the head (px) has the eyes all the way over. */
const GAZE_FULL = 90;
/** From here on the eyes let go, and beyond GAZE_FAR they are back in the middle. */
const GAZE_NEAR = 260;
const GAZE_FAR = 420;

/**
 * Where the eyes look for a pointer `dx`, `dy` px from the head's centre:
 * towards it, −1…1 each way, and straight ahead once it is far.
 */
export function gazeFor(dx: number, dy: number): readonly [number, number] {
  const d = Math.hypot(dx, dy);
  if (!(d > 0) || d >= GAZE_FAR) return [0, 0];
  const reach = Math.min(1, d / GAZE_FULL) * (1 - seg(d, GAZE_NEAR, GAZE_FAR));
  return [(dx / d) * reach, (dy / d) * reach];
}

// ── A still pose ──────────────────────────────────────────────────────────────

/** Everything a painter needs to draw one robot. */
export interface RobotPose {
  /** The shell's colour (shellPalette). */
  shell: RGB;
  eyeColor: RGB;
  /** The colour of the eyes' halo. */
  eyeHalo: RGB;
  antennaColor: RGB;
  /** The antenna's halo, 0 (none) … 1, and above for a flash. */
  glow: number;
  eyes: EyeLook;
  /** A size and an opacity for both eyes: a swap of shapes in progress. */
  eyeScale: number;
  eyeAlpha: number;
  /** 0 open … 1 shut. */
  blink: number;
  gaze: readonly [number, number];
  tilt: number;
  /** How far out the hands and the feet are, 0 (tucked away) … 1; and the hands' lift, 0…1. */
  hands: number;
  feet: number;
  lift: number;
  /**
   * The waving hand (WAVE): how far it is raised beside the head, 0…1, how far
   * it swings there, and the bend of its wrist — the hand itself turning, late.
   * Radians.
   */
  raise: number;
  swing: number;
  wrist: number;
  /**
   * What each hand does on its own, left then right: its lift on top of
   * `lift`, and the bend of its wrist. Dancing, typing.
   */
  reach: readonly [number, number];
  flick: readonly [number, number];
  /** How far each foot is from its place under the body, in R, down positive: left, right. A foot tapping. */
  step: readonly [number, number];
  /** How far the eyes are turned on top of their shape's slant, radians: the dizzy spirals going round. */
  eyeTurn: number;
  /** How far the antenna's tip trails the body, in R. */
  sway: readonly [number, number];
  /** Squash and stretch, from the ground up: width and height, 1 = at rest. */
  stretch: readonly [number, number];
  /** What it wears (outfits.ts), and how far on it is: 0 (off) … 1, a little past 1 as it pops on. */
  outfit: Outfit;
  wear: number;
  /** How hard the beat of the dance is felt at this instant, 0…1: what it wears may move to it. */
  beat: number;
}

export interface StillLook {
  model?: RobotModel;
  state?: BotStateName;
  /** The shell's colour: a pill's, or the default. */
  shell?: RGB;
  /** Other eyes than the state's (dev/robot-preview.html shows each shape). */
  eyes?: EyeShape;
  /** What it wears; nothing unless told (a pill's figure never wears anything). */
  outfit?: Outfit;
}

/** A robot standing still in a state: its face and its lights, nothing in motion. */
export function stillPose(look: StillLook = {}): RobotPose {
  const state = ROBOT_STATES[look.state ?? "idle"];
  const limbs = look.model === "body" ? 1 : 0;
  return {
    shell: look.shell ?? SHELL_ICE,
    eyeColor: state.eyeColor,
    eyeHalo: state.color,
    antennaColor: antennaColor(state),
    glow: state.antenna,
    eyes: look.eyes ? { shape: look.eyes, scale: EVEN } : state.eyes,
    eyeScale: 1,
    eyeAlpha: 1,
    blink: 0,
    gaze: state.gaze ?? [0, 0],
    tilt: state.tilt,
    hands: limbs,
    feet: limbs,
    lift: 0,
    raise: 0,
    swing: 0,
    wrist: 0,
    reach: [0, 0],
    flick: [0, 0],
    step: [0, 0],
    eyeTurn: 0,
    sway: [0, 0],
    stretch: [1, 1],
    outfit: look.outfit ?? "none",
    wear: 1,
    beat: 0,
  };
}
