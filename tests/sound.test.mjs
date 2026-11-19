// What Settings → General says about sounds must be true: Liv ships its own
// (tests/sounds-gen.test.mjs holds the files to their recipes), and the names
// and formats it lists for replacing one are ones that work
// (src/core/sound.ts, src-tauri/src/sounds.rs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOUND_FORMATS, SOUND_NAMES, soundFilesHint } from "../src/core/sound.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TABLE = JSON.parse(readFileSync(join(ROOT, "src/i18n/strings.json"), "utf8")).strings;
/** How to replace a sound, in words; the names and the formats follow it, the same in every language. */
const HOW = "To replace a sound, put a file with its name in the sounds folder, then reload.";

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [readFileSync(path, "utf8")] : [];
  });
}

/** The names the line under it lists, and the formats after the dot in the middle. */
const listed = () => soundFilesHint().split(" · ")[0].split(", ");
const formats = () => soundFilesHint().split(" · ")[1].split(" ").map((ext) => ext.replace(/^\./, ""));

test("the hint is in Settings, in both languages, with the names and the formats under it", () => {
  const settings = readFileSync(join(ROOT, "src/settings/main.ts"), "utf8");
  assert.ok(TABLE[HOW]?.es, "the sounds hint is gone from the table");
  assert.ok(settings.includes(JSON.stringify(HOW)));
  assert.ok(settings.includes("soundFilesHint()"), "the names are no longer listed");
  assert.deepEqual(formats(), [...SOUND_FORMATS]);
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
  const names = listed();
  for (const name of names) assert.ok(SOUND_NAMES.includes(name), `${name} is not a sound name`);
  assert.deepEqual([...names].sort(), [...played].sort());
  assert.equal(new Set(names).size, names.length);
});

test("every format the hint lists is one the sounds folder is read for", () => {
  const rust = readFileSync(join(ROOT, "src-tauri/src/sounds.rs"), "utf8");
  const accepted = JSON.parse(rust.match(/const EXTENSIONS: \[&str; \d+\] = (\[[^\]]+\]);/)[1]);
  assert.ok(formats().length > 0);
  for (const ext of formats()) assert.ok(accepted.includes(ext), `.${ext} is not looked for`);
});
