// The island's size (Settings → General → Island size): the whole island drawn
// bigger, its text with it.
//
// Rust grows the window and zooms the webview by the same factor
// (src-tauri/src/scale.rs), so the page keeps its 720×320 CSS px and every size
// in layout.ts and style.css stays what it is: the cursor, the island's shape
// and the closed island's size travel in CSS px, as before. All the page has to
// do is paint its canvases at the pixel ratio the zoom gives it. No DOM here.

/** The sizes Settings offers, 1 being the island as designed. */
export const ISLAND_SCALES: readonly number[] = [1, 1.1, 1.25, 1.5];

/** The allowed size nearest to `value`; 1 for anything that is not a number. */
export function islandScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  let best = ISLAND_SCALES[0];
  for (const size of ISLAND_SCALES) {
    if (Math.abs(size - value) < Math.abs(best - value)) best = size;
  }
  return best;
}

/** A size as Settings shows it: "125 %". */
export function scaleLabel(size: number): string {
  return `${Math.round(size * 100)} %`;
}

/**
 * The size a display holds the island to when it cannot fit the one asked
 * for (src-tauri/src/scale.rs `fit`): Settings then says so under its size
 * buttons. Null when the island has the size asked for, and while the size in
 * force is not known.
 */
export function clampedScale(asked: unknown, inForce: number | null): number | null {
  if (inForce == null) return null;
  const size = islandScale(inForce);
  return size < islandScale(asked) ? size : null;
}

/** At the island's own size a canvas is painted at up to twice its CSS size. */
const MAX_CANVAS_RATIO = 2;

/**
 * The pixel ratio a canvas is painted at. The webview's zoom is part of
 * `devicePixelRatio` (a display at 125 % with the island at 150 % reports
 * 1.875), so a bigger island raises the cap by as much: a canvas that was
 * sharp at the island's own size stays sharp at every other.
 */
export function canvasRatio(devicePixelRatio: number, size: number): number {
  const ratio = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  return Math.min(MAX_CANVAS_RATIO * islandScale(size), ratio);
}
