// The coloured band on top of each page of the Liv window: a deep black
// with the page's colour breathing in a corner, and particles that drift all
// the time and move away from the pointer. On its right stands the page's
// troupe of Livs (troupe.ts), alive; the sidebar's Liv is here too.
//
// One animation loop draws every live canvas; it stops when none is left or
// the window is hidden, so a hidden window costs nothing, and skips the ones
// scrolled out of sight. The Livs ride on that loop: they are drawn on the
// frames the bands ask for, and ask for none themselves.

import { paintParticles, particleCount, seedParticles, type Particle } from "../core/particles";
import { pillDefinition } from "../core/pills";
import { hexToRGB, placeInBox } from "../robot/look";
import type { Outfit } from "../robot/outfits";
import { Robot } from "../robot/robot";
import { onScreen, shouldAnimate } from "./frames";
import { castFor, memberAt, nextBit, troupeLayout, type BitCue, type Standing } from "./troupe";

interface Animated {
  el: HTMLCanvasElement;
  draw(dt: number, t: number): void;
  /** Drawn on the loop's frames without keeping it going: a Liv, next to a band that does. */
  rides?: boolean;
  /** Pages are built before they are put in the window: dropped only once gone. */
  shown?: boolean;
  born?: number;
}

const live = new Set<Animated>();
let frame: number | null = null;
/** The stand-in timer while the webview gives no animation frames (see `ask`). */
let fallback: number | null = null;
/** No animation frame came after the last ask: the timer drives the loop. */
let starved = false;
let last = performance.now();
const start = performance.now();
/** The Liv window is on screen, as Rust last said (`setWindowShown`). */
let windowShown = true;

/** How many of the live canvases keep the loop going. */
function drivers(): number {
  let count = 0;
  for (const a of live) if (!a.rides) count++;
  return count;
}

function running(): boolean {
  // WebView2 can leave a window created hidden reporting "hidden" once shown:
  // focused, it is in front of the user whatever the page thinks.
  const visibility = document.hasFocus?.() ? "visible" : document.visibilityState;
  return shouldAnimate(drivers(), visibility, windowShown);
}

function loop(now: number) {
  frame = null;
  if (fallback !== null) {
    window.clearTimeout(fallback);
    fallback = null;
  }
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = (now - start) / 1000;
  for (const a of live) {
    if (!a.el.isConnected) {
      // Built but not shown yet: wait for it (a few seconds at most).
      if (a.shown || now - (a.born ??= now) > 5000) live.delete(a);
      continue;
    }
    a.shown = true;
    if (onScreen(a.el.getBoundingClientRect(), window.innerWidth, window.innerHeight)) a.draw(dt, t);
  }
  if (running()) ask();
}

/**
 * The next frame. WebView2 gives a window created hidden no animation frames
 * until something wakes its compositor, so a timer stands in when
 * none comes: the bands stay alive at 30 frames a second instead of frozen,
 * and the loop goes back to real frames the moment one arrives.
 */
function ask() {
  frame = requestAnimationFrame((now) => {
    starved = false;
    loop(now);
  });
  fallback = window.setTimeout(() => {
    fallback = null;
    if (frame === null) return;
    cancelAnimationFrame(frame);
    starved = true;
    loop(performance.now());
  }, starved ? 33 : 250);
}

function wake() {
  if (frame === null && fallback === null && running()) {
    last = performance.now();
    ask();
  }
}

document.addEventListener("visibilitychange", wake);
window.addEventListener("focus", wake);

/** The window was shown or hidden (the `hub-visible` event): hidden, the loop
 *  stops at once; shown, it starts again. */
export function setWindowShown(shown: boolean) {
  windowShown = shown;
  if (!shown) {
    if (frame !== null) cancelAnimationFrame(frame);
    if (fallback !== null) window.clearTimeout(fallback);
    frame = null;
    fallback = null;
  }
  wake();
}

function add(a: Animated) {
  live.add(a);
  wake();
}

function fit(canvas: HTMLCanvasElement): { w: number; h: number; ctx: CanvasRenderingContext2D | null } {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h, ctx };
}

/** "r,g,b" of each colour, read once: the particles ask every frame. */
const channels = new Map<string, string>();

function rgba(hex: string, alpha: number): string {
  let rgb = channels.get(hex);
  if (rgb === undefined) {
    const [r, g, b] = hexToRGB(hex);
    rgb = `${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}`;
    channels.set(hex, rgb);
  }
  return `rgba(${rgb},${Math.max(0, Math.min(1, alpha))})`;
}

// ── The backdrop ──────────────────────────────────────────────────────────────

/** The deep black, the colour and the particles, on `canvas`; `pointerFrom` is
 *  the element whose pointer pushes the particles. */
function backdrop(canvas: HTMLCanvasElement, color: string, pointerFrom: HTMLElement, radius = 18) {
  let particles: Particle[] = [];
  let pointer: { x: number; y: number } | null = null;
  let strength = 0;
  pointerFrom.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  pointerFrom.addEventListener("pointerleave", () => (pointer = null));

  add({
    el: canvas,
    draw(dt, t) {
      const { w, h, ctx } = fit(canvas);
      if (!ctx || w === 0) return;
      if (particles.length === 0) particles = seedParticles(w, h, particleCount(w, h));
      strength += ((pointer ? 1 : 0) - strength) * Math.min(1, dt * 4);
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, radius);
      ctx.clip();
      ctx.fillStyle = "#020203";
      ctx.fillRect(0, 0, w, h);
      const lin = ctx.createLinearGradient(w, 0, w * 0.35, h);
      lin.addColorStop(0, rgba(color, 0.1));
      lin.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = lin;
      ctx.fillRect(0, 0, w, h);
      const breath = 0.85 + 0.15 * Math.sin(t * 0.9);
      const rad = ctx.createRadialGradient(w * 0.92, -h * 0.15, 0, w * 0.92, -h * 0.15, Math.max(w, h) * 0.55 * breath);
      rad.addColorStop(0, rgba(color, 0.3 * breath));
      rad.addColorStop(0.5, rgba(color, 0.08));
      rad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = rad;
      ctx.fillRect(0, 0, w, h);

      // They drift, always; the pointer pushes them away (core/particles.ts).
      paintParticles(ctx, particles, dt, t, w, h, pointer, strength, (white, alpha) => rgba(white ? "#FFFFFF" : color, alpha));
      ctx.restore();
    },
  });
}

// ── Liv, alive ────────────────────────────────────────────────────────────────

/** The eyes follow a pointer anywhere in the window as they follow one this near, px (robot/look.ts: gazeFor). */
const POINTER_NEAR = 240;

/** A pointer `dx`, `dy` px from a head, brought within the distance its eyes follow. */
function toward(dx: number, dy: number): readonly [number, number] {
  const d = Math.hypot(dx, dy);
  const near = d > POINTER_NEAR ? POINTER_NEAR / d : 1;
  return [dx * near, dy * near];
}

/**
 * Liv's head next to its name, in `canvas`, as big as it goes: it blinks, and
 * its eyes follow the pointer over the window.
 */
export function brandRobot(canvas: HTMLCanvasElement) {
  const robot = new Robot();
  robot.alive = true;
  let pointer: { x: number; y: number } | null = null;
  window.addEventListener("mousemove", (e) => (pointer = { x: e.clientX, y: e.clientY }));
  document.addEventListener("mouseleave", () => (pointer = null));

  add({
    el: canvas,
    rides: true,
    draw(dt) {
      const { w, h, ctx } = fit(canvas);
      if (!ctx || w === 0) return;
      const place = placeInBox(w, h, "head");
      const box = canvas.getBoundingClientRect();
      robot.lookAt(pointer && toward(pointer.x - box.left - place.cx, pointer.y - box.top - place.cy));
      robot.update(dt);
      ctx.clearRect(0, 0, w, h);
      robot.drawAt(ctx, place.R, place.cx, place.cy);
    },
  });
}

/** What Liv wears now, for the one of the troupe that is Liv itself (troupe.ts: `dressed`). */
let worn: Outfit = "none";

/** Liv wears `outfit` from now on: the Liv of the General page puts it on. */
export function dressTroupe(outfit: Outfit) {
  worn = outfit;
}

/** The troupe breathes out of step: each was born this many seconds after the one on its left. */
const BREATH_APART = 0.9;

/** Under each of them, a pool of the page's colour on the floor: this wide and this flat, in head radii. */
const POOL = { rx: 1.5, ry: 0.26, alpha: 0.22 } as const;

/**
 * The page's troupe, on `canvas`, in the right of `band`: each of the cast a
 * living Liv on the floor, clear of the text of `copy`. They look at the
 * pointer while it is over the band; a click on a head pokes it, and a
 * pointer left resting on one wins it over, as on the island. Now and then
 * one of them does a small bit of its own.
 */
function troupe(canvas: HTMLCanvasElement, band: HTMLElement, copy: HTMLElement, page: string, color: string) {
  const cast = castFor(page);
  const robots = cast.members.map((member, i) => {
    const robot = new Robot(Math.random, i * BREATH_APART);
    robot.alive = true;
    robot.setLimbs(true);
    robot.setState(member.state);
    robot.restGaze = member.gaze;
    const pill = member.pill ? pillDefinition(member.pill) : undefined;
    if (pill) robot.bodyColor = hexToRGB(pill.color);
    // It comes on stage dressed: nobody saw it put that on.
    if (member.dressed) robot.setOutfit(worn, false);
    return robot;
  });
  let standing: Standing[] = [];
  let cue: BitCue | null = null;
  /** The band's width and the canvas's size the troupe was last stood for. */
  let stoodFor = "";
  let pointer: { x: number; y: number } | null = null;

  /** The pointer of `e` in the canvas, and who of those standing has its head under it. */
  const locate = (e: PointerEvent) => {
    const box = canvas.getBoundingClientRect();
    const at = { x: e.clientX - box.left, y: e.clientY - box.top };
    return { at, on: memberAt(standing, at.x, at.y) };
  };
  band.addEventListener("pointermove", (e) => {
    const { at, on } = locate(e);
    pointer = at;
    standing.forEach((s, i) => robots[s.member].hover(i === on));
    band.style.cursor = on == null ? "" : "pointer";
  });
  band.addEventListener("pointerleave", () => {
    pointer = null;
    for (const robot of robots) robot.hover(false);
    band.style.cursor = "";
  });
  band.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const { at, on } = locate(e);
    if (on != null) robots[standing[on].member].poke(at.x < standing[on].cx ? -1 : 1);
  });

  /** How far right the title and its line reach, in the canvas: the text itself, not its box. */
  const textRight = (left: number) => {
    const range = document.createRange();
    let right = -Infinity;
    for (const line of copy.children) {
      range.selectNodeContents(line);
      right = Math.max(right, range.getBoundingClientRect().right - left);
    }
    return right;
  };

  add({
    el: canvas,
    rides: true,
    draw(dt) {
      const { w, h, ctx } = fit(canvas);
      if (!ctx || w === 0) return;
      // The window was resized: the text has moved, and so does the troupe.
      const key = `${band.clientWidth}|${w}|${h}`;
      if (key !== stoodFor) {
        stoodFor = key;
        const count = standing.length;
        standing = troupeLayout(cast, w, h, textRight(canvas.getBoundingClientRect().left));
        if (standing.length !== count) cue = nextBit(Math.random, cast, standing.length);
      }
      if (cue) {
        cue.inMs -= dt * 1000;
        if (cue.inMs <= 0) {
          const robot = robots[standing[cue.who].member];
          if (cue.bit === "glance") robot.act(cue.toward < 0 ? "glanceLeft" : "glanceRight");
          else robot.perform(cue.bit);
          cue = nextBit(Math.random, cast, standing.length);
        }
      }

      ctx.clearRect(0, 0, w, h);
      for (const s of standing) {
        const robot = robots[s.member];
        ctx.save();
        ctx.translate(s.cx, s.floor);
        ctx.scale(1, POOL.ry / POOL.rx);
        const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, POOL.rx * s.R);
        pool.addColorStop(0, rgba(color, POOL.alpha));
        pool.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = pool;
        ctx.beginPath();
        ctx.arc(0, 0, POOL.rx * s.R, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        robot.lookAt(pointer && toward(pointer.x - s.cx, pointer.y - s.cy));
        if (cast.members[s.member].dressed) robot.setOutfit(worn);
        robot.update(dt);
        robot.drawAt(ctx, s.R, s.cx, s.cy);
      }
    },
  });
}

// ── Page themes ───────────────────────────────────────────────────────────────

/** Each page's colour. */
const THEMES: Record<string, string> = {
  general: "#8E939C",
  island: "#5FD9EE",
  appearance: "#E879F9",
  pills: "#F5A524",
  agents: "#3B9EFF",
  chat: "#E07950",
  integrations: "#7C5CFF",
  shortcuts: "#6366F1",
};

/** The band itself: its backdrop, the page's troupe, the title and its line. */
export function hero(page: string, title: string, subtitle: string): HTMLElement {
  const color = THEMES[page] ?? THEMES.general;
  const el = document.createElement("div");
  el.className = "hub-hero";
  el.style.setProperty("--hero-line", rgba(color, 0.16));
  el.style.setProperty("--hero-glow", rgba(color, 0.3));
  el.style.setProperty("--hero-tint", rgba(color, 0.1));
  const back = document.createElement("canvas");
  back.className = "backdrop";
  const copy = document.createElement("div");
  copy.className = "copy";
  const h1 = document.createElement("h1");
  h1.textContent = title;
  copy.append(h1);
  const p = document.createElement("p");
  p.textContent = subtitle;
  copy.append(p);
  const stage = document.createElement("canvas");
  stage.className = "troupe";
  el.append(back, stage, copy);
  backdrop(back, color, el);
  troupe(stage, el, copy, page, color);
  return el;
}
