// When an alert of a pill — a session that finished or failed, the virtual
// office asking — may take the island's screen. No DOM and no state: the
// island says how things stand, this says whether the alert shows. One rule
// for the agents' hooks (island/hooks.ts) and the office (island/office.ts).

import type { IslandViewName } from "./layout";

/**
 * The views an alert may replace on an open island: the cards that only show
 * how things stand. Every other view holds something the user is doing —
 * typing in the chat or the launch card, the settings, a dropped file, the recap.
 */
const REPLACEABLE: ReadonlySet<IslandViewName> = new Set(["overview", "finished", "error", "empty"]);

export interface AlertScene {
  /** The alert's pill is the one in front. */
  focused: boolean;
  /** The alert waits for the user, as a permission card does (the office asking). */
  waitsForYou: boolean;
  /** Settings → "Open for every pill's alerts". */
  alertsFromAllPills: boolean;
  /** A permission card or a question is waiting for an answer. */
  cardWaiting: boolean;
  /** The island is open. */
  expanded: boolean;
  /** The view it shows, or showed last. */
  view: IslandViewName;
}

/**
 * Whether the alert may take the screen; false leaves it a badge. Never over a
 * card waiting for an answer, and never over what the user is doing in the
 * open island — whichever pill the alert comes from. Past that, the pill in
 * front always shows its alerts; another pill's show when they wait for the
 * user or when "alerts from all pills" is on.
 */
export function alertShows(scene: AlertScene): boolean {
  if (scene.cardWaiting) return false;
  if (scene.expanded && !REPLACEABLE.has(scene.view)) return false;
  return scene.focused || scene.waitsForYou || scene.alertsFromAllPills;
}
