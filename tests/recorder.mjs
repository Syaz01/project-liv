// A 2D context for the tests of what Liv's painters draw (src/robot): nothing
// is painted, everything is noted.

/**
 * A 2D context that paints nothing and notes everything: each call, each
 * colour used, and — following the transforms like a real one — how far the
 * shapes reach on the canvas. `dpr` is the scale it starts with.
 */
export function recorder(dpr = 1) {
  let m = [dpr, 0, 0, dpr, 0, 0];
  const stack = [];
  const ops = [];
  const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  const at = (x, y) => {
    const px = (m[0] * x + m[2] * y + m[4]) / dpr;
    const py = (m[1] * x + m[3] * y + m[5]) / dpr;
    box.left = Math.min(box.left, px);
    box.right = Math.max(box.right, px);
    box.top = Math.min(box.top, py);
    box.bottom = Math.max(box.bottom, py);
  };
  const around = (x, y, rx, ry = rx) => {
    for (const [dx, dy] of [[-rx, -ry], [rx, -ry], [rx, ry], [-rx, ry]]) at(x + dx, y + dy);
  };
  const mul = (n) => {
    m = [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  };
  const gradient = (kind, at) => ({ kind, at, stops: [], addColorStop(offset, color) { this.stops.push([offset, color]); } });
  const ctx = {
    ops,
    box,
    fills: [],
    strokes: [],
    lineWidths: [],
    save: () => stack.push(m),
    restore: () => (m = stack.pop()),
    translate: (x, y) => mul([1, 0, 0, 1, x, y]),
    scale: (x, y) => mul([x, 0, 0, y, 0, 0]),
    rotate: (a) => mul([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]),
    getTransform: () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }),
    beginPath() {},
    closePath() {},
    clip() {},
    moveTo: at,
    lineTo: at,
    quadraticCurveTo: (cx, cy, x, y) => (at(cx, cy), at(x, y)),
    bezierCurveTo: (ax, ay, bx, by, x, y) => (at(ax, ay), at(bx, by), at(x, y)),
    arc: (x, y, r) => around(x, y, r),
    ellipse: (x, y, rx, ry) => around(x, y, Math.max(rx, ry)),
    roundRect: (x, y, w, h) => (at(x, y), at(x + w, y + h)),
    fillText() {},
    createLinearGradient: (...at) => gradient("linear", at),
    createRadialGradient: (...at) => gradient("radial", at),
    fill() { ctx.fills.push(ctx.fillStyle); },
    stroke() {
      ctx.strokes.push(ctx.strokeStyle);
      ctx.lineWidths.push(ctx.lineWidth * Math.hypot(m[0], m[1]));
    },
    set shadowBlur(_) { throw new Error("no shadow blur: glows are gradients"); },
  };
  for (const name of ["beginPath", "arc", "ellipse", "roundRect", "moveTo", "fillText", "clip"]) {
    const real = ctx[name];
    ctx[name] = (...args) => (ops.push([name, ...args]), real(...args));
  }
  return ctx;
}

/** The colours a recorder was asked to fill with, gradients opened into their stops. */
export const colours = (ctx) => ctx.fills.flatMap((f) => (typeof f === "string" ? [f] : f.stops.map((s) => s[1])));
