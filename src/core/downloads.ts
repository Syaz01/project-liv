// A download that finished (src-tauri/src/downloads.rs), as the island holds
// it: the last one told, how many came since the card was last looked at, and
// when its news may open the island. No DOM here.
//
// Rust tells a name and a size, never a path: the card asks for the download
// by its number, and Rust opens only what it announced.

import { alertShows } from "./alerts";
import type { IslandViewName } from "./layout";

export interface DownloadTold {
  id: number;
  name: string;
  size: number;
}

/** What Rust sent, if it is a download; anything else is passed over. */
export function parseDownload(raw: unknown): DownloadTold | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, name, size } = raw as Record<string, unknown>;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
  if (typeof name !== "string" || name.trim() === "") return null;
  return { id, name, size: typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : 0 };
}

export interface DownloadsState {
  /** The download the card shows; null until one finishes. */
  latest: DownloadTold | null;
  /** How many finished since the card was last on screen, the one shown included. */
  fresh: number;
  /** The file of the one shown was gone when the card tried to use it. */
  gone: boolean;
}

export const NO_DOWNLOADS: DownloadsState = { latest: null, fresh: 0, gone: false };

/** A download finished: it is the one the card shows now. */
export function downloadTold(state: DownloadsState, told: DownloadTold): DownloadsState {
  return { latest: told, fresh: state.fresh + 1, gone: false };
}

/** The card was looked at and left: the next download is news on its own. */
export function downloadsSeen(state: DownloadsState): DownloadsState {
  return state.fresh === 0 ? state : { ...state, fresh: 0 };
}

/** The card's file could not be used: it says so. */
export function downloadGone(state: DownloadsState, id: number): DownloadsState {
  return state.latest?.id === id ? { ...state, gone: true } : state;
}

export interface DownloadScene {
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
 * Whether a finished download opens the island on its card. As a screenshot's
 * does (core/tools.ts): never over a card that waits for an answer, nor over
 * what is being typed, nor where nobody would see it. Then the download is
 * still the one the card will show, the next time it is asked for.
 */
export function downloadOpensIsland(scene: DownloadScene): boolean {
  if (scene.paused || scene.parked) return false;
  // Already on its card: it only takes the new name.
  if (scene.expanded && scene.view === "download") return false;
  return alertShows({
    focused: true,
    waitsForYou: false,
    alertsFromAllPills: false,
    cardWaiting: scene.cardWaiting,
    expanded: scene.expanded,
    view: scene.view,
  });
}
