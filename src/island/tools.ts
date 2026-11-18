// The clipboard's history, the shelf and the screenshots → the page
// (src-tauri/src/clipboard.rs, shelf.rs, capture.rs). Rust sends each list
// whole on every change; the page keeps its copy (core/tools.ts) and the
// Tools view draws it.
//
// A copy made somewhere else, or a file put on the shelf, is no news for the
// island: a list coming in shows nothing, plays nothing, and wakes nothing.
// Only a Tools view that is on screen is drawn again. A screenshot is the one
// thing that opens the island — it was asked for — and only where an alert
// may take the screen (core/alerts.ts), without a sound.

import { Bridge, onEvent } from "../core/bridge";
import type { IslandViewName } from "../core/layout";
import { State } from "../core/state";
import {
  CAPTURE_NOTE_MS, FRESH_MS, Tools, captureOpensIsland, captureResult, clipEntries, shelfItems,
} from "../core/tools";

/** What a screenshot needs from the island: to open it on a view, as an alert does. */
export interface ToolsHost {
  alert(view: IslandViewName): void;
}

/** The Tools view is what the open island shows. */
function toolsOnScreen(): boolean {
  return State.mode === "expanded" && State.view === "tools";
}

/** A list from Rust (or its answer at startup). */
export function applyClipboard(list: unknown) {
  Tools.clipboard = clipEntries(list);
  // Off screen the view reads the list when it next comes up: telling the
  // island now would start its frame loop for something nobody sees.
  if (toolsOnScreen()) State.notify();
}

/** The shelf as Rust has it now. */
export function applyShelf(list: unknown) {
  Tools.shelf = shelfItems(list);
  if (toolsOnScreen()) State.notify();
}

/** A list came as an event: it is newer than any answer still on its way. */
let heard = false;
/** How many times the shelf came as an event: an answer asked for before the last of them is older. */
let shelfHeard = 0;

/** The timers that end what a screenshot shows for a moment. */
let freshTimer: number | null = null;
let failedTimer: number | null = null;

/** A screenshot was taken, or could not be. */
function onCapture(host: ToolsHost | undefined, raw: unknown) {
  const result = captureResult(raw);
  if (!result) return;
  if (result.ok) {
    // Its item on the shelf is lit for a moment (the list came just before).
    if (freshTimer != null) window.clearTimeout(freshTimer);
    Tools.fresh = result.id;
    freshTimer = window.setTimeout(() => {
      freshTimer = null;
      Tools.fresh = null;
      if (toolsOnScreen()) State.notify();
    }, FRESH_MS);
  } else {
    if (failedTimer != null) window.clearTimeout(failedTimer);
    Tools.captureFailed = true;
    failedTimer = window.setTimeout(() => {
      failedTimer = null;
      Tools.captureFailed = false;
      if (toolsOnScreen()) State.notify();
    }, CAPTURE_NOTE_MS);
  }
  if (toolsOnScreen()) {
    State.notify();
    return;
  }
  const opens = captureOpensIsland({
    paused: State.paused,
    parked: State.parked,
    cardWaiting: State.pendingApproval != null,
    expanded: State.mode === "expanded",
    view: State.view,
  });
  if (host && opens) host.alert("tools");
}

/** `host` is the island; without one a screenshot only leaves its mark on the shelf. */
export function registerToolsHandlers(host?: ToolsHost) {
  void onEvent<unknown>("clipboard-history", (list) => {
    heard = true;
    applyClipboard(list);
  });
  void onEvent<unknown>("shelf", (list) => {
    shelfHeard++;
    applyShelf(list);
  });
  void onEvent<unknown>("capture", (result) => onCapture(host, result));

  // The tools come on screen: the shelf is asked for again. Rust looks at the
  // files as it answers, so one that has gone since shows as missing.
  let wasOn = toolsOnScreen();
  State.subscribe(() => {
    const on = toolsOnScreen();
    if (on && !wasOn) void loadShelf();
    wasOn = on;
  });
}

/** Rust may have recorded copies before this page listened: ask once. */
export async function loadClipboard() {
  if (!State.settings.clipboardHistory) return;
  const list = await Bridge.clipboardHistory();
  if (list && !heard) applyClipboard(list);
}

/** The shelf as it is now: asked as the page starts, and each time the tools come up. */
export async function loadShelf() {
  const asked = shelfHeard;
  const list = await Bridge.shelfList();
  if (list && asked === shelfHeard) applyShelf(list);
}
