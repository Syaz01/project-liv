// What Liv says, and when — one recipe for each name in SOUND_NAMES
// (src/core/sound.ts). Soft blips, each with a shape of its own so it is known
// by ear: how many notes, whether they step up or down, how long the last one
// rings. Up when something goes well, down when it does not, and never long
// enough to get in the way. Pitches are in Hz (notes of one scale, so any two
// sounds heard together agree), times in seconds (scripts/sounds/synth.mjs).

// C major pentatonic, from E4 to C6.
const E4 = 330, G4 = 392, A4 = 440, C5 = 523, D5 = 587, E5 = 659, G5 = 784, A5 = 880, C6 = 1047;

/** @type {Record<string, import("./synth.mjs").Note[]>} */
export const RECIPES = {
  // The island shows itself: one drop, leaning up a little.
  peek: [{ at: 0, dur: 0.12, from: E5, to: 690, bend: 1.5 }],

  // It opens: two soft steps up.
  open: [
    { at: 0, dur: 0.09, from: C5, gain: 0.85 },
    { at: 0.07, dur: 0.16, from: E5 },
  ],

  // It folds: the same two steps down, quieter.
  close: [
    { at: 0, dur: 0.09, from: E5, gain: 0.75 },
    { at: 0.07, dur: 0.15, from: C5, gain: 0.75 },
  ],

  // A click on something: the plain blip.
  blip: [{ at: 0, dur: 0.07, from: G5, decay: 5 }],

  // An agent gets to work: three quick low steps, each a little louder.
  work: [
    { at: 0, dur: 0.07, from: G4, gain: 0.7 },
    { at: 0.06, dur: 0.07, from: C5, gain: 0.85 },
    { at: 0.12, dur: 0.13, from: D5 },
  ],

  // A task is done: three notes up, the last left to ring.
  finish: [
    { at: 0, dur: 0.11, from: E5, gain: 0.85 },
    { at: 0.095, dur: 0.11, from: G5, gain: 0.9 },
    { at: 0.19, dur: 0.3, from: C6, decay: 3.2 },
  ],

  // Something failed: two low notes down, unhurried.
  error: [
    { at: 0, dur: 0.15, from: A4, decay: 3 },
    { at: 0.16, dur: 0.24, from: E4, decay: 3, octave: 0.06 },
  ],

  // A permission is waiting: two taps, the second a step higher.
  approval: [
    { at: 0, dur: 0.1, from: E5 },
    { at: 0.14, dur: 0.18, from: A5, decay: 3.4 },
  ],

  // A question for the user: low then high, the way a question lifts.
  question: [
    { at: 0, dur: 0.1, from: D5, gain: 0.85 },
    { at: 0.09, dur: 0.2, from: A5, to: 905, bend: 2, decay: 3 },
  ],

  // The user said yes: two bright steps, close together.
  approve: [
    { at: 0, dur: 0.07, from: G5, gain: 0.85 },
    { at: 0.06, dur: 0.15, from: C6 },
  ],

  // Moving between options: barely there.
  tick: [{ at: 0, dur: 0.035, from: C6, decay: 5, octave: 0.05, gain: 0.7, attack: 0.004 }],

  // A message leaves: one soft note lifting away.
  send: [{ at: 0, dur: 0.16, from: D5, to: A5, bend: 0.9, attack: 0.02, decay: 3.4, octave: 0.06 }],

  // A choice lands: a small drop.
  pop: [{ at: 0, dur: 0.07, from: 470, to: E5, bend: 0.6, decay: 5, octave: 0.08, attack: 0.005 }],

  // Out of quota for now: two slow notes down, the last one long.
  rate: [
    { at: 0, dur: 0.18, from: C5, decay: 2.6, attack: 0.016 },
    { at: 0.17, dur: 0.3, from: G4, decay: 2.6, attack: 0.016, octave: 0.06 },
  ],
};
