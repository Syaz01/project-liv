// Liv in the drop sequence: what the figure does on the sequence's own
// timeline (sequence.ts), which decides where it is, how big, and when. While
// a file hovers Liv follows it, looks at it and raises its hands to catch it;
// the file goes into its visor and it smiles; then it shrinks into the light
// of its antenna, which rides the progress bar, and grows back out of that
// light by the choose card.
//
// Pure: a frame of the sequence in, what to draw out (canvas.ts draws it).

import { Ease, clamp, lerp, seg } from "../core/anim";
import {
  ANTENNA_OFF, EYE_SWAP_MS, ROBOT_STATES,
  eyeSwap, gazeFor, headRadius, mix, robotDrop, robotGeometry, stillPose,
  type EyeShape, type RGB, type RobotPose,
} from "../robot/look";
import type { Outfit } from "../robot/outfits";
import { USC, type UploadFrame } from "./sequence";

/** The slot the sequence shrinks the figure to on the bar, and grows it back from (sequence.ts). */
const DOT_D = 14;

/** Hands raised to catch: how far they are lifted, and how long they take to go up as the file comes in. */
const CATCH_LIFT = 0.7;
const CATCH_UP_S = 0.26;
/** The eager bounce as the follow locks on: a hop of this much (R) in this long, and the squash it lands with. */
const LOCK = { hop: 0.1, hopS: 0.24, stretch: 0.05, squash: 0.045, landS: 0.16 } as const;
/** The file lands in the visor: squashed this much within 60 ms, back at rest in 300. */
const GULP = { squash: 0.11, downS: 0.06, upS: 0.3 } as const;
/** Having caught it, the hands come down in this long. */
const HANDS_DOWN_S = 0.24;
/** Going into its light, the body is gone from sight once it is this small a share of itself. */
const GONE_BELOW = 0.3;
/** Grown back, it stops smiling this long after the sequence's grow ends. */
const SMILE_PAST_S = 0.3;

const WORKING: RGB = ROBOT_STATES.working.color;
const DONE: RGB = ROBOT_STATES.finished.color;

export interface UploadBody {
  /** Its head's centre, and its head's radius at full size. */
  x: number;
  y: number;
  R: number;
  /** How much of its size it has: 1 whole, less going into its light or coming out of it. */
  share: number;
  alpha: number;
  pose: RobotPose;
}

export interface UploadLamp {
  x: number;
  y: number;
  r: number;
  color: RGB;
  /** 0 off … 1 lit. */
  light: number;
}

export interface UploadLiv {
  /** Liv itself; null while only its light is left. */
  body: UploadBody | null;
  /** The antenna's light on its own: while the body shrinks into it, rides the bar as it, and grows back out of it. */
  lamp: UploadLamp | null;
  /** Where the file goes: the middle of the visor. */
  mouth: { x: number; y: number };
}

/** The eyes of an instant of a swap from one shape to another, `ms` after it starts (look.ts: eyeSwap). */
function swapping(from: EyeShape, to: EyeShape, ms: number): Pick<RobotPose, "eyes" | "eyeScale" | "eyeAlpha"> {
  const swap = eyeSwap(seg(ms, 0, EYE_SWAP_MS));
  return { eyes: { shape: swap.old ? from : to, scale: [1, 1] }, eyeScale: swap.scale, eyeAlpha: swap.alpha };
}

/** What Liv does in frame `f` of the sequence, in what it wears (`outfit`: the island says). */
export function uploadLiv(f: UploadFrame, outfit: Outfit = "none"): UploadLiv {
  // The pulse as the file lands goes into the size, so Liv is drawn with the detail of the size it has.
  const R = headRadius(USC.D_REST * f.scale);
  const g = robotGeometry(R);
  const drop = robotDrop(g, 1) * R;
  const share = (f.d - DOT_D) / (USC.D_REST - DOT_D);
  const whole = clamp(share, 0, 1);

  // Still in the air: the file has not gone in. Until it starts to, Liv is waiting for it.
  const waiting = f.fileVisible && f.suck === 0;
  const sinceCatch = f.t - USC.T_SUCK_END;

  // The eager bounce, while the follow is locked on to the file.
  const age = waiting && f.lockAge != null ? f.lockAge : null;
  const air = age == null ? 0 : Math.sin(Math.PI * seg(age, 0, LOCK.hopS));
  const landing = age == null ? 0 : Math.sin(Math.PI * seg(age, LOCK.hopS, LOCK.hopS + LOCK.landS));
  // The gulp as the file lands.
  const gulp = f.fileVisible
    ? 0
    : GULP.squash * seg(sinceCatch, 0, GULP.downS) * (1 - Ease.out(seg(sinceCatch, GULP.downS, GULP.upS)));
  const squash = LOCK.stretch * air - LOCK.squash * landing - gulp;

  const x = f.x;
  const y = f.y + whole * drop - LOCK.hop * air * R;
  const mouth = { x, y: y + g.visorY * R };

  const pose: RobotPose = { ...stillPose({ model: "body", outfit }), stretch: [1 - squash * 0.7, 1 + squash] };
  if (waiting) {
    // Eyes wide on the file, hands going up to catch it.
    pose.eyes = { shape: "wide", scale: [1, 1] };
    pose.gaze = gazeFor(f.cursorX - x, f.cursorY + 14 - y);
    pose.lift = CATCH_LIFT * Ease.back(seg(f.t, USC.ENTRY_T_REF, USC.ENTRY_T_REF + CATCH_UP_S));
  } else if (f.fileVisible) {
    // It is coming in: the eyes follow it to the visor and turn happy.
    const k = 1 - Ease.easeIn(f.suck);
    const to = gazeFor(f.cursorX - x, f.cursorY + 14 - y);
    pose.gaze = [to[0] * k, to[1] * k];
    pose.lift = CATCH_LIFT;
    Object.assign(pose, swapping("wide", "arc", (f.t - USC.T_SUCK_START) * 1000));
  } else if (f.t < f.growEnd + SMILE_PAST_S) {
    // Caught: it smiles, and its hands come down.
    pose.eyes = { shape: "arc", scale: [1, 1] };
    pose.lift = CATCH_LIFT * (1 - Ease.inOut(seg(sinceCatch, 0, HANDS_DOWN_S)));
  } else {
    Object.assign(pose, swapping("arc", "round", (f.t - f.growEnd - SMILE_PAST_S) * 1000));
  }

  const body: UploadBody | null = share > 0
    ? { x, y, R, share, alpha: seg(share, 0, GONE_BELOW), pose }
    : null;

  // The light: where the body's antenna ends, lit as the body goes into it —
  // the working blue on the bar, green once the upload is done.
  const lamp: UploadLamp | null = share < 1
    ? {
      x: f.x + whole * g.lean * R,
      y: f.y + whole * (drop + g.ballY * R),
      r: lerp(headRadius(DOT_D), g.ballR * R, whole),
      color: mix(ANTENNA_OFF, mix(WORKING, DONE, clamp(f.check, 0, 1)), 1 - whole),
      light: 1 - whole,
    }
    : null;

  return { body, lamp, mouth };
}
