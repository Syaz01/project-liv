// The open island as its owner shaped it (Settings → General → Appearance):
// how wide it is, how much taller than each view asks for, how round its
// corners are and how opaque the whole island is.
//
// The inherited island — 640 wide, corners of 22, fully opaque — is the
// default of each, so an install nobody touched looks as it always did. This
// module turns what settings.json holds into what the island uses: every
// value brought into its range, the size and the corners of each mode, the
// window Rust gives the page (src-tauri/src/appearance.rs has the same
// numbers; tests/appearance.test.mjs checks the two agree). No DOM here.

import { CLOSED_CORNER, CLOSED_H } from "./closed";
import {
  EXPANDED_CORNER, EXPANDED_W, NOTCH_H, PANEL_H, PANEL_W, ROUNDED_CORNER,
  type IslandMode, type OpenShape,
} from "./layout";

/** The four settings, by the name settings.json gives them. */
export type AppearanceKey = "islandWidth" | "islandExtraHeight" | "islandRadius" | "islandOpacity";

export interface AppearanceRange {
  min: number;
  max: number;
  step: number;
  /** The inherited island's value: what a missing or unusable setting reads as. */
  initial: number;
}

export const APPEARANCE_RANGES: Readonly<Record<AppearanceKey, AppearanceRange>> = {
  /** Width of the open island, page px. */
  islandWidth: { min: EXPANDED_W, max: 960, step: 10, initial: EXPANDED_W },
  /** Added to the height of every open view, page px. */
  islandExtraHeight: { min: 0, max: 160, step: 10, initial: 0 },
  /** Radius of the open island's lower corners, page px. */
  islandRadius: { min: 0, max: 40, step: 1, initial: EXPANDED_CORNER },
  /** Opacity of the whole island, percent. */
  islandOpacity: { min: 40, max: 100, step: 1, initial: 100 },
};

export const APPEARANCE_KEYS = Object.keys(APPEARANCE_RANGES) as AppearanceKey[];

/**
 * A setting as the island uses it: on one of its range's steps, inside the
 * range. Anything that is not a number reads as the inherited value.
 */
export function clampAppearance(key: AppearanceKey, value: unknown): number {
  const { min, max, step, initial } = APPEARANCE_RANGES[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return initial;
  const stepped = min + Math.round((value - min) / step) * step;
  return Math.max(min, Math.min(max, stepped));
}

/** The four settings, each as the island uses it. */
export type AppearanceSettings = Record<AppearanceKey, number>;

/** What the settings hold, each value brought into its range. */
export function appearanceSettings(settings: Partial<Record<AppearanceKey, unknown>> | null | undefined): AppearanceSettings {
  const read = (key: AppearanceKey) => clampAppearance(key, settings?.[key]);
  return {
    islandWidth: read("islandWidth"),
    islandExtraHeight: read("islandExtraHeight"),
    islandRadius: read("islandRadius"),
    islandOpacity: read("islandOpacity"),
  };
}

/** The inherited island: what "Reset" puts back. */
export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = appearanceSettings(null);

/** What the island draws itself with. */
export interface Appearance extends OpenShape {
  /** Radius of the open island's lower corners, and of Liv's pocket. */
  radius: number;
  /** Opacity of the whole island, 0.4 … 1. */
  opacity: number;
}

export function appearance(settings: Partial<Record<AppearanceKey, unknown>> | null | undefined): Appearance {
  const s = appearanceSettings(settings);
  return {
    width: s.islandWidth,
    extraHeight: s.islandExtraHeight,
    radius: s.islandRadius,
    opacity: s.islandOpacity / 100,
  };
}

export const DEFAULT_APPEARANCE: Appearance = appearance(null);

/** The shapes the island takes: open, Liv's pocket, compact (and hidden), closed with something in it. */
export type IslandShape = "expanded" | "peek" | "compact" | "closed";

/**
 * The radius of a shape's lower corners. The open island and Liv's pocket
 * take the setting as it is; the folded shapes keep the proportion they have
 * to the inherited 22 (compact 14, closed 10), and are never rounder than a
 * half circle.
 */
export function cornerRadius(a: Appearance, shape: IslandShape): number {
  const share = a.radius / EXPANDED_CORNER;
  switch (shape) {
    case "expanded":
    case "peek":
      return a.radius;
    case "compact":
      return Math.min(ROUNDED_CORNER * share, NOTCH_H / 2);
    case "closed":
      return Math.min(CLOSED_CORNER * share, CLOSED_H / 2);
  }
}

/** The shape the island has in `mode`; `closedShows`: folded all the way, a closed island stays on screen. */
export function islandShape(mode: IslandMode, closedShows: boolean): IslandShape {
  if (mode === "hidden") return closedShows ? "closed" : "compact";
  return mode;
}

/** The open island's height for a view that asks for `viewHeight`. */
export function openHeight(a: OpenShape, viewHeight: number): number {
  return viewHeight + a.extraHeight;
}

/** Room the window keeps on both sides of the open island together, page px. */
export const PANEL_MARGIN_W = PANEL_W - EXPANDED_W;

/**
 * The window Rust gives the page while the island is not folded away, in page
 * px: the inherited panel, wider by what the island is wider and taller by
 * what it is taller (src-tauri/src/appearance.rs: panel).
 */
export function panelSize(a: OpenShape): { w: number; h: number } {
  return { w: Math.max(PANEL_W, a.width + PANEL_MARGIN_W), h: PANEL_H + a.extraHeight };
}
