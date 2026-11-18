// Liv on the desktop, in numbers: how big it is drawn, how big its window has
// to be so that nothing of it is ever cut — the antenna at the top of a hop,
// a raised hand, the badge, the hearts — and which part of that window is Liv
// itself: its head, its hands and its feet. Anywhere else in the window a
// click belongs to whatever is underneath. No DOM here: the page (main.ts)
// draws by these and hands the shape to Rust, which tests the pointer against
// it (src-tauri/src/pet.rs).
//
// Lengths are in page px, from the window's top-left corner; the island's
// size setting zooms the page, as it does the island's (core/scale.ts).

import { FOOT, HAND, HEAD_FIT, antennaHalo, headRadius, robotBounds, robotGeometry } from "../robot/look";
import { HEARTS } from "../robot/particles";

/** The slot Liv is given on the desktop: a little more than in the island's cards. */
export const PET_SLOT = 72;

/** Its head's radius there. */
export const PET_R = headRadius(PET_SLOT);

/**
 * The air Liv needs around it, in R, on top of how far it reaches at rest:
 * above, the highest hop with the stretch and the antenna's swing that come
 * with it; to the sides, a shake and the widening of a squash; below, the
 * hover.
 */
const AIR = { above: 0.75, beside: 0.25, below: 0.2 } as const;

/** The antenna's light at its brightest: lit, breathing, and flashing on top. */
const BRIGHTEST = 2.3;
/** The badge by the head, in half slots: how far right its middle is, and its ring at the top of its pop. */
const BADGE = { x: 0.85, r: 0.3 * 1.15 } as const;

/** How far the figure reaches from its head's centre, in R, with everything it does. */
function reach(): { top: number; bottom: number; side: number } {
  const g = robotGeometry(PET_R);
  const body = robotBounds(g, "body");
  const antenna = -g.ballY + g.ballR * antennaHalo(BRIGHTEST);
  const hearts = HEARTS.rise - HEARTS.from + HEARTS.size;
  // A hand swung all the way out, and the badge, whichever reaches further.
  const hand = -HAND.pivotX + HAND.arm + HAND.half + HAND.bottomR;
  const badge = (BADGE.x + BADGE.r) / (2 * HEAD_FIT);
  return {
    top: Math.max(antenna + AIR.above, hearts),
    bottom: body.bottom + AIR.below,
    side: Math.max(hand, badge) + AIR.beside,
  };
}

export interface PetWindow {
  /** The window, and the canvas that fills it. */
  w: number;
  h: number;
  /** Where the head's centre rests in it. */
  cx: number;
  cy: number;
}

/** The window for a head of radius `R`: whole pixels, the head in the middle of its width. */
export function petWindow(R: number = PET_R): PetWindow {
  const room = reach();
  const half = Math.ceil(room.side * R);
  const above = Math.ceil(room.top * R);
  return { w: half * 2, h: above + Math.ceil(room.bottom * R), cx: half, cy: above };
}

/** The window Liv lives in on the desktop. Rust creates it at this size (pet.rs: PAGE_W, PAGE_H). */
export const PET_WINDOW = petWindow();

// ── The silhouette ────────────────────────────────────────────────────────────

/** A disc of the hit shape, in page px. */
export interface Disc {
  x: number;
  y: number;
  r: number;
}

/** The head is caught a little beyond its edge, as on the island (robot/react.ts). */
const HEAD_REACH = 1.05;

/**
 * What of the window is Liv, at rest: its head, and a disc over each hand
 * and each foot. Simple on purpose: the discs cover the middle of each limb
 * and reach a pixel or two past its edge, never further.
 */
export function hitShape(place: PetWindow = PET_WINDOW, R: number = PET_R): Disc[] {
  // A hand hangs from its shoulder, leaning out: the middle of its paddle.
  const handX = -HAND.pivotX + HAND.arm * Math.sin(HAND.angle);
  const handY = HAND.pivotY + HAND.arm * Math.cos(HAND.angle);
  // A foot: under the body, between its top and its tip, which is towards the middle.
  const footX = -FOOT.x - FOOT.tipX / 2;
  const footY = FOOT.y + FOOT.tipY / 2;
  const discs: Disc[] = [{ x: 0, y: 0, r: HEAD_REACH }];
  for (const side of [-1, 1]) {
    discs.push({ x: side * handX, y: handY, r: HAND.half });
    discs.push({ x: side * footX, y: footY, r: FOOT.half });
  }
  return discs.map((d) => ({ x: place.cx + d.x * R, y: place.cy + d.y * R, r: d.r * R }));
}

/** Whether a pointer at `x`, `y` (page px in the window) is on Liv. */
export function onShape(x: number, y: number, shape: readonly Disc[]): boolean {
  return shape.some((d) => Math.hypot(x - d.x, y - d.y) <= d.r);
}

/** Whether the pointer is on the head: where a click annoys it and a rest wins it over. */
export function onPetHead(x: number, y: number, place: PetWindow = PET_WINDOW, R: number = PET_R): boolean {
  return Math.hypot(x - place.cx, y - place.cy) <= R * HEAD_REACH;
}
