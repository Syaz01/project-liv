// Liv's way between the island and its spot on the desktop: where its window
// is at each instant, and how Liv carries itself on the way. It leaves the
// island downwards and sweeps across to its spot — and comes home the same
// way, backwards — slow at both ends, leaning into the way it goes, its
// antenna pushed back by the air and its eyes ahead; it comes out of the
// island small and grows on the way, and is small again as it goes back in.
//
// Pure: a point for a share of the way, a pose for the same share. The island
// samples the path and hands it to Rust, which moves the window along it
// (src-tauri/src/pet.rs); the window's page poses Liv for the same instants.
//
// A point is in whatever unit the two ends are given in; y grows downwards.

import { Ease, clamp, lerp, seg } from "../core/anim";

export interface Point {
  x: number;
  y: number;
}

export const TRAVEL = {
  /** A short way takes this long, ms; a way of `farPx` page px or more, `maxMs`. */
  minMs: 450,
  maxMs: 600,
  farPx: 1200,
  /** The window is given a new place this often, ms: once a frame. */
  stepMs: 16,
  /** How far the way bends towards the corner under its higher end, 0 (straight) … 1. */
  bend: 0.5,
  /** At its fastest: the head's lean, radians, and how far back the antenna's tip is, in R. */
  lean: 0.24,
  trail: 0.3,
  /** Its size at the island's end of the way, and the share of the way it takes to grow from it. */
  small: 0.42,
  grow: 0.4,
} as const;

/** Which end of the way is the island: Liv leaves it, comes back to it, or neither (a move on the desktop). */
export type Heading = "out" | "home" | "move";

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** How long a way of `px` page px takes, ms. */
export function travelMs(px: number): number {
  return Math.round(lerp(TRAVEL.minMs, TRAVEL.maxMs, seg(px, 0, TRAVEL.farPx)));
}

/**
 * The point the way bends towards: half way, pulled towards the corner under
 * the higher end — so Liv drops out of the island before it crosses the
 * screen, and rises into it at the end of the way back.
 */
function bendPoint(from: Point, to: Point): Point {
  const higher = from.y <= to.y ? from : to;
  const lower = higher === from ? to : from;
  return {
    x: lerp((from.x + to.x) / 2, higher.x, TRAVEL.bend),
    y: lerp((from.y + to.y) / 2, lower.y, TRAVEL.bend),
  };
}

/** How far along the way it is `t` of the time in (0…1): slow at both ends. */
const along = (t: number) => Ease.inOut(clamp(t, 0, 1));

/** How fast that grows, as a share of its fastest (half way). */
function pace(t: number): number {
  const u = clamp(t, 0, 1);
  return 4 * Math.min(u, 1 - u) ** 2;
}

/** Where Liv is `t` of the time into its way from `from` to `to` (0…1). */
export function travelPoint(from: Point, to: Point, t: number): Point {
  const s = along(t);
  // The two ends exactly: the window starts and stops on the pixel asked for.
  if (s <= 0) return { ...from };
  if (s >= 1 || (from.x === to.x && from.y === to.y)) return { ...to };
  const c = bendPoint(from, to);
  const a = (1 - s) * (1 - s);
  const b = 2 * (1 - s) * s;
  return { x: a * from.x + b * c.x + s * s * to.x, y: a * from.y + b * c.y + s * s * to.y };
}

/** The way it is going at that instant, as a unit vector; nowhere when the two ends are one. */
function direction(from: Point, to: Point, t: number): Point {
  const s = along(t);
  const c = bendPoint(from, to);
  const x = (1 - s) * (c.x - from.x) + s * (to.x - c.x);
  const y = (1 - s) * (c.y - from.y) + s * (to.y - c.y);
  const d = Math.hypot(x, y);
  return d > 0 ? { x: x / d, y: y / d } : { x: 0, y: 0 };
}

export interface TravelPath {
  /** The window's place at each step, the first at `from` and the last at `to`. */
  points: [number, number][];
  ms: number;
}

/**
 * The whole way, a point every TRAVEL.stepMs. `unit` is how many of the
 * points' units make one page px (physical px on a display at 150 % with the
 * island at 125 %: 1.875), so the time follows the way as it looks.
 */
export function travelPath(from: Point, to: Point, unit = 1): TravelPath {
  const ms = travelMs(distance(from, to) / (unit > 0 ? unit : 1));
  const steps = Math.ceil(ms / TRAVEL.stepMs);
  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const p = travelPoint(from, to, i / steps);
    points.push([p.x, p.y]);
  }
  return { points, ms };
}

/** How Liv carries itself at an instant of the way. */
export interface TravelPose {
  /** The head's lean, radians: towards where it goes. */
  lean: number;
  /** How far the air pushes the antenna's tip back, in R. */
  trail: readonly [number, number];
  /** Where its eyes look, in gaze units: ahead. */
  gaze: readonly [number, number];
  /** Its size, 1 = as it stands on the desktop. */
  size: number;
}

/** At rest: upright, the antenna straight, its eyes its own, whole. */
export const AT_REST: TravelPose = { lean: 0, trail: [0, 0], gaze: [0, 0], size: 1 };

function sizeAt(t: number, way: Heading): number {
  if (way === "move") return 1;
  // How much of the island's small Liv it is, 1 (at the island) … 0 (whole).
  const small = way === "out" ? 1 - Ease.out(seg(t, 0, TRAVEL.grow)) : Ease.easeIn(seg(t, 1 - TRAVEL.grow, 1));
  return small >= 1 ? TRAVEL.small : lerp(1, TRAVEL.small, small);
}

/**
 * Liv `t` of the time into a way of `dx`, `dy` (0…1). The lean and the
 * antenna follow its speed, so it straightens as it slows down to land.
 */
export function travelPose(t: number, dx: number, dy: number, way: Heading): TravelPose {
  const size = sizeAt(clamp(t, 0, 1), way);
  if (t <= 0 || t >= 1 || (dx === 0 && dy === 0)) return { ...AT_REST, size };
  const dir = direction({ x: 0, y: 0 }, { x: dx, y: dy }, t);
  const speed = pace(t);
  const ahead = Math.min(1, speed * 2);
  return {
    lean: dir.x * speed * TRAVEL.lean,
    trail: [-dir.x * speed * TRAVEL.trail, -dir.y * speed * TRAVEL.trail],
    gaze: [dir.x * ahead, dir.y * ahead],
    size,
  };
}
