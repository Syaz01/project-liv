// What a webview does by itself as a browser, refused by Liv's pages: the
// browser's own keys (reload, find, print, back…), its right-click menu and
// its zoom. A reload is the worst of them: the island's page holds the tasks
// and the cards agents are waiting on. Rust refuses the same at the source
// where it can (src-tauri/src/webview_guard.rs); this holds on its own.
//
// Nothing here touches the DOM until guardPage is handed a window.

import type { KeyPress } from "./shortcuts";

/** Ctrl + one of these does something in a browser and nothing in a text field. */
const CTRL_LETTERS = new Set([
  "r", // reload (with Shift: without the cache)
  "f", "g", // find, find next
  "p", // print — and "keep the island open", which the island runs itself
  "s", // save the page
  "u", // view its source
  "o", // open a file — and "open the selected item"
  "j", "h", // downloads, history
]);

/** The letter a press stands for: the layout's when it is a Latin one, else the key's position. */
function letter(e: KeyPress): string | null {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  return /^Key([A-Z])$/.exec(e.code)?.[1].toLowerCase() ?? null;
}

/**
 * Whether the webview would act on this key press by itself, as a browser.
 * The page cancels that and nothing else: the press still reaches whoever
 * listens for it, so Liv's own shortcuts on the same keys (Ctrl+P, Ctrl+O)
 * keep working. Nothing that types or edits text is ever one of these: AltGr
 * (Ctrl+Alt) combinations, the arrows by word, Backspace, copy and paste.
 */
export function isBrowserAccelerator(e: KeyPress): boolean {
  // Reload, find next, caret browsing — whatever is held with them.
  if (e.key === "F5" || e.key === "F3" || e.key === "F7") return true;
  // The keyboard's own browser keys.
  if (e.key === "BrowserRefresh" || e.key === "BrowserBack" || e.key === "BrowserForward") return true;
  // Back and forward.
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return true;
  // Ctrl alone from here on: with Alt it is AltGr, which types.
  if (!e.ctrlKey || e.altKey || e.metaKey) return false;
  // Zoom.
  if (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0") return true;
  const pressed = letter(e);
  return pressed != null && CTRL_LETTERS.has(pressed);
}

/** The kinds of <input> that hold no text: right-clicked, they get the page's menu. */
const NOT_TEXT_INPUTS = new Set([
  "button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit",
]);

/**
 * Whether `target` is a field whose text can be edited. The right-click menu
 * stays there (cut, copy, paste); anywhere else it is the page's own, with
 * Refresh and Back in it.
 */
export function editsText(target: unknown): boolean {
  const el = target as {
    tagName?: string; type?: string; readOnly?: boolean; disabled?: boolean; isContentEditable?: boolean;
  } | null;
  if (!el) return false;
  if (el.isContentEditable === true) return true;
  if (el.readOnly === true || el.disabled === true) return false;
  if (el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && !NOT_TEXT_INPUTS.has((el.type ?? "text").toLowerCase());
}

/** Makes a page refuse the browser's own keys, right-click menu and Ctrl+wheel zoom. */
export function guardPage(page: Pick<Window, "addEventListener">) {
  // Capture phase, and only ever preventDefault: a field that keeps its keys
  // to itself is covered too, and no listener loses a press.
  page.addEventListener(
    "keydown",
    (e) => {
      if (isBrowserAccelerator(e)) e.preventDefault();
    },
    true,
  );
  page.addEventListener(
    "contextmenu",
    (e) => {
      if (!editsText(e.target)) e.preventDefault();
    },
    true,
  );
  page.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false },
  );
}
