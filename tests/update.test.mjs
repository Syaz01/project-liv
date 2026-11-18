// New versions in the island (src/core/update.ts, src/island/update.ts): when
// the card may open, what it says, and what goes back to Rust — through the
// real bridge, Rust's answers stubbed.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { calls, emit, internals, sent } from "./tauri.mjs";
import { State } from "../src/core/state.ts";
import { NO_UPDATE, headerLine, isBusy, mayOffer, percent } from "../src/core/update.ts";
import { Updates } from "../src/island/update.ts";

const free = { paused: false, pending: false, mode: "hidden", view: "overview" };

test("the question and an announcement come only when the island is free", () => {
  for (const offer of ["ask", "announce"]) {
    assert.equal(mayOffer(offer, free), true);
    assert.equal(mayOffer(offer, { ...free, mode: "compact" }), true);
    assert.equal(mayOffer(offer, { ...free, mode: "expanded", view: "update" }), true);
    assert.equal(mayOffer(offer, { ...free, mode: "expanded", view: "prompt" }), false, `${offer} over the chat`);
    assert.equal(mayOffer(offer, { ...free, mode: "expanded", view: "overview" }), false);
    assert.equal(mayOffer(offer, { ...free, pending: true }), false, `${offer} over an approval`);
    assert.equal(mayOffer(offer, { ...free, paused: true }), false);
  }
});

test("the card asked for (tray, Settings) opens over any view but never over an approval", () => {
  assert.equal(mayOffer("show", { ...free, mode: "expanded", view: "prompt" }), true);
  assert.equal(mayOffer("show", { ...free, paused: true }), true);
  assert.equal(mayOffer("show", { ...free, mode: "expanded", view: "question", pending: true }), false);
});

test("progress, the header line and the busy phases", () => {
  assert.equal(percent(0), 0);
  assert.equal(percent(0.424), 42);
  assert.equal(percent(1.7), 100);
  assert.equal(percent(-1), 0);
  assert.equal(percent(Number.NaN), 0);
  assert.equal(headerLine("A new card", "You have 0.5.0"), "A new card  ·  You have 0.5.0");
  assert.equal(headerLine(null, "You have 0.5.0"), "You have 0.5.0");
  assert.equal(headerLine("  ", "You have 0.5.0"), "You have 0.5.0");
  assert.equal(isBusy({ kind: "downloading", fraction: 0.1 }), true);
  assert.equal(isBusy({ kind: "verifying" }), true);
  assert.equal(isBusy({ kind: "installing" }), true);
  assert.equal(isBusy({ kind: "idle" }), false);
  assert.equal(isBusy({ kind: "error", message: "x" }), false);
});

// ── The controller ────────────────────────────────────────────────────────────

const original = internals.invoke;
// A build with a release channel (RELEASES_REPO in update.rs); NO_UPDATE is one without.
const ON = { ...NO_UPDATE, enabled: true };
const OUT = {
  ...ON,
  consent: true,
  current: "0.5.0",
  latest: { version: "0.6.0", headline: "Island size", pageUrl: "https://github.com/example/liv/releases/tag/windows-v0.6.0" },
  canInstall: true,
};
let shown;
let collapsed;
const host = {
  alert: (view) => shown.push(view),
  collapse: () => collapsed++,
};

beforeEach(async () => {
  calls.length = 0;
  shown = [];
  collapsed = 0;
  internals.invoke = async (cmd, args) => {
    if (cmd === "update_status") return { ...ON, current: "0.5.0" };
    return original(cmd, args);
  };
  State.mode = "hidden";
  State.view = "overview";
  State.paused = false;
  State.pendingApproval = null;
  await Updates.register(host);
});

afterEach(() => {
  internals.invoke = original;
});

test("the question opens the card once Rust offers it, and says it was shown", () => {
  emit("update-offer", "ask");
  assert.deepEqual(shown, ["update"]);
  assert.equal(Updates.asking, true);
  assert.deepEqual(sent("update_shown"), [{ kind: "ask" }]);
  Updates.answer(true);
  assert.equal(Updates.asking, false);
  assert.deepEqual(sent("update_set_consent"), [{ allowed: true }]);
  assert.equal(collapsed, 1);
});

test("without a release channel no card ever opens, asked for or not", () => {
  emit("update-status", { ...NO_UPDATE, current: "0.1.0" });
  emit("update-offer", "ask");
  emit("update-offer", "announce");
  Updates.show();
  assert.deepEqual(shown, []);
  assert.equal(Updates.asking, false);
  assert.deepEqual(sent("update_shown"), []);
  assert.equal(Updates.waiting(), false, "and Liv never turns blue");
});

test("nothing opens over a waiting permission, and nothing is marked shown", () => {
  State.pendingApproval = { requestId: "r1", tool: "Bash", command: "ls", pillId: "integration_claude" };
  emit("update-status", OUT);
  emit("update-offer", "ask");
  emit("update-offer", "announce");
  emit("update-offer", "show");
  assert.deepEqual(shown, []);
  assert.deepEqual(sent("update_shown"), []);
});

test("an announcement opens the card; Later snoozes it", () => {
  emit("update-status", OUT);
  assert.equal(Updates.status.latest.version, "0.6.0");
  emit("update-offer", "announce");
  assert.deepEqual(shown, ["update"]);
  assert.deepEqual(sent("update_shown"), [{ kind: "announce" }]);
  Updates.later();
  assert.equal(sent("update_later").length, 1);
  assert.equal(collapsed, 1);
});

test("an announcement with no version known yet, or while the chat is open, waits", () => {
  emit("update-status", { ...OUT, latest: null });
  emit("update-offer", "announce");
  emit("update-status", OUT);
  State.mode = "expanded";
  State.view = "prompt";
  emit("update-offer", "announce");
  assert.deepEqual(shown, []);
});

test("the tray's Update Liv to X… opens the card without marking anything", () => {
  emit("update-status", OUT);
  State.mode = "expanded";
  State.view = "prompt";
  Updates.show();
  assert.deepEqual(shown, ["update"]);
  assert.deepEqual(sent("update_shown"), []);
  Updates.install();
  Updates.openPage();
  assert.equal(sent("update_install").length, 1);
  assert.equal(sent("update_open_page").length, 1);
});

test("Settings shows its Updates rows only when there is a release channel", async () => {
  const { installFakeDom } = await import("./fakedom.mjs");
  installFakeDom();
  const off = { ...NO_UPDATE, current: "0.1.0" };
  internals.invoke = async (cmd, args) => (cmd === "update_status" ? off : original(cmd, args));
  const settings = await import("../src/settings/updates.ts");
  const rows = settings.updateRows(() => document.createElement("button"), "0.1.0");
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.style.display === "none"), "no release channel: no rows");
  settings.updatesListener({ ...ON, current: "0.1.0" });
  assert.ok(rows.every((row) => row.style.display === ""));
  settings.updatesListener(off);
  assert.ok(rows.every((row) => row.style.display === "none"));
});
