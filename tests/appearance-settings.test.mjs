// Settings → Appearance → Shape of the open island (src/settings/appearance.ts), drawn on the
// fake DOM: four sliders at the saved values, each with its value next to it;
// a slider that moves is followed by the island at once and saved a moment
// after it stops; Reset puts the inherited island back. What it asks of Rust
// is read from the commands it invokes (tests/tauri.mjs).

import { mock, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { calls, sent } from "./tauri.mjs";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
// The save waits on a timer: time passes by hand.
mock.timers.enable({ apis: ["setTimeout"] });

const { APPEARANCE_SAVE_DELAY_MS, appearanceSection } = await import("../src/settings/appearance.ts");
const { APPEARANCE_RANGES } = await import("../src/core/appearance.ts");
const { DEFAULT_SETTINGS } = await import("../src/core/state.ts");
const { setLanguage } = await import("../src/i18n/i18n.ts");

const INHERITED = { islandWidth: 640, islandExtraHeight: 0, islandRadius: 22, islandOpacity: 100 };

/**
 * The section over settings of its own: `saved` is what settings.json held.
 * `settings` is replaced the way the window replaces its own when a change
 * comes from elsewhere; `saves` are the settings each save wrote.
 */
function open(saved = {}) {
  const box = { settings: { ...DEFAULT_SETTINGS, ...saved }, saves: [] };
  const section = appearanceSection(() => box.settings, () => {
    box.saves.push({ ...box.settings });
  });
  const sliders = () => section.el.find("INPUT");
  const row = (i) => sliders()[i].parentNode;
  return {
    box,
    section,
    sliders,
    slider: (i) => sliders()[i],
    values: () => sliders().map((slider) => slider.value),
    labels: () => sliders().map((_, i) => row(i).find("LABEL")[0].textContent),
    shown: () => sliders().map((_, i) => row(i).find(".hint")[0].textContent),
    reset: () => section.el.find("BUTTON")[0],
    /** The pointer drags slider `i` to `value`: the field's value, then its `input`. */
    move(i, value) {
      sliders()[i].value = String(value);
      sliders()[i].fire("input");
    },
    /** The four settings as they are now. */
    look: () => Object.fromEntries(Object.keys(INHERITED).map((key) => [key, box.settings[key]])),
  };
}

/** What the island was last told to look like, before any save. */
const previewed = () => sent("preview_appearance").at(-1);
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  mock.timers.tick(10 * APPEARANCE_SAVE_DELAY_MS);
  calls.length = 0;
  setLanguage("en");
});

test("four sliders, each with its range, at the inherited island on a fresh install", () => {
  const ui = open();
  assert.equal(ui.section.el.getAttribute("data-anchor"), "appearance.shape");
  assert.equal(ui.section.el.find("H2")[0].textContent, "Shape of the open island");
  assert.deepEqual(ui.labels(), ["Width", "Extra height", "Corner rounding", "Opacity"]);
  assert.deepEqual(ui.values(), ["640", "0", "22", "100"]);
  assert.deepEqual(ui.shown(), ["640 px", "0 px", "22 px", "100 %"]);
  const ranges = Object.values(APPEARANCE_RANGES);
  ui.sliders().forEach((slider, i) => {
    assert.equal(slider.getAttribute("type"), "range");
    assert.deepEqual(
      [slider.getAttribute("min"), slider.getAttribute("max"), slider.getAttribute("step")],
      [String(ranges[i].min), String(ranges[i].max), String(ranges[i].step)],
    );
    assert.equal(slider.getAttribute("aria-label"), ui.labels()[i]);
  });
  // One line under the title says what the sliders are for.
  assert.equal(ui.section.el.find(".group-about")[0].textContent, "How wide, tall and round the open island is, and how see-through.");
  assert.equal(ui.reset().textContent, "Reset");
  // Drawing it asks nothing of Rust and writes nothing.
  assert.deepEqual(calls, []);
  assert.deepEqual(ui.box.saves, []);
});

test("the sliders come up with what was saved, and a value settings.json should never hold is shown inside its range", () => {
  const ui = open({ islandWidth: 800, islandExtraHeight: 60, islandRadius: 12, islandOpacity: 85 });
  assert.deepEqual(ui.values(), ["800", "60", "12", "85"]);
  assert.deepEqual(ui.shown(), ["800 px", "60 px", "12 px", "85 %"]);
  const odd = open({ islandWidth: 5000, islandExtraHeight: -40, islandRadius: Number.NaN, islandOpacity: "half" });
  assert.deepEqual(odd.values(), ["960", "0", "22", "100"]);
  assert.deepEqual(odd.shown(), ["960 px", "0 px", "22 px", "100 %"]);
});

test("a slider that moves is followed by the island at once and saved a moment after it stops", async () => {
  const ui = open();
  ui.move(0, 800);
  assert.equal(ui.box.settings.islandWidth, 800);
  assert.deepEqual(ui.shown(), ["800 px", "0 px", "22 px", "100 %"]);
  await flush();
  assert.deepEqual(previewed(), { width: 800, extraHeight: 0, radius: 22, opacity: 100 }, "the island has it now");
  assert.deepEqual(ui.box.saves, [], "and nothing is written yet");

  // Dragged on: every step reaches the island, and the save keeps waiting.
  for (const width of [810, 820, 830, 900]) {
    mock.timers.tick(APPEARANCE_SAVE_DELAY_MS - 1);
    ui.move(0, width);
  }
  await flush();
  assert.deepEqual(sent("preview_appearance").map((shape) => shape.width), [800, 810, 820, 830, 900]);
  assert.deepEqual(ui.box.saves, []);
  // It stops: one save, with where it stopped.
  mock.timers.tick(APPEARANCE_SAVE_DELAY_MS - 1);
  assert.deepEqual(ui.box.saves, []);
  mock.timers.tick(1);
  assert.equal(ui.box.saves.length, 1);
  assert.equal(ui.box.saves[0].islandWidth, 900);
  mock.timers.tick(10 * APPEARANCE_SAVE_DELAY_MS);
  assert.equal(ui.box.saves.length, 1, "once");

  // The other three, each its own setting.
  ui.move(1, 40);
  ui.move(2, 0);
  ui.move(3, 60);
  assert.deepEqual(ui.look(), { islandWidth: 900, islandExtraHeight: 40, islandRadius: 0, islandOpacity: 60 });
  assert.deepEqual(ui.shown(), ["900 px", "40 px", "0 px", "60 %"]);
  await flush();
  assert.deepEqual(previewed(), { width: 900, extraHeight: 40, radius: 0, opacity: 60 });
  mock.timers.tick(APPEARANCE_SAVE_DELAY_MS);
  assert.equal(ui.box.saves.length, 2, "three moves in a row, one save");
  assert.deepEqual(
    Object.fromEntries(Object.keys(INHERITED).map((key) => [key, ui.box.saves[1][key]])),
    { islandWidth: 900, islandExtraHeight: 40, islandRadius: 0, islandOpacity: 60 },
  );
  // Nothing else of the settings was touched.
  assert.deepEqual({ ...ui.box.saves[1], ...INHERITED }, { ...DEFAULT_SETTINGS });
});

test("whatever the field hands over, the value saved is on a step inside the range", async () => {
  const ui = open();
  for (const [i, handed, kept] of [
    [0, 805, 810], [0, 5000, 960], [0, 12, 640], [0, "wide", 640],
    [1, 74, 70], [1, 900, 160], [1, -30, 0],
    [2, 99, 40], [2, -1, 0], [2, 17.6, 18],
    [3, 3, 40], [3, 250, 100], [3, 59.6, 60],
  ]) {
    ui.move(i, handed);
    const key = Object.keys(INHERITED)[i];
    assert.equal(ui.box.settings[key], kept, `${key}: ${handed}`);
    assert.equal(typeof ui.box.settings[key], "number");
  }
  await flush();
  for (const shape of sent("preview_appearance")) {
    assert.ok(shape.width >= 640 && shape.width <= 960 && shape.width % 10 === 0);
    assert.ok(shape.extraHeight >= 0 && shape.extraHeight <= 160 && shape.extraHeight % 10 === 0);
    assert.ok(shape.radius >= 0 && shape.radius <= 40 && Number.isInteger(shape.radius));
    assert.ok(shape.opacity >= 40 && shape.opacity <= 100 && Number.isInteger(shape.opacity));
  }
  mock.timers.tick(APPEARANCE_SAVE_DELAY_MS);
  assert.deepEqual(
    Object.fromEntries(Object.keys(INHERITED).map((key) => [key, ui.box.saves.at(-1)[key]])),
    { islandWidth: 640, islandExtraHeight: 0, islandRadius: 18, islandOpacity: 60 },
  );
});

test("Reset puts the four back to the inherited island, at once", async () => {
  const ui = open({ islandWidth: 900, islandExtraHeight: 120, islandRadius: 4, islandOpacity: 55 });
  // A slider was moved a moment ago: its save is still waiting.
  ui.move(3, 50);
  ui.reset().fire("click");
  assert.deepEqual(ui.look(), INHERITED);
  assert.deepEqual(ui.values(), ["640", "0", "22", "100"]);
  assert.deepEqual(ui.shown(), ["640 px", "0 px", "22 px", "100 %"]);
  await flush();
  assert.deepEqual(previewed(), { width: 640, extraHeight: 0, radius: 22, opacity: 100 });
  // A click, not a drag: written now, and the save that was waiting is not made after it.
  assert.equal(ui.box.saves.length, 1);
  assert.deepEqual({ ...ui.box.saves[0] }, { ...DEFAULT_SETTINGS });
  mock.timers.tick(10 * APPEARANCE_SAVE_DELAY_MS);
  assert.equal(ui.box.saves.length, 1);
});

test("a change made elsewhere reaches the sliders, except the one under the pointer", () => {
  const ui = open();
  // The window replaces its settings when Rust says they changed.
  ui.box.settings = { ...ui.box.settings, islandWidth: 720, islandOpacity: 70 };
  ui.section.sync();
  assert.deepEqual(ui.values(), ["720", "0", "22", "70"]);
  assert.deepEqual(ui.shown(), ["720 px", "0 px", "22 px", "70 %"]);
  // The sliders write into the settings as they are now, not the ones the section was built with.
  ui.move(1, 30);
  assert.deepEqual(ui.look(), { islandWidth: 720, islandExtraHeight: 30, islandRadius: 22, islandOpacity: 70 });

  // A slider that has the focus is being dragged: an echo of an older value does not move it.
  document.activeElement = ui.slider(0);
  try {
    ui.slider(0).value = "880";
    ui.box.settings = { ...ui.box.settings, islandWidth: 860, islandRadius: 9 };
    ui.section.sync();
    assert.equal(ui.slider(0).value, "880", "where the pointer has it");
    assert.equal(ui.slider(2).value, "9", "the others follow");
    // Reset moves all four, that one too.
    ui.reset().fire("click");
    assert.deepEqual(ui.values(), ["640", "0", "22", "100"]);
  } finally {
    delete document.activeElement;
  }
});

test("in Spanish the section reads in Spanish", () => {
  setLanguage("es");
  const ui = open({ islandOpacity: 80 });
  assert.equal(ui.section.el.find("H2")[0].textContent, "Forma de la isla abierta");
  assert.deepEqual(ui.labels(), ["Ancho", "Alto adicional", "Redondeo de las esquinas", "Opacidad"]);
  assert.equal(ui.reset().textContent, "Restablecer");
  assert.equal(ui.section.el.find(".group-about")[0].textContent, "El ancho, el alto y el redondeo de la isla abierta, y su transparencia.");
  assert.deepEqual(ui.shown(), ["640 px", "0 px", "22 px", "80 %"]);
});
