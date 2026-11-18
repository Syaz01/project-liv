// Writes Liv's sounds into resources/sounds, the folder the app ships
// (SOUNDS_DIR in vite.config.ts). They are synthesised here, from the recipes
// in scripts/sounds/recipes.mjs: nothing is sampled from anywhere.
//
//   npm run sounds
//
// Run it again after changing a recipe; the files are kept in the repository,
// and tests/sounds-gen.test.mjs fails if they no longer match their recipes.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RECIPES } from "./sounds/recipes.mjs";
import { RATE, render, wav } from "./sounds/synth.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "sounds");
mkdirSync(out, { recursive: true });

let total = 0;
for (const [name, recipe] of Object.entries(RECIPES)) {
  const samples = render(recipe);
  const file = wav(samples);
  writeFileSync(join(out, `${name}.wav`), file);
  total += file.length;
  console.log(`${name.padEnd(9)} ${(samples.length / RATE).toFixed(2)} s  ${(file.length / 1024).toFixed(1)} KB`);
}
console.log(`\n${Object.keys(RECIPES).length} sounds, ${(total / 1024).toFixed(0)} KB, in ${out}`);
