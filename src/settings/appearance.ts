// Settings → General → Appearance: the shape of the open island. Four sliders
// — its width, what is added to every view's height, the rounding of its
// corners, the whole island's opacity — each with its value next to it, and
// "Reset", which puts back the inherited island (core/appearance.ts has the
// ranges and brings every value into them).
//
// A slider that moves is followed by the island at once: Rust takes the shape
// without writing it (Bridge.previewAppearance). The settings are written a
// moment after the last move, so a drag across the whole slider is one write.

import {
  APPEARANCE_KEYS, APPEARANCE_RANGES, DEFAULT_APPEARANCE_SETTINGS, appearanceSettings, clampAppearance,
  type AppearanceKey,
} from "../core/appearance";
import { Bridge } from "../core/bridge";
import type { Settings } from "../core/state";
import { h } from "../views/dom";
import { N_, t } from "../i18n/i18n";

/** How long after a slider last moved the settings are written, ms. */
export const APPEARANCE_SAVE_DELAY_MS = 300;

/** The sliders, in the order they are drawn: the setting, its label and its unit. */
const SLIDERS: readonly { key: AppearanceKey; label: string; unit: string }[] = [
  { key: "islandWidth", label: N_("Width"), unit: "px" },
  { key: "islandExtraHeight", label: N_("Extra height"), unit: "px" },
  { key: "islandRadius", label: N_("Corner rounding"), unit: "px" },
  { key: "islandOpacity", label: N_("Opacity"), unit: "%" },
];

/** Room for the longest label in either language, so the four sliders start in line. */
const LABEL_STYLE = "min-width:168px";

export interface AppearanceSection {
  el: HTMLElement;
  /** Shows the sliders as the settings have them, after a change made elsewhere. */
  sync(): void;
}

/**
 * The section. `settings` gives the window's settings as they are now (the
 * sliders write into them); `save` writes them, as every other control of
 * the window does.
 */
export function appearanceSection(settings: () => Settings, save: () => unknown): AppearanceSection {
  let timer: number | null = null;
  const cancelSave = () => {
    if (timer != null) window.clearTimeout(timer);
    timer = null;
  };
  const saveSoon = () => {
    cancelSave();
    timer = window.setTimeout(() => {
      timer = null;
      void save();
    }, APPEARANCE_SAVE_DELAY_MS);
  };
  /** The island takes the shape now, saved or not. */
  const preview = () => void Bridge.previewAppearance(appearanceSettings(settings()));

  const rows = SLIDERS.map(({ key, label, unit }) => {
    const range = APPEARANCE_RANGES[key];
    const slider = h("input", {
      type: "range",
      min: String(range.min),
      max: String(range.max),
      step: String(range.step),
      style: "width:220px",
      "aria-label": t(label),
    }) as HTMLInputElement;
    const value = h("span", { class: "hint" });
    const show = () => {
      const now = clampAppearance(key, settings()[key]);
      value.textContent = `${now} ${unit}`;
      return now;
    };
    slider.addEventListener("input", () => {
      // Whatever the field hands over, the setting is inside its range.
      settings()[key] = clampAppearance(key, Number(slider.value));
      show();
      preview();
      saveSoon();
    });
    return {
      el: h("div", { class: "row" }, h("label", { style: LABEL_STYLE, text: t(label) }), slider, value),
      /** `force`: also a slider that has the focus (Reset moves all four). */
      sync(force: boolean) {
        const now = show();
        // A slider being dragged keeps where the pointer has it.
        if (force || document.activeElement !== slider) slider.value = String(now);
      },
    };
  });

  const sync = (force = false) => {
    for (const row of rows) row.sync(force);
  };
  sync(true);

  const reset = h("button", {
    text: t("Reset"),
    onclick: () => {
      for (const key of APPEARANCE_KEYS) settings()[key] = DEFAULT_APPEARANCE_SETTINGS[key];
      sync(true);
      preview();
      // A click, not a drag: written at once.
      cancelSave();
      void save();
    },
  });

  const el = h(
    "section",
    { "data-anchor": "general.appearance" },
    h("h2", {}, h("span", { text: t("Appearance") })),
    h("div", {
      class: "hint",
      text: t("Island size, in General, makes the whole island bigger. These change the shape of the open island."),
    }),
    ...rows.map((row) => row.el),
    h("div", { class: "row" }, h("label", { style: LABEL_STYLE }), reset),
  );
  return { el, sync: () => sync() };
}
