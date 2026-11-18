// Liv's own window on the desktop (pet.html): draws Liv as the island says it
// looks, and turns the pointer into what it does to Liv — a click annoys it,
// three make it dizzy, a rest wins it over, a drag carries it, a double click
// sends it home.
//
// The window knows nothing of agents: what Liv shows comes from the island
// (PET_EVENTS.look), where the window is and where the pointer is from Rust
// (src-tauri/src/pet.rs). One frame loop, on demand: it runs while something
// of Liv moves and stops with it. Left alone Liv is a still picture that
// blinks on one timer, and asleep it is a still picture with no timer at all.

import { Bridge, IS_TAURI, emitToWindow, onEvent } from "../core/bridge";
import { guardPage } from "../core/guards";
import { nextLife } from "../robot/life";
import { HOVER_FLOAT, Robot } from "../robot/robot";
import { isDrag, type Point } from "./drag";
import { petLivesOnTimer, petNeedsFrame, type PetScene } from "./frames";
import { hovers, nextChangeAt, pointerNear, sleeps, type Presence } from "./rest";
import { PET_R, PET_WINDOW, hitShape, onPetHead, onShape } from "./shape";
import { AT_REST, travelPose, type TravelPose } from "./travel";
import { HELLO_FRESH_MS, ISLAND_WINDOW, PET_EVENTS, type PetLook, type PetTravel } from "./wire";

/** The canvas is never painted at more than this many pixels per page px. */
const MAX_RATIO = 4;

/** A way the window is on: when it set off (performance.now()), and what Rust said of it. */
interface Way extends PetTravel {
  startedAt: number;
}

class PetView {
  private engine = new Robot();
  private canvas: HTMLCanvasElement;
  private shape = hitShape();

  /** The window is on screen. In a plain browser there is no Rust to say so: it always is. */
  private shown = !IS_TAURI;
  /** What the island last said Liv looks like; null until it has. */
  private look: PetLook | null = null;
  /** The greeting last played (PetLook.hello). */
  private hello = 0;

  /** The pointer, in the window's page px; null while nobody knows where it is. */
  private pointer: Point | null = null;
  /** When something last happened to Liv, on the performance.now() clock (rest.ts: quietMs). */
  private touchedAt = performance.now();
  private asleep = false;
  private way: Way | null = null;

  /** Where the pointer pressed on Liv: moved far enough from there, it is a drag. */
  private press: Point | null = null;

  private running = false;
  private lastFrame = 0;
  /** The pixel ratio the canvas was sized for. */
  private ratio = 0;
  /** The one timer of Liv's small signs of life while it stands still (frames.ts: petLivesOnTimer). */
  private lifeTimer: number | null = null;
  /** The one timer for what changes by itself: the hover ending, then sleep (rest.ts: nextChangeAt). */
  private restTimer: { dueAt: number; timer: number } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.style.width = `${PET_WINDOW.w}px`;
    canvas.style.height = `${PET_WINDOW.h}px`;
    this.engine.float = HOVER_FLOAT;
    this.engine.setLimbs(true);
    this.wireInput();
  }

  async start() {
    // The zoom follows the island's size (Settings → Island size): Rust
    // corrects it when the page's pixel ratio is not what it should be.
    const check = () => void Bridge.petFitZoom(window.devicePixelRatio || 1);
    const watchRatio = () => {
      window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener?.(
        "change",
        () => {
          watchRatio();
          check();
          this.ensureRunning();
        },
        { once: true },
      );
    };
    watchRatio();
    check();
    void Bridge.petShape(this.shape);

    await onEvent<PetLook>(PET_EVENTS.look, (look) => this.onLook(look));
    await onEvent<Point>(PET_EVENTS.cursor, (p) => this.onPointer(p));
    // Listened to before Rust is asked where things stand: what it answers
    // counts only if no event came after it.
    let heard = false;
    await onEvent<boolean>(PET_EVENTS.shown, (shown) => {
      heard = true;
      this.setShown(shown);
    });
    const shown = await Bridge.petShown();
    if (shown != null && !heard) this.setShown(shown);
    await onEvent<PetTravel>(PET_EVENTS.travel, (travel) => this.setOff(travel));
    await onEvent<boolean>(PET_EVENTS.held, (held) => this.setHeld(held));
    // The island may have spoken before this page listened: it says it again.
    await emitToWindow(ISLAND_WINDOW, PET_EVENTS.ready);
    this.ensureRunning();
  }

  // ── What the island and Rust say ────────────────────────────────────────────

  private onLook(look: PetLook) {
    const before = this.look;
    this.look = look;
    const replay = before != null && look.beat !== before.beat;
    // A change of state is something happening to it, and so is being dressed: it wakes for it.
    if (!before || before.state !== look.state || before.outfit !== look.outfit || replay) this.touch();
    // What it already had on when it came into sight is simply on.
    this.engine.setOutfit(look.outfit, this.shown && before != null);
    this.engine.bodyColor = look.shell;
    this.engine.setUpdateHint(look.hint);
    this.engine.setState(look.state, replay);
    if (look.hello !== this.hello) {
      this.hello = look.hello;
      if (Date.now() - look.hello < HELLO_FRESH_MS) {
        this.touch();
        this.engine.greet();
      }
    }
    this.ensureRunning();
  }

  private setShown(shown: boolean) {
    if (shown === this.shown) return;
    this.shown = shown;
    if (shown) {
      // The two pages may have started in either order: ask again if needed.
      if (!this.look) void emitToWindow(ISLAND_WINDOW, PET_EVENTS.ready);
      this.touch();
      this.ensureRunning();
      return;
    }
    // Nobody sees it: whatever was going on is over, and nothing is left running.
    this.way = null;
    this.press = null;
    this.pointer = null;
    this.engine.calm();
    this.engine.lookAt(null);
    this.syncTimers(this.scene(performance.now()), performance.now());
    // The window comes back somewhere else, later: not with this picture in it.
    const ctx = this.canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  /** The window sets off on a way: Liv carries itself accordingly, for as long as it takes. */
  private setOff(travel: PetTravel) {
    this.way = { ...travel, startedAt: performance.now() };
    this.touch();
    this.ensureRunning();
  }

  /** The pointer picked Liv up, or let go of it. */
  private setHeld(held: boolean) {
    this.press = null;
    this.touch();
    if (held) this.engine.hold();
    else this.engine.land();
    this.ensureRunning();
  }

  // ── The pointer ─────────────────────────────────────────────────────────────

  private onPointer(p: Point | null) {
    this.pointer = p;
    if (this.near()) this.touch();
    // Left resting on its head, it is won over (robot/react.ts says when).
    this.engine.hover(p != null && !this.way && onPetHead(p.x, p.y));
    this.ensureRunning();
  }

  /** The pointer is near (rest.ts). */
  private near(): boolean {
    const p = this.pointer;
    return pointerNear(p ? Math.hypot(p.x - PET_WINDOW.cx, p.y - PET_WINDOW.cy) : null);
  }

  /** Something happened to Liv: it wakes if it slept, and hovers for a while. */
  private touch() {
    this.touchedAt = performance.now();
    this.rest(this.touchedAt);
  }

  private wireInput() {
    // From the canvas's own corner: the window's, since the canvas fills it.
    const at = (e: MouseEvent): Point => ({ x: e.offsetX, y: e.offsetY });
    const onLiv = (e: MouseEvent) => {
      const p = at(e);
      return onShape(p.x, p.y, this.shape);
    };

    this.canvas.addEventListener("pointerdown", (e) => {
      if (this.way || !onLiv(e)) return;
      // The other button: its wardrobe opens in the island, and Liv stays here to try things on.
      if (e.button === 2) {
        this.touch();
        void emitToWindow(ISLAND_WINDOW, PET_EVENTS.wardrobe);
        this.ensureRunning();
        return;
      }
      if (e.button !== 0) return;
      this.press = at(e);
      // The page keeps the pointer while the button is held, wherever it goes.
      this.canvas.setPointerCapture?.(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.press || !isDrag(this.press, at(e))) return;
      // A drag: Rust carries the window from here on, and says so (PET_EVENTS.held).
      this.press = null;
      void Bridge.petGrab();
    });
    this.canvas.addEventListener("pointerup", (e) => {
      if (!this.press) return;
      this.press = null;
      // A click on Liv: it minds, from the side it came from.
      this.touch();
      this.engine.poke(e.offsetX < PET_WINDOW.cx ? -1 : 1);
      this.ensureRunning();
    });
    this.canvas.addEventListener("pointercancel", () => {
      this.press = null;
    });
    this.canvas.addEventListener("dblclick", (e) => {
      if (onLiv(e)) void emitToWindow(ISLAND_WINDOW, PET_EVENTS.home);
    });

    // In a plain browser nothing polls the cursor: the page follows it itself.
    if (!IS_TAURI) {
      window.addEventListener("mousemove", (e) => {
        const box = this.canvas.getBoundingClientRect();
        this.onPointer({ x: e.clientX - box.left, y: e.clientY - box.top });
      });
      document.addEventListener("mouseleave", () => this.onPointer(null));
    }
  }

  // ── Rest ────────────────────────────────────────────────────────────────────

  private presence(now: number): Presence {
    return { near: this.near(), quietMs: now - this.touchedAt };
  }

  /** Falls asleep or wakes, as things stand at `now` (rest.ts). */
  private rest(now: number) {
    const asleep = this.shown && sleeps(this.presence(now));
    if (asleep === this.asleep) return;
    this.asleep = asleep;
    this.engine.sleep(asleep);
    // Asleep, Rust looks for the pointer only a few times a second.
    void Bridge.petAsleep(asleep);
  }

  private scene(now: number): PetScene {
    return { shown: this.shown, hovering: !this.asleep && hovers(this.presence(now)), asleep: this.asleep };
  }

  /**
   * The two timers, armed here and nowhere else. One plays Liv's next small
   * sign of life while it stands still; the other wakes the frame loop for
   * the moment the hover ends, then for the moment it falls asleep. Out of
   * sight there is neither, and asleep neither.
   */
  private syncTimers(scene: PetScene, now: number) {
    if (!petLivesOnTimer(scene)) {
      if (this.lifeTimer != null) window.clearTimeout(this.lifeTimer);
      this.lifeTimer = null;
    } else if (this.lifeTimer == null) {
      const next = nextLife(Math.random);
      this.lifeTimer = window.setTimeout(() => {
        this.lifeTimer = null;
        this.engine.act(next.kind);
        this.ensureRunning();
      }, next.inMs);
    }

    const quiet = scene.shown ? nextChangeAt(this.presence(now)) : null;
    const dueAt = quiet == null ? null : this.touchedAt + quiet;
    if (dueAt === (this.restTimer?.dueAt ?? null)) return;
    if (this.restTimer) window.clearTimeout(this.restTimer.timer);
    this.restTimer = dueAt == null ? null : {
      dueAt,
      timer: window.setTimeout(() => {
        this.restTimer = null;
        this.ensureRunning();
      }, Math.max(0, dueAt - now)),
    };
  }

  // ── Frames ──────────────────────────────────────────────────────────────────

  private ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    const dt = Math.min(0.05, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;

    if (this.near()) this.touchedAt = now;
    this.rest(now);
    const scene = this.scene(now);
    const pose = this.poseAt(now);

    const engine = this.engine;
    engine.alive = scene.shown && scene.hovering;
    engine.fly(pose.lean, pose.trail);
    // On its way its eyes are ahead; standing, on the pointer while it is near.
    engine.restGaze = pose.gaze;
    const p = this.pointer;
    engine.lookAt(p && !this.way && !this.asleep ? [p.x - PET_WINDOW.cx, p.y - PET_WINDOW.cy] : null);
    engine.update(dt);
    if (scene.shown) this.draw(pose.size);

    const busy = petNeedsFrame(scene, { travelling: this.way != null, robotChanging: engine.changing });
    this.syncTimers(scene, now);
    if (busy) requestAnimationFrame(this.frame);
    else this.running = false;
  };

  /**
   * How Liv carries itself at `now` (travel.ts). At the end of a way it
   * lands — but one that ends in the island stays as small as it got there
   * until the window is put away.
   */
  private poseAt(now: number): TravelPose {
    const way = this.way;
    if (!way) return AT_REST;
    const t = (now - way.startedAt) / way.ms;
    if (t >= 1 && way.way !== "home") {
      this.way = null;
      this.touch();
      this.engine.land();
      return AT_REST;
    }
    return travelPose(t, way.dx, way.dy, way.way);
  }

  private draw(size: number) {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const { w, h, cx, cy } = PET_WINDOW;
    // The webview's zoom is part of the ratio: a bigger island paints Liv on as many more pixels.
    const ratio = Math.min(MAX_RATIO, window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);
    if (ratio !== this.ratio) {
      this.ratio = ratio;
      this.canvas.width = Math.round(w * ratio);
      this.canvas.height = Math.round(h * ratio);
    }
    // Cleared in device pixels, the whole canvas (see Island.drawBot).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.engine.drawAt(ctx, PET_R * size, cx, cy);
  }
}

/** A link or a file dropped on Liv goes nowhere: left to the webview, a dropped link is followed. */
function refuseDrops() {
  for (const type of ["dragenter", "dragover", "drop"] as const) {
    window.addEventListener(type, (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    });
  }
}

const canvas = document.getElementById("pet");
if (canvas instanceof HTMLCanvasElement) {
  guardPage(window);
  refuseDrops();
  const view = new PetView(canvas);
  // The dev preview (dev/pet-preview.html) reaches into it.
  if (import.meta.env.DEV) Object.assign(window, { __pet: view });
  void view.start();
}
