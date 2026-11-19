// The Liv window: a sidebar with Island (every setting of the island), and
// the page on the right, under its coloured band. Port of FlowHub.swift.

import "./hub.css";
import { h, clear } from "../views/dom";
import { t, tl, onLanguageChange } from "../i18n/i18n";
import { Bridge, onEvent } from "../core/bridge";
import { parseTarget, type SettingsPage } from "../core/settings-target";
import { brandRobot, hero, setWindowShown } from "./hero";
import { icon } from "./ui";
import { entryTitle, hitSubtitle, searchSettings, type SettingsSearchHit } from "./search";

export type PageId = SettingsPage;

interface PageDef {
  id: PageId;
  icon: string;
  title: () => string;
  /** The band's line. */
  subtitle: () => string;
}

export const ISLAND_PAGES: PageDef[] = [
  { id: "general", icon: "gear", title: () => t("General"), subtitle: () => t("Sound, language, startup and updates.") },
  { id: "island", icon: "sliders", title: () => t("Island"), subtitle: () => t("When it opens, when it folds and what it tells you.") },
  { id: "appearance", icon: "shapes", title: () => t("Appearance"), subtitle: () => t("The island's size and shape, and what Liv wears.") },
  { id: "pills", icon: "grid", title: () => t("Active pills"), subtitle: () => t("The pills shown in the island and their colours.") },
  { id: "agents", icon: "terminal", title: () => t("Agents"), subtitle: () => t("Claude Code, Codex and the other agents Liv follows.") },
  { id: "chat", icon: "chat", title: () => t("Chat"), subtitle: () => t("The AI of the island's chat, with your own keys.") },
  { id: "integrations", icon: "puzzle", title: () => t("Integrations"), subtitle: () => t("Stripe, GitHub, Vercel, n8n, Notion and the rest.") },
  { id: "shortcuts", icon: "keyboard", title: () => t("Shortcuts"), subtitle: () => t("The keys that open the island and its actions.") },
];

export interface HubOptions {
  version: string;
  /** Draws the island's settings for one of the pages into `container`. */
  renderIsland(page: PageId, container: HTMLElement): Promise<void>;
}

export async function startHub(root: HTMLElement, opts: HubOptions) {
  document.body.classList.add("hub-window");
  // The window is created hidden and only shown and hidden afterwards: its
  // canvases animate only while it is on screen.
  await onEvent<boolean>("hub-visible", setWindowShown);
  const shown = await Bridge.hubShown();
  if (shown !== null) setWindowShown(shown);
  let current: PageId = "general";
  let activeAnchor: string | null = null;
  let searchHits: SettingsSearchHit[] = [];
  const items = new Map<PageId, HTMLElement>();
  const labels = new Map<PageId, HTMLElement>();
  const searchRows = new Map<string, HTMLElement>();
  const scroll = h("div", { class: "hub-scroll" });
  let rendering = 0;

  function updateSearchRowHighlights() {
    for (const [id, rowEl] of searchRows) {
      rowEl.classList.toggle("on", id === activeAnchor);
    }
  }

  /**
   * What a result of the search is about, inside its section: the row whose
   * label, name, button or choice reads `label`. The section itself when there is none.
   */
  function labelled(section: HTMLElement, label: string): HTMLElement {
    for (const el of section.querySelectorAll<HTMLElement>("label, span, button, option, h3, input")) {
      if (el.textContent === label || el.getAttribute("aria-label") === label) {
        return el.closest<HTMLElement>(".row, .pill-row") ?? el;
      }
    }
    return section;
  }

  async function show(page: PageId, targetAnchor?: string, label?: string) {
    const def = ISLAND_PAGES.find((p) => p.id === page) ?? ISLAND_PAGES[0];
    current = def.id;
    activeAnchor = targetAnchor ?? null;
    for (const [id, el] of items) el.classList.toggle("on", id === current);
    updateSearchRowHighlights();
    const token = ++rendering;
    const page_ = h("div", { class: "hub-page" });
    page_.append(hero(def.id, def.title(), def.subtitle()));
    const container = h("div", { id: "settings-root" });
    page_.append(container);
    await opts.renderIsland(def.id, container);
    if (token !== rendering) return;
    clear(scroll);
    scroll.append(page_);
    if (targetAnchor) {
      const el = page_.querySelector(`[data-anchor="${targetAnchor}"]`) as HTMLElement | null;
      if (el) {
        // What was looked for is brought to the middle, and the section it
        // is in glows. A section taller than the window shows from its top.
        const target = label ? labelled(el, label) : el;
        const fits = target.offsetHeight <= scroll.clientHeight;
        target.scrollIntoView({ behavior: "smooth", block: fits ? "center" : "start" });
        el.classList.remove("hub-card-glowing");
        void el.offsetWidth;
        el.classList.add("hub-card-glowing");
      } else {
        scroll.scrollTop = 0;
      }
    } else {
      scroll.scrollTop = 0;
    }
  }

  // ── The sidebar ──
  const side = h("nav", { class: "hub-side" });
  const logo = h("canvas", {});
  side.append(h("div", { class: "hub-brand" }, logo, h("span", { text: "Liv" })));
  brandRobot(logo as HTMLCanvasElement);

  // Settings search field
  const searchInput = h("input", {
    class: "hub-search-input",
    type: "text",
    placeholder: t("Search settings"),
    spellcheck: "false",
  }) as HTMLInputElement;

  const searchClear = h("button", {
    class: "hub-search-clear",
    title: tl("Close"),
    style: "display:none",
  }, icon("x"));

  const searchBox = h("div", { class: "hub-search" },
    icon("search"),
    searchInput,
    searchClear,
  );
  searchBox.querySelector("svg")?.classList.add("hub-search-icon");
  side.append(searchBox);

  const groupsContainer = h("div", { class: "hub-groups" });
  const resultsContainer = h("div", { class: "hub-search-results", style: "display:none" });
  side.append(groupsContainer, resultsContainer);

  const group = (title: string, pages: PageDef[]) => {
    const heading = h("div", { class: "hub-group", text: title });
    groupsContainer.append(heading);
    for (const p of pages) {
      const b = h("button", { class: "hub-item", onclick: () => void show(p.id) });
      const label = h("span", { text: p.title() });
      b.append(icon(p.icon), label);
      items.set(p.id, b);
      labels.set(p.id, label);
      groupsContainer.append(b);
    }
    return heading;
  };
  const islandGroup = group(t("Settings"), ISLAND_PAGES);

  function renderSearchResults() {
    clear(resultsContainer);
    searchRows.clear();
    const query = searchInput.value.trim();
    if (!query) {
      searchClear.style.display = "none";
      resultsContainer.style.display = "none";
      groupsContainer.style.display = "";
      searchHits = [];
      return;
    }
    searchClear.style.display = "";
    groupsContainer.style.display = "none";
    resultsContainer.style.display = "";
    searchHits = searchSettings(query, (pageId) => ISLAND_PAGES.find((p) => p.id === pageId)?.title() ?? pageId);
    if (searchHits.length === 0) {
      resultsContainer.append(h("div", { class: "hub-search-empty", text: t("No setting found") }));
      return;
    }
    for (const hit of searchHits) {
      const pageDef = ISLAND_PAGES.find((p) => p.id === hit.entry.page);
      const row = h("button", { class: "hub-search-row" });
      if (activeAnchor === hit.entry.id && current === hit.entry.page) {
        row.classList.add("on");
      }
      row.append(icon(pageDef?.icon ?? "sliders"));
      const textContainer = h("div", { class: "hub-search-row-text" });
      const rowTitle = h("div", { class: "hub-search-row-title", text: hit.label ?? entryTitle(hit.entry) });
      const rowSubtitle = h("div", {
        class: "hub-search-row-subtitle",
        text: hitSubtitle(hit, pageDef?.title() ?? ""),
      });
      textContainer.append(rowTitle, rowSubtitle);
      row.append(textContainer);
      row.addEventListener("click", () => {
        void show(hit.entry.page, hit.entry.id, hit.label);
      });
      searchRows.set(hit.entry.id, row);
      resultsContainer.append(row);
    }
  }

  searchInput.addEventListener("input", renderSearchResults);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      renderSearchResults();
    } else if (e.key === "Enter") {
      if (searchHits.length > 0) {
        void show(searchHits[0].entry.page, searchHits[0].entry.id, searchHits[0].label);
      }
    }
  });

  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    renderSearchResults();
    searchInput.focus();
  });

  onLanguageChange(() => {
    searchInput.placeholder = t("Search settings");
    if (searchInput.value.trim()) renderSearchResults();
  });

  side.append(h("div", { class: "spacer" }), h("div", { class: "hub-version", text: `Liv ${opts.version}` }));

  clear(root);
  root.append(side, h("main", { class: "hub-panel" }, scroll));
  await show(current);

  // Rust shows the window on a page, or on a page and one of its sections
  // (a "Settings…" link of the island: core/settings-target.ts).
  void onEvent<string>("hub-page", (where) => {
    const target = parseTarget(where);
    if (target) void show(target.page, target.anchor);
  });
  return {
    redraw: () => {
      for (const p of ISLAND_PAGES) {
        const label = labels.get(p.id);
        if (label) label.textContent = p.title();
      }
      islandGroup.textContent = t("Settings");
      void show(current);
    },
  };
}
