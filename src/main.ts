// Entry point: boot the bridge, wire the island, show it.

import { registerDownloadHandlers } from "./island/downloads";
import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { guardPage } from "./core/guards";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { officeSettingsChanged, registerOfficeHandlers } from "./island/office";
import { registerShortcutHandlers } from "./island/shortcuts";
import { applySpotify, registerSpotifyHandlers } from "./island/spotify";
import { loadClipboard, loadShelf, registerToolsHandlers } from "./island/tools";
import { SPOTIFY_ID } from "./core/spotify";
import { Recap } from "./recap/recap";
import { Updates } from "./island/update";
import { WhatsNew } from "./whats-new/controller";
import { onLanguageChange, resolveLanguage, setLanguage, systemLanguages } from "./i18n/i18n";

/** Shows the language Settings asks for ("" = the system's, when Liv has it). */
function applyLanguage() {
  setLanguage(resolveLanguage(State.settings.language, systemLanguages()));
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;
  // Before anything else: a reload of this page would lose the tasks and the
  // cards agents are waiting on.
  guardPage(window);

  void Sound.preload();

  // Before the island exists: its canvases size their bitmaps from the pixel
  // ratio once, so the zoom correction has to land first. If zoom was adjusted,
  // wait until the ratio updates (or up to 500ms) so nothing is sized against
  // the stale value.
  const dprBefore = window.devicePixelRatio || 1;
  const zoomChanged = await Bridge.fitZoom(dprBefore);
  if (zoomChanged) {
    for (let i = 0; i < 20 && window.devicePixelRatio === dprBefore; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const island = new Island(root);
  // The dev previews (dev/*.html) drive the island from the console.
  if (import.meta.env.DEV) Object.assign(window, { __island: island, __state: State });

  // Another app went full screen on the island's display, or left it. Listened
  // to before Rust is asked where things stand, so nothing said in between is
  // lost; what Rust says at boot counts only if no event came after it.
  let parkedHeard = false;
  await onEvent<boolean>("island-parked", (parked) => {
    parkedHeard = true;
    island.setParked(parked);
  });

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
    if (!parkedHeard) island.setParked(boot.parked);
  }
  // A language change redraws the island in place: the texts given as tl(…)
  // relabel themselves (views/dom.ts) and the views redraw the rest on this
  // sync. Nothing is rebuilt, so tasks, steps and the chat stay as they are.
  onLanguageChange(() => State.notify());
  applyLanguage();
  // Rust shows the tray and its errors in the same language as the webview.
  void Bridge.setSystemLanguages(systemLanguages());
  island.applySettings();
  State.loadIntegrationTasks();
  if (boot && !boot.cursorPoll) island.followPageCursor();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));
  await onEvent<boolean>("pointer-inside", (inside) => island.setPointerInside(inside));
  await onEvent<null>("closed-hover", () => island.wakeFromClosed());

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      // "Open Liv": the island, on what it has to show. ("Settings…" opens the
      // Liv window, in Rust: tray.rs.)
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "recap":
        setPaused(false);
        void Recap.open(island);
        break;
      // "Update Liv to X…", only in the menu while a new version is out.
      case "update":
        setPaused(false);
        Updates.show();
        break;
      // "Wardrobe…": what Liv wears.
      case "wardrobe":
        setPaused(false);
        island.openWardrobe();
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  const checkZoom = async () => {
    const dpr = window.devicePixelRatio || 1;
    await Bridge.fitZoom(dpr);
  };

  await onEvent<null>("screen-changed", async () => {
    await checkZoom();
    void Bridge.reposition();
    island.ensureRunning();
  });

  // A query only matches the ratio it was made for: once it changes, watch the
  // new one, or the next monitor's scale goes unnoticed and the zoom stays wrong.
  // One frame redraws Liv at the new ratio, even while the loop is idle.
  const watchRatio = () => {
    window
      .matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      .addEventListener?.("change", () => {
        watchRatio();
        void checkZoom();
        island.ensureRunning();
      }, { once: true });
  };
  watchRatio();
  // The ratio may have moved between the check at the top and this watch (the
  // webview applies a zoom a moment after it is asked to): look once more.
  void checkZoom();

  // Settings → Reload sounds: read the sounds folder again, and let them hear it.
  await onEvent<null>("sounds-changed", () => {
    void Sound.reload().then(() => Sound.play("pop"));
  });

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    const previousMain = State.mainPillId;
    State.settings = { ...State.settings, ...s };
    applyLanguage();
    island.applySettings();
    State.loadIntegrationTasks();
    // A new main tool comes to the front, as on macOS.
    if (State.mainPillId !== previousMain) State.setFocus(State.mainPillId);
    officeSettingsChanged();
    void refreshConfigured();
  });

  // Settings → Appearance while one of its sliders is dragged: the open
  // island's shape as it is now, before it is saved (lib.rs: preview_appearance).
  // The island opens to show it.
  await onEvent<Partial<Settings>>("island-appearance", (shape) => {
    State.settings = { ...State.settings, ...shape };
    island.previewAppearance();
  });

  registerHookHandlers(island);
  registerIntegrationHandlers(island);
  registerOfficeHandlers(island);
  registerShortcutHandlers(island, () => setPaused(false));
  registerSpotifyHandlers(island);
  registerToolsHandlers(island);
  registerDownloadHandlers(island);
  // New versions: Rust offers the card, the island opens it when nothing else waits.
  await Updates.register(island);
  // Rust may have read Spotify before this page listened: ask once.
  if (State.settings.activeIntegrations.includes(SPOTIFY_ID)) {
    void Bridge.spotifyRefresh().then((s) => s && applySpotify(island, s));
  }
  // The same for the clipboard's history: what was copied before this page listened.
  void loadClipboard();
  // And the shelf, as it was left.
  void loadShelf();

  // Monday recap: app start (the island waking below), an agent starting work, waking up.
  const checkRecap = () => void Recap.check(island);
  // What's new, once after an update: a few seconds in (the card waits for a
  // quiet island).
  window.setTimeout(() => void WhatsNew.launch(island), 8000);
  island.onWake = checkRecap;
  await onEvent<null>("recap-check", checkRecap);

  // Liv on the desktop: its window, when Rust could make one (pet.rs).
  await island.pet.init(boot?.pet === true);

  // At launch Liv pops out of the island and waves — from its spot on the
  // desktop when that is where it lives; started with the computer the island
  // only shows itself compact (Island.appear).
  island.appear(boot?.atLogin === true);

  // In a plain browser nothing has resumed the audio context yet: the first
  // click does, so the sounds can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
