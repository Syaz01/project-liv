// Interface language for what Rust shows: the tray menu, the settings window
// title and the errors the webviews display. Same table and same lookup as
// src/i18n/i18n.ts: strings.json, written by hand, keyed by the English text
// with its Spanish translation. A string missing from it shows in English.
//
// The language is Settings.language when it is one of ours; "" follows the
// system: the languages the island's webview reports at launch, else (Linux)
// the LANGUAGE / LC_ALL / LC_MESSAGES / LANG variables, else English.

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

pub const LANGUAGES: [&str; 2] = ["en", "es"];

static STRINGS: &str = include_str!("../../src/i18n/strings.json");

type Table = HashMap<String, Map<String, Value>>;

fn table() -> &'static Table {
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut out = Table::new();
        let Ok(Value::Object(root)) = serde_json::from_str::<Value>(STRINGS) else { return out };
        let Some(Value::Object(strings)) = root.get("strings") else { return out };
        for (key, entry) in strings {
            if let Value::Object(langs) = entry {
                out.insert(key.clone(), langs.clone());
            }
        }
        out
    })
}

struct Current {
    picked: String,
    system: Vec<String>,
    resolved: &'static str,
}

fn state() -> &'static RwLock<Current> {
    static STATE: OnceLock<RwLock<Current>> = OnceLock::new();
    STATE.get_or_init(|| {
        let system = env_languages();
        let resolved = resolve("", &system);
        RwLock::new(Current { picked: String::new(), system, resolved })
    })
}

/// LANGUAGE (a list), then LC_ALL, LC_MESSAGES and LANG, as gettext reads them.
fn env_languages() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(list) = std::env::var("LANGUAGE") {
        out.extend(list.split(':').filter(|s| !s.is_empty()).map(str::to_string));
    }
    for name in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(v) = std::env::var(name) {
            if !v.is_empty() && v != "C" && v != "POSIX" {
                out.push(v);
            }
        }
    }
    out
}

/// The language to show: `picked` when it is one of ours, else the first of
/// the system's languages we have, else English. Same rules as resolveLanguage
/// in src/i18n/i18n.ts.
pub fn resolve(picked: &str, system: &[String]) -> &'static str {
    if let Some(code) = LANGUAGES.iter().find(|c| **c == picked) {
        return code;
    }
    for raw in system {
        // "es_ES.UTF-8" → "es-es"
        let tag = raw.split('.').next().unwrap_or("").replace('_', "-").to_lowercase();
        let base = tag.split('-').next().unwrap_or("");
        if base.is_empty() {
            continue;
        }
        if let Some(code) = LANGUAGES.iter().find(|c| c.to_lowercase() == base) {
            return code;
        }
    }
    "en"
}

/// Records Settings.language. Returns true when the shown language changed.
pub fn set_picked(picked: &str) -> bool {
    let mut s = state().write().unwrap_or_else(|e| e.into_inner());
    s.picked = picked.to_string();
    let next = resolve(&s.picked, &s.system);
    std::mem::replace(&mut s.resolved, next) != next
}

/// Records the system's languages as the webview sees them. Returns true when
/// the shown language changed.
pub fn set_system(languages: Vec<String>) -> bool {
    let mut s = state().write().unwrap_or_else(|e| e.into_inner());
    if !languages.is_empty() {
        s.system = languages;
    }
    let next = resolve(&s.picked, &s.system);
    std::mem::replace(&mut s.resolved, next) != next
}

/// The language shown now.
pub fn current() -> &'static str {
    #[cfg(test)]
    return TEST_LANG.with(|c| c.get());
    #[cfg(not(test))]
    state().read().unwrap_or_else(|e| e.into_inner()).resolved
}

// Tests run in parallel and many check English text: each test thread has its
// own language, English unless the test picks another.
#[cfg(test)]
thread_local! {
    static TEST_LANG: std::cell::Cell<&'static str> = const { std::cell::Cell::new("en") };
}

fn interpolate(text: &str, vars: &[(&str, &str)]) -> String {
    let mut out = text.to_string();
    for (name, value) in vars {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

fn lookup_in(lang: &str, key: &str) -> Option<&'static Value> {
    if lang == "en" {
        return None;
    }
    table().get(key)?.get(lang)
}

fn pick_plural(forms: &Map<String, Value>, category: &str) -> Option<String> {
    forms
        .get(category)
        .or_else(|| forms.get("other"))
        .or_else(|| forms.values().next())
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Marks an English key for a table built before it is shown (the tray's
/// labels): the code translates it with `t` when it shows it. The i18n test
/// (tests/i18n.test.mjs) finds the keys through it.
pub const fn n_(key: &'static str) -> &'static str {
    key
}

/// `key` (English text) in the shown language, else the English text.
pub fn t(key: &str) -> String {
    tf(key, &[])
}

/// `t` with `{name}` placeholders filled in.
pub fn tf(key: &str, vars: &[(&str, &str)]) -> String {
    let lang = current();
    let text = match lookup_in(lang, key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(forms)) => pick_plural(forms, "other").unwrap_or_else(|| key.to_string()),
        _ => key.to_string(),
    };
    interpolate(&text, vars)
}

#[cfg(test)]
pub(crate) fn set_for_test(lang: &str) {
    TEST_LANG.with(|c| c.set(resolve(lang, &[])));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_like_the_webview() {
        let sys = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(resolve("es", &sys(&["en-US"])), "es");
        assert_eq!(resolve("en", &sys(&["es-ES"])), "en");
        assert_eq!(resolve("", &sys(&["es_ES.UTF-8"])), "es");
        assert_eq!(resolve("", &sys(&["zh-TW", "it", "es-MX"])), "es");
        assert_eq!(resolve("", &sys(&["en-GB", "es-ES"])), "en");
        assert_eq!(resolve("", &sys(&["it-IT"])), "en");
        assert_eq!(resolve("", &[]), "en");
        // A language this build doesn't have reads as "follow the system".
        assert_eq!(resolve("fr", &sys(&["es-AR"])), "es");
        assert_eq!(resolve("xx", &[]), "en");
    }

    #[test]
    fn looks_up_the_table_and_falls_back_to_english() {
        set_for_test("es");
        assert_eq!(t("Allow"), "Permitir");
        assert_eq!(t("Open Liv"), "Abrir Liv");
        assert_eq!(t("A string nobody translated"), "A string nobody translated");
        assert_eq!(tf("Open {name}", &[("name", "Vercel")]), "Abrir Vercel");
        set_for_test("en");
        assert_eq!(t("Allow"), "Allow");
        assert_eq!(tf("Open {name}", &[("name", "Vercel")]), "Open Vercel");
    }

    #[test]
    fn every_string_has_every_language() {
        assert!(table().len() > 300, "only {} strings: has strings.json changed shape?", table().len());
        for (key, entry) in table() {
            for lang in LANGUAGES.iter().filter(|l| **l != "en") {
                assert!(entry.get(*lang).is_some(), "{key:?} has no {lang}");
            }
        }
    }
}
