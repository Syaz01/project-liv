// Liv's wardrobe (src/robot/outfits.ts): the table of what it can wear, what
// the season picks for "Auto", at which sizes an accessory shows, how each is
// drawn and where it sits among the layers of the figure, how one comes on
// and goes, that none of them covers the eyes or leaves the canvas, and that
// none keeps a frame going once it is on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";
import { lookup } from "../src/i18n/i18n.ts";
import { seededRandom } from "../src/robot/life.ts";
import {
  CANVAS_PER_SLOT, EYE_SHAPES, GAZE_EYES, GAZE_VISOR, LOVE, ROBOT_STATES, headRadius, placeInSlot, rgba, robotGeometry,
  stillPose, visorPoint,
} from "../src/robot/look.ts";
import {
  BEANIE, DEFAULT_OUTFIT, GLASSES, OUTFITS, OUTFIT_CHOICES, OUTFIT_IDS, OUTFIT_OFF_MS, OUTFIT_ON_MS, PHONES, SCARF,
  SEASONS, STAR_LAMP, autoLine, outfitChoice, outfitShare, seasonalOutfit, wornOutfit,
} from "../src/robot/outfits.ts";
import { paintRobot, paintSlotRobot } from "../src/robot/paint.ts";
import { PET_SLOT } from "../src/pet/shape.ts";
import { Robot } from "../src/robot/robot.ts";
import { colours, recorder } from "./recorder.mjs";

const IDS = ["glasses", "scarf", "headphones", "beanie", "star"];
/** The slots the app rests the figure at, the one between two levels, the desktop's and the preview's largest. */
const SLOTS = [13, 18, 20, 24, 34, 44, 46, 50, 52, 56, 58, 62, 66, PET_SLOT, 120];
const STATES = Object.keys(ROBOT_STATES);

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** Steps the robot for `seconds`, 100 times a second; `each` sees it after every step. */
function run(robot, seconds, each = () => {}) {
  const steps = Math.round(seconds * 100);
  for (let i = 1; i <= steps; i++) {
    robot.update(0.01);
    each(robot, i * 10);
  }
}

/** A still figure with a head of `R`, wearing `outfit`, painted on a recorder. */
function painted(outfit, R = headRadius(58), more = {}, look = {}) {
  const ctx = recorder();
  paintRobot(ctx, R, { ...stillPose({ model: "body", ...look, outfit }), ...more });
  return ctx;
}

/** A robot standing in a card, whole, wearing `outfit` already. */
function dressed(outfit, slot = 58) {
  const robot = new Robot(seededRandom(slot));
  robot.setLimbs(slot >= 44);
  robot.setOutfit(outfit, false);
  run(robot, 1);
  return robot;
}

// ── The table ─────────────────────────────────────────────────────────────────

test("the wardrobe holds five accessories, each with a name, a line for Auto and something to paint", () => {
  assert.deepEqual(OUTFIT_IDS, IDS);
  for (const id of IDS) {
    const def = OUTFITS[id];
    assert.equal(def.id, id);
    for (const key of [def.name, def.auto]) {
      assert.ok(key.length > 0);
      const es = lookup(key, "es");
      assert.ok(typeof es === "string" && es.length > 0 && es !== key, `${id}: ${key} is not translated`);
    }
    assert.match(def.auto, /^Auto: today Liv wears the \w+\.$/);
    assert.ok(def.behind || def.onVisor || def.over || def.lamp, `${id} paints nothing`);
  }
  assert.deepEqual(
    IDS.map((id) => [OUTFITS[id].name, lookup(OUTFITS[id].name, "es")]),
    [["Glasses", "Gafas"], ["Scarf", "Bufanda"], ["Headphones", "Auriculares"], ["Beanie", "Gorro"], ["Star", "Estrella"]],
  );
  // The star is the antenna's light, and the only one that shows on the small robot.
  assert.deepEqual(IDS.filter((id) => OUTFITS[id].small), ["star"]);
  assert.deepEqual(IDS.filter((id) => OUTFITS[id].lamp), ["star"]);
  // The antenna comes out through the beanie alone.
  assert.deepEqual(IDS.filter((id) => OUTFITS[id].antennaFrom != null), ["beanie"]);
  // Where each is painted: on the visor, over the head, or behind the antenna.
  const layers = (id) => ["behind", "onVisor", "over"].filter((layer) => OUTFITS[id][layer]);
  assert.deepEqual(IDS.map(layers), [["onVisor"], ["over"], ["behind", "over"], ["over"], []]);
});

test("the choices: Auto, Nothing, then each accessory; a word this build does not have reads as Auto", () => {
  assert.deepEqual(OUTFIT_CHOICES.map((c) => c.id), ["auto", "none", ...IDS]);
  assert.deepEqual(OUTFIT_CHOICES.slice(0, 2).map((c) => [c.name, lookup(c.name, "es")]), [["Auto", "Auto"], ["Nothing", "Nada"]]);
  for (const choice of OUTFIT_CHOICES) assert.equal(outfitChoice(choice.id), choice.id);
  assert.equal(DEFAULT_OUTFIT, "auto");
  for (const stale of ["sunglasses", "Scarf", "", undefined, null, 3, {}]) assert.equal(outfitChoice(stale), "auto");
  assert.equal(DEFAULT_SETTINGS.livOutfit, "auto");
});

test("Rust knows the same choices: one it does not know is cleaned out of the settings file", () => {
  const rust = readFileSync(new URL("../src-tauri/src/settings.rs", import.meta.url), "utf8");
  const listed = rust.match(/const LIV_OUTFITS: \[&str; (\d+)\] = (\[[^\]]+\]);/);
  assert.ok(listed, "settings.rs no longer lists what Liv can wear");
  assert.equal(Number(listed[1]), OUTFIT_CHOICES.length);
  assert.deepEqual(JSON.parse(listed[2]), OUTFIT_CHOICES.map((c) => c.id));
  assert.match(rust, /liv_outfit: "auto"\.into\(\)/, "and starts from the same default");
  assert.match(rust, /if !LIV_OUTFITS\.contains\(&settings\.liv_outfit\.as_str\(\)\)/);
});

// ── The season ────────────────────────────────────────────────────────────────

const day = (year, month, date, ...time) => new Date(year, month - 1, date, ...time);

test("the season picks: a beanie in December, a scarf in January and February, glasses for the summer, else nothing", () => {
  const picks = [
    [day(2026, 11, 17), "none"],
    [day(2026, 11, 30), "none"],
    [day(2026, 12, 1), "beanie"],
    [day(2026, 12, 15), "beanie"],
    [day(2026, 12, 27), "beanie"],
    [day(2027, 1, 4), "scarf"],
    [day(2027, 1, 31), "scarf"],
    [day(2027, 2, 1), "scarf"],
    [day(2027, 2, 28), "scarf"],
    [day(2028, 2, 29), "scarf"],
    [day(2027, 3, 1), "none"],
    [day(2027, 4, 20), "none"],
    [day(2027, 5, 31), "none"],
    [day(2027, 6, 1), "glasses"],
    [day(2027, 7, 15), "glasses"],
    [day(2027, 8, 31), "glasses"],
    [day(2027, 9, 1), "none"],
    [day(2027, 10, 31), "none"],
  ];
  for (const [date, outfit] of picks) assert.equal(seasonalOutfit(date), outfit, date.toDateString());
});

test("around the new year the star comes first, across the end of the year", () => {
  assert.equal(seasonalOutfit(day(2026, 12, 27, 23, 59, 59)), "beanie");
  for (const date of [
    day(2026, 12, 28), day(2026, 12, 29), day(2026, 12, 30), day(2026, 12, 31), day(2026, 12, 31, 23, 59, 59, 999),
    day(2027, 1, 1), day(2027, 1, 1, 0, 0, 1), day(2027, 1, 2), day(2027, 1, 3), day(2027, 1, 3, 23, 59, 59),
  ]) assert.equal(seasonalOutfit(date), "star", date.toString());
  assert.equal(seasonalOutfit(day(2027, 1, 4)), "scarf");
  // Any year, a leap one too: a week of star, the rest of December in a beanie.
  for (const year of [2024, 2026, 2027, 2028, 2031]) {
    const count = {};
    for (let d = day(year, 1, 1); d.getFullYear() === year; d = day(year, d.getMonth() + 1, d.getDate() + 1)) {
      const outfit = seasonalOutfit(d);
      count[outfit] = (count[outfit] ?? 0) + 1;
    }
    const leap = new Date(year, 1, 29).getMonth() === 1;
    assert.deepEqual(count, { star: 7, scarf: 28 + (leap ? 29 : 28), none: 365 + (leap ? 1 : 0) - 7 - 27 - 92 - 28 - (leap ? 29 : 28), glasses: 92, beanie: 27 }, String(year));
  }
});

test("the season is one table, read from the top: every span names something Liv has, on real days", () => {
  assert.deepEqual(SEASONS.map((s) => s.outfit), ["star", "beanie", "scarf", "glasses"]);
  assert.deepEqual(SEASONS[0], { outfit: "star", from: [12, 28], to: [1, 3] });
  for (const span of SEASONS) {
    assert.ok(span.outfit === "none" || IDS.includes(span.outfit));
    for (const [month, date] of [span.from, span.to]) {
      assert.ok(month >= 1 && month <= 12 && date >= 1 && date <= 31, JSON.stringify(span));
    }
  }
  // The star's week lies inside the beanie's and the scarf's months: it has to come before them.
  assert.ok(SEASONS.findIndex((s) => s.outfit === "star") < SEASONS.findIndex((s) => s.outfit === "beanie"));
  assert.ok(SEASONS.findIndex((s) => s.outfit === "star") < SEASONS.findIndex((s) => s.outfit === "scarf"));
});

test("Auto wears the season's pick; any other choice is worn whatever the day", () => {
  const winter = day(2027, 1, 20);
  const spring = day(2027, 4, 20);
  assert.equal(wornOutfit("auto", winter), "scarf");
  assert.equal(wornOutfit("auto", spring), "none");
  for (const choice of ["none", ...IDS]) {
    assert.equal(wornOutfit(choice, winter), choice);
    assert.equal(wornOutfit(choice, spring), choice);
  }
  // What the wardrobe says of it.
  assert.equal(autoLine(winter), "Auto: today Liv wears the scarf.");
  assert.equal(autoLine(day(2026, 12, 31)), "Auto: today Liv wears the star.");
  assert.equal(autoLine(spring), "Auto: today Liv wears nothing.");
  assert.equal(lookup(autoLine(winter), "es"), "Auto: hoy Liv lleva la bufanda.");
  assert.equal(lookup(autoLine(spring), "es"), "Auto: hoy Liv no lleva nada.");
});

// ── Sizes ─────────────────────────────────────────────────────────────────────

test("up to a slot of 24 px nothing is worn but the star; from 34 px everything is whole", () => {
  const share = (outfit, slot) => outfitShare(outfit, headRadius(slot));
  for (const slot of SLOTS) assert.equal(share("none", slot), 0);
  for (const id of IDS.filter((id) => id !== "star")) {
    for (const slot of [6, 13, 14, 18, 20, 24]) assert.equal(share(id, slot), 0, `${id} at ${slot}`);
    for (const slot of [34, 44, 46, 50, 52, 56, 58, 62, 66, PET_SLOT, 120]) assert.equal(share(id, slot), 1, `${id} at ${slot}`);
    // Between the two it grows in: a figure growing into a card never jumps.
    let last = 0;
    for (let slot = 24; slot <= 34; slot += 0.5) {
      const now = share(id, slot);
      assert.ok(now >= last && now - last < 0.08, `${id} at ${slot}: ${last} → ${now}`);
      last = now;
    }
    assert.ok(share(id, 29) > 0.4 && share(id, 29) < 0.6);
  }
  // The star is the antenna's ball: it shows wherever there is one.
  assert.deepEqual([6, 13, 14].map((slot) => share("star", slot)), [0, 0, 0]);
  for (const slot of [16, 18, 20, 24, 34, 58, 120]) assert.equal(share("star", slot), 1);
});

test("on the small robot only the star is drawn; the tiny one and a pill's figure wear nothing", () => {
  const ops = (slot, outfit) => JSON.stringify(painted(outfit, headRadius(slot), {}, { model: "head" }).ops);
  for (const slot of [13, 18, 20, 24]) {
    for (const id of IDS.filter((id) => id !== "star")) assert.equal(ops(slot, id), ops(slot, "none"), `${id} at ${slot}`);
  }
  // No antenna, no star.
  assert.equal(ops(13, "star"), ops(13, "none"));
  for (const slot of [18, 20, 24]) assert.notEqual(ops(slot, "star"), ops(slot, "none"), `the star at ${slot}`);
  // In a card every one of them changes the picture.
  for (const id of IDS) assert.notEqual(ops(58, id), ops(58, "none"), id);

  // A still figure wears nothing unless told: the minis on the pills and in the compact island's grid.
  for (const slot of [13, 24, 58]) {
    const size = slot * CANVAS_PER_SLOT;
    const plain = recorder();
    paintSlotRobot(plain, size, { shell: [0.2, 0.6, 1] });
    const none = recorder();
    paintSlotRobot(none, size, { shell: [0.2, 0.6, 1], outfit: "none" });
    assert.deepEqual(plain.ops, none.ops);
  }
  assert.equal(stillPose().outfit, "none");
});

// ── The drawings ──────────────────────────────────────────────────────────────

const R = headRadius(58);
const G = robotGeometry(R);
const plain = painted("none");

/**
 * The widest and the tallest an eye gets, in R: the biggest of its shapes, or
 * a state's shape at the size that state gives its bigger eye (a question's).
 */
const EYE = (() => {
  const shapes = Object.values(EYE_SHAPES);
  const states = Object.values(ROBOT_STATES).map((s) => ({ shape: EYE_SHAPES[s.eyes.shape], scale: Math.max(...s.eyes.scale) }));
  return {
    halfW: Math.max(...shapes.map((s) => s.w), ...states.map((s) => s.shape.w * s.scale)) * G.eyeR,
    halfH: Math.max(...shapes.map((s) => s.h), ...states.map((s) => s.shape.h * s.scale)) * G.eyeR,
  };
})();

/** Where Liv can look, all the way: each side, up, down and the corners. */
const GAZES = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [1, 1], [-1, 1], [1, -1], [-1, -1]];

/** Points around the edge of the biggest eye on `side`, in R from the head's centre, while Liv looks towards `gaze`. */
function eyeEdge(side, gaze) {
  const cx = side * G.eyeX + gaze[0] * (GAZE_EYES[0] + GAZE_VISOR);
  const cy = G.eyeY + gaze[1] * (GAZE_EYES[1] + GAZE_VISOR);
  return Array.from({ length: 32 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return [cx + Math.cos(a) * EYE.halfW, cy + Math.sin(a) * EYE.halfH];
  });
}

/** The angles the context is turned by while `pose` is painted, in order. */
function turnsOf(pose) {
  const ctx = recorder();
  const made = [];
  const rotate = ctx.rotate;
  ctx.rotate = (a) => (made.push(a), rotate(a));
  paintRobot(ctx, R, pose);
  return made;
}

test("nothing is drawn with a shadow blur or as an image, and nothing but the glasses is drawn with a line", () => {
  // The recorder throws on shadowBlur; an image would need drawImage, which it does not have.
  for (const id of IDS) {
    const ctx = painted(id);
    assert.ok(ctx.fills.length >= plain.fills.length, id);
    if (id === "glasses") assert.equal(ctx.strokes.length, 1, "the frame");
    else if (id === "headphones") assert.equal(ctx.strokes.length, 2, "the band and its pad");
    else if (id === "beanie") assert.equal(ctx.strokes.length, 1, "the knit, where there is room for it");
    else assert.equal(ctx.strokes.length, 0, id);
  }
  // The knit is fine detail: gone where the small robot's detail is gone, the cap itself not.
  const justAbove = painted("beanie", headRadius(25));
  assert.equal(justAbove.strokes.length, 0);
  assert.ok(justAbove.fills.length > painted("none", headRadius(25)).fills.length);
});

test("the glasses sit on the visor around the eyes: every eye fits its lens, wherever Liv looks", () => {
  const ctx = painted("glasses");
  // Two tinted lenses and one stroke for the frames, the bridge and the arms.
  assert.equal(ctx.fills.length, plain.fills.length + 2);
  const lenses = ctx.ops.filter((o) => o[0] === "ellipse" && near(o[3], GLASSES.rx * R)).map((o) => [o[1], o[3], o[4]]);
  assert.equal(lenses.length, 4, "each lens is filled, then outlined");
  assert.deepEqual(lenses.slice(0, 2).map((l) => Math.round(l[0] * 1000) / 1000), [-G.eyeX * R, G.eyeX * R].map((v) => Math.round(v * 1000) / 1000));
  // After the eyes: over them, on the glass.
  const lastEye = ctx.ops.findLastIndex((o) => o[0] === "ellipse" && near(o[3], G.eyeR * R));
  const firstLens = ctx.ops.findIndex((o) => o[0] === "ellipse" && near(o[3], GLASSES.rx * R));
  assert.ok(lastEye >= 0 && firstLens > lastEye);

  // The widest eye, with what of its travel the glasses do not follow, stays inside the frame.
  const slipX = GAZE_EYES[0] * (1 - GLASSES.follow);
  const slipY = GAZE_EYES[1] * (1 - GLASSES.follow);
  assert.ok(EYE.halfW + slipX < GLASSES.rx - GLASSES.frame / 2, `${EYE.halfW + slipX} in ${GLASSES.rx}`);
  assert.ok(EYE.halfH + slipY < GLASSES.ry - GLASSES.frame / 2, `${EYE.halfH + slipY} in ${GLASSES.ry}`);
  // The two lenses do not meet, and both stay on the glass.
  assert.ok(G.eyeX - GLASSES.rx > 0.03);
  assert.ok(G.eyeX + GLASSES.rx + GLASSES.frame / 2 < G.visorW / 2);
  assert.ok(GLASSES.ry + GLASSES.frame / 2 < G.visorH / 2);

  // The lenses are a thin tint, not a cover: every eye shape shows through.
  const tints = ctx.fills.filter((f) => typeof f !== "string" && f.stops.some(([, c]) => c.startsWith("rgba(255,201,138")));
  assert.equal(tints.length, 2);
  for (const [, colour] of tints[0].stops) {
    const alpha = Number(colour.slice(colour.lastIndexOf(",") + 1, -1));
    assert.ok(alpha > 0 && alpha <= 0.2, colour);
  }
  // The frame is never thinner than a pixel.
  for (const dpr of [1, 1.5, 2]) {
    const scaled = recorder(dpr);
    paintRobot(scaled, headRadius(34), stillPose({ outfit: "glasses" }));
    assert.ok(scaled.lineWidths.every((w) => w >= 1 - 1e-9), `@${dpr}: ${scaled.lineWidths}`);
  }

  // They turn with the head: looking aside moves them, by more than the visor and less than the eyes.
  const lensX = (gaze) => painted("glasses", R, { gaze }).ops.find((o) => o[0] === "ellipse" && near(o[3], GLASSES.rx * R));
  const aside = recorder();
  paintRobot(aside, R, { ...stillPose({ outfit: "glasses" }), gaze: [1, 0] });
  const moved = aside.box.right - painted("glasses", R, {}, { model: "head" }).box.right;
  assert.ok(lensX([1, 0]) && moved >= 0);
  assert.ok(GAZE_VISOR < GAZE_VISOR + GAZE_EYES[0] * GLASSES.follow && GLASSES.follow < 1);
});

test("the scarf wraps the lower third and stays under the eyes, wherever they look", () => {
  const ctx = painted("scarf", R, {}, { model: "head" });
  // The band, two ends (the one behind in the shade), the stripes and the knot.
  assert.equal(ctx.fills.length, painted("none", R, {}, { model: "head" }).fills.length + 5);
  // Its upper edge, at `x` across the head: a curve from one side to the other, lowest in the middle.
  const edgeAt = (x) => {
    const side = Math.sin(SCARF.from) * SCARF.out;
    const at = x / (Math.cos(SCARF.from) * SCARF.out);
    return SCARF.topMid + (side - SCARF.topMid) * at * at;
  };
  // Wherever Liv looks, no point of its biggest eye comes near that edge.
  for (const gaze of GAZES) {
    for (const side of [-1, 1]) {
      for (const [x, y] of eyeEdge(side, gaze)) {
        assert.ok(y < edgeAt(x) - 0.04, `looking ${gaze}: the eye at ${x}, ${y}, the scarf from ${edgeAt(x)}`);
      }
    }
  }
  // The lower third of the ball, a little proud of it: nothing above a third of the way down.
  assert.ok(Math.sin(SCARF.from) > 1 / 3 && SCARF.topMid > 0.5 && SCARF.bottomMid < 1 && SCARF.out > 1 && SCARF.out < 1.05);
  // The tail hangs below the ball, at one side.
  assert.ok(SCARF.knot[0] > 0.5 && SCARF.knot[1] + SCARF.length > 1);
  assert.ok(near(ctx.box.bottom, (SCARF.knot[1] + SCARF.length) * R, 0.02 * R), `${ctx.box.bottom / R}`);
});

test("the scarf's ends swing behind the body, with the antenna's lag, and hang plumb when the head tilts", () => {
  // The last two turns of the painting are the scarf's ends: the one behind, then the one in front.
  const ends = (more = {}) => turnsOf({ ...stillPose({ outfit: "scarf" }), ...more }).slice(-2);
  assert.deepEqual(ends(), [SCARF.apart, 0], "at rest the one in front hangs straight down");
  // The antenna's tip lags to the left (the body went right): the ends trail to the left too —
  // a turn clockwise takes what hangs to the left.
  const [, left] = ends({ sway: [-0.25, 0] });
  const [, right] = ends({ sway: [0.25, 0] });
  assert.ok(near(left, 0.25 * SCARF.swing) && near(right, -0.25 * SCARF.swing));
  // The body drops and the tip lags up: the ends float outward.
  assert.ok(near(ends({ sway: [0, -0.2] })[1], -0.2 * SCARF.lift));
  // The head tilts, and they still hang nearly plumb.
  assert.ok(near(ends({ tilt: 0.2 })[1], -0.2 * SCARF.plumb));
  // The one behind follows less: the two are out of step.
  const [behind, front] = ends({ sway: [-0.2, 0] });
  assert.ok(near(behind, front * SCARF.lag + SCARF.apart) && SCARF.lag < 1);
  // Never further than they can.
  assert.equal(ends({ sway: [0.3, -0.3] })[1], -SCARF.reach);
  assert.equal(ends({ sway: [-0.3, 0.3], tilt: -0.3 })[1], SCARF.reach);
  assert.ok(SCARF.reach < Math.PI / 4);
  // Swung out they reach past the ball; nothing else of the head does.
  const reach = (more) => painted("scarf", R, more, { model: "head" }).box.right;
  assert.ok(reach({ sway: [0.25, 0] }) > reach({}) + 0.05 * R);

  // In the engine: an error's shake sets them swinging, and they come to rest with the antenna.
  const robot = dressed("scarf");
  const tail = () => turnsOf(robot.pose()).at(-1);
  assert.equal(tail(), 0);
  robot.setState("error");
  const swung = [];
  run(robot, 0.5, () => swung.push(tail()));
  assert.ok(Math.max(...swung) > 0.08 && Math.min(...swung) < -0.08, `to both sides: ${Math.min(...swung)} … ${Math.max(...swung)}`);
  run(robot, 3);
  assert.ok(near(tail(), 0, 0.02));
  assert.equal(robot.changing, false);
  // A hop lifts them outward on the way down.
  robot.setState("finished");
  const hopped = [];
  run(robot, 1, () => hopped.push(tail()));
  assert.ok(Math.min(...hopped) < -0.08, `${Math.min(...hopped)}`);
});

test("the headphones: a band behind the antenna, a cup on each side at the height of the eyes", () => {
  const ctx = painted("headphones");
  // Two strokes for the band and its pad; a cushion and a cup on each side.
  assert.equal(ctx.strokes.length, 2);
  assert.equal(ctx.fills.length, plain.fills.length + 4);
  // The band is painted on the shell before the antenna's stem, which starts at the top of the head.
  const band = ctx.ops.findIndex((o) => o[0] === "arc" && near(o[3], PHONES.band * R));
  const stem = ctx.ops.findIndex((o) => o[0] === "moveTo" && near(o[2], -0.96 * R));
  const visor = ctx.ops.findIndex((o) => o[0] === "clip");
  const cups = ctx.ops.findIndex((o) => o[0] === "roundRect");
  assert.ok(band > 0 && stem > band, "behind the antenna");
  assert.ok(cups > stem && cups > visor, "the cups over the head");
  // It rests on the head, and passes under the antenna's ball.
  assert.ok(PHONES.band - PHONES.bandW / 2 <= 1 && PHONES.band + PHONES.padW / 2 < -G.ballY - G.ballR);
  // The cups: over the head's edge at the height of the eyes, clear of the glass and of the hand's shoulder.
  assert.ok(Math.abs(PHONES.cup[1] - G.eyeY) < 0.12);
  assert.ok(PHONES.cup[0] - PHONES.cupW / 2 < 1 && PHONES.cup[0] + PHONES.cupW / 2 > 1);
  assert.ok(PHONES.cup[0] + PHONES.cushionX - PHONES.cushionW / 2 > G.visorW / 2 + GAZE_VISOR, "nothing of them on the glass");
  assert.ok(PHONES.cup[1] + PHONES.cupH / 2 < 0.3 - 0.1, "above the hand's shoulder (look.ts: HAND)");
  // The same on both sides.
  const head = painted("headphones", R, {}, { model: "head" });
  assert.ok(near(-head.box.left, head.box.right, 1e-6));
});

test("the cups pulse a little on the beat while Liv dances, and not otherwise", () => {
  const width = (beat) => painted("headphones", R, { beat }, { model: "head" }).box.right;
  assert.ok(near(width(1) - width(0), (PHONES.pulse * PHONES.cupW * R) / 2, 1e-6));
  assert.ok(PHONES.pulse > 0 && PHONES.pulse <= 0.08, "very slightly");

  const robot = dressed("headphones");
  assert.equal(robot.pose().beat, 0);
  robot.setDancing(true);
  let hardest = 0;
  let softest = 1;
  run(robot, 0.6);
  run(robot, 2, (r) => {
    hardest = Math.max(hardest, r.pose().beat);
    softest = Math.min(softest, r.pose().beat);
  });
  assert.ok(hardest > 0.9 && softest < 0.1, `${softest} … ${hardest}`);
  robot.setDancing(false);
  run(robot, 1);
  assert.equal(robot.pose().beat, 0);
  // Nothing else moves to the beat.
  for (const id of ["glasses", "scarf", "beanie", "star"]) {
    assert.deepEqual(painted(id, R, { beat: 1 }).box, painted(id, R, { beat: 0 }).box, id);
  }
});

test("the beanie sits over the top of the glass and above the eyes, and the antenna comes out through it", () => {
  const ctx = painted("beanie");
  // The crown and its fold; the knit is lines.
  assert.equal(ctx.strokes.length, 1);
  // The antenna is painted last, over the cap: its ball is the cap's pompom.
  const lampFill = ctx.fills.at(-1);
  assert.equal(lampFill.kind, "radial");
  assert.deepEqual(lampFill.stops.at(-1), plain.fills.find((f) => f.kind === "radial" && f.at[5] === G.ballR * R).stops.at(-1));
  const cap = ctx.ops.findIndex((o) => o[0] === "moveTo" && near(o[1], -BEANIE.side[0] * R) && near(o[2], BEANIE.side[1] * R));
  const stem = ctx.ops.findIndex((o) => o[0] === "moveTo" && near(o[2], BEANIE.antennaFrom * R));
  assert.ok(cap > 0 && stem > cap, "the stem starts at the cap's top, after the cap");
  assert.equal(ctx.ops.filter((o) => o[0] === "moveTo" && near(o[2], -0.96 * R)).length, 0, "not from inside the head");
  // The nub the antenna stands on is under the cap.
  const nub = (c) => c.ops.filter((o) => o[0] === "ellipse" && near(o[2], -0.985 * R)).length;
  assert.deepEqual([nub(plain), nub(ctx)], [1, 0]);
  // The stem comes out of the top of the crown, under the ball.
  assert.ok(BEANIE.antennaFrom > BEANIE.top && BEANIE.antennaFrom < -1);
  assert.ok(BEANIE.top > G.ballY + G.ballR, "the ball clears the cap");

  // Over the visor's top edge: the cap is painted after the glass.
  const glass = ctx.ops.findIndex((o) => o[0] === "clip");
  assert.ok(cap > glass);
  const visorTop = visorPoint(G, -Math.PI / 2)[1];
  assert.ok(BEANIE.lowMid > visorTop + GAZE_VISOR, "it comes down over the top of the glass");
  // And above the highest an eye gets: looking all the way up, the visor with it.
  const highestEye = G.eyeY - GAZE_EYES[1] - GAZE_VISOR - EYE.halfH;
  assert.ok(BEANIE.lowMid < highestEye - 0.04, `the brim down to ${BEANIE.lowMid}, the eye up to ${highestEye}`);
  assert.ok(BEANIE.low[1] < BEANIE.lowMid && BEANIE.high[1] < BEANIE.highMid, "its edges sag in the middle, as on a ball");
});

test("the star is the antenna's light, star-shaped: the ball's colours, halo and blink", () => {
  const starPath = (ctx) => ctx.ops.filter((o) => o[0] === "moveTo").length;
  for (const state of STATES) {
    const ball = painted("none", R, {}, { state });
    const star = painted("star", R, {}, { state });
    // The same paints, in the same number: a halo when lit, and the light itself.
    assert.equal(star.fills.length, ball.fills.length, state);
    assert.deepEqual(new Set(colours(star)), new Set(colours(ball)), state);
    // The ball's disc is gone, a path stands in its place.
    const discs = (c) => c.ops.filter((o) => o[0] === "arc" && near(o[3], G.ballR * R)).length;
    assert.deepEqual([discs(ball), discs(star)], [1, 0], state);
    assert.equal(starPath(star), starPath(ball) + 1);
  }
  // Five points, the first straight up, reaching 1.9 ball radii where the ball is the design's.
  assert.deepEqual([STAR_LAMP.points, STAR_LAMP.reachFull, STAR_LAMP.reachSmall], [5, 1.9, 1.45]);
  const star = painted("star", R, {}, { model: "head" });
  assert.ok(near(star.box.top, (G.ballY - G.ballR * 1.9) * R, 1e-6));
  // On the small robot the ball is already big: the star reaches less.
  const small = robotGeometry(headRadius(20));
  assert.ok(near(painted("star", headRadius(20), {}, { model: "head" }).box.top, (small.ballY - small.ballR * 1.45) * headRadius(20), 1e-6));

  // Off, it is the dim neutral the ball is; flashing or blinking, it follows the engine like the ball.
  const robot = dressed("star");
  const lamp = (r) => {
    const ctx = recorder();
    paintRobot(ctx, R, r.pose());
    return colours(ctx);
  };
  const off = lamp(robot);
  assert.ok(off.includes(rgba([0.4, 0.475, 0.498])) || off.some((c) => c.startsWith("rgba(102,121,127")), "off: the antenna's neutral");
  robot.setState("approval");
  const seen = new Set();
  run(robot, 0.6, (r) => seen.add(r.pose().antennaColor.map((v) => Math.round(v * 20)).join()));
  assert.ok(seen.size > 3, "it blinks three times as the ball does");
  run(robot, 2);
  assert.ok(lamp(robot).includes(rgba(ROBOT_STATES.approval.color)));
});

test("the state's badge and what Liv sends up are painted after anything it wears", () => {
  for (const id of IDS) {
    const robot = dressed(id);
    robot.setState("approval");
    run(robot, 1.5);
    const size = 58 * CANVAS_PER_SLOT;
    const ctx = recorder();
    robot.draw(ctx, size, size);
    const badge = ctx.ops.findLastIndex((o) => o[0] === "fillText");
    const last = ctx.ops.findLastIndex((o) => ["bezierCurveTo", "roundRect", "ellipse"].includes(o[0]) || (o[0] === "arc" && !near(o[3], size)));
    assert.ok(badge > 0 && badge === ctx.ops.length - 1, `${id}: the badge's mark is the last thing drawn`);
    assert.ok(last < badge);

    // Hearts: in love's pink, after the figure.
    const loving = dressed(id);
    loving.react("love");
    run(loving, 0.8);
    const hearts = recorder();
    loving.draw(hearts, size, size);
    assert.equal(hearts.fills.at(-1), rgba(LOVE), `${id}: a heart on top`);
  }
});

// ── Putting on, taking off ────────────────────────────────────────────────────

test("an accessory pops on in 240 ms, a little past its size and back", () => {
  assert.deepEqual([OUTFIT_ON_MS, OUTFIT_OFF_MS], [240, 150]);
  const robot = new Robot();
  assert.deepEqual([robot.worn, robot.wear, robot.changing], ["none", 0, false]);
  robot.setOutfit("scarf");
  assert.deepEqual([robot.worn, robot.wear], ["scarf", 0]);
  assert.equal(robot.changing, true);
  let top = 0;
  let last = 0;
  run(robot, 0.23, (r, ms) => {
    top = Math.max(top, r.wear);
    if (ms <= 100) assert.ok(r.wear > last, `it grows: ${ms}`);
    last = r.wear;
  });
  assert.ok(top > 1.03 && top < 1.15, `a back ease: ${top}`);
  assert.equal(robot.changing, true);
  run(robot, 0.02);
  assert.deepEqual([robot.worn, robot.wear], ["scarf", 1]);
  assert.equal(robot.pose().outfit, "scarf");
  assert.equal(robot.pose().wear, 1);
});

test("what is on goes first, in 150 ms; then the new thing arrives", () => {
  const robot = dressed("scarf");
  assert.deepEqual([robot.worn, robot.wear, robot.changing], ["scarf", 1, false]);
  robot.setOutfit("glasses");
  const seen = [];
  run(robot, 0.14, (r, ms) => {
    assert.equal(r.worn, "scarf", `the scarf is still the one on at ${ms}`);
    seen.push(r.wear);
  });
  assert.ok(seen.every((w, i) => i === 0 || w < seen[i - 1]) && seen.at(-1) < 0.05, "and it only goes");
  assert.ok(seen.every((w) => w <= 1), "without a bounce");
  run(robot, 0.02);
  // The scarf is gone; the glasses start from nothing.
  assert.equal(robot.worn, "glasses");
  assert.ok(robot.wear < 0.2);
  run(robot, 0.22);
  assert.equal(robot.changing, true, "390 ms in all");
  run(robot, 0.03);
  assert.deepEqual([robot.worn, robot.wear, robot.changing], ["glasses", 1, false]);

  // Only ever one thing on: the pose names one outfit at each instant, never a blend.
  const order = [];
  robot.setOutfit("beanie");
  run(robot, 0.5, (r) => {
    const now = r.pose().outfit;
    if (order.at(-1) !== now) order.push(now);
  });
  assert.deepEqual(order, ["glasses", "beanie"]);
});

test("taking it off is the 150 ms alone; told the same thing again, nothing starts over", () => {
  const robot = dressed("headphones");
  robot.setOutfit("none");
  run(robot, 0.14);
  assert.equal(robot.worn, "headphones");
  run(robot, 0.02);
  assert.deepEqual([robot.worn, robot.wear, robot.changing], ["none", 0, false]);
  assert.equal(robot.pose().outfit, "none");

  robot.setOutfit("star");
  run(robot, 0.1);
  const midway = robot.wear;
  // Asked every frame: the same answer changes nothing.
  robot.setOutfit("star");
  assert.equal(robot.wear, midway);
  run(robot, 0.15);
  assert.deepEqual([robot.worn, robot.wear], ["star", 1]);
  robot.setOutfit("star");
  assert.equal(robot.changing, false);
});

test("a change of mind on the way: back to what was leaving, or on to a third thing, never through a fourth", () => {
  // The pointer crosses three chips in a moment: only the last one is put on.
  const robot = dressed("scarf");
  const worn = [];
  const note = (r) => {
    if (worn.at(-1) !== r.worn) worn.push(r.worn);
  };
  robot.setOutfit("glasses");
  run(robot, 0.05, note);
  robot.setOutfit("beanie");
  run(robot, 0.05, note);
  robot.setOutfit("star");
  run(robot, 0.6, note);
  assert.deepEqual(worn, ["scarf", "none", "star"].filter((o) => o !== "none"), "the scarf leaves, the star arrives");
  assert.deepEqual([robot.worn, robot.wear, robot.changing], ["star", 1, false]);

  // Back to what was on its way off: it comes back from where it was.
  robot.setOutfit("none");
  run(robot, 0.07);
  const low = robot.wear;
  assert.ok(low > 0.2 && low < 0.8);
  robot.setOutfit("star");
  run(robot, 0.01);
  assert.equal(robot.worn, "star");
  assert.ok(robot.wear >= low);
  run(robot, 0.24);
  assert.deepEqual([robot.worn, robot.wear, robot.changing], ["star", 1, false]);

  // Taken off while it was still arriving.
  const fresh = new Robot();
  fresh.setOutfit("beanie");
  run(fresh, 0.08);
  fresh.setOutfit("none");
  run(fresh, 0.16);
  assert.deepEqual([fresh.worn, fresh.wear, fresh.changing], ["none", 0, false]);
});

test("with nobody looking it simply has it on: no transition, no frame asked for", () => {
  const robot = new Robot();
  robot.setOutfit("beanie", false);
  assert.deepEqual([robot.worn, robot.wear, robot.changing], ["beanie", 1, false]);
  robot.setOutfit("glasses", false);
  assert.deepEqual([robot.worn, robot.wear, robot.changing], ["glasses", 1, false]);
  // In the middle of a change, out of sight: it is over.
  robot.setOutfit("scarf");
  run(robot, 0.05);
  assert.equal(robot.changing, true);
  robot.setOutfit("scarf", false);
  assert.deepEqual([robot.worn, robot.wear, robot.changing], ["scarf", 1, false]);
  robot.setOutfit("none", false);
  assert.deepEqual([robot.worn, robot.wear, robot.changing], ["none", 0, false]);
});

test("how each comes on: the glasses grow on the visor, the cap comes down, the rest land from a little bigger", () => {
  const half = (id, wear) => painted(id, R, { wear }, { model: "head" });
  const bare = painted("none", R, {}, { model: "head" });
  // Half way on, the cap is above its place and the antenna's foot half way up to its top.
  const cap = half("beanie", 0.5);
  assert.ok(cap.ops.some((o) => o[0] === "moveTo" && near(o[2], ((-0.96 + BEANIE.antennaFrom) / 2) * R)));
  assert.equal(cap.ops.filter((o) => o[0] === "ellipse" && near(o[2], -0.985 * R)).length, 1, "the nub still shows through");
  // The scarf and the headphones are wider than at rest, landing.
  for (const id of ["scarf", "headphones"]) {
    assert.ok(half(id, 0.5).box.right > half(id, 1).box.right + 0.05 * R, id);
    assert.ok(half(id, 1.08).box.right < half(id, 1).box.right, `${id} squeezes a little past its place`);
  }
  // The glasses are smaller, on the glass.
  const lens = (wear) => half("glasses", wear).ops.find((o) => o[0] === "ellipse" && near(o[3], GLASSES.rx * R));
  assert.ok(lens(1) && lens(0.5));
  // The star grows out of the ball, which shrinks away.
  const morph = half("star", 0.5);
  assert.ok(morph.ops.some((o) => o[0] === "arc" && near(o[3], G.ballR * R * 0.5)), "half a ball");
  assert.ok(near(morph.box.top, (G.ballY - G.ballR * STAR_LAMP.reachFull * 0.5) * R), "and half a star");
  assert.ok(half("star", 0.8).box.top < bare.box.top && half("star", 1).box.top < half("star", 0.8).box.top);
  // Nearly off, nothing of it is drawn at all.
  for (const id of IDS) assert.deepEqual(half(id, 0.005).ops, bare.ops, id);
});

// ── Frames ────────────────────────────────────────────────────────────────────

test("an accessory keeps no frame going once it is on: a resting robot is at rest in anything", () => {
  for (const id of IDS) {
    const robot = new Robot();
    robot.setLimbs(true);
    run(robot, 1);
    assert.equal(robot.changing, false);
    robot.setOutfit(id);
    let lastChange = 0;
    run(robot, 3, (r, ms) => {
      if (r.changing) lastChange = ms;
    });
    assert.ok(lastChange >= OUTFIT_ON_MS - 10 && lastChange <= OUTFIT_ON_MS, `${id}: changing until ${lastChange} ms`);
    run(robot, 10, (r) => assert.equal(r.changing, false, id));

    // After a hop and a shake everything it wears comes to rest with it.
    robot.setState("finished");
    run(robot, 4);
    robot.setState("error");
    run(robot, 4);
    assert.equal(robot.changing, false, `${id} after a hop and a shake`);
    // And once it is taken off.
    robot.setOutfit("none");
    run(robot, 0.2);
    assert.equal(robot.changing, false, `${id} taken off`);
  }
});

// ── The canvas ────────────────────────────────────────────────────────────────

/** Asserts that what `robot` draws at `slot` stays inside its canvas. */
function inside(robot, slot, what) {
  const size = slot * CANVAS_PER_SLOT;
  const ctx = recorder();
  robot.draw(ctx, size, size);
  const { left, top, right, bottom } = ctx.box;
  assert.ok(left >= 0 && top >= 0 && right <= size && bottom <= size, `${what} in ${slot}: ${JSON.stringify(ctx.box)} of ${size}`);
}

test("nothing Liv wears leaves its canvas: at every size, at rest and as it is put on in the middle of a hop", () => {
  for (const id of IDS) {
    for (const slot of SLOTS) {
      // The whole body only where the app draws it: in the cards (look.ts: modelFor).
      for (const limbs of slot >= 40 ? [false, true] : [false]) {
        const robot = new Robot(seededRandom(slot));
        robot.alive = slot >= 44;
        robot.setLimbs(limbs);
        robot.setOutfit(id, false);
        run(robot, 1);
        inside(robot, slot, `${id} at rest`);
        for (const state of ["approval", "finished", "error"]) {
          robot.setOutfit("none", false);
          robot.setState(state, true);
          // Put on as it leaves the ground: its overshoot comes at the top of the hop.
          robot.setOutfit(id);
          run(robot, 1.2, (r, ms) => inside(r, slot, `${id} ${state} at ${ms}`));
          robot.setOutfit("none");
          run(robot, 0.3, (r, ms) => inside(r, slot, `${id} off, ${state} at ${ms}`));
        }
      }
    }
  }
});

test("nor while Liv dances, is annoyed, dizzy, in love or greeting, nor leaning on its way across the desktop", () => {
  const acts = {
    dance: (r) => r.setDancing(true),
    annoyed: (r) => r.react("annoyed", -1),
    dizzy: (r) => r.react("dizzy"),
    love: (r) => r.react("love"),
    greeting: (r) => r.greet(),
    flying: (r) => r.fly(0.22, [-0.25, 0.12]),
    wave: (r) => r.perform("wave"),
  };
  for (const id of IDS) {
    for (const slot of [44, 58, 66, PET_SLOT]) {
      for (const [name, start] of Object.entries(acts)) {
        const robot = new Robot(seededRandom(slot));
        robot.alive = true;
        robot.setLimbs(true);
        robot.setOutfit(id, false);
        run(robot, 1);
        start(robot);
        run(robot, 3.6, (r, ms) => inside(r, slot, `${id} ${name} at ${ms}`));
      }
    }
  }
});

test("in the closed and the compact island the star fits with room to spare, at the top of a hop too", () => {
  for (const [islandH, cy, slot] of [[24, 12, 18], [32, 16, 20]]) {
    const size = slot * CANVAS_PER_SLOT;
    const robot = new Robot();
    robot.setOutfit("star", false);
    run(robot, 1);
    const top = (r) => {
      const ctx = recorder();
      r.draw(ctx, size, size);
      return ctx.box.top + (cy - size / 2);
    };
    assert.ok(top(robot) >= 2, `${slot}: ${top(robot)} px from the top edge`);
    // Its halo aside, which fades to nothing: the shape itself.
    const place = placeInSlot(size, "head");
    const g = robotGeometry(place.R);
    const starTop = cy + (place.cy - size / 2) + (g.ballY - g.ballR * STAR_LAMP.reachSmall) * place.R;
    assert.ok(starTop >= 2.5, `${slot}: the star's point ${starTop} px down`);
    assert.ok(starTop - 0.27 * place.R > 0.5, "at the top of a request's hop");
    assert.ok(islandH - (cy + (place.cy - size / 2) + place.R) >= 2);
  }
});
