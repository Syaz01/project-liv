// Liv's voice, synthesised: soft blips, like a drop or a light mallet — a pair
// that steps up when something goes well, one that steps down when it does
// not. Everything here is plain arithmetic: no samples of anyone's, no
// randomness, so the same recipe always gives the same file
// (tests/sounds-gen.test.mjs holds resources/sounds to it).
//
// A sound is a list of notes. A note is a pure tone with a touch of its
// octave that dies away first, as a struck thing rings: it comes up gently,
// fades the way a pluck does, and is silent at both ends, so nothing clicks.
// Most notes hold their pitch; a few lean a little up or down.

/** Samples per second. Liv's tones sit well under 4 kHz: 32 kHz carries them whole. */
export const RATE = 32000;
/** The loudest sample of every sound, of 1: the app's own volume does the rest. */
export const PEAK = 0.85;

/**
 * @typedef {object} Note
 * @property {number} at       when it starts, seconds
 * @property {number} dur      how long it lasts, seconds
 * @property {number} from     pitch at its start, Hz
 * @property {number} [to]     pitch at its end, Hz (default: `from`)
 * @property {number} [bend]   how the lean is paced: 1 even, above 1 late, below 1 early
 * @property {number} [gain]   loudness against the other notes (default 1)
 * @property {number} [attack] seconds to full loudness (default 0.01)
 * @property {number} [decay]  how fast it dies away, in halvings over the note (default 4)
 * @property {number} [octave] how much of the octave above rings with it at first (default 0.12)
 */

/** The pitch of `note` at `t` seconds into it: a lean in ratio, as the ear hears pitch. */
export function pitchAt(note, t) {
  const to = note.to ?? note.from;
  const along = Math.min(1, Math.max(0, t / note.dur)) ** (note.bend ?? 1);
  return note.from * (to / note.from) ** along;
}

/** How loud `note` is at `t` seconds into it, 0…1: up gently, away like a pluck, silent at both ends. */
export function loudnessAt(note, t) {
  if (t < 0 || t > note.dur) return 0;
  const attack = Math.min(note.attack ?? 0.01, note.dur / 2);
  const rise = t < attack ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack) : 1;
  const fall = 0.5 ** ((note.decay ?? 4) * (t / note.dur));
  // The last quarter fades to nothing whatever the decay left.
  const tail = note.dur * 0.25;
  const left = note.dur - t;
  const fade = left < tail ? 0.5 - 0.5 * Math.cos((Math.PI * left) / tail) : 1;
  return rise * fall * fade;
}

/** The notes of `recipe` as samples, the loudest at `PEAK`. */
export function render(recipe) {
  const length = Math.max(...recipe.map((note) => note.at + note.dur));
  const samples = new Float32Array(Math.ceil(length * RATE) + 1);
  for (const note of recipe) {
    const start = Math.round(note.at * RATE);
    const count = Math.round(note.dur * RATE);
    const octave = note.octave ?? 0.12;
    let phase = 0;
    for (let i = 0; i < count; i++) {
      const t = i / RATE;
      phase += (2 * Math.PI * pitchAt(note, t)) / RATE;
      // The octave is gone by a third of the note: what is left is the pure tone.
      const shimmer = octave * 0.5 ** (12 * (t / note.dur));
      const voice = Math.sin(phase) + shimmer * Math.sin(2 * phase);
      samples[start + i] += voice * loudnessAt(note, t) * (note.gain ?? 1);
    }
  }
  let loudest = 0;
  for (const sample of samples) loudest = Math.max(loudest, Math.abs(sample));
  if (loudest > 0) for (let i = 0; i < samples.length; i++) samples[i] *= PEAK / loudest;
  return samples;
}

/** `samples` as a WAV file: mono, 16 bit, `RATE` samples a second. */
export function wav(samples) {
  const data = samples.length * 2;
  const file = Buffer.alloc(44 + data);
  file.write("RIFF", 0, "ascii");
  file.writeUInt32LE(36 + data, 4);
  file.write("WAVEfmt ", 8, "ascii");
  file.writeUInt32LE(16, 16); // the format block's size
  file.writeUInt16LE(1, 20); // PCM
  file.writeUInt16LE(1, 22); // one channel
  file.writeUInt32LE(RATE, 24);
  file.writeUInt32LE(RATE * 2, 28); // bytes a second
  file.writeUInt16LE(2, 32); // bytes a sample
  file.writeUInt16LE(16, 34); // bits a sample
  file.write("data", 36, "ascii");
  file.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i]));
    file.writeInt16LE(Math.round(clipped * 32767), 44 + i * 2);
  }
  return file;
}
