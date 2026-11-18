// The open island's shape (src/core/appearance.ts, and what src/core/layout.ts
// makes of it): the four settings brought into their ranges, the island's size
// and corners in each mode, where Liv stands, the window Rust gives the page —
// and that an island nobody reshaped is, to the pixel, the inherited one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const {
  APPEARANCE_KEYS, APPEARANCE_RANGES, DEFAULT_APPEARANCE, DEFAULT_APPEARANCE_SETTINGS, PANEL_MARGIN_W,
  appearance, appearanceSettings, clampAppearance, cornerRadius, islandShape, openHeight, panelSize,
} = await import("../src/core/appearance.ts");
const {
  APPROVAL_LINE_W, APPROVAL_LONG_H, COMPACT_W, EXPANDED_CORNER, EXPANDED_W, INHERITED_SHAPE, NOTCH_H, NOTCH_W,
  PANEL_H, PANEL_W, PEEK_BOT_Y, PEEK_H, PEEK_W, QUESTION_PICKER_H, ROUNDED_CORNER, STAGED_VIEWS, STAGE_W,
  VIEW_LAYOUTS, approvalLineWidth, botPosition, chatPromptHeight, commandNeedsRoom, islandSize, stageOffset,
} = await import("../src/core/layout.ts");
const { CLOSED_CORNER, CLOSED_H } = await import("../src/core/closed.ts");
const { DEFAULT_SETTINGS } = await import("../src/core/state.ts");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VIEWS = Object.keys(VIEW_LAYOUTS);
/** The island at its widest, tallest and roundest, and half see-through. */
const BIG = appearance({ islandWidth: 960, islandExtraHeight: 160, islandRadius: 40, islandOpacity: 50 });

// ── The settings ──────────────────────────────────────────────────────────────

test("the four settings have the ranges Settings offers, and the inherited island as their default", () => {
  assert.deepEqual(APPEARANCE_KEYS, ["islandWidth", "islandExtraHeight", "islandRadius", "islandOpacity"]);
  assert.deepEqual(APPEARANCE_RANGES, {
    islandWidth: { min: 640, max: 960, step: 10, initial: 640 },
    islandExtraHeight: { min: 0, max: 160, step: 10, initial: 0 },
    islandRadius: { min: 0, max: 40, step: 1, initial: 22 },
    islandOpacity: { min: 40, max: 100, step: 1, initial: 100 },
  });
  // The inherited constants are those defaults, and the page starts with them.
  assert.equal(APPEARANCE_RANGES.islandWidth.initial, EXPANDED_W);
  assert.equal(APPEARANCE_RANGES.islandRadius.initial, EXPANDED_CORNER);
  assert.deepEqual(DEFAULT_APPEARANCE_SETTINGS, { islandWidth: 640, islandExtraHeight: 0, islandRadius: 22, islandOpacity: 100 });
  for (const key of APPEARANCE_KEYS) assert.equal(DEFAULT_SETTINGS[key], APPEARANCE_RANGES[key].initial, key);
  assert.deepEqual(DEFAULT_APPEARANCE, { width: 640, extraHeight: 0, radius: 22, opacity: 1 });
  assert.deepEqual(appearance(DEFAULT_SETTINGS), DEFAULT_APPEARANCE);
  assert.deepEqual(INHERITED_SHAPE, { width: DEFAULT_APPEARANCE.width, extraHeight: DEFAULT_APPEARANCE.extraHeight });
});

test("a value is brought onto a step inside its range", () => {
  for (const [key, value, kept] of [
    ["islandWidth", 640, 640], ["islandWidth", 800, 800], ["islandWidth", 960, 960],
    ["islandWidth", 100, 640], ["islandWidth", 5000, 960], ["islandWidth", -1, 640],
    ["islandWidth", 804, 800], ["islandWidth", 806, 810],
    ["islandExtraHeight", 0, 0], ["islandExtraHeight", 160, 160], ["islandExtraHeight", -20, 0],
    ["islandExtraHeight", 999, 160], ["islandExtraHeight", 74, 70],
    ["islandRadius", 0, 0], ["islandRadius", 40, 40], ["islandRadius", 41, 40], ["islandRadius", -3, 0],
    ["islandRadius", 12.4, 12],
    ["islandOpacity", 100, 100], ["islandOpacity", 40, 40], ["islandOpacity", 0, 40], ["islandOpacity", 250, 100],
    ["islandOpacity", 59.6, 60],
  ]) {
    assert.equal(clampAppearance(key, value), kept, `${key}: ${value}`);
  }
});

test("what is missing or not a number reads as the inherited island", () => {
  for (const key of APPEARANCE_KEYS) {
    for (const bad of [undefined, null, Number.NaN, Infinity, -Infinity, "800", "", true, {}, [700]]) {
      assert.equal(clampAppearance(key, bad), APPEARANCE_RANGES[key].initial, `${key}: ${String(bad)}`);
    }
  }
  for (const nothing of [null, undefined, {}, { islandWidth: "wide", islandOpacity: Number.NaN }]) {
    assert.deepEqual(appearanceSettings(nothing), DEFAULT_APPEARANCE_SETTINGS);
    assert.deepEqual(appearance(nothing), DEFAULT_APPEARANCE);
  }
  // Each setting on its own: one that is unusable costs none of the others.
  assert.deepEqual(
    appearance({ islandWidth: 2000, islandExtraHeight: "tall", islandRadius: 8, islandOpacity: 10 }),
    { width: 960, extraHeight: 0, radius: 8, opacity: 0.4 },
  );
  assert.deepEqual(BIG, { width: 960, extraHeight: 160, radius: 40, opacity: 0.5 });
});

test("the Rust side has the same ranges and the same panel", () => {
  const rust = readFileSync(join(ROOT, "src-tauri/src/appearance.rs"), "utf8");
  const range = (name) => {
    const m = rust.match(new RegExp(`pub const ${name}: Range = Range \\{ min: ([\\d.]+), max: ([\\d.]+), step: ([\\d.]+), initial: ([\\d.]+) \\};`));
    assert.ok(m, `no ${name} in appearance.rs`);
    return { min: Number(m[1]), max: Number(m[2]), step: Number(m[3]), initial: Number(m[4]) };
  };
  assert.deepEqual(range("WIDTH"), APPEARANCE_RANGES.islandWidth);
  assert.deepEqual(range("EXTRA_HEIGHT"), APPEARANCE_RANGES.islandExtraHeight);
  assert.deepEqual(range("RADIUS"), APPEARANCE_RANGES.islandRadius);
  assert.deepEqual(range("OPACITY"), APPEARANCE_RANGES.islandOpacity);
  const base = rust.match(/pub const BASE_PANEL: \(f64, f64\) = \(([\d.]+), ([\d.]+)\);/);
  assert.deepEqual([Number(base[1]), Number(base[2])], [PANEL_W, PANEL_H]);
  // settings.json names them as the page does.
  const settings = readFileSync(join(ROOT, "src-tauri/src/settings.rs"), "utf8");
  for (const field of ["island_width", "island_extra_height", "island_radius", "island_opacity"]) {
    assert.ok(settings.includes(`pub ${field}: f64,`), field);
  }
});

// ── The island's size ─────────────────────────────────────────────────────────

test("an island nobody reshaped has the inherited size in every mode and every view", () => {
  for (const shape of [undefined, INHERITED_SHAPE, DEFAULT_APPEARANCE, appearance(DEFAULT_SETTINGS)]) {
    assert.deepEqual(islandSize("hidden", "overview", 0, shape), { w: NOTCH_W, h: 0 });
    assert.deepEqual(islandSize("compact", "overview", 0, shape), { w: COMPACT_W, h: NOTCH_H });
    assert.deepEqual(islandSize("peek", "overview", 0, shape), { w: PEEK_W, h: PEEK_H });
    for (const view of VIEWS) {
      const h = view === "prompt" ? 240 : VIEW_LAYOUTS[view].height;
      assert.deepEqual(islandSize("expanded", view, 0, shape), { w: 640, h }, view);
    }
    assert.deepEqual(islandSize("expanded", "prompt", 1, shape), { w: 640, h: 280 });
    assert.deepEqual(islandSize("expanded", "prompt", 9, shape), { w: 640, h: 300 });
  }
  // The numbers the island has always had.
  assert.deepEqual(
    [NOTCH_W, COMPACT_W, NOTCH_H, PEEK_W, PEEK_H, EXPANDED_W, ROUNDED_CORNER, EXPANDED_CORNER, CLOSED_CORNER],
    [184, 288, 32, 124, 116, 640, 14, 22, 10],
  );
});

test("open, the island is as wide as Settings says and that much taller than its view; folded, it is what it was", () => {
  for (const view of VIEWS) {
    const own = view === "prompt" ? chatPromptHeight(3) : VIEW_LAYOUTS[view].height;
    assert.deepEqual(islandSize("expanded", view, 3, BIG), { w: 960, h: own + 160 }, view);
    assert.deepEqual(islandSize("expanded", view, 3, appearance({ islandWidth: 800 })), { w: 800, h: own }, view);
    assert.deepEqual(islandSize("expanded", view, 3, appearance({ islandExtraHeight: 40 })), { w: 640, h: own + 40 }, view);
  }
  assert.deepEqual(islandSize("hidden", "tools", 0, BIG), { w: NOTCH_W, h: 0 });
  assert.deepEqual(islandSize("compact", "tools", 0, BIG), { w: COMPACT_W, h: NOTCH_H });
  assert.deepEqual(islandSize("peek", "tools", 0, BIG), { w: PEEK_W, h: PEEK_H });
  // A view that asks for a height of its own gets the same extra.
  assert.equal(openHeight(DEFAULT_APPEARANCE, QUESTION_PICKER_H), 200);
  assert.equal(openHeight(BIG, QUESTION_PICKER_H), 360);
  assert.equal(openHeight(appearance({ islandExtraHeight: 30 }), APPROVAL_LONG_H), 230);
});

// ── Its corners ───────────────────────────────────────────────────────────────

test("the corners: the setting for the open island and the pocket, the folded shapes in proportion, never past a half circle", () => {
  const corners = (a) => ["expanded", "peek", "compact", "closed"].map((shape) => cornerRadius(a, shape));
  // Inherited: 22 open, 14 compact, 10 closed.
  assert.deepEqual(corners(DEFAULT_APPEARANCE), [22, 22, 14, 10]);
  assert.deepEqual(corners(appearance({ islandRadius: 0 })), [0, 0, 0, 0]);
  assert.deepEqual(corners(appearance({ islandRadius: 11 })), [11, 11, 7, 5]);
  // At the roundest the folded shapes stop at half their height.
  assert.deepEqual(corners(BIG), [40, 40, NOTCH_H / 2, CLOSED_H / 2]);
  for (let radius = 0; radius <= 40; radius++) {
    const [open, pocket, compact, closed] = corners(appearance({ islandRadius: radius }));
    assert.equal(open, radius);
    assert.equal(pocket, radius);
    assert.ok(compact <= NOTCH_H / 2 && closed <= CLOSED_H / 2, `${radius}`);
    assert.ok(pocket <= PEEK_H / 2 && pocket <= PEEK_W / 2);
    // In proportion until the cap: compact 14 and closed 10 for an open 22.
    if (compact < NOTCH_H / 2) assert.ok(Math.abs(compact - (14 * radius) / 22) < 1e-9);
    if (closed < CLOSED_H / 2) assert.ok(Math.abs(closed - (10 * radius) / 22) < 1e-9);
  }
});

test("each mode has its shape: folded all the way it is the closed island's, or the compact one when nothing shows", () => {
  assert.equal(islandShape("expanded", true), "expanded");
  assert.equal(islandShape("peek", true), "peek");
  assert.equal(islandShape("compact", true), "compact");
  assert.equal(islandShape("hidden", true), "closed");
  assert.equal(islandShape("hidden", false), "compact");
});

// ── The window ────────────────────────────────────────────────────────────────

test("the panel is the inherited one until the island grows: 80 wider than it, 20 taller than its tallest view", () => {
  assert.equal(PANEL_MARGIN_W, 80);
  assert.deepEqual(panelSize(DEFAULT_APPEARANCE), { w: 720, h: 320 });
  assert.deepEqual(panelSize(INHERITED_SHAPE), { w: PANEL_W, h: PANEL_H });
  assert.deepEqual(panelSize(appearance({ islandWidth: 800 })), { w: 880, h: 320 });
  assert.deepEqual(panelSize(appearance({ islandExtraHeight: 60 })), { w: 720, h: 380 });
  assert.deepEqual(panelSize(BIG), { w: 1040, h: 480 });
  // Whatever is open, and however long the chat, it fits its panel with that room to spare.
  for (const a of [DEFAULT_APPEARANCE, BIG, appearance({ islandWidth: 700, islandExtraHeight: 90 })]) {
    const panel = panelSize(a);
    for (const view of VIEWS) {
      const { w, h } = islandSize("expanded", view, 99, a);
      assert.ok(w + 80 <= panel.w && h + 20 <= panel.h, `${view} in ${panel.w}×${panel.h}`);
    }
    assert.ok(openHeight(a, 300) + 20 <= panel.h, "the chat's model picker");
  }
});

// ── Where Liv stands ──────────────────────────────────────────────────────────

test("on the inherited island Liv stands where it always did", () => {
  const at = (view, h, progress = 0) => {
    const p = botPosition("expanded", view, h, progress);
    return [p.cx, p.cy, p.diameter];
  };
  assert.deepEqual(at("overview", 160), [68, 101, 58]);
  assert.deepEqual(at("approval", 160), [62, 101, 56]);
  assert.deepEqual(at("approval", 200), [62, 121, 56]);
  assert.deepEqual(at("recap", 184), [62, 113, 58]);
  assert.deepEqual(at("whatsNew", 222), [62, 132, 58]);
  assert.deepEqual(at("prompt", 300), [52, 171, 44]);
  assert.deepEqual(at("upload", 176), [140, 104, 62]);
  assert.deepEqual(at("uploading", 176, 0), [36, 103, 20]);
  assert.deepEqual(at("uploading", 176, 1), [562, 103, 20]);
  assert.deepEqual(at("choose", 176), [60, 101, 52]);
  assert.deepEqual(at("tools", 236), [28, 58, 20]);
  // Handed the inherited shape, or none: the same, in every view.
  for (const view of VIEWS) {
    const h = VIEW_LAYOUTS[view].height;
    assert.deepEqual(botPosition("expanded", view, h, 0.3, DEFAULT_APPEARANCE), botPosition("expanded", view, h, 0.3), view);
  }
  assert.deepEqual(stageOffset(), { x: 0, y: 0 });
  assert.deepEqual(stageOffset(DEFAULT_APPEARANCE), { x: 0, y: 0 });
});

test("in a wider, taller island Liv stays next to what it stands by", () => {
  const big = (view) => {
    const { h } = islandSize("expanded", view, 0, BIG);
    return { h, ...botPosition("expanded", view, h, 0.5, BIG) };
  };
  for (const view of VIEWS) {
    const layout = VIEW_LAYOUTS[view];
    const liv = big(view);
    assert.equal(liv.diameter, layout.botDiameter, view);
    if (STAGED_VIEWS.has(view)) continue;
    // The cards are anchored to the island's left edge: so is Liv.
    assert.equal(liv.cx, layout.botX, view);
    if (layout.botY == null) {
      // What a card says is centred on its height, and Liv with it: as far
      // below the middle of the island as on the inherited one (21 px).
      assert.equal(liv.cy - liv.h / 2, 21, view);
      const inherited = botPosition("expanded", view, layout.height);
      assert.equal(inherited.cy - layout.height / 2, 21, view);
    } else {
      // The tools: in the left card's heading, which stays at the top.
      assert.equal(liv.cy, layout.botY, view);
    }
  }
  assert.deepEqual([...STAGED_VIEWS].sort(), ["choose", "upload", "uploading"]);
  // The drop flow is one 640 × 176 drawing in the middle of the room: Liv moves with it.
  assert.equal(STAGE_W, 640);
  assert.deepEqual(stageOffset(BIG), { x: 160, y: 80 });
  assert.deepEqual(stageOffset(appearance({ islandWidth: 800, islandExtraHeight: 30 })), { x: 80, y: 15 });
  assert.deepEqual([big("upload").cx, big("upload").cy], [160 + 140, 80 + 104]);
  assert.deepEqual([big("choose").cx, big("choose").cy], [160 + 60, 80 + 101]);
  // Riding the progress bar, which is 526 long whatever the island's width.
  const riding = (progress) => botPosition("expanded", "uploading", 336, progress, BIG);
  assert.deepEqual([riding(0).cx, riding(0).cy], [160 + 36, 80 + 103]);
  assert.equal(riding(1).cx - riding(0).cx, 526);
  // Folded and in its pocket nothing of this counts.
  assert.deepEqual(botPosition("compact", "upload", NOTCH_H, 0, BIG), botPosition("compact", "upload", NOTCH_H));
  assert.deepEqual(botPosition("peek", "upload", PEEK_H, 0, BIG), { cx: PEEK_W / 2, cy: PEEK_BOT_Y, diameter: 58, opacity: 1 });
});

// ── What else knew the island was 640 wide ───────────────────────────────────

test("the approval card's one line is as long as the island is wide", () => {
  assert.equal(APPROVAL_LINE_W, 464);
  assert.equal(approvalLineWidth(), 464);
  assert.equal(approvalLineWidth(640), 464);
  assert.equal(approvalLineWidth(960), 784);
  const sevenPerChar = (text) => text.length * 7;
  const command = "x".repeat(80); // 560 px
  assert.equal(commandNeedsRoom(command, sevenPerChar), true);
  assert.equal(commandNeedsRoom(command, sevenPerChar, approvalLineWidth(640)), true);
  assert.equal(commandNeedsRoom(command, sevenPerChar, approvalLineWidth(960)), false, "it fits the wider island's line");
  assert.equal(commandNeedsRoom("a\nb", sevenPerChar, approvalLineWidth(960)), true, "a line break still needs the room");
});

test("the island and its stylesheet name the same two variables, and the inherited look is their fallback", () => {
  const css = readFileSync(join(ROOT, "src/style.css"), "utf8");
  const island = readFileSync(join(ROOT, "src/island/island.ts"), "utf8");
  for (const name of ["--island-opacity", "--island-extra-h"]) {
    assert.ok(island.includes(`setProperty("${name}"`), `island.ts does not set ${name}`);
    assert.ok(css.includes(`var(${name}, `), `style.css does not read ${name}`);
  }
  assert.match(css, /#island \{\s*opacity: var\(--island-opacity, 1\);\s*\}/);
  // Every use of the extra height falls back to none.
  for (const use of css.matchAll(/var\(--island-extra-h([^)]*)\)/g)) assert.equal(use[1], ", 0px");
});
