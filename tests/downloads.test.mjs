// A download that finished (src/core/downloads.ts), its way into the island
// (src/island/downloads.ts) and its card (src/views/views.ts), through the
// real bridge: the event comes in as Rust emits it, and what the card asks of
// Rust is read from the commands it invokes — always a number, never a path.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { calls, emit, internals, sent } from "./tauri.mjs";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const {
  NO_DOWNLOADS, downloadGone, downloadOpensIsland, downloadTold, downloadsSeen, parseDownload,
} = await import("../src/core/downloads.ts");
const { Downloads, registerDownloadHandlers } = await import("../src/island/downloads.ts");
const { buildDownload } = await import("../src/views/views.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { Sound } = await import("../src/core/sound.ts");
const { setLanguage } = await import("../src/i18n/i18n.ts");

/** What the mocked Rust side answers, by command. */
let answers = {};
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  return cmd in answers ? answers[cmd] : result;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** What the handler asked the island to do, and what the card asked of it. */
let asked;
const island = { alert: (view) => asked.push(`alert:${view}`) };
registerDownloadHandlers(island);
const actions = new Proxy({}, {
  get: (_, name) => (...args) => asked.push([name, ...args].join(":")),
});
const view = buildDownload(actions);

let played;
const told = (extra = {}) => ({ id: 1, name: "informe.pdf", size: 1_300_000, ...extra });
const text = (cls) => view.el.find(cls).map((el) => el.textContent);
const buttons = () => view.el.find("button").map((b) => b.firstElementChild?.textContent ?? b.textContent);
const click = (label) => view.el.find("button").find((b) => (b.firstElementChild?.textContent ?? b.textContent) === label).fire("click");

beforeEach((t) => {
  setLanguage("en");
  played = [];
  t.mock.method(Sound, "play", (name) => played.push(name));
  answers = {};
  asked = [];
  calls.length = 0;
  State.settings = { ...DEFAULT_SETTINGS };
  State.paused = false;
  State.parked = false;
  State.pendingApproval = null;
  State.mode = "hidden";
  State.view = "overview";
  Downloads.state = NO_DOWNLOADS;
});

// ── What Rust tells ───────────────────────────────────────────────────────────

test("a download is a number, a name and a size; anything else is passed over", () => {
  assert.deepEqual(parseDownload(told()), { id: 1, name: "informe.pdf", size: 1_300_000 });
  assert.deepEqual(parseDownload({ id: 2, name: "a.zip" }), { id: 2, name: "a.zip", size: 0 });
  assert.deepEqual(parseDownload({ id: 2, name: "a.zip", size: -5 }), { id: 2, name: "a.zip", size: 0 });
  // A path, if one ever came, is not kept.
  assert.deepEqual(parseDownload({ ...told(), path: "C:/Users/x/Downloads/informe.pdf" }), told());
  for (const bad of [null, "x", 7, {}, { id: 0, name: "a" }, { id: 1.5, name: "a" }, { id: 1, name: "  " }, { id: "1", name: "a" }]) {
    assert.equal(parseDownload(bad), null);
  }
});

test("the card holds the last download and counts those that came since it was looked at", () => {
  let state = downloadTold(NO_DOWNLOADS, told());
  assert.deepEqual(state, { latest: told(), fresh: 1, gone: false });
  state = downloadTold(state, told({ id: 2, name: "fotos.zip" }));
  assert.deepEqual([state.latest.name, state.fresh], ["fotos.zip", 2]);
  // Looked at: the next one is news on its own. The download stays on the card.
  state = downloadsSeen(state);
  assert.deepEqual([state.latest.name, state.fresh], ["fotos.zip", 0]);
  assert.equal(downloadsSeen(state), state);
  // Its file gone: said of the one shown, not of an older one.
  assert.equal(downloadGone(state, 1), state);
  assert.equal(downloadGone(state, 2).gone, true);
  assert.equal(downloadTold(downloadGone(state, 2), told({ id: 3 })).gone, false);
});

test("a finished download opens the island where an alert may take the screen", () => {
  const scene = { paused: false, parked: false, cardWaiting: false, expanded: false, view: "overview" };
  assert.ok(downloadOpensIsland(scene));
  assert.ok(downloadOpensIsland({ ...scene, expanded: true }), "over the overview");
  // Never over a card that waits, what is being typed, or a section in use; nor where nobody sees it.
  assert.ok(!downloadOpensIsland({ ...scene, cardWaiting: true }));
  for (const busy of ["prompt", "tools", "approval", "launch"]) {
    assert.ok(!downloadOpensIsland({ ...scene, expanded: true, view: busy }), busy);
  }
  assert.ok(!downloadOpensIsland({ ...scene, paused: true }));
  assert.ok(!downloadOpensIsland({ ...scene, parked: true }));
  // Already on its card: it only takes the new name.
  assert.ok(!downloadOpensIsland({ ...scene, expanded: true, view: "download" }));
});

// ── Into the island ───────────────────────────────────────────────────────────

test("a download finishing: the sound of a finished task, and the island opens on its card", () => {
  emit("download", told());
  assert.deepEqual(played, ["finish"]);
  assert.deepEqual(asked, ["alert:download"]);
  assert.equal(Downloads.state.latest.name, "informe.pdf");
});

test("switched off in Settings, or with news that is no download, nothing happens", () => {
  State.settings = { ...State.settings, downloadAlerts: false };
  emit("download", told());
  emit("download", { nonsense: true });
  State.settings = { ...State.settings, downloadAlerts: true };
  emit("download", { nonsense: true });
  assert.deepEqual([played, asked, Downloads.state], [[], [], NO_DOWNLOADS]);
  // A settings file from before the choice existed: on, as a new install.
  State.settings = { ...State.settings, downloadAlerts: undefined };
  emit("download", told());
  assert.deepEqual(asked, ["alert:download"]);
});

test("paused, or with a card waiting, the download is kept for its card and the island stays as it is", () => {
  State.paused = true;
  emit("download", told());
  assert.deepEqual([played, asked], [[], []]);
  assert.equal(Downloads.state.latest.id, 1);

  State.paused = false;
  State.pendingApproval = { requestId: "r1" };
  emit("download", told({ id: 2, name: "fotos.zip" }));
  assert.deepEqual([played, asked], [["finish"], []]);
  assert.deepEqual([Downloads.state.latest.name, Downloads.state.fresh], ["fotos.zip", 2]);
});

test("leaving the card starts the count again", () => {
  emit("download", told());
  emit("download", told({ id: 2 }));
  assert.equal(Downloads.state.fresh, 2);
  State.mode = "expanded";
  State.view = "download";
  State.notify();
  assert.equal(Downloads.state.fresh, 2, "while it is looked at");
  State.view = "overview";
  State.notify();
  assert.equal(Downloads.state.fresh, 0);
});

// ── The card ──────────────────────────────────────────────────────────────────

test("the card: the name, the size, and three things to do with the file", () => {
  view.sync();
  assert.deepEqual([text(".title"), buttons()], [["No download yet."], []]);

  emit("download", told());
  view.sync();
  assert.deepEqual(text(".n"), ["Download finished"]);
  assert.deepEqual(text(".title"), ["informe.pdf"]);
  assert.match(view.el.find(".who-row")[0].textContent, /1\.2 MB/);
  assert.deepEqual(buttons(), ["Open", "Show in folder", "To the shelf"]);

  // Two since the card was last looked at.
  emit("download", told({ id: 2, name: "fotos.zip", size: 10 }));
  view.sync();
  assert.deepEqual([text(".n"), text(".title")], [["2 downloads finished"], ["fotos.zip"]]);

  setLanguage("es");
  view.sync();
  assert.deepEqual(text(".n"), ["2 descargas terminadas"]);
  assert.deepEqual(buttons(), ["Abrir", "Mostrar en la carpeta", "A la repisa"]);
});

test("each button asks Rust for the download by its number, never by a path", async () => {
  answers = { download_open: true, download_reveal: true, download_shelve: true };
  emit("download", told({ id: 7 }));
  view.sync();
  asked = [];

  click("Show in folder");
  await flush();
  assert.deepEqual(sent("download_reveal"), [{ id: 7 }]);
  assert.deepEqual(asked, [], "the card stays");

  click("Open");
  await flush();
  assert.deepEqual(sent("download_open"), [{ id: 7 }]);
  assert.deepEqual(asked, ["collapse"]);

  // On the shelf: the tools come up to show it there.
  click("To the shelf");
  await flush();
  assert.deepEqual(sent("download_shelve"), [{ id: 7 }]);
  assert.deepEqual(asked, ["collapse", "setView:tools"]);
  for (const call of calls) assert.ok(!JSON.stringify(call).includes("informe.pdf"), "no name or path goes back");
});

test("a file that has gone says so, and the island is not folded over a click that did nothing", async () => {
  answers = { download_open: false };
  emit("download", told());
  view.sync();
  asked = [];
  click("Open");
  await flush();
  assert.equal(Downloads.state.gone, true);
  assert.deepEqual(asked, []);
  view.sync();
  assert.deepEqual(text(".n"), ["The file is no longer there"]);
  assert.deepEqual(buttons(), ["OK"]);
  // The next download is whole again.
  emit("download", told({ id: 2, name: "otro.zip" }));
  view.sync();
  assert.deepEqual(buttons(), ["Open", "Show in folder", "To the shelf"]);
});
