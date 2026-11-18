// What the island's page and Liv's desktop window say to each other, and
// what Rust says to both. The window has no idea of agents: the island tells
// it what Liv looks like, and the window draws it.

import type { BotStateName } from "../core/layout";
import type { RGB } from "../robot/look";
import type { Outfit } from "../robot/outfits";
import type { Heading } from "./travel";

/** The windows' labels (src-tauri: island.rs WINDOW_LABEL, pet.rs LABEL). */
export const ISLAND_WINDOW = "island";
export const PET_WINDOW_LABEL = "pet";

export const PET_EVENTS = {
  /** Island → window: what Liv looks like now (PetLook). */
  look: "pet-look",
  /** Window → island: the page is up and knows nothing yet. */
  ready: "pet-ready",
  /** Window → island: a double click on Liv, it goes home. */
  home: "pet-home",
  /** Window → island: a right-click on Liv, its wardrobe opens in the island. */
  wardrobe: "pet-wardrobe",
  /** Rust → window: the pointer, in the window's page px. */
  cursor: "pet-cursor",
  /** Rust → window: the window is on screen, or not (home, parked for a full-screen app, paused). */
  shown: "pet-shown",
  /** Rust → window: the window sets off on a way (PetTravel). */
  travel: "pet-travel",
  /** Rust → window: the pointer holds Liv, or has let go of it. */
  held: "pet-held",
  /** Rust → island: Liv was picked up where it stood on the desktop. */
  grabbed: "pet-grabbed",
  /** Rust → island: the pointer let go of Liv (PetDrop). */
  dropped: "pet-dropped",
  /** Rust → island: Settings asks for Liv on the desktop, or back home. */
  ask: "pet-ask",
  /** Rust → every window: Liv lives on the desktop, or in the island (what Settings shows). */
  out: "pet-out",
} as const;

/** Liv as the island would draw it. */
export interface PetLook {
  state: BotStateName;
  /** A colour for the shell (a pill's, the update's blue); null = its own. */
  shell: RGB | null;
  /** The update hint: an arrow badge of this colour over an idle Liv. */
  hint: RGB | null;
  /** What it wears now: what the wardrobe is trying on it, else what it has on. */
  outfit: Outfit;
  /** Goes up each time the state's entrance is to be played, again when it is the same state. */
  beat: number;
  /**
   * When Liv was last asked to greet, ms on the wall clock (0: never). It
   * travels with the look, so a window whose page comes up late still hears
   * of it; a greeting asked for long ago is not played.
   */
  hello: number;
}

/** A greeting asked for longer ago than this is over, ms. */
export const HELLO_FRESH_MS = 4000;

/** A way the window sets off on: how far, in page px, for how long, and which end is the island. */
export interface PetTravel {
  dx: number;
  dy: number;
  ms: number;
  way: Heading;
}

/** Where the pointer let go of Liv, in the island page's px, and where it had picked it up. */
export interface PetDrop {
  x: number;
  y: number;
  from: "island" | "desktop";
}
