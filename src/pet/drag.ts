// Picking Liv up and putting it down: when a press on it becomes a drag, and
// what a drop means. Pressed on the open island and moved past a few pixels,
// Liv is picked up and follows the pointer in its own window; let go over the
// island it is home again, anywhere else it stays where it was dropped. A
// press let go before that is a click, as it always was. Pure: the island
// (island/island.ts), the desktop window (main.ts) and Rust do the rest.

import { COMPACT_W, NOTCH_H } from "../core/layout";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A press that moves further than this is a drag, page px. */
export const DRAG_THRESHOLD = 6;

/** Whether the pointer, pressed at `press` and now at `now`, has started a drag. */
export function isDrag(press: Point, now: Point): boolean {
  return Math.hypot(now.x - press.x, now.y - press.y) > DRAG_THRESHOLD;
}

/** Around the island, how near a drop still counts as on it, page px. */
export const HOME_MARGIN = 28;

/**
 * Where a drop brings Liv home: the island as it is drawn, with a margin —
 * and never smaller than the compact island, so a closed or hidden one can
 * still be aimed at. `island` is its shape in its page: glued to the top
 * edge, centred.
 */
export function homeZone(island: Rect): Rect {
  const w = Math.max(island.w, COMPACT_W) + HOME_MARGIN * 2;
  const h = Math.max(island.h, NOTCH_H) + HOME_MARGIN;
  // Above the top edge too: a pointer pushed against the top of the screen is on the island.
  return { x: island.x + island.w / 2 - w / 2, y: island.y - HOME_MARGIN, w, h: h + HOME_MARGIN };
}

/** What a drop at `point` means, in the island page's coordinates: Liv is home, or stays where it is. */
export function dropOutcome(point: Point, island: Rect): "home" | "stay" {
  const zone = homeZone(island);
  const inside =
    point.x >= zone.x && point.x <= zone.x + zone.w && point.y >= zone.y && point.y <= zone.y + zone.h;
  return inside ? "home" : "stay";
}
