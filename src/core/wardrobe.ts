// The wardrobe card (views/wardrobe.ts), without its DOM: what Liv tries on
// while the pointer is on a chip, what it goes back to, and the line under
// the chips. The choice that is kept is the setting itself (`livOutfit`);
// all the card holds is the chip under the pointer.

import { N_ } from "../i18n/i18n";
import { autoLine, wornOutfit, type Outfit, type OutfitChoice } from "../robot/outfits";

/** The chip under the pointer; null while it is on none. */
export type Hovered = OutfitChoice | null;

/**
 * The pointer left `chip`. Nothing is hovered any more — unless the pointer
 * is already on another chip, whose turn came first.
 */
export function afterLeaving(hovered: Hovered, chip: OutfitChoice): Hovered {
  return hovered === chip ? null : hovered;
}

/**
 * What Liv tries on: what the hovered chip would have it wear on `date`
 * ("Auto" is the season's pick, which may be nothing). Null with no chip
 * hovered: Liv goes back to what it wears.
 */
export function tryingOn(hovered: Hovered, date: Date): Outfit | null {
  return hovered == null ? null : wornOutfit(hovered, date);
}

/** What Liv shows: what it is trying on, else what the kept choice has it wear on `date`. */
export function shownOutfit(kept: OutfitChoice, trying: Outfit | null, date: Date): Outfit {
  return trying ?? wornOutfit(kept, date);
}

/** Under the chips while a choice of the user's own is kept: where it does not show. */
const FOLDED_NOTE = N_("With the island folded, only the star fits.");

/**
 * The line under the chips (an English key): with "Auto" kept, what the
 * season picked today; otherwise that the folded island is too small for
 * anything but the star.
 */
export function wardrobeLine(kept: OutfitChoice, date: Date): string {
  return kept === "auto" ? autoLine(date) : FOLDED_NOTE;
}
