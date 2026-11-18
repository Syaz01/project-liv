// Interface language: English and Spanish.
//
// Strings are looked up by their English text: `t("Allow")`,
// `t("Uploading {name}", { name })`. One table, strings.json, written by hand:
// every string the code shows, keyed by its English text, with its Spanish
// translation. A string missing from it shows in English.
//
// The Rust side (src-tauri/src/i18n.rs) embeds the same file and looks up the
// same way, for the tray menu, notifications and the errors it returns.
//
// Changing the language never reloads a window: `setLanguage` tells whoever
// listens (`onLanguageChange`), views/dom.ts relabels the text it was given
// as `tl(…)`, and the views redraw the rest on their next sync.

import STRINGS from "./strings.json";

export const LANGUAGE_CODES = ["en", "es"] as const;
export type Language = (typeof LANGUAGE_CODES)[number];

/** The picker's entries, each in its own language. */
export const LANGUAGES: readonly { code: Language; name: string }[] = [
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
];

export type Vars = Record<string, string | number>;
type Plural = Partial<Record<Intl.LDMLPluralRule, string>>;
/** English is the key itself: an entry has the other languages. */
type Entry = Partial<Record<Exclude<Language, "en">, string | Plural>>;
type Table = Record<string, Entry>;

const TABLE: Table = (STRINGS as { strings: Table }).strings;

let current: Language = "en";
const listeners = new Set<(lang: Language) => void>();

export function isLanguage(code: unknown): code is Language {
  return typeof code === "string" && (LANGUAGE_CODES as readonly string[]).includes(code);
}

/**
 * The language to show: the one picked in Settings when it is one of ours,
 * else the first of the system's languages we have, else English.
 */
export function resolveLanguage(picked: string | undefined | null, system: readonly string[] = []): Language {
  if (isLanguage(picked)) return picked;
  for (const raw of system) {
    const tag = String(raw ?? "").replace(/_/g, "-").toLowerCase();
    if (!tag) continue;
    const base = tag.split("-")[0];
    const exact = LANGUAGE_CODES.find((c) => c.toLowerCase() === base);
    if (exact) return exact;
  }
  return "en";
}

/** The system's languages, as the webview knows them. */
export function systemLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  const list = navigator.languages?.length ? [...navigator.languages] : [];
  if (navigator.language && !list.includes(navigator.language)) list.push(navigator.language);
  return list;
}

export function language(): Language {
  return current;
}

/** Switches the language. Returns true when it changed (listeners were told). */
export function setLanguage(lang: Language): boolean {
  if (!isLanguage(lang) || lang === current) return false;
  current = lang;
  applyDocumentLanguage();
  for (const listener of [...listeners]) listener(lang);
  return true;
}

/** Called after every language change; returns the unsubscribe. */
export function onLanguageChange(listener: (lang: Language) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** <html lang> follows the language, so the webview picks fitting fonts. */
export function applyDocumentLanguage() {
  if (typeof document === "undefined" || !document.documentElement) return;
  document.documentElement.lang = current;
}

function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

function pluralRule(lang: Language, count: number): Intl.LDMLPluralRule {
  try {
    return new Intl.PluralRules(lang).select(count);
  } catch {
    return count === 1 ? "one" : "other";
  }
}

function pickPlural(forms: Plural, lang: Language, count: number): string | undefined {
  return forms[pluralRule(lang, count)] ?? forms.other ?? Object.values(forms)[0];
}

/** The raw translation of `key` in `lang`, or undefined. */
export function lookup(key: string, lang: Language = current): string | Plural | undefined {
  if (lang === "en") return undefined;
  return TABLE[key]?.[lang];
}

/**
 * `key` (English text) in the current language, its `{placeholders}` filled
 * from `vars`. Falls back to the English text.
 */
export function t(key: string, vars?: Vars): string {
  const found = lookup(key);
  let text: string;
  if (typeof found === "string") text = found;
  else if (found) text = pickPlural(found, current, Number(vars?.count ?? 0)) ?? key;
  else text = key;
  return interpolate(text, vars);
}

/**
 * A count with its words: `tn("{count} file", "{count} files", n)`. The other
 * languages pick their form from the entry keyed by the English plural;
 * `{count}` is filled in.
 */
export function tn(one: string, other: string, count: number, vars?: Vars): string {
  const all = { ...vars, count };
  const found = lookup(other);
  if (found && typeof found !== "string") {
    const text = pickPlural(found, current, count);
    if (text) return interpolate(text, all);
  }
  if (typeof found === "string") return interpolate(found, all);
  // English, or a string without a translation: the English forms.
  return interpolate(count === 1 ? one : other, all);
}

/**
 * Marks a literal as a key without translating it, for tables built at load
 * time (pill categories, shortcut names…): the code translates it with `t()`
 * where it is shown. The i18n test finds the keys through it.
 */
export function N_<T extends string>(key: T): T {
  return key;
}

/**
 * A string that follows the language by itself once it is on screen. Given to
 * `h()` (views/dom.ts) as a text, a title, a placeholder or a child, it is
 * redrawn in place when the language changes.
 */
export class Msg {
  readonly key: string;
  readonly vars?: Vars;
  constructor(key: string, vars?: Vars) {
    this.key = key;
    this.vars = vars;
  }
  toString(): string {
    return t(this.key, this.vars);
  }
}

/** `t()` for text built once: see `Msg`. */
export function tl(key: string, vars?: Vars): Msg {
  return new Msg(key, vars);
}

// ── Dates ─────────────────────────────────────────────────────────────────────
// English keeps the Mac's fixed abbreviations; the other languages ask Intl.

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function intl(options: Intl.DateTimeFormatOptions, date: Date): string | null {
  try {
    return new Intl.DateTimeFormat(current, { ...options, timeZone: "UTC" }).format(date);
  } catch {
    return null;
  }
}

/** "Mon" for 1 (Sunday is 0). */
export function weekdayShort(day: number): string {
  if (current === "en") return EN_WEEKDAYS[day] ?? "";
  // 7 January 2024 was a Sunday.
  return intl({ weekday: "short" }, new Date(Date.UTC(2024, 0, 7 + day))) ?? EN_WEEKDAYS[day] ?? "";
}

/** "Oct 9" (months from 0), in the language's own order. */
export function dayMonth(month: number, day: number): string {
  if (current === "en") return `${EN_MONTHS[month] ?? ""} ${day}`;
  return intl({ month: "short", day: "numeric" }, new Date(Date.UTC(2024, month, day))) ?? `${EN_MONTHS[month] ?? ""} ${day}`;
}

/** True when `key` has a translation in every language but English. */
export function isComplete(key: string): boolean {
  const entry = TABLE[key];
  return !!entry && LANGUAGE_CODES.every((l) => l === "en" || entry[l] !== undefined);
}
