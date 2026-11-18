// Island open/close FSM — port of IslandStateMachine.swift.
// No DOM, no Tauri: it only reports transitions.

/**
 * `peek` is Liv's pocket, between the compact island and the open one: Liv
 * pops out for a moment (a task finished or failed, a greeting) and the
 * island is compact again.
 */
export type FsmState = "hidden" | "petit" | "peek" | "home";

/** How long Liv stays out for a task that finished, and for one that failed, seconds. */
export const PEEK_HOLD = { finished: 3.6, error: 5 } as const;

export class IslandStateMachine {
  state: FsmState = "hidden";

  onTransition: ((from: FsmState, to: FsmState) => void) | null = null;

  /**
   * home → petit delay, seconds: the auto-close preference. Changing it while a
   * countdown runs starts that countdown again with the new delay, so an edit in
   * Settings applies at once (IslandStateMachine.homeToPetitDelay on macOS).
   */
  get homeToPetitDelay(): number {
    return this.homeDelay;
  }
  set homeToPetitDelay(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds === this.homeDelay) return;
    this.homeDelay = seconds;
    if (this.state === "home" && this.homeCollapse != null) this.scheduleHomeCollapse();
  }
  /** petit → hidden delay, seconds. */
  petitToHiddenDelay = 60;
  /** An alert waiting for an answer stays open, even when the mouse leaves. */
  pinned = false;
  /**
   * Hovering opens the island all the way instead of peeking (Settings →
   * General → Open on hover, off by default), as IslandStateMachine.openOnHover.
   */
  openOnHover = false;
  /**
   * Nobody would see Liv pop out: the island waits off-screen for a
   * full-screen app, or is paused from the tray. The island says so (island.ts).
   */
  away = false;
  /** Grace period after the pointer leaves a hover-opened island, seconds. */
  hoverCloseDelay = 0.6;
  /** How long the pointer rests on the compact island before Open on hover opens it, seconds. */
  hoverOpenDelay = 0.5;
  /**
   * When the open island will fold, on the performance.now() clock, while the
   * mouse-leave countdown runs; null otherwise. The island draws its countdown
   * bar from it.
   */
  homeCollapseDueAt: number | null = null;

  private homeDelay = 15;
  /** Open because of a hover, until the user clicks inside it. */
  private byHover = false;
  private petitHide: number | null = null;
  private homeCollapse: number | null = null;
  private hoverOpen: number | null = null;
  private peekEnd: number | null = null;
  /** What is left of the pocket's hold, ms, and when it ends on the performance.now() clock while it runs. */
  private peekLeft = 0;
  private peekDueAt = 0;

  // ── Inputs ──────────────────────────────────────────────────────────────────

  mouseEntered() {
    switch (this.state) {
      case "hidden":
        // The closed island only peeks: a PC has no notch, so the pointer
        // lands on it far more often than on a Mac's, on its way elsewhere.
        this.cancelTimers();
        this.transition("petit");
        if (this.openOnHover && !this.pinned) this.scheduleHoverOpen();
        break;
      case "petit":
        this.clear("petitHide");
        // Open on hover: once the pointer rests on the compact island.
        if (this.openOnHover && !this.pinned) this.scheduleHoverOpen();
        break;
      case "peek":
        // The pointer resting on Liv's pocket holds it there.
        this.pausePeek();
        break;
      case "home":
        this.clear("homeCollapse");
        break;
    }
  }

  mouseLeft() {
    this.clear("hoverOpen");
    switch (this.state) {
      case "hidden":
        break;
      case "petit":
        this.schedulePetitHide();
        break;
      case "peek":
        // What was left of the hold when the pointer came runs on.
        if (this.peekEnd == null) this.schedulePeekEnd();
        break;
      case "home":
        this.scheduleHomeCollapse();
        break;
    }
  }

  click() {
    this.byHover = false;
    if (this.state !== "petit" && this.state !== "peek") return;
    this.cancelTimers();
    this.transition("home");
  }

  /**
   * Liv pops out in its pocket for `seconds`, then the island is compact and
   * hides on its usual clock. Only from an island that is folded: an open one
   * keeps what it shows, a card folded away while it waits keeps the compact
   * island, and nothing pops out of an island nobody sees. Asked again while
   * Liv is out, the hold starts over. False when it does not pop out.
   */
  peek(seconds: number): boolean {
    if (this.state === "home" || this.pinned || this.away) return false;
    this.cancelTimers();
    this.peekLeft = seconds * 1000;
    this.transition("peek");
    this.schedulePeekEnd();
    return true;
  }

  /** Non-alert work event: show compact from hidden. */
  reveal() {
    if (this.state !== "hidden") return;
    this.cancelTimers();
    this.transition("petit");
    this.schedulePetitHide();
  }

  /**
   * The user clicked inside the island: a hover-opened island now stays like
   * any open island (normal auto-close) instead of folding once the pointer leaves.
   */
  userInteracted() {
    if (!this.byHover) return;
    this.byHover = false;
    // The short countdown already running becomes the normal one.
    if (this.state === "home" && this.homeCollapse != null) this.scheduleHomeCollapse();
  }

  /** Alert or explicit request: open straight to expanded. */
  forceHome() {
    this.byHover = false;
    this.cancelTimers();
    this.transition("home");
  }

  /// Explicit close (OK button, Escape, an alert being answered).
  forcePetit() {
    this.byHover = false;
    this.cancelTimers();
    this.transition("petit");
  }

  forceHidden() {
    this.byHover = false;
    this.cancelTimers();
    this.transition("hidden");
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  private schedulePetitHide() {
    this.clear("petitHide");
    // A card folded away while it waits for an answer keeps the compact island
    // on screen, so it can be reopened (isHeldOpen on macOS).
    if (this.pinned) return;
    this.petitHide = window.setTimeout(() => {
      this.petitHide = null;
      if (this.state === "petit" && !this.pinned) this.transition("hidden");
    }, this.petitToHiddenDelay * 1000);
  }

  private scheduleHomeCollapse() {
    this.clear("homeCollapse");
    if (this.pinned) return;
    const ms = (this.byHover ? this.hoverCloseDelay : this.homeDelay) * 1000;
    this.homeCollapseDueAt = performance.now() + ms;
    this.homeCollapse = window.setTimeout(() => {
      this.homeCollapse = null;
      this.homeCollapseDueAt = null;
      // An alert pinned while the countdown ran keeps the island open.
      if (this.state === "home" && !this.pinned) {
        this.byHover = false;
        this.transition("petit");
      }
    }, ms);
  }

  private schedulePeekEnd() {
    this.clear("peekEnd");
    this.peekDueAt = performance.now() + this.peekLeft;
    this.peekEnd = window.setTimeout(() => {
      this.peekEnd = null;
      if (this.state !== "peek") return;
      this.transition("petit");
      this.schedulePetitHide();
    }, this.peekLeft);
  }

  /** The hold stops where it is; mouseLeft runs the rest of it. */
  private pausePeek() {
    if (this.peekEnd == null) return;
    this.peekLeft = Math.max(0, this.peekDueAt - performance.now());
    this.clear("peekEnd");
  }

  private scheduleHoverOpen() {
    this.clear("hoverOpen");
    this.hoverOpen = window.setTimeout(() => {
      this.hoverOpen = null;
      if (this.state !== "petit" || this.pinned || !this.openOnHover) return;
      this.cancelTimers();
      this.byHover = true;
      this.transition("home");
    }, this.hoverOpenDelay * 1000);
  }

  private clear(which: "petitHide" | "homeCollapse" | "hoverOpen" | "peekEnd") {
    const id = this[which];
    if (id != null) window.clearTimeout(id);
    this[which] = null;
    if (which === "homeCollapse") this.homeCollapseDueAt = null;
  }

  cancelTimers() {
    this.clear("hoverOpen");
    this.clear("petitHide");
    this.clear("homeCollapse");
    this.clear("peekEnd");
  }

  private transition(next: FsmState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
  }
}
