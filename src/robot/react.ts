// What the pointer does to Liv on the open island: where its head is to be
// clicked or rested on, and how clicks add up. A click annoys it; three in a
// row make it dizzy; a pointer left resting on it wins it over. Pure: the
// engine (robot.ts) keeps the time, the island says where the pointer is.

import { headRadius, robotDrop, robotGeometry } from "./look";

/** Clicks: this many within this long make Liv dizzy; fewer only annoy it. How long each lasts, ms. */
export const POKE = { dizzyAt: 3, withinMs: 1700, annoyedMs: 1200, dizzyMs: 3300 } as const;

/** The pointer resting on Liv: after this long, hearts, for this long; then this long before it can happen again. */
export const LOVE_TIMES = { restMs: 2000, lastsMs: 1900, cooldownMs: 6000 } as const;

/** The head is clicked a little beyond its edge too. */
const HEAD_REACH = 1.05;

/**
 * Whether a pointer `dx`, `dy` px from the middle of the figure's slot is on
 * its head: a slot of `slot` px, `limbs` of its hands and feet out (0…1) —
 * with them the head sits higher in its slot (look.ts: robotDrop).
 */
export function onHead(dx: number, dy: number, slot: number, limbs: number): boolean {
  const R = headRadius(slot);
  if (!(R > 0)) return false;
  return onHeadAt(dx, dy - robotDrop(robotGeometry(R), limbs) * R, R);
}

/** Whether a pointer `dx`, `dy` px from the centre of a head of radius `R` is on it. */
export function onHeadAt(dx: number, dy: number, R: number): boolean {
  return R > 0 && Math.hypot(dx, dy) <= R * HEAD_REACH;
}

/**
 * One more click, at `nowMs`, after the clicks at `times`: the clicks that
 * still count, and whether this one makes Liv dizzy — which starts the count over.
 */
export function countPoke(times: readonly number[], nowMs: number): { times: number[]; dizzy: boolean } {
  const recent = [...times.filter((t) => nowMs - t < POKE.withinMs), nowMs];
  return recent.length >= POKE.dizzyAt ? { times: [], dizzy: true } : { times: recent, dizzy: false };
}
