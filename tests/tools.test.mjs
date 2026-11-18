// The Tools view: its rules (src/core/tools.ts), the lists coming from Rust
// (src/island/tools.ts, through the real bridge) and the view itself
// (src/views/tools.ts) on the fake DOM — what a row says, what a click, the
// row's small button and "Clear" ask of Rust, and what the card shows with
// nothing copied or with the history turned off; then the shelf — how an
// item reads, what a click, a drag and its small buttons ask of Rust, the
// screenshot buttons, and what a `capture` does. The history itself — what is
// recorded, the caps, the images — is tested in src-tauri/src/clipboard.rs;
// the shelf's list and its file in shelf.rs, the screenshots in capture.rs.
// The island's side of a file drop is in tests/pet-island.test.mjs.

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { calls, emit, internals, sent } from "./tauri.mjs";
import { installFakeDom } from "./fakedom.mjs";

const NOW = new Date(2027, 0, 20, 12).getTime();
mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });

installFakeDom();

// Rust's side: what each of the history's and the shelf's commands answers.
const rust = { history: null, paste: "pasted", shelf: null, copy: "copied" };
const answer = {
  clipboard_history: () => rust.history,
  clipboard_paste: () => rust.paste,
  shelf_list: () => rust.shelf,
  shelf_copy: () => rust.copy,
};
const invoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const plain = await invoke(cmd, args);
  return cmd in answer ? answer[cmd](args) : plain;
};
/** Lets what was asked of Rust be answered, and what follows from it happen. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
};

const {
  CAPTURE_NOTE_MS, DRAG_OUT_GRACE_MS, DRAG_START_PX, FRESH_MS, LABEL_CHARS, NAME_CHARS, NOTE_MS, Tools, agoLabel,
  captureOpensIsland, captureResult, clipEntries, clipboardEmptyText, dragStarts, entryLabel, itemDetail, oneLine,
  pasteNote, rowIcon, shelfItems, shelfTakesDrop, shortName, sizeLabel, swatchColor, textKind, thumbSource,
} = await import("../src/core/tools.ts");
const { VIEW_LAYOUTS, botPosition, islandSize, EXPANDED_W } = await import("../src/core/layout.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { lookup, setLanguage } = await import("../src/i18n/i18n.ts");
const { applyClipboard, loadClipboard, loadShelf, registerToolsHandlers } = await import("../src/island/tools.ts");
const { buildClipboardCard, buildShelfCard, buildTools } = await import("../src/views/tools.ts");

const THUMB = "data:image/png;base64,iVBORw0KGgo=";
const text = (id, preview, over = {}) => ({ id, kind: "text", preview, chars: [...preview].length, at: NOW, ...over });
const image = (id, over = {}) => ({ id, kind: "image", width: 640, height: 480, thumb: THUMB, at: NOW, ...over });
/** A list as Rust sends it: an address, a colour, a note over two lines, a screenshot. */
const sample = () => [
  text(4, "https://example.com/a?b=1"),
  text(3, "#1DB954", { at: NOW - 5 * 60_000 }),
  text(2, "  first line\r\n\tsecond   line  ", { at: NOW - 3 * 3_600_000 }),
  image(1, { at: NOW - 2 * 86_400_000 }),
];

// ── The rules ─────────────────────────────────────────────────────────────────

test("a text reads on one line: spaces and line breaks collapsed, the ends trimmed, the rest cut", () => {
  assert.equal(oneLine("  first line\r\n\tsecond   line  "), "first line second line");
  assert.equal(oneLine("one"), "one");
  assert.equal(oneLine(" \n "), "");
  assert.equal(oneLine("abcdef", 3), "abc…");
  assert.equal(oneLine("ab cdef", 3), "ab…", "no space before the ellipsis");
  assert.equal(oneLine("abc", 3), "abc");
  // Characters, not halves of one.
  assert.equal(oneLine("🙂🙂🙂", 2), "🙂🙂…");
  const long = oneLine("x".repeat(500));
  assert.equal([...long].length, LABEL_CHARS + 1);
});

test("a row's label is the text on one line, or the image's size", () => {
  const [link, , note, shot] = clipEntries(sample());
  assert.equal(entryLabel(link), "https://example.com/a?b=1");
  assert.equal(entryLabel(note), "first line second line");
  assert.equal(entryLabel(shot), "640 × 480");
});

test("a link and a colour are told from plain text, cheaply", () => {
  for (const link of ["https://example.com", "http://localhost:1420/dev/x.html", " HTTPS://EXAMPLE.COM/A?b=1#c \n"]) {
    assert.equal(textKind(link), "link", link);
  }
  for (const plain of ["example.com", "see https://example.com", "https://a b", "https://", "ftp://example.com", "javascript:alert(1)", ""]) {
    assert.equal(textKind(plain), "text", plain);
  }
  for (const color of ["#1DB954", "#fff", "#FFFF", "#1db95480", " #1DB954\n"]) {
    assert.equal(textKind(color), "color", color);
    assert.equal(swatchColor(color), color.trim());
  }
  // Not a colour: no swatch is ever painted with it.
  for (const not of ["#12", "#12345", "#1DB95G", "1DB954", "#1DB954;background:url(x)", "red", "# 1DB954"]) {
    assert.equal(textKind(not), "text", not);
    assert.equal(swatchColor(not), null, not);
  }
  const [link, color, note, shot] = clipEntries(sample());
  assert.deepEqual([link, color, note, shot].map(rowIcon), ["link", "color", "text", "image"]);
});

test("how long ago, in a few characters", () => {
  const ago = (ms) => agoLabel(NOW - ms, NOW);
  assert.equal(ago(0), "now");
  assert.equal(ago(59_000), "now");
  assert.equal(ago(60_000), "1m");
  assert.equal(ago(59 * 60_000), "59m");
  assert.equal(ago(60 * 60_000), "1h");
  assert.equal(ago(23 * 3_600_000 + 59 * 60_000), "23h");
  assert.equal(ago(24 * 3_600_000), "1d");
  assert.equal(ago(9 * 86_400_000), "9d");
  assert.equal(agoLabel(NOW + 30_000, NOW), "now", "a clock that went back");
  // The clock by default.
  assert.equal(agoLabel(NOW - 120_000), "2m");
  setLanguage("es");
  assert.equal(ago(0), "ahora");
  assert.equal(ago(5 * 60_000), "5 min");
  setLanguage("en");
});

test("what a click came to: pasted, only copied, not even that — or nothing to say", () => {
  assert.equal(pasteNote("pasted"), "Pasted");
  assert.equal(pasteNote("copied"), "Copied");
  assert.equal(pasteNote("failed"), "Couldn’t copy");
  // The entry is gone (its row goes with the next list), or nobody answered.
  for (const quiet of ["gone", null, undefined, "", "anything else"]) assert.equal(pasteNote(quiet), null);
  for (const said of ["Pasted", "Copied", "Couldn’t copy"]) assert.ok(lookup(said, "es"), said);
});

test("the card says why it lists nothing: nothing copied yet, or the history is off", () => {
  assert.equal(clipboardEmptyText(true, 0), "Nothing copied yet");
  assert.equal(clipboardEmptyText(true, 3), null);
  assert.equal(clipboardEmptyText(false, 0), "Clipboard history is off");
  assert.equal(clipboardEmptyText(false, 3), "Clipboard history is off", "off, what the page still holds is not shown");
});

test("only a PNG data URL is a thumbnail: nothing the webview would go and fetch", () => {
  assert.equal(thumbSource(THUMB), THUMB);
  for (const not of [
    "https://example.com/pixel.png", "//example.com/x.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:text/html;base64,AAAA",
    "data:image/png;base64,", "data:image/png;base64,AAAA\" onerror=\"x", "data:image/png,AAAA", "", null, undefined, 7, {},
  ]) {
    assert.equal(thumbSource(not), "", String(not));
  }
});

test("the list from Rust is taken apart: only entries, each id once, nothing trusted", () => {
  const entries = clipEntries(sample());
  assert.deepEqual(entries.map((e) => e.id), [4, 3, 2, 1]);
  assert.deepEqual(entries[0], {
    id: 4, kind: "text", preview: "https://example.com/a?b=1", chars: 25, width: 0, height: 0, thumb: "", at: NOW,
  });
  assert.deepEqual(entries[3], {
    id: 1, kind: "image", preview: "", chars: 0, width: 640, height: 480, thumb: THUMB, at: NOW - 2 * 86_400_000,
  });

  for (const nothing of [null, undefined, "list", 7, {}, { 0: text(1, "a") }]) assert.deepEqual(clipEntries(nothing), []);
  const odd = clipEntries([
    null, "text", 7, [],
    { kind: "text", preview: "no id" },
    { id: "5", kind: "text", preview: "an id that is not a number" },
    { id: 1.5, kind: "text", preview: "nor a whole one" },
    { id: 6, kind: "file", preview: "a kind this page does not have" },
    text(7, "kept"),
    text(7, "the same id again"),
    { id: 8, kind: "text", preview: 12, chars: -4, at: "yesterday" },
    image(9, { width: "wide", height: Number.NaN, thumb: "https://example.com/x.png" }),
  ]);
  assert.deepEqual(odd, [
    { id: 7, kind: "text", preview: "kept", chars: 4, width: 0, height: 0, thumb: "", at: NOW },
    { id: 8, kind: "text", preview: "", chars: 0, width: 0, height: 0, thumb: "", at: 0 },
    { id: 9, kind: "image", preview: "", chars: 0, width: 0, height: 0, thumb: "", at: NOW },
  ]);
});

// ── The view's place in the island ────────────────────────────────────────────

test("the tools view is taller than a card, and Liv is small in the left card's heading, clear of every row", () => {
  assert.deepEqual(VIEW_LAYOUTS.tools, { height: 236, botX: 28, botY: 58, botDiameter: 20 });
  assert.deepEqual(islandSize("expanded", "tools"), { w: EXPANDED_W, h: 236 });
  const liv = botPosition("expanded", "tools", 236);
  assert.deepEqual(liv, { cx: 28, cy: 58, diameter: 20, opacity: 1 });
  // The cards start under the header, 42 px down and 10 px in; the heading is
  // 30 px tall, and the rows start under it. Liv's slot is inside the heading,
  // before the title (the heading's 34 px of padding).
  const [cardLeft, cardTop, headH, titleAt] = [10, 42, 30, 34];
  assert.ok(liv.cy - liv.diameter / 2 >= cardTop + 1);
  assert.ok(liv.cy + liv.diameter / 2 <= cardTop + 1 + headH, "above the first row");
  assert.ok(liv.cx - liv.diameter / 2 >= cardLeft + 1);
  assert.ok(liv.cx + liv.diameter / 2 <= cardLeft + 1 + titleAt, "before the title");
  // The size it has in the compact island.
  assert.equal(liv.diameter, botPosition("compact", "overview", 32).diameter);
});

// ── The list from Rust ────────────────────────────────────────────────────────

let notified = 0;
State.subscribe(() => notified++);
// The island, as far as the tools know it: an alert opens it on a view.
const alerts = [];
const island = {
  alert(view) {
    alerts.push(view);
    State.mode = "expanded";
    State.view = view;
    State.notify();
  },
};
registerToolsHandlers(island);

beforeEach(() => {
  setLanguage("en");
  State.settings = { ...DEFAULT_SETTINGS };
  State.mode = "hidden";
  State.view = "overview";
  State.paused = false;
  State.parked = false;
  State.pendingApproval = null;
  // The island is shut, and the tools know it.
  State.notify();
  Tools.clipboard = [];
  Tools.shelf = [];
  Object.assign(Tools, { dropOver: false, dragOut: false, fresh: null, captureFailed: false });
  Object.assign(rust, { history: null, paste: "pasted", shelf: null, copy: "copied" });
  calls.length = 0;
  alerts.length = 0;
  notified = 0;
});

test("at startup the page asks once for what was copied before it listened — not with the history off", async () => {
  State.settings.clipboardHistory = false;
  await loadClipboard();
  assert.deepEqual(sent("clipboard_history"), []);

  State.settings.clipboardHistory = true;
  rust.history = sample();
  await loadClipboard();
  assert.equal(sent("clipboard_history").length, 1);
  assert.deepEqual(Tools.clipboard.map((e) => e.id), [4, 3, 2, 1]);
  assert.equal(notified, 0, "the island is hidden: nothing is told");
  assert.deepEqual(calls.map(([cmd]) => cmd), ["clipboard_history"], "and nothing else is asked of Rust");
});

test("a list coming in shows nothing and wakes nothing, unless the tools are on screen", () => {
  for (const [mode, view] of [["hidden", "overview"], ["hidden", "tools"], ["compact", "tools"], ["peek", "tools"], ["expanded", "overview"], ["expanded", "prompt"]]) {
    State.mode = mode;
    State.view = view;
    emit("clipboard-history", sample());
    assert.equal(notified, 0, `${mode} ${view}`);
    assert.deepEqual([State.mode, State.view], [mode, view], "the island is left as it is");
  }
  assert.deepEqual(Tools.clipboard.map((e) => e.id), [4, 3, 2, 1], "the page has the list all the same");
  assert.deepEqual(calls, [], "and Rust is asked nothing");

  // On screen: the view is drawn again.
  State.mode = "expanded";
  State.view = "tools";
  emit("clipboard-history", [text(5, "new"), ...sample()]);
  assert.equal(notified, 1);
  assert.deepEqual(Tools.clipboard.map((e) => e.id), [5, 4, 3, 2, 1]);
  // Cleared, or the history turned off: Rust sends an empty list.
  emit("clipboard-history", []);
  assert.deepEqual(Tools.clipboard, []);
  // Something that is not a list empties it too, rather than break the view.
  emit("clipboard-history", sample());
  emit("clipboard-history", null);
  assert.deepEqual(Tools.clipboard, []);
});

test("an answer that comes after a list has been heard is older than it, and dropped", async () => {
  emit("clipboard-history", [text(9, "heard")]);
  rust.history = sample();
  await loadClipboard();
  assert.deepEqual(Tools.clipboard.map((e) => e.id), [9]);
});

// ── The view ──────────────────────────────────────────────────────────────────

const opened = [];
let folded = 0;
const view = buildTools({ openSettingsWindow: (target) => opened.push(target), collapse: () => folded++ });
const [left, right] = view.el.children;
const rows = () => left.find(".clip-row");
const labels = () => rows().map((row) => row.find(".clip-label")[0].textContent);
const agos = () => rows().map((row) => row.find(".clip-ago")[0].textContent);
const [clearLink, settingsLink] = left.find(".tools-link");
const list = left.find(".clip-list")[0];
const empty = left.find(".tools-empty")[0];
const emptyText = empty.find("SPAN")[0];

/** The view as the island shows it with `entries` in the history. */
function show(entries) {
  State.mode = "expanded";
  State.view = "tools";
  emit("clipboard-history", entries);
  view.sync();
}

test("two cards side by side: the clipboard on the left, the shelf on the right", () => {
  show([]);
  assert.equal(view.el.className, "view tools");
  assert.deepEqual([left.className, right.className], ["left", "right"]);
  assert.equal(left.find(".tools-title")[0].textContent, "Clipboard");
  assert.equal(right.find(".tools-title")[0].textContent, "Shelf");
  assert.equal(right.find(".tools-empty")[0].textContent, "Drop files here");
  // Liv stands in the clipboard's heading, and only there.
  assert.ok(left.find(".tools-head")[0].classList.contains("liv"));
  assert.ok(!right.find(".tools-head")[0].classList.contains("liv"));
  // The shelf is a card of its own, built apart.
  const shelf = buildShelfCard();
  assert.ok(shelf.el.classList.contains("card"));
  assert.equal(shelf.el.find(".tools-title")[0].textContent, "Shelf");
  shelf.sync();

  setLanguage("es");
  view.sync();
  assert.equal(left.find(".tools-title")[0].textContent, "Portapapeles");
  assert.equal(right.find(".tools-title")[0].textContent, "Repisa");
  assert.equal(right.find(".tools-empty")[0].textContent, "Suelta archivos aquí");
  assert.equal(emptyText.textContent, lookup("Nothing copied yet", "es"));
});

test("one row per entry, newest first: its icon, its one line or its thumbnail and size, and how long ago", () => {
  show(sample());
  assert.deepEqual(labels(), ["https://example.com/a?b=1", "#1DB954", "first line second line", "640 × 480"]);
  assert.deepEqual(agos(), ["now", "5m", "3h", "2d"]);
  assert.equal(empty.style.display, "none");
  assert.notEqual(list.style.display, "none");
  assert.notEqual(clearLink.style.display, "none");

  const [link, color, note, shot] = rows();
  // A link and a plain text have an icon; a colour, a swatch of it.
  assert.equal(link.find(".clip-icon")[0].find("svg").length, 1);
  assert.equal(note.find(".clip-icon")[0].find("svg").length, 1);
  const swatch = color.find(".clip-icon")[0].find(".dot")[0];
  assert.match(swatch.getAttribute("style"), /background:#1DB954/);
  // An image is its thumbnail, with its size next to it.
  assert.ok(shot.classList.contains("image"));
  const thumb = shot.find("IMG")[0];
  assert.equal(thumb.getAttribute("src"), THUMB);
  assert.equal(shot.find(".clip-icon").length, 0);
  // Each row has its small button to forget it.
  for (const row of rows()) assert.equal(row.find(".clip-remove")[0].getAttribute("title"), "Remove");
});

test("what was copied is only ever text on the page: markup in it stays letters, and no address is fetched", () => {
  const markup = '<img src=x onerror="alert(1)"> <b>bold</b>';
  show([text(1, markup), image(2, { thumb: "https://example.com/track.png" })]);
  const [first, second] = rows();
  assert.equal(first.find(".clip-label")[0].textContent, markup);
  assert.equal(first.find("IMG").length, 0);
  assert.equal(first.find("B").length, 0);
  // An image whose thumbnail is not one of Rust's PNGs shows the image icon instead.
  assert.equal(second.find("IMG").length, 0);
  assert.equal(second.find(".clip-icon")[0].find("svg").length, 1);
  assert.equal(second.find(".clip-label")[0].textContent, "640 × 480");
});

test("a click on a row sends its id to be pasted, and the row says what came of it for a moment", async () => {
  show(sample());
  const row = rows()[1];
  row.find(".clip-main")[0].fire("click");
  assert.deepEqual(sent("clipboard_paste"), [{ id: 3 }], "the id and nothing else: never the text");
  await settle();
  // Rust put it back on the clipboard: it is the newest again.
  emit("clipboard-history", [text(3, "#1DB954"), text(4, "https://example.com/a?b=1"), ...sample().slice(2)]);
  view.sync();
  assert.equal(rows()[0], row, "the same row, moved to the top");
  assert.deepEqual(agos(), ["Pasted", "now", "3h", "2d"]);
  assert.ok(row.classList.contains("noted"));
  assert.equal(list.scrollTop, 0);

  mock.timers.tick(NOTE_MS);
  assert.deepEqual(agos(), ["now", "now", "3h", "2d"]);
  assert.ok(!row.classList.contains("noted"));

  // Liv's own window was in front: only copied. In Spanish too.
  rust.paste = "copied";
  setLanguage("es");
  rows()[2].find(".clip-main")[0].fire("click");
  await settle();
  assert.equal(agos()[2], "Copiado");
  mock.timers.tick(NOTE_MS);
  setLanguage("en");

  // The clipboard would not take it.
  rust.paste = "failed";
  rows()[3].find(".clip-main")[0].fire("click");
  await settle();
  assert.equal(agos()[3], "Couldn’t copy");
  mock.timers.tick(NOTE_MS);

  // Gone meanwhile, or nobody to answer: the row says nothing.
  for (const quiet of ["gone", null]) {
    rust.paste = quiet;
    rows()[0].find(".clip-main")[0].fire("click");
    await settle();
    assert.equal(agos()[0], "now", String(quiet));
    assert.ok(!rows()[0].classList.contains("noted"));
  }
  assert.deepEqual(sent("clipboard_paste").map((args) => args.id), [3, 2, 1, 3, 3]);
  assert.equal(notified, 2, "only the two lists were news for the island: the notes are the card's own");
});

test("the row's small button forgets its entry, and Clear all of them", () => {
  show(sample());
  rows()[2].find(".clip-remove")[0].fire("click");
  assert.deepEqual(sent("clipboard_remove"), [{ id: 2 }]);
  assert.deepEqual(sent("clipboard_paste"), [], "forgetting a row does not paste it");
  // The page waits for Rust's list: the row is still there until it comes.
  assert.equal(rows().length, 4);
  emit("clipboard-history", sample().filter((e) => e.id !== 2));
  view.sync();
  assert.deepEqual(labels(), ["https://example.com/a?b=1", "#1DB954", "640 × 480"]);

  clearLink.fire("click");
  assert.equal(sent("clipboard_clear").length, 1);
  emit("clipboard-history", []);
  view.sync();
  assert.equal(rows().length, 0);
  assert.equal(emptyText.textContent, "Nothing copied yet");
  assert.notEqual(empty.style.display, "none");
  assert.equal(list.style.display, "none");
  assert.equal(clearLink.style.display, "none", "nothing to clear");
  assert.equal(settingsLink.style.display, "none", "the history is on: no way to Settings is needed");
});

test("a new copy comes in above the rows that are there, which stay the very same rows", () => {
  show(sample());
  const before = rows();
  list.scrollTop = 40;
  emit("clipboard-history", [text(6, "newer"), text(5, "new"), ...sample()]);
  view.sync();
  const after = rows();
  assert.deepEqual(labels().slice(0, 2), ["newer", "new"]);
  assert.deepEqual(after.slice(2), before, "a press on one of them is not lost to a copy made meanwhile");
  assert.equal(list.scrollTop, 0, "what was just copied is shown");
  // The same list again changes nothing, not even where it is scrolled to.
  list.scrollTop = 40;
  view.sync();
  assert.deepEqual(rows(), after);
  assert.equal(list.scrollTop, 40);
  // The oldest fell off the end of Rust's list: its row goes, the others stay.
  emit("clipboard-history", [text(6, "newer"), text(5, "new"), ...sample().slice(0, 3)]);
  view.sync();
  assert.deepEqual(rows(), after.slice(0, 5));
  assert.equal(list.scrollTop, 40);
});

test("with the history off the card says so, lists nothing, and points at its switch", () => {
  show(sample());
  State.settings.clipboardHistory = false;
  view.sync();
  assert.equal(rows().length, 0, "what the page still holds is not shown");
  assert.equal(emptyText.textContent, "Clipboard history is off");
  assert.notEqual(empty.style.display, "none");
  assert.equal(clearLink.style.display, "none");
  assert.notEqual(settingsLink.style.display, "none");
  assert.equal(settingsLink.textContent, "Settings…");
  opened.length = 0;
  settingsLink.fire("click");
  assert.deepEqual(opened, [{ page: "general", anchor: "general.tools" }]);
  assert.deepEqual(calls.filter(([cmd]) => cmd.startsWith("clipboard_")), [], "nothing is asked of the clipboard while it is off");

  // On again: Rust starts from an empty list.
  State.settings.clipboardHistory = true;
  emit("clipboard-history", []);
  view.sync();
  assert.equal(emptyText.textContent, "Nothing copied yet");
  assert.equal(settingsLink.style.display, "none");
});

test("the clipboard's card stands on its own too", () => {
  const card = buildClipboardCard(() => {});
  Tools.clipboard = clipEntries(sample());
  card.sync();
  assert.equal(card.el.find(".clip-row").length, 4);
  assert.ok(card.el.classList.contains("card"));
});

// ── The shelf: its rules ──────────────────────────────────────────────────────

const file = (id, name, over = {}) => ({
  id, path: `C:\\files\\${name}`, name, size: 1_288_490, isDir: false, addedAt: NOW, thumb: "", missing: false, ...over,
});
/** A shelf as Rust sends it: a screenshot with its thumbnail, a document, a folder, a file that has gone. */
const shelfSample = () => [
  file(4, "Captura 2026-11-17 15.53.07.png", { thumb: THUMB, size: 482_133 }),
  file(3, "informe.pdf"),
  file(2, "proj", { isDir: true, size: 0 }),
  file(1, "borrado.zip", { missing: true, size: 0 }),
];

test("a size reads as the file manager says it: bytes, then one decimal under ten and none from there", () => {
  assert.equal(sizeLabel(0), "0 B");
  assert.equal(sizeLabel(980), "980 B");
  assert.equal(sizeLabel(1023), "1023 B");
  assert.equal(sizeLabel(1024), "1.0 KB");
  assert.equal(sizeLabel(1_288_490), "1.2 MB");
  assert.equal(sizeLabel(482_133), "470 KB");
  // Cut, never rounded up: a file does not read bigger than it is.
  assert.equal(sizeLabel(10 * 1024 - 1), "9.9 KB");
  assert.equal(sizeLabel(10 * 1024), "10 KB");
  assert.equal(sizeLabel(1024 ** 2 - 1), "1023 KB");
  assert.equal(sizeLabel(1024 ** 2), "1.0 MB");
  assert.equal(sizeLabel(5 * 1024 ** 3), "5.0 GB");
  assert.equal(sizeLabel(3.5 * 1024 ** 4), "3.5 TB");
  assert.equal(sizeLabel(5000 * 1024 ** 4), "5000 TB", "nothing bigger than a terabyte has a name here");
  for (const odd of [-1, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, "12"]) assert.equal(sizeLabel(odd), "0 B", String(odd));
  // Spanish writes the decimal with a comma.
  setLanguage("es");
  assert.equal(sizeLabel(1_288_490), "1,2 MB");
  assert.equal(sizeLabel(482_133), "470 KB");
  setLanguage("en");
});

test("a long name is cut in the middle: its start, then its last two characters and its extension", () => {
  assert.equal(NAME_CHARS, 12);
  // Short enough: as it is.
  for (const name of ["a.txt", "informe.pdf", "123456789.md", "README", ""]) assert.equal(shortName(name), name);
  // What tells one screenshot from the next is at the end.
  assert.equal(shortName("Captura 2026-11-17 15.53.07.png"), "Captu…07.png");
  assert.equal(shortName("Captura 2026-11-17 15.53.08.png"), "Captu…08.png");
  assert.equal(shortName("informe-trimestral-final.pdf"), "infor…al.pdf");
  assert.equal(shortName("fotos de la boda.jpeg"), "foto…da.jpeg");
  // Only the last extension counts as one.
  assert.equal(shortName("archive.tar.gz"), "archiv…ar.gz");
  // No extension, a name that starts with a dot, an "extension" too long or with a space in it: the two ends.
  assert.equal(shortName("a-very-long-name-without-one"), "a-very-lo…ne");
  assert.equal(shortName(".gitignore-backup-copy"), ".gitignor…py");
  assert.equal(shortName("notes.verylongextension"), "notes.ver…on");
  assert.equal(shortName("Mr. Smith goes to town"), "Mr. Smith…wn");
  // No space before the ellipsis, and never half a character.
  assert.equal(shortName("ab cdefghijklmno.txt", 10), "ab…no.txt");
  assert.equal(shortName(`${"🙂".repeat(13)}.png`), `${"🙂".repeat(5)}…🙂🙂.png`);
  // Every one of them fits.
  for (const name of ["Captura 2026-11-17 15.53.07.png", "archive.tar.gz", "x".repeat(300), `${"ñ".repeat(40)}.jpeg`]) {
    assert.equal([...shortName(name)].length, NAME_CHARS, name);
  }
  // No room for both ends: the start alone.
  assert.equal(shortName("abcdefghij.jpeg", 6), "abcde…");
  assert.equal(shortName("abcdefghij.jpeg", 1), "a…");
});

test("under its name an item says its size, that it is a folder, or that its file has gone", () => {
  const [shot, doc, folder, gone] = shelfItems(shelfSample());
  assert.deepEqual([shot, doc, folder, gone].map(itemDetail), ["470 KB", "1.2 MB", "Folder", "Missing"]);
  // A folder that has gone is missing first.
  assert.equal(itemDetail({ ...folder, missing: true }), "Missing");
  setLanguage("es");
  assert.deepEqual([shot, doc, folder, gone].map(itemDetail), ["470 KB", "1,2 MB", "Carpeta", "No encontrado"]);
  setLanguage("en");
});

test("a press becomes a drag once it has moved more than 4 px, in any direction", () => {
  assert.equal(DRAG_START_PX, 4);
  for (const [dx, dy] of [[0, 0], [4, 0], [0, -4], [2, 2], [-2.8, 2.8]]) assert.equal(dragStarts(dx, dy), false, `${dx},${dy}`);
  for (const [dx, dy] of [[4.1, 0], [0, 5], [-5, 0], [3, 3], [-3, -3], [40, -60]]) assert.equal(dragStarts(dx, dy), true, `${dx},${dy}`);
  // A pointer that says nowhere has not moved.
  assert.equal(dragStarts(Number.NaN, Number.NaN), false);
});

test("a dropped file is the shelf's only while the tools are what the open island shows", () => {
  assert.equal(shelfTakesDrop("expanded", "tools"), true);
  for (const [mode, view] of [
    ["compact", "tools"], ["hidden", "tools"], ["peek", "tools"],
    ["expanded", "overview"], ["expanded", "upload"], ["expanded", "prompt"], ["expanded", "approval"], ["hidden", "overview"],
  ]) {
    assert.equal(shelfTakesDrop(mode, view), false, `${mode} ${view}`);
  }
});

test("the shelf from Rust is taken apart: only items, each id once, nothing trusted", () => {
  const items = shelfItems(shelfSample());
  assert.deepEqual(items.map((it) => it.id), [4, 3, 2, 1]);
  assert.deepEqual(items[0], {
    id: 4, path: "C:\\files\\Captura 2026-11-17 15.53.07.png", name: "Captura 2026-11-17 15.53.07.png", size: 482_133,
    isDir: false, addedAt: NOW, thumb: THUMB, missing: false,
  });
  for (const nothing of [null, undefined, "list", 7, {}, { 0: file(1, "a") }]) assert.deepEqual(shelfItems(nothing), []);
  const odd = shelfItems([
    null, "file", 7, [],
    { path: "C:\\no-id.txt" },
    { id: "5", path: "C:\\an id that is not a number" },
    { id: 1.5, path: "C:\\nor a whole one" },
    { id: 6 },
    { id: 6, path: "" },
    file(7, "kept.txt"),
    file(7, "the same id again.txt"),
    { id: 8, path: "C:\\bare", name: 12, size: -4, isDir: "yes", addedAt: "yesterday", thumb: "https://example.com/x.png", missing: 1 },
  ]);
  assert.deepEqual(odd, [
    file(7, "kept.txt"),
    // Without a name the path stands for it; a picture that is not one of Rust's PNGs is not drawn.
    { id: 8, path: "C:\\bare", name: "C:\\bare", size: 0, isDir: false, addedAt: 0, thumb: "", missing: false },
  ]);
});

test("a capture event says what was taken, or only that nothing was", () => {
  assert.deepEqual(
    captureResult({ ok: true, id: 7, name: "Captura 2026-11-17 15.53.07.png", width: 1920, height: 1080 }),
    { ok: true, id: 7, name: "Captura 2026-11-17 15.53.07.png", width: 1920, height: 1080 },
  );
  assert.deepEqual(captureResult({ ok: false }), { ok: false });
  assert.deepEqual(captureResult({ ok: false, id: 3, name: "x" }), { ok: false });
  // Saved, but not on the shelf: nothing to light up.
  assert.deepEqual(captureResult({ ok: true, name: "a.png", width: 4, height: 4 }), { ok: true, id: null, name: "a.png", width: 4, height: 4 });
  assert.deepEqual(captureResult({ ok: true, id: "7", name: 5, width: -1 }), { ok: true, id: null, name: "", width: 0, height: 0 });
  for (const not of [null, undefined, "ok", 1, [], {}, { ok: "true" }, { ok: 1 }]) assert.equal(captureResult(not), null, JSON.stringify(not));
});

test("a screenshot opens the island as an alert would: not over a card that waits or what the user is doing, not paused, not parked", () => {
  const scene = (over) => ({ paused: false, parked: false, cardWaiting: false, expanded: false, view: "overview", ...over });
  // Shut, compact, or open on a card that only shows how things stand.
  assert.equal(captureOpensIsland(scene()), true);
  assert.equal(captureOpensIsland(scene({ view: "tools" })), true, "folded on the tools: it opens on them again");
  for (const view of ["overview", "finished", "error", "empty"]) {
    assert.equal(captureOpensIsland(scene({ expanded: true, view })), true, view);
  }
  // Open on something the user is doing.
  for (const view of ["prompt", "launch", "settings", "upload", "uploading", "choose", "wardrobe", "recap"]) {
    assert.equal(captureOpensIsland(scene({ expanded: true, view })), false, view);
  }
  // A card waits for an answer, folded or not.
  assert.equal(captureOpensIsland(scene({ cardWaiting: true })), false);
  assert.equal(captureOpensIsland(scene({ cardWaiting: true, expanded: true, view: "approval" })), false);
  // Nobody would see it.
  assert.equal(captureOpensIsland(scene({ paused: true })), false);
  assert.equal(captureOpensIsland(scene({ parked: true })), false);
});

// ── The shelf from Rust ───────────────────────────────────────────────────────

test("the shelf coming in shows nothing and wakes nothing, unless the tools are on screen", () => {
  for (const [mode, view] of [["hidden", "overview"], ["compact", "tools"], ["expanded", "overview"]]) {
    State.mode = mode;
    State.view = view;
    emit("shelf", shelfSample());
    assert.equal(notified, 0, `${mode} ${view}`);
    assert.deepEqual([State.mode, State.view], [mode, view], "the island is left as it is");
  }
  assert.deepEqual(Tools.shelf.map((it) => it.id), [4, 3, 2, 1], "the page has the list all the same");
  assert.deepEqual(calls, []);
  assert.deepEqual(alerts, []);

  State.mode = "expanded";
  State.view = "tools";
  emit("shelf", [file(5, "new.txt"), ...shelfSample()]);
  assert.equal(notified, 1);
  assert.deepEqual(Tools.shelf.map((it) => it.id), [5, 4, 3, 2, 1]);
  // Emptied, or something that is not a list.
  emit("shelf", null);
  assert.deepEqual(Tools.shelf, []);
});

test("the shelf is asked for as the page starts and each time the tools come up; an answer older than what was heard is dropped", async () => {
  rust.shelf = shelfSample();
  await loadShelf();
  assert.equal(sent("shelf_list").length, 1);
  assert.deepEqual(Tools.shelf.map((it) => it.id), [4, 3, 2, 1]);
  assert.equal(notified, 0, "the island is shut: nothing is told");

  // The tools come on screen: asked again — Rust looks at the files as it answers.
  rust.shelf = shelfSample().map((it) => (it.id === 3 ? { ...it, missing: true } : it));
  State.mode = "expanded";
  State.view = "tools";
  State.notify();
  await settle();
  assert.equal(sent("shelf_list").length, 2);
  assert.equal(Tools.shelf.find((it) => it.id === 3).missing, true);
  // Still on screen: not asked at every redraw.
  State.notify();
  State.notify();
  await settle();
  assert.equal(sent("shelf_list").length, 2);
  // Folded and opened again.
  State.mode = "compact";
  State.notify();
  State.mode = "expanded";
  State.notify();
  await settle();
  assert.equal(sent("shelf_list").length, 3);

  // An answer that was on its way when a list came: the list is the newer of the two.
  rust.shelf = shelfSample();
  const asked = loadShelf();
  emit("shelf", [file(9, "heard.txt")]);
  await asked;
  assert.deepEqual(Tools.shelf.map((it) => it.id), [9]);
});

// ── The shelf's card ──────────────────────────────────────────────────────────

const shelfCard = right.children[0];
const cells = () => right.find(".shelf-item");
const mains = () => cells().map((cell) => cell.find(".shelf-main")[0]);
const names = () => cells().map((cell) => cell.find(".shelf-name")[0].textContent);
const details = () => cells().map((cell) => cell.find(".shelf-detail")[0].textContent);
const grid = right.find(".shelf-grid")[0];
const shelfEmpty = right.find(".tools-empty")[0];
const shelfClear = right.find(".tools-link")[0];
const [shotArea, shotScreen] = right.find(".shelf-shot");
const failedNote = right.find(".shelf-note")[0];

/** The view as the island shows it with `items` on the shelf. */
function showShelf(items) {
  State.mode = "expanded";
  State.view = "tools";
  emit("shelf", items);
  view.sync();
}

test("the shelf's card: its title, the two screenshot buttons, and with nothing on it where to drop", () => {
  showShelf([]);
  assert.ok(shelfCard.classList.contains("card"));
  assert.equal(right.find(".tools-title")[0].textContent, "Shelf");
  assert.deepEqual([shotArea, shotScreen].map((b) => b.getAttribute("title")), ["Capture an area", "Capture the screen"]);
  assert.equal(shelfEmpty.textContent, "Drop files here");
  assert.notEqual(shelfEmpty.style.display, "none");
  assert.equal(grid.style.display, "none");
  assert.equal(shelfClear.style.display, "none", "nothing to clear");
  assert.equal(failedNote.style.display, "none");
  assert.ok(!shelfCard.classList.contains("drop"));
  setLanguage("es");
  view.sync();
  assert.deepEqual([shotArea, shotScreen].map((b) => b.getAttribute("title")), ["Capturar un área", "Capturar la pantalla"]);
  assert.equal(shelfClear.textContent, "Vaciar");
});

test("one item per file, newest first: its thumbnail or an icon, its name with the extension kept, and its size", () => {
  showShelf(shelfSample());
  assert.deepEqual(names(), ["Captu…07.png", "informe.pdf", "proj", "borrado.zip"]);
  assert.deepEqual(details(), ["470 KB", "1.2 MB", "Folder", "Missing"]);
  assert.equal(shelfEmpty.style.display, "none");
  assert.notEqual(grid.style.display, "none");
  assert.notEqual(shelfClear.style.display, "none");

  const [shot, doc, folder, gone] = cells();
  // The shell's picture, which the webview may not drag away by itself.
  const thumb = shot.find("IMG")[0];
  assert.equal(thumb.getAttribute("src"), THUMB);
  assert.equal(thumb.getAttribute("draggable"), "false");
  assert.equal(shot.find(".shelf-icon").length, 0);
  // No picture yet: a plain file, or a folder.
  for (const plain of [doc, folder, gone]) {
    assert.equal(plain.find("IMG").length, 0);
    assert.equal(plain.find(".shelf-icon")[0].find("svg").length, 1);
  }
  assert.notEqual(
    doc.find(".shelf-icon")[0].find("path")[0].getAttribute("d"),
    folder.find(".shelf-icon")[0].find("path")[0].getAttribute("d"),
  );
  // The whole name, and where the file is, on the item's tooltip.
  assert.equal(mains()[0].getAttribute("title"), "C:\\files\\Captura 2026-11-17 15.53.07.png");
  // Each has its three small buttons.
  for (const cell of cells()) {
    assert.deepEqual(cell.find(".icon-btn").map((b) => b.getAttribute("title")), ["Open", "Show in folder", "Remove"]);
  }
  assert.deepEqual(cells().map((cell) => cell.classList.contains("missing")), [false, false, false, true]);

  setLanguage("es");
  view.sync();
  assert.deepEqual(details(), ["470 KB", "1,2 MB", "Carpeta", "No encontrado"]);
  assert.deepEqual(doc.find(".icon-btn").map((b) => b.getAttribute("title")), ["Abrir", "Mostrar en la carpeta", "Quitar"]);
});

test("a file's name is only ever text on the page, and no address is fetched for its picture", () => {
  const markup = '<img src=x onerror="alert(1)">.png';
  showShelf([file(1, markup, { thumb: "https://example.com/track.png" })]);
  const [cell] = cells();
  assert.equal(cell.find("IMG").length, 0);
  assert.equal(cell.find(".shelf-icon").length, 1);
  assert.equal(cell.find(".shelf-name")[0].textContent, shortName(markup));
  assert.equal(mains()[0].getAttribute("title"), `C:\\files\\${markup}`);
});

test("a click on an item sends its id to be copied, and the item says what came of it for a moment", async () => {
  showShelf(shelfSample());
  const doc = cells()[1];
  mains()[1].fire("click");
  assert.deepEqual(sent("shelf_copy"), [{ id: 3 }], "the id and nothing else: never the path");
  await settle();
  assert.deepEqual(details(), ["470 KB", "Copied", "Folder", "Missing"]);
  assert.ok(doc.classList.contains("noted"));
  mock.timers.tick(NOTE_MS);
  assert.deepEqual(details(), ["470 KB", "1.2 MB", "Folder", "Missing"]);
  assert.ok(!doc.classList.contains("noted"));

  // A folder is copied like a file. In Spanish too.
  setLanguage("es");
  mains()[2].fire("click");
  await settle();
  assert.equal(details()[2], "Copiado");
  mock.timers.tick(NOTE_MS);
  setLanguage("en");

  // The clipboard would not take it.
  rust.copy = "failed";
  mains()[0].fire("click");
  await settle();
  assert.equal(details()[0], "Couldn’t copy");
  mock.timers.tick(NOTE_MS);

  // Gone meanwhile (Rust sends the list again, with the item missing), or nobody to answer: nothing is said.
  for (const quiet of ["gone", null]) {
    rust.copy = quiet;
    mains()[1].fire("click");
    await settle();
    assert.equal(details()[1], "1.2 MB", String(quiet));
    assert.ok(!cells()[1].classList.contains("noted"));
  }
  assert.deepEqual(sent("shelf_copy").map((args) => args.id), [3, 2, 4, 3, 3]);
  // Copying opens nothing, shows nothing and takes nothing off the shelf.
  assert.deepEqual(calls.map(([cmd]) => cmd).filter((cmd) => cmd !== "shelf_copy" && cmd !== "shelf_list"), []);
});

test("the small buttons open the item, show it in its folder or take it off the shelf, and Clear empties it", () => {
  showShelf(shelfSample());
  const doc = cells()[1];
  doc.find(".shelf-open")[0].fire("click");
  assert.deepEqual(sent("shelf_open"), [{ id: 3 }]);
  doc.find(".shelf-reveal")[0].fire("click");
  assert.deepEqual(sent("shelf_reveal"), [{ id: 3 }]);
  doc.find(".shelf-remove")[0].fire("click");
  assert.deepEqual(sent("shelf_remove"), [{ id: 3 }]);
  assert.deepEqual(sent("shelf_copy"), [], "none of them copies the file");
  // The page waits for Rust's list: the item is still there until it comes.
  assert.equal(cells().length, 4);
  emit("shelf", shelfSample().filter((it) => it.id !== 3));
  view.sync();
  assert.deepEqual(names(), ["Captu…07.png", "proj", "borrado.zip"]);

  shelfClear.fire("click");
  assert.equal(sent("shelf_clear").length, 1);
  emit("shelf", []);
  view.sync();
  assert.equal(cells().length, 0);
  assert.notEqual(shelfEmpty.style.display, "none");
  assert.equal(shelfClear.style.display, "none");
});

test("an item whose file has gone shows as missing and can only be removed", async () => {
  showShelf(shelfSample());
  const gone = cells()[3];
  const main = mains()[3];
  assert.ok(gone.classList.contains("missing"));
  assert.equal(details()[3], "Missing");
  // A click copies nothing; a press that moves drags nothing.
  main.fire("click");
  main.fire("pointerdown", { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
  main.fire("pointermove", { clientX: 60, clientY: 40 });
  main.fire("click");
  await settle();
  assert.deepEqual(sent("shelf_copy"), []);
  assert.deepEqual(sent("shelf_drag"), []);
  assert.equal(Tools.dragOut, false);
  // It is taken off the shelf like any other.
  gone.find(".shelf-remove")[0].fire("click");
  assert.deepEqual(sent("shelf_remove"), [{ id: 1 }]);

  // A file that goes while it is on the shelf: the same item, now missing — and back if it comes back.
  const doc = cells()[1];
  emit("shelf", shelfSample().map((it) => (it.id === 3 ? { ...it, missing: true, size: 0 } : it)));
  view.sync();
  assert.equal(cells()[1], doc);
  assert.ok(doc.classList.contains("missing"));
  assert.equal(details()[1], "Missing");
  mains()[1].fire("click");
  assert.deepEqual(sent("shelf_copy"), []);
  emit("shelf", shelfSample());
  view.sync();
  assert.ok(!doc.classList.contains("missing"));
  mains()[1].fire("click");
  assert.deepEqual(sent("shelf_copy"), [{ id: 3 }]);
});

test("a press that moves more than 4 px drags the item out of the island; the release that ends it copies nothing", async () => {
  showShelf(shelfSample());
  const doc = cells()[1];
  const main = mains()[1];
  main.fire("pointerdown", { button: 0, clientX: 100, clientY: 50, pointerId: 1 });
  main.fire("pointermove", { clientX: 103, clientY: 52 });
  assert.deepEqual(sent("shelf_drag"), [], "not yet: a hand is never quite still");
  main.fire("pointermove", { clientX: 105, clientY: 50 });
  assert.deepEqual(sent("shelf_drag"), [{ id: 3 }], "the id and nothing else");
  assert.equal(Tools.dragOut, true);
  assert.ok(doc.classList.contains("dragging"));
  // The pointer keeps moving: one drag, not one per move.
  main.fire("pointermove", { clientX: 300, clientY: 200 });
  assert.equal(sent("shelf_drag").length, 1);
  // The button comes up somewhere: not a click on the item.
  main.fire("pointerup");
  main.fire("click");
  await settle();
  assert.deepEqual(sent("shelf_copy"), []);
  // Rust answered: the drag is over. For a moment more the island takes no drop — its news may come last.
  assert.ok(!doc.classList.contains("dragging"));
  assert.equal(Tools.dragOut, true);
  mock.timers.tick(DRAG_OUT_GRACE_MS);
  assert.equal(Tools.dragOut, false);

  // A press let go where it went down is a click, as it always was.
  main.fire("pointerdown", { button: 0, clientX: 100, clientY: 50, pointerId: 2 });
  main.fire("pointermove", { clientX: 101, clientY: 51 });
  main.fire("pointerup");
  main.fire("click");
  await settle();
  assert.deepEqual(sent("shelf_copy"), [{ id: 3 }]);
  assert.equal(sent("shelf_drag").length, 1);
  mock.timers.tick(NOTE_MS);
  // The other buttons of the mouse drag nothing; nor does a move with no button down.
  main.fire("pointerdown", { button: 2, clientX: 100, clientY: 50, pointerId: 3 });
  main.fire("pointermove", { clientX: 160, clientY: 90 });
  main.fire("pointerup");
  main.fire("pointermove", { clientX: 10, clientY: 10 });
  assert.equal(sent("shelf_drag").length, 1);
  // The webview's own drag — of the picture, of the text — never starts.
  assert.equal(shelfCard.fire("dragstart").defaultPrevented, true);
});

test("a new item comes in before the ones there, which stay the very same items; a picture that comes later takes its place", () => {
  showShelf(shelfSample());
  const before = cells();
  grid.scrollTop = 30;
  emit("shelf", [file(6, "newer.txt"), file(5, "new.txt"), ...shelfSample()]);
  view.sync();
  const after = cells();
  assert.deepEqual(names().slice(0, 2), ["newer.txt", "new.txt"]);
  assert.deepEqual(after.slice(2), before, "a press on one of them is not lost to a drop made meanwhile");
  assert.equal(grid.scrollTop, 0, "what was just put there is shown");
  // The same list again changes nothing, not even where it is scrolled to.
  grid.scrollTop = 30;
  view.sync();
  assert.deepEqual(cells(), after);
  assert.equal(grid.scrollTop, 30);

  // Rust sends the list first and the thumbnails after: the item stays, its picture changes.
  const doc = cells()[3];
  assert.equal(doc.find("IMG").length, 0);
  emit("shelf", [file(6, "newer.txt"), file(5, "new.txt"), ...shelfSample().map((it) => (it.id === 3 ? { ...it, thumb: THUMB } : it))]);
  view.sync();
  assert.equal(cells()[3], doc);
  assert.equal(doc.find("IMG")[0].getAttribute("src"), THUMB);
  assert.equal(doc.find(".shelf-icon").length, 0);
  assert.equal(grid.scrollTop, 30);

  // Put on the shelf again, an item moves to the front: still the same item.
  emit("shelf", [file(3, "informe.pdf", { thumb: THUMB }), file(6, "newer.txt"), file(5, "new.txt")]);
  view.sync();
  assert.equal(cells()[0], doc);
  assert.equal(cells().length, 3);
  assert.equal(grid.scrollTop, 0);
});

test("the screenshot buttons ask for an area or the screen; for an area the island folds first", () => {
  showShelf(shelfSample());
  folded = 0;
  calls.length = 0;
  shotScreen.fire("click");
  assert.equal(sent("capture_screen").length, 1);
  assert.equal(folded, 0, "the island stays: Rust keeps it out of the picture");
  shotArea.fire("click");
  assert.equal(sent("capture_area").length, 1);
  assert.equal(folded, 1, "the area is chosen on the screen behind it");
  assert.deepEqual(calls.map(([cmd]) => cmd), ["capture_screen", "capture_area"], "and nothing else is asked of Rust");
});

test("a screenshot opens the island on the tools with its item lit for a moment", () => {
  // The island is shut. Rust sends the shelf with the new item, then says what it took.
  const shot = file(5, "Captura 2026-11-17 16.00.00.png", { thumb: THUMB });
  emit("shelf", [shot, ...shelfSample()]);
  emit("capture", { ok: true, id: 5, name: shot.name, width: 1920, height: 1080 });
  assert.deepEqual(alerts, ["tools"]);
  assert.deepEqual([State.mode, State.view], ["expanded", "tools"]);
  view.sync();
  assert.deepEqual(cells().map((cell) => cell.classList.contains("fresh")), [true, false, false, false, false]);
  assert.equal(failedNote.style.display, "none");
  mock.timers.tick(FRESH_MS - 1);
  view.sync();
  assert.ok(cells()[0].classList.contains("fresh"));
  notified = 0;
  mock.timers.tick(1);
  assert.equal(notified, 1, "the tools are on screen: they are drawn again");
  view.sync();
  assert.ok(!cells()[0].classList.contains("fresh"));

  // With the tools already on screen nothing is opened: the item only lights up.
  alerts.length = 0;
  emit("capture", { ok: true, id: 3, name: "informe.pdf", width: 10, height: 10 });
  assert.deepEqual(alerts, []);
  view.sync();
  assert.deepEqual(cells().map((cell) => cell.classList.contains("fresh")), [false, false, true, false, false]);
  // Another one before the first went dark: the newest is the one lit.
  emit("capture", { ok: true, id: 5, name: shot.name, width: 10, height: 10 });
  view.sync();
  assert.deepEqual(cells().map((cell) => cell.classList.contains("fresh")), [true, false, false, false, false]);
  mock.timers.tick(FRESH_MS);
  view.sync();
  assert.ok(cells().every((cell) => !cell.classList.contains("fresh")));
  // Not a capture at all: nothing happens.
  emit("capture", null);
  emit("capture", { ok: "yes" });
  assert.deepEqual(alerts, []);
  assert.equal(Tools.fresh, null);
  assert.deepEqual(calls.filter(([cmd]) => cmd !== "shelf_list"), [], "a screenshot asks nothing more of Rust, and plays no sound");
});

test("a screenshot never opens the island over a card that waits, what the user is doing, a paused island or a parked one", () => {
  const taken = { ok: true, id: 4, name: "Captura.png", width: 10, height: 10 };
  const stays = (why) => {
    const before = [State.mode, State.view];
    emit("capture", taken);
    assert.deepEqual(alerts, [], why);
    assert.deepEqual([State.mode, State.view], before, why);
    // It is on the shelf all the same, and lit for whoever opens the tools next.
    assert.equal(Tools.fresh, 4, why);
  };
  emit("shelf", shelfSample());

  State.paused = true;
  stays("paused");
  State.paused = false;
  State.parked = true;
  stays("parked for a full-screen app");
  State.parked = false;
  State.pendingApproval = { requestId: "r1" };
  stays("a card waits, folded");
  State.mode = "expanded";
  State.view = "approval";
  stays("a card waits, on screen");
  State.pendingApproval = null;
  for (const view of ["prompt", "launch", "settings", "uploading"]) {
    State.view = view;
    stays(view);
  }
  // Open on a card that only shows how things stand: the tools take its place.
  State.view = "overview";
  emit("capture", taken);
  assert.deepEqual(alerts, ["tools"]);
  mock.timers.tick(FRESH_MS);
});

test("a screenshot that could not be taken says so in the card for a moment", () => {
  emit("capture", { ok: false });
  assert.deepEqual(alerts, ["tools"], "the island opens to say it, by the same rule");
  view.sync();
  assert.notEqual(failedNote.style.display, "none");
  assert.equal(failedNote.textContent, "Couldn’t take the screenshot");
  assert.equal(Tools.fresh, null);
  setLanguage("es");
  assert.equal(failedNote.textContent, "No se pudo hacer la captura");
  setLanguage("en");
  mock.timers.tick(CAPTURE_NOTE_MS);
  view.sync();
  assert.equal(failedNote.style.display, "none");

  // Paused: the island stays shut, and the note is gone by itself.
  State.mode = "hidden";
  State.paused = true;
  alerts.length = 0;
  emit("capture", { ok: false });
  assert.deepEqual(alerts, []);
  assert.equal(Tools.captureFailed, true);
  mock.timers.tick(CAPTURE_NOTE_MS);
  assert.equal(Tools.captureFailed, false);
});

test("a file dragged over the island with the tools up lights the shelf's card", () => {
  showShelf(shelfSample());
  Tools.dropOver = true;
  view.sync();
  assert.ok(shelfCard.classList.contains("drop"));
  assert.ok(!left.children[0].classList.contains("drop"), "the clipboard's card is not where it lands");
  Tools.dropOver = false;
  view.sync();
  assert.ok(!shelfCard.classList.contains("drop"));
  // On an empty shelf too, which says where to drop.
  showShelf([]);
  Tools.dropOver = true;
  view.sync();
  assert.ok(shelfCard.classList.contains("drop"));
  assert.equal(shelfEmpty.textContent, "Drop files here");
});

test("the shelf's card stands on its own too", () => {
  let folds = 0;
  const card = buildShelfCard(() => folds++);
  Tools.shelf = shelfItems(shelfSample());
  card.sync();
  assert.equal(card.el.find(".shelf-item").length, 4);
  card.el.find(".shelf-shot")[0].fire("click");
  assert.equal(folds, 1);
});
