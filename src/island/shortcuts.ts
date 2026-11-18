// Keyboard shortcuts → island. Port of IslandWindowController.handleHotKey and
// handleIslandKey from the macOS app.
//
// Global shortcuts are caught by Rust and arrive as a `shortcut` event with
// the action id. The in-island keys are read here, while the
// island has the keyboard: it takes it for the chat, and when a global
// shortcut opens it.

import { Bridge, onEvent } from "../core/bridge";
import type { IslandViewName } from "../core/layout";
import { cyclePill, islandKeyAction, navigate, pillByNumber, type IslandKeyAction } from "../core/shortcuts";
import { Sound } from "../core/sound";
import { State } from "../core/state";

const CLAUDE_DESKTOP_ID = "agent_claude-desktop";

/** What the shortcuts need from the island. */
export interface ShortcutHost {
  alert(view: IslandViewName): void;
  setView(view: IslandViewName): void;
  collapse(): void;
  setPinned(on: boolean): void;
  /** Gives the island the keyboard, so the in-island keys work (Mac: makeKey). */
  takeKeyboard(): void;
  /** Hands Ctrl+O / Ctrl+E to the view on screen (the Mac posts notifications). */
  viewCommand(command: ViewCommand): void;
  /** Sends Liv out to the desktop, or calls it home (pet/outing.ts). */
  livOutOrHome(): void;
  /** Opens Liv's wardrobe, or goes back to the usual view when it is the one open. */
  toggleWardrobe(): void;
  /** Opens the island on the tools (the clipboard's history), or folds it when they are what it shows. */
  toggleTools(): void;
}

/** What the open view is asked to do: open the highlighted item, toggle the diff. */
export type ViewCommand = "openSelection" | "toggleDiff";

function focusPill(host: ShortcutHost, id: string | null, open: boolean) {
  if (!id) return;
  State.setFocus(id);
  State.cardSelection = null;
  Sound.play("blip");
  if (open) host.alert("overview");
  else host.setView("overview");
}

/** A global shortcut was pressed. `resume` lifts Pause, as the tray's Open does. */
export function runGlobalShortcut(host: ShortcutHost, action: string, resume: () => void) {
  switch (action) {
    case "toggleIsland":
      if (State.mode === "expanded") {
        host.collapse();
      } else {
        resume();
        // A waiting card is what the island opens on (State.defaultView).
        host.alert(State.defaultView());
        host.takeKeyboard();
      }
      break;

    case "openChat":
      resume();
      host.alert("prompt");
      break;

    case "goToAlert": {
      const asking = State.tasks.find((t) => t.state === "question");
      const pending = State.pendingApproval;
      if (pending) {
        // The one card every agent's request uses: its own pill to the front,
        // its card (permission or question) up. Nothing is answered from here.
        resume();
        State.setFocus(pending.pillId);
        host.alert(pending.questions ? "question" : "approval");
        host.takeKeyboard();
      } else if (asking) {
        resume();
        State.setFocus(asking.id);
        host.alert("question");
        host.takeKeyboard();
      } else {
        // Nothing is waiting: the error sound says so.
        Sound.play("error");
      }
      break;
    }

    // The Mac brings the terminal app forward; here it is the existing "Open
    // terminal": the session's own window when it was found, else its folder
    // in VS Code; the Claude app for a Claude Desktop session.
    case "jumpToTerminal": {
      const task = State.focusTask;
      if (task?.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
      else void Bridge.openSession(task?.sessionId ?? null, task?.sessionCwd ?? null);
      if (State.mode === "expanded") host.collapse();
      break;
    }

    case "nextPill":
    case "prevPill":
      resume();
      focusPill(
        host,
        cyclePill(State.tasks.map((t) => t.id), State.focusTask?.id ?? null, action === "nextPill" ? 1 : -1),
        true,
      );
      break;

    case "muteToggle": {
      const on = !State.settings.soundEnabled;
      State.settings.soundEnabled = on;
      Sound.setEnabled(on);
      void Bridge.saveSettings(State.settings);
      if (on) Sound.play("tick");
      State.notify();
      break;
    }

    // Liv out to its spot on the desktop, or home. Like the other shortcuts
    // it lifts Pause: paused, Liv is nowhere to be seen.
    case "desktopToggle":
      resume();
      host.livOutOrHome();
      break;

    // Liv's wardrobe. Opened from the keyboard, the island takes it: Esc folds.
    case "wardrobeToggle":
      resume();
      host.toggleWardrobe();
      host.takeKeyboard();
      break;

    // The tools: what was copied, a click away from where the user types.
    // Opened from the keyboard, the island takes it: Esc folds. A click on an
    // entry hands the keyboard back before it pastes (src-tauri/src/clipboard.rs).
    case "toolsToggle":
      resume();
      host.toggleTools();
      if (State.mode === "expanded") host.takeKeyboard();
      break;

    // A screenshot (src-tauri/src/capture.rs): taken whatever the island is
    // doing, paused or not — nothing is resumed, opened or focused for it.
    // When it is saved the island hears `capture` (island/tools.ts) and shows
    // it on the shelf, where an alert may take the screen.
    case "captureArea":
      // An open island would sit on what is being chosen: it folds first, as
      // it does for the button on its shelf.
      if (State.mode === "expanded") host.collapse();
      void Bridge.captureArea();
      break;
    case "captureScreen":
      void Bridge.captureScreen();
      break;

    default:
      break;
  }
}

/** A key the island acts on while it has the keyboard. */
export function runIslandKey(host: ShortcutHost, action: IslandKeyAction) {
  const ids = State.tasks.map((t) => t.id);
  switch (action.kind) {
    case "cycle":
      focusPill(host, cyclePill(ids, State.focusTask?.id ?? null, action.delta), false);
      break;
    case "pill":
      focusPill(host, pillByNumber(ids, action.number), false);
      break;
    case "list":
      // Only a card with a list counts its items: the GitHub lists, as on the Mac.
      if (State.view !== "overview" || State.cardItemCount <= 0) return;
      State.cardSelection = navigate(State.cardSelection, action.delta, State.cardItemCount);
      State.notify();
      break;
    case "openSelection":
      if (State.cardSelection == null) return;
      host.viewCommand("openSelection");
      break;
    case "diff":
      host.viewCommand("toggleDiff");
      break;
    case "newChat":
      // Not while an answer is on its way: it would land in the new chat.
      if (State.stateOverride === "thinking") return;
      State.chatHistory = [];
      State.droppedFile = null;
      void Bridge.chatReset();
      Sound.play("blip");
      host.setView("prompt");
      break;
    case "settings":
      void Bridge.openSettingsWindow();
      break;
    case "pin":
      // A permission card keeps the island pinned until it is answered.
      if (State.pendingApproval) return;
      host.setPinned(!State.isPinned);
      break;
  }
}

function inTextField(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable === true;
}

export function registerShortcutHandlers(host: ShortcutHost, resume: () => void) {
  void onEvent<string>("shortcut", (action) => runGlobalShortcut(host, action, resume));

  // Capture phase: the chat field stops its own key events from bubbling.
  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (State.mode !== "expanded") return;
      const action = islandKeyAction(e, { view: State.view, inTextField: inTextField(e.target) });
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      runIslandKey(host, action);
    },
    true,
  );
}
