// Where the island opens again, and how soon it closes: the section it was
// folded on is the one a click or a hover brings back, and the compact island
// closes after the delay chosen in Settings → General. No DOM here.

import type { IslandViewName } from "./layout";

/**
 * The views that are sections of their own — a tab of the header, or the
 * quick settings: places the user goes to and stays in. The cards of an
 * alert (a permission, a finished task, a note, what's new) are not: they
 * come up for what happened and are gone with it.
 */
const SECTIONS: ReadonlySet<IslandViewName> = new Set(["prompt", "upload", "launch", "tools", "settings"]);

/** What to remember of `view` as the island folds: itself if it is a section, else nothing. */
export function sectionToRemember(view: IslandViewName): IslandViewName | null {
  return SECTIONS.has(view) ? view : null;
}

/**
 * What the island opens on: the section it was folded on, else `usual` (the
 * overview). A card waiting for an answer always comes first.
 */
export function reopensOn(remembered: IslandViewName | null, usual: IslandViewName, waiting: boolean): IslandViewName {
  return waiting || remembered == null ? usual : remembered;
}

/** The choices of Settings → General for how long the compact island stays, seconds; 0 is "at once". */
export const COMPACT_CLOSE_CHOICES: readonly number[] = [0, 5, 15, 30, 60, 300];
export const DEFAULT_COMPACT_CLOSE = 60;

/** The delay in force for a saved value: itself within 0…10 minutes, else the default. */
export function compactCloseDelay(saved: unknown): number {
  return typeof saved === "number" && Number.isFinite(saved) && saved >= 0 && saved <= 600 ? saved : DEFAULT_COMPACT_CLOSE;
}
