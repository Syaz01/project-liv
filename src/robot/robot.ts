// Liv, alive: the island's figure. The state shows on its lights (the antenna
// and the eyes) and in the shape of its eyes; it hops, shakes, blinks, looks
// at the pointer and breathes; a status badge sits by its head. And it has
// moods of its own, whatever the state: a click annoys it, three make it
// dizzy, a pointer left resting on it wins it over, and at launch it waves.
// While music plays it dances (dance.ts), and waiting in the Liv window it
// has small bits of its own: a wave, a hop, a burst of typing. And it wears
// what it is told to (outfits.ts): the thing in place goes, the next pops on.
//
// Out on the desktop (src/pet) it hovers, is carried through the air, lands,
// and falls asleep when left alone.
//
// Everything moves by the `dt` handed to update(): the engine reads no clock,
// sets no timer and touches no DOM, so it can be stepped by hand in a test.
// draw() only needs a 2D context.

import { Ease, Spring, clamp, lerp, type EaseFn } from "../core/anim";
import type { BotStateName } from "../core/layout";
import {
  DANCE_COLOR, DANCE_EYES, STILL, beatPhase, beatsAt, danceLevel, groove, pulseAt, stepDance, type Groove,
} from "./dance";
import { nextLife, type LifeKind } from "./life";
import {
  ANTENNA_OFF, CANVAS_PER_SLOT, EYE_SHAPES, EYE_SWAP_MS, HEAD_FIT, HELLO, LOVE, LOVE_EYES, ROBOT_STATES, SHELL_ICE,
  antennaColor, eyeKey, eyeSwap, followColor, followShare, gazeFor, headRadius, mix, rgba, robotDrop, robotGeometry,
  type Badge, type EyeLook, type EyeShape, type RGB, type RobotLook, type RobotPose,
} from "./look";
import { OUTFIT_OFF_MS, OUTFIT_ON_MS, type Outfit } from "./outfits";
import { paintParticle, paintRobot } from "./paint";
import { HEARTS, ageParticles, fading, heart, particleShape, stars, type Particle } from "./particles";
import { LOVE_TIMES, POKE, countPoke } from "./react";

// ── Tweens ────────────────────────────────────────────────────────────────────

type TweenKey = readonly [target: number, durationMs: number, ease: EaseFn];

interface Tween {
  keys: readonly TweenKey[];
  from: number;
  ms: number;
  totalMs: number;
  onComplete?: () => void;
}

/** What a tween can move. Offsets (`ox`, `oy`) are in R, the head's radius. */
type PropKey =
  | "ox" | "oy" | "squash" | "tilt" | "badgeS"
  | "blink" | "glance" | "eyeT"
  | "hands" | "feet" | "lift"
  | "lit" | "flash"
  | "wobble" | "raise" | "swing" | "wrist" | "reachL" | "reachR"
  | "wear";

/** What a mood moves, and what goes back to rest when it is cut short. */
const MOOD_PROPS: readonly PropKey[] = [
  "ox", "oy", "squash", "lift", "flash", "wobble", "raise", "swing", "wrist", "reachL", "reachR",
];

/** The value of a chain of keys `ms` after it started from `from`. */
function sampleKeys(from: number, keys: readonly TweenKey[], ms: number): number {
  let value = from;
  let left = ms;
  for (const [target, durationMs, ease] of keys) {
    if (left < durationMs) return value + (target - value) * ease(Math.max(0, left / durationMs));
    value = target;
    left -= durationMs;
  }
  return value;
}

const totalMs = (keys: readonly TweenKey[]) => keys.reduce((sum, k) => sum + k[1], 0);

/** One soft pulse of scale: up to 1.12 in 140 ms, back to rest in 260 ms. */
const PULSE: readonly TweenKey[] = [[1.12, 140, Ease.out], [1, 260, Ease.back]];

/** The scale of the pulse `ms` after it starts: 1 before it and once it is over. */
export function pulseScale(ms: number): number {
  return sampleKeys(1, PULSE, ms);
}

// ── Motion ────────────────────────────────────────────────────────────────────

/** The hop of a request that waits for an answer, in R. */
const HOP: readonly TweenKey[] = [[-0.27, 150, Ease.out], [0, 300, Ease.back]];
/** With it the antenna blinks three times, then stays lit. */
const BLINK_LIGHT: readonly TweenKey[] = [
  [0.1, 90, Ease.inOut], [1, 90, Ease.inOut],
  [0.1, 90, Ease.inOut], [1, 90, Ease.inOut],
  [0.1, 90, Ease.inOut], [1, 90, Ease.inOut],
];
/** The shake of an error, in R. */
const SHAKE: readonly TweenKey[] = [
  [0.11, 50, Ease.out], [-0.11, 70, Ease.inOut],
  [0.07, 70, Ease.inOut], [0, 90, Ease.out],
];
/**
 * The happy hop of a finished task. It gathers itself (a squash), springs up
 * stretched, comes down, squashes on landing and settles; the hands go up on
 * the way and the antenna flashes once.
 */
const JOY_SQUASH: readonly TweenKey[] = [
  [-0.09, 90, Ease.out], [0.08, 110, Ease.out], [0.04, 210, Ease.lin],
  [-0.07, 70, Ease.out], [0, 220, Ease.back],
];
const JOY_HOP: readonly TweenKey[] = [[0, 90, Ease.lin], [-0.26, 170, Ease.out], [0, 150, Ease.easeIn]];
const JOY_HANDS: readonly TweenKey[] = [[0, 90, Ease.lin], [1, 180, Ease.back], [1, 240, Ease.lin], [0, 260, Ease.inOut]];
const FLASH: readonly TweenKey[] = [[1, 120, Ease.out], [0, 420, Ease.inOut]];
/** How much narrower the figure gets for each part it gets taller. */
const SQUASH_SIDE = 0.7;

/** The head takes its tilt in this long. */
const TILT_MS = 220;

/** A blink: down in 70 ms, up in 110. */
const BLINK: readonly TweenKey[] = [[1, 70, Ease.out], [0, 110, Ease.out]];
const DOUBLE_BLINK: readonly TweenKey[] = [...BLINK, [0, 90, Ease.lin], ...BLINK];
/** A glance to one side, in gaze units: over, a look, and back. */
const glance = (side: number): readonly TweenKey[] => [[side * 0.9, 160, Ease.out], [side * 0.9, 620, Ease.lin], [0, 220, Ease.inOut]];

/** Hands and feet pop out when the island opens, the hands a moment after the feet; they tuck away faster. */
const LIMBS_OUT_MS = 260;
const LIMBS_STAGGER_MS = 70;
const LIMBS_IN_MS = 160;

/** Breathing, while the island is open: a slight swell and a slight float, this often. */
const BREATH_S = 3.2;
const BREATH_SWELL = 0.012;
const BREATH_FLOAT = 0.02;
/** On the desktop it hovers: it floats this far with each breath, in R (src/pet). */
export const HOVER_FLOAT = 0.085;
/** How much the antenna's halo swells and fades with each of its own breaths. */
const HALO_BREATH = 0.3;

/** The antenna's tip follows the body on a loose spring: it trails, then catches up. */
const SWAY_RESPONSE = 0.3;
const SWAY_DAMPING = 0.34;
const SWAY_MAX = 0.3;

// ── Moods ─────────────────────────────────────────────────────────────────────

/** What the pointer can do to Liv (react.ts). */
export type Reaction = "annoyed" | "dizzy" | "love";

/**
 * A mood of Liv's own, over the state's look for as long as it lasts: other
 * eyes, and for some another colour in them. The antenna and the badge stay
 * the state's.
 */
interface Mood {
  kind: Reaction | "greeting" | "bit";
  eyes: EyeLook | null;
  eyeColor: RGB | null;
  halo: RGB | null;
}

const eyes = (shape: EyeShape): EyeLook => ({ shape, scale: [1, 1] });

/** Asleep: two thin bars. */
const SHUT_EYES = eyes("closed");

/** Something a mood does at a moment of its own: a heart leaving, the eyes changing, its end. */
interface Cue {
  inMs: number;
  run: () => void;
}

/**
 * Annoyed: it flinches — squashed in 60 ms, back up a little past its height,
 * at rest in 180 — and recoils from the finger; the antenna whips on its
 * spring, and the hands are pulled in to its sides for as long as it frowns.
 */
const POKE_SQUASH: readonly TweenKey[] = [[-0.13, 60, Ease.out], [0.035, 70, Ease.out], [0, 50, Ease.inOut]];
const pokeRecoil = (side: number): readonly TweenKey[] => [[-side * 0.06, 60, Ease.out], [0, 200, Ease.back]];
const POKE_HANDS: readonly TweenKey[] = [[-0.12, 90, Ease.out], [-0.12, 910, Ease.lin], [0, 200, Ease.inOut]];
/** The push the click gives the antenna's tip, in R per second. */
const WHIP = 6;

/** A sway that dies down: from side to side, each swing shorter than the last, then still. */
const decaying = (first: number, shares: readonly number[], firstMs: number, swingMs: number): readonly TweenKey[] => [
  [first, firstMs, Ease.out],
  ...shares.map((share): TweenKey => [first * share, swingMs, Ease.inOut]),
  [0, swingMs, Ease.inOut],
];
/**
 * Dizzy: the head wobbles for three seconds, less and less, and the body
 * sways under it the other way, which the antenna follows late. The eyes'
 * spirals turn this fast (radians per second).
 */
const DIZZY_WOBBLE = decaying(0.2, [-0.85, 0.65, -0.5, 0.35, -0.2, 0.1], 220, 400);
const DIZZY_SWAY = decaying(-0.07, [-0.85, 0.65, -0.5, 0.35, -0.2], 220, 400);
const SPIN = 7;

/**
 * Love: a small happy bounce — it gathers itself, hops and lands — with the
 * hands lifted a little for as long as the hearts rise.
 */
const LOVE_SQUASH: readonly TweenKey[] = [
  [-0.06, 80, Ease.out], [0.05, 110, Ease.out], [0.03, 110, Ease.lin], [-0.05, 60, Ease.out], [0, 200, Ease.back],
];
const LOVE_HOP: readonly TweenKey[] = [[0, 80, Ease.lin], [-0.14, 130, Ease.out], [0, 120, Ease.easeIn]];
const LOVE_HANDS: readonly TweenKey[] = [[0.3, 220, Ease.back], [0.3, 1300, Ease.lin], [0, 280, Ease.inOut]];
/** The first heart leaves this long after the eyes change. */
const FIRST_HEART_MS = 60;

/** The greeting, start to end. */
export const GREETING_MS = 2400;
/**
 * It drops in from this far above its place (R), lands squashed at 260 ms,
 * hops once and is at rest by 800; then one hand goes up beside the head and
 * waves three times — the arm first, the wrist 70 ms behind it, the body
 * leaning a touch the other way so the antenna follows late — while the eyes
 * smile and the antenna flashes once; the hand is down again by 2160.
 */
const GREET_FROM = -0.4;
const GREET_DROP: readonly TweenKey[] = [[0, 260, Ease.easeIn], [0, 60, Ease.lin], [-0.13, 120, Ease.out], [0, 120, Ease.easeIn]];
const GREET_SQUASH: readonly TweenKey[] = [
  [0.07, 260, Ease.lin], [-0.12, 60, Ease.out], [0.06, 120, Ease.out], [0.02, 120, Ease.lin],
  [-0.06, 60, Ease.out], [0, 180, Ease.back],
];
/** Three waves of `to` one way and 0.8 of it back, 150 ms each way, after `waitMs`. */
const waves = (to: number, waitMs: number): readonly TweenKey[] => [
  [0, waitMs, Ease.lin],
  ...[0, 1, 2].flatMap((): TweenKey[] => [[to, 150, Ease.inOut], [-to * 0.8, 150, Ease.inOut]]),
  [0, 140, Ease.inOut],
];
const GREET_RAISE: readonly TweenKey[] = [[0, 640, Ease.lin], [1, 220, Ease.back], [1, 1040, Ease.lin], [0, 260, Ease.inOut]];
const GREET_SWING = waves(0.36, 800);
const GREET_WRIST = waves(0.3, 870);
const GREET_LEAN = waves(0.03, 800);
const GREET_TILT: readonly TweenKey[] = [[0, 640, Ease.lin], [-0.07, 220, Ease.out], [-0.07, 1040, Ease.lin], [0, 260, Ease.inOut]];
const GREET_FLASH: readonly TweenKey[] = [[0, 640, Ease.lin], ...FLASH];
/** The eyes smile from here to here. */
const GREET_SMILE_MS = [600, 1960] as const;

// ── Bits ──────────────────────────────────────────────────────────────────────

/**
 * A small thing Liv does for itself while it waits (the troupe of the Liv
 * window, hub/troupe.ts): a wave to whoever is looking, a little hop, a
 * burst of typing.
 */
export type Bit = "wave" | "hop" | "type";

/** A wave on its own is the greeting's, without the way in: every key this much sooner, the smile from the start. */
const WAVE_AT_MS = 640;
const WAVE_RAISE = GREET_RAISE.slice(1);
const WAVE_SWING = waves(0.36, 800 - WAVE_AT_MS);
const WAVE_WRIST = waves(0.3, 870 - WAVE_AT_MS);
const WAVE_LEAN = waves(0.03, 800 - WAVE_AT_MS);
const WAVE_TILT = GREET_TILT.slice(1);
const WAVE_SMILE_MS = GREET_SMILE_MS[1] - WAVE_AT_MS;

/**
 * Typing: both hands come up a little, and each goes up and down eight
 * times, seven times a second, the right one half a stroke behind the left.
 */
const TYPE_STROKE_MS = 70;
const TYPE_STROKES = 8;
const strokes = (waitMs: number): readonly TweenKey[] => [
  [0, waitMs, Ease.lin],
  ...Array.from({ length: TYPE_STROKES }).flatMap((): TweenKey[] => [
    [0.2, TYPE_STROKE_MS, Ease.out], [0, TYPE_STROKE_MS, Ease.inOut],
  ]),
];
const TYPE_LEFT = strokes(0);
const TYPE_RIGHT = strokes(TYPE_STROKE_MS);
const TYPE_HANDS: readonly TweenKey[] = [
  [0.1, 120, Ease.out], [0.1, totalMs(TYPE_RIGHT) - 120, Ease.lin], [0, 180, Ease.inOut],
];

/** How long each bit lasts, ms. The hop is love's small bounce, without the hearts. */
export const BIT_MS: Record<Bit, number> = {
  wave: totalMs(WAVE_RAISE),
  hop: totalMs(LOVE_SQUASH),
  type: totalMs(TYPE_HANDS),
};

// ── Out of the island (src/pet) ───────────────────────────────────────────────

/** Held by the pointer, it hangs from it: a little stretched, its hands up a little. */
const HELD_STRETCH: readonly TweenKey[] = [[0.05, 140, Ease.out]];
const HELD_HANDS: readonly TweenKey[] = [[0.2, 180, Ease.back]];
/** It touches down: squashed in 70 ms, back up a little past its height, at rest in 320. */
const LAND_SQUASH: readonly TweenKey[] = [[-0.1, 70, Ease.out], [0.03, 110, Ease.out], [0, 140, Ease.inOut]];
const LAND_HANDS: readonly TweenKey[] = [[0, 200, Ease.inOut]];
/** Falling asleep, the antenna goes out in this long; waking, it is lit again in this long. */
const SLEEP_MS = 600;
const WAKE_MS = 240;

/** A mood cut short is back at rest in this long, and what had left Liv fades in it. */
const CALM_MS = 160;

/** Followers closer than this to their target are there. */
const COLOR_EPS = 0.003;
const GAZE_EPS = 0.004;

const far = (a: readonly number[], b: readonly number[], eps: number) => a.some((v, i) => Math.abs(v - b[i]) > eps);

const badgeKey = (b: Badge | null) => (b ? `${b.kind}-${b.color.join(",")}` : "none");

const FONT = `system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif`;

const WHITE: RGB = [1, 1, 1];
/** Dancing, the eyes take the music's colour this far towards white: they stay bright. */
const DANCE_EYE_TINT = 0.5;

// ── Engine ────────────────────────────────────────────────────────────────────

export class Robot {
  /** A colour for the shell (an integration's pill, a plan); null = the default shell. */
  bodyColor: RGB | null = null;
  /** The default shell. */
  shell: RGB = SHELL_ICE;
  /**
   * Alive: it breathes, the antenna's halo breathes with it, and it blinks on
   * its own clock. The island says so while it is open; anywhere else the
   * figure only moves when something happens, and the frame loop stops.
   */
  alive = false;
  /**
   * A new Liv waits (whats-new/whats-new.ts): while idle it wears the
   * up-arrow badge. The island turns the shell blue alongside.
   */
  private updateHint: RGB | null = null;

  // Tweened values.
  ox = 0;
  oy = 0;
  squash = 0;
  tilt = 0;
  badgeS = 0;
  blink = 0;
  glance = 0;
  eyeT = 1;
  hands = 0;
  feet = 0;
  lift = 0;
  /** The antenna's light, 1 = as lit as the state says; and a flash on top of it. */
  lit = 1;
  flash = 0;
  /** A mood's own: the head's wobble (radians, on top of the tilt) and the waving hand (look.ts: RobotPose). */
  wobble = 0;
  raise = 0;
  swing = 0;
  wrist = 0;
  /** Each hand's own lift, on top of `lift`: typing. */
  reachL = 0;
  reachR = 0;
  /** How far on what it wears is: 0 (off) … 1, a little past 1 as it pops on. */
  wear = 0;

  // Followers.
  eyeCol: RGB = ROBOT_STATES.idle.eyeColor;
  haloCol: RGB = ROBOT_STATES.idle.color;
  ledCol: RGB = ANTENNA_OFF;
  glow = 0;
  /** How much it breathes, 0 (still) … 1. */
  breath = 0;
  gaze: readonly [number, number] = [0, 0];
  /** Where the eyes rest while the state has no spot of its own and no pointer is near, in gaze units. */
  restGaze: readonly [number, number] = [0, 0];
  /** The colour its lights pulse in while it dances: the pill's the music plays on. */
  danceColor: RGB = DANCE_COLOR;
  /** How far it floats with each breath, in R: a slight float on the island, a hover on the desktop. */
  float = BREATH_FLOAT;

  state: BotStateName = "idle";
  private look: RobotLook = ROBOT_STATES.idle;
  private eyes: EyeLook = ROBOT_STATES.idle.eyes;
  private eyesBefore: EyeLook = ROBOT_STATES.idle.eyes;
  private tiltTo = 0;
  private limbsOut = false;
  /** Where the pointer has the eyes, null while it is far or unknown. */
  private pointer: readonly [number, number] | null = null;

  badge: Badge | null = null;
  private shownBadgeKey = "none";

  /** What it has on now (outfits.ts), and what it was last told to wear: the one gives way to the other. */
  worn: Outfit = "none";
  private outfit: Outfit = "none";

  private tweens = new Map<PropKey, Tween>();
  private swayX = new Spring(0, SWAY_RESPONSE, SWAY_DAMPING);
  private swayY = new Spring(0, SWAY_RESPONSE, SWAY_DAMPING);
  /** Seconds of update() so far: the phase of the breath and of the badge's dots. */
  private time = 0;
  /** What decides when it blinks while alive (0…1 each draw), and the ms until it next does. */
  private random: () => number;
  private lifeIn: number;

  private mood: Mood | null = null;
  private cues: Cue[] = [];
  /** The hearts and the stars in the air. */
  private particles: Particle[] = [];
  /** How far the dizzy spirals have turned, radians. */
  private eyeTurn = 0;
  /** What a flash turns the antenna to; null = more of the state's own light. */
  private flashTo: RGB | null = null;
  /** When the last clicks landed, in ms of this engine's time (react.ts: countPoke). */
  private pokes: number[] = [];
  /** The pointer rests on the head, and for how long it has; and how long before it can win Liv over again. */
  private hovering = false;
  private restMs = 0;
  private loveIn = 0;

  /**
   * Dancing (dance.ts): it is asked to, how far into the dance it is (0…1),
   * the seconds danced so far, and what the dance adds to it at this instant.
   */
  private dancing = false;
  private danceIn = 0;
  private danceS = 0;
  private groove: Groove = STILL;
  /** How hard the beat is felt at this instant, 0…1: what it wears may move to it. */
  private beat = 0;

  /**
   * In the air, moved by whoever moves its window (pet/travel.ts): how far
   * its head leans, radians, and how far the air pushes the antenna's tip
   * back, in R. The tip gets there on its spring, and swings back on landing.
   */
  private lean = 0;
  private trail: readonly [number, number] = [0, 0];
  /** Asleep on the desktop (pet/rest.ts): its eyes shut and its antenna off, whatever the state. */
  private asleep = false;

  /**
   * `age` is how many seconds it has already lived: robots side by side are
   * given different ones, and breathe out of step.
   */
  constructor(random: () => number = Math.random, age = 0) {
    this.random = random;
    this.lifeIn = nextLife(random).inMs;
    this.time = age;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  setState(next: BotStateName, force = false) {
    if (this.state === next && !force) return;
    // What happens to the task comes before a mood of its own.
    this.settle();
    this.state = next;
    this.look = ROBOT_STATES[next];
    this.setBadge(this.stateBadge());
    this.setEyes(this.eyesTo);
    if (this.look.tilt !== this.tiltTo) {
      this.tiltTo = this.look.tilt;
      this.anim("tilt", [[this.tiltTo, TILT_MS, Ease.out]]);
    }

    switch (next) {
      case "finished":
        this.anim("squash", JOY_SQUASH);
        this.anim("oy", JOY_HOP);
        this.anim("lift", JOY_HANDS);
        this.anim("flash", FLASH);
        break;
      case "error":
        this.anim("ox", SHAKE);
        break;
      case "approval":
        this.anim("oy", HOP);
        this.anim("lit", BLINK_LIGHT);
        break;
    }
  }

  /** The update badge (blue arrow) while one waits, else nothing. Asked every frame; cheap. */
  setUpdateHint(color: RGB | null) {
    const was = this.updateHint;
    const same = color === was || (color != null && was != null && color.every((c, i) => c === was[i]));
    if (same) return;
    this.updateHint = color;
    this.setBadge(this.stateBadge());
  }

  /** Whether the update hint shows now: only over an idle robot. */
  get showsUpdateHint(): boolean {
    return this.updateHint != null && this.state === "idle";
  }

  /** The whole body or the head alone: hands and feet pop out, or tuck away. Asked every frame; cheap. */
  setLimbs(out: boolean) {
    if (out === this.limbsOut) return;
    this.limbsOut = out;
    if (out) {
      this.anim("feet", [[1, LIMBS_OUT_MS, Ease.back]]);
      this.anim("hands", [[this.hands, LIMBS_STAGGER_MS, Ease.lin], [1, LIMBS_OUT_MS, Ease.back]]);
    } else {
      this.anim("feet", [[0, LIMBS_IN_MS, Ease.inOut]]);
      this.anim("hands", [[0, LIMBS_IN_MS, Ease.inOut]]);
    }
  }

  /**
   * The pointer, in px from the head's centre: the eyes follow it while it is
   * near (look.ts: gazeFor). `null`: nobody knows where it is, look ahead.
   */
  lookAt(pointer: readonly [number, number] | null) {
    this.pointer = pointer && gazeFor(pointer[0], pointer[1]);
  }

  /**
   * One small sign of life, now: the island's timer plays these while it is
   * closed or compact. Eyes that are shut or smiling have nothing to blink.
   */
  act(kind: LifeKind) {
    switch (kind) {
      case "blink":
        if (EYE_SHAPES[this.eyes.shape].blinks) this.anim("blink", BLINK);
        break;
      case "doubleBlink":
        if (EYE_SHAPES[this.eyes.shape].blinks) this.anim("blink", DOUBLE_BLINK);
        break;
      case "glanceLeft":
        this.anim("glance", glance(-1));
        break;
      case "glanceRight":
        this.anim("glance", glance(1));
        break;
    }
  }

  /**
   * Music plays, or has stopped: Liv eases into its dance, or out of it
   * (dance.ts). A mood of its own holds the dance back for as long as it
   * lasts. Asked every frame; cheap.
   */
  setDancing(on: boolean) {
    if (on === this.dancing) return;
    this.dancing = on;
    this.setEyes(this.eyesTo);
  }

  /**
   * One small bit of its own, now (BIT_MS says for how long). False, and
   * nothing happens, while it is in a mood: it has something else on its mind.
   */
  perform(bit: Bit): boolean {
    if (this.mood) return false;
    const mood: Mood = { kind: "bit", eyes: null, eyeColor: null, halo: null };
    switch (bit) {
      case "wave":
        this.setMood({ ...mood, eyes: eyes("arc") });
        this.anim("raise", WAVE_RAISE);
        this.anim("swing", WAVE_SWING);
        this.anim("wrist", WAVE_WRIST);
        this.anim("ox", WAVE_LEAN);
        this.anim("wobble", WAVE_TILT);
        this.cue(WAVE_SMILE_MS, () => this.setMood(mood));
        break;
      case "hop":
        this.setMood(mood);
        this.anim("squash", LOVE_SQUASH);
        this.anim("oy", LOVE_HOP);
        break;
      case "type":
        this.setMood(mood);
        this.anim("lift", TYPE_HANDS);
        this.anim("reachL", TYPE_LEFT);
        this.anim("reachR", TYPE_RIGHT);
        break;
    }
    this.cue(BIT_MS[bit], () => this.endMood());
    return true;
  }

  /**
   * What it wears from now on. What it has on goes first (OUTFIT_OFF_MS),
   * then this pops on (OUTFIT_ON_MS). With nobody looking (`seen` false) it
   * simply has it on. Asked every frame; cheap.
   */
  setOutfit(next: Outfit, seen = true) {
    if (!seen) {
      this.outfit = next;
      this.worn = next;
      this.tweens.delete("wear");
      this.wear = next === "none" ? 0 : 1;
      return;
    }
    if (next === this.outfit) return;
    this.outfit = next;
    this.change();
  }

  /** One step towards wearing what it was told to: what is on comes off, then the new thing goes on. */
  private change() {
    const next = this.outfit;
    if (this.worn !== next && this.worn !== "none" && this.wear > 0) {
      this.anim("wear", [[0, OUTFIT_OFF_MS, Ease.inOut]], () => {
        this.worn = "none";
        this.change();
      });
      return;
    }
    this.worn = next;
    if (next === "none") {
      this.tweens.delete("wear");
      this.wear = 0;
    } else this.anim("wear", [[1, OUTFIT_ON_MS, Ease.back]]);
  }

  // ── Out of the island (src/pet) ─────────────────────────────────────────────

  /**
   * On its way through the air: leaning by `lean` radians, the antenna's tip
   * pushed back by `trail` (R). Both zero once it is there. Asked every frame
   * of the way; cheap.
   */
  fly(lean: number, trail: readonly [number, number]) {
    this.lean = lean;
    this.trail = trail;
  }

  /** The pointer picks it up: whatever it was doing for itself ends, and it hangs from the pointer. */
  hold() {
    this.settle();
    this.anim("squash", HELD_STRETCH);
    this.anim("lift", HELD_HANDS);
  }

  /** It touches down, set down by the pointer or at the end of its way: a small squash, and it is at rest. */
  land() {
    this.anim("squash", LAND_SQUASH);
    if (this.lift !== 0) this.anim("lift", LAND_HANDS);
  }

  /**
   * Asleep or awake. Asleep its eyes are shut and its antenna is off, whatever
   * the state, and once they are nothing moves: nothing asks for a frame.
   * Asked on every change of what it shows; cheap.
   */
  sleep(on: boolean) {
    if (on === this.asleep) return;
    this.asleep = on;
    if (on) this.calm();
    this.setEyes(this.eyesTo);
    this.anim("lit", [[on ? 0 : 1, on ? SLEEP_MS : WAKE_MS, Ease.inOut]]);
  }

  // ── Moods ───────────────────────────────────────────────────────────────────

  /**
   * A click on the head, from the left (−1) or the right (1) of its middle:
   * Liv is annoyed, and at the third click in a row dizzy — and while it is
   * dizzy it does not feel another.
   */
  poke(side = 1) {
    if (this.mood?.kind === "dizzy") return;
    const count = countPoke(this.pokes, this.time * 1000);
    this.pokes = count.times;
    this.react(count.dizzy ? "dizzy" : "annoyed", side);
  }

  /**
   * The pointer is resting on the head, or has left it: after two seconds
   * there Liv is won over. Leaving sooner ends the wait, not what has
   * started. Asked on every move of the pointer; cheap.
   */
  hover(on: boolean) {
    if (on === this.hovering) return;
    this.hovering = on;
    this.restMs = 0;
  }

  /** One of the pointer's moods, now. `side` is where the click came from, for the one that has a side. */
  react(kind: Reaction, side = 1) {
    this.settle();
    this.restMs = 0;
    switch (kind) {
      case "annoyed":
        this.setMood({ kind, eyes: eyes("angry"), eyeColor: null, halo: null });
        this.anim("squash", POKE_SQUASH);
        this.anim("ox", pokeRecoil(side));
        this.anim("lift", POKE_HANDS);
        this.swayX.velocity += side * WHIP;
        this.cue(POKE.annoyedMs, () => this.endMood());
        break;
      case "dizzy":
        this.setMood({ kind, eyes: eyes("spiral"), eyeColor: null, halo: null });
        this.anim("wobble", DIZZY_WOBBLE);
        this.anim("ox", DIZZY_SWAY);
        this.particles.push(...stars(POKE.dizzyMs));
        this.cue(POKE.dizzyMs, () => this.endMood());
        break;
      case "love":
        this.setMood({ kind, eyes: eyes("heart"), eyeColor: LOVE_EYES, halo: LOVE });
        this.anim("squash", LOVE_SQUASH);
        this.anim("oy", LOVE_HOP);
        this.anim("lift", LOVE_HANDS);
        HEARTS.seats.forEach((_, i) => {
          this.cue(FIRST_HEART_MS + i * HEARTS.everyMs, () => this.particles.push(heart(i)));
        });
        this.cue(LOVE_TIMES.lastsMs, () => {
          this.endMood();
          this.loveIn = LOVE_TIMES.cooldownMs;
        });
        break;
    }
  }

  /**
   * Liv arrives and says hello (GREETING_MS in all): it drops in and bounces
   * to rest, waves one hand three times with happy eyes, and the antenna
   * flashes once. Without hands (the head alone) it only smiles.
   */
  greet() {
    this.settle();
    this.setMood({ kind: "greeting", eyes: null, eyeColor: null, halo: null });
    // The antenna comes down with it, and trails from there.
    this.swayY.value += GREET_FROM - this.oy;
    this.oy = GREET_FROM;
    this.flashTo = HELLO;
    this.anim("oy", GREET_DROP);
    this.anim("squash", GREET_SQUASH);
    this.anim("raise", GREET_RAISE);
    this.anim("swing", GREET_SWING);
    this.anim("wrist", GREET_WRIST);
    this.anim("ox", GREET_LEAN);
    this.anim("wobble", GREET_TILT);
    this.anim("flash", GREET_FLASH);
    const mood = this.mood;
    this.cue(GREET_SMILE_MS[0], () => this.setMood({ ...mood!, eyes: eyes("arc") }));
    this.cue(GREET_SMILE_MS[1], () => this.setMood(mood!));
    this.cue(GREETING_MS, () => this.endMood());
  }

  /**
   * The island folds, or opens from Liv's pocket: whatever Liv was doing for
   * itself ends with what showed it, and the pointer is no longer on it.
   */
  calm() {
    this.hover(false);
    this.settle();
  }

  /**
   * The mood it is in is over, now: its eyes are the state's again, it is back
   * at rest in a moment, and the hearts or stars in the air fade.
   */
  private settle() {
    if (!this.mood) return;
    this.cues = [];
    this.endMood();
    for (const prop of MOOD_PROPS) {
      if (this[prop] === 0) this.tweens.delete(prop);
      else this.anim(prop, [[0, CALM_MS, Ease.inOut]]);
    }
    this.particles = this.particles.map((p) => fading(p, CALM_MS));
  }

  private setMood(mood: Mood) {
    this.mood = mood;
    this.setEyes(this.eyesTo);
  }

  private endMood() {
    this.mood = null;
    this.flashTo = null;
    this.setEyes(this.eyesTo);
  }

  private cue(inMs: number, run: () => void) {
    this.cues.push({ inMs, run });
  }

  /**
   * The eyes and their colours as they should be: the mood's where it has
   * its own, else the state's — or the dance's smile, while it dances.
   */
  private get eyesTo(): EyeLook {
    if (this.mood) return this.mood.eyes ?? this.look.eyes;
    if (this.asleep) return SHUT_EYES;
    return this.dancing ? DANCE_EYES : this.look.eyes;
  }
  private get eyeColorTo(): RGB {
    return this.mood?.eyeColor ?? this.look.eyeColor;
  }
  private get haloTo(): RGB {
    return this.mood?.halo ?? this.look.color;
  }

  private stateBadge(): Badge | null {
    if (this.showsUpdateHint && this.updateHint) return { kind: "arrow", color: this.updateHint };
    return this.look.badge;
  }

  /** The badge in place goes in 90 ms; 10 ms later the new one pops in over 280 ms. */
  private setBadge(b: Badge | null) {
    const key = badgeKey(b);
    if (key === this.shownBadgeKey) return;
    this.shownBadgeKey = key;
    this.anim("badgeS", [[0, 90, Ease.inOut], [0, 10, Ease.lin]], () => {
      this.badge = b;
      if (b) this.anim("badgeS", [[1, 280, Ease.back]]);
    });
  }

  /** New eyes: the ones in place shrink away and these grow in (look.ts: eyeSwap). */
  private setEyes(next: EyeLook) {
    if (eyeKey(next) === eyeKey(this.eyes)) return;
    this.eyesBefore = this.eyes;
    this.eyes = next;
    this.eyeT = 0;
    this.anim("eyeT", [[1, EYE_SWAP_MS, Ease.lin]]);
  }

  /** Where the eyes are heading: where the state looks, else the pointer, else where they rest. */
  private get gazeTo(): readonly [number, number] {
    return this.look.gaze ?? this.pointer ?? this.restGaze;
  }

  /**
   * A change is still playing out: a tween, a light on its way to the state's
   * colour, the eyes on their way to the pointer, the antenna still swaying —
   * or it is alive, and breathes. A mood is a change for as long as it lasts,
   * with what it has sent into the air; so is the pointer resting on the
   * head, which is being timed, and so is the dance, until it has eased out.
   * A resting robot is not changing: the island's frame loop stops.
   * The dots of a working badge are not counted: they are painted on whatever
   * frames the island runs, and never ask for one.
   */
  get changing(): boolean {
    const look = this.look;
    return this.alive || this.breath > COLOR_EPS || this.tweens.size > 0 ||
      this.mood != null || this.cues.length > 0 || this.particles.length > 0 || this.hovering ||
      this.dancing || this.danceIn > 0 ||
      far(this.eyeCol, this.eyeColorTo, COLOR_EPS) || far(this.haloCol, this.haloTo, COLOR_EPS) ||
      far(this.ledCol, antennaColor(look), COLOR_EPS) || Math.abs(this.glow - look.antenna) > COLOR_EPS ||
      far(this.gaze, this.gazeTo, GAZE_EPS) ||
      !this.swayX.settled || !this.swayY.settled;
  }

  // ── Tweens ──────────────────────────────────────────────────────────────────

  private anim(prop: PropKey, keys: readonly TweenKey[], onComplete?: () => void) {
    this.tweens.set(prop, { keys, from: this[prop], ms: 0, totalMs: totalMs(keys), onComplete });
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  update(dt: number) {
    this.time += dt;

    if (this.alive) {
      this.lifeIn -= dt * 1000;
      if (this.lifeIn <= 0) {
        const next = nextLife(this.random);
        this.lifeIn = next.inMs;
        // Its own eyes are on the pointer or on the state's spot: here it only blinks.
        this.act(next.kind === "doubleBlink" ? "doubleBlink" : "blink");
      }
    }

    for (const [prop, tw] of [...this.tweens]) {
      tw.ms += dt * 1000;
      this[prop] = sampleKeys(tw.from, tw.keys, tw.ms);
      if (tw.ms >= tw.totalMs) {
        this.tweens.delete(prop);
        tw.onComplete?.();
      }
    }

    this.updateMood(dt * 1000);
    this.updateDance(dt);

    const look = this.look;
    const share = followShare(dt);
    this.eyeCol = followColor(this.eyeCol, this.eyeColorTo, dt);
    this.haloCol = followColor(this.haloCol, this.haloTo, dt);
    this.ledCol = followColor(this.ledCol, antennaColor(look), dt);
    this.glow = lerp(this.glow, look.antenna, share);
    this.breath = lerp(this.breath, this.alive ? 1 : 0, share);
    const to = this.gazeTo;
    this.gaze = [lerp(this.gaze[0], to[0], share), lerp(this.gaze[1], to[1], share)];

    // The antenna's tip follows where the body is, late.
    this.swayX.target = this.ox + this.groove.ox + this.trail[0];
    this.swayY.target = this.oy + this.groove.oy + this.trail[1];
    this.swayX.step(dt);
    this.swayY.step(dt);
  }

  /**
   * `dt` more of the dance: into it while the music plays and no mood holds
   * it back, out of it otherwise. It starts on a beat, and is still once out.
   */
  private updateDance(dt: number) {
    const on = this.dancing && !this.mood;
    if (on && this.danceIn === 0) this.danceS = 0;
    this.danceIn = stepDance(this.danceIn, on, dt * 1000);
    if (this.danceIn === 0) {
      this.groove = STILL;
      this.beat = 0;
      return;
    }
    this.danceS += dt;
    const beats = beatsAt(this.danceS);
    const level = danceLevel(this.danceIn);
    this.groove = groove(beats, level);
    this.beat = pulseAt(beatPhase(beats)) * level;
  }

  /** `ms` more of Liv's own moods: the pointer's rest is timed, what a mood has planned comes due, the air clears. */
  private updateMood(ms: number) {
    this.particles = ageParticles(this.particles, ms);
    if (this.mood?.kind === "dizzy") this.eyeTurn += (ms / 1000) * SPIN;

    // What the mood has planned and is due. A cue may end the mood.
    const due: Cue[] = [];
    for (const cue of this.cues) {
      cue.inMs -= ms;
      if (cue.inMs <= 0) due.push(cue);
    }
    if (due.length > 0) {
      this.cues = this.cues.filter((cue) => !due.includes(cue));
      for (const cue of due) cue.run();
    }

    this.loveIn = Math.max(0, this.loveIn - ms);
    if (this.hovering && !this.mood && this.loveIn === 0) {
      this.restMs += ms;
      if (this.restMs >= LOVE_TIMES.restMs) this.react("love");
    }
  }

  // ── Draw ────────────────────────────────────────────────────────────────────

  /** The pose of this instant, for the painter. */
  private pose(): RobotPose {
    const swap = eyeSwap(this.eyeT);
    const swell = Math.sin((this.time / BREATH_S) * Math.PI * 2) * this.breath * BREATH_SWELL;
    const halo = this.look.pulse > 0
      ? 1 + Math.sin((this.time / this.look.pulse) * Math.PI * 2) * this.breath * HALO_BREATH
      : 1;
    const flash = clamp(this.flash, 0, 1);
    const antenna = this.flashTo
      ? mix(mix(ANTENNA_OFF, this.ledCol, clamp(this.lit, 0, 1)), this.flashTo, flash)
      : mix(ANTENNA_OFF, this.ledCol, clamp(this.lit + this.flash, 0, 1));
    // What the dance adds: its moves, and the music's colour in the lights, on the beat.
    const dance = this.groove;
    const squash = this.squash + dance.squash;
    return {
      shell: this.bodyColor ?? this.shell,
      eyeColor: mix(this.eyeCol, mix(this.danceColor, WHITE, DANCE_EYE_TINT), dance.light),
      eyeHalo: mix(this.haloCol, this.danceColor, dance.light),
      antennaColor: mix(antenna, this.danceColor, dance.light),
      glow: this.glow * halo * this.lit + this.flash + dance.light,
      eyes: swap.old ? this.eyesBefore : this.eyes,
      eyeScale: swap.scale,
      eyeAlpha: swap.alpha,
      blink: this.blink,
      gaze: [clamp(this.gaze[0] + this.glance, -1, 1), clamp(this.gaze[1] + dance.nod, -1, 1)],
      tilt: this.tilt + this.wobble + dance.tilt + this.lean,
      hands: this.hands,
      feet: this.feet,
      lift: this.lift,
      raise: this.raise,
      swing: this.swing,
      wrist: this.wrist,
      reach: [this.reachL + dance.reach[0], this.reachR + dance.reach[1]],
      flick: dance.flick,
      step: dance.step,
      eyeTurn: this.eyeTurn,
      sway: [
        clamp(this.swayX.value - this.ox - dance.ox, -SWAY_MAX, SWAY_MAX),
        clamp(this.swayY.value - this.oy - dance.oy, -SWAY_MAX, SWAY_MAX),
      ],
      stretch: [1 - squash * SQUASH_SIDE + swell, 1 + squash + swell],
      outfit: this.worn,
      wear: this.wear,
      beat: this.beat,
    };
  }

  /**
   * Draws the robot and its badge into a canvas of `W`×`H` CSS pixels (the
   * caller has already applied the DPR transform). The canvas is larger than
   * the figure's slot (look.ts: CANVAS_PER_SLOT), which the antenna, the feet
   * and the badge overflow.
   */
  draw(x: CanvasRenderingContext2D, W: number, H: number) {
    const R = headRadius(W / CANVAS_PER_SLOT);
    this.drawAt(x, R, W / 2, H / 2 + robotDrop(robotGeometry(R), this.feet) * R);
  }

  /**
   * Draws the robot and its badge with a head of radius `R` px that rests
   * centred on `restX`, `restY`: wherever the caller stands it (the troupe of
   * the Liv window stands several on one canvas).
   */
  drawAt(x: CanvasRenderingContext2D, R: number, restX: number, restY: number) {
    const float = Math.sin((this.time / BREATH_S) * Math.PI * 2) * this.breath * this.float;
    // Where the head is now.
    const cx = restX + (this.ox + this.groove.ox) * R;
    const cy = restY + (this.oy + this.groove.oy - float) * R;

    x.save();
    x.translate(cx, cy);
    paintRobot(x, R, this.pose());
    x.restore();

    if (this.badge && this.badgeS > 0.01) this.drawBadge(x, this.badge, R / HEAD_FIT / 2, cx, cy);

    // The hearts and the stars have left it: they do not hop or sway with it.
    if (this.particles.length > 0) {
      x.save();
      x.translate(restX, restY);
      for (const p of this.particles) paintParticle(x, R, particleShape(p));
      x.restore();
    }
  }

  /** The badge, by the upper right of the head, clear of the antenna. `U` is half the slot. */
  private drawBadge(x: CanvasRenderingContext2D, badge: Badge, U: number, cx: number, cy: number) {
    x.save();
    x.translate(cx + U * 0.85, cy - U * 0.55);
    x.scale(this.badgeS, this.badgeS);
    const col = rgba(badge.color);

    const circle = (r: number) => {
      x.beginPath();
      x.arc(0, 0, r, 0, Math.PI * 2);
    };
    const disc = (ring: number, fill: number) => {
      x.fillStyle = "#000";
      circle(U * ring);
      x.fill();
      x.fillStyle = col;
      circle(U * fill);
      x.fill();
    };

    if (badge.kind === "dots") {
      const pw = U * 0.72;
      const ph = U * 0.36;
      x.beginPath();
      x.roundRect(-pw / 2, -ph / 2, pw, ph, ph / 2);
      x.fillStyle = col;
      x.fill();
      for (let i = 0; i < 3; i++) {
        const phase = (((this.time * 2.4 - i * 0.22) % 1) + 1) % 1;
        const dotR = U * 0.055 * (1 + 0.4 * Math.max(0, Math.sin(phase * Math.PI * 2)));
        x.fillStyle = "#fff";
        x.beginPath();
        x.arc((i - 1) * U * 0.18, 0, dotR, 0, Math.PI * 2);
        x.fill();
      }
    } else if (badge.kind === "arrow") {
      // The "!" badge's ring and disc, with a white up-arrow: a new Liv is out.
      disc(0.3, 0.23);
      const a = U * 0.12;
      x.strokeStyle = "#fff";
      x.lineWidth = U * 0.055;
      x.lineCap = "round";
      x.lineJoin = "round";
      x.beginPath();
      x.moveTo(0, a);
      x.lineTo(0, -a);
      x.moveTo(-a * 0.8, -a * 0.2);
      x.lineTo(0, -a);
      x.lineTo(a * 0.8, -a * 0.2);
      x.stroke();
    } else if (badge.kind === "bang" || badge.kind === "question") {
      disc(0.3, 0.23);
      x.fillStyle = "#fff";
      x.font = `900 ${U * 0.32}px ${FONT}`;
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText(badge.kind === "bang" ? "!" : "?", 0, U * 0.02);
    } else {
      disc(0.2, 0.135);
    }
    x.restore();
  }
}
