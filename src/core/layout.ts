// Island geometry — ported from IslandTypes.swift + IslandWindowController.islandSize
// + IslandRootView.botPosition. All values are page pixels, identical to the
// macOS app's points; the island's size setting scales the page (core/scale.ts).

/** `peek` is Liv's pocket: the island grown down just enough for the figure alone (Island.peek). */
export type IslandMode = "hidden" | "compact" | "peek" | "expanded";

export type IslandViewName =
  | "overview"
  | "empty"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "upload"
  | "uploading"
  | "choose"
  | "prompt"
  | "note"
  | "settings"
  | "recap"
  | "update"
  | "whatsNew"
  | "launch"
  | "wardrobe"
  | "tools"
  | "download";

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit";

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = auto-centred
  botDiameter: number;
}

// The open window is 720×320 (largest view, PANEL_W × PANEL_H in
// src-tauri/src/island.rs) like the macOS panel; the island is drawn inside
// it, glued to the top edge and horizontally centred. Closed, the window
// folds to the closed island alone (Island.updateWindowCollapsed). An island
// made wider or taller in Settings has a panel that grows with it
// (core/appearance.ts: panelSize).
export const PANEL_W = 720;
export const PANEL_H = 320;

// No notch on a PC: these are the hidden/compact sizes.
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 288; // NOTCH_W + 104
export const EXPANDED_W = 640;

export const ROUNDED_CORNER = 14; // hidden / compact
export const EXPANDED_CORNER = 22;

/**
 * The open island as its owner shaped it in Settings (core/appearance.ts):
 * how wide it is, and how much taller than each view asks for. Everything
 * here takes one and defaults to the inherited island, EXPANDED_W wide and
 * not a pixel taller.
 */
export interface OpenShape {
  width: number;
  extraHeight: number;
}

export const INHERITED_SHAPE: OpenShape = { width: EXPANDED_W, extraHeight: 0 };

// Liv's pocket: when a task finishes or fails, or to greet at launch, the
// island grows down from the top edge into a pocket for the whole figure and
// nothing else, with the open island's corners. Liv stands in the middle of
// it, in the cards' 58 slot, PEEK_BOT_Y below the top edge: room above for
// its antenna at the top of a hop, room below for its feet.
export const PEEK_W = 124;
export const PEEK_H = 116;
export const PEEK_BOT_D = 58;
export const PEEK_BOT_Y = 62;

export const VIEW_LAYOUTS: Record<IslandViewName, ViewLayout> = {
  overview: { height: 160, botX: 68, botY: null, botDiameter: 58 },
  empty: { height: 160, botX: 70, botY: null, botDiameter: 62 },
  approval: { height: 160, botX: 62, botY: null, botDiameter: 56 },
  question: { height: 160, botX: 62, botY: null, botDiameter: 56 },
  error: { height: 160, botX: 62, botY: null, botDiameter: 58 },
  finished: { height: 160, botX: 62, botY: null, botDiameter: 58 },
  // A download that finished: Liv on the left, the file and what to do with it.
  download: { height: 160, botX: 62, botY: null, botDiameter: 58 },
  upload: { height: 176, botX: 140, botY: 104, botDiameter: 62 },
  // botY 103 = bar top (42 + 58) + 3, so the dot really rides the bar. The Swift
  // layout says 118 while its own comment says 103; the comment matches the spec.
  uploading: { height: 176, botX: 46, botY: 103, botDiameter: 20 },
  choose: { height: 176, botX: 60, botY: 101, botDiameter: 52 },
  prompt: { height: 160, botX: 52, botY: null, botDiameter: 44 },
  note: { height: 160, botX: 60, botY: null, botDiameter: 50 },
  settings: { height: 160, botX: 54, botY: null, botDiameter: 46 },
  // Mac: 160. The extra 24 hold the two lines with top agent, project, busiest
  // day, longest session, permissions and questions, which the Mac card leaves
  // to the shared image.
  recap: { height: 184, botX: 62, botY: null, botDiameter: 58 },
  // New version: Liv on the left, the version and Update now (Mac: .update).
  update: { height: 160, botX: 62, botY: null, botDiameter: 58 },
  // After an update: what the new version brings, then "Your Liv so far".
  // Taller than a card, for two rows of items with their line.
  whatsNew: { height: 222, botX: 62, botY: null, botDiameter: 58 },
  // A new Claude Code session: Liv on the left, the project and the prompt (Mac: .launch).
  launch: { height: 160, botX: 58, botY: null, botDiameter: 52 },
  // What Liv wears: Liv on the left trying things on, a chip for each on the right.
  wardrobe: { height: 160, botX: 62, botY: null, botDiameter: 58 },
  // The tools: the clipboard's history on the left, the shelf on the right,
  // taller than a card for a list of rows. Liv is small, at the compact
  // island's size, in the left card's heading next to its title (the cards
  // start at y = 42; the heading is TOOLS_HEAD_H tall), clear of every row.
  tools: { height: 236, botX: 28, botY: 58, botDiameter: 20 },
};

// The upload views above are only the fallback geometry. Once a file is actually
// dropped the whole sequence — Liv included — is drawn by src/upload, which
// owns its own constants (USC) straight from UploadSequenceEngine.swift.

/** The question view with options to pick from: room for two rows of them. */
export const QUESTION_PICKER_H = 200;

/**
 * The approval view when what it asks about takes more than one line: room for
 * the command box at its full height, three and a half lines.
 */
export const APPROVAL_LONG_H = 200;

/**
 * The width a command has on the approval card's one line: the open island
 * less the content's padding and the card's border (10 + 1 on each side), the
 * stack's padding (116 + 16) and the box's own padding and border (10 + 1 on
 * each side).
 */
export function approvalLineWidth(islandWidth: number = EXPANDED_W): number {
  return islandWidth - 22 - 132 - 22;
}

/** The same on the inherited island. */
export const APPROVAL_LINE_W = approvalLineWidth();

/**
 * True when `text` takes more than the approval card's one line: it has a line
 * break or a tab in it, or is wider than the line (`width` measures it in the
 * box's font; the pixel taken off is for rounding). `lineWidth` is the line of
 * the island as wide as it is now.
 */
export function commandNeedsRoom(
  text: string,
  width: (text: string) => number,
  lineWidth: number = APPROVAL_LINE_W,
): boolean {
  return /[\r\n\t]/.test(text) || width(text) > lineWidth - 1;
}

/** Chat view grows with the conversation — IslandContainer.chatPromptHeight. */
export function chatPromptHeight(messageCount: number): number {
  return Math.min(300, 240 + messageCount * 40);
}

/**
 * The three views of the drop flow are one fixed drawing, USC.W × USC.ISL_H
 * (src/upload/sequence.ts: 640 × 176): in an island made wider or taller it
 * keeps that size and stands in the middle of the room, the header above it
 * staying where it is.
 */
export const STAGE_W = 640;
export const STAGED_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Where that drawing's top-left corner is in the open island. */
export function stageOffset(shape: OpenShape = INHERITED_SHAPE): { x: number; y: number } {
  return { x: (shape.width - STAGE_W) / 2, y: shape.extraHeight / 2 };
}

/**
 * The size of the island in each mode. Open, it is as wide as `shape` says and
 * `shape.extraHeight` taller than its view; hidden, compact and in Liv's
 * pocket it is what it always was.
 */
export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  chatCount = 0,
  shape: OpenShape = INHERITED_SHAPE,
): { w: number; h: number } {
  switch (mode) {
    case "hidden":
      // No notch to hide inside on a PC: the island retracts to zero height and
      // slides into the top edge of the screen instead of sitting there as a bar.
      return { w: NOTCH_W, h: 0 };
    case "compact":
      return { w: COMPACT_W, h: NOTCH_H };
    case "peek":
      return { w: PEEK_W, h: PEEK_H };
    case "expanded": {
      const h = view === "prompt" ? chatPromptHeight(chatCount) : VIEW_LAYOUTS[view].height;
      return { w: shape.width, h: h + shape.extraHeight };
    }
  }
}

export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/**
 * IslandRootView.botPosition — cx is measured from the island's left edge, cy
 * from its top edge. The cards are anchored to the left and centre what they
 * say, so Liv keeps its x at any width and follows the island's height; in
 * the drop flow it moves with the drawing (stageOffset).
 */
export function botPosition(
  mode: IslandMode,
  view: IslandViewName,
  islandH: number,
  uploadProgress = 0,
  shape: OpenShape = INHERITED_SHAPE,
): BotPlacement {
  switch (mode) {
    case "hidden":
      return { cx: 46, cy: 16, diameter: 6, opacity: 0 };
    case "compact":
      return { cx: 40, cy: 16, diameter: 20, opacity: 1 };
    case "peek":
      return { cx: PEEK_W / 2, cy: PEEK_BOT_Y, diameter: PEEK_BOT_D, opacity: 1 };
    case "expanded": {
      const layout = VIEW_LAYOUTS[view];
      const stage = STAGED_VIEWS.has(view) ? stageOffset(shape) : { x: 0, y: 0 };
      if (view === "uploading") {
        return {
          cx: stage.x + 36 + uploadProgress * 526,
          cy: stage.y + (layout.botY ?? 103),
          diameter: layout.botDiameter,
          opacity: 1,
        };
      }
      if (layout.botY != null) {
        return { cx: stage.x + layout.botX, cy: stage.y + layout.botY, diameter: layout.botDiameter, opacity: 1 };
      }
      // Centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const headerBottom = 42;
      const cardH = 84;
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx: layout.botX, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "working":
      return "#3B9EFF";
    case "thinking":
      return "#A78BFA";
    case "approval":
      return "#F5A524";
    case "error":
      return "#F4505E";
    case "finished":
      return "#34D399";
    case "ratelimit":
      return "#F59E0B";
    default:
      return "#FFFFFF";
  }
}

export function botGlowOpacity(s: BotStateName): number {
  return s === "idle" ? 0.15 : 0.65;
}

// Card wash colours (CardBackground.washColor)
export type Wash = "red" | "green" | "amber" | "cyan" | "indigo" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    default:
      return "rgba(0,0,0,0)";
  }
}
