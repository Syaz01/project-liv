// Liv dancing while music plays: a groove of its own, in numbers. A bounce on
// every beat that lands squashed, a sway from side to side over two beats,
// the hands going up in turn, the feet tapping in turn, a nod at the top of
// every eight beats, and its lights pulsing on the beat. Nothing is known of
// the song's tempo, so the groove keeps one of its own.
//
// Pure: where Liv is in the dance follows from the beats danced so far and
// from how far into the dance it is (0…1), which scales every offset — the
// engine (robot.ts) keeps the clock and adds these to what it draws.
//
// Lengths are in R, the head's radius; angles in radians.

import type { BotStateName, IslandMode, IslandViewName } from "../core/layout";
import { clamp } from "../core/anim";
import { SPOTIFY_GREEN } from "../core/spotify";
import { hexToRGB, type EyeLook, type RGB } from "./look";

// ── The beat ──────────────────────────────────────────────────────────────────

export const DANCE_BPM = 116;

/** Beats danced after `seconds` of dancing: the whole part counts them, the rest is how far into this one. */
export const beatsAt = (seconds: number) => (seconds * DANCE_BPM) / 60;

/** How far into its beat, 0 (on the beat) … 1 (the next one). */
export const beatPhase = (beats: number) => beats - Math.floor(beats);

// ── In and out ────────────────────────────────────────────────────────────────

/** Liv is fully dancing this long after the music starts, and still this long after it stops. */
export const DANCE_IN_MS = 300;
export const DANCE_OUT_MS = 450;

/**
 * How far into the dance Liv is `ms` later, 0 (still) … 1 (dancing), while
 * the music is `on` or off: at an even pace, so a pause in the middle of the
 * way in turns back from where it is.
 */
export function stepDance(progress: number, on: boolean, ms: number): number {
  return clamp(progress + (on ? ms / DANCE_IN_MS : -ms / DANCE_OUT_MS), 0, 1);
}

/** How much of the dance shows that far into it: eased at both ends. */
export function danceLevel(progress: number): number {
  const p = clamp(progress, 0, 1);
  return p * p * (3 - 2 * p);
}

// ── The moves ─────────────────────────────────────────────────────────────────

/**
 * The bounce. Liv lands on the beat and stays on the ground for this share of
 * it, squashing and coming back; then it is in the air until the next beat,
 * this high at the top, a little stretched on the way up and on the way down.
 */
export const BOUNCE = { ground: 0.22, height: 0.13, squash: 0.09, stretch: 0.035 } as const;

/** How far through its time in the air, 0…1; 0 while on the ground. */
const airborne = (phase: number) => Math.max(0, (phase - BOUNCE.ground) / (1 - BOUNCE.ground));

/** How high Liv is at `phase` of a beat, 0 (on the ground) … 1 (the top). */
export function bounceAt(phase: number): number {
  const u = airborne(phase);
  return 4 * u * (1 - u);
}

/** Its squash at `phase` of a beat: negative on the ground, shorter and wider; positive in the air. */
export function squashAt(phase: number): number {
  if (phase < BOUNCE.ground) return -BOUNCE.squash * Math.sin((phase / BOUNCE.ground) * Math.PI);
  return BOUNCE.stretch * Math.sin(airborne(phase) * Math.PI * 2) ** 2;
}

/** The sway: this far to each side and the head leaning this much with it, there and back in two beats. */
export const SWAY = { reach: 0.09, tilt: 0.07 } as const;

/** Where the sway is after `beats`, −1 (left) … 1 (right). */
export const swayAt = (beats: number) => Math.sin(beats * Math.PI);

/**
 * The hands: each goes up this much (in lifts, look.ts: HAND) and down again
 * over two beats, one a beat behind the other, so one is up on every beat.
 * The wrist follows this much of a beat late, bent back by the way it moves.
 */
export const HANDS = { reach: 0.5, wrist: 0.28, late: 0.15 } as const;

/** How far up each hand is after `beats`, 0…1: left, right. The right one is up on the even beats. */
export function handsAt(beats: number): readonly [number, number] {
  const left = 0.5 - 0.5 * Math.cos(beats * Math.PI);
  return [left, 1 - left];
}

/** The bend of each wrist after `beats`, −1…1: left, right. Each trails its own hand. */
export function wristsAt(beats: number): readonly [number, number] {
  const drag = Math.sin((beats - HANDS.late) * Math.PI);
  return [-drag, drag];
}

/** The tapping foot comes this much further off the ground than the body lifts it. */
export const TAP = 0.07;

/**
 * Where each foot is at `beats`, in R from its place under the body, down
 * positive: left, right. One stays on the ground while the body bounces —
 * as far below it as the body is up — and the other leaves with it and taps
 * down on the next beat; they change over on every beat.
 */
export function feetAt(beats: number): readonly [number, number] {
  const phase = beatPhase(beats);
  const planted = bounceAt(phase) * BOUNCE.height;
  const tapping = -TAP * Math.sin(phase * Math.PI);
  return Math.floor(beats) % 2 === 0 ? [tapping, planted] : [planted, tapping];
}

/**
 * The nod: at the top of every eight beats the eyes dip this far (in gaze
 * units) and the head this far with them, and are back up in this much of a beat.
 */
export const NOD = { every: 8, beats: 0.6, gaze: 0.8, dip: 0.04 } as const;

/** How far down the nod is after `beats`, 0…1. */
export function nodAt(beats: number): number {
  const into = beats - Math.floor(beats / NOD.every) * NOD.every;
  return into < NOD.beats ? Math.sin((into / NOD.beats) * Math.PI) ** 2 : 0;
}

/** The lights come up in this share of the beat and fade over the rest of it. */
const PULSE_RISE = 0.08;

/** How lit the antenna and the eyes are at `phase` of a beat, 0…1: up on the beat, then fading. */
export function pulseAt(phase: number): number {
  return phase < PULSE_RISE ? phase / PULSE_RISE : ((1 - phase) / (1 - PULSE_RISE)) ** 2;
}

// ── The whole groove ──────────────────────────────────────────────────────────

/** Everything the dance adds to Liv at one instant. */
export interface Groove {
  /** Where the body is from its place: to the right, and down (negative = up). */
  ox: number;
  oy: number;
  squash: number;
  tilt: number;
  /** Each hand's lift and each wrist's bend: left, right. */
  reach: readonly [number, number];
  flick: readonly [number, number];
  /** Each foot from its place under the body, down positive: left, right. */
  step: readonly [number, number];
  /** How far down the eyes look, in gaze units. */
  nod: number;
  /** How much of the dance's colour its lights take, 0…1. */
  light: number;
}

const PAIR: readonly [number, number] = [0, 0];

/** Not dancing. */
export const STILL: Groove = { ox: 0, oy: 0, squash: 0, tilt: 0, reach: PAIR, flick: PAIR, step: PAIR, nod: 0, light: 0 };

/** Between two beats the lights keep this much of the dance's colour; the beat brings the rest. */
const LIGHT_FLOOR = 0.55;

/** The dance after `beats`, `level` of it showing (0 = none: STILL … 1 = all). */
export function groove(beats: number, level: number): Groove {
  if (!(level > 0)) return STILL;
  const phase = beatPhase(beats);
  const sway = swayAt(beats);
  const nod = nodAt(beats);
  const hands = handsAt(beats);
  const wrists = wristsAt(beats);
  const feet = feetAt(beats);
  return {
    ox: SWAY.reach * sway * level,
    oy: (NOD.dip * nod - BOUNCE.height * bounceAt(phase)) * level,
    squash: squashAt(phase) * level,
    tilt: SWAY.tilt * sway * level,
    reach: [HANDS.reach * hands[0] * level, HANDS.reach * hands[1] * level],
    flick: [HANDS.wrist * wrists[0] * level, HANDS.wrist * wrists[1] * level],
    step: [feet[0] * level, feet[1] * level],
    nod: NOD.gaze * nod * level,
    light: (LIGHT_FLOOR + (1 - LIGHT_FLOOR) * pulseAt(phase)) * level,
  };
}

/** Dancing, its eyes smile. */
export const DANCE_EYES: EyeLook = { shape: "arc", scale: [1, 1] };

/** The colour its lights pulse in unless it is told another: Spotify's green. */
export const DANCE_COLOR: RGB = hexToRGB(SPOTIFY_GREEN);

// ── When ──────────────────────────────────────────────────────────────────────

/** What the island knows when it asks whether Liv dances. */
export interface DanceScene {
  /** Music is playing on a declared Spotify pill. */
  playing: boolean;
  /** The Spotify pill is the one in front, its card showing. */
  inFront: boolean;
  mode: IslandMode;
  view: IslandViewName;
  parked: boolean;
  paused: boolean;
  /** The state Liv wears. */
  state: BotStateName;
}

/**
 * Whether Liv dances now: music playing, on the open island with the Spotify
 * pill's card in front, in sight and not paused — and nothing to say. A state
 * with a look of its own (a request, an error, work going on) always comes
 * before the dance.
 */
export function shouldDance(scene: DanceScene): boolean {
  return scene.playing && scene.inFront && scene.mode === "expanded" && scene.view === "overview" &&
    !scene.parked && !scene.paused && scene.state === "idle";
}
