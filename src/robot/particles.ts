// What leaves Liv for a moment: hearts that float up from its head and fade,
// stars that circle over it while it is dizzy. A particle is a kind, an age
// and a seat; where it is and how it looks follows from those alone, so the
// engine (robot.ts) only ages them and the painter (paint.ts) only draws them.
// No canvas and no clock here.
//
// Lengths are in R, the head's radius, from the head's centre at rest.

import { Ease, lerp, seg } from "../core/anim";

export type ParticleKind = "heart" | "star";

export interface Particle {
  kind: ParticleKind;
  ageMs: number;
  lifeMs: number;
  /** A heart: where across the head it leaves from, in R. A star: its place on the ring, 0…1. */
  seat: number;
  /** A heart: the side it drifts to as it rises, −1…1. A star has none. */
  drift: number;
}

/** A particle as it is drawn: its centre, its half-size, its opacity and its turn (radians). */
export interface ParticleShape {
  kind: ParticleKind;
  x: number;
  y: number;
  size: number;
  alpha: number;
  turn: number;
}

/**
 * The hearts: each leaves the top of the head, pops to its size, rises about
 * a head's radius swaying to its side, and fades over the last part of its
 * life. Five of them, one every 140 ms, from these seats and to these sides.
 */
export const HEARTS = {
  from: -0.95,
  rise: 0.98,
  size: 0.16,
  lifeMs: 1150,
  everyMs: 140,
  seats: [-0.4, 0.34, -0.06, 0.52, -0.28],
  drifts: [-1, 0.7, 0.35, 1, -0.6],
} as const;

/**
 * The stars: three on a flat ring around the antenna's stem, one turn every
 * 1.1 s. The ring is seen from a little above, so a star is bigger on the near
 * side than on the far one.
 */
export const STARS = {
  count: 3,
  y: -1.28,
  rx: 0.8,
  ry: 0.2,
  size: 0.125,
  turnMs: 1100,
  inMs: 180,
  outMs: 320,
} as const;

export const heart = (index: number): Particle => ({
  kind: "heart",
  ageMs: 0,
  lifeMs: HEARTS.lifeMs,
  seat: HEARTS.seats[index % HEARTS.seats.length],
  drift: HEARTS.drifts[index % HEARTS.drifts.length],
});

/** The ring of stars, to last `lifeMs`. */
export const stars = (lifeMs: number): Particle[] =>
  Array.from({ length: STARS.count }, (_, i) => ({ kind: "star", ageMs: 0, lifeMs, seat: i / STARS.count, drift: 0 }));

/** The particles `ms` later: older, and without those whose life is over. */
export function ageParticles(particles: readonly Particle[], ms: number): Particle[] {
  return particles.map((p) => ({ ...p, ageMs: p.ageMs + ms })).filter((p) => p.ageMs < p.lifeMs);
}

/** A particle that fades from now on, gone in `ms` at the latest. */
export const fading = (p: Particle, ms: number): Particle => ({ ...p, lifeMs: Math.min(p.lifeMs, p.ageMs + ms) });

/** How it looks at its age. */
export function particleShape(p: Particle): ParticleShape {
  if (p.kind === "star") {
    const angle = (p.seat + p.ageMs / STARS.turnMs) * Math.PI * 2;
    const near = Math.sin(angle);
    return {
      kind: "star",
      x: Math.cos(angle) * STARS.rx,
      y: STARS.y + near * STARS.ry,
      size: STARS.size * (1 + 0.22 * near),
      alpha: seg(p.ageMs, 0, STARS.inMs) * (1 - seg(p.ageMs, p.lifeMs - STARS.outMs, p.lifeMs)),
      turn: angle * 1.5,
    };
  }
  const t = p.ageMs / p.lifeMs;
  const sway = Math.sin(t * Math.PI * 1.5);
  return {
    kind: "heart",
    x: p.seat + p.drift * 0.16 * sway,
    y: HEARTS.from - HEARTS.rise * Ease.out(t),
    size: HEARTS.size * lerp(0.3, 1, Ease.back(seg(t, 0, 0.22))),
    alpha: 1 - seg(t, 0.55, 1),
    turn: p.drift * 0.22 * sway,
  };
}
