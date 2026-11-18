// The island: DOM shell, sizing animation, the figure's placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop, type DragDropPayload } from "../core/bridge";
import { chatShell, towards } from "../core/chat-look";
import {
  DEFAULT_APPEARANCE, appearance, cornerRadius, islandShape, openHeight, panelSize, type Appearance,
} from "../core/appearance";
import {
  CLOSED_BOT_D, CLOSED_H, closedContent, closedIsland, closedWidth, type ClosedContent,
} from "../core/closed";
import {
  NOTCH_W, PEEK_H,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition,
  islandSize, stageOffset,
  QUESTION_PICKER_H,
  type BotStateName, type IslandMode, type IslandViewName,
} from "../core/layout";
import {
  breathes, countdownShare, countdownWindow, livInSight, livesOnTimer, needsFrame, type FrameScene,
} from "../core/frames";
import { canvasRatio, islandScale } from "../core/scale";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { SPOTIFY_ID, Spotify } from "../core/spotify";
import { Tools, shelfTakesDrop } from "../core/tools";
import { OFFICE_PILL_ID } from "../core/office";
import { shownOutfit } from "../core/wardrobe";
import { shouldDance } from "../robot/dance";
import { nextLife } from "../robot/life";
import { CANVAS_PER_SLOT, hexToRGB, modelFor, type RGB } from "../robot/look";
import { miniRobot } from "../robot/mini";
import { outfitChoice, type Outfit } from "../robot/outfits";
import { onHead } from "../robot/react";
import { GREETING_MS, Robot } from "../robot/robot";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq, uploadProgressCurve } from "../upload/sequence";
import { dominantPct, planColor } from "../core/plan";
import { isDrag, type Point } from "../pet/drag";
import { callsHome } from "../pet/outing";
import type { PetLook } from "../pet/wire";
import { language, t, tl } from "../i18n/i18n";
import { claudeCompactPillVisible, closePlanCard, openPlanColor, planCardOpen } from "../views/usage";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { buildSessionDropList, type SessionDropList } from "../views/session-drop";
import { DROP_TEXT_RIGHT_WITH_LIST, dropTargetAt, dropTargets } from "../core/launch";
import { IslandStateMachine, PEEK_HOLD } from "./fsm";
import { refreshHookPills } from "./integrations";
import { restoreAlertFocus } from "./hooks";
import { currentOfficeCard, openOfficeUrl } from "./office";
import { PetLink } from "./pet";
import type { ViewCommand } from "./shortcuts";
import { Updates } from "./update";
import { UPDATE_BLUE, showsUpdateHint } from "../whats-new/whats-new";

const UPDATE_BLUE_RGB = hexToRGB(UPDATE_BLUE);
const CLAUDE_DESKTOP_ID = "agent_claude-desktop";
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The views with a text field: the island takes the keyboard while one is on. */
const TYPING_VIEWS: ReadonlySet<IslandViewName> = new Set(["prompt", "launch"]);

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

/** What of the island's shape is animated to: its size and its corners (the opacity is CSS's). */
const shapeKeyOf = (a: Appearance) => `${a.width}|${a.extraHeight}|${a.radius}`;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : m === "peek" ? 2 : 3);

/** What a click in a card is meant for when it lands on one of these: the card, not Liv behind it. */
const CONTROL_TAGS: ReadonlySet<string> = new Set(["BUTTON", "INPUT", "TEXTAREA", "SELECT", "A"]);

/**
 * Liv is on its way out of the island for this long before it reacts to what
 * it came out for: the hop or the shake is seen in the pocket, not lost in
 * its opening.
 */
const POCKET_ARRIVE_MS = 260;

/** The glow behind Liv in its pocket waits until the pocket is this close to its height, px. */
const POCKET_GLOW_WITHIN = 4;

/** What Liv came out of the island for (Island.peek, Island.greet). */
interface Pocket {
  /** The state it wears there; null = the one it has (the greeting). */
  look: "finished" | "error" | null;
  /** The view a click on the pocket opens; null = the usual one. */
  view: IslandViewName | null;
  /** What is left of its way out, ms of frames. */
  arriveMs: number;
  /** Its state's entrance is still to be played. */
  enters: boolean;
}

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private miniGrid!: HTMLElement;
  private clockEl!: HTMLElement;
  private clockTimer?: number;
  /** The closed island's one line (core/closed.ts), and what it last showed. */
  private closedEl!: HTMLElement;
  private closedDot!: HTMLElement;
  private closedText!: HTMLElement;
  private closedKey = "";
  /** Width of the closed island for what it shows now. */
  private closedW = 120;
  /** The size the window was last folded to, so a new one is only sent on a change. */
  private collapsedTo = { w: 0, h: 0 };
  /**
   * The open island as Settings shapes it (core/appearance.ts), kept with the
   * four settings it was read from: read again only when one of them changes.
   */
  private shapeMemo: { w: unknown; h: unknown; r: unknown; o: unknown; value: Appearance } | null = null;
  /** The size and the corners last animated to, so only a change of them moves the island. */
  private shapeKey = shapeKeyOf(DEFAULT_APPEARANCE);
  private countdown!: HTMLElement;
  private compactPlan!: HTMLElement;
  private compactPlanDot!: HTMLElement;
  private compactPlanLabel!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;
  /** The sessions listed on the drop card while a file is over it. */
  private sessionDrop!: SessionDropList;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine: Robot;
  /** What times Liv's small signs of life (0…1 each draw). */
  private random: () => number;
  /**
   * The one timer of Liv's life while the island is closed or compact
   * (core/frames.ts: livesOnTimer): it wakes the frame loop for a blink or a
   * glance, and the loop stops again.
   */
  private lifeTimer: number | null = null;

  /** Liv's outings to the desktop (island/pet.ts). */
  readonly pet: PetLink;
  /**
   * The island opened by itself for something (alert): for as long as it
   * stays open, a Liv that lives on the desktop is here.
   */
  private summoned = false;
  /**
   * Where the pointer pressed on Liv, in the page: moved far enough from
   * there with the button held, it picks Liv up (pet/drag.ts).
   */
  private press: Point | null = null;
  /**
   * The day "Auto" dresses Liv for (robot/outfits.ts). Looked up again when
   * the island shows itself, when the settings change and when the wardrobe
   * is used — never by a timer.
   */
  private today = new Date();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;
  /** The pixel ratio the figure's bitmap was sized for: it changes with the monitor. */
  private canvasDpr = 0;

  // Rust starts the window at full size.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Where the pointer was last reported, in the page's coordinates. */
  private cursor = { x: -10_000, y: -10_000 };
  /** Liv is out in its pocket, and what for; null the rest of the time. */
  private pocket: Pocket | null = null;
  /** The colour Liv's shell wears in the chat: who answers; null out of it. */
  private chatColor: RGB | null = null;
  /** Something is being typed in a card: the island stays open. */
  private holdingOpen = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };

  /**
   * The timer that wakes the frame loop when the countdown bar comes into
   * view, and the fold it counts down to.
   */
  private countdownWake: { dueAt: number; timer: number } | null = null;

  private lastSyncedView: IslandViewName | null = null;

  /** The island came out of hidden — one of the moments the Monday recap may
   *  open (see src/recap/recap.ts). */
  onWake: (() => void) | null = null;

  /** The next reveal from hidden makes no peek (music starting, as on macOS). */
  private silentReveal = false;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;
  private dragLeaveTimer: number | null = null;

  constructor(root: HTMLElement, random: () => number = Math.random) {
    this.root = root;
    this.random = random;
    this.engine = new Robot(random);
    this.build();
    this.pet = new PetLink({
      slot: () => this.livSpot(),
      rect: () => this.islandRect(),
      needed: () => this.summoned && State.mode === "expanded",
      look: () => this.livLook(),
      reveal: () => this.reveal(),
      toggleWardrobe: () => this.toggleWardrobe(),
    });
    this.wireFsm();
    this.wireInput();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  /** The request has its answer: the card goes and the session carries on. */
  private closeApproval() {
    State.endApproval();
    if (State.pendingApproval) {
      const view = State.pendingApproval.questions ? "question" : "approval";
      this.setView(view);
      Sound.play(view);
      return;
    }
    this.setView(State.defaultView());
  }

  /**
   * Folds a card that is waiting for an answer down to the compact island,
   * without answering it. Nothing is decided: the request keeps
   * waiting, the island stays on screen, and opening it shows the card again.
   */
  foldApproval() {
    if (!State.pendingApproval || State.mode !== "expanded") return;
    State.setPinned(true);
    this.fsm.forcePetit();
  }

  /**
   * What keeps the state machine from folding the island: the pin (Ctrl+P, a
   * card waiting for an answer) or something being typed in a card. The one
   * place its flag is written; State.setPinned calls it on every change.
   */
  private syncPin() {
    this.fsm.pinned = State.isPinned || this.holdingOpen;
  }

  /**
   * Something is being typed in the card on screen: the island stays open
   * until it is sent or cleared. The hold ends with the card: when another
   * view replaces it, and when the island folds.
   */
  private holdOpen(on: boolean) {
    if (this.holdingOpen === on) return;
    this.holdingOpen = on;
    this.syncPin();
    if (on) this.fsm.cancelTimers();
    else if (!this.fsm.pinned && !this.wasInIsland && this.fsm.state === "home") this.fsm.mouseLeft();
    // The countdown bar follows on the next frame.
    this.ensureRunning();
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      cancelDrop: () => this.discardDrop(),
      collapse: () => this.collapse(),
      foldApproval: () => this.foldApproval(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
        // A pill with a waiting request opens on its card: going back to it
        // after looking at another pill brings the card up again.
        const req = State.pendingApproval;
        if (req?.pillId === id) this.setView(req.questions ? "question" : "approval");
      },
      openTerminal: () => {
        const task = State.focusTask;
        // Sessions from the Claude desktop app live there, not in a terminal.
        if (task?.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else void Bridge.openSession(task?.sessionId ?? null, task?.sessionCwd ?? null);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com/pulls",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else if (task.id === "integration_claude" || task.sessionId) {
          void Bridge.openSession(task.sessionId ?? null, task.sessionCwd ?? null);
        } else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (task.id === "integration_gitea") void Bridge.openGitea();
        else if (task.id === SPOTIFY_ID) void Bridge.spotifyOpen();
        // The office: what its card's headline is about, else the office itself.
        else if (task.id === OFFICE_PILL_ID) openOfficeUrl(currentOfficeCard().jumpUrl);
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      // Each of the three answers the request its button was pressed on, and
      // only while that request still has the card: a press that landed as the
      // next one in line came up answers nothing.
      decide: (d, requestId) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req || req.requestId !== requestId) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        this.closeApproval();
      },
      answer: (answers, requestId) => {
        const req = State.pendingApproval;
        if (!req || req.requestId !== requestId) return;
        Sound.play("approve");
        void Bridge.approvalAnswer(req.requestId, answers);
        this.closeApproval();
      },
      answerInTerminal: (requestId) => {
        const req = State.pendingApproval;
        if (!req || req.requestId !== requestId) return;
        Sound.play("blip");
        void Bridge.approvalDecline(req.requestId);
        this.closeApproval();
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: (target) => void Bridge.openSettingsWindow(target),
      blip: () => Sound.play("blip"),
      keyboard: (on) => {
        // The chat and launch views manage the keyboard on their own.
        if (on) void Bridge.focusWindow(true);
        else if (!TYPING_VIEWS.has(State.view) && State.mode === "expanded") void Bridge.focusWindow(false);
      },
      launched: () => {
        Sound.play("send");
        this.collapse();
      },
      holdOpen: (on) => this.holdOpen(on),
      previewOutfit: (outfit) => {
        if (State.outfitPreview === outfit) return;
        State.outfitPreview = outfit;
        State.notify();
      },
      chooseOutfit: (choice) => {
        State.settings.livOutfit = choice;
        this.today = new Date();
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.closedDot = h("span", { class: "dot" });
    this.closedText = h("span", { class: "text" });
    this.closedEl = h("div", { id: "island-closed" }, this.closedDot, this.closedText);
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.clockEl = h("div", { id: "island-clock" });
    this.countdown = h("div", { id: "countdown" });
    this.compactPlanDot = h("i", { class: "compact-plan-dot" });
    this.compactPlanLabel = h("span", { class: "compact-plan-label" });
    this.compactPlan = h(
      "button",
      {
        id: "compact-plan",
        title: tl("Claude plan usage"),
        onmousedown: (e) => {
          e.stopPropagation();
        },
        onclick: (e) => {
          e.stopPropagation();
          const me = e as MouseEvent;
          if (me.button === 0) this.openClaudePlan();
        },
      },
      this.compactPlanDot,
      this.compactPlanLabel,
    );

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own figure. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => this.setView("prompt"),
      cancel: () => this.discardDrop(),
    });
    this.sessionDrop = buildSessionDropList();
    this.uploadCanvas.stage.append(this.sessionDrop.el);

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.compactPlan,
      this.clockEl,
      this.closedEl,
      this.countdown,
    );

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.openOnHover = State.settings.openOnHover;
    State.onPinned = () => this.syncPin();
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "hidden" && !this.silentReveal) Sound.play("peek");
          this.setMode("compact");
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "peek":
          // At launch Liv comes out to the sound the compact island made there.
          // A task that finished or failed has its own (hooks.ts, office.ts).
          if (from === "hidden" && this.pocket?.look == null) Sound.play("peek");
          this.setMode("peek");
          break;
        case "home":
          // A click on the pocket opens what Liv came out for.
          this.expand((from === "peek" ? this.pocket?.view : null) ?? this.openingView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          // Hooks may have been installed in a terminal since: the idle cards
          // say so on the next open, without polling while the island is shut.
          void refreshHookPills();
          break;
      }
      if (from === "peek") {
        this.pocket = null;
        // Liv went back in without the island opening: the pill whose alert
        // borrowed the front gives it back, as when the open island closes.
        if (to !== "home") restoreAlertFocus();
      }
      State.notify();
      if (from === "hidden") this.onWake?.();
    };
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    // The island shows itself: on another day "Auto" may dress Liv otherwise.
    if (prev === "hidden") this.today = new Date();
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      // Nothing holds Liv here any more: one that lives on the desktop goes back.
      this.summoned = false;
      this.press = null;
      this.pet.outing.folded();
      Sound.play("close");
      // Nothing is typed in an island that is shut.
      this.holdOpen(false);
      // A folded card is still waiting: it keeps the island pinned.
      if (!State.pendingApproval) State.setPinned(false);
      void Bridge.focusWindow(false);
      // The view that comes up next takes the keyboard afresh, the chat
      // included when it is the chat again.
      this.lastSyncedView = null;
      // Another pill's alert borrowed the front: the pill you had comes back (Mac).
      restoreAlertFocus();
    }
    // What Liv was doing for itself (a wave, hearts in the air) ends with what showed it.
    if (prev === "expanded" || prev === "peek") this.engine.calm();
    if (mode !== "expanded") {
      closePlanCard();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    // Folding all the way: the closed island's width for what it will show.
    // Folded, the window hears no pointer: Liv looks ahead.
    if (mode === "hidden") {
      this.updateClosed();
      this.engine.lookAt(null);
    } else this.closedEl.classList.remove("on");
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  /** Click on compact plan gauge: opens the Claude plan card on the overview. */
  openClaudePlan() {
    Sound.resume();
    this.fsm.userInteracted();
    State.planDetailIsCodex = false;
    State.showingPlanDetail = true;
    this.fsm.forceHome();
    this.expand("overview");
    State.notify();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    if (view !== State.view) this.holdOpen(false);
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    if (view !== State.view) this.holdOpen(false);
    State.view = view;
    this.animateGeometry(!grew);
    State.notify();
  }

  collapse() {
    // A waiting card is only ever folded, never dropped by a close.
    if (State.pendingApproval) {
      this.foldApproval();
      return;
    }
    State.setPinned(false);
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    const wasOpen = this.fsm.state === "home";
    this.fsm.forceHome();
    this.expand(view);
    // On an island already open, forceHome only stopped the countdown and no
    // transition starts it again: with the pointer elsewhere it starts over
    // here (a pin holds it back, as always).
    if (wasOpen && !this.wasInIsland) this.fsm.mouseLeft();
    // The island opened for something that waits for the user: Liv, out on the
    // desktop, comes home for it.
    if (callsHome(view, State.focusId === OFFICE_PILL_ID)) {
      this.summoned = true;
      this.pet.hears("alert");
    }
  }

  /**
   * Settings → Appearance while one of its sliders is dragged: the island
   * takes the shape, and shows it. What is being chosen is the open island's
   * shape, so a folded island opens (as "Open Liv" in the tray does) on what
   * it has to show; one already open keeps its view. With the pointer away,
   * in the Settings window, it folds again on its usual clock, counted from
   * the last move. Paused or parked off-screen, nobody would see it: it only
   * takes the shape.
   */
  previewAppearance() {
    this.applyAppearance();
    if (State.paused || State.parked) return;
    if (State.mode !== "expanded") {
      this.alert(this.openingView());
    } else if (!this.wasInIsland && !this.fsm.pinned) {
      // The countdown starts over, as for an alert on an island already open.
      this.fsm.forceHome();
      this.fsm.mouseLeft();
    }
  }

  /** A new Liv waits and the figure has nothing else to show (its shell is blue). */
  private updateHintOn(): boolean {
    return !State.paused && showsUpdateHint(Updates.waiting(), State.effectiveState, State.pendingApproval != null);
  }

  /**
   * What a click or a hover opens on: while the shell is blue, the new version
   * ("Liv X is out", Update now); otherwise the usual view. A waiting
   * permission or question always comes first.
   */
  private openingView(): IslandViewName {
    return this.updateHintOn() ? "update" : State.defaultView();
  }

  reveal() {
    this.fsm.reveal();
  }

  /**
   * Liv pops out of the folded island in its pocket, whole, wearing a state's
   * colours, and nothing else is drawn: a task finished or failed (hooks.ts,
   * office.ts). It plays that state's entrance there, waits, and the island
   * is compact again; a click on it opens the island on `view`. False when it
   * does not come out — the island is open, keeps a folded card waiting, is
   * parked off-screen or paused — and the caller does as it did before.
   */
  peek(look: "finished" | "error", view: IslandViewName): boolean {
    // Out on the desktop, Liv reacts where it stands: no pocket, the island only shows itself.
    if (this.pet.hears(look)) {
      this.reveal();
      return true;
    }
    // Already out: it reacts at once.
    const arriveMs = this.fsm.state === "peek" ? 0 : POCKET_ARRIVE_MS;
    return this.popOut({ look, view, arriveMs, enters: true }, PEEK_HOLD[look]);
  }

  /**
   * Liv pops out in its pocket and waves, and the island is compact when it
   * has (robot.ts: greet). False when nobody would see it, as peek.
   */
  greet(): boolean {
    // Out on the desktop, Liv waves from its spot.
    if (this.pet.hears("greeting")) {
      this.reveal();
      return true;
    }
    if (!this.popOut({ look: null, view: null, arriveMs: 0, enters: false }, GREETING_MS / 1000)) return false;
    this.engine.greet();
    return true;
  }

  /**
   * The island shows itself as Liv starts: Liv comes out and greets. Started
   * with the computer (`atLogin`), or where nobody would see the greeting, it
   * only shows itself compact, as it does for a work event.
   */
  appear(atLogin: boolean) {
    const show = () => {
      if (atLogin || !this.greet()) this.reveal();
    };
    // Liv was on the desktop when it last quit: it is put back there first.
    if (State.settings.petOut && this.pet.outing.supported) void this.pet.outing.startOut().then(show);
    else show();
  }

  /** The desktop shortcut: Liv out to its spot, or home (island/shortcuts.ts). */
  livOutOrHome() {
    this.pet.outing.toggle();
  }

  /**
   * Liv's wardrobe, from anywhere: the tray's item, the shortcut, a
   * right-click on Liv. Out on the desktop Liv stays there and tries things
   * on where it stands: nothing here waits for the user (pet/outing.ts:
   * callsHome). A card that does wait comes first, and is what opens.
   */
  openWardrobe() {
    this.today = new Date();
    this.alert(State.pendingApproval ? State.defaultView() : "wardrobe");
  }

  /** A right-click on Liv, or the shortcut: the wardrobe, or back to the usual view when it is the one open. */
  toggleWardrobe() {
    if (State.mode === "expanded" && State.view === "wardrobe") this.setView(State.defaultView());
    else this.openWardrobe();
  }

  /**
   * The tools, from the shortcut: the island opens on what was copied. As
   * with the wardrobe, a card that waits for an answer comes first, and
   * nothing here calls a Liv that lives on the desktop home.
   */
  openTools() {
    this.alert(State.pendingApproval ? State.defaultView() : "tools");
  }

  /** The shortcut again, with the tools on screen: the island folds, and whoever had the keyboard has it back. */
  toggleTools() {
    if (State.mode === "expanded" && State.view === "tools") this.collapse();
    else this.openTools();
  }

  /**
   * What Liv has on now: what a chip of the wardrobe is trying on it while
   * that card is up, else what it wears.
   */
  private get wearing(): Outfit {
    const trying = State.mode === "expanded" && State.view === "wardrobe" ? State.outfitPreview : null;
    return shownOutfit(outfitChoice(State.settings.livOutfit), trying, this.today);
  }

  /**
   * Where Liv is in the page, for its way out and back: the middle of its
   * slot, or of the island's top edge while the island shows no figure.
   */
  private livSpot(): Point {
    const rect = this.islandRect();
    const drawn = State.mode !== "hidden" || closedIsland(State.settings.closedIsland) === "robot";
    return drawn
      ? { x: rect.x + this.botCx.value, y: rect.y + this.botCy.value }
      : { x: rect.x + rect.w / 2, y: rect.y };
  }

  /**
   * Liv as it looks away from the island's cards: the state of the pill in
   * front, that pill's colour on its shell while it rests, and the update's
   * blue and arrow while a new Liv waits; and what it wears.
   */
  private livLook(): Pick<PetLook, "state" | "shell" | "hint" | "outfit"> {
    const state = State.effectiveState;
    const hint = this.updateHintOn() ? UPDATE_BLUE_RGB : null;
    const focus = State.focusTask;
    const resting = state === "idle";
    const shell = hint && resting ? hint : focus?.isIntegration && resting ? hexToRGB(focus.color) : null;
    return { state, shell, hint, outfit: this.wearing };
  }

  private popOut(pocket: Pocket, seconds: number): boolean {
    this.fsm.away = State.parked || State.paused;
    // Before the state machine is asked: its transition reads what Liv comes out for.
    const before = this.pocket;
    this.pocket = pocket;
    if (!this.fsm.peek(seconds)) {
      this.pocket = before;
      return false;
    }
    // The pointer may already be where the pocket opens: then it holds Liv there.
    const size = islandSize("peek", State.view);
    this.wasInIsland = this.pointerIn(this.rectOf(size.w, size.h));
    if (this.wasInIsland) this.fsm.mouseEntered();
    this.dirty = true;
    this.ensureRunning();
    return true;
  }

  /** Music started playing: the compact island, without the peek sound (musicReveal). */
  revealSilently() {
    this.silentReveal = true;
    this.fsm.reveal();
    this.silentReveal = false;
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    State.setPinned(false);
    // The countdown the pin held back starts now, if the mouse is elsewhere.
    if (!this.wasInIsland) this.fsm.mouseLeft();
  }

  // ── Keyboard shortcuts (island/shortcuts.ts) ────────────────────────────────

  /** Ctrl+P: keep the open island from folding away, or let it fold again. */
  setPinned(on: boolean) {
    State.setPinned(on);
    if (on) {
      // The countdown bar reads the state machine's deadline, cleared with it.
      this.fsm.cancelTimers();
    } else if (!this.wasInIsland && this.fsm.state === "home") {
      this.fsm.mouseLeft();
    }
    State.notify();
  }

  /** The island takes the keyboard, so its own shortcuts work (Mac: makeKey).
   *  It gives it back when it closes, or when the chat is left. */
  takeKeyboard() {
    void Bridge.focusWindow(true);
  }

  /** Ctrl+O / Ctrl+E go to the view on screen. */
  viewCommand(command: ViewCommand) {
    this.views.get(State.view)?.command?.(command);
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: DragDropPayload) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    // An item of the shelf on its way out of the island: back over it, or let
    // go on it, it is no file being brought in.
    if (Tools.dragOut) return;
    if (this.dragLeaveTimer != null && e.type !== "leave") {
      window.clearTimeout(this.dragLeaveTimer);
      this.dragLeaveTimer = null;
    }
    // Tauri's own drag events say where the pointer is (Linux, where the page
    // hears no mouse during a drag); Windows has the cursor poll (onCursor).
    if (e.position && e.type !== "leave") {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.islandRect();
      this.updateDropTarget(e.position.x / dpr - rect.x, e.position.y / dpr - rect.y);
    }
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        // With the tools on screen the file is for the shelf: the view stays,
        // and the shelf's card lights up (core/tools.ts: shelfTakesDrop).
        if (shelfTakesDrop(State.mode, State.view)) {
          Tools.dropOver = true;
          State.notify();
          break;
        }
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(...this.inStage(State.mouseInIsland.x, State.mouseInIsland.y));
        this.alert("upload");
        break;
      }
      case "leave": {
        State.dropSessionTarget = null;
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        // It was over the shelf: the card goes dark again, and that is all.
        if (Tools.dropOver) {
          Tools.dropOver = false;
          State.notify();
          break;
        }
        // The island stays open briefly for recovery, but auto-exits upload mode
        // if the drop occurred outside or the drag was aborted.
        UploadSeq.exitZone();
        State.notify();
        if (this.dragLeaveTimer != null) window.clearTimeout(this.dragLeaveTimer);
        this.dragLeaveTimer = window.setTimeout(() => {
          this.dragLeaveTimer = null;
          if (!State.fileDragOver && State.view === "upload") {
            this.setView(State.defaultView());
            if (!this.wasInIsland) {
              this.fsm.mouseLeft();
            }
          }
        }, 800);
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        // Let go with the tools on screen: every file goes on the shelf, and
        // Liv takes none of them in.
        if (Tools.dropOver) {
          Tools.dropOver = false;
          void this.shelve(e.paths ?? []);
          State.notify();
          return;
        }
        // Let go over one of the sessions on the drop card: into its prompt.
        const target = State.dropSessionTarget;
        State.dropSessionTarget = null;
        if (target && e.paths?.length) {
          this.dropIntoSession(target, e.paths);
          return;
        }
        const path = e.paths?.[0];
        if (!path) {
          this.setView(State.defaultView());
          return;
        }
        this.takeFile(path);
        break;
      }
    }
  }

  /**
   * Files dropped on the shelf, one after the other in the order they came:
   * the last is the one on top. Rust takes each only because a drop just
   * delivered it (src-tauri/src/shelf.rs).
   */
  private async shelve(paths: string[]) {
    for (const path of paths) await Bridge.shelfAdd(path);
  }

  /**
   * A point of the island in the drop sequence's own drawing, which stands in
   * the middle of an island made wider or taller (layout.ts: stageOffset).
   */
  private inStage(x: number, y: number): [number, number] {
    const stage = stageOffset(this.shape);
    return [x - stage.x, y - stage.y];
  }

  /** The session pill under the pointer on the drop card (island points), if any. */
  private updateDropTarget(x: number, y: number) {
    const targets = State.view === "upload" && State.fileDragOver && !UploadSeq.dropped ? dropTargets(State.tasks) : [];
    const i = targets.length > 0 ? dropTargetAt(...this.inStage(x, y), targets.length) : null;
    State.dropSessionTarget = i == null ? null : targets[i].id;
  }

  /**
   * A file let go over a session on the drop card (SessionDrop.send): the
   * island folds, Rust brings the session's window forward and pastes the
   * paths there. When it can only copy them, a note says so.
   */
  private dropIntoSession(taskId: string, paths: string[]) {
    const task = State.tasks.find((x) => x.id === taskId);
    UploadSeq.deactivate();
    this.setView(State.defaultView());
    this.collapse();
    if (!task?.sessionId) return;
    void Bridge.log(`drop: ${paths.length} file(s) into ${task.name}`);
    void Bridge.dropIntoSession(task.sessionId, task.sessionCwd ?? null, paths).then((outcome) => {
      if (outcome === "pasted") {
        Sound.play("send");
        return;
      }
      Sound.play("error");
      if (outcome !== "copied") return;
      State.noteMessage = t("Copied: paste it into the session's terminal.");
      this.alert("note");
      window.setTimeout(() => {
        if (State.mode === "expanded" && State.view === "note") this.collapse();
      }, 4000);
    });
  }

  /**
   * Liv takes the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private takeFile(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    Sound.play("approve");

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        // Cancelled (or replaced by another drop) while the copy was running.
        if (State.droppedFile?.path !== path) return;
        State.droppedFile = { name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        if (State.droppedFile?.path !== path) return;
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => {
          // Only the note still on screen: setView would reopen a folded island
          // and replace a view the user opened since.
          if (State.mode === "expanded" && State.view === "note") this.setView(State.defaultView());
        }, 2400);
      });
  }

  /** "Cancel" on the dropped file: forget it, so the chat does not pick it up. */
  private discardDrop() {
    State.droppedFile = null;
    this.setView(State.defaultView());
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once the figure has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    // The bar and the percentage follow the same eased curve as the figure.
    State.uploadProgress = uploadProgressCurve(p);
    if (State.view === "uploading") this.views.get("uploading")?.sync();

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  /** The closed island stays on screen (anything but "hidden"). */
  private get closedShows(): boolean {
    return closedIsland(State.settings.closedIsland) !== "hidden";
  }

  /**
   * The open island as Settings shapes it: its width, what it adds to every
   * view's height, its corners and its opacity, each brought into its range.
   */
  private get shape(): Appearance {
    const s = State.settings;
    const memo = this.shapeMemo;
    if (
      memo && memo.w === s.islandWidth && memo.h === s.islandExtraHeight &&
      memo.r === s.islandRadius && memo.o === s.islandOpacity
    ) {
      return memo.value;
    }
    const value = appearance(s);
    this.shapeMemo = { w: s.islandWidth, h: s.islandExtraHeight, r: s.islandRadius, o: s.islandOpacity, value };
    return value;
  }

  private targetSize(): { w: number; h: number; r: number } {
    const shape = this.shape;
    const r = cornerRadius(shape, islandShape(State.mode, this.closedShows));
    if (State.mode === "hidden" && this.closedShows) {
      return { w: this.closedW, h: CLOSED_H, r };
    }
    let { w, h } = islandSize(State.mode, State.view, State.chatHistory.length, shape);
    if (State.mode === "expanded") {
      // A view that needs more room for what it shows now: options to pick
      // from, a long command to approve, the chat's model picker. The height
      // Settings adds goes on top of it, as on every view.
      const picker = State.view === "question" && State.pendingApproval?.questions ? QUESTION_PICKER_H : null;
      const own = this.views.get(State.view)?.height?.() ?? picker;
      if (own != null) h = openHeight(shape, own);
    }
    return { w, h, r };
  }

  /**
   * Settings changed the open island's shape (State.settings has it): its
   * opacity and what the views lay themselves out with follow at once, and a
   * new size or new corners are reached with the island's usual motion.
   * Called with every other setting (applySettings), and by
   * previewAppearance while a slider of Settings → Appearance is dragged.
   */
  applyAppearance() {
    const shape = this.shape;
    this.islandEl.style.setProperty("--island-opacity", String(shape.opacity));
    this.islandEl.style.setProperty("--island-extra-h", `${shape.extraHeight}px`);
    const stage = stageOffset(shape);
    this.uploadCanvas.setRoom(shape.width, openHeight(shape, USC.ISL_H), stage.x, stage.y);
    const key = shapeKeyOf(shape);
    if (key === this.shapeKey) return;
    this.shapeKey = key;
    const { w, h } = this.targetSize();
    this.animateGeometry(w < this.width.value || h < this.height.value);
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = `translateX(-50%)`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.miniGrid.style.left = `${w - 40 - 14.5}px`;
    this.miniGrid.style.top = `${hh / 2 - 14.5}px`;
    this.clockEl.style.height = `${hh}px`;
    // The drop sequence's layer is as wide as the open island: centred on
    // the island while that grows to it.
    this.uploadCanvas.el.style.left = `${(w - this.shape.width) / 2}px`;

    const rect = this.rectOf(w, hh);
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /**
   * Island rect in the page's coordinates (origin top-left of the panel:
   * 720×320, or more for an island made wider or taller, appearance.ts:
   * panelSize). CSS px at every island size: Rust zooms the page with the
   * window (core/scale.ts), so the panel is always that wide in here.
   */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    return this.rectOf(this.width.value, this.height.value);
  }

  /** An island of `w` × `h` in the page: glued to the top edge, in the middle. */
  private rectOf(w: number, h: number): { x: number; y: number; w: number; h: number } {
    const viewportW = window.innerWidth > 0 ? window.innerWidth : panelSize(this.shape).w;
    return { x: (viewportW - w) / 2, y: 0, w, h };
  }

  /** Whether the pointer, where it was last reported, is on `rect` or within the margin around it. */
  private pointerIn(rect: { x: number; y: number; w: number; h: number }): boolean {
    const { x, y } = this.cursor;
    return x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;
  }

  /**
   * The pointer is on Liv's head, on the open island, where Liv is the
   * island's own figure (the drop sequence draws another).
   */
  private pointerOnLiv(): boolean {
    if (State.mode !== "expanded" || this.uploadActive || State.petAway) return false;
    return onHead(
      State.mouseInIsland.x - this.botCx.value,
      State.mouseInIsland.y - this.botCy.value,
      this.botSize.value / CANVAS_PER_SLOT,
      this.engine.feet,
    );
  }

  /** The click landed on a control of the card on screen: a button, a field, a link. */
  private onControl(target: EventTarget | null): boolean {
    for (let el = target as Element | null; el && el !== this.islandEl; el = el.parentElement) {
      if (CONTROL_TAGS.has(el.tagName)) return true;
    }
    return false;
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish folding, then shrink the window to it — to the
      // closed island, or to the wake strip when that shows nothing: from
      // there nothing polls the cursor at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        this.sendCollapsedSize(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      this.collapsedTo = { w: 0, h: 0 };
      void Bridge.setCollapsed(false);
    }
  }

  /** The pointer is on the folded window (Rust's `closed-hover`): the island wakes. */
  wakeFromClosed() {
    if (State.mode !== "hidden") return;
    Sound.resume();
    this.fsm.mouseEntered();
  }

  /** Tells Rust the folded window's size: the closed island's, or none (the strip). */
  private sendCollapsedSize(force = false) {
    const size = this.closedShows ? { w: this.closedW, h: CLOSED_H } : { w: 0, h: 0 };
    if (!force && size.w === this.collapsedTo.w && size.h === this.collapsedTo.h) return;
    this.collapsedTo = size;
    if (size.w > 0) void Bridge.setCollapsed(true, size.w, size.h);
    else void Bridge.setCollapsed(true);
  }

  /**
   * What the closed island shows, redrawn when it changes (the minute, the
   * song, the plan): a new width animates the island and, once folded,
   * resizes the window to it.
   */
  private updateClosed() {
    const style = closedIsland(State.settings.closedIsland);
    const track = Spotify.state.track;
    const content: ClosedContent | null = State.mode === "hidden" || this.collapsed
      ? closedContent(style, {
        now: new Date(),
        locale: language(),
        planUsage: State.planUsage,
        music: State.spotifyPlaying && track ? { title: track.title, artist: track.artist } : null,
      })
      : null;
    const key = content ? `${style}|${content.text}|${content.dot ?? ""}|${content.note}` : style;
    const shown = State.mode === "hidden" && this.closedShows;
    this.closedEl.classList.toggle("on", shown && content != null);
    if (key === this.closedKey) return;
    this.closedKey = key;
    this.closedText.textContent = content?.text ?? "";
    this.closedEl.classList.toggle("note", content?.note === true);
    this.closedDot.style.display = content?.dot ? "" : "none";
    if (content?.dot) this.closedDot.style.background = content.dot;
    // Measured as drawn: the font and the language decide the width.
    const extras = (content?.dot ? 12 : 0) + (content?.note ? 16 : 0);
    const w = closedWidth(content ? this.closedText.scrollWidth : 0, extras);
    if (w !== this.closedW) {
      this.closedW = w;
      if (State.mode === "hidden") {
        this.animateGeometry(w < this.width.value);
        if (this.collapsed) this.sendCollapsedSize();
      }
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // Folded, the window is only the closed island (or the wake strip): the
    // pointer coming onto it is all there is to hear, and it wakes the island.
    const wake = () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    };
    this.wakeStrip.addEventListener("mouseenter", wake);
    this.root.addEventListener("mouseover", () => {
      if (this.collapsed) wake();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      // The other button, on Liv's head on the open island: its wardrobe.
      // Anywhere else it does nothing, as before.
      if (e.button === 2 && this.pointerOnLiv() && !this.onControl(e.target)) {
        this.fsm.userInteracted();
        this.toggleWardrobe();
        return;
      }
      // Only the main button opens the island or counts as using it.
      if (e.button !== 0) return;
      Sound.resume();
      // A click makes a hover-opened island an ordinary open one.
      this.fsm.userInteracted();
      if (State.mode !== "expanded") {
        this.fsm.click();
      } else if (this.pointerOnLiv() && !this.onControl(e.target)) {
        // A click on Liv itself: it minds, from the side it came from.
        this.engine.poke(State.mouseInIsland.x < this.botCx.value ? -1 : 1);
        // Held and moved from here, Liv is picked up (onCursor).
        this.press = { ...this.cursor };
        this.ensureRunning();
      }
    });
    // Let go before it moved that far: a click, and nothing more.
    window.addEventListener("mouseup", () => {
      this.press = null;
    });

    // Only keys typed into the island itself land here, never Escape typed in
    // a terminal — so it may fold a waiting card away, as Escape in the notch
    // does on macOS.
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (State.mode === "expanded") {
        if (State.pendingApproval) this.foldApproval();
        else if (!State.isPinned) this.collapse();
      } else if (State.mode === "peek") {
        // Liv goes back in.
        this.fsm.forcePetit();
      }
    });

    void onDragDrop((e) => this.onDragDrop(e));

    // Rust resized the window (the island was made wider in Settings, or the
    // window folded or grew back): the island is in the middle of another
    // width, and Rust hears where, even when nothing in the page is moving.
    window.addEventListener("resize", () => this.applyGeometry());

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /**
   * Pointer on/off the island as the compositor sees it (Linux only). Null
   * until the first report, so a platform that never sends it is not gated.
   */
  private pointerInside: boolean | null = null;

  setPointerInside(inside: boolean) {
    this.pointerInside = inside;
  }

  /** Cursor in the page's coordinates (CSS px), like islandRect(). */
  onCursor(x: number, y: number) {
    // WebKitGTK can deliver a mousemove after the pointer has left the layer
    // surface; trusting it re-enters the island and the auto-close never runs.
    if (this.pointerInside === false) {
      x = -10_000;
      y = -10_000;
    }
    this.cursor = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };
    // Liv's eyes follow a pointer that is near (robot/look.ts says how near).
    this.engine.lookAt(
      State.mode === "hidden" ? null : [State.mouseInIsland.x - this.botCx.value, State.mouseInIsland.y - this.botCy.value],
    );
    // Left resting on its head, it is won over (robot/react.ts says when).
    this.engine.hover(this.pointerOnLiv());
    // Pressed on Liv and dragged: it leaves the island under the pointer.
    // Taken out by hand, it is not called back for the card that is open.
    if (this.press && isDrag(this.press, this.cursor)) {
      this.press = null;
      this.summoned = false;
      void this.pet.outing.pickUp();
    }

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(...this.inStage(State.mouseInIsland.x, State.mouseInIsland.y));
      this.updateDropTarget(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland = this.pointerIn(rect);

    // Recorded before the state machine hears of it: a transition it makes
    // right away (open on hover) reads where the pointer is, and must not see
    // the pointer as still outside.
    const wasIn = this.wasInIsland;
    this.wasInIsland = inIsland;
    if (inIsland && !wasIn) {
      this.fsm.mouseEntered();
    }
    if (!inIsland && wasIn) {
      this.fsm.mouseLeft();
    }

    this.ensureRunning();
  }

  /**
   * The window left the screen for a full-screen app (Rust keeps it off-screen
   * until that app leaves), or came back. Away, the state, the cards and the
   * timers go on as usual (a card already up still waits for its answer; a new
   * request goes back to its terminal, hooks.ts), but nobody sees the island,
   * so nothing is drawn: the frame loop only finishes what is settling, and
   * the CSS animations pause.
   */
  setParked(parked: boolean) {
    if (State.parked === parked) return;
    State.parked = parked;
    this.root.classList.toggle("parked", parked);
    this.dirty = true;
    this.ensureRunning();
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    // Kept running even while the drop canvas is up, so the island's own figure
    // is already in the right place the moment the canvas fades out.
    const scene = this.scene();
    this.drawBot(dt, scene);

    const uploadActive = this.uploadActive;
    // A file over the drop card: the sessions it could go to, on the right.
    const listing = uploadActive && State.view === "upload" && State.fileDragOver && !UploadSeq.dropped;
    this.sessionDrop.sync(listing);
    this.uploadCanvas.textRight = listing && dropTargets(State.tasks).length > 0 ? DROP_TEXT_RIGHT_WITH_LIST : this.uploadCanvas.defaultTextRight;
    // The sequence draws a Liv of its own, in what the island's has on.
    this.uploadCanvas.outfit = this.wearing;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    // A ticker scroll that loses its frames freezes mid-way, rows overlapping.
    const viewAnimating = this.views.get(State.view)?.tick?.(nowMs) === true;
    if (UploadSeq.isActive) this.stepSequence();
    const countingDown = this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    const botMoving = !this.botCx.settled || !this.botCy.settled || !this.botSize.settled;
    // Closed, only the folding — and Liv reaching its place in the closed
    // island and taking its state's lights and badge there.
    // The same, and less, while the window is parked off-screen (core/frames.ts).
    // Open, Liv breathes: it is changing all the time and the loop goes on.
    const busy = needsFrame(scene, {
      settling,
      botMoving,
      // On its way out of the island, Liv has still to react to what it came out for.
      // Out on the desktop, nothing of it moves here.
      robotChanging: !State.petAway && (this.engine.changing || (this.pocket?.arriveMs ?? 0) > 0),
      uploading: UploadSeq.isActive,
      viewAnimating,
      countingDown,
    });
    this.syncLife(scene);

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  /** Where the island is, for what may move in it (core/frames.ts). */
  private scene(): FrameScene {
    return {
      mode: State.mode,
      closedRobot: closedIsland(State.settings.closedIsland) === "robot",
      parked: State.parked,
      paused: State.paused,
    };
  }

  /**
   * Closed, compact or out in its pocket, Liv blinks or glances aside every few seconds: one
   * timer, armed here and nowhere else, plays the next sign of life and wakes
   * the frame loop for it. Open, parked or paused there is no timer; nor
   * while Liv is out on the desktop.
   */
  private syncLife(scene: FrameScene) {
    if (!livesOnTimer(scene) || State.petAway) {
      if (this.lifeTimer != null) window.clearTimeout(this.lifeTimer);
      this.lifeTimer = null;
      return;
    }
    if (this.lifeTimer != null) return;
    const next = nextLife(this.random);
    this.lifeTimer = window.setTimeout(() => {
      this.lifeTimer = null;
      this.engine.act(next.kind);
      this.ensureRunning();
    }, next.inMs);
  }

  private updateBotTargets() {
    let p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress, this.shape);
    // The closed island with Liv in it.
    if (State.mode === "hidden" && closedIsland(State.settings.closedIsland) === "robot") {
      p = { cx: this.width.value / 2, cy: this.height.value / 2, diameter: CLOSED_BOT_D, opacity: 1 };
    }
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter * CANVAS_PER_SLOT;

    // The drop canvas draws its own figure; two of them would overlap. And
    // while Liv is out on the desktop its slot is empty: no figure, no glow.
    const visible = p.opacity > 0 && !this.uploadActive && !State.petAway;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    const open = State.mode === "expanded" && State.view !== "uploading" && !this.uploadActive;
    if ((open || State.mode === "peek") && !State.petAway) {
      const d = p.diameter;
      const state = this.figureState();
      const color = botGlowColor(state);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      // Behind Liv in its pocket once the pocket is open around it: the glow
      // is wider than the island while that is still growing.
      const around = open || Math.abs(this.height.value - PEEK_H) < POCKET_GLOW_WITHIN;
      this.botGlow.style.opacity = String(around ? botGlowOpacity(state) : 0);
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number, scene: FrameScene) {
    // Out on the desktop Liv is drawn in its own window (src/pet): what it
    // was doing for itself here ends, and nothing of it is stepped or painted.
    if (State.petAway) {
      this.engine.calm();
      // It comes back in what it wore out there.
      this.engine.setOutfit(this.wearing, false);
      return;
    }
    this.showState(dt);
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const dpr = canvasRatio(window.devicePixelRatio, State.settings.islandScale);
    // Drawn at the current ratio, so a bitmap sized for another monitor's
    // (or another island size's) would show the figure too big and cut, or too small.
    if (this.canvasPx !== w || this.canvasDpr !== dpr) {
      this.canvasPx = w;
      this.canvasDpr = dpr;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(w * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${w}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - w / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - w / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    // A new Liv waits: over an idle figure, the blue shell and the arrow
    // badge (whats-new.ts). Any other state comes first.
    this.engine.setUpdateHint(this.updateHintOn() ? UPDATE_BLUE_RGB : null);
    // While a plan card is open the shell wears the plan's colour, like its pill.
    // At rest it wears its pill's colour; once something happens it goes back
    // to its own, and the state shows on the antenna and in the eyes.
    const resting = this.engine.state === "idle";
    // In the chat it wears the colour of who answers, whatever its state, and
    // goes from one provider's to the next's without a jump (core/chat-look.ts).
    const answering = chatShell(State.mode, State.view, State.settings.chatProvider);
    this.chatColor = answering ? (this.chatColor ? towards(this.chatColor, hexToRGB(answering), dt) : hexToRGB(answering)) : null;
    this.engine.bodyColor = planCardOpen()
      ? hexToRGB(openPlanColor())
      : (this.chatColor ??
        (this.engine.showsUpdateHint
          ? UPDATE_BLUE_RGB
          : focus?.isIntegration && resting
            ? hexToRGB(focus.color)
            : null));
    // The whole body in the open island's cards and in its pocket, the head
    // alone anywhere else; and it breathes only on the open island.
    const roomy = State.mode === "expanded" || State.mode === "peek";
    this.engine.setLimbs(roomy && modelFor(this.botSize.target / CANVAS_PER_SLOT) === "body");
    this.engine.alive = breathes(scene);
    // Music on the Spotify pill's card: Liv dances to it, its lights in the pill's colour.
    const dancing = focus != null && shouldDance({
      playing: State.spotifyPlaying,
      inFront: focus.id === SPOTIFY_ID && !planCardOpen() && !this.uploadActive,
      mode: scene.mode,
      view: State.view,
      parked: scene.parked,
      paused: scene.paused,
      state: this.engine.state,
    });
    if (dancing) this.engine.danceColor = hexToRGB(focus.color);
    this.engine.setDancing(dancing);
    // What it wears: put on where somebody sees it, simply on anywhere else.
    this.engine.setOutfit(this.wearing, livInSight(scene));

    this.engine.update(dt);
    // Cleared in device pixels, the whole canvas. At a fractional scale (150 %)
    // the canvas is a whole number of pixels but `w * dpr` is not: clearing in
    // CSS units would leave the last row half-cleared, and whatever was drawn
    // there would pile up into a coloured bar.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.botCanvas.width, this.botCanvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.engine.draw(ctx, w, w);
  }

  /** The state Liv wears: what it came out of the island for, else the pill's in front. */
  private figureState(): BotStateName {
    return this.pocket?.look ?? State.effectiveState;
  }

  /**
   * Tells Liv its state. On its way out of the island it keeps the one it
   * had; once out, it takes the pocket's and plays its entrance — again when
   * it already wore it.
   */
  private showState(dt: number) {
    const pocket = this.pocket;
    if (pocket && pocket.arriveMs > 0) {
      pocket.arriveMs -= dt * 1000;
      if (pocket.arriveMs > 0) return;
    }
    this.engine.setState(this.figureState(), pocket?.enters === true);
    if (pocket) pocket.enters = false;
  }

  /**
   * Draws the countdown bar; true while it is in view, the only time it needs
   * frames. Before that nothing of it is drawn and the loop may stop: a timer
   * wakes it for the moment the bar comes into view.
   */
  private updateCountdown(nowMs: number): boolean {
    // The state machine's own deadline, so the bar follows an auto-close delay
    // edited while the countdown runs.
    const dueAt = State.mode === "expanded" && !State.isPinned ? this.fsm.homeCollapseDueAt : null;
    const autoClose = this.fsm.homeToPetitDelay;
    const remaining = dueAt == null ? 0 : (dueAt - nowMs) / 1000;
    const share = dueAt == null ? 0 : countdownShare(remaining, autoClose);
    this.countdown.style.width = `${share * 160}px`;

    // Counting down with the bar still out of view: the loop is woken for it.
    const wakeFor = dueAt != null && share === 0 && remaining > 0 ? dueAt : null;
    if (wakeFor !== (this.countdownWake?.dueAt ?? null)) {
      if (this.countdownWake) window.clearTimeout(this.countdownWake.timer);
      this.countdownWake = wakeFor == null ? null : {
        dueAt: wakeFor,
        timer: window.setTimeout(() => {
          this.countdownWake = null;
          this.ensureRunning();
        }, Math.max(0, (remaining - countdownWindow(autoClose)) * 1000)),
      };
    }
    return share > 0;
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const live = State.mode === "expanded";
    this.contentEl.style.opacity = live ? "1" : "0";
    // While the drop sequence owns the body its buttons are painted on the canvas
    // underneath, so only the header may keep taking clicks up here.
    this.contentEl.style.pointerEvents = live && !this.uploadActive ? "auto" : "none";
    this.header.el.style.pointerEvents = live ? "auto" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    // The chat and the launch card are the views with a text field, so they
    // are the only time the island is allowed to take keyboard focus.
    if (live && this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView != null && TYPING_VIEWS.has(this.lastSyncedView);
      this.lastSyncedView = State.view;
      if (TYPING_VIEWS.has(State.view)) {
        const view = State.view;
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get(view)?.focus?.(), 120);
      } else if (wasChat) {
        void Bridge.focusWindow(false);
      }
    }

    // Compact mini grid
    const showGrid = State.mode === "compact";
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    if (showGrid) {
      const others = State.otherTasks.slice(0, 4);
      // The island's size is in the key: the minis are painted for it.
      const scale = islandScale(State.settings.islandScale);
      const key = `${scale}|${others.map((t) => `${t.id}:${t.color}`).join("|")}`;
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(miniRobot(t.color, 13, scale));
        }
      }
    }

    // Compact Claude plan indicator
    const showPlan = claudeCompactPillVisible();
    this.compactPlan.style.opacity = showPlan ? "1" : "0";
    this.compactPlan.style.pointerEvents = showPlan ? "auto" : "none";
    if (showPlan) {
      const others = State.otherTasks.slice(0, 4);
      this.compactPlan.style.right = others.length > 0 ? "58px" : "20px";
      const pct = dominantPct(State.planUsage);
      const color = planColor(pct);
      this.compactPlan.style.setProperty("--plan", color);
      this.compactPlanLabel.textContent = pct != null ? `${Math.round(pct)}%` : "—";
    }

    this.updateClock();
  }

  /** The clock sits in the middle of the compact island, where the notch is on a Mac. */
  private updateClock() {
    this.updateClosed();
    const on = State.mode === "compact" && State.settings.showClock;
    this.clockEl.style.opacity = on ? "1" : "0";
    if (!on) return;
    const now = new Date();
    const date = now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const text = `${date}  ${time}`;
    if (this.clockEl.textContent !== text) this.clockEl.textContent = text;
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    this.today = new Date();
    this.applyAppearance();
    // The closed island may have changed: what it shows, or whether it shows.
    this.closedKey = "";
    this.updateClosed();
    if (State.mode === "hidden") {
      this.animateGeometry(true);
      if (this.collapsed) this.sendCollapsedSize();
    }
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.openOnHover = State.settings.openOnHover;
    State.notify();
    // One timer for the life of the window; a minute is the clock's finest tick.
    this.clockTimer ??= window.setInterval(() => this.updateClock(), 10_000);
  }
}
