// The wardrobe card: its logic (src/core/wardrobe.ts) and the card itself
// (src/views/wardrobe.ts) on the fake DOM — what Liv tries on while the
// pointer is on a chip, what it goes back to, what a click keeps, which chip
// is marked and what the line under them says. The day is set by hand: "Auto"
// follows the season.

import { mock, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

const WINTER = new Date(2027, 0, 20, 12);
const SPRING = new Date(2027, 3, 20, 12);
const NEW_YEAR = new Date(2026, 11, 31, 23, 30);
mock.timers.enable({ apis: ["Date"], now: WINTER.getTime() });

installFakeDom();

const { afterLeaving, shownOutfit, tryingOn, wardrobeLine } = await import("../src/core/wardrobe.ts");
const { VIEW_LAYOUTS, botPosition } = await import("../src/core/layout.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { setLanguage } = await import("../src/i18n/i18n.ts");
const { OUTFIT_CHOICES } = await import("../src/robot/outfits.ts");
const { buildWardrobe } = await import("../src/views/wardrobe.ts");

const IDS = ["auto", "none", "glasses", "scarf", "headphones", "beanie", "star"];

// ── The logic ─────────────────────────────────────────────────────────────────

test("the chip under the pointer is tried on: Auto as what the season picks that day", () => {
  assert.equal(tryingOn(null, WINTER), null, "no chip: nothing is tried on");
  for (const id of IDS.slice(1)) assert.equal(tryingOn(id, WINTER), id);
  assert.equal(tryingOn("none", WINTER), "none", "Nothing takes off what Liv wears, for as long as it is hovered");
  assert.equal(tryingOn("auto", WINTER), "scarf");
  assert.equal(tryingOn("auto", SPRING), "none");
  assert.equal(tryingOn("auto", NEW_YEAR), "star");
});

test("leaving a chip ends the try — unless the pointer is already on another", () => {
  assert.equal(afterLeaving("scarf", "scarf"), null);
  assert.equal(afterLeaving("beanie", "scarf"), "beanie", "it went straight from the scarf to the beanie");
  assert.equal(afterLeaving(null, "scarf"), null);
});

test("Liv shows what it tries on, else what the kept choice has it wear that day", () => {
  assert.equal(shownOutfit("glasses", null, WINTER), "glasses");
  assert.equal(shownOutfit("glasses", "beanie", WINTER), "beanie");
  assert.equal(shownOutfit("glasses", "none", WINTER), "none", "trying nothing on is not the same as trying nothing");
  assert.equal(shownOutfit("auto", null, WINTER), "scarf");
  assert.equal(shownOutfit("auto", null, SPRING), "none");
  assert.equal(shownOutfit("auto", "star", SPRING), "star");
  assert.equal(shownOutfit("none", null, WINTER), "none");
});

test("under the chips: with Auto kept, what the season picked today; else where a choice does not show", () => {
  assert.equal(wardrobeLine("auto", WINTER), "Auto: today Liv wears the scarf.");
  assert.equal(wardrobeLine("auto", SPRING), "Auto: today Liv wears nothing.");
  assert.equal(wardrobeLine("auto", NEW_YEAR), "Auto: today Liv wears the star.");
  for (const id of IDS.slice(1)) assert.equal(wardrobeLine(id, WINTER), "With the island folded, only the star fits.");
});

// ── The card ──────────────────────────────────────────────────────────────────

const did = [];
const view = buildWardrobe({
  previewOutfit: (outfit) => {
    did.push(["try", outfit]);
    State.outfitPreview = outfit;
  },
  chooseOutfit: (choice) => {
    did.push(["keep", choice]);
    State.settings.livOutfit = choice;
  },
});
const chips = view.el.find(".picker-chip");
const chip = (id) => chips[IDS.indexOf(id)];
const marked = () => chips.filter((c) => c.classList.contains("on")).map((c) => IDS[chips.indexOf(c)]);
const line = () => view.el.find(".sub")[0].textContent;

beforeEach(() => {
  mock.timers.setTime(WINTER.getTime());
  setLanguage("en");
  State.settings = { ...DEFAULT_SETTINGS };
  State.outfitPreview = null;
  State.mode = "expanded";
  State.view = "wardrobe";
  // Whatever chip the last test left the pointer on.
  for (const c of chips) c.fire("mouseleave");
  did.length = 0;
  view.sync();
});

test("the card: a title, a chip for Auto, Nothing and each accessory, in the cards' own frame and classes", () => {
  assert.deepEqual(OUTFIT_CHOICES.map((c) => c.id), IDS);
  assert.equal(chips.length, 7);
  assert.deepEqual(chips.map((c) => c.textContent), ["Auto", "Nothing", "Glasses", "Scarf", "Headphones", "Beanie", "Star"]);
  assert.ok(chips.every((c) => c.tagName === "BUTTON" && c.parentNode.classList.contains("picker-chips")));
  assert.equal(view.el.find(".title")[0].textContent, "Wardrobe");
  assert.ok(view.el.classList.contains("view") && view.el.firstElementChild.classList.contains("card"));
  // The same inset as the other cards, which leaves Liv its room on the left; and their height.
  const stack = view.el.find(".stack")[0];
  assert.equal(stack.style.padding, "4px 16px 4px 116px");
  assert.deepEqual(VIEW_LAYOUTS.wardrobe, { height: 160, botX: 62, botY: null, botDiameter: 58 });
  assert.deepEqual(VIEW_LAYOUTS.wardrobe, VIEW_LAYOUTS.update);
  assert.deepEqual(botPosition("expanded", "wardrobe", 160), botPosition("expanded", "update", 160));
  // In Spanish, relabelled in place.
  setLanguage("es");
  view.sync();
  assert.deepEqual(chips.map((c) => c.textContent), ["Auto", "Nada", "Gafas", "Bufanda", "Auriculares", "Gorro", "Estrella"]);
  assert.equal(view.el.find(".title")[0].textContent, "Vestuario");
  assert.equal(line(), "Auto: hoy Liv lleva la bufanda.");
});

test("the kept choice is the one marked, and the line under the chips follows it and the day", () => {
  assert.deepEqual(marked(), ["auto"]);
  assert.equal(chip("auto").getAttribute("aria-pressed"), "true");
  assert.equal(chip("scarf").getAttribute("aria-pressed"), "false");
  assert.equal(line(), "Auto: today Liv wears the scarf.");
  // Another day, the card drawn again.
  mock.timers.setTime(SPRING.getTime());
  view.sync();
  assert.equal(line(), "Auto: today Liv wears nothing.");
  State.settings.livOutfit = "headphones";
  view.sync();
  assert.deepEqual(marked(), ["headphones"]);
  assert.equal(line(), "With the island folded, only the star fits.");
  // A word a newer build wrote: Auto.
  State.settings.livOutfit = "cape";
  view.sync();
  assert.deepEqual(marked(), ["auto"]);
});

test("the pointer on a chip tries it on at once; leaving puts back what Liv wears", () => {
  chip("beanie").fire("mouseenter");
  assert.deepEqual(did, [["try", "beanie"]]);
  chip("beanie").fire("mouseleave");
  assert.deepEqual(did, [["try", "beanie"], ["try", null]]);
  // Nothing was kept.
  assert.equal(State.settings.livOutfit, "auto");
  assert.deepEqual(marked(), ["auto"]);

  // Auto is tried on as today's pick; Nothing as nothing.
  did.length = 0;
  State.settings.livOutfit = "glasses";
  chip("auto").fire("mouseenter");
  chip("auto").fire("mouseleave");
  chip("none").fire("mouseenter");
  assert.deepEqual(did, [["try", "scarf"], ["try", null], ["try", "none"]]);
});

test("from one chip straight to the next: the last one hovered is what Liv has on", () => {
  chip("glasses").fire("mouseenter");
  chip("glasses").fire("mouseleave");
  chip("scarf").fire("mouseenter");
  assert.deepEqual(did.at(-1), ["try", "scarf"]);
  // The events the other way round: leaving the first chip does not undress the second.
  chip("star").fire("mouseenter");
  chip("scarf").fire("mouseleave");
  assert.deepEqual(did.at(-1), ["try", "star"]);
  chip("star").fire("mouseleave");
  assert.deepEqual(did.at(-1), ["try", null]);
});

test("a click keeps the chip's choice — Auto as Auto, not as today's pick — and marks it", () => {
  chip("headphones").fire("mouseenter");
  chip("headphones").fire("click");
  assert.deepEqual(did, [["try", "headphones"], ["keep", "headphones"]]);
  view.sync();
  assert.deepEqual(marked(), ["headphones"]);
  // Leaving after the click: Liv goes back to what it wears, which is now this.
  chip("headphones").fire("mouseleave");
  assert.deepEqual(did.at(-1), ["try", null]);
  assert.equal(State.settings.livOutfit, "headphones");

  did.length = 0;
  chip("auto").fire("mouseenter");
  chip("auto").fire("click");
  assert.deepEqual(did, [["try", "scarf"], ["keep", "auto"]]);
  view.sync();
  assert.deepEqual(marked(), ["auto"]);
  assert.equal(line(), "Auto: today Liv wears the scarf.");
});

test("a try never outlives the card: folded or on another view, Liv is back in what it wears", () => {
  chip("beanie").fire("mouseenter");
  assert.equal(State.outfitPreview, "beanie");
  // The island folds under the pointer: no chip is ever left.
  State.mode = "compact";
  State.notify();
  assert.equal(State.outfitPreview, null);
  // Back on the card, with the pointer elsewhere: a chip left long ago changes nothing.
  State.mode = "expanded";
  State.notify();
  did.length = 0;
  chip("beanie").fire("mouseleave");
  assert.deepEqual(did, [["try", null]]);
  assert.equal(State.outfitPreview, null);

  chip("star").fire("mouseenter");
  State.view = "overview";
  State.notify();
  assert.equal(State.outfitPreview, null);
});
