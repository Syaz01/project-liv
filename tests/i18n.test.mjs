// Interface language (src/i18n): lookup, fallback, interpolation and plurals,
// the table being well-formed, carrying exactly the keys the code uses, each
// translated, and no known user-facing English left outside t() in the views.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const {
  LANGUAGES, LANGUAGE_CODES, dayMonth, isComplete, language, lookup,
  onLanguageChange, resolveLanguage, setLanguage, t, tl, tn, weekdayShort,
} = await import("../src/i18n/i18n.ts");
const { h, relabel } = await import("../src/views/dom.ts");

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const TABLE = JSON.parse(readFileSync(join(ROOT, "src/i18n/strings.json"), "utf8"));
const OTHERS = LANGUAGE_CODES.filter((l) => l !== "en");

/** Runs `fn` in `lang`, then puts English back for the other tests. */
function inLanguage(lang, fn) {
  setLanguage(lang);
  try {
    fn();
  } finally {
    setLanguage("en");
  }
}

// ── Lookup ────────────────────────────────────────────────────────────────────

test("English is the key itself, Spanish comes from the table", () => {
  assert.equal(language(), "en");
  assert.equal(t("Allow"), "Allow");
  inLanguage("es", () => {
    assert.equal(language(), "es");
    assert.equal(t("Allow"), "Permitir");
    assert.equal(t("Open the chat"), "Abrir el chat");
  });
});

test("a string nobody translated falls back to its English text", () => {
  inLanguage("es", () => {
    assert.equal(t("Some brand new sentence."), "Some brand new sentence.");
    assert.equal(t("Hello {name}", { name: "Liv" }), "Hello Liv");
  });
});

test("placeholders are filled in both languages, unknown ones are left as they are", () => {
  assert.equal(t("Uploading {name}", { name: "a.pdf" }), "Uploading a.pdf");
  assert.equal(t("Uploading {name}"), "Uploading {name}");
  inLanguage("es", () => {
    assert.equal(t("Uploading {name}", { name: "a.pdf" }), "Subiendo a.pdf");
    assert.equal(t("Uploading {name}"), "Subiendo {name}");
    assert.equal(t("in {h} h {m}", { h: 1, m: 20 }), "en 1 h 20");
    assert.equal(t("API error {code}", { code: 401 }), "Error de API 401");
  });
  assert.equal(t("{used}/{max} slots in use — the main tool doesn't take one.", { used: 2, max: 4 }),
    "2/4 slots in use — the main tool doesn't take one.");
});

test("a count picks its form in both languages", () => {
  const repos = (n) => tn("{count} repo", "{count} repos", n);
  assert.equal(repos(1), "1 repo");
  assert.equal(repos(0), "0 repos");
  assert.equal(repos(3), "3 repos");
  inLanguage("es", () => {
    assert.equal(repos(1), "1 repositorio");
    assert.equal(repos(0), "0 repositorios");
    assert.equal(repos(21), "21 repositorios");
    assert.equal(tn("{count} contribution", "{count} contributions", 1), "1 contribución");
    assert.equal(tn("{count} contribution", "{count} contributions", 2), "2 contribuciones");
    // t() on a counted string reads the count from its variables.
    assert.equal(t("{count} repos", { count: 1 }), "1 repositorio");
    assert.equal(t("{count} repos", { count: 5 }), "5 repositorios");
    // A count nobody translated keeps the English forms it was given.
    assert.equal(tn("{count} thing", "{count} things", 1), "1 thing");
    assert.equal(tn("{count} thing", "{count} things", 2), "2 things");
  });
});

test("dates read in the current language", () => {
  inLanguage("es", () => {
    assert.match(weekdayShort(1), /^lun/);
    assert.match(dayMonth(8, 28), /^28 sept?/);
  });
  assert.equal(weekdayShort(1), "Mon");
  assert.equal(dayMonth(8, 28), "Sep 28");
});

// ── Choosing the language ─────────────────────────────────────────────────────

test("System follows the system's language when Liv has it, else English", () => {
  assert.equal(resolveLanguage("", ["es-ES", "en-US"]), "es");
  assert.equal(resolveLanguage("", ["en-GB", "es-ES"]), "en");
  assert.equal(resolveLanguage("", ["it-IT", "es-MX"]), "es");
  for (const tag of ["es", "es-AR", "es_ES", "es_ES.UTF-8", "ES-es"]) assert.equal(resolveLanguage("", [tag]), "es");
  assert.equal(resolveLanguage("", ["it-IT"]), "en");
  assert.equal(resolveLanguage("", []), "en");
  assert.equal(resolveLanguage(undefined, ["es"]), "es");
  // A picked language wins; one this build doesn't have means System.
  assert.equal(resolveLanguage("es", ["en-US"]), "es");
  assert.equal(resolveLanguage("en", ["es-ES"]), "en");
  assert.equal(resolveLanguage("fr", ["es-ES"]), "es");
  assert.equal(resolveLanguage("xx", ["fr-FR"]), "en");
});

test("the picker offers English and Spanish, each in its own language", () => {
  assert.deepEqual(LANGUAGES, [{ code: "en", name: "English" }, { code: "es", name: "Español" }]);
  assert.deepEqual(LANGUAGES.map((l) => l.code), [...LANGUAGE_CODES]);
});

test("the Rust language list agrees with the picker", () => {
  const rust = readFileSync(join(ROOT, "src-tauri/src/i18n.rs"), "utf8");
  const registered = rust.match(/pub const LANGUAGES: \[&str; (\d+)\] = (\[[^;]+\]);/);
  assert.ok(registered);
  assert.equal(Number(registered[1]), LANGUAGE_CODES.length);
  assert.deepEqual(JSON.parse(registered[2]), [...LANGUAGE_CODES]);
});

test("the document's language follows, and an unknown one changes nothing", () => {
  const previousRoot = document.documentElement;
  document.documentElement = { lang: "en" };
  try {
    inLanguage("es", () => assert.equal(document.documentElement.lang, "es"));
    assert.equal(document.documentElement.lang, "en");
    assert.equal(setLanguage("fr"), false);
    assert.equal(language(), "en");
  } finally {
    if (previousRoot === undefined) delete document.documentElement;
    else document.documentElement = previousRoot;
  }
});

test("a language change relabels what was built, in place, and says so once", () => {
  let told = 0;
  const off = onLanguageChange(() => told++);
  const button = h("button", { title: tl("Settings") }, tl("Cancel"));
  const label = h("span", { text: tl("Uploading {name}", { name: "x.png" }) });
  const replaced = h("span", { text: tl("Allow") });
  replaced.textContent = "dynamic text"; // some code wrote over it since

  setLanguage("es");
  assert.equal(told, 1);
  assert.equal(button.getAttribute("title"), "Ajustes");
  assert.equal(button.textContent, "Cancelar");
  assert.equal(label.textContent, "Subiendo x.png");
  assert.equal(replaced.textContent, "dynamic text");
  setLanguage("es"); // same language: nothing to do
  assert.equal(told, 1);

  setLanguage("en");
  assert.equal(button.textContent, "Cancel");
  relabel();
  assert.equal(button.getAttribute("title"), "Settings");
  off();
});

// ── The table ─────────────────────────────────────────────────────────────────

const placeholders = (s) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort();

test("strings.json: every string in Spanish, with the key's placeholders", () => {
  assert.deepEqual(Object.keys(TABLE), ["_about", "strings"]);
  for (const [key, entry] of Object.entries(TABLE.strings)) {
    const name = JSON.stringify(key);
    // English is the key: an entry has the other languages and nothing else.
    assert.deepEqual(Object.keys(entry), OTHERS, name);
    for (const lang of OTHERS) {
      const value = entry[lang];
      if (typeof value === "string") {
        assert.ok(value.trim(), `${lang} ${name} is empty`);
        assert.deepEqual(placeholders(value), placeholders(key), `${lang} ${name}: ${JSON.stringify(value)}`);
        continue;
      }
      // A counted string: the two forms English and Spanish have, and Rust picks from.
      assert.ok(value && typeof value === "object" && !Array.isArray(value), `${lang} ${name}`);
      assert.deepEqual(Object.keys(value).sort(), ["one", "other"], `${lang} ${name}`);
      assert.ok(key.includes("{count}"), `${name} is counted without {count}`);
      for (const [form, text] of Object.entries(value)) {
        assert.ok(typeof text === "string" && text.trim(), `${lang} ${name} ${form}`);
        // The singular may write the number out ("un repositorio").
        const got = placeholders(text);
        const ok = form === "other"
          ? JSON.stringify(got) === JSON.stringify(placeholders(key))
          : got.every((p) => placeholders(key).includes(p));
        assert.ok(ok, `${lang} ${name} ${form}: ${JSON.stringify(text)}`);
      }
    }
  }
});

test("lookup() answers from the table", () => {
  assert.equal(lookup("Allow", "en"), undefined);
  assert.equal(lookup("Allow", "es"), "Permitir");
  assert.equal(lookup("Allow"), undefined, "the current language by default");
  assert.deepEqual(lookup("{count} repos", "es"), { one: "{count} repositorio", other: "{count} repositorios" });
  assert.equal(lookup("Some brand new sentence.", "es"), undefined);
});

// ── Every key the code uses is translated ─────────────────────────────────────

function files(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path, ext));
    else if (path.endsWith(ext)) out.push(path);
  }
  return out;
}

/** Source without comments (a doc example is not a key) or Rust test modules. */
function code(path) {
  // Windows checkouts have CRLF line endings.
  let text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const tests = text.indexOf("#[cfg(test)]\nmod tests");
  if (tests >= 0) text = text.slice(0, tests);
  return text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
}

const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
const unquote = (s) => JSON.parse(`"${s}"`);

function usedKeys() {
  const keys = new Map();
  const add = (key, path) => keys.set(key, relative(ROOT, path));
  for (const path of files(join(ROOT, "src"), ".ts")) {
    const text = code(path);
    for (const m of text.matchAll(new RegExp(String.raw`\b(?:t|tl|N_)\(\s*` + STR, "g"))) add(unquote(m[1]), path);
    // tn(one, other, n): the English plural is the key.
    for (const m of text.matchAll(new RegExp(String.raw`\btn\(\s*` + STR + String.raw`\s*,\s*` + STR, "g"))) add(unquote(m[2]), path);
  }
  for (const path of files(join(ROOT, "src-tauri/src"), ".rs")) {
    const text = code(path);
    for (const m of text.matchAll(new RegExp(String.raw`\b(?:t|tf|n_)\(\s*` + STR, "g"))) add(unquote(m[1]), path);
    for (const m of text.matchAll(new RegExp(String.raw`\btn\(\s*` + STR + String.raw`\s*,\s*` + STR, "g"))) add(unquote(m[2]), path);
  }
  return keys;
}

test("every string the code shows is translated, and the table carries nothing else", () => {
  const keys = usedKeys();
  assert.ok(keys.size > 300, `only ${keys.size} keys found — has the scan broken?`);
  const missing = [...keys].filter(([key]) => !isComplete(key)).map(([key, path]) => `${path}: ${JSON.stringify(key)}`);
  assert.deepEqual(missing, []);
  // A string the code no longer uses leaves the table with it.
  const unused = Object.keys(TABLE.strings).filter((key) => !keys.has(key));
  assert.deepEqual(unused, []);
});

// ── No English left outside t() ───────────────────────────────────────────────
//
// Pragmatic: a literal in the views, the settings window, the island, the
// upload canvas or the recap that is exactly a translated string, and is not
// the argument of t() / tl() / tn() / N_(), is English that would stay English.

const CHECKED = ["src/views", "src/settings", "src/island", "src/upload", "src/recap", "src/main.ts"];
/** Literals that are a translated word but are values in the code, not text on screen. */
const NOT_TEXT = new Set([
  "file", // the kind of a chat context: { kind: "file" }
  "finished", // a task state and a pill badge
  "unknown", // a CI state
]);

test("no known user-facing English literal outside t() in the views and settings", () => {
  const translated = new Set(
    Object.entries(TABLE.strings)
      .filter(([key, entry]) => OTHERS.some((l) => typeof entry[l] !== "string" || entry[l] !== key))
      .map(([key]) => key),
  );
  const offenders = [];
  for (const target of CHECKED) {
    const full = join(ROOT, target);
    const list = statSync(full).isDirectory() ? files(full, ".ts") : [full];
    for (const path of list) {
      const text = code(path);
      for (const m of text.matchAll(new RegExp(STR, "g"))) {
        let value;
        try {
          value = unquote(m[1]);
        } catch {
          continue;
        }
        if (!translated.has(value) || NOT_TEXT.has(value)) continue;
        const before = text.slice(Math.max(0, m.index - 400), m.index);
        if (/\b(?:t|tl|N_)\(\s*$/.test(before)) continue;
        if (/\btn\(\s*"(?:[^"\\]|\\.)*"\s*,\s*$/.test(before) || /\btn\(\s*$/.test(before)) continue;
        offenders.push(`${relative(ROOT, path)}: ${JSON.stringify(value)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
