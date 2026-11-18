// Liv's desktop window on a bench: the window's real page (src/pet/main.ts)
// with a stand-in for Rust — this file moves the "window" (a box on the
// page), says where the pointer is, lets clicks through outside Liv's
// silhouette and carries the box during a drag, the way src-tauri/src/pet.rs
// does with the real one. See pet-preview.html for how to drive it.
// Not shipped in the app.

import type { BotStateName } from "../src/core/layout";
import { dropOutcome } from "../src/pet/drag";
import { PET_WINDOW, onShape, type Disc } from "../src/pet/shape";
import { OUTFIT_CHOICES, wornOutfit } from "../src/robot/outfits";
import { travelPath } from "../src/pet/travel";
import type { PetLook } from "../src/pet/wire";

const STATES: BotStateName[] = ["idle", "working", "thinking", "approval", "question", "error", "finished", "ratelimit"];
const UPDATE_BLUE: [number, number, number] = [0.231, 0.51, 0.965];
/** As far as Rust tells the page about the pointer (island.rs: NEAR_ZONE). */
const NEAR_ZONE = 420;
/** The compact island the page draws at the top, and where Liv's head is in it. */
const ISLAND = { w: 288, h: 32, headX: 40, headY: 16 };

// ── Rust's stand-in ───────────────────────────────────────────────────────────

const answers: Record<string, unknown> = {};
(window as any).__answers = answers;
await import("./tauri-mock.ts");
const emit = (event: string, payload?: unknown) => (window as any).__emit(event, payload);

// Frames the window's page asks for are counted; the bench's own are not.
const ownFrame = window.requestAnimationFrame.bind(window);
let painted: number[] = [];
window.requestAnimationFrame = (fn) =>
  ownFrame((now) => {
    painted.push(now);
    fn(now);
  });

const box = document.getElementById("window") as HTMLElement;
const canvas = document.getElementById("pet") as HTMLCanvasElement;
const overlay = document.getElementById("silhouette") as HTMLCanvasElement;
const through = document.getElementById("through") as HTMLElement;
const bar = document.getElementById("bar") as HTMLElement;

let shape: Disc[] = [];
let asleep = false;
let shown = true;
/** Liv stands on the desktop: not on its way, not carried. */
let landed = true;
let takesMouse = false;
let mouse = { x: -10_000, y: -10_000 };
let far = false;
/** The window's corner, and the spot Liv goes back to. */
let pos = { x: window.innerWidth - PET_WINDOW.w - 60, y: window.innerHeight - PET_WINDOW.h - 110 };
let spot = { ...pos };
let carry: { x: number; y: number } | null = null;
/** Bumped by every way: an older one stops moving the window. */
let way = 0;

const look: PetLook = { state: "idle", shell: null, hint: null, outfit: "none", beat: 0, hello: 0 };
const tell = () => emit("pet-look", { ...look });

function place(at: { x: number; y: number }) {
  pos = at;
  box.style.transform = `translate(${at.x}px, ${at.y}px)`;
}

function setShown(on: boolean) {
  shown = on;
  box.style.display = on ? "" : "none";
  emit("pet-shown", on);
}

/** What takes the mouse, and what the page hears of the pointer: Rust's poll. */
function poll() {
  const local = { x: mouse.x - pos.x, y: mouse.y - pos.y };
  takesMouse = shown && (carry != null || (landed && onShape(local.x, local.y, shape)));
  canvas.style.pointerEvents = takesMouse ? "auto" : "none";
  if (!shown || !landed || carry) return;
  const near =
    local.x >= -NEAR_ZONE && local.x <= PET_WINDOW.w + NEAR_ZONE &&
    local.y >= -NEAR_ZONE && local.y <= PET_WINDOW.h + NEAR_ZONE;
  if (!near && far) return;
  far = !near;
  emit("pet-cursor", local);
}

const islandRect = () => ({ x: window.innerWidth / 2 - ISLAND.w / 2, y: 0, w: ISLAND.w, h: ISLAND.h });
/** The window's corner when Liv's head is where it sits in the compact island. */
function islandEnd() {
  const island = islandRect();
  return { x: island.x + ISLAND.headX - PET_WINDOW.cx, y: island.y + ISLAND.headY - PET_WINDOW.cy };
}

/** Where the window is `t` of the time into a way (pet.rs: logic::along). */
function along(points: [number, number][], t: number) {
  if (t >= 1) return { x: points[points.length - 1][0], y: points[points.length - 1][1] };
  const at = Math.max(0, t) * (points.length - 1);
  const i = Math.min(points.length - 2, Math.floor(at));
  const k = at - i;
  return { x: points[i][0] + (points[i + 1][0] - points[i][0]) * k, y: points[i][1] + (points[i + 1][1] - points[i][1]) * k };
}

/** One way of the window, as `pet_travel` runs it. */
function travel(to: "spot" | "home") {
  const comingOut = !shown;
  if (to === "home" && !shown) return;
  const from = comingOut ? islandEnd() : pos;
  const target = to === "home" ? islandEnd() : spot;
  const path = travelPath(from, target, 1);
  const mine = ++way;
  landed = false;
  carry = null;
  place(from);
  setShown(true);
  tell();
  emit("pet-travel", {
    dx: target.x - from.x,
    dy: target.y - from.y,
    ms: path.ms,
    way: to === "home" ? "home" : comingOut ? "out" : "move",
  });
  const started = performance.now();
  const step = (now: number) => {
    if (mine !== way) return;
    const t = (now - started) / path.ms;
    place(along(path.points, t));
    if (t < 1) {
      ownFrame(step);
      return;
    }
    if (to === "home") setShown(false);
    else landed = true;
    poll();
  };
  ownFrame(step);
}

answers.pet_shown = () => shown;
answers.pet_fit_zoom = () => false;
answers.pet_shape = (args: { shape: Disc[] }) => {
  shape = args.shape;
  drawSilhouette();
};
answers.pet_asleep = (args: { asleep: boolean }) => {
  asleep = args.asleep;
};
answers.pet_grab = () => {
  if (!landed || !shown) return false;
  way++;
  carry = { x: mouse.x - pos.x, y: mouse.y - pos.y };
  emit("pet-held", true);
  poll();
  return true;
};
// What the window's page says to the island's.
answers["plugin:event|emit_to"] = (args: { event: string }) => {
  if (args.event === "pet-ready") tell();
  if (args.event === "pet-home") travel("home");
  // A right-click on Liv: in the app the island opens on its wardrobe.
  if (args.event === "pet-wardrobe") {
    through.textContent = "right-click: the island would open the wardrobe";
    through.style.opacity = "1";
    window.setTimeout(() => (through.style.opacity = "0"), 1400);
  }
  return null;
};

document.addEventListener("mousemove", (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (carry) place({ x: mouse.x - carry.x, y: mouse.y - carry.y });
  poll();
});
document.addEventListener("mouseup", () => {
  if (!carry) return;
  carry = null;
  emit("pet-held", false);
  // The island's page decides: on the island it is home, anywhere else it stays.
  const drop = { x: mouse.x, y: mouse.y };
  if (dropOutcome(drop, islandRect()) === "home") setShown(false);
  else spot = { ...pos };
  poll();
});
// A click that the window let through lands on the desktop.
document.body.addEventListener("pointerdown", (e) => {
  if (e.target !== document.body) return;
  through.textContent = "a click went through to the desktop";
  through.style.opacity = "1";
  window.setTimeout(() => (through.style.opacity = "0"), 700);
});

// ── The bench ─────────────────────────────────────────────────────────────────

function drawSilhouette() {
  const dpr = window.devicePixelRatio || 1;
  overlay.style.width = `${PET_WINDOW.w}px`;
  overlay.style.height = `${PET_WINDOW.h}px`;
  overlay.width = Math.round(PET_WINDOW.w * dpr);
  overlay.height = Math.round(PET_WINDOW.h * dpr);
  const ctx = overlay.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = "rgba(255, 90, 160, 0.9)";
  for (const d of shape) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function group(label: string, buttons: Record<string, () => void>) {
  const el = document.createElement("div");
  el.className = "group";
  const name = document.createElement("span");
  name.className = "hint";
  name.textContent = label;
  el.append(name);
  for (const [text, run] of Object.entries(buttons)) {
    const button = document.createElement("button");
    button.textContent = text;
    button.addEventListener("click", run);
    el.append(button);
  }
  bar.append(el);
}

group("State", Object.fromEntries(STATES.map((state) => [state, () => {
  look.state = state;
  tell();
}])));
group("While out", {
  Finished: () => {
    look.state = "finished";
    look.beat++;
    tell();
  },
  Error: () => {
    look.state = "error";
    look.beat++;
    tell();
  },
  Greeting: () => {
    look.hello = Date.now();
    tell();
  },
  Update: () => {
    const on = look.hint == null;
    look.state = "idle";
    look.hint = on ? UPDATE_BLUE : null;
    look.shell = on ? UPDATE_BLUE : null;
    tell();
  },
});
// What the wardrobe's chips would have it wear ("Auto": the season's pick today).
group("Wears", Object.fromEntries(OUTFIT_CHOICES.map((choice) => [choice.name, () => {
  look.outfit = wornOutfit(choice.id, new Date());
  tell();
}])));
group("Way", {
  "Send out": () => travel("spot"),
  "Call home": () => travel("home"),
});
group("Rest", {
  "Sleep now": () => {
    const pet = (window as any).__pet;
    pet.touchedAt = performance.now() - 121_000;
    pet.ensureRunning();
  },
  Parked: () => setShown(!shown),
});
group("Show", {
  Window: () => box.classList.toggle("outlined"),
  Silhouette: () => (overlay.style.display = overlay.style.display === "none" ? "" : "none"),
});

const status = document.createElement("span");
status.id = "status";
bar.append(status);
window.setInterval(() => {
  const now = performance.now();
  painted = painted.filter((at) => now - at < 1000);
  status.textContent =
    `${painted.length} frames/s · ${asleep ? "asleep (poll at its slowest)" : "awake"} · ` +
    `${takesMouse ? "takes the mouse" : "clicks go through"} · ${shown ? "on screen" : "put away"}`;
}, 250);

overlay.style.display = "none";
box.style.width = `${PET_WINDOW.w}px`;
box.style.height = `${PET_WINDOW.h}px`;
place(pos);
// The page asks whether it is on screen and what Liv looks like as it loads.
await import("../src/pet/main.ts");
