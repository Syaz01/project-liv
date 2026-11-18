// The specks of light that drift behind Liv: in the bands of the Liv window
// (hub/hero.ts) and beside the chat (views/chat.ts). They drift all the time,
// each twinkling on its own clock, and move away from the pointer, brighter
// and bigger while it is near. No DOM here: the caller owns the canvas, says
// how big it is and where the pointer is, and gets circles to fill.

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** How near it is, 0.35 (far: slow and faint) to 1. */
  depth: number;
  phase: number;
  /** White, else the colour of the place. */
  white: boolean;
}

export interface Point {
  x: number;
  y: number;
}

/** The pointer pushes those within this many px, and lights those within `NEAR`. */
const PUSH = 140;
const NEAR = 200;

/** How many for a room of `w` × `h` px: one for every `per` px², within `min` and `max`. */
export function particleCount(w: number, h: number, per = 2600, min = 24, max = 90): number {
  return Math.round(Math.min(max, Math.max(min, (w * h) / per)));
}

export function seedParticles(w: number, h: number, count: number, random: () => number = Math.random): Particle[] {
  return Array.from({ length: count }, () => ({
    x: random() * w,
    y: random() * h,
    vx: (random() - 0.5) * 6,
    vy: -2 - random() * 6,
    r: 0.5 + random() * 1.4,
    depth: 0.35 + random() * 0.65,
    phase: random() * Math.PI * 2,
    white: random() < 0.35,
  }));
}

/**
 * Moves `p` on by `dt` seconds in a room of `w` × `h` px and says how it shows
 * at time `t`: its opacity and its radius. `strength` is how much the pointer
 * counts, 0…1 (it comes and goes softly: the caller eases it).
 */
export function stepParticle(
  p: Particle,
  dt: number,
  t: number,
  w: number,
  h: number,
  pointer: Point | null,
  strength: number,
): { alpha: number; r: number } {
  // Drift, always; the pointer pushes them away.
  p.x += p.vx * dt * p.depth;
  p.y += p.vy * dt * p.depth;
  let alpha = (0.22 + 0.5 * (0.5 + 0.5 * Math.sin(t * (1.2 + p.depth) + p.phase))) * p.depth;
  let r = p.r;
  if (pointer && strength > 0.01) {
    const dx = p.x - pointer.x;
    const dy = p.y - pointer.y;
    const d = Math.hypot(dx, dy);
    if (d < PUSH && d > 0.1) {
      const push = (1 - d / PUSH) * 90 * strength * dt;
      p.x += (dx / d) * push;
      p.y += (dy / d) * push;
    }
    if (d < NEAR) {
      const near = (1 - d / NEAR) * strength;
      alpha += near * 0.6;
      r *= 1 + near * 0.8;
    }
  }
  // Out on one side, back in on the other.
  if (p.y < -4) p.y = h + 4;
  if (p.y > h + 4) p.y = -4;
  if (p.x < -4) p.x = w + 4;
  if (p.x > w + 4) p.x = -4;
  return { alpha: Math.min(1, alpha), r };
}

/** What `paintParticles` draws on: the few calls of a 2D canvas it makes. */
export interface ParticleCanvas {
  fillStyle: string | CanvasGradient | CanvasPattern;
  beginPath(): void;
  arc(x: number, y: number, r: number, from: number, to: number): void;
  fill(): void;
}

/**
 * One frame: every particle moved on and drawn — a dot, and a soft halo round
 * the bigger ones. `tint` gives the colour of a white one or a coloured one at
 * an opacity.
 */
export function paintParticles(
  ctx: ParticleCanvas,
  particles: Particle[],
  dt: number,
  t: number,
  w: number,
  h: number,
  pointer: Point | null,
  strength: number,
  tint: (white: boolean, alpha: number) => string,
) {
  for (const p of particles) {
    const { alpha, r } = stepParticle(p, dt, t, w, h, pointer, strength);
    if (r > 1.1) {
      ctx.fillStyle = tint(p.white, alpha * 0.12);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = tint(p.white, alpha);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}
