// The settings search (src/hub/search.ts): how a query is matched, and the
// index against the pages it points into. The real settings window is drawn
// on the fake DOM (src/settings/main.ts, through the bridge's stand-in), in
// both languages: every result must name something the pages show, in the
// language shown, and land on a section that is there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeDom } from "./fakedom.mjs";
import { calls, emit, sent } from "./tauri.mjs";

// The window imports its stylesheets; layout is checked in the browser.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".css")) {
      return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    return nextLoad(url, context);
  },
});

const dom = installFakeDom();
// Keep canvas animation asleep: only the window's DOM is looked at.
document.visibilityState = "hidden";
document.addEventListener = () => {};
document.documentElement = {};
window.addEventListener = () => {};
// The page the settings window draws itself into (settings.html's #hub).
const windowRoot = dom.root();
document.getElementById = (id) => (id === "hub" ? windowRoot : null);

const { LANGUAGE_CODES, isComplete, lookup, setLanguage, t } = await import("../src/i18n/i18n.ts");
const {
  SETTINGS_ENTRIES, entryTitle, hitSubtitle, match, normalize, searchSettings, words,
} = await import("../src/hub/search.ts");
const { ISLAND_PAGES } = await import("../src/hub/shell.ts");
const { SETTINGS_PAGES } = await import("../src/core/settings-target.ts");

const settle = () => new Promise((resolve) => setImmediate(resolve));
// The window boots itself on import, as it does in settings.html.
await import("../src/settings/main.ts");
await settle();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pageTitle = (page) => ISLAND_PAGES.find((p) => p.id === page).title();
const search = (query) => searchSettings(query, pageTitle);
/** The results as "anchor" (the section itself) or "anchor|label" (something in it). */
const found = (query) => search(query).map((hit) => hit.id);

/** Shows `page` the way Rust asks for it, and returns the sections it draws. */
async function sectionsOf(page) {
  emit("hub-page", page);
  await settle();
  return windowRoot.find("SECTION");
}

async function inLanguage(lang, fn) {
  setLanguage(lang);
  await settle();
  try {
    await fn();
  } finally {
    setLanguage("en");
    await settle();
  }
}

// ── Matching ──────────────────────────────────────────────────────────────────

test("a query is split into words, whatever the accents and the case", () => {
  assert.deepEqual(words("  Réglage   SON "), ["reglage", "son"]);
  assert.deepEqual(words("   "), []);
  assert.deepEqual(words("Píldoras ACTIVAS"), ["pildoras", "activas"]);
  assert.equal(normalize("  Relé "), "rele");
});

test("a box matches by its title or its page, a setting inside it by its label", () => {
  const sound = {
    title: "Son",
    page: "Général",
    labels: ["Activer les sons", "Volume", "Ouvrir le dossier des sons"],
  };
  const m = (q) => match(words(q), sound.title, sound.page, sound.labels);

  // The box by its title or its page, whatever the accents and the case.
  assert.deepEqual(m("son"), { kind: "box" });
  assert.deepEqual(m("GENERAL"), { kind: "box" });
  assert.deepEqual(m("général son"), { kind: "box" });

  // A setting inside it.
  assert.deepEqual(m("volu"), { kind: "label", label: "Volume" });
  assert.deepEqual(m("dossier"), { kind: "label", label: "Ouvrir le dossier des sons" });

  // Every word somewhere; the label with most of them.
  assert.deepEqual(m("ouvrir dossier son"), { kind: "label", label: "Ouvrir le dossier des sons" });
  assert.deepEqual(m("volume general"), { kind: "label", label: "Volume" });

  // Not there.
  assert.equal(m("micro"), null);
  assert.equal(m("volume micro"), null, "every word must be found");
  assert.equal(m(""), null);
});

// ── The index: nothing raw, nothing Liv does not have ─────────────────────────

/** True for a text shown as it is in every language: no translation, or its own. */
const neverTranslated = (text) =>
  LANGUAGE_CODES.every((lang) => lang === "en" || lookup(text, lang) === undefined || lookup(text, lang) === text);

test("every entry names a page, a section of its own, and words that read in both languages", () => {
  const ids = new Set();
  for (const entry of SETTINGS_ENTRIES) {
    assert.ok(SETTINGS_PAGES.includes(entry.page), `${entry.id}: no page ${entry.page}`);
    assert.ok(entry.id.startsWith(`${entry.page}.`), `${entry.id} is not named after its page`);
    assert.ok(!ids.has(entry.id), `duplicate entry: ${entry.id}`);
    ids.add(entry.id);

    // A heading is a string of the table, or a name no language changes.
    if (entry.properTitle) assert.ok(neverTranslated(entry.title), `${entry.id}: ${entry.title} is translated`);
    else assert.ok(isComplete(entry.title), `${entry.id}: the title ${JSON.stringify(entry.title)} is not in the table`);
    // Every term is a string of the table: a raw key can never be shown.
    for (const term of entry.terms) {
      assert.ok(isComplete(term), `${entry.id}: the term ${JSON.stringify(term)} is not in the table`);
    }
    for (const name of entry.names ?? []) {
      assert.ok(neverTranslated(name), `${entry.id}: ${name} has a translation, it is a term`);
    }
    assert.equal(new Set([...entry.terms, ...(entry.names ?? [])]).size, entry.terms.length + (entry.names ?? []).length,
      `${entry.id} lists a word twice`);
  }
});

test("every word of the index is written where the settings pages are drawn", () => {
  // What draws the pages: the settings' own sources, the pill catalog and the
  // shortcuts' texts — and agents.rs, which names the agents.
  const read = (dir) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(ROOT, dir, f), "utf8"));
  const drawn = [
    ...read("src/settings"),
    readFileSync(join(ROOT, "src/core/pills.ts"), "utf8"),
    readFileSync(join(ROOT, "src/core/shortcuts.ts"), "utf8"),
    readFileSync(join(ROOT, "src-tauri/src/agents.rs"), "utf8"),
  ].join("\n");
  for (const entry of SETTINGS_ENTRIES) {
    for (const term of entry.terms) {
      assert.ok(drawn.includes(JSON.stringify(term)), `${entry.id}: no page shows ${JSON.stringify(term)}`);
    }
    for (const name of entry.names ?? []) {
      assert.ok(drawn.includes(name), `${entry.id}: no page shows ${name}`);
    }
  }
});

// ── The index against the pages ───────────────────────────────────────────────

test("every section the pages draw is in the index, and every entry lands on its section", async () => {
  for (const lang of LANGUAGE_CODES) {
    await inLanguage(lang, async () => {
      const landed = new Set();
      for (const page of SETTINGS_PAGES) {
        const sections = await sectionsOf(page);
        assert.ok(sections.length > 0, `${page} draws no section`);
        assert.equal(windowRoot.find("H1")[0].textContent, pageTitle(page), `${page} is not the page shown`);
        for (const section of sections) {
          const heading = section.find("H2")[0].textContent;
          const anchor = section.getAttribute("data-anchor");
          assert.ok(anchor, `${lang} ${page}: the section "${heading}" has no anchor: the search cannot reach it`);
          const entry = SETTINGS_ENTRIES.find((e) => e.id === anchor);
          assert.ok(entry, `${lang} ${page}: no entry for the section "${heading}" (${anchor})`);
          assert.equal(entry.page, page, `${anchor} is drawn on ${page}`);
          // The result is titled as the section is, in the language shown.
          assert.equal(entryTitle(entry), heading, `${lang} ${anchor}`);
          assert.ok(!landed.has(anchor), `${anchor} is drawn twice`);
          landed.add(anchor);
        }
      }
      assert.deepEqual([...landed].sort(), SETTINGS_ENTRIES.map((e) => e.id).sort(), `${lang}: entries without a section`);
    });
  }
});

test("a link to a section of a page opens that page", async () => {
  emit("hub-page", "chat#chat.local");
  await settle();
  assert.equal(windowRoot.find("H1")[0].textContent, "Chat");
  // What is not a page of the window changes nothing.
  emit("hub-page", "nowhere#x");
  await settle();
  assert.equal(windowRoot.find("H1")[0].textContent, "Chat");
  emit("hub-page", "general");
  await settle();
  assert.equal(windowRoot.find("H1")[0].textContent, "General");
});

// ── Searching ─────────────────────────────────────────────────────────────────

test("a search finds what Liv has, by what its pages say", () => {
  assert.deepEqual(found("sound"), ["general.general|Sound"]);
  assert.deepEqual(found("volume"), ["general.general|Volume"]);
  assert.deepEqual(found("island size"), ["general.general|Island size"]);
  assert.deepEqual(found("full screen"), ["general.general|Hide when an app is full screen"]);
  assert.deepEqual(found("language"), ["general.general|Language"]);
  // A section by its heading, with the others that mention the word after it.
  assert.equal(found("virtual office")[0], "integrations.office");
  assert.deepEqual(found("office address"), ["integrations.office|Office address"]);
  assert.equal(found("claude code")[0], "agents.claude-code");
  assert.equal(found("plan usage")[0], "agents.plan");
  assert.equal(found("local models")[0], "chat.local");
  assert.equal(found("shortcuts")[0], "shortcuts.all");
  assert.equal(found("active pills")[0], "pills.active");
  // The services and providers the old index missed.
  assert.deepEqual(found("gitlab"), ["integrations.services|GitLab"]);
  assert.deepEqual(found("gitea"), ["integrations.services|Gitea"]);
  assert.deepEqual(found("openrouter"), ["chat.providers|OpenRouter"]);
  assert.deepEqual(found("ollama"), ["pills.active|Ollama", "chat.local|Ollama"]);
  assert.deepEqual(found("antigravity").sort(), ["agents.others|Antigravity", "pills.active|Antigravity"]);

  assert.deepEqual(found(""), []);
  assert.deepEqual(found("   "), []);
  assert.deepEqual(found("nonexistentgibberishqueryxyz"), []);
});

test("nothing Liv does not have can be found", () => {
  for (const gone of ["demo", "vitals", "mac startup", "crypto", "linear", "figma", "twilio", "deepseek", "notch", "hotkey", "youtube", "sentry"]) {
    assert.deepEqual(found(gone), [], gone);
  }
});

test("a search in Spanish reads in Spanish, and never shows a key", async () => {
  await inLanguage("es", () => {
    assert.deepEqual(found("sonido"), ["general.general|Sonido"]);
    assert.deepEqual(found("volumen"), ["general.general|Volumen"]);
    assert.equal(found("píldoras activas")[0], "pills.active");
    assert.equal(found("pildoras")[0], "pills.active", "without the accent too");
    assert.equal(found("oficina virtual")[0], "integrations.office");
    assert.equal(found("atajos")[0], "shortcuts.all");
    assert.ok(found("relé").includes("agents.claude-code|Relé"));

    // Every result of every entry, as the sidebar writes it: its two lines.
    for (const entry of SETTINGS_ENTRIES) {
      const title = entryTitle(entry);
      if (!entry.properTitle) assert.equal(title, lookup(entry.title, "es"), entry.id);
      for (const term of entry.terms) {
        const text = t(term);
        assert.equal(text, lookup(term, "es"), `${entry.id}: ${term}`);
        const hits = search(text).filter((hit) => hit.entry === entry);
        assert.equal(hits.length, 1, `${entry.id}: "${text}" does not find it`);
      }
    }
  });
});

test("a result says its page, and its section when that is another name", () => {
  const [sound] = search("sound");
  assert.equal(hitSubtitle(sound, pageTitle("general")), "General", "the section is named like its page");
  const relay = search("install relay").find((hit) => hit.entry.id === "agents.plan");
  assert.equal(relay.id, "agents.plan|Install relay…");
  assert.equal(hitSubtitle(relay, pageTitle("agents")), "Agents › Plan usage");
  const [office] = search("virtual office");
  assert.equal(hitSubtitle(office, pageTitle("integrations")), "Integrations", "a section itself: just its page");
});

// ── What Liv wears ────────────────────────────────────────────────────────────

test("General has a row for what Liv wears, next to Liv on the desktop: the wardrobe's seven choices, saved on change", async () => {
  const { OUTFIT_CHOICES } = await import("../src/robot/outfits.ts");
  emit("hub-page", "general");
  await settle();
  const labels = windowRoot.find("LABEL").map((label) => label.textContent);
  assert.equal(labels.indexOf("Liv wears"), labels.indexOf("Liv on the desktop") + 1);
  // The page may be drawn again when the settings change: the row is looked up each time.
  const row = () => windowRoot.find("LABEL").find((label) => label.textContent === "Liv wears").parentNode;
  const select = row().find("SELECT")[0];
  const options = select.find("OPTION");
  assert.deepEqual(options.map((o) => o.getAttribute("value")), OUTFIT_CHOICES.map((c) => c.id));
  assert.deepEqual(options.map((o) => o.textContent), ["Auto", "Nothing", "Glasses", "Scarf", "Headphones", "Beanie", "Star"]);
  assert.equal(select.value, "auto", "a fresh install lets the season pick");

  select.value = "headphones";
  select.fire("change");
  await settle();
  assert.equal(sent("save_settings").at(-1).settings.livOutfit, "headphones");

  // Picked somewhere else — the island's wardrobe: the row follows. (The language is
  // named with it: left to the system, this window would follow the computer's.)
  emit("settings-changed", { livOutfit: "star", language: "en" });
  await settle();
  assert.equal(row().find("SELECT")[0].value, "star");
  // A word this build does not have shows as Auto.
  emit("settings-changed", { livOutfit: "cape", language: "en" });
  await settle();
  assert.equal(row().find("SELECT")[0].value, "auto");
  emit("settings-changed", { livOutfit: "auto", language: "en" });
  await settle();

  // The search finds it, in both languages.
  assert.ok(found("wears").includes("general.general|Liv wears"), JSON.stringify(found("wears")));
  await inLanguage("es", async () => {
    emit("hub-page", "general");
    await settle();
    assert.ok(search("lleva").some((hit) => hit.label === "Liv lleva"));
    const spanish = windowRoot.find("LABEL").find((label) => label.textContent === "Liv lleva").parentNode.find("OPTION");
    assert.deepEqual(spanish.map((o) => o.textContent), ["Auto", "Nada", "Gafas", "Bufanda", "Auriculares", "Gorro", "Estrella"]);
  });
});

// ── The tools ─────────────────────────────────────────────────────────────────

test("General has a Tools section with the clipboard history's switch: on at first, saved on change, and found by the search", async () => {
  emit("hub-page", "general");
  await settle();
  // The page may be drawn again when the settings change: the section is looked up each time.
  const section = () => windowRoot.find("SECTION").find((s) => s.getAttribute("data-anchor") === "general.tools");
  const toggle = () => section().find(".switch")[0];
  const hints = () => section().find(".hint").map((hint) => hint.textContent);
  assert.equal(section().find("H2")[0].textContent, "Tools");
  assert.deepEqual(section().find("LABEL").map((label) => label.textContent), ["Clipboard history", "Screenshots"]);
  assert.ok(toggle().classList.contains("on"), "a fresh install keeps what is copied");
  // The hint names the shortcut that opens the view, and says where the history lives.
  assert.match(hints()[0], /press Ctrl\+Alt\+V,/);
  assert.match(hints()[1], /in memory only, never on disk/);
  assert.match(hints()[1], /password manager/);

  toggle().fire("click");
  await settle();
  assert.equal(sent("save_settings").at(-1).settings.clipboardHistory, false);
  assert.ok(!toggle().classList.contains("on"));
  // Switched somewhere else: the switch follows. So does the hint, when the shortcut loses its key.
  emit("settings-changed", { clipboardHistory: true, shortcuts: { toolsToggle: { keys: "", enabled: true } }, language: "en" });
  await settle();
  assert.ok(toggle().classList.contains("on"));
  assert.doesNotMatch(hints()[0], /press/);
  emit("settings-changed", { shortcuts: {}, language: "en" });
  await settle();
  assert.match(hints()[0], /press Ctrl\+Alt\+V,/);

  assert.deepEqual(found("clipboard"), ["general.tools|Clipboard history"]);
  assert.equal(found("tools")[0], "general.tools");
  await inLanguage("es", async () => {
    emit("hub-page", "general");
    await settle();
    assert.equal(section().find("H2")[0].textContent, "Herramientas");
    assert.deepEqual(found("portapapeles"), ["general.tools|Historial del portapapeles"]);
    assert.match(hints()[1], /nunca en disco/);
  });
});

test("the Tools section says where screenshots go, has the way to their folder, and the search finds both", async () => {
  emit("hub-page", "general");
  await settle();
  const section = () => windowRoot.find("SECTION").find((s) => s.getAttribute("data-anchor") === "general.tools");
  const button = () => section().find("BUTTON").find((b) => b.textContent === t("Open screenshots folder"));
  const hints = () => section().find(".hint").map((hint) => hint.textContent);
  assert.ok(button(), "the button is there");
  // Where they go, and what else happens to each.
  assert.match(hints()[2], /saved as PNG in the Liv folder inside Pictures/);
  assert.match(hints()[2], /copied to the clipboard and put on the shelf/);

  const before = sent("open_captures_folder").length;
  const saved = sent("save_settings").length;
  button().fire("click");
  assert.equal(sent("open_captures_folder").length, before + 1);
  assert.equal(sent("save_settings").length, saved, "opening a folder saves nothing");

  assert.deepEqual(found("screenshots folder"), ["general.tools|Open screenshots folder"]);
  assert.ok(found("screenshots").includes("general.tools|Screenshots"));
  // The two shortcuts are found too, on their page.
  assert.deepEqual(found("capture an area"), ["shortcuts.all|Capture an area"]);
  assert.deepEqual(found("capture the screen"), ["shortcuts.all|Capture the screen"]);
  await inLanguage("es", async () => {
    emit("hub-page", "general");
    await settle();
    assert.equal(button().textContent, "Abrir la carpeta de capturas");
    assert.match(hints()[2], /dentro de Imágenes/);
    assert.match(hints()[2], /se pone en la repisa/);
    assert.deepEqual(found("carpeta de capturas"), ["general.tools|Abrir la carpeta de capturas"]);
    assert.ok(found("capturas").includes("general.tools|Capturas"));
  });
});

// ── The open island's shape ───────────────────────────────────────────────────

test("General has an Appearance section between General and Tools: four sliders, followed by the island at once, saved a moment later, and found by the search", async () => {
  const { APPEARANCE_SAVE_DELAY_MS } = await import("../src/settings/appearance.ts");
  const sections = await sectionsOf("general");
  assert.deepEqual(
    sections.map((s) => s.getAttribute("data-anchor")),
    ["general.general", "general.appearance", "general.tools"],
  );
  // The page may be drawn again when the settings change: the section is looked up each time.
  const section = () => windowRoot.find("SECTION").find((s) => s.getAttribute("data-anchor") === "general.appearance");
  const sliders = () => section().find("INPUT");
  assert.equal(section().find("H2")[0].textContent, "Appearance");
  assert.deepEqual(section().find("LABEL").map((label) => label.textContent).filter(Boolean),
    ["Width", "Extra height", "Corner rounding", "Opacity"]);
  assert.deepEqual(sliders().map((slider) => slider.getAttribute("type")), ["range", "range", "range", "range"]);
  assert.deepEqual(sliders().map((slider) => slider.value), ["640", "0", "22", "100"], "a fresh install has the inherited island");

  // A slider moves: the island is told now, the settings are written once it has stopped.
  calls.length = 0;
  sliders()[0].value = "800";
  sliders()[0].fire("input");
  sliders()[3].value = "70";
  sliders()[3].fire("input");
  await settle();
  assert.deepEqual(sent("preview_appearance").at(-1), { width: 800, extraHeight: 0, radius: 22, opacity: 70 });
  assert.deepEqual(sent("save_settings"), []);
  await new Promise((resolve) => setTimeout(resolve, APPEARANCE_SAVE_DELAY_MS + 60));
  assert.equal(sent("save_settings").length, 1);
  const saved = sent("save_settings")[0].settings;
  assert.deepEqual(
    [saved.islandWidth, saved.islandExtraHeight, saved.islandRadius, saved.islandOpacity],
    [800, 0, 22, 70],
  );

  // Rust says the settings changed (this save, or one made elsewhere): the sliders follow.
  emit("settings-changed", { islandWidth: 900, islandExtraHeight: 40, islandRadius: 30, islandOpacity: 55, language: "en" });
  await settle();
  assert.deepEqual(sliders().map((slider) => slider.value), ["900", "40", "30", "55"]);
  assert.deepEqual(section().find(".hint").slice(1).map((hint) => hint.textContent), ["900 px", "40 px", "30 px", "55 %"]);

  // Reset: the inherited island, written at once.
  calls.length = 0;
  section().find("BUTTON").find((button) => button.textContent === "Reset").fire("click");
  await settle();
  assert.deepEqual(sliders().map((slider) => slider.value), ["640", "0", "22", "100"]);
  assert.deepEqual(sent("preview_appearance").at(-1), { width: 640, extraHeight: 0, radius: 22, opacity: 100 });
  const reset = sent("save_settings").at(-1).settings;
  assert.deepEqual([reset.islandWidth, reset.islandExtraHeight, reset.islandRadius, reset.islandOpacity], [640, 0, 22, 100]);
  emit("settings-changed", { islandWidth: 640, islandExtraHeight: 0, islandRadius: 22, islandOpacity: 100, language: "en" });
  await settle();

  // The search finds the section and what is in it, in both languages.
  assert.deepEqual(found("appearance"), ["general.appearance"]);
  assert.ok(found("opacity").includes("general.appearance|Opacity"), JSON.stringify(found("opacity")));
  assert.ok(found("corner").includes("general.appearance|Corner rounding"));
  assert.ok(found("width").includes("general.appearance|Width"));
  assert.ok(found("extra height").includes("general.appearance|Extra height"));
  await inLanguage("es", async () => {
    emit("hub-page", "general");
    await settle();
    assert.equal(section().find("H2")[0].textContent, "Apariencia");
    assert.deepEqual(section().find("LABEL").map((label) => label.textContent).filter(Boolean),
      ["Ancho", "Alto adicional", "Redondeo de las esquinas", "Opacidad"]);
    assert.ok(search("apariencia").some((hit) => hit.id === "general.appearance"));
    assert.ok(search("opacidad").some((hit) => hit.label === "Opacidad"));
    assert.ok(search("redondeo").some((hit) => hit.label === "Redondeo de las esquinas"));
    assert.ok(search("restablecer").some((hit) => hit.id.startsWith("general.appearance")));
  });
});
