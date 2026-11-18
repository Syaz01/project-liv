// A virtual office's events → its pill. The office is another program (a team
// of agents working on its own) that tells Liv what happens through
// `liv-hook office`; Rust passes each event on as `office` (pipe.rs). What an
// event means is core/office.ts; here it meets the island: the pill, Liv,
// the badge, and the same alert rules as an agent's (hooks.ts).
//
// Liv only listens: nothing is ever sent back to the office, nothing it sends
// can approve, run or open anything, and nothing is kept on disk. No timer
// either — an agent gone quiet is noticed when the island next draws.

import { Bridge, onEvent } from "../core/bridge";
import {
  OFFICE_PILL_ID, applyOfficeEvent, officeBadge, officeCard, officeBotState, officeEffect, officeSeen,
  parseOfficeEvent, safeUrl, type OfficeCard, type OfficeState,
} from "../core/office";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { t } from "../i18n/i18n";
import { restoreAlertFocus, showsAlert, surfaceIsland } from "./hooks";
import type { Island } from "./island";

/** The office as its events have described it; null until the first one, and after `reset`. */
let office: OfficeState | null = null;

/** What the office's card shows right now (views/office.ts). */
export function currentOfficeCard(): OfficeCard {
  return officeCard(office, State.settings.officeUrl, Date.now());
}

/**
 * Opens an address of the office's in the browser — only ever from a click,
 * and only an http or https one: checked here again, whatever was checked when
 * the event came in, and once more by Rust (`open_url`).
 */
export function openOfficeUrl(url: string | null) {
  const safe = safeUrl(url);
  if (safe) void Bridge.openUrl(safe);
}

export function registerOfficeHandlers(island: Island) {
  void onEvent<unknown>("office", (payload) => handleOffice(island, payload));
  State.subscribe(syncPill);
  syncPill();
}

/**
 * Keeps the pill in step with the office — its name, Liv's state while it
 * is in front, its badge while it is not. Runs whenever the state changes, so
 * it also follows the language, a pill declared in Settings, and the clock (an
 * agent gone quiet no longer counts as working the next time anything moves).
 */
function syncPill() {
  const pill = State.tasks.find((x) => x.id === OFFICE_PILL_ID);
  if (!pill) return;
  const focused = State.focusId === OFFICE_PILL_ID;
  if (focused) office = officeSeen(office);
  pill.name = office?.name ?? t("Office");
  pill.state = officeBotState(office, Date.now());
  pill.pillBadge = focused ? null : officeBadge(office);
  // Its one step says an office is there: a pill with steps is in the middle
  // of something and stays through a change of settings, declared or not
  // (State.loadIntegrationTasks).
  pill.steps = office ? [office.id] : [];
  pill.stepIndex = 0;
}

function handleOffice(island: Island, payload: unknown) {
  // Rust drops the events of an office that is switched off; so does a page
  // without Rust behind it (the browser preview).
  if (!State.settings.officeEnabled) return;
  const event = parseOfficeEvent(payload);
  if (!event) return;

  // What is new, and so worth an alert, is judged against the office as it
  // was. A paused island takes the event in and stays quiet.
  const effect = State.paused ? null : officeEffect(office, event);
  office = applyOfficeEvent(office, event, Date.now());
  if (!office) {
    forgetOffice();
    return;
  }
  // The pill comes with the first event, next to the main one; declared in
  // Settings it is already there.
  State.upsertWorkspacePill(OFFICE_PILL_ID, office.name ?? t("Office"), "");

  if (effect) {
    if (effect.sound) Sound.play(effect.sound);
    // Something waits for the user: like a permission card, it opens the
    // island from any pill (the office's borrows the front until the island
    // closes) — but never over a card waiting for an answer, nor over what is
    // being typed. Then the badge says it all; syncPill sets it.
    if (effect.action === "open") {
      if (showsAlert(OFFICE_PILL_ID, State.focusId === OFFICE_PILL_ID, true)) surfaceIsland(island, "overview", true);
    } else if (effect.action === "peek" && !popsOut(island, effect.badge === "error" ? "error" : "finished")) {
      surfaceIsland(island, "overview", false);
    }
  }
  State.notify();
}

/**
 * The office has good or bad news: on a folded island Liv pops out in its
 * pocket in the news' colours, and a click on it opens the office's card —
 * under the rule of an agent's alert (showsAlert): the office's pill in
 * front, or "alerts from all pills" on, and never over a card that waits.
 * False when Liv stays in: the island then only shows itself compact, as it
 * always did, and the badge says the rest.
 */
function popsOut(island: Island, look: "finished" | "error"): boolean {
  if (State.mode === "expanded") return false;
  if (!showsAlert(OFFICE_PILL_ID, State.focusId === OFFICE_PILL_ID)) return false;
  if (island.peek(look, "overview")) return true;
  // The island is parked off-screen: nothing came out, so nothing keeps the front.
  restoreAlertFocus();
  return false;
}

/** The office closed, or was switched off: a pill declared in Settings stays, idle; any other goes. */
function forgetOffice() {
  office = null;
  // An alert of the office's may have borrowed the front: the pill you were on comes back.
  if (State.focusId === OFFICE_PILL_ID) restoreAlertFocus();
  State.removeTask(OFFICE_PILL_ID);
}

/** Settings changed: an office that was switched off is forgotten at once. */
export function officeSettingsChanged() {
  if (!State.settings.officeEnabled && office) forgetOffice();
}
