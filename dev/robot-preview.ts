// Liv on a bench: both models, at every size the app shows it, in every state,
// alive — on the island's black and on a mid grey — and each shape its eyes
// can take. `npx vite`, then open /dev/robot-preview.html. Not shipped in the app.
//
// The controls: the shell's colour (the default "ice" or the design sheets'
// teal), what Liv wears — every robot on the page puts it on, the eye strip
// included, so each accessory is seen at each size, in each state and with
// each shape of eye; at 24 px and under only the star shows —, whether the
// eyes follow the pointer, a replay of every state's
// entrance (a click on one robot replays its own), and Liv's own moods on the
// big robots (a slot of 44 px and up): a poke, dizzy, love, the greeting, a
// task finishing or failing, and the bits of the Liv window's troupe (a wave,
// a hop, typing). "Dance" has the big idle ones dance as they do to music on
// the island — the other rows keep their state's look, which comes before the
// dance there too. The pointer does the same as on the island: a click on a
// head pokes it (three in a row make it dizzy), and resting on a head for two
// seconds wins it over.

import type { BotStateName } from "../src/core/layout";
import { seededRandom } from "../src/robot/life";
import {
  CANVAS_PER_SLOT, EYE_SHAPES, ROBOT_STATES, SHELL_ICE, SHELL_TEAL,
  type EyeShape, type RGB, type RobotModel,
} from "../src/robot/look";
import { OUTFIT_CHOICES, wornOutfit, type Outfit } from "../src/robot/outfits";
import { paintBoxRobot } from "../src/robot/paint";
import { onHead } from "../src/robot/react";
import { Robot } from "../src/robot/robot";

/** The slots the app gives the figure, in CSS px, and one large for the drawing itself. */
const SLOTS = [13, 18, 20, 24, 44, 58, 66, 120];
const MODELS: RobotModel[] = ["head", "body"];
const STATES = Object.keys(ROBOT_STATES) as BotStateName[];
const SHAPES = Object.keys(EYE_SHAPES) as EyeShape[];
const SHELLS: Record<string, RGB> = { "Ice (default)": SHELL_ICE, "Teal (design)": SHELL_TEAL };
/** The eye strip: one head per shape, this big. */
const STRIP = 84;
/** From this slot a robot is big enough for its moods to be judged. */
const BIG_SLOT = 44;

interface Cell {
  canvas: HTMLCanvasElement;
  slot: number;
  size: number;
  robot: Robot;
  state: BotStateName;
}

/** What the mood buttons do to a robot. */
const MOODS: Record<string, (robot: Robot) => void> = {
  Poke: (robot) => robot.poke(),
  Dizzy: (robot) => robot.react("dizzy"),
  Love: (robot) => robot.react("love"),
  Greeting: (robot) => robot.greet(),
  Finished: (robot) => robot.setState("finished", true),
  Error: (robot) => robot.setState("error", true),
  Wave: (robot) => robot.perform("wave"),
  Hop: (robot) => robot.perform("hop"),
  Type: (robot) => robot.perform("type"),
};

const cells: Cell[] = [];
const strips: { canvas: HTMLCanvasElement; shape: EyeShape }[] = [];
let shell: RGB = SHELL_ICE;
let outfit: Outfit = "none";
let follow = true;
let pointer: { x: number; y: number } | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** A canvas of `w` × `h` CSS px, with its 2D context scaled to the screen's pixels. */
function sized(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
  if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function paintStrips() {
  for (const { canvas, shape } of strips) {
    paintBoxRobot(sized(canvas, STRIP, STRIP), STRIP, STRIP, { shell, eyes: shape, outfit });
  }
}

// ── The page ──────────────────────────────────────────────────────────────────

function buildBar() {
  const bar = document.getElementById("bar")!;
  const shells = el("label", "Shell");
  const select = el("select");
  for (const name of Object.keys(SHELLS)) select.append(el("option", name));
  select.addEventListener("change", () => {
    shell = SHELLS[select.value];
    for (const cell of cells) cell.robot.shell = shell;
    paintStrips();
  });
  shells.append(select);

  // "Auto" is what the season picks today.
  const outfits = el("label", "Outfit");
  const wardrobe = el("select");
  for (const choice of OUTFIT_CHOICES) {
    const option = el("option", choice.name);
    option.value = choice.id;
    option.selected = choice.id === "none";
    wardrobe.append(option);
  }
  wardrobe.addEventListener("change", () => {
    outfit = wornOutfit(OUTFIT_CHOICES.find((choice) => choice.id === wardrobe.value)!.id, new Date());
    for (const cell of cells) cell.robot.setOutfit(outfit);
    paintStrips();
  });
  outfits.append(wardrobe);

  const following = el("label");
  const box = el("input");
  box.type = "checkbox";
  box.checked = follow;
  box.addEventListener("change", () => (follow = box.checked));
  following.append(box, "Follow the pointer");

  const replay = el("button", "Replay every state");
  replay.addEventListener("click", () => {
    for (const cell of cells) cell.robot.setState(cell.state, true);
  });

  const moods = el("label", "On the big robots");
  for (const [name, run] of Object.entries(MOODS)) {
    const button = el("button", name);
    button.addEventListener("click", () => {
      for (const cell of cells) if (cell.slot >= BIG_SLOT) run(cell.robot);
    });
    moods.append(button);
  }

  const dancing = el("label");
  const dance = el("input");
  dance.type = "checkbox";
  dance.addEventListener("change", () => {
    for (const cell of cells) cell.robot.setDancing(dance.checked && cell.slot >= BIG_SLOT && cell.state === "idle");
  });
  dancing.append(dance, "Dance");

  bar.append(
    shells, outfits, following, replay, moods, dancing,
    el("span", "Columns are slot sizes in px; a click on a robot replays its state, on a big one's head it pokes it.", "hint"),
  );
}

/** Whether the pointer of `e` is on the head of the robot in `cell`. */
function onItsHead(cell: Cell, e: MouseEvent): boolean {
  const box = cell.canvas.getBoundingClientRect();
  return onHead(e.clientX - (box.left + box.width / 2), e.clientY - (box.top + box.height / 2), cell.slot, cell.robot.feet);
}

function buildPanel(name: string, className: string): HTMLElement {
  const panel = el("section", "", `panel ${className}`);
  panel.append(el("h2", name));

  panel.append(el("h3", "Eye shapes"));
  const strip = el("div", "", "strip");
  for (const shape of SHAPES) {
    const canvas = el("canvas");
    strips.push({ canvas, shape });
    const figure = el("figure");
    figure.append(canvas, shape);
    strip.append(figure);
  }
  panel.append(strip);

  for (const model of MODELS) {
    panel.append(el("h3", model === "head" ? "Model 1 — head" : "Model 2 — body"));
    const table = el("table");
    const head = el("tr");
    head.append(el("th"));
    for (const slot of SLOTS) head.append(el("th", String(slot)));
    table.append(head);
    for (const state of STATES) {
      const row = el("tr");
      row.append(el("th", state, "state"));
      for (const slot of SLOTS) {
        const canvas = el("canvas");
        const robot = new Robot(seededRandom(cells.length + 1));
        robot.alive = true;
        robot.setLimbs(model === "body");
        robot.setState(state);
        const cell: Cell = { canvas, slot, size: slot * CANVAS_PER_SLOT, robot, state };
        sized(canvas, cell.size, cell.size);
        if (slot >= BIG_SLOT) {
          canvas.addEventListener("click", (e) => {
            if (onItsHead(cell, e)) robot.poke(e.clientX < canvas.getBoundingClientRect().left + cell.size / 2 ? -1 : 1);
            else robot.setState(state, true);
          });
          canvas.addEventListener("mousemove", (e) => robot.hover(onItsHead(cell, e)));
          canvas.addEventListener("mouseleave", () => robot.hover(false));
        } else {
          canvas.addEventListener("click", () => robot.setState(state, true));
        }
        cells.push(cell);
        const td = el("td");
        td.append(canvas);
        row.append(td);
      }
      table.append(row);
    }
    panel.append(table);
  }
  return panel;
}

buildBar();
document.getElementById("stage")!.append(
  buildPanel("On the island's black", "black"),
  buildPanel("On a mid grey", "grey"),
);
paintStrips();

window.addEventListener("mousemove", (e) => (pointer = { x: e.clientX, y: e.clientY }));
document.addEventListener("mouseleave", () => (pointer = null));

// ── The loop ──────────────────────────────────────────────────────────────────

let last = performance.now();

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const cell of cells) {
    const box = cell.canvas.getBoundingClientRect();
    // Out of sight, a robot is neither stepped nor drawn.
    if (box.bottom < 0 || box.top > window.innerHeight) continue;
    cell.robot.lookAt(
      follow && pointer ? [pointer.x - (box.left + box.width / 2), pointer.y - (box.top + box.height / 2)] : null,
    );
    cell.robot.update(dt);
    cell.robot.draw(sized(cell.canvas, cell.size, cell.size), cell.size, cell.size);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
