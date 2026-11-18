// What Settings → General says about sounds must be true: Liv ships its own
// (tests/sounds-gen.test.mjs holds the files to their recipes), and the names
// and formats it lists for replacing one are ones that work
// (src/core/sound.ts, src-tauri/src/sounds.rs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOUND_NAMES } from "../src/core/sound.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TABLE = JSON.parse(readFileSync(join(ROOT, "src/i18n/strings.json"), "utf8")).strings;
const HINT = Object.keys(TABLE).find((key) => key.startsWith("Liv has its own sounds."));

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [readFileSync(path, "utf8")] : [];
  });
}

/** The names the hint lists: between "named" and the formats in brackets. */
const listed = (text, last) =>
  text.match(/(?:named|llamado) ([^(]+) \(/)[1].split(new RegExp(`, | ${last} `)).map((name) => name.trim());
const formats = (text) => text.match(/\(([^)]+)\)/)[1].match(/\.\w+/g).map((ext) => ext.slice(1));

test("the hint is in Settings, and says the same in both languages", () => {
  assert.ok(HINT, "the sounds hint is gone from the table");
  assert.ok(readFileSync(join(ROOT, "src/settings/main.ts"), "utf8").includes(JSON.stringify(HINT)));
  assert.deepEqual(listed(TABLE[HINT].es, "o"), listed(HINT, "or"));
  assert.deepEqual(formats(TABLE[HINT].es), formats(HINT));
});

test("Liv ships a sound of its own for every name, as the hint says", () => {
  // vite.config.ts serves and bundles this folder.
  for (const name of SOUND_NAMES) {
    assert.ok(existsSync(join(ROOT, "resources/sounds", `${name}.wav`)), `${name}.wav is missing: npm run sounds`);
  }
});

test("every name the hint lists is a sound the island plays, and it lists them all", () => {
  const code = sources(join(ROOT, "src")).join("\n");
  /** Played by name, or as the sound of an alert, or as the name of the card that comes up. */
  const played = SOUND_NAMES.filter((name) =>
    new RegExp(`Sound\\.play\\([^)]*"${name}"`).test(code) || new RegExp(`sound: "${name}"`).test(code) ||
    ((name === "approval" || name === "question") && /Sound\.play\(view\)/.test(code)));
  const names = listed(HINT, "or");
  for (const name of names) assert.ok(SOUND_NAMES.includes(name), `${name} is not a sound name`);
  assert.deepEqual([...names].sort(), [...played].sort());
  assert.equal(new Set(names).size, names.length);
});

test("every format the hint lists is one the sounds folder is read for", () => {
  const rust = readFileSync(join(ROOT, "src-tauri/src/sounds.rs"), "utf8");
  const accepted = JSON.parse(rust.match(/const EXTENSIONS: \[&str; \d+\] = (\[[^\]]+\]);/)[1]);
  for (const ext of formats(HINT)) assert.ok(accepted.includes(ext), `.${ext} is not looked for`);
});
