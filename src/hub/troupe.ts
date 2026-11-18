// The troupe: the Livs that stand on the right of the band on top of each page
// of the Liv window. Who is in it on each page, where each one stands in the
// room the title leaves, which one is under the pointer, and the small thing
// one of them does now and then. No canvas and no clock here: the band
// (hero.ts) draws them with the real engine and keeps the time.

import { lerp } from "../core/anim";
import type { BotStateName } from "../core/layout";
import { headRadius, robotBounds, robotGeometry } from "../robot/look";
import { onHeadAt } from "../robot/react";
import type { Bit } from "../robot/robot";

// ── The cast ──────────────────────────────────────────────────────────────────

export interface CastMember {
  /** The pill whose colour its shell wears (core/pills.ts); null = Liv's own. */
  pill: string | null;
  state: BotStateName;
  /** The room it is given, px: about what the whole figure measures, each way. */
  slot: number;
  /** Where its eyes rest while the pointer is elsewhere, in gaze units. */
  gaze: readonly [number, number];
  /** It is Liv itself, not a pill's figure: it wears what Liv wears (Settings → Liv wears). */
  dressed: boolean;
}

/** What one of the troupe does now and then: one of the engine's bits, or a glance at its neighbour. */
export type TroupeBit = Bit | "glance";

export interface Cast {
  /** From left to right. */
  members: readonly CastMember[];
  /** What they do now and then, one of them at a time. */
  bits: readonly TroupeBit[];
  /** Between two bits: never less, never more, ms. */
  every: readonly [number, number];
}

const liv = (slot: number, more: Partial<Omit<CastMember, "slot">> = {}): CastMember => ({
  pill: null, state: "idle", gaze: [0, 0], dressed: false, ...more, slot,
});

/** A wave to whoever is looking, a little hop, a glance at a neighbour: every 6 to 12 s. */
const IDLING: Pick<Cast, "bits" | "every"> = { bits: ["wave", "hop", "glance"], every: [6000, 12000] };

/**
 * Each page's cast. General: Liv itself, in what it wears. Active pills: a line-up in four
 * pills' colours. Agents: one working, one thinking, one asking. Chat: two
 * facing each other, one of them typing its answer. Integrations: three in
 * services' colours. Shortcuts: one at an imaginary keyboard, typing in bursts.
 */
export const CASTS: Record<string, Cast> = {
  general: { ...IDLING, members: [liv(64, { dressed: true })] },
  pills: {
    ...IDLING,
    members: [
      liv(48, { pill: "agent_codex" }), liv(46, { pill: "agent_antigravity" }),
      liv(50, { pill: "agent_amp" }), liv(46, { pill: "integration_spotify" }),
    ],
  },
  agents: {
    ...IDLING,
    members: [liv(56, { state: "working" }), liv(52, { state: "thinking" }), liv(58, { state: "approval" })],
  },
  chat: {
    ...IDLING,
    members: [liv(58, { gaze: [0.75, 0] }), liv(54, { pill: "ai_anthropic", state: "working", gaze: [-0.75, 0] })],
  },
  integrations: {
    ...IDLING,
    members: [
      liv(54, { pill: "integration_github" }), liv(58, { pill: "integration_vercel" }),
      liv(52, { pill: "integration_office" }),
    ],
  },
  shortcuts: { members: [liv(60, { gaze: [0, 0.9] })], bits: ["type"], every: [2600, 4200] },
};

/** The cast of `page`; a page without one has General's. */
export const castFor = (page: string): Cast => CASTS[page] ?? CASTS.general;

// ── Where they stand ──────────────────────────────────────────────────────────

/**
 * The troupe's place in its canvas, px: clear of the band's right edge and of
 * the title's text, feet on a floor this far above the band's bottom edge.
 * Each has its slot and a little more to stand in (`pitch`, in slots). Short
 * of room they all shrink together, down to `smallest` of their size; shorter
 * still, the one nearest the text leaves, and so on. The smaller ones stand
 * further back: higher by this much of what they lack in size.
 */
export const TROUPE = { edge: 26, gap: 22, floor: 38, pitch: 1.16, smallest: 0.8, back: 0.6 } as const;

/** One of the troupe where it stands. */
export interface Standing {
  /** Which of the cast's members. */
  member: number;
  /** Its head's radius, and its head's centre at rest. */
  R: number;
  cx: number;
  cy: number;
  /** The floor under its feet. */
  floor: number;
}

/**
 * Where the cast stands in a canvas of `width` × `height` whose left side is
 * taken by text up to `textRight` (px from the canvas's left edge; negative
 * when the text ends before the canvas starts). In the middle of the canvas
 * when there is room, against its right edge otherwise; nobody when not even
 * one fits.
 */
export function troupeLayout(cast: Cast, width: number, height: number, textRight: number): Standing[] {
  const left = Math.max(0, textRight + TROUPE.gap);
  const right = width - TROUPE.edge;
  const room = right - left;
  for (let first = 0; first < cast.members.length; first++) {
    const members = cast.members.slice(first);
    const natural = members.reduce((sum, m) => sum + m.slot * TROUPE.pitch, 0);
    const scale = Math.min(1, room / natural);
    if (scale < TROUPE.smallest) continue;

    const span = natural * scale;
    const tallest = Math.max(...members.map((m) => m.slot)) * scale;
    let x = Math.min(Math.max((width - span) / 2, left), right - span);
    return members.map((m, i) => {
      const slot = m.slot * scale;
      const R = headRadius(slot);
      const floor = height - TROUPE.floor - (tallest - slot) * TROUPE.back;
      const cx = x + (slot * TROUPE.pitch) / 2;
      x += slot * TROUPE.pitch;
      return { member: first + i, R, cx, cy: floor - robotBounds(robotGeometry(R), "body").bottom * R, floor };
    });
  }
  return [];
}

/** Which of them has its head under a pointer at `x`, `y` in the canvas: its place in `standing`, or null. */
export function memberAt(standing: readonly Standing[], x: number, y: number): number | null {
  const at = standing.findIndex((s) => onHeadAt(x - s.cx, y - s.cy, s.R));
  return at < 0 ? null : at;
}

// ── What they do now and then ─────────────────────────────────────────────────

export interface BitCue {
  /** How long from now, ms. */
  inMs: number;
  /** Who: its place among those standing. */
  who: number;
  bit: TroupeBit;
  /** A glance: to the left (−1) or to the right (1), where a neighbour stands. */
  toward: -1 | 1;
}

/**
 * The next bit for a troupe of `count` standing, from four draws of `random`
 * (each 0…1): when, who, what, and for a glance which neighbour. Alone, there
 * is nobody to glance at. Null when nobody stands, or the cast does nothing.
 */
export function nextBit(random: () => number, cast: Cast, count: number): BitCue | null {
  const bits = cast.bits.filter((bit) => bit !== "glance" || count > 1);
  if (count < 1 || bits.length === 0) return null;
  const inMs = lerp(cast.every[0], cast.every[1], random());
  const who = Math.min(count - 1, Math.floor(random() * count));
  const bit = bits[Math.min(bits.length - 1, Math.floor(random() * bits.length))];
  const side = random() < 0.5 ? -1 : 1;
  return { inMs, who, bit, toward: who === 0 ? 1 : who === count - 1 ? -1 : side };
}
