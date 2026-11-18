// The Tools view: two cards side by side, as on the overview. On the left the
// clipboard's history — what was copied, newest first, a click away from
// where the user is typing; on the right the shelf — files kept at hand, and
// the two buttons that take a screenshot onto it.
//
// The lists come from Rust (src-tauri/src/clipboard.rs, shelf.rs) through
// island/tools.ts, and what a row or an item says from core/tools.ts. A click
// on a row sends the entry's id: Rust puts it back on the clipboard and pastes
// it in the app in front, which the island never takes the place of. A click
// on a shelf item copies the file itself; a press that moves drags it out of
// the island, into any app (the drag is the system's own, started by Rust).

import { h, svg, dot } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import {
  CAPTURE_FAILED, DRAG_OUT_GRACE_MS, NOTE_MS, SHELF_EMPTY, Tools, agoLabel, clipboardEmptyText, dragStarts,
  entryLabel, itemDetail, pasteNote, rowIcon, shortName, swatchColor, type ClipEntry, type ShelfItem,
} from "../core/tools";
import type { ViewActions, ViewHost } from "./views";
import { t, tl } from "../i18n/i18n";

/** A card of the view: what it draws, kept and updated in place. */
export interface ToolsCard {
  el: HTMLElement;
  sync(): void;
}

/** A card's heading: its title and, after it, what the card puts on the right. */
function heading(title: Node, ...right: Node[]): HTMLElement {
  return h("div", { class: "tools-head" }, title, h("div", { class: "grow" }), ...right);
}

// ── Clipboard ─────────────────────────────────────────────────────────────────

interface Row {
  el: HTMLElement;
  /** How long ago, or for a moment what a click came to. */
  ago: HTMLElement;
  /** What the row was built from (rowKey). */
  key: string;
}

/** What a row draws of its entry. Rust never gives an id to something else; a list that does gets a new row. */
function rowKey(entry: ClipEntry): string {
  return [entry.kind, entry.width, entry.height, entry.thumb, entry.preview].join("|");
}

/** What stands at the start of a row: the image itself, a swatch of the colour, or the kind's icon. */
function rowLead(entry: ClipEntry): HTMLElement {
  if (entry.kind === "image" && entry.thumb) {
    return h("img", { class: "clip-thumb", src: entry.thumb, alt: "", draggable: "false" });
  }
  const color = swatchColor(entry.preview);
  const icon = rowIcon(entry);
  return h(
    "span",
    { class: "clip-icon" },
    icon === "color" && color
      ? dot(color, 10)
      : svg(icon === "image" ? ICONS.photo : icon === "link" ? ICONS.link : ICONS.textLines, 13, { stroke: 1.7 }),
  );
}

/**
 * The clipboard's card: a heading with "Clear", then one row per entry. A
 * click on a row pastes it; the small button that shows on the row under the
 * pointer forgets it. `openSettings` is where the switch is, for the card to
 * point at while the history is off.
 */
export function buildClipboardCard(openSettings: () => void): ToolsCard {
  const clearAll = h("button", {
    class: "link-btn tools-link",
    text: tl("Clear"),
    onclick: () => void Bridge.clipboardClear(),
  });
  const head = heading(h("span", { class: "tools-title", text: tl("Clipboard") }), clearAll);
  // Liv stands at the start of this heading (core/layout.ts: tools).
  head.classList.add("liv");
  const list = h("div", { class: "clip-list" });
  const emptyText = h("span", {});
  const settingsLink = h("button", { class: "link-btn tools-link", text: tl("Settings…"), onclick: openSettings });
  const empty = h("div", { class: "tools-empty" }, emptyText, settingsLink);
  const el = h("div", { class: "card tools-card" }, head, list, empty);

  // Rows are kept by their entry's id and moved, not built again: a list that
  // comes in between a press and its release must not swallow the click.
  const rows = new Map<number, Row>();
  /** The ids of the rows in the list, top first. */
  let shown: number[] = [];
  /** What a click came to, for a moment, by entry (an English key), and the timer that ends it. */
  const notes = new Map<number, { text: string; timer: number }>();

  function note(id: number, text: string) {
    const before = notes.get(id);
    if (before) window.clearTimeout(before.timer);
    const timer = window.setTimeout(() => {
      notes.delete(id);
      sync();
    }, NOTE_MS);
    notes.set(id, { text, timer });
    sync();
  }

  function forget(id: number) {
    const said = notes.get(id);
    if (said) window.clearTimeout(said.timer);
    notes.delete(id);
    rows.get(id)?.el.remove();
    rows.delete(id);
  }

  async function paste(id: number) {
    const said = pasteNote(await Bridge.clipboardPaste(id));
    if (said && rows.has(id)) note(id, said);
  }

  function buildRow(entry: ClipEntry): Row {
    const ago = h("span", { class: "clip-ago" });
    const main = h(
      "button",
      { class: "clip-main", onclick: () => void paste(entry.id) },
      rowLead(entry),
      h("span", { class: "clip-label", text: entryLabel(entry) }),
      ago,
    );
    const remove = h(
      "button",
      { class: "icon-btn clip-remove", title: tl("Remove"), onclick: () => void Bridge.clipboardRemove(entry.id) },
      svg(ICONS.xmark, 8),
    );
    const el = h("div", { class: entry.kind === "image" ? "clip-row image" : "clip-row" }, main, remove);
    return { el, ago, key: rowKey(entry) };
  }

  function sync() {
    const on = State.settings.clipboardHistory;
    // Off, Rust holds nothing; whatever the page still has is not shown.
    const entries = on ? Tools.clipboard : [];
    const ids = entries.map((entry) => entry.id);

    for (const id of [...rows.keys()]) if (!ids.includes(id)) forget(id);
    for (const entry of entries) {
      if (rows.has(entry.id) && rows.get(entry.id)!.key !== rowKey(entry)) forget(entry.id);
    }
    shown = shown.filter((id) => rows.has(id));
    for (const entry of entries) if (!rows.has(entry.id)) rows.set(entry.id, buildRow(entry));

    if (ids.join() !== shown.join()) {
      const fresh = ids.length - shown.length;
      if (fresh > 0 && ids.slice(fresh).join() === shown.join()) {
        // New copies, above what is there: nothing that is there moves.
        list.prepend(...ids.slice(0, fresh).map((id) => rows.get(id)!.el));
      } else {
        list.replaceChildren(...ids.map((id) => rows.get(id)!.el));
      }
      // What was just copied or put back is at the top: the list shows it.
      if (ids[0] !== shown[0]) list.scrollTop = 0;
      shown = ids;
    }

    const now = Date.now();
    for (const entry of entries) {
      const row = rows.get(entry.id)!;
      const said = notes.get(entry.id);
      const text = said ? t(said.text) : agoLabel(entry.at, now);
      if (row.ago.textContent !== text) row.ago.textContent = text;
      row.el.classList.toggle("noted", said != null);
    }

    const nothing = clipboardEmptyText(on, entries.length);
    emptyText.textContent = nothing ? t(nothing) : "";
    empty.style.display = nothing ? "" : "none";
    list.style.display = nothing ? "none" : "";
    settingsLink.style.display = on ? "none" : "";
    clearAll.style.display = entries.length > 0 ? "" : "none";
  }

  return { el, sync };
}

// ── Shelf ─────────────────────────────────────────────────────────────────────

interface Cell {
  el: HTMLElement;
  /** What a click copies and a press drags: the picture, the name and the line under it. */
  main: HTMLElement;
  /** Where the picture is. */
  pic: HTMLElement;
  name: HTMLElement;
  /** The size, or for a moment what a click came to. */
  detail: HTMLElement;
  /** What the picture was drawn from (picKey). */
  shown: string;
}

/** What an item's picture is drawn from: a new thumbnail replaces it in place, the item stays. */
function picKey(item: ShelfItem): string {
  return [item.missing ? "" : item.thumb, item.isDir].join("|");
}

/** The item's picture: the shell's thumbnail or icon, or a plain file or folder while there is none. */
function picture(item: ShelfItem): HTMLElement {
  if (item.thumb && !item.missing) {
    return h("img", { class: "shelf-thumb", src: item.thumb, alt: "", draggable: "false" });
  }
  return h("span", { class: "shelf-icon" }, svg(item.isDir ? ICONS.folderLine : ICONS.fileLine, 24, { stroke: 1.4 }));
}

/**
 * The shelf's card: a heading with the two screenshot buttons and "Clear",
 * then a grid of what is on the shelf. A click on an item copies its file; a
 * press that moves drags it out; the small buttons that show on the item
 * under the pointer open it, show it in its folder, or take it off the shelf.
 * `fold` folds the island: an area is chosen on the screen behind it.
 */
export function buildShelfCard(fold: () => void = () => {}): ToolsCard {
  const shotArea = h(
    "button",
    {
      class: "icon-btn shelf-shot",
      title: tl("Capture an area"),
      onclick: () => {
        fold();
        void Bridge.captureArea();
      },
    },
    svg(ICONS.captureArea, 13, { stroke: 1.8 }),
  );
  const shotScreen = h(
    "button",
    { class: "icon-btn shelf-shot", title: tl("Capture the screen"), onclick: () => void Bridge.captureScreen() },
    svg(ICONS.captureScreen, 13, { stroke: 1.8 }),
  );
  const clearAll = h("button", {
    class: "link-btn tools-link",
    text: tl("Clear"),
    onclick: () => void Bridge.shelfClear(),
  });
  const head = heading(h("span", { class: "tools-title", text: tl("Shelf") }), shotArea, shotScreen, clearAll);
  // A screenshot that could not be taken, for a moment.
  const failed = h("div", { class: "shelf-note", text: tl(CAPTURE_FAILED) });
  const grid = h("div", { class: "shelf-grid" });
  const empty = h("div", { class: "tools-empty" }, h("span", { text: tl(SHELF_EMPTY) }));
  const el = h("div", { class: "card tools-card shelf" }, head, failed, grid, empty);
  // The drag out is Rust's: the webview must not start one of its own with
  // the picture or the text under the pointer.
  el.addEventListener("dragstart", (e) => e.preventDefault());

  // Items are kept by id and moved, not built again: a list that comes in
  // between a press and its release must not swallow the click, or the drag.
  const cells = new Map<number, Cell>();
  /** The ids of the items in the grid, first to last. */
  let shown: number[] = [];
  /** What a click came to, for a moment, by item (an English key), and the timer that ends it. */
  const notes = new Map<number, { text: string; timer: number }>();
  /** Where the button went down on an item, until it comes up or the press becomes a drag. */
  let press: { id: number; x: number; y: number } | null = null;
  /** The press that is ending was a drag: it copies nothing. */
  let dragged = false;
  /** Ends the moment after a drag out in which the island takes no drop. */
  let grace: number | null = null;

  const item = (id: number) => Tools.shelf.find((it) => it.id === id) ?? null;

  function note(id: number, text: string) {
    const before = notes.get(id);
    if (before) window.clearTimeout(before.timer);
    const timer = window.setTimeout(() => {
      notes.delete(id);
      sync();
    }, NOTE_MS);
    notes.set(id, { text, timer });
    sync();
  }

  function forget(id: number) {
    const said = notes.get(id);
    if (said) window.clearTimeout(said.timer);
    notes.delete(id);
    cells.get(id)?.el.remove();
    cells.delete(id);
  }

  async function copy(id: number) {
    const said = pasteNote(await Bridge.shelfCopy(id));
    if (said && cells.has(id)) note(id, said);
  }

  /** The press moved: Rust drags the file out, and answers when it was let go. */
  function dragOut(id: number) {
    dragged = true;
    if (grace != null) window.clearTimeout(grace);
    grace = null;
    Tools.dragOut = true;
    cells.get(id)?.el.classList.add("dragging");
    void Bridge.shelfDrag(id).then(() => {
      cells.get(id)?.el.classList.remove("dragging");
      // If it was let go on the island itself, that drop's news is still on its way.
      grace = window.setTimeout(() => {
        grace = null;
        Tools.dragOut = false;
      }, DRAG_OUT_GRACE_MS);
    });
  }

  function buildCell(first: ShelfItem): Cell {
    const { id } = first;
    const pic = h("span", { class: "shelf-pic" }, picture(first));
    const name = h("span", { class: "shelf-name" });
    const detail = h("span", { class: "shelf-detail" });
    const main = h("button", { class: "shelf-main" }, pic, name, detail);
    main.addEventListener("click", () => {
      // The end of a drag is not a click; and what has gone cannot be copied.
      if (dragged || item(id)?.missing !== false) return;
      void copy(id);
    });
    main.addEventListener("pointerdown", (e) => {
      const at = e as PointerEvent;
      dragged = false;
      press = null;
      if ((at.button ?? 0) !== 0 || item(id)?.missing !== false) return;
      press = { id, x: at.clientX, y: at.clientY };
      // The moves keep coming here once the pointer is off the item.
      try {
        main.setPointerCapture(at.pointerId);
      } catch {
        // No such pointer any more: the press is over.
      }
    });
    main.addEventListener("pointermove", (e) => {
      const at = e as PointerEvent;
      if (press?.id !== id || !dragStarts(at.clientX - press.x, at.clientY - press.y)) return;
      press = null;
      dragOut(id);
    });
    const release = () => {
      if (press?.id === id) press = null;
    };
    main.addEventListener("pointerup", release);
    main.addEventListener("pointercancel", release);

    const acts = h(
      "div",
      { class: "shelf-acts" },
      h(
        "button",
        { class: "icon-btn shelf-open", title: tl("Open"), onclick: () => void Bridge.shelfOpen(id) },
        svg(ICONS.arrowUpRight, 9),
      ),
      h(
        "button",
        { class: "icon-btn shelf-reveal", title: tl("Show in folder"), onclick: () => void Bridge.shelfReveal(id) },
        svg(ICONS.folderLine, 10, { stroke: 2 }),
      ),
      h(
        "button",
        { class: "icon-btn shelf-remove", title: tl("Remove"), onclick: () => void Bridge.shelfRemove(id) },
        svg(ICONS.xmark, 8),
      ),
    );
    const el = h("div", { class: "shelf-item" }, main, acts);
    return { el, main, pic, name, detail, shown: picKey(first) };
  }

  function sync() {
    const items = Tools.shelf;
    const ids = items.map((it) => it.id);

    for (const id of [...cells.keys()]) if (!ids.includes(id)) forget(id);
    shown = shown.filter((id) => cells.has(id));
    for (const it of items) if (!cells.has(it.id)) cells.set(it.id, buildCell(it));

    if (ids.join() !== shown.join()) {
      const fresh = ids.length - shown.length;
      if (fresh > 0 && ids.slice(fresh).join() === shown.join()) {
        // New items, before what is there: nothing that is there is touched.
        grid.prepend(...ids.slice(0, fresh).map((id) => cells.get(id)!.el));
      } else {
        grid.replaceChildren(...ids.map((id) => cells.get(id)!.el));
      }
      // What was just dropped or captured is first: the grid shows it.
      if (ids[0] !== shown[0]) grid.scrollTop = 0;
      shown = ids;
    }

    for (const it of items) {
      const cell = cells.get(it.id)!;
      const key = picKey(it);
      if (cell.shown !== key) {
        cell.pic.replaceChildren(picture(it));
        cell.shown = key;
      }
      const name = shortName(it.name);
      if (cell.name.textContent !== name) cell.name.textContent = name;
      // The whole name, and where the file is.
      if (cell.main.getAttribute("title") !== it.path) cell.main.setAttribute("title", it.path);
      const said = notes.get(it.id);
      const detail = said ? t(said.text) : itemDetail(it);
      if (cell.detail.textContent !== detail) cell.detail.textContent = detail;
      cell.el.classList.toggle("noted", said != null);
      cell.el.classList.toggle("missing", it.missing);
      cell.el.classList.toggle("fresh", Tools.fresh === it.id);
    }

    const nothing = items.length === 0;
    empty.style.display = nothing ? "" : "none";
    grid.style.display = nothing ? "none" : "";
    clearAll.style.display = nothing ? "none" : "";
    failed.style.display = Tools.captureFailed ? "" : "none";
    // A file is over the island: this is where it would land.
    el.classList.toggle("drop", Tools.dropOver);
  }

  return { el, sync };
}

// ── The view ──────────────────────────────────────────────────────────────────

export function buildTools(actions: ViewActions): ViewHost {
  const clipboard = buildClipboardCard(() => actions.openSettingsWindow({ page: "general", anchor: "general.tools" }));
  const shelf = buildShelfCard(() => actions.collapse());
  const el = h(
    "div",
    { class: "view tools" },
    h("div", { class: "left" }, clipboard.el),
    h("div", { class: "right" }, shelf.el),
  );
  return {
    el,
    sync() {
      clipboard.sync();
      shelf.sync();
    },
  };
}
