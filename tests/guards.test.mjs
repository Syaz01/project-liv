// What Liv's pages refuse of the webview's own behaviour as a browser
// (src/core/guards.ts): its keys, its right-click menu, its zoom — and, in the
// island, a link or text dragged onto it (src/core/bridge.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { editsText, guardPage, isBrowserAccelerator } from "../src/core/guards.ts";
import { ISLAND_SHORTCUTS, islandKeyAction } from "../src/core/shortcuts.ts";

const press = (over) => ({ key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over });
const ctrl = (key, code = "", over = {}) => press({ key, code, ctrlKey: true, ...over });

// ── Keys ──────────────────────────────────────────────────────────────────────

test("the browser's own keys are recognised", () => {
  const taken = {
    reload: [press({ key: "F5" }), ctrl("F5"), press({ key: "F5", shiftKey: true }), ctrl("r", "KeyR"), ctrl("R", "KeyR", { shiftKey: true })],
    find: [ctrl("f", "KeyF"), ctrl("g", "KeyG"), ctrl("G", "KeyG", { shiftKey: true }), press({ key: "F3" }), press({ key: "F3", shiftKey: true })],
    "caret browsing": [press({ key: "F7" })],
    print: [ctrl("p", "KeyP"), ctrl("P", "KeyP", { shiftKey: true })],
    "save, source, open, downloads, history": [ctrl("s", "KeyS"), ctrl("u", "KeyU"), ctrl("o", "KeyO"), ctrl("j", "KeyJ"), ctrl("h", "KeyH")],
    "back and forward": [
      press({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }), press({ key: "ArrowRight", code: "ArrowRight", altKey: true }),
      press({ key: "BrowserBack" }), press({ key: "BrowserForward" }), press({ key: "BrowserRefresh" }),
    ],
    zoom: [ctrl("+"), ctrl("-"), ctrl("="), ctrl("0", "Digit0"), ctrl("+", "Equal", { shiftKey: true })],
  };
  for (const [what, presses] of Object.entries(taken)) {
    for (const e of presses) assert.equal(isBrowserAccelerator(e), true, `${what}: ${JSON.stringify(e)}`);
  }
});

test("on a layout without Latin letters the key's position stands for the letter", () => {
  // Ctrl+R on a Russian layout types "к" on the key at R's place, and still reloads.
  assert.equal(isBrowserAccelerator(ctrl("к", "KeyR")), true);
  assert.equal(isBrowserAccelerator(ctrl("з", "KeyP")), true);
  assert.equal(isBrowserAccelerator(ctrl("ф", "KeyA")), false);
  // AZERTY: the key labelled A sits at Q's place, and Ctrl+A is not one of them.
  assert.equal(isBrowserAccelerator(ctrl("a", "KeyQ")), false);
});

test("typing and editing are never taken", () => {
  const typed = [
    // Plain keys, in a field or not.
    ..."rfgpsuojh0-=+".split("").map((key) => press({ key })),
    press({ key: "R", shiftKey: true }),
    press({ key: "Backspace", code: "Backspace" }),
    press({ key: "Enter", code: "Enter" }),
    press({ key: " ", code: "Space" }),
    press({ key: "Escape", code: "Escape" }),
    press({ key: "Tab", code: "Tab" }),
    // The clipboard, undo and select all.
    ctrl("c", "KeyC"), ctrl("v", "KeyV"), ctrl("x", "KeyX"), ctrl("a", "KeyA"), ctrl("z", "KeyZ"), ctrl("y", "KeyY"),
    // The caret by word and by paragraph, with and without a selection.
    ctrl("ArrowLeft", "ArrowLeft"), ctrl("ArrowRight", "ArrowRight"), ctrl("ArrowUp", "ArrowUp"), ctrl("ArrowDown", "ArrowDown"),
    ctrl("ArrowLeft", "ArrowLeft", { shiftKey: true }), ctrl("Backspace", "Backspace"), ctrl("Delete", "Delete"),
    press({ key: "ArrowLeft", code: "ArrowLeft" }), press({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }),
    press({ key: "Home", code: "Home" }), press({ key: "End", code: "End" }),
    // AltGr is Ctrl+Alt on Windows: € on E, @ on Q or 2, } on 0, \ on the minus key…
    ctrl("€", "KeyE", { altKey: true }), ctrl("@", "KeyQ", { altKey: true }), ctrl("}", "Digit0", { altKey: true }),
    ctrl("r", "KeyR", { altKey: true }), ctrl("p", "KeyP", { altKey: true }), ctrl("0", "Digit0", { altKey: true }),
    ctrl("-", "Minus", { altKey: true }), ctrl("+", "Equal", { altKey: true }),
    // The other function keys, and the Windows key's combinations.
    press({ key: "F1" }), press({ key: "F2" }), press({ key: "F4", altKey: true }), press({ key: "F6" }), press({ key: "F12" }),
    press({ key: "r", code: "KeyR", metaKey: true }), ctrl("r", "KeyR", { metaKey: true }),
  ];
  for (const e of typed) assert.equal(isBrowserAccelerator(e), false, JSON.stringify(e));
});

/** One press for each of the island's own shortcuts (ISLAND_SHORTCUTS), and what it does in the overview. */
const ISLAND_KEYS = [
  ["Ctrl+→ / Ctrl+←", [ctrl("ArrowRight", "ArrowRight"), ctrl("ArrowLeft", "ArrowLeft")], "cycle"],
  ["Ctrl+1 – Ctrl+9", [ctrl("1", "Digit1"), ctrl("9", "Digit9")], "pill"],
  ["Ctrl+↓ / Ctrl+↑", [ctrl("ArrowDown", "ArrowDown"), ctrl("ArrowUp", "ArrowUp")], "list"],
  ["Ctrl+O", [ctrl("o", "KeyO")], "openSelection"],
  ["Ctrl+E", [ctrl("e", "KeyE")], "diff"],
  ["Ctrl+Enter", [ctrl("Enter", "Enter")], null],
  ["Ctrl+K", [ctrl("k", "KeyK")], null],
  ["Ctrl+,", [ctrl(",", "Comma")], "settings"],
  ["Ctrl+P", [ctrl("p", "KeyP")], "pin"],
  ["Esc", [press({ key: "Escape", code: "Escape" })], null],
];

test("each of the island's own shortcuts still does what it did", () => {
  assert.deepEqual(ISLAND_KEYS.map(([keys]) => keys), ISLAND_SHORTCUTS.map((s) => s.keys), "every shortcut Settings lists");
  const overview = { view: "overview", inTextField: false };
  for (const [keys, presses, kind] of ISLAND_KEYS) {
    for (const e of presses) {
      assert.equal(islandKeyAction(e, overview)?.kind ?? null, kind, keys);
      // Only the two that are also a browser's keys have the browser's part
      // cancelled, and cancelling is all the guard does (see guardPage below).
      assert.equal(isBrowserAccelerator(e), keys === "Ctrl+O" || keys === "Ctrl+P", keys);
    }
  }
  // Ctrl+K starts a new chat from the chat; Ctrl+Enter and Esc are read by the views and the island.
  assert.deepEqual(islandKeyAction(ctrl("k", "KeyK"), { view: "prompt", inTextField: true }), { kind: "newChat" });
});

// ── The right-click menu ──────────────────────────────────────────────────────

test("the right-click menu stays only where text is being edited", () => {
  const input = (type, over = {}) => ({ tagName: "INPUT", type, ...over });
  for (const type of ["text", "search", "url", "email", "password", "number", "tel", "TEXT"]) {
    assert.equal(editsText(input(type)), true, type);
  }
  assert.equal(editsText({ tagName: "INPUT" }), true, "an input without a type is a text field");
  assert.equal(editsText({ tagName: "TEXTAREA" }), true);
  assert.equal(editsText({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(editsText({ tagName: "SPAN", isContentEditable: true }), true, "anything inside an editable block");

  // A slider, a switch or a colour holds no text: its menu is the page's, Refresh included.
  for (const type of ["range", "checkbox", "radio", "color", "file", "button", "submit", "reset", "image", "hidden"]) {
    assert.equal(editsText(input(type)), false, type);
  }
  // So does a field that can't be edited.
  assert.equal(editsText(input("text", { readOnly: true })), false);
  assert.equal(editsText(input("text", { disabled: true })), false);
  assert.equal(editsText({ tagName: "TEXTAREA", readOnly: true }), false);
  for (const tagName of ["DIV", "BUTTON", "A", "CANVAS", "BODY", "SELECT", "IMG"]) {
    assert.equal(editsText({ tagName, isContentEditable: false }), false, tagName);
  }
  assert.equal(editsText(null), false);
  assert.equal(editsText(undefined), false);
});

// ── A page with the guard on ──────────────────────────────────────────────────

/** A window that only keeps its listeners, and events that say what was done to them. */
function guarded() {
  const listeners = [];
  guardPage({ addEventListener: (type, fn, options) => listeners.push({ type, fn, options }) });
  const fire = (type, over) => {
    const e = {
      prevented: false,
      preventDefault() { this.prevented = true; },
      // The guard must leave every press to whoever else listens for it.
      stopPropagation() { throw new Error("the guard must not stop an event"); },
      stopImmediatePropagation() { throw new Error("the guard must not stop an event"); },
      ...over,
    };
    for (const l of listeners.filter((x) => x.type === type)) l.fn(e);
    return e.prevented;
  };
  return { listeners, fire };
}

test("a guarded page cancels the browser's keys and lets every listener hear them", () => {
  const { listeners, fire } = guarded();
  const keydown = listeners.find((l) => l.type === "keydown");
  assert.equal(keydown.options, true, "capture phase: before a field that keeps its keys to itself");
  for (const e of [press({ key: "F5" }), ctrl("r", "KeyR"), ctrl("f", "KeyF"), ctrl("p", "KeyP"), ctrl("o", "KeyO"), ctrl("0", "Digit0")]) {
    assert.equal(fire("keydown", e), true, JSON.stringify(e));
  }
  for (const e of [press({ key: "r" }), ctrl("c", "KeyC"), ctrl("e", "KeyE"), ctrl("k", "KeyK"), press({ key: "Escape" }), press({ key: "Enter" })]) {
    assert.equal(fire("keydown", e), false, JSON.stringify(e));
  }
});

test("a guarded page has no right-click menu outside a text field, and no Ctrl+wheel zoom", () => {
  const { listeners, fire } = guarded();
  assert.equal(fire("contextmenu", { target: { tagName: "DIV" } }), true);
  assert.equal(fire("contextmenu", { target: { tagName: "CANVAS" } }), true);
  assert.equal(fire("contextmenu", { target: null }), true);
  assert.equal(fire("contextmenu", { target: { tagName: "INPUT", type: "range" } }), true);
  assert.equal(fire("contextmenu", { target: { tagName: "INPUT", type: "text" } }), false);
  assert.equal(fire("contextmenu", { target: { tagName: "TEXTAREA" } }), false);

  assert.equal(fire("wheel", { ctrlKey: true }), true);
  assert.equal(fire("wheel", { ctrlKey: false }), false);
  // A wheel listener may only cancel when it is not passive.
  assert.deepEqual(listeners.find((l) => l.type === "wheel").options, { passive: false });
});

// ── Drags onto the island ─────────────────────────────────────────────────────

test("a link or text dragged onto the island is refused, a file is taken", async () => {
  // WebView2's own bridge and the window's listeners, as the island's page has them.
  const posted = [];
  globalThis.chrome = { webview: { postMessageWithAdditionalObjects: (message, objects) => posted.push([message, objects]) } };
  const listeners = new Map();
  globalThis.addEventListener = (type, fn) => listeners.set(type, fn);
  globalThis.removeEventListener = () => {};
  const { onDragDrop } = await import("../src/core/bridge.ts");
  const told = [];
  await onDragDrop((e) => told.push(e.type));

  const drag = (type, types, files = []) => {
    const e = {
      dataTransfer: { types, files, dropEffect: "copy" },
      prevented: false,
      preventDefault() { this.prevented = true; },
    };
    listeners.get(type)(e);
    return e;
  };

  // A link from the browser, a selection from an editor: cancelled every time
  // (uncancelled, the webview follows a dropped link) and shown as "no drop".
  for (const types of [["text/uri-list", "text/plain"], ["text/plain"], ["text/html"], []]) {
    for (const type of ["dragenter", "dragover"]) {
      const e = drag(type, types);
      assert.equal(e.prevented, true, `${type} ${types}`);
      assert.equal(e.dataTransfer.dropEffect, "none", `${type} ${types}`);
    }
    assert.equal(drag("drop", types).prevented, true);
    drag("dragleave", types);
  }
  assert.deepEqual(told, [], "the island never hears of them");
  assert.deepEqual(posted, []);

  // A file is still taken, exactly as before.
  const file = { name: "notes.txt" };
  assert.equal(drag("dragenter", ["Files"]).prevented, true);
  const over = drag("dragover", ["Files"]);
  assert.deepEqual([over.prevented, over.dataTransfer.dropEffect], [true, "copy"]);
  assert.equal(drag("drop", ["Files"], [file]).prevented, true);
  assert.deepEqual(told, ["enter", "over"]);
  assert.deepEqual(posted, [["liv-file-drop", [file]]]);
});
