// The upload canvas — port of UploadCanvasView.swift.
//
// While the sequence engine is active this canvas draws the whole island body:
// card, dashed drop frame, drop text, progress bar, the choose card, Liv and
// the file going into its visor. The island's own figure is hidden for the
// duration, because this canvas draws its own (liv.ts says what it does).

import { paintParticles, particleCount, seedParticles, type Particle } from "../core/particles";
import { canvasRatio } from "../core/scale";
import { State } from "../core/state";
import { SCRIPT_FONTS } from "../core/fonts";
import { N_, t } from "../i18n/i18n";
import type { Outfit } from "../robot/outfits";
import { paintLamp, paintRobot } from "../robot/paint";
import { uploadLiv, type UploadLiv } from "./liv";
import { USC, eIn, lerp, progressAt, type UploadFrame } from "./sequence";

const FONT = `system-ui, "Segoe UI Variable Text", "Segoe UI", ${SCRIPT_FONTS}, sans-serif`;

/** The card's inner right edge: no text runs past it. */
const TEXT_RIGHT = USC.CARD_X + USC.CARD_W - 16;
/** The two choose buttons, as drawn and as hit areas. */
const ASK_BTN = { x: 114, w: 168 };
const CANCEL_BTN = { x: 290, w: 120 };
/** Drop-zone chips (English keys, shown with `t()`). */
const CHIPS = [N_("PDF"), N_("Images"), N_("Code"), N_("Docs")];

/** Mirrors the reference `rr()`: a rounded rect, radius clamped to the box. */
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rad);
}

function text(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  font: string,
  color: string,
  align: CanvasTextAlign = "left",
) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  // SwiftUI's .leading / .center / .trailing anchors are vertically centred.
  ctx.textBaseline = "middle";
  ctx.fillText(s, x, y);
}

/**
 * The font that fits `s` in `maxW`: `weight size FONT`, or smaller down to
 * `minSize` for a longer translation. English was laid out for these widths
 * and keeps its size (only an overlong file name can make it shrink).
 */
export function fitFont(
  ctx: CanvasRenderingContext2D,
  s: string,
  maxW: number,
  weight: number,
  size: number,
  minSize = size * 0.75,
): string {
  let px = size;
  ctx.font = `${weight} ${px}px ${FONT}`;
  while (ctx.measureText(s).width > maxW && px > minSize) {
    px = Math.max(minSize, px - 0.5);
    ctx.font = `${weight} ${px}px ${FONT}`;
  }
  return ctx.font;
}

/** `s` cut with an ellipsis so it fits `maxW` in `font` (a file name that is too long). */
export function ellipsize(ctx: CanvasRenderingContext2D, s: string, maxW: number, font: string): string {
  ctx.font = font;
  if (ctx.measureText(s).width <= maxW) return s;
  let cut = s;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxW) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** A label that fits `maxW`: a smaller font first, then an ellipsis. */
function fitted(ctx: CanvasRenderingContext2D, s: string, maxW: number, weight: number, size: number) {
  const font = fitFont(ctx, s, maxW, weight, size);
  return { font, s: ellipsize(ctx, s, maxW, font) };
}

export interface UploadCanvasActions {
  /** Primary button — hand the file to the chat. */
  ask(): void;
  /** Secondary button. */
  cancel(): void;
}

export class UploadCanvas {
  /** Wrapper holding the canvas and the two invisible choose buttons. */
  readonly el: HTMLElement;
  /**
   * The drawing's own USC.W × USC.ISL_H box inside the wrapper: what is laid
   * out in the drawing's points (the choose buttons, the sessions a file can
   * be dropped on) goes in here.
   */
  readonly stage: HTMLElement;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private overlay: HTMLElement;
  private sizedFor = "";
  /**
   * The open island the drawing stands in — the canvas is that size, so the
   * file under the pointer is drawn all over it — and where the drawing's
   * corner is in it (core/layout.ts: stageOffset). The drawing itself never
   * changes size.
   */
  private room: { w: number; h: number; x: number; y: number } = { w: USC.W, h: USC.ISL_H, x: 0, y: 0 };
  /** Where the drop text stops: sooner while the sessions are listed on the right. */
  textRight: number = TEXT_RIGHT;
  readonly defaultTextRight: number = TEXT_RIGHT;
  /** What the sequence's Liv wears: what the island's own has on, which it stands in for. */
  outfit: Outfit = "none";
  /** The specks over the drop card, and when they were last moved on (seconds). */
  private specks: Particle[] = [];
  private specksAt = 0;

  constructor(actions: UploadCanvasActions) {
    this.canvas = document.createElement("canvas");
    this.canvas.id = "upload-canvas";

    // Invisible hit areas at the reference button positions. The labels are
    // painted on the canvas; these only catch the click.
    const mk = (x: number, w: number, onclick: () => void) => {
      const b = document.createElement("button");
      b.className = "upload-hit";
      b.style.left = `${x}px`;
      b.style.top = "113px";
      b.style.width = `${w}px`;
      b.style.height = "26px";
      b.addEventListener("click", onclick);
      return b;
    };
    this.overlay = document.createElement("div");
    this.overlay.id = "upload-overlay";
    this.overlay.append(mk(ASK_BTN.x, ASK_BTN.w, actions.ask), mk(CANCEL_BTN.x, CANCEL_BTN.w, actions.cancel));

    this.stage = document.createElement("div");
    this.stage.id = "upload-stage";
    this.stage.append(this.overlay);

    this.el = document.createElement("div");
    this.el.id = "upload-layer";
    this.el.append(this.canvas, this.stage);

    this.ctx = this.canvas.getContext("2d");
  }

  /**
   * The open island is `w` × `h`, and the drawing's corner is at (`x`, `y`)
   * in it. The inherited island is the drawing's own size, corner on corner.
   */
  setRoom(w: number, h: number, x: number, y: number) {
    this.room = { w, h, x, y };
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    this.stage.style.left = `${x}px`;
    this.stage.style.top = `${y}px`;
  }

  /** `wallTime` in seconds drives the marching dashes, like the macOS timeline. */
  draw(f: UploadFrame, wallTime: number) {
    const dpr = canvasRatio(window.devicePixelRatio, State.settings.islandScale);
    const { w, h, x, y } = this.room;
    const sized = `${dpr}|${w}|${h}`;
    if (this.sizedFor !== sized) {
      this.sizedFor = sized;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    // In the drawing's own points from here on, wherever it stands in the room.
    ctx.setTransform(dpr, 0, 0, dpr, x * dpr, y * dpr);
    ctx.clearRect(-x, -y, w, h);

    this.drawScene(ctx, f, wallTime);

    // The buttons only exist once the choose card has faded in.
    this.overlay.style.display = f.chooseAlpha > 0.5 ? "block" : "none";
  }

  // ── Scene ─────────────────────────────────────────────────────────────────

  /**
   * The specks of the Liv window (core/particles.ts) over the card while it
   * waits for a file: white, and green once a file is over it. Drawn inside
   * the card's clip, in the card's own corner.
   */
  private drawSpecks(ctx: CanvasRenderingContext2D, f: UploadFrame, wallTime: number) {
    if (f.zoneAlpha <= 0) {
      this.specksAt = 0;
      return;
    }
    if (this.specks.length === 0) {
      this.specks = seedParticles(USC.CARD_W, USC.CARD_H, particleCount(USC.CARD_W, USC.CARD_H));
    }
    const dt = this.specksAt ? Math.min(0.05, Math.max(0, wallTime - this.specksAt)) : 0;
    this.specksAt = wallTime;
    const tint = f.zoneOver ? "52,212,153" : "170,176,188";
    ctx.save();
    ctx.globalAlpha = f.zoneAlpha;
    ctx.translate(USC.CARD_X, USC.CARD_Y);
    paintParticles(ctx, this.specks, dt, wallTime, USC.CARD_W, USC.CARD_H, null, 0, (white, alpha) =>
      `rgba(${white ? "255,255,255" : tint},${alpha})`,
    );
    ctx.restore();
  }

  private drawScene(ctx: CanvasRenderingContext2D, f: UploadFrame, wallTime: number) {
    // Island background.
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, USC.W, USC.ISL_H);

    // Card.
    ctx.save();
    rr(ctx, USC.CARD_X, USC.CARD_Y, USC.CARD_W, USC.CARD_H, USC.CARD_R);
    ctx.clip();
    ctx.fillStyle = "#0D0E10";
    ctx.fillRect(USC.CARD_X, USC.CARD_Y, USC.CARD_W, USC.CARD_H);

    // Green glow, fanning up from the bottom edge of the card.
    if (f.greenWash > 0) {
      const gx = USC.CARD_X + USC.CARD_W / 2;
      const gy = USC.CARD_Y + USC.CARD_H;
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, USC.CARD_H * 1.5);
      g.addColorStop(0, `rgba(40,212,130,${f.greenWash * 0.9})`);
      g.addColorStop(0.55, `rgba(40,212,130,${f.greenWash * 0.3})`);
      g.addColorStop(1, "rgba(40,212,130,0)");
      ctx.fillStyle = g;
      ctx.fillRect(USC.CARD_X, USC.CARD_Y, USC.CARD_W, USC.CARD_H);
    }
    this.drawSpecks(ctx, f, wallTime);
    ctx.restore();

    // Dashed border, marching left to right at ~20 pt/s.
    if (f.zoneAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = f.zoneAlpha;
      ctx.strokeStyle = f.zoneOver ? "rgba(52,212,153,0.55)" : "rgba(255,255,255,0.14)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -wallTime * 20;
      rr(ctx, USC.CARD_X + 0.75, USC.CARD_Y + 0.75, USC.CARD_W - 1.5, USC.CARD_H - 1.5, USC.CARD_R - 0.5);
      ctx.stroke();
      ctx.restore();
    }

    if (f.zoneAlpha > 0 && f.textAlpha > 0) this.drawDropText(ctx, f);
    if (f.barAlpha > 0 || f.barReveal > 0) this.drawProgressBar(ctx, f);
    if (f.chooseAlpha > 0) this.drawChoose(ctx, f);

    const liv = uploadLiv(f, this.outfit);
    this.drawLiv(ctx, liv);
    if (f.fileVisible) this.drawFile(ctx, f, liv);
  }

  // ── Drop zone text and chips ──────────────────────────────────────────────

  private drawDropText(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    ctx.save();
    ctx.globalAlpha = f.textAlpha;
    const title = fitted(ctx, t("Drop your files here"), this.textRight - USC.TEXT_X, 500, 13);
    text(ctx, title.s, USC.TEXT_X, USC.TEXT_Y - 4, title.font, "#D5D7DB");

    // The macOS port measures chips the same rough way, so the row lines up; a
    // translation wider than that estimate gets the room it needs.
    const labels = CHIPS.map((chip) => t(chip));
    let chipPx = 11;
    const widths = () => {
      ctx.font = `500 ${chipPx}px ${FONT}`;
      return labels.map((l) => Math.max(l.length * 6.5 + 16, Math.ceil(ctx.measureText(l).width) + 16));
    };
    let ws = widths();
    const rowW = () => ws.reduce((a, b) => a + b, 0) + 6 * (ws.length - 1);
    while (rowW() > this.textRight - USC.TEXT_X && chipPx > 8.5) {
      chipPx -= 0.5;
      ws = widths();
    }
    let cx = USC.TEXT_X;
    labels.forEach((chip, i) => {
      const w = ws[i];
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      rr(ctx, cx, USC.TEXT_Y + 9, w, 18, 9);
      ctx.fill();
      text(ctx, chip, cx + 8, USC.TEXT_Y + 18, `500 ${chipPx}px ${FONT}`, "#B9BDC4");
      cx += w + 6;
    });
    ctx.restore();
  }

  // ── Progress bar ──────────────────────────────────────────────────────────

  private drawProgressBar(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    ctx.save();
    ctx.globalAlpha = Math.max(f.barAlpha, 0.001);

    const x0 = USC.BAR_X0;
    const x1 = USC.BAR_X1;
    const by = USC.BAR_Y;
    const barLen = (x1 - x0) * f.barReveal;

    // Room up to the percentage (or the check mark) at the bar's right end.
    const uploading = t("Uploading {name}", { name: State.droppedFile?.name ?? t("file") });
    const label = fitted(ctx, uploading, x1 - x0 - 56, 500, 12.5);
    text(ctx, label.s, x0, by - 30, label.font, "#A9ADB5");

    if (f.check > 0) {
      ctx.save();
      ctx.translate(x1 - 8, by - 30);
      ctx.scale(f.check, f.check);
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fillStyle = "#34D399";
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-3.6, 0.2);
      ctx.lineTo(-1, 2.8);
      ctx.lineTo(3.8, -2.6);
      ctx.strokeStyle = "#07130E";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    } else {
      text(ctx, `${Math.round(f.progress * 100)} %`, x1, by - 30, `500 12.5px ${FONT}`, "#A9ADB5", "right");
    }

    // Track.
    if (barLen > 0) {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      rr(ctx, x0, by - 3, barLen, 6, 3);
      ctx.fill();
    }

    // Fill.
    const fx = lerp(x0, x1, f.progress);
    if (fx > x0 + 1) {
      const flashGreen = `rgb(${Math.round(lerp(52, 110, f.flash))},${Math.round(
        lerp(211, 231, f.flash),
      )},${Math.round(lerp(153, 183, f.flash))})`;
      const g = ctx.createLinearGradient(x0, 0, fx, 0);
      g.addColorStop(0, "#1FA87A");
      g.addColorStop(1, flashGreen);
      ctx.fillStyle = g;
      rr(ctx, x0, by - 3, fx - x0, 6, 3);
      ctx.fill();
    }

    // Glow trail, its length driven by how fast the bar is moving.
    if (f.progress > 0.01 && f.progress < 1) {
      const v =
        (progressAt(f.t + 0.01, USC.T_PROG_START, f.progEnd) -
          progressAt(f.t, USC.T_PROG_START, f.progEnd)) / 0.01;
      const tl = Math.max(8, Math.min(34, 8 + v * 40));
      const g = ctx.createLinearGradient(fx - tl, 0, fx, 0);
      g.addColorStop(0, "rgba(52,212,153,0)");
      g.addColorStop(1, "rgba(110,231,183,0.6)");
      ctx.save();
      ctx.filter = "blur(3px)";
      ctx.fillStyle = g;
      rr(ctx, fx - tl, by - 4, tl, 8, 4);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // ── Choose card ───────────────────────────────────────────────────────────

  private drawChoose(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    ctx.save();
    ctx.globalAlpha = f.chooseAlpha;
    ctx.translate(0, (1 - f.chooseAlpha) * 4);

    const maxW = TEXT_RIGHT - 114;
    const ready = fitted(ctx, t("{name} is ready.", { name: State.droppedFile?.name ?? t("file") }), maxW, 600, 14);
    text(ctx, ready.s, 114, 80, ready.font, "#F5F6F8");
    const what = fitted(ctx, t("What do you want to do with it?"), maxW, 400, 12.5);
    text(ctx, what.s, 114, 100, what.font, "#9398A1");

    ctx.fillStyle = "#F5F6F8";
    rr(ctx, ASK_BTN.x, 113, ASK_BTN.w, 26, 13);
    ctx.fill();
    const ask = fitted(ctx, t("Ask a question about it"), ASK_BTN.w - 14, 500, 12.5);
    text(ctx, ask.s, ASK_BTN.x + ASK_BTN.w / 2, 126, ask.font, "#0B0C0E", "center");

    ctx.fillStyle = "rgba(255,255,255,0.09)";
    rr(ctx, CANCEL_BTN.x, 113, CANCEL_BTN.w, 26, 13);
    ctx.fill();
    const cancel = fitted(ctx, t("Cancel"), CANCEL_BTN.w - 14, 500, 12.5);
    text(ctx, cancel.s, CANCEL_BTN.x + CANCEL_BTN.w / 2, 126, cancel.font, "#F1F2F4", "center");
    ctx.restore();
  }

  // ── Liv ───────────────────────────────────────────────────────────────────

  /**
   * Liv, whole, and the light of its antenna. Going into that light and
   * coming back out of it the body is scaled around its own head, which keeps
   * its antenna's end on the light.
   */
  private drawLiv(ctx: CanvasRenderingContext2D, { body, lamp }: UploadLiv) {
    if (body) {
      ctx.save();
      ctx.translate(body.x, body.y);
      ctx.scale(body.share, body.share);
      ctx.globalAlpha = body.alpha;
      paintRobot(ctx, body.R, body.pose);
      ctx.restore();
    }
    if (lamp) paintLamp(ctx, lamp.x, lamp.y, lamp.r, lamp.color, lamp.light);
  }

  // ── The file ──────────────────────────────────────────────────────────────

  /**
   * The file under the cursor. Once let go it heads for the middle of Liv's
   * visor, shrinking to nothing and fading on the way.
   */
  private drawFile(ctx: CanvasRenderingContext2D, f: UploadFrame, liv: UploadLiv) {
    const k = eIn(f.suck);
    ctx.save();
    ctx.globalAlpha = 0.92 * (1 - k);
    ctx.translate(lerp(f.cursorX, liv.mouth.x, k), lerp(f.cursorY + 14, liv.mouth.y, k));
    ctx.scale(1 - k, 1 - k);
    drawDoc(ctx);
    ctx.restore();
  }
}

// ── Document icon ───────────────────────────────────────────────────────────

/**
 * The generic sheet with a folded corner. macOS swaps in the real file icon from
 * NSWorkspace; Windows has no equivalent reachable from the webview, so this is
 * the shape in every case — it is the same fallback the Swift draws. Centred
 * on the origin.
 */
function drawDoc(ctx: CanvasRenderingContext2D) {
  const w = 34;
  const h = 42;
  const x = -w / 2;
  const y = -h / 2;
  const fold = 8;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  ctx.moveTo(x + 2, y);
  ctx.lineTo(x + w - fold, y);
  ctx.lineTo(x + w, y + fold);
  ctx.lineTo(x + w, y + h - 2);
  ctx.quadraticCurveTo(x + w, y + h, x + w - 2, y + h);
  ctx.lineTo(x + 2, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - 2);
  ctx.lineTo(x, y + 2);
  ctx.quadraticCurveTo(x, y, x + 2, y);
  ctx.closePath();
  ctx.fillStyle = "#F4F4F6";
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(x + w - fold, y);
  ctx.lineTo(x + w - fold, y + fold);
  ctx.lineTo(x + w, y + fold);
  ctx.closePath();
  ctx.fillStyle = "#D5D6DB";
  ctx.fill();

  ctx.fillStyle = "#3B82F5";
  rr(ctx, x + w * 0.18, y + h * 0.58, w * 0.64, h * 0.16, 2);
  ctx.fill();
}
