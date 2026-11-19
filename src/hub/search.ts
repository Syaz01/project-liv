// Settings search in the Liv window: finds every section of the settings by
// what is written in it, in the app's language, whatever the accents and case.
// The matching is SettingsSearchMatch.swift's; the index is Liv's own — one
// entry per section the settings pages draw (src/settings), named by that
// section's `data-anchor`, so a result opens its page and lands on the section.

import { N_, t } from "../i18n/i18n";
import { OFFICE_PILL_ID } from "../core/office";
import { SPOTIFY_ID } from "../core/spotify";
import { PILL_CATALOG, PILL_CATEGORIES } from "../core/pills";
import { ISLAND_SHORTCUTS, SHORTCUTS, SHORTCUT_TEXT } from "../core/shortcuts";
import type { SettingsPage } from "../core/settings-target";

export interface SettingsSearchEntry {
  /** The section's `data-anchor`, unique. */
  id: string;
  page: SettingsPage;
  /**
   * The section's heading, as its page writes it: a key of the string table
   * (shown through `t`), or — with `properTitle` — a name that is never
   * translated ("Claude Code").
   */
  title: string;
  properTitle?: true;
  /** What is written in the section — labels, buttons — as keys of the string table. */
  terms: string[];
  /** Proper names found in the section, never translated ("Ollama", "GitHub"). */
  names?: string[];
}

export interface SettingsSearchHit {
  entry: SettingsSearchEntry;
  label?: string;
  id: string;
}

export type MatchResult =
  | { kind: "box" }
  | { kind: "label"; label: string };

/**
 * Normalizes a string for searching: case-insensitive, diacritic/accent-insensitive,
 * trimmed of leading/trailing whitespace.
 */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * The words of a query, normalized.
 */
export function words(query: string): string[] {
  return query
    .split(/\s+/)
    .map(normalize)
    .filter((w) => w.length > 0);
}

/**
 * Matches a list of query words against a box's title, page and inner labels.
 * Returns null when the box doesn't have every word.
 */
export function match(
  wordList: string[],
  title: string,
  page: string,
  labels: string[]
): MatchResult | null {
  if (wordList.length === 0) return null;
  const head = normalize(title + " " + page);
  const texts = labels.map(normalize);
  const all = [head, ...texts].join(" ");
  if (!wordList.every((w) => all.includes(w))) return null;
  if (wordList.every((w) => head.includes(w))) return { kind: "box" };

  // The label with the most of the words, the first one when tied.
  let bestIndex = -1;
  let bestCount = 0;
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const count = wordList.filter((w) => text.includes(w)).length;
    if (count > 0 && count > bestCount) {
      bestIndex = i;
      bestCount = count;
    }
  }

  if (bestIndex < 0) return { kind: "box" };
  return { kind: "label", label: labels[bestIndex] };
}

/** The pills of the catalog this build offers, by where their rows are drawn. */
const pillNames = (services: boolean) =>
  PILL_CATALOG
    // The office's name and the music pill's are not proper ones: they are
    // terms, shown translated.
    .filter((p) => (p.category === "service") === services && p.id !== OFFICE_PILL_ID && p.id !== SPOTIFY_ID)
    .map((p) => p.name);

export const SETTINGS_ENTRIES: SettingsSearchEntry[] = [
  // ── General ──
  {
    id: "general.sound",
    page: "general",
    title: N_("Sound"),
    terms: [N_("Volume"), N_("Your own sounds"), N_("Open sounds folder"), N_("Reload sounds")],
  },
  {
    id: "general.startup",
    page: "general",
    title: N_("Language and startup"),
    terms: [N_("Language"), N_("Launch at startup"), N_("Open this window when Liv starts")],
  },
  {
    id: "general.updates",
    page: "general",
    title: N_("Updates and history"),
    terms: [N_("Tell me when a new version is out"), N_("Check now"), N_("Keep a history of my coding sessions"), N_("Clear history")],
  },
  {
    id: "general.tools",
    page: "general",
    title: N_("Tools"),
    terms: [N_("Clipboard history"), N_("Screenshots"), N_("Open screenshots folder")],
  },

  // ── Island ──
  {
    id: "island.open",
    page: "island",
    title: N_("Opening and folding"),
    terms: [N_("Open on hover"), N_("Fold as the pointer leaves"), N_("Auto-close"), N_("Compact island closes")],
  },
  {
    id: "island.alerts",
    page: "island",
    title: N_("Alerts"),
    terms: [
      N_("Open for every pill’s alerts"), N_("Show the island when music starts"), N_("Tell me when a download finishes"),
    ],
  },
  {
    id: "island.shows",
    page: "island",
    title: N_("What it shows"),
    terms: [N_("Show clock in the island"), N_("Closed island shows"), N_("Hide the island")],
  },
  {
    id: "island.where",
    page: "island",
    title: N_("Where it lives"),
    terms: [N_("Island lives on"), N_("Hide when an app is full screen")],
  },

  // ── Appearance ──
  {
    id: "appearance.size",
    page: "appearance",
    title: N_("Size"),
    terms: [N_("Island size")],
  },
  {
    id: "appearance.shape",
    page: "appearance",
    title: N_("Shape of the open island"),
    terms: [N_("Width"), N_("Extra height"), N_("Corner rounding"), N_("Opacity"), N_("Reset")],
  },
  {
    id: "appearance.liv",
    page: "appearance",
    title: N_("Liv"),
    terms: [N_("Liv wears"), N_("Liv on the desktop")],
  },

  // ── Active pills ──
  {
    id: "pills.active",
    page: "pills",
    title: N_("Active pills"),
    terms: [N_("Main tool"), ...PILL_CATEGORIES.filter((c) => c.id !== "service").map((c) => c.title)],
    names: pillNames(false),
  },

  // ── Agents ──
  {
    id: "agents.claude-code",
    page: "agents",
    title: "Claude Code",
    properTitle: true,
    terms: [N_("Install hooks…"), N_("Uninstall hooks…"), N_("Relay")],
    names: ["settings.json"],
  },
  {
    id: "agents.others",
    page: "agents",
    title: N_("Agents"),
    terms: [
      N_("Install…"), N_("Uninstall…"), N_("Sessions, and Allow / Deny from the island"),
      N_("Approve commands from the island"),
    ],
    // As agents.rs names them (Agent::name).
    names: [
      "Codex", "GitHub Copilot CLI", "Muse Code", "Gemini CLI", "Antigravity", "Cursor Agent",
      "OpenCode", "Amp", "Hermes Agent",
    ],
  },
  {
    id: "agents.plan",
    page: "agents",
    title: N_("Plan usage"),
    terms: [
      N_("Show in the island's header"), N_("Show in compact island"),
      N_("Show Codex plan in the island's header"), N_("Install relay…"), N_("Uninstall relay…"),
    ],
    names: ["Claude", "Codex"],
  },

  // ── Chat ──
  {
    id: "chat.subscriptions",
    page: "chat",
    title: N_("Your AI subscriptions"),
    terms: [N_("Install it")],
    names: ["Claude", "Google Gemini", "ChatGPT", "Cursor", "GitHub Copilot"],
  },
  {
    id: "chat.claude",
    page: "chat",
    title: "Claude",
    properTitle: true,
    terms: [N_("API key"), N_("Save key"), N_("Model")],
    names: ["Anthropic"],
  },
  {
    id: "chat.providers",
    page: "chat",
    title: N_("Chat providers"),
    terms: [],
    names: ["Google AI", "OpenAI", "OpenRouter"],
  },
  {
    id: "chat.local",
    page: "chat",
    title: N_("Local models"),
    terms: [N_("OpenAI-compatible"), N_("Connect"), N_("API key (optional)")],
    names: ["Ollama", "LM Studio", "vLLM", "llama.cpp"],
  },

  // ── Integrations ──
  {
    id: "integrations.services",
    page: "integrations",
    title: N_("Integrations"),
    terms: [
      N_("Token"), N_("API key"), N_("Secret key"), N_("Integration token"), N_("Instance URL"), N_("Office"), N_("Music"),
    ],
    // The music pill is found by the player most people have in mind.
    names: [...pillNames(true), "Spotify"],
  },
  {
    id: "integrations.office",
    page: "integrations",
    title: N_("Virtual office"),
    terms: [N_("Show my virtual office"), N_("Office address"), N_("Send events with"), N_("Copy example")],
  },

  // ── Shortcuts ──
  {
    id: "shortcuts.all",
    page: "shortcuts",
    title: N_("Shortcuts"),
    terms: [
      N_("From anywhere"),
      ...SHORTCUTS.map((d) => SHORTCUT_TEXT[d.id]),
      N_("Reset to defaults"),
      N_("In the open island"),
      ...ISLAND_SHORTCUTS.map((row) => row.description),
    ],
  },
];

/** The section's heading as its page shows it. */
export function entryTitle(entry: SettingsSearchEntry): string {
  return entry.properTitle ? entry.title : t(entry.title);
}

/**
 * The second line of a result: its page, and its section too when the result
 * is something inside a section that is not named like its page.
 */
export function hitSubtitle(hit: SettingsSearchHit, pageTitle: string): string {
  const section = entryTitle(hit.entry);
  return hit.label && section !== pageTitle ? `${pageTitle} › ${section}` : pageTitle;
}

/**
 * Searches the settings index given a query string and page title resolver.
 */
export function searchSettings(
  query: string,
  getPageTitle: (page: SettingsPage) => string,
  entries: SettingsSearchEntry[] = SETTINGS_ENTRIES
): SettingsSearchHit[] {
  const qWords = words(query);
  if (qWords.length === 0) return [];
  const boxes: SettingsSearchHit[] = [];
  const labels: SettingsSearchHit[] = [];

  for (const entry of entries) {
    const pageText = getPageTitle(entry.page);
    const labelTexts = [...entry.terms.map((k) => t(k)), ...(entry.names ?? [])];
    const res = match(qWords, entryTitle(entry), pageText, labelTexts);
    if (!res) continue;
    if (res.kind === "box") {
      boxes.push({ entry, id: entry.id });
    } else {
      labels.push({ entry, label: res.label, id: `${entry.id}|${res.label}` });
    }
  }

  return [...boxes, ...labels].slice(0, 30);
}
