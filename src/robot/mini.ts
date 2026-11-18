// Minis: the small still figures on a pill, in the compact island's grid and
// on the office card. Painted once when built — nothing here moves, so
// nothing asks for a frame.

import { CANVAS_PER_SLOT, hexToRGB } from "./look";
import { paintSlotRobot } from "./paint";

/** Painted at twice its size: sharp on a monitor of any scale, without a repaint. */
const DENSITY = 2;

/** A plain dot: this much of its slot across, this far below the middle of it. */
const DOT_RADIUS = 0.44;
const DOT_DROP = 0.03;

/**
 * A slot of `bodySize` CSS pixels with a canvas painted by `paint`.
 *
 * The canvas is larger than the slot (look.ts: CANVAS_PER_SLOT) and centred on
 * it, overflowing it. The slot is what the pill lays out.
 *
 * `scale` is the island's size (core/scale.ts): a bigger island shows the mini
 * on that many more pixels, so it is painted on as many. Whoever keeps minis
 * builds them again when the size changes.
 */
function mini(bodySize: number, scale: number, paint: (ctx: CanvasRenderingContext2D, size: number) => void): HTMLElement {
  const slot = document.createElement("span");
  slot.className = "mini";
  slot.style.width = `${bodySize}px`;
  slot.style.height = `${bodySize}px`;

  const canvas = document.createElement("canvas");
  const size = bodySize * CANVAS_PER_SLOT;
  const density = DENSITY * scale;
  canvas.width = Math.round(size * density);
  canvas.height = Math.round(size * density);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  slot.append(canvas);

  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.setTransform(density, 0, 0, density, 0, 0);
    paint(ctx, size);
  }
  return slot;
}

/** Liv's head with a shell of `color`, for a slot of `bodySize` CSS pixels: a pill's figure. */
export function miniRobot(color: string, bodySize: number, scale: number): HTMLElement {
  return mini(bodySize, scale, (ctx, size) => paintSlotRobot(ctx, size, { shell: hexToRGB(color) }));
}

/** A plain dot of `color`: a state, not a figure (the office card's agents). */
export function miniDot(color: string, bodySize: number, scale: number): HTMLElement {
  return mini(bodySize, scale, (ctx, size) => {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2 + bodySize * DOT_DROP, bodySize * DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });
}
