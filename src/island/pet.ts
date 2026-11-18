// Liv on the desktop, island side: runs its outings (pet/outing.ts) against
// the real app, draws the way between the island and its spot
// (pet/travel.ts) for Rust to move the window along, and tells the window
// what Liv looks like. The window itself is src-tauri/src/pet.rs, and its
// page src/pet/main.ts.
//
// Nothing here runs while Liv is home: no timer, no event to the window.

import { Bridge, emitToWindow, onEvent } from "../core/bridge";
import { State } from "../core/state";
import { dropOutcome, type Point, type Rect } from "../pet/drag";
import { Outing, whileOut, type IslandEvent } from "../pet/outing";
import { travelPath } from "../pet/travel";
import { PET_EVENTS, PET_WINDOW_LABEL, type PetDrop, type PetLook } from "../pet/wire";
import { PEEK_HOLD } from "./fsm";

/** What Liv's outings need from the island. */
export interface PetIsland {
  /** Where Liv is in the island's page, px: the middle of its slot. */
  slot(): Point;
  /** The island's shape in its page. */
  rect(): Rect;
  /** The island is open for something that needs the user. */
  needed(): boolean;
  /** Liv as the island would draw it now. */
  look(): Pick<PetLook, "state" | "shell" | "hint" | "outfit">;
  /** Shows the island, compact, when it is hidden. */
  reveal(): void;
  /** Opens Liv's wardrobe, or goes back to the usual view when it is the one open. */
  toggleWardrobe(): void;
}

const point = ([x, y]: readonly [number, number]): Point => ({ x, y });

export class PetLink {
  readonly outing: Outing;

  private island: PetIsland;
  /** What the window was last told, so it is only told of a change. */
  private pushed = "";
  private beat = 0;
  private hello = 0;
  /** A task ended while Liv was out: the state it shows for it, until the timer ends it. */
  private cheer: { state: "finished" | "error"; timer: number } | null = null;

  constructor(island: PetIsland) {
    this.island = island;
    this.outing = new Outing({
      goOut: (anywhere) => this.travel("spot", anywhere),
      goHome: () => this.travel("home", false),
      appear: async () => (await Bridge.petAppear()) === true,
      pickUp: async () => (await Bridge.petPickUp()) === true,
      settle: () => void Bridge.petSettle(),
      hide: (forget) => void Bridge.petHide(forget),
      setAway: (away) => {
        State.petAway = away;
        State.notify();
      },
      needed: () => this.island.needed(),
    });
    State.subscribe(() => this.push());
  }

  /** Listens to the window and to Rust. `supported`: the window exists. */
  async init(supported: boolean) {
    this.outing.supported = supported;
    if (!supported) return;
    await onEvent<PetDrop>(PET_EVENTS.dropped, (drop) => {
      const outcome = dropOutcome(drop, this.island.rect());
      this.outing.dropped(outcome);
      // Liv arrives in an island that shows.
      if (outcome === "home") this.island.reveal();
    });
    await onEvent<null>(PET_EVENTS.grabbed, () => {
      this.outing.grabbed();
      // The island shows itself: a place to drop Liv on.
      this.island.reveal();
    });
    await onEvent<null>(PET_EVENTS.home, () => this.outing.sendHome());
    await onEvent<null>(PET_EVENTS.wardrobe, () => this.island.toggleWardrobe());
    await onEvent<boolean>(PET_EVENTS.ask, (out) => this.outing.ask(out));
    // The window's page (re)loaded: it knows nothing yet.
    await onEvent<null>(PET_EVENTS.ready, () => {
      this.pushed = "";
      this.push();
    });
  }

  /**
   * The island has something to say. Out on the desktop, Liv does its part
   * there (pet/outing.ts: whileOut); true when it did, and the island has no
   * figure of its own to do it with.
   */
  hears(event: IslandEvent): boolean {
    const action = whileOut(event);
    if (action === "flyHome") {
      this.outing.summon();
      return false;
    }
    if (!this.outing.away) return false;
    if (action === "celebrate" && (event === "finished" || event === "error")) this.celebrate(event);
    else if (action === "wave") {
      this.hello = Date.now();
      this.push();
    }
    return action !== "nothing";
  }

  /** Liv wears the state of a task that ended, and plays its entrance, for as long as it would in its pocket. */
  private celebrate(state: "finished" | "error") {
    if (this.cheer) window.clearTimeout(this.cheer.timer);
    const timer = window.setTimeout(() => {
      this.cheer = null;
      this.push();
    }, PEEK_HOLD[state] * 1000);
    this.cheer = { state, timer };
    this.beat++;
    this.push();
  }

  /** One way of the window, start to end. */
  private async travel(to: "spot" | "home", anywhere: boolean): Promise<boolean> {
    const slot = this.island.slot();
    const route = await Bridge.petRoute(to, slot.x, slot.y, anywhere);
    if (!route) return false;
    const path = travelPath(point(route.from), point(route.to), route.unit);
    return (await Bridge.petTravel(path.points, path.ms, to)) === true;
  }

  /** Tells the window what Liv looks like, when that changed and Liv is out. */
  private push() {
    if (!this.outing.away) {
      this.pushed = "";
      if (this.cheer) window.clearTimeout(this.cheer.timer);
      this.cheer = null;
      return;
    }
    const look: PetLook = { ...this.island.look(), beat: this.beat, hello: this.hello };
    if (this.cheer) look.state = this.cheer.state;
    const key = JSON.stringify(look);
    if (key === this.pushed) return;
    this.pushed = key;
    void emitToWindow(PET_WINDOW_LABEL, PET_EVENTS.look, look);
  }
}
