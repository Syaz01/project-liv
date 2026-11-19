// Small pieces every settings section draws with.

import { h } from "../views/dom";

export function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

export function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

/**
 * One setting: its name and, under it, what it does — on the left; what
 * changes it — on the right. `about` may be an element of its own when the
 * text changes (a shortcut that was rebound), or nothing.
 */
export function setting(name: string, about: string | HTMLElement | null, ...controls: (Node | null)[]): HTMLElement {
  const text = h("div", { class: "setting-text" }, h("div", { class: "setting-name", text: name }));
  if (typeof about === "string") text.append(h("div", { class: "setting-about", text: about }));
  else if (about) {
    about.classList.add("setting-about");
    text.append(about);
  }
  const control = h("div", { class: "setting-control" });
  for (const node of controls) if (node) control.append(node);
  return h("div", { class: "setting" }, text, control);
}

/**
 * A card of settings that belong together: its title, a line saying what
 * they are for, and the settings one under another. `anchor` is where a
 * "Settings…" link and the search land (core/settings-target.ts).
 */
export function group(anchor: string, title: string, about: string | null, ...children: (Node | null)[]): HTMLElement {
  const head = h("div", { class: "group-head" }, h("h2", {}, h("span", { text: title })));
  if (about) head.append(h("p", { class: "group-about", text: about }));
  const el = h("section", { class: "group", "data-anchor": anchor }, head);
  for (const child of children) if (child) el.append(child);
  return el;
}
