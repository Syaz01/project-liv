// The specks that drift behind Liv in the island's cards: the ones of the Liv
// window's bands (core/particles.ts), on a canvas laid under a card's content.
// They drift, twinkle and move away from the pointer; white, and the colour
// the card gives them — who answers in the chat, the pill in front elsewhere.
//
// They move only on the open island, in sight and not paused: it already
// draws every frame there for Liv's breath, so they cost no frame of their
// own, and folded, parked or paused they ask for none.

import { paintParticles, particleCount, seedParticles, type Particle, type Point } from "../core/particles";
import { State } from "../core/state";
import { hexToRGB } from "../robot/look";
import { h } from "./dom";

/**
 * Where the specks go in the card: `side` is the room the card leaves Liv on
 * its left (they thin out towards the content), `whole` is all of it.
 */
export type StarRoom = "side" | "whole";

/** One speck for every this many px² of the room, within these counts. */
const DENSITY: Record<StarRoom, { per: number; min: number; max: number }> = {
  side: { per: 1100, min: 10, max: 40 },
  whole: { per: 2400, min: 14, max: 60 },
};
/** How tall a card is counted as when they are first spread: about what the island's cards are. */
const ROOM_H = 150;

export interface StarField {
  el: HTMLCanvasElement;
  /** One frame, in `color` (#RRGGBB). True: they are moving and want the next one. */
  tick(nowMs: number, color: string): boolean;
}

/**
 * Whether the specks may move now: where Liv breathes. With Liv out on the
 * desktop nothing moves in the open island, and they stand still with it.
 */
export function starsLive(): boolean {
  return State.mode === "expanded" && !State.parked && !State.paused && !State.petAway;
}

/**
 * A field of specks under the content of `card`, which becomes their room:
 * its pointer pushes them away.
 */
export function addStars(card: HTMLElement, room: StarRoom): StarField {
  const el = h("canvas", { class: `stars ${room}` }) as HTMLCanvasElement;
  card.classList.add("starry");
  card.prepend(el);

  let field: Particle[] = [];
  let pointer: Point | null = null;
  let strength = 0;
  let last = 0;
  /** The room they were last drawn in, px. */
  let size = { w: 0, h: 0 };
  /** "r,g,b" of the colour they were last drawn in. */
  let tinted = { hex: "", rgb: "" };

  card.addEventListener("pointermove", (e) => {
    const box = el.getBoundingClientRect();
    pointer = { x: (e as PointerEvent).clientX - box.left, y: (e as PointerEvent).clientY - box.top };
  });
  card.addEventListener("pointerleave", () => (pointer = null));

  return {
    el,
    tick(nowMs, color) {
      if (!starsLive()) {
        // The next frame comes after a pause: no jump when they move again.
        last = 0;
        return false;
      }
      const w = el.clientWidth;
      const height = el.clientHeight;
      const ctx = w && height ? el.getContext?.("2d") : null;
      if (!ctx) return true;
      const dt = last ? Math.min(0.05, (nowMs - last) / 1000) : 0;
      last = nowMs;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(height * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(height * dpr);
      }
      if (field.length === 0) {
        const d = DENSITY[room];
        field = seedParticles(w, height, particleCount(w, Math.max(height, ROOM_H), d.per, d.min, d.max));
      }
      // The card grows and shrinks with what it shows, and from nothing as the
      // island opens: they keep their places in it, spread over the whole room.
      if (size.w !== w || size.h !== height) {
        if (size.w && size.h) for (const p of field) (p.x *= w / size.w), (p.y *= height / size.h);
        size = { w, h: height };
      }
      if (tinted.hex !== color) {
        const [r, g, b] = hexToRGB(color);
        tinted = { hex: color, rgb: `${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}` };
      }
      strength += ((pointer ? 1 : 0) - strength) * Math.min(1, dt * 4);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintParticles(ctx, field, dt, nowMs / 1000, w, height, pointer, strength, (white, alpha) =>
        `rgba(${white ? "255,255,255" : tinted.rgb},${alpha})`,
      );
      return true;
    },
  };
}
