// What's new after an update and the blue Liv while one waits
// (src/whats-new/whats-new.ts): which entry, when the card shows, what it
// counts, and when Liv is blue.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NO_UPDATE } from "../src/core/update.ts";
import { Robot } from "../src/robot/robot.ts";
import { WHATS_NEW_ICONS } from "../src/whats-new/icons.ts";
import {
  ICON_NAMES, LATER_MS, compareVersions, decideOnLaunch, iconName, localized, releaseFor,
  showsUpdateHint, soFar, updateWaiting, usedBefore,
} from "../src/whats-new/whats-new.ts";

const FILE = JSON.parse(readFileSync(new URL("../src/whats-new/whats-new.json", import.meta.url), "utf8"));
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("versions compare as numbers", () => {
  assert.equal(compareVersions("0.10.0", "0.9.3"), 1);
  assert.equal(compareVersions("0.5.1", "0.5"), 1);
  assert.equal(compareVersions("0.5", "0.5.0"), 0);
  assert.equal(compareVersions("0.5.0", "0.5.1"), -1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
});

test("the entry of exactly the running version", () => {
  const file = { releases: [{ version: "0.6.0", items: [{ icon: "terminal", title: { en: "A" }, detail: { en: "a" } }] }, { version: "0.5.9", items: [] }] };
  assert.equal(releaseFor(file, "0.6.0")?.version, "0.6.0");
  assert.equal(releaseFor(file, "0.6"), file.releases[0], "0.6 is 0.6.0");
  assert.equal(releaseFor(file, "0.5.9"), null, "an entry without items is no card");
  assert.equal(releaseFor(file, "0.7.0"), null);
  assert.equal(releaseFor(null, "0.6.0"), null);
  assert.equal(releaseFor({}, "0.6.0"), null);
});

test("the version this app ships has its entry, in both languages", () => {
  const release = releaseFor(FILE, PKG.version);
  assert.ok(release, `whats-new.json has no entry for ${PKG.version}`);
  for (const item of release.items) {
    assert.ok(ICON_NAMES.includes(item.icon), item.icon);
    for (const lang of ["en", "es"]) {
      assert.ok(item.title[lang]?.trim(), `${item.icon} title ${lang}`);
      assert.ok(item.detail[lang]?.trim(), `${item.icon} detail ${lang}`);
    }
  }
});

test("every icon name has its drawing", () => {
  for (const name of ICON_NAMES) assert.ok(WHATS_NEW_ICONS[name], name);
  assert.equal(iconName("terminal"), "terminal");
  assert.equal(iconName("rocket"), "sparkles", "an unknown icon draws the sparkles");
});

test("the user's language, else English", () => {
  assert.equal(localized({ en: "Hello", es: "Hola" }, "es"), "Hola");
  assert.equal(localized({ en: "Hello", es: " " }, "es"), "Hello");
  assert.equal(localized({ en: "Hello" }, "es"), "Hello");
  assert.equal(localized(null, "es"), "");
});

test("at launch: an update shows the card once, a first install never", () => {
  const base = { current: "0.5.2", usedBefore: true, hasEntry: true };
  assert.deepEqual(decideOnLaunch({ ...base, lastSeen: "0.5.1" }), { show: true, record: true });
  assert.deepEqual(decideOnLaunch({ ...base, lastSeen: "0.5.2" }), { show: false, record: false }, "same version: nothing");
  assert.deepEqual(decideOnLaunch({ ...base, lastSeen: "0.6.0" }), { show: false, record: true }, "an older build: remember, say nothing");
  assert.deepEqual(decideOnLaunch({ ...base, lastSeen: "0.5.1", hasEntry: false }), { show: false, record: true }, "no entry: no card");
  // No version stored, yet Liv ran here before.
  assert.deepEqual(decideOnLaunch({ ...base, lastSeen: null }), { show: true, record: true });
  assert.deepEqual(decideOnLaunch({ ...base, lastSeen: null, usedBefore: false }), { show: false, record: true }, "a first install");
  assert.deepEqual(decideOnLaunch({ ...base, current: "", lastSeen: null }), { show: false, record: false });
});

test("signs of an earlier install", () => {
  const empty = { turns: [], decisions: [], prefs: {} };
  assert.equal(usedBefore({ consent: null, history: empty }), false);
  assert.equal(usedBefore({ consent: null, history: null }), false);
  assert.equal(usedBefore({ consent: false, history: empty }), true, "the update question was answered");
  assert.equal(usedBefore({ consent: null, history: { ...empty, decisions: [{ agent: "a", date: 1, decision: "allow" }] } }), true);
});

test("your Liv so far: every kept number, zeros left out", () => {
  const turn = (start, end, linesAdded) => ({
    agent: "claude-code", project: "p", start, end, filesChanged: 1, linesAdded, linesRemoved: 3, commandsRun: 0, questions: 0,
  });
  const history = {
    // Two turns overlap: their time counts once (10 min + 20 min - 5 min overlap = 25 min).
    turns: [turn(0, 600, 40), turn(300, 1500, 60)],
    decisions: [
      { agent: "claude-code", date: 1, decision: "allow" },
      { agent: "claude-code", date: 2, decision: "always" },
      { agent: "claude-code", date: 3, decision: "deny" },
      { agent: "claude-code", date: 4, decision: "ask" },
    ],
    prefs: {},
  };
  const stats = soFar({ history });
  assert.deepEqual(stats, [
    { kind: "agentSessions", value: 2 },
    { kind: "agentTime", value: 25 },
    { kind: "linesAdded", value: 100 },
    { kind: "approvals", value: 3 },
  ]);
  assert.deepEqual(soFar({ history: null }), [], "a quiet install: nothing to count");
});

const out = (version = "0.6.0") => ({
  ...NO_UPDATE,
  enabled: true,
  consent: true,
  current: "0.5.2",
  latest: { version, headline: null, pageUrl: "https://github.com/example/liv/releases/tag/windows-v0.6.0" },
});

test("Liv is blue while a version waits", () => {
  const now = 1_800_000_000_000;
  assert.equal(updateWaiting(out(), null, now), true);
  assert.equal(updateWaiting({ ...out(), consent: null }, null, now), false, "never before the user said yes");
  assert.equal(updateWaiting({ ...out(), consent: false }, null, now), false);
  assert.equal(updateWaiting({ ...out(), enabled: false }, null, now), false, "never without a release channel");
  assert.equal(updateWaiting({ ...out(), latest: null }, null, now), false, "up to date");
  for (const phase of [{ kind: "downloading", fraction: 0.3 }, { kind: "verifying" }, { kind: "installing" }, { kind: "error", message: "x" }]) {
    assert.equal(updateWaiting({ ...out(), phase }, null, now), false, phase.kind);
  }
  assert.equal(updateWaiting(out(), { version: "0.6.0", at: now - 3600_000 }, now), false, "Later an hour ago");
  assert.equal(updateWaiting(out(), { version: "0.6.0", at: now - LATER_MS - 1 }, now), true, "Later yesterday: blue again");
  assert.equal(updateWaiting(out(), { version: "0.5.9", at: now - 60_000 }, now), true, "Later on another version");
  assert.equal(updateWaiting(out(), { version: "0.6.0", at: now + 3600_000 }, now), true, "a clock that went back");
});

test("Liv wears the arrow badge only while idle", () => {
  const engine = new Robot();
  engine.setUpdateHint([0.231, 0.51, 0.965]);
  assert.equal(engine.showsUpdateHint, true);
  engine.setState("working");
  assert.equal(engine.showsUpdateHint, false, "work in progress comes first");
  engine.setState("idle");
  assert.equal(engine.showsUpdateHint, true);
  engine.setUpdateHint(null);
  assert.equal(engine.showsUpdateHint, false);
});

test("the blue only when Liv has nothing else to show", () => {
  assert.equal(showsUpdateHint(true, "idle", false), true);
  assert.equal(showsUpdateHint(true, "working", false), false);
  assert.equal(showsUpdateHint(true, "approval", false), false);
  assert.equal(showsUpdateHint(true, "idle", true), false, "a waiting permission comes first");
  assert.equal(showsUpdateHint(false, "idle", false), false);
});
