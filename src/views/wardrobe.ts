// The wardrobe card: Liv on the left in what it is trying on, and on the
// right a chip for "Auto" (the season picks), for "Nothing" and for each thing
// it can wear, the one kept marked. The pointer on a chip tries it on Liv at
// once, in the island and out on the desktop; leaving the chip puts back what
// Liv wears; a click keeps it. Same left inset as the other cards.

import { h } from "./dom";
import { State } from "../core/state";
import { afterLeaving, tryingOn, wardrobeLine, type Hovered } from "../core/wardrobe";
import { rgba } from "../robot/look";
import { CORAL, OUTFIT_CHOICES, outfitChoice } from "../robot/outfits";
import type { ViewActions, ViewHost } from "./views";
import { t, tl } from "../i18n/i18n";

export function buildWardrobe(actions: ViewActions): ViewHost {
  let hovered: Hovered = null;
  const tryOn = () => actions.previewOutfit(tryingOn(hovered, new Date()));

  const chips = OUTFIT_CHOICES.map((choice) => {
    // The chips of the chat's model picker, marked in the wardrobe's own coral.
    const el = h("button", { class: "picker-chip", style: `--accent:${rgba(CORAL)}`, text: tl(choice.name) });
    el.addEventListener("mouseenter", () => {
      hovered = choice.id;
      tryOn();
    });
    el.addEventListener("mouseleave", () => {
      hovered = afterLeaving(hovered, choice.id);
      tryOn();
    });
    el.addEventListener("click", () => actions.chooseOutfit(choice.id));
    return { id: choice.id, el };
  });

  const line = h("div", { class: "sub" });
  const stack = h(
    "div",
    { class: "stack" },
    h("div", { class: "title one-line", text: tl("Wardrobe") }),
    h("div", { class: "picker-chips" }, ...chips.map((chip) => chip.el)),
    line,
  );
  stack.style.padding = "4px 16px 4px 116px";
  const el = h("div", { class: "view" }, h("div", { class: "card" }, stack));

  // Off screen nothing is being tried on: the card comes back with Liv as it is.
  State.subscribe(() => {
    if (State.mode === "expanded" && State.view === "wardrobe") return;
    hovered = null;
    State.outfitPreview = null;
  });

  return {
    el,
    sync() {
      const kept = outfitChoice(State.settings.livOutfit);
      for (const chip of chips) {
        chip.el.classList.toggle("on", chip.id === kept);
        chip.el.setAttribute("aria-pressed", String(chip.id === kept));
      }
      line.textContent = t(wardrobeLine(kept, new Date()));
    },
  };
}
