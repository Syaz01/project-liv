// Liv's idle life: what small thing it does next, and when. A blink, now and
// then two, sometimes a glance to one side. Pure: the next event comes from
// the random source it is handed, so a seeded one gives the same life twice.
// Who runs the clock is not decided here (the engine while the island is
// open, one timer of the island's while it is closed or compact).

import { lerp } from "../core/anim";

export type LifeKind = "blink" | "doubleBlink" | "glanceLeft" | "glanceRight";

export interface LifeEvent {
  /** How long from now, ms. */
  inMs: number;
  kind: LifeKind;
}

/** Between two events: never less, never more. */
export const LIFE_MIN_MS = 2400;
export const LIFE_MAX_MS = 6000;

/** Out of a hundred events: this many double blinks, then glances each way; the rest are blinks. */
const DOUBLE_BLINKS = 0.14;
const GLANCES = 0.1;

/** The next event, from two draws of `random` (each 0…1). */
export function nextLife(random: () => number): LifeEvent {
  const inMs = lerp(LIFE_MIN_MS, LIFE_MAX_MS, random());
  const pick = random();
  const kind: LifeKind =
    pick < DOUBLE_BLINKS ? "doubleBlink"
    : pick < DOUBLE_BLINKS + GLANCES ? "glanceLeft"
    : pick < DOUBLE_BLINKS + GLANCES * 2 ? "glanceRight"
    : "blink";
  return { inMs, kind };
}

/** A random source that gives the same run for the same seed (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
