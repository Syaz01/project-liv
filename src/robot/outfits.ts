// Liv's wardrobe: what it can wear, in one table — glasses, a scarf,
// headphones, a beanie, and a star in place of the antenna's ball. Each is
// drawn here in the robot's own coordinates, so it hops, squashes, tilts,
// dances and travels with the figure at any size. Also here: what the season
// picks when the choice is "Auto", at which sizes an accessory shows, and how
// long one takes to come on and to go.
//
// No image, no shadow blur and no clock: a painter takes a 2D context and the
// pose of the instant. Every length is in units of R, the head's radius, from
// the head's centre; angles in radians.

import { clamp, lerp, seg } from "../core/anim";
import { N_ } from "../i18n/i18n";
import {
  GAZE_EYES, HEAD_FIT, SMALL_SLOT, hairline, hexToRGB, lodFor, mix, rgba,
  type RGB, type RobotGeometry, type RobotPose,
} from "./look";

type Ctx = CanvasRenderingContext2D;

export type OutfitId = "glasses" | "scarf" | "headphones" | "beanie" | "star";
/** What Liv has on. */
export type Outfit = OutfitId | "none";
/** What the user picked: an outfit, nothing, or whatever the season says. */
export type OutfitChoice = Outfit | "auto";

// ── Colours ───────────────────────────────────────────────────────────────────

// Warm and matte, next to a shell that is cold and glossy: a muted coral for
// cloth and cups, a cream for frames and bands, a charcoal for what lies
// against the shell. None of them is a light: the states' colours are
// saturated and glow, and stay the only ones that do. And all but the
// charcoal are light enough to show against the island's black.
const WHITE: RGB = [1, 1, 1];
export const CORAL = hexToRGB("#E88D75");
const CORAL_LIGHT = mix(CORAL, WHITE, 0.32);
const CORAL_DEEP = hexToRGB("#B5604F");
const CREAM = hexToRGB("#F7EBD7");
const CREAM_DEEP = hexToRGB("#D2BC98");
const CHARCOAL = hexToRGB("#3A3F47");
/** The lenses' tint: a pale amber, thin enough for any eye to show through. */
const LENS = hexToRGB("#FFC98A");

// ── Putting on, taking off ────────────────────────────────────────────────────

/** An accessory pops on in this long, with a little overshoot, and goes in this long; the one in place goes first. */
export const OUTFIT_ON_MS = 240;
export const OUTFIT_OFF_MS = 150;

/** It is opaque by the time it is this far on. */
const SOLID_AT = 0.6;
/** What hugs the head lands on it from this much bigger. */
const LAND_FROM = 1.3;

/** Scales the context for something landing on the head, `on` of the way there. */
function landing(x: Ctx, on: number) {
  const k = lerp(LAND_FROM, 1, on);
  x.scale(k, k);
}

// ── Painters ──────────────────────────────────────────────────────────────────

/** An outfit on a figure, as its painters see it. */
export interface Worn {
  def: OutfitDef;
  R: number;
  g: RobotGeometry;
  pose: RobotPose;
  /** How far on it is: 0 (off) … 1, a little past 1 on its way on. */
  on: number;
  /** One device pixel, in the units the context draws in. */
  px: number;
}

type Painter = (x: Ctx, worn: Worn) => void;

/** Left, then right. */
const SIDES = [-1, 1] as const;
const TAU = Math.PI * 2;

/** A gradient down from `y0` to `y1` through `colors`, evenly. */
function down(x: Ctx, y0: number, y1: number, ...colors: RGB[]): CanvasGradient {
  const gradient = x.createLinearGradient(0, y0, 0, y1);
  colors.forEach((color, i) => gradient.addColorStop(i / (colors.length - 1), rgba(color)));
  return gradient;
}

// Glasses: two round-ish lenses around the eyes, a bridge between them and
// the start of an arm on each side, sitting on the visor.
export const GLASSES = {
  /** Half a lens, across and down. The widest eye is 0.24 across its half. */
  rx: 0.31,
  ry: 0.295,
  frame: 0.055,
  /** The bridge: where it meets the lenses, and how far it arches above that. */
  bridgeY: -0.04,
  arch: 0.08,
  /** Each arm leaves its lens here and ends this far past the visor's edge, this far up. */
  armY: -0.03,
  armPast: 0.03,
  armRise: 0.05,
  /**
   * The eyes travel further than the visor when Liv looks aside: the glasses
   * follow this much of that travel, and the eyes stay inside the lenses.
   */
  follow: 0.75,
  /** The tint at the top of a lens; it thins out to this share of it at the bottom. */
  tint: 0.2,
  thin: 0.3,
} as const;

function paintGlasses(x: Ctx, { R, g, pose, on, px }: Worn) {
  x.translate(
    pose.gaze[0] * GAZE_EYES[0] * GLASSES.follow * R,
    (g.eyeY + pose.gaze[1] * GAZE_EYES[1] * GLASSES.follow) * R,
  );
  // They pop on from nothing, around the bridge.
  x.scale(on, on);
  const ex = g.eyeX * R;
  const rx = GLASSES.rx * R;
  const ry = GLASSES.ry * R;

  const tint = x.createLinearGradient(0, -ry, 0, ry);
  tint.addColorStop(0, rgba(LENS, GLASSES.tint));
  tint.addColorStop(1, rgba(LENS, GLASSES.tint * GLASSES.thin));
  x.fillStyle = tint;
  for (const side of SIDES) {
    x.beginPath();
    x.ellipse(side * ex, 0, rx, ry, 0, 0, TAU);
    x.fill();
  }

  x.strokeStyle = down(x, -ry, ry, CREAM, CREAM_DEEP);
  x.lineWidth = hairline(GLASSES.frame * R, px);
  x.lineCap = "round";
  x.beginPath();
  for (const side of SIDES) {
    x.moveTo(side * ex + rx, 0);
    x.ellipse(side * ex, 0, rx, ry, 0, 0, TAU);
    // The arm, from the lens's outer edge to just past the visor's.
    x.moveTo(side * (ex + rx), GLASSES.armY * R);
    x.lineTo(side * (g.visorW / 2 + GLASSES.armPast) * R, (GLASSES.armY - GLASSES.armRise) * R);
  }
  x.moveTo(-(ex - rx), GLASSES.bridgeY * R);
  x.quadraticCurveTo(0, (GLASSES.bridgeY - GLASSES.arch * 2) * R, ex - rx, GLASSES.bridgeY * R);
  x.stroke();
}

// A scarf: a band around the lower third of the ball, sagging in the middle
// as a band on a ball does when seen from a little above, knotted at one side
// with its two ends hanging there.
export const SCARF = {
  /** Where the band's upper and lower edges leave the ball, as angles below the horizontal; and how far out the cloth stands. */
  from: 0.38,
  to: 0.78,
  out: 1.02,
  /** How low each edge is in the middle. */
  topMid: 0.58,
  bottomMid: 0.9,
  /** The knot, on the right of the picture. */
  knot: [0.7, 0.6],
  knotR: 0.12,
  /** An end: its length, and half its width at the knot and at its tip. */
  length: 0.5,
  neck: 0.09,
  tip: 0.15,
  /** The end behind is this much of the one in front, and hangs this far apart from it. */
  behind: 0.78,
  apart: -0.3,
  /**
   * The ends swing behind the body as the antenna's tip does (RobotPose.sway):
   * by this much of its lag sideways, and outward by this much of its lag
   * upward as the body drops. They hang plumb, by this much, when the head tilts.
   */
  swing: 2.2,
  lift: 1.3,
  plumb: 0.85,
  /** Never further than this. */
  reach: 0.75,
  /** The end behind follows this much of it: it is out of step. */
  lag: 0.7,
  /** Two stripes near the tip, as shares of the length. */
  stripes: [[0.62, 0.72], [0.8, 0.9]],
} as const;

/** One end of the scarf hanging from the origin, `length` long. */
function scarfEnd(x: Ctx, R: number, length: number) {
  const neck = SCARF.neck * R;
  const tip = SCARF.tip * R;
  const corner = tip * 0.6;
  x.beginPath();
  x.moveTo(-neck, 0);
  x.lineTo(neck, 0);
  x.lineTo(tip, length - corner);
  x.quadraticCurveTo(tip, length, tip - corner, length);
  x.lineTo(corner - tip, length);
  x.quadraticCurveTo(-tip, length, -tip, length - corner);
  x.closePath();
}

function paintScarf(x: Ctx, { R, pose, on }: Worn) {
  landing(x, on);
  const r = SCARF.out * R;
  const [topX, topY] = [Math.cos(SCARF.from) * r, Math.sin(SCARF.from) * r];
  const [lowX, lowY] = [Math.cos(SCARF.to) * r, Math.sin(SCARF.to) * r];
  // Along its upper edge, down the side of the ball, back along its lower edge and up the other side.
  x.beginPath();
  x.moveTo(-topX, topY);
  x.quadraticCurveTo(0, 2 * SCARF.topMid * R - topY, topX, topY);
  x.arc(0, 0, r, SCARF.from, SCARF.to);
  x.quadraticCurveTo(0, 2 * SCARF.bottomMid * R - lowY, -lowX, lowY);
  x.arc(0, 0, r, Math.PI - SCARF.to, Math.PI - SCARF.from);
  x.closePath();
  x.fillStyle = down(x, topY, SCARF.bottomMid * R, CORAL_LIGHT, CORAL, CORAL_DEEP);
  x.fill();

  const swing = clamp(
    -pose.sway[0] * SCARF.swing + pose.sway[1] * SCARF.lift - pose.tilt * SCARF.plumb, -SCARF.reach, SCARF.reach,
  );
  const length = SCARF.length * R;
  x.translate(SCARF.knot[0] * R, SCARF.knot[1] * R);
  // The end behind, shorter and in the shade.
  x.save();
  x.rotate(swing * SCARF.lag + SCARF.apart);
  scarfEnd(x, R, length * SCARF.behind);
  x.fillStyle = rgba(CORAL_DEEP);
  x.fill();
  x.restore();
  // The end in front, with its stripes.
  x.save();
  x.rotate(swing);
  scarfEnd(x, R, length);
  x.fillStyle = down(x, 0, length, CORAL, CORAL_LIGHT);
  x.fill();
  const half = (at: number) => lerp(SCARF.neck, SCARF.tip, at) * R;
  x.beginPath();
  for (const [from, to] of SCARF.stripes) {
    x.moveTo(-half(from), from * length);
    x.lineTo(half(from), from * length);
    x.lineTo(half(to), to * length);
    x.lineTo(-half(to), to * length);
    x.closePath();
  }
  x.fillStyle = rgba(CREAM);
  x.fill();
  x.restore();
  // The knot over both.
  x.beginPath();
  x.ellipse(0, 0, SCARF.knotR * R, SCARF.knotR * 1.12 * R, 0, 0, TAU);
  x.fillStyle = down(x, -SCARF.knotR * R, SCARF.knotR * R, CORAL, CORAL_DEEP);
  x.fill();
}

// Headphones: a band over the top of the head, padded where it rests, and a
// cup over each side at the height of the eyes.
export const PHONES = {
  /** The band: the middle of its stroke, its width, and how far above the horizontal it meets the cups. */
  band: 1.05,
  bandW: 0.1,
  bandFrom: 0.12,
  /** The pad on top: this far to each side of the top, this wide. */
  pad: 0.42,
  padW: 0.15,
  /** A cup: its middle, its size and its corners. It ends above the shoulder of the hand under it. */
  cup: [1.04, -0.08],
  cupW: 0.25,
  cupH: 0.48,
  cupR: 0.11,
  /** The cushion between the cup and the head: its middle from the cup's, its size. */
  cushionX: -0.13,
  cushionW: 0.1,
  cushionH: 0.4,
  /** A cup grows by this much on the beat while Liv dances. */
  pulse: 0.07,
} as const;

function paintBand(x: Ctx, { R, on }: Worn) {
  landing(x, on);
  const r = PHONES.band * R;
  x.lineCap = "round";
  x.beginPath();
  x.arc(0, 0, r, Math.PI + PHONES.bandFrom, TAU - PHONES.bandFrom);
  x.strokeStyle = down(x, -r, 0, CREAM, CREAM_DEEP);
  x.lineWidth = PHONES.bandW * R;
  x.stroke();
  x.beginPath();
  x.arc(0, 0, r, -Math.PI / 2 - PHONES.pad, -Math.PI / 2 + PHONES.pad);
  x.strokeStyle = down(x, -r - (PHONES.padW / 2) * R, -r * Math.cos(PHONES.pad), CORAL_LIGHT, CORAL);
  x.lineWidth = PHONES.padW * R;
  x.stroke();
}

function paintCups(x: Ctx, { R, pose, on }: Worn) {
  landing(x, on);
  const beat = 1 + PHONES.pulse * pose.beat;
  const w = PHONES.cupW * R;
  const h = PHONES.cupH * R;
  for (const side of SIDES) {
    x.save();
    x.translate(side * PHONES.cup[0] * R, PHONES.cup[1] * R);
    // Drawn as the right one, mirrored on the left: the shading runs top to bottom, the same on both.
    x.scale(side * beat, beat);
    x.beginPath();
    x.roundRect(
      (PHONES.cushionX - PHONES.cushionW / 2) * R, (-PHONES.cushionH / 2) * R,
      PHONES.cushionW * R, PHONES.cushionH * R, (PHONES.cushionW / 2) * R,
    );
    x.fillStyle = rgba(CHARCOAL);
    x.fill();
    x.beginPath();
    x.roundRect(-w / 2, -h / 2, w, h, PHONES.cupR * R);
    x.fillStyle = down(x, -h / 2, h / 2, CORAL_LIGHT, CORAL, CORAL_DEEP);
    x.fill();
    x.restore();
  }
}

// A beanie: a knitted crown over the top of the head and a folded brim, pulled
// down over the top of the glass. The antenna comes out through its top.
export const BEANIE = {
  /** The crown: where it meets the brim on each side, the pull of its sides and of its shoulders, and its top. */
  side: [0.86, -0.58],
  flank: [0.84, -0.96],
  shoulder: [0.5, -1.14],
  top: -1.14,
  /** The brim: its lower corners and how low its lower edge is in the middle; its upper corners and that edge's middle. */
  low: [0.86, -0.56],
  lowMid: -0.485,
  high: [0.8, -0.78],
  highMid: -0.685,
  /** How far its sides bulge. */
  bulge: [0.95, -0.66],
  /** The knit: ribs up the crown, from these places across the brim's upper edge, and as many across the fold. */
  ribs: [-0.56, -0.28, 0, 0.28, 0.56],
  rib: 0.03,
  ribAlpha: 0.45,
  /** It comes down onto the head from this far above. */
  drop: 0.5,
  /** The antenna's stem starts here once the cap is on: just inside its top. */
  antennaFrom: -1.12,
} as const;

/** The height of a sagging edge at `at` (−1…1) between corners at `side` and a middle at `mid`. */
function sag(at: number, side: number, mid: number): number {
  return mid + (side - mid) * at * at;
}

function paintBeanie(x: Ctx, { R, g, on, px }: Worn) {
  x.translate(0, -(1 - on) * BEANIE.drop * R);
  const at = ([ax, ay]: readonly [number, number], flip = 1): [number, number] => [flip * ax * R, ay * R];
  const [sx, sy] = at(BEANIE.side);
  const top = BEANIE.top * R;

  // The crown, up one side, over the top and down the other; closed along the brim's lower edge.
  x.beginPath();
  x.moveTo(-sx, sy);
  x.bezierCurveTo(...at(BEANIE.flank, -1), ...at(BEANIE.shoulder, -1), 0, top);
  x.bezierCurveTo(...at(BEANIE.shoulder), ...at(BEANIE.flank), sx, sy);
  x.quadraticCurveTo(0, (2 * BEANIE.lowMid - BEANIE.side[1]) * R, -sx, sy);
  x.closePath();
  const crown = x.createLinearGradient(-sx, top, sx, sy);
  crown.addColorStop(0, rgba(CORAL_LIGHT));
  crown.addColorStop(0.45, rgba(CORAL));
  crown.addColorStop(1, rgba(CORAL_DEEP));
  x.fillStyle = crown;
  x.fill();

  // The fold: along its lower edge, round its bulging side, back along its upper edge.
  const [lx, ly] = at(BEANIE.low);
  const [hx, hy] = at(BEANIE.high);
  x.beginPath();
  x.moveTo(-lx, ly);
  x.quadraticCurveTo(0, (2 * BEANIE.lowMid - BEANIE.low[1]) * R, lx, ly);
  x.quadraticCurveTo(...at(BEANIE.bulge), hx, hy);
  x.quadraticCurveTo(0, (2 * BEANIE.highMid - BEANIE.high[1]) * R, -hx, hy);
  x.quadraticCurveTo(...at(BEANIE.bulge, -1), -lx, ly);
  x.closePath();
  x.fillStyle = down(x, hy, BEANIE.lowMid * R, CORAL_LIGHT, CORAL);
  x.fill();

  // The knit shows only where there is room for it: fine lines, not outlines.
  if (g.detail < 0.01) return;
  x.strokeStyle = rgba(CORAL_DEEP, BEANIE.ribAlpha * g.detail);
  x.lineWidth = hairline(BEANIE.rib * R, px);
  x.lineCap = "round";
  x.beginPath();
  for (const rib of BEANIE.ribs) {
    const from = sag(rib / BEANIE.high[0], BEANIE.high[1], BEANIE.highMid);
    x.moveTo(rib * R, (from - 0.02) * R);
    x.quadraticCurveTo(rib * 0.95 * R, lerp(from, BEANIE.top, 0.6) * R, rib * 0.3 * R, (BEANIE.top + 0.05) * R);
    // And across the fold under it, half a rib along.
    const across = rib + 0.14;
    x.moveTo(across * R, (sag(across / BEANIE.high[0], BEANIE.high[1], BEANIE.highMid) + 0.045) * R);
    x.lineTo(across * 1.06 * R, (sag(across / BEANIE.low[0], BEANIE.low[1], BEANIE.lowMid) - 0.04) * R);
  }
  x.stroke();
}

// A star: the antenna's light, star-shaped. The same light — the painter of
// the ball fills this path with the ball's colours, under the ball's halo.
export const STAR_LAMP = {
  points: 5,
  /** Its points reach this many ball radii: where the ball is big (the small robot), where it is the design's. */
  reachSmall: 1.45,
  reachFull: 1.9,
  /** How deep it is cut between its points. */
  waist: 0.52,
  /** Each point is rounded over this share of its sides. */
  round: 0.24,
} as const;

function starPath(x: Ctx, cx: number, cy: number, reach: number) {
  const count = STAR_LAMP.points * 2;
  const corner = (i: number): [number, number] => {
    const a = (i / count) * TAU - Math.PI / 2;
    const d = i % 2 === 0 ? reach : reach * STAR_LAMP.waist;
    return [cx + Math.cos(a) * d, cy + Math.sin(a) * d];
  };
  const toward = (p: [number, number], q: [number, number]): [number, number] => [
    lerp(p[0], q[0], STAR_LAMP.round), lerp(p[1], q[1], STAR_LAMP.round),
  ];
  x.beginPath();
  x.moveTo(...corner(count - 1));
  for (let i = 0; i < count; i += 2) {
    const point = corner(i);
    x.lineTo(...toward(point, corner(i - 1)));
    x.quadraticCurveTo(...point, ...toward(point, corner(i + 1)));
    x.lineTo(...corner(i + 1));
  }
  x.closePath();
}

// ── The table ─────────────────────────────────────────────────────────────────

export interface OutfitDef {
  id: OutfitId;
  /** Its name, and what the wardrobe says when the season picks it: English keys (src/i18n). */
  name: string;
  auto: string;
  /**
   * It shows wherever Liv has its antenna, down to the closed island. The
   * others show only where Liv is drawn in full: a slot over 24 px.
   */
  small: boolean;
  /** Painted on the shell before the antenna, which passes in front of it. */
  behind?: Painter;
  /** Painted on the visor over the eyes, turning with it. */
  onVisor?: Painter;
  /** Painted over the head, after the visor. */
  over?: Painter;
  /** The antenna comes out through it: the stem starts here, and is painted after `over`. */
  antennaFrom?: number;
  /** The antenna's light in place of the ball: how far it reaches, in ball radii, and its path at that reach. */
  lamp?: { reach(detail: number): number; path(x: Ctx, cx: number, cy: number, reach: number): void };
}

/** Everything Liv can wear, in the order the wardrobe offers it. */
export const OUTFITS: Record<OutfitId, OutfitDef> = {
  glasses: {
    id: "glasses", name: N_("Glasses"), auto: N_("Auto: today Liv wears the glasses."), small: false,
    onVisor: paintGlasses,
  },
  scarf: {
    id: "scarf", name: N_("Scarf"), auto: N_("Auto: today Liv wears the scarf."), small: false,
    over: paintScarf,
  },
  headphones: {
    id: "headphones", name: N_("Headphones"), auto: N_("Auto: today Liv wears the headphones."), small: false,
    behind: paintBand, over: paintCups,
  },
  beanie: {
    id: "beanie", name: N_("Beanie"), auto: N_("Auto: today Liv wears the beanie."), small: false,
    over: paintBeanie, antennaFrom: BEANIE.antennaFrom,
  },
  star: {
    id: "star", name: N_("Star"), auto: N_("Auto: today Liv wears the star."), small: true,
    lamp: { reach: (detail) => lerp(STAR_LAMP.reachSmall, STAR_LAMP.reachFull, detail), path: starPath },
  },
};

export const OUTFIT_IDS = Object.keys(OUTFITS) as OutfitId[];

/** What the wardrobe and Settings offer, in order: the season's pick, nothing, then each accessory. */
export const OUTFIT_CHOICES: readonly { id: OutfitChoice; name: string }[] = [
  { id: "auto", name: N_("Auto") },
  { id: "none", name: N_("Nothing") },
  ...OUTFIT_IDS.map((id) => ({ id, name: OUTFITS[id].name })),
];

export const DEFAULT_OUTFIT: OutfitChoice = "auto";

/** The choice a setting holds; a word this build doesn't have reads as the default. */
export function outfitChoice(value: unknown): OutfitChoice {
  return OUTFIT_CHOICES.find((choice) => choice.id === value)?.id ?? DEFAULT_OUTFIT;
}

// ── The season ────────────────────────────────────────────────────────────────

type Day = readonly [month: number, day: number];

/**
 * What "Auto" picks, by the date: the first span that holds it, both ends
 * included, and nothing outside them all. The northern hemisphere's seasons —
 * a beanie in December, a scarf in January and February, glasses for the
 * summer — and the star for the week around the new year, which comes first.
 * A span may run over the end of the year.
 */
export const SEASONS: readonly { outfit: Outfit; from: Day; to: Day }[] = [
  { outfit: "star", from: [12, 28], to: [1, 3] },
  { outfit: "beanie", from: [12, 1], to: [12, 31] },
  { outfit: "scarf", from: [1, 1], to: [2, 29] },
  { outfit: "glasses", from: [6, 1], to: [8, 31] },
];

const dayOfYear = ([month, day]: Day) => month * 100 + day;

/** What the season picks on `date`, by the computer's own calendar. */
export function seasonalOutfit(date: Date): Outfit {
  const today = dayOfYear([date.getMonth() + 1, date.getDate()]);
  const holds = (from: number, to: number) => (from <= to ? today >= from && today <= to : today >= from || today <= to);
  return SEASONS.find((span) => holds(dayOfYear(span.from), dayOfYear(span.to)))?.outfit ?? "none";
}

/** What Liv wears on `date` for a choice: the choice itself, or the season's pick for "Auto". */
export function wornOutfit(choice: OutfitChoice, date: Date): Outfit {
  return choice === "auto" ? seasonalOutfit(date) : choice;
}

/** What the wardrobe says under "Auto" when the season picks nothing. */
const AUTO_NOTHING = N_("Auto: today Liv wears nothing.");

/** The wardrobe's line for "Auto" on `date`: what the season picked (an English key). */
export function autoLine(date: Date): string {
  const picked = seasonalOutfit(date);
  return picked === "none" ? AUTO_NOTHING : OUTFITS[picked].auto;
}

// ── Sizes ─────────────────────────────────────────────────────────────────────

/** From this slot an accessory is its whole size; it grows in from the small robot's slot. */
const WHOLE_SLOT = 34;

/**
 * How much of `outfit` shows on a head of radius `R` px, 0…1. Up to a slot of
 * 24 px — the closed and the compact island, the pills — nothing is drawn but
 * the star, which is the antenna's ball and shows wherever there is one.
 * Above it the others grow in, so a figure growing into a card never jumps.
 */
export function outfitShare(outfit: Outfit, R: number): number {
  if (outfit === "none") return 0;
  const lod = lodFor(R);
  if (OUTFITS[outfit].small) return lod === "tiny" ? 0 : 1;
  if (lod !== "full") return 0;
  const t = seg(R / HEAD_FIT, SMALL_SLOT, WHOLE_SLOT);
  return t * t * (3 - 2 * t);
}

/** What `pose` wears as it shows on a head of radius `R`; null when nothing of it does. */
export function wornBy(pose: RobotPose, R: number, g: RobotGeometry, px: number): Worn | null {
  if (pose.outfit === "none") return null;
  const on = pose.wear * outfitShare(pose.outfit, R);
  return on > 0.01 ? { def: OUTFITS[pose.outfit], R, g, pose, on, px } : null;
}

/** One layer of what is worn, fading in as it comes on. */
export function paintOutfit(x: Ctx, worn: Worn, layer: "behind" | "onVisor" | "over") {
  const paint = worn.def[layer];
  if (!paint) return;
  x.save();
  x.globalAlpha = clamp(worn.on / SOLID_AT, 0, 1);
  paint(x, worn);
  x.restore();
}
