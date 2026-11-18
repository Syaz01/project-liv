// Liv's own sounds: the synthesiser (scripts/sounds/synth.mjs), the recipes
// (scripts/sounds/recipes.mjs) and the files they make, which the app ships
// from resources/sounds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOUND_NAMES } from "../src/core/sound.ts";
import { RECIPES } from "../scripts/sounds/recipes.mjs";
import { PEAK, RATE, loudnessAt, pitchAt, render, wav } from "../scripts/sounds/synth.mjs";

const SOUNDS = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "sounds");
const peak = (samples) => samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);

test("there is a recipe for every sound the island plays, and for nothing else", () => {
  assert.deepEqual(Object.keys(RECIPES).sort(), [...SOUND_NAMES].sort());
});

test("a note leans in ratio from one pitch to the other, and holds a pitch it was given alone", () => {
  const glide = { at: 0, dur: 1, from: 400, to: 1600 };
  assert.equal(pitchAt(glide, 0), 400);
  // Halfway in time is halfway in pitch as the ear hears it: one octave up of two.
  assert.ok(Math.abs(pitchAt(glide, 0.5) - 800) < 1e-9);
  assert.ok(Math.abs(pitchAt(glide, 1) - 1600) < 1e-9);
  // A late bend is still low at the half, an early one already high.
  assert.ok(pitchAt({ ...glide, bend: 2 }, 0.5) < 800);
  assert.ok(pitchAt({ ...glide, bend: 0.5 }, 0.5) > 800);
  assert.equal(pitchAt({ at: 0, dur: 1, from: 440 }, 0.7), 440);
});

test("the voice is soft: most notes hold their pitch, and none slides far", () => {
  const notes = Object.values(RECIPES).flat();
  const held = notes.filter((note) => (note.to ?? note.from) === note.from);
  assert.ok(held.length >= notes.length * 0.75, `${held.length} of ${notes.length} notes hold their pitch`);
  for (const [name, recipe] of Object.entries(RECIPES)) {
    for (const note of recipe) {
      // Never as much as an octave: a slide that wide is a siren, not a blip.
      const ratio = (note.to ?? note.from) / note.from;
      assert.ok(ratio > 0.6 && ratio < 1.7, `${name} slides by ${ratio.toFixed(2)}`);
      // A gentle start, and only a touch of the octave above.
      assert.ok((note.attack ?? 0.01) >= 0.004, `${name} starts too sharply`);
      assert.ok((note.octave ?? 0.12) <= 0.15, `${name} is too bright`);
    }
  }
});

test("a note is silent at both ends and never louder than full", () => {
  const note = { at: 0, dur: 0.2, from: 440 };
  assert.equal(loudnessAt(note, 0), 0);
  assert.ok(loudnessAt(note, 0.2) < 1e-9);
  assert.equal(loudnessAt(note, -0.01), 0);
  assert.equal(loudnessAt(note, 0.21), 0);
  let loudest = 0;
  for (let t = 0; t <= 0.2; t += 0.0005) {
    const loud = loudnessAt(note, t);
    assert.ok(loud >= 0 && loud <= 1);
    loudest = Math.max(loudest, loud);
  }
  // Up gently, but soon: nearly full a little past a hundredth of a second.
  assert.ok(loudest > 0.8);
  assert.ok(loudnessAt(note, 0.012) > 0.8);
  // And away like a pluck: far quieter by the middle than at its fullest.
  assert.ok(loudnessAt(note, 0.1) < loudest * 0.4);
});

test("every sound is short, starts and ends in silence, and is as loud as the others", () => {
  for (const name of SOUND_NAMES) {
    const samples = render(RECIPES[name]);
    const seconds = samples.length / RATE;
    assert.ok(seconds >= 0.02 && seconds <= 0.5, `${name} lasts ${seconds.toFixed(2)} s`);
    assert.ok(Math.abs(peak(samples) - PEAK) < 1e-6, `${name} peaks at ${peak(samples)}`);
    // No click going in or out: it starts from nothing and is still quiet a
    // millisecond in, and its last millisecond is near nothing.
    const edge = Math.round(RATE / 1000);
    assert.ok(Math.abs(samples[0]) < 0.001, `${name} does not start from silence`);
    assert.ok(peak(samples.subarray(0, edge)) < 0.2, `${name} starts with a click`);
    assert.ok(peak(samples.subarray(samples.length - edge)) < 0.01, `${name} ends with a click`);
    for (const sample of samples) assert.ok(Number.isFinite(sample), `${name} has a sample that is not a number`);
  }
});

test("the same recipe always makes the same sound", () => {
  for (const name of ["finish", "error", "rate"]) {
    assert.deepEqual(wav(render(RECIPES[name])), wav(render(RECIPES[name])));
  }
});

test("what goes well rises and what goes badly sinks", () => {
  const first = (name) => RECIPES[name][0];
  const last = (name) => RECIPES[name].at(-1);
  const ends = (note) => note.to ?? note.from;
  for (const name of ["peek", "open", "work", "finish", "approve", "question", "send"]) {
    assert.ok(ends(last(name)) > first(name).from, `${name} should end higher than it starts`);
  }
  for (const name of ["close", "error", "rate"]) {
    assert.ok(ends(last(name)) < first(name).from, `${name} should end lower than it starts`);
  }
});

test("a sound is written as a mono 16-bit WAV at the synthesiser's rate", () => {
  const samples = render(RECIPES.blip);
  const file = wav(samples);
  assert.equal(file.toString("ascii", 0, 4), "RIFF");
  assert.equal(file.readUInt32LE(4), file.length - 8);
  assert.equal(file.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(file.readUInt16LE(20), 1); // PCM
  assert.equal(file.readUInt16LE(22), 1); // mono
  assert.equal(file.readUInt32LE(24), RATE);
  assert.equal(file.readUInt32LE(28), RATE * 2);
  assert.equal(file.readUInt16LE(34), 16);
  assert.equal(file.toString("ascii", 36, 40), "data");
  assert.equal(file.readUInt32LE(40), samples.length * 2);
  assert.equal(file.length, 44 + samples.length * 2);
  // Loud samples are clipped, never wrapped around.
  const loud = wav(new Float32Array([2, -2, 0]));
  assert.deepEqual([loud.readInt16LE(44), loud.readInt16LE(46), loud.readInt16LE(48)], [32767, -32767, 0]);
});

test("the files Liv ships are the ones the recipes make: every sound, and nothing else", () => {
  // `npm run sounds` after changing a recipe.
  assert.deepEqual(readdirSync(SOUNDS).sort(), SOUND_NAMES.map((name) => `${name}.wav`).sort());
  let total = 0;
  for (const name of SOUND_NAMES) {
    const shipped = readFileSync(join(SOUNDS, `${name}.wav`));
    assert.ok(shipped.equals(wav(render(RECIPES[name]))), `${name}.wav is not what its recipe makes: npm run sounds`);
    total += shipped.length;
  }
  // The whole voice stays small: it rides in the installer.
  assert.ok(total < 300 * 1024, `${Math.round(total / 1024)} KB of sounds`);
});
