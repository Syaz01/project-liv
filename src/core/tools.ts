// The Tools view (views/tools.ts), without its DOM: the clipboard's history
// as Rust reports it (src-tauri/src/clipboard.rs) and how a row reads — its
// one line, how long ago it was copied, what kind of text it is, and what a
// click on it came to; and the shelf (src-tauri/src/shelf.rs) — how an item
// reads, when a press on it becomes a drag, where a dropped file goes, and
// what a screenshot (src-tauri/src/capture.rs) does to the island.
//
// The history itself lives in Rust, in memory only. The page gets, for a
// text, its first 300 characters and never the whole of it; for an image, a
// small PNG of it. The shelf lives in Rust too: the page names an item by its
// id, and never hands Rust a path that a drop did not just deliver.

import { alertShows } from "./alerts";
import type { IslandViewName } from "./layout";
import { N_, language, t } from "../i18n/i18n";

/** One thing that was copied. */
export interface ClipEntry {
  /** Rust's id for it: what a click sends back, never the text. */
  id: number;
  kind: "text" | "image";
  /** Text: its first 300 characters. */
  preview: string;
  /** Text: how many characters the whole of it has. */
  chars: number;
  /** Image: its size in pixels. */
  width: number;
  height: number;
  /** Image: a PNG data URL of a thumbnail no taller than 96 px; "" when there is none to show. */
  thumb: string;
  /** When it was copied, or put back on the clipboard, last: Unix ms. */
  at: number;
}

/** One file on the shelf: a reference to the file where it is, never a copy. */
export interface ShelfItem {
  /** Rust's id for it: what every click and drag sends back, never the path. */
  id: number;
  /** Where the file is, to be read on the item's tooltip. */
  path: string;
  /** Its name, extension included. */
  name: string;
  /** Bytes; 0 for a folder. */
  size: number;
  isDir: boolean;
  /** When it was put on the shelf, last: Unix ms. */
  addedAt: number;
  /** A PNG data URL of its thumbnail or its type's icon; "" when there is none to show. */
  thumb: string;
  /** The file is no longer where it was: the item can only be removed. */
  missing: boolean;
}

/** The page's copy of what Rust holds, and what the shelf's card shows for a moment. */
export const Tools = {
  /** The clipboard's history, newest first. */
  clipboard: [] as ClipEntry[],
  /** The shelf, newest first. */
  shelf: [] as ShelfItem[],
  /** A file is being dragged over the island with the tools up: the shelf is where it would land. */
  dropOver: false,
  /** An item is being dragged out of the island (and for a moment after): what comes back in is not a drop. */
  dragOut: false,
  /** The item a screenshot just put on the shelf, while it is lit. */
  fresh: null as number | null,
  /** A screenshot could not be taken, while the card says so. */
  captureFailed: false,
};

/** How many characters of a text a row shows at most: the row cuts the rest with its own ellipsis. */
export const LABEL_CHARS = 120;

/** How long a row says "Pasted" or "Copied" after a click, ms. */
export const NOTE_MS = 1600;

const whole = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/**
 * A thumbnail the page may draw: a PNG data URL, as clipboard.rs makes them.
 * Anything else — an address the webview would go and fetch — is not one.
 */
export function thumbSource(thumb: unknown): string {
  return typeof thumb === "string" && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(thumb) ? thumb : "";
}

/**
 * The list as Rust sent it, taken apart: only what is an entry is kept, in the
 * order it came, each id once.
 */
export function clipEntries(raw: unknown): ClipEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const entries: ClipEntry[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (item == null || typeof item !== "object") continue;
    const { id, kind } = item;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || seen.has(id)) continue;
    if (kind !== "text" && kind !== "image") continue;
    seen.add(id);
    entries.push({
      id,
      kind,
      preview: typeof item.preview === "string" ? item.preview : "",
      chars: whole(item.chars),
      width: whole(item.width),
      height: whole(item.height),
      thumb: thumbSource(item.thumb),
      at: whole(item.at),
    });
  }
  return entries;
}

/** A text on one line: every run of spaces and line breaks is one space, none at the ends, cut at `max`. */
export function oneLine(text: string, max = LABEL_CHARS): string {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max).join("").trimEnd()}…` : line;
}

/** What a row says of its entry: the text on one line, or the image's size. */
export function entryLabel(entry: ClipEntry): string {
  if (entry.kind === "image") return `${entry.width} × ${entry.height}`;
  return oneLine(entry.preview);
}

/** What kind of text was copied, as far as it is cheap to tell: it picks the row's icon. */
export type TextKind = "link" | "color" | "text";

const LINK = /^https?:\/\/[^\s]+$/i;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function textKind(text: string): TextKind {
  const s = text.trim();
  if (HEX_COLOR.test(s)) return "color";
  if (LINK.test(s)) return "link";
  return "text";
}

/** The colour a copied "#1DB954" names, for the row's swatch; null when the text is not one. */
export function swatchColor(text: string): string | null {
  const s = text.trim();
  return HEX_COLOR.test(s) ? s : null;
}

/** The icon of a row. */
export type RowIcon = "image" | TextKind;

export function rowIcon(entry: ClipEntry): RowIcon {
  return entry.kind === "image" ? "image" : textKind(entry.preview);
}

/** How long ago, in a few characters: "now", "5m", "3h", "2d". */
export function agoLabel(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return t("now");
  if (minutes < 60) return t("{n}m", { n: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? t("{n}h", { n: hours }) : t("{n}d", { n: Math.floor(hours / 24) });
}

/**
 * What a row says for a moment after a click, by what Rust answered (an
 * English key): pasted where the user types, only copied (Liv's own window
 * was in front), or not even that. Null says nothing: the entry is gone, and
 * its row goes with the next list; or there is no Rust to answer (a browser).
 */
export function pasteNote(outcome: string | null | undefined): string | null {
  switch (outcome) {
    case "pasted":
      return N_("Pasted");
    case "copied":
      return N_("Copied");
    case "failed":
      return N_("Couldn’t copy");
    default:
      return null;
  }
}

/** What the clipboard's card shows in place of rows; null while it has rows. */
export function clipboardEmptyText(on: boolean, count: number): string | null {
  if (!on) return N_("Clipboard history is off");
  return count === 0 ? N_("Nothing copied yet") : null;
}

// ── The shelf ─────────────────────────────────────────────────────────────────

/** How many characters of a name an item shows; the whole of it is on its tooltip. */
export const NAME_CHARS = 12;
/** A press on an item that moves further than this drags it out, page px. */
export const DRAG_START_PX = 4;
/** How long after a drag out ends the island still takes no file for a drop, ms: the drop's own news may come last. */
export const DRAG_OUT_GRACE_MS = 1000;
/** How long the item a screenshot made stays lit, ms. */
export const FRESH_MS = 3000;
/** How long the card says a screenshot could not be taken, ms. */
export const CAPTURE_NOTE_MS = 4000;

/** What the shelf's card says while it holds nothing. */
export const SHELF_EMPTY = N_("Drop files here");
/** What it says, for a moment, after a screenshot that could not be taken. */
export const CAPTURE_FAILED = N_("Couldn’t take the screenshot");

/**
 * The list as Rust sent it, taken apart: only what is an item is kept, in the
 * order it came, each id once.
 */
export function shelfItems(raw: unknown): ShelfItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const items: ShelfItem[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (item == null || typeof item !== "object") continue;
    const { id, path } = item;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || seen.has(id)) continue;
    if (typeof path !== "string" || !path) continue;
    seen.add(id);
    items.push({
      id,
      path,
      name: typeof item.name === "string" && item.name ? item.name : path,
      size: whole(item.size),
      isDir: item.isDir === true,
      addedAt: whole(item.addedAt),
      thumb: thumbSource(item.thumb),
      missing: item.missing === true,
    });
  }
  return items;
}

const SIZE_UNITS = ["KB", "MB", "GB", "TB"];

/**
 * A file's size as Explorer would say it: "980 B", "1.2 MB", "34 GB" — one
 * decimal under ten, none from there on; a comma for it in Spanish.
 */
export function sizeLabel(bytes: number): string {
  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (size < 1024) return `${Math.floor(size)} B`;
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // Cut, not rounded: a file never reads bigger than it is ("9.9", not "10.0").
  const shown = value < 10 ? (Math.floor(value * 10) / 10).toFixed(1) : String(Math.floor(value));
  return `${language() === "es" ? shown.replace(".", ",") : shown} ${SIZE_UNITS[unit]}`;
}

/** The extension of a name, dot included, when it has a short one after something else; else "". */
function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? [...name.slice(dot)] : [];
  return ext.length >= 2 && ext.length <= 6 && !ext.includes(" ") ? ext.join("") : "";
}

/**
 * A name short enough for an item: its start, an ellipsis, then its last two
 * characters and its extension — what tells one screenshot from the next, and
 * a .pdf from a .png.
 */
export function shortName(name: string, max = NAME_CHARS): string {
  const chars = [...name];
  if (chars.length <= max) return name;
  const ext = [...extension(name)];
  const stem = chars.slice(0, chars.length - ext.length);
  const tail = [...stem.slice(-2), ...ext];
  const head = max - 1 - tail.length;
  // No room for both ends: the start alone.
  if (head < 1) return `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
  return `${stem.slice(0, head).join("").trimEnd()}…${tail.join("")}`;
}

/** What an item says under its name: that its file has gone, that it is a folder, or its size. */
export function itemDetail(item: ShelfItem): string {
  if (item.missing) return t("Missing");
  return item.isDir ? t("Folder") : sizeLabel(item.size);
}

/** Whether a press that has moved by (dx, dy) has become a drag out of the island. */
export function dragStarts(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > DRAG_START_PX;
}

/**
 * Where a file dragged onto the island goes: with the tools on screen, onto
 * the shelf — the view stays, and no file is taken in. Anywhere else the drop
 * is Liv's, as it always was (island/island.ts).
 */
export function shelfTakesDrop(mode: string, view: string): boolean {
  return mode === "expanded" && view === "tools";
}

/** How a screenshot went, as Rust says it in `capture`. `id` is its item on the shelf, when it has one. */
export type CaptureResult =
  | { ok: true; id: number | null; name: string; width: number; height: number }
  | { ok: false };

/** The `capture` event, taken apart; null for anything that is not one. */
export function captureResult(raw: unknown): CaptureResult | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = raw as Record<string, unknown>;
  if (event.ok === false) return { ok: false };
  if (event.ok !== true) return null;
  const id = typeof event.id === "number" && Number.isSafeInteger(event.id) ? event.id : null;
  return {
    ok: true,
    id,
    name: typeof event.name === "string" ? event.name : "",
    width: whole(event.width),
    height: whole(event.height),
  };
}

export interface CaptureScene {
  paused: boolean;
  /** The island waits off-screen while another app is full screen. */
  parked: boolean;
  /** A permission card or a question is waiting for an answer. */
  cardWaiting: boolean;
  /** The island is open. */
  expanded: boolean;
  /** The view it shows, or showed last. */
  view: IslandViewName;
}

/**
 * Whether a screenshot opens the island on the tools, by the rule every alert
 * goes by (core/alerts.ts): never over a card that waits, nor over what the
 * user is doing in the open island; and not at all while the island is paused
 * or parked off-screen, where nobody would see it. The screenshot is taken,
 * saved and shelved all the same.
 */
export function captureOpensIsland(scene: CaptureScene): boolean {
  if (scene.paused || scene.parked) return false;
  return alertShows({
    // Asked for by the user, just now: as an alert of the pill in front.
    focused: true,
    waitsForYou: false,
    alertsFromAllPills: false,
    cardWaiting: scene.cardWaiting,
    expanded: scene.expanded,
    view: scene.view,
  });
}
