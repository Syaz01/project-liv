// Liv's outings: where it is — in the island, on the desktop, on its way —
// and what moves it. It goes out when it is dragged out of the island or sent
// (the shortcut, the switch in Settings) and comes home the same ways or by a
// double click; and while it lives on the desktop it flies home whenever the
// island opens for something that needs the user, and back to its spot once
// the island folds again.
//
// No DOM and no Tauri: whoever owns the windows is handed in (island/pet.ts
// in the app, a stand-in in the tests). Every way is a promise that settles
// when Liv is there; a later way overtakes an earlier one.

/**
 * `home`: in the island. `carried`: the pointer holds it. `leaving`: on its
 * way to its spot. `out`: on the desktop. `returning`: on its way to the
 * island. `visiting`: in the island for as long as it is needed there; its
 * home is still the desktop.
 */
export type OutingPhase = "home" | "carried" | "leaving" | "out" | "returning" | "visiting";

/** What the island has to say while Liv is out. */
export type IslandEvent =
  /** It opens by itself for something: a permission, a question, the office asking, a card. */
  | "alert"
  /** A task finished, or failed. */
  | "finished"
  | "error"
  /** Liv starts. */
  | "greeting"
  /** Work goes on: the compact island shows itself. */
  | "work";

/** What Liv does about it, where it stands. */
export type OutAction = "flyHome" | "celebrate" | "wave" | "nothing";

/**
 * What Liv does on the desktop when the island has something to say. Only
 * what needs the user brings it home — the island's card then has its robot;
 * a task that ends is celebrated or lamented on the spot, the greeting is a
 * wave from there, and the rest is the island's business alone.
 */
export function whileOut(event: IslandEvent): OutAction {
  switch (event) {
    case "alert":
      return "flyHome";
    case "finished":
    case "error":
      return "celebrate";
    case "greeting":
      return "wave";
    case "work":
      return "nothing";
  }
}

/**
 * Whether an island that opens on `view` calls a Liv that lives on the desktop
 * home: only for what waits for the user — a permission, a question, the
 * office asking (its card is the overview with the office's pill in front) —
 * and for a file being dropped, which Liv catches. A chat, a recap or the
 * island opened from the tray leave it where it is.
 */
export function callsHome(view: string, officeInFront: boolean): boolean {
  return view === "approval" || view === "question" || view === "upload" || (view === "overview" && officeInFront);
}

export interface OutingHost {
  /**
   * From the island to its spot: the one it had, or with `anywhere` a spot of
   * its own choosing when it has none it can go back to. False when it did
   * not get there: no spot, no window, or another way overtook this one.
   */
  goOut(anywhere: boolean): Promise<boolean>;
  /** From where it is to the island. False when it did not get there. */
  goHome(): Promise<boolean>;
  /** At its spot at once, without the way there (Liv starts). False when the spot is gone. */
  appear(): Promise<boolean>;
  /** Out of the island under the pointer, which carries it from here on. False when it cannot. */
  pickUp(): Promise<boolean>;
  /** Dropped on the desktop: it stays there, and that is its spot. */
  settle(): void;
  /** Its window is put away. `forget`: Liv lives in the island again. */
  hide(forget: boolean): void;
  /** The island's slot is empty (Liv is elsewhere), or holds Liv again. */
  setAway(away: boolean): void;
  /** The island is open for something that needs the user. */
  needed(): boolean;
}

export class Outing {
  phase: OutingPhase = "home";
  /** The window exists: Liv can leave the island at all. */
  supported = false;
  /** Liv lives on the desktop: where it goes back to after a visit home. */
  private lives = false;
  private host: OutingHost;

  constructor(host: OutingHost) {
    this.host = host;
  }

  /** Liv is not in the island: its slot there is empty. */
  get away(): boolean {
    return this.phase !== "home" && this.phase !== "visiting";
  }

  /** Liv starts, and was on the desktop when it last quit: it is there again. True when it is. */
  async startOut(): Promise<boolean> {
    if (!this.supported || this.phase !== "home") return false;
    this.phase = "out";
    this.lives = true;
    this.host.setAway(true);
    if (await this.host.appear()) {
      if (this.host.needed()) this.summon();
      return true;
    }
    // Its spot is on a display that is gone: it stays in the island.
    if (this.phase === "out") this.backHome(true);
    return false;
  }

  /** The shortcut: out to the desktop, or home. On its way or in the pointer's hand, nothing. */
  toggle() {
    if (!this.supported) return;
    switch (this.phase) {
      case "home":
        void this.leave(true);
        break;
      case "out":
        void this.comeHome(true);
        break;
      case "visiting":
        // Already in the island: it simply stays.
        this.lives = false;
        this.phase = "home";
        this.host.hide(true);
        break;
      default:
        break;
    }
  }

  /** Settings asks for Liv on the desktop, or in the island. */
  ask(out: boolean) {
    if (out !== this.lives) this.toggle();
  }

  /** A double click on Liv, on the desktop: home. */
  sendHome() {
    if (this.phase === "out") void this.comeHome(true);
  }

  /** The island opened for something that needs the user: Liv flies home for as long as it does. */
  summon() {
    if (this.phase === "out" || this.phase === "leaving") void this.comeHome(false);
  }

  /** The island folded: a Liv that was only visiting goes back to its spot. */
  folded() {
    if (this.phase === "visiting") void this.leave(false);
  }

  /** The pointer drags Liv out of the island. */
  async pickUp() {
    if (!this.supported || this.phase !== "home") return;
    this.phase = "carried";
    this.host.setAway(true);
    if (await this.host.pickUp()) return;
    if (this.phase === "carried") this.backHome(false);
  }

  /** The pointer picked Liv up where it stood on the desktop. */
  grabbed() {
    if (this.phase === "out") this.phase = "carried";
  }

  /** The pointer let go of Liv: over the island it is home, anywhere else it stays there. */
  dropped(outcome: "home" | "stay") {
    if (this.phase !== "carried") return;
    if (outcome === "home") {
      this.backHome(true);
      return;
    }
    this.host.settle();
    this.phase = "out";
    this.lives = true;
    if (this.host.needed()) this.summon();
  }

  private async leave(anywhere: boolean) {
    this.phase = "leaving";
    // From here on the desktop is where it lives: called home on the way, it is only visiting.
    this.lives = true;
    this.host.setAway(true);
    const there = await this.host.goOut(anywhere);
    // Called home on the way: that way has taken over.
    if (this.phase !== "leaving") return;
    if (!there) {
      this.backHome(true);
      return;
    }
    this.phase = "out";
    if (this.host.needed()) this.summon();
  }

  private async comeHome(forGood: boolean) {
    this.phase = "returning";
    if (forGood) this.lives = false;
    const there = await this.host.goHome();
    if (this.phase !== "returning") return;
    if (!there || !this.lives) {
      this.backHome(!this.lives);
      return;
    }
    this.phase = "visiting";
    this.host.setAway(false);
    // The island folded while Liv was on its way: nothing keeps it here.
    if (!this.host.needed()) this.folded();
  }

  /** Liv is in the island, its window put away. */
  private backHome(forget: boolean) {
    if (forget) this.lives = false;
    this.host.hide(forget);
    this.phase = this.lives ? "visiting" : "home";
    this.host.setAway(false);
    if (this.phase === "visiting" && !this.host.needed()) this.folded();
  }
}
