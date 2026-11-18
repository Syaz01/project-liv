// The virtual office's model (src/core/office.ts): reading an event as
// docs/OFICINA.md describes it, the office's state and its limits, and what
// the island shows and does for it. No DOM, no Tauri, and no clock but the
// `now` each call is given.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OFFICE_ID, MAX_AGENTS, MAX_ASKS, MAX_NEWS, SHOWN_AGENTS, STALE_AFTER_MS,
  applyOfficeEvent, isStale, officeBadge, officeCard, officeBotState, officeEffect, officeSeen,
  parseOfficeEvent, safeUrl, waitingCount,
} from "../src/core/office.ts";

const T0 = 1_000_000;
const MINUTE = 60_000;

/** The office after these raw events, each a minute after the last one. */
function office(events, state = null, start = T0) {
  events.forEach((raw, i) => {
    const event = parseOfficeEvent(raw);
    assert.ok(event, `not an event: ${JSON.stringify(raw)}`);
    state = applyOfficeEvent(state, event, start + i * MINUTE);
  });
  return state;
}

const agentState = (id, state, extra = {}) => ({ type: "agent.state", agent: { id }, state, ...extra });
const askOpen = (id, title = "¿Apruebas?", extra = {}) => ({ type: "ask.open", ask: { id, title, ...extra } });
const askClose = (id) => ({ type: "ask.close", ask: { id } });
const news = (title, level, extra = {}) => ({ type: "news", news: { title, level, ...extra } });

// ── Reading an event ──────────────────────────────────────────────────────────

test("the contract's examples are read as written", () => {
  assert.deepEqual(
    parseOfficeEvent({
      type: "agent.state",
      agent: { id: "editora", name: "Editora", role: "Edición" },
      state: "working",
      summary: "Montando el vídeo 12",
      item: { id: "video-12", title: "Vídeo 12", stage: "edición" },
    }),
    {
      office: "office", officeName: null, openUrl: null,
      type: "agent.state", agent: { id: "editora", name: "Editora", role: "Edición" },
      state: "working", summary: "Montando el vídeo 12",
    },
  );
  assert.deepEqual(
    parseOfficeEvent({
      type: "ask.open",
      agent: { id: "guionista" },
      ask: {
        id: "guion-12", title: "¿Apruebas el guion del vídeo 12?", detail: "8 minutos, tono divulgativo",
        open_url: "http://localhost:3000/videos/12/guion",
      },
    }),
    {
      office: "office", officeName: null, openUrl: null,
      type: "ask.open", agent: { id: "guionista", name: null, role: null },
      id: "guion-12", title: "¿Apruebas el guion del vídeo 12?", detail: "8 minutos, tono divulgativo",
      url: "http://localhost:3000/videos/12/guion",
    },
  );
  assert.deepEqual(parseOfficeEvent({ type: "ask.close", ask: { id: "guion-12" } }), {
    office: "office", officeName: null, openUrl: null, type: "ask.close", id: "guion-12",
  });
  assert.deepEqual(
    parseOfficeEvent({
      type: "news", agent: { id: "publicadora" },
      news: { title: "Vídeo 12 publicado", level: "success", open_url: "https://youtu.be/abc" },
    }),
    {
      office: "office", officeName: null, openUrl: null,
      type: "news", agent: { id: "publicadora", name: null, role: null },
      title: "Vídeo 12 publicado", level: "success", url: "https://youtu.be/abc",
    },
  );
  assert.deepEqual(parseOfficeEvent({ type: "reset" }), {
    office: "office", officeName: null, openUrl: null, type: "reset",
  });
});

test("the common fields: version, office, its name and its address", () => {
  const read = (extra) => parseOfficeEvent({ type: "reset", ...extra });
  assert.equal(DEFAULT_OFFICE_ID, "office");
  assert.equal(read({ v: 1 }).office, "office");
  assert.equal(read({ v: 2 }), null, "a format this version does not know");
  assert.equal(read({ v: "1" }), null);
  assert.equal(read({ office: "canal-youtube-2" }).office, "canal-youtube-2");
  for (const bad of ["Canal", "canal youtube", "", "a".repeat(25), "café", 12, null, ["office"]]) {
    assert.equal(read({ office: bad }), null, `office ${JSON.stringify(bad)}`);
  }
  assert.equal(read({ office_name: "  Canal\n de\tYouTube " }).officeName, "Canal de YouTube");
  assert.equal(read({ office_name: "   " }).officeName, null);
  assert.equal(read({ office_name: 7 }).officeName, null);
  assert.equal(read({ open_url: "http://localhost:3000" }).openUrl, "http://localhost:3000/");
  assert.equal(read({ open_url: "file:///C:/Windows" }).openUrl, null, "the field is left out, the event stays");
});

test("what is not an event this version understands is nothing at all", () => {
  for (const raw of [
    null, undefined, 7, "reset", [], [{ type: "reset" }], {},
    { type: "agent.created" }, { type: 1 }, { type: "RESET" },
    // agent.state: its agent and its state are required.
    { type: "agent.state", state: "working" },
    { type: "agent.state", agent: "editora", state: "working" },
    { type: "agent.state", agent: { id: "Editora" }, state: "working" },
    { type: "agent.state", agent: { id: "a b" }, state: "working" },
    { type: "agent.state", agent: { id: "editora" } },
    { type: "agent.state", agent: { id: "editora" }, state: "busy" },
    { type: "agent.state", agent: { id: "editora" }, state: "Working" },
    // ask.open: an id and a title; ask.close: an id.
    { type: "ask.open" },
    { type: "ask.open", ask: { title: "¿Sí?" } },
    { type: "ask.open", ask: { id: "a" } },
    { type: "ask.open", ask: { id: "a", title: "  \n " } },
    { type: "ask.open", ask: { id: 12, title: "¿Sí?" } },
    { type: "ask.open", ask: { id: "x".repeat(49), title: "¿Sí?" } },
    { type: "ask.close" },
    { type: "ask.close", ask: {} },
    { type: "ask.close", ask: { id: " " } },
    // news: a title.
    { type: "news" },
    { type: "news", news: { level: "success" } },
    { type: "news", news: { title: 404 } },
  ]) {
    assert.equal(parseOfficeEvent(raw), null, JSON.stringify(raw));
  }
});

test("an optional field that is wrong is left out, not the event", () => {
  const state = parseOfficeEvent({
    type: "agent.state", agent: { id: "editora", name: ["Editora"], role: 3 }, state: "idle", summary: { a: 1 }, item: "vídeo",
  });
  assert.deepEqual([state.agent.name, state.agent.role, state.summary], [null, null, null]);

  const ask = parseOfficeEvent({
    type: "ask.open", agent: { id: "NOPE" }, ask: { id: "a", title: "¿Sí?", detail: 5, open_url: "javascript:alert(1)" },
  });
  assert.deepEqual([ask.agent, ask.detail, ask.url], [null, null, null]);

  const piece = parseOfficeEvent({ type: "news", news: { title: "Hecho", level: "loud", open_url: "notaurl" } });
  assert.deepEqual([piece.level, piece.url], ["info", null]);
  assert.equal(parseOfficeEvent({ type: "news", news: { title: "Hecho" } }).level, "info");
});

test("text is one line, cut to its length with an ellipsis", () => {
  const lengths = (raw) => {
    const e = parseOfficeEvent(raw);
    return e && Object.fromEntries(
      Object.entries({ ...e, ...e.agent }).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, Array.from(v).length]),
    );
  };
  const long = "é".repeat(500);
  assert.deepEqual(
    lengths({ type: "agent.state", office_name: long, agent: { id: "a", name: long, role: long }, state: "idle", summary: long }),
    { office: 6, officeName: 40, type: 11, id: 1, name: 32, role: 32, state: 4, summary: 140 },
  );
  assert.deepEqual(
    lengths({ type: "ask.open", ask: { id: "x".repeat(48), title: long, detail: long } }),
    { office: 6, type: 8, id: 48, title: 100, detail: 140 },
  );
  assert.equal(lengths({ type: "news", news: { title: long } }).title, 100);

  const cut = parseOfficeEvent({ type: "news", news: { title: "a".repeat(101) } }).title;
  assert.equal(cut, `${"a".repeat(99)}…`);
  assert.equal(parseOfficeEvent({ type: "news", news: { title: "a".repeat(100) } }).title, "a".repeat(100));
  // By character, not by half of one.
  const emoji = parseOfficeEvent({ type: "news", news: { title: "🎬".repeat(150) } }).title;
  assert.equal(emoji, `${"🎬".repeat(99)}…`);
  // Line breaks, tabs and control characters never reach a card.
  assert.equal(
    parseOfficeEvent({ type: "news", news: { title: "  Vídeo\r\n12\u0000\u0007 \t publicado\u0085 " } }).title,
    "Vídeo 12 publicado",
  );
});

test("the piece an agent works on stands in for a missing summary", () => {
  const read = (extra) => parseOfficeEvent({ type: "agent.state", agent: { id: "a" }, state: "working", ...extra }).summary;
  assert.equal(read({ item: { id: "video-12", title: "Vídeo 12", stage: "edición" } }), "Vídeo 12 · edición");
  assert.equal(read({ item: { title: "Vídeo 12" } }), "Vídeo 12");
  assert.equal(read({ item: { stage: "edición" } }), "edición");
  assert.equal(read({ item: { id: "video-12" } }), null);
  assert.equal(read({ summary: "Montando", item: { title: "Vídeo 12" } }), "Montando");
});

test("only http and https addresses are ever kept", () => {
  assert.equal(safeUrl("http://localhost:3000/videos/12"), "http://localhost:3000/videos/12");
  assert.equal(safeUrl("  https://youtu.be/abc?t=1#x "), "https://youtu.be/abc?t=1#x");
  assert.equal(safeUrl("HTTPS://Example.com"), "https://example.com/", "written out the way Rust's open_url expects it");
  for (const bad of [
    "", "   ", "localhost:3000", "example.com", "/videos/12", "//example.com",
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>",
    "file:///C:/Windows/System32/calc.exe", "C:\\Windows\\System32\\calc.exe", "\\\\server\\share\\x.exe",
    "ms-settings:privacy", "vscode://file/x", "ftp://example.com/x", "mailto:a@example.com", "about:blank",
    "http://", `https://example.com/${"a".repeat(2050)}`,
    null, undefined, 3000, { href: "http://x" }, ["http://x"],
  ]) {
    assert.equal(safeUrl(bad), null, JSON.stringify(bad));
  }
});

// ── The office ────────────────────────────────────────────────────────────────

test("an agent's name and role are remembered, its line only while its state stays", () => {
  let s = office([agentState("editora", "working", { agent: { id: "editora", name: "Editora", role: "Edición" }, summary: "Montando" })]);
  assert.deepEqual(s.agents.map((a) => [a.id, a.name, a.role, a.state, a.summary]), [
    ["editora", "Editora", "Edición", "working", "Montando"],
  ]);
  // The same state again, without a line: a sign of life, nothing forgotten.
  s = office([agentState("editora", "working")], s);
  assert.deepEqual([s.agents[0].name, s.agents[0].role, s.agents[0].summary], ["Editora", "Edición", "Montando"]);
  // Another state: the line said what it was doing then.
  s = office([agentState("editora", "idle")], s);
  assert.deepEqual([s.agents[0].name, s.agents[0].state, s.agents[0].summary], ["Editora", "idle", null]);
  // A new name replaces the old one; an agent that never gave one goes by its id.
  s = office([agentState("editora", "idle", { agent: { id: "editora", name: "Edi" } }), agentState("ideas", "working")], s);
  assert.deepEqual(s.agents.map((a) => a.name), ["Edi", "ideas"]);
});

test("the office's name and address come with any event and stay", () => {
  let s = office([{ ...agentState("a", "idle"), office_name: "Canal", open_url: "http://localhost:3000" }]);
  assert.deepEqual([s.id, s.name, s.openUrl], ["office", "Canal", "http://localhost:3000/"]);
  s = office([news("Hola")], s);
  assert.deepEqual([s.name, s.openUrl], ["Canal", "http://localhost:3000/"]);
  s = office([{ ...news("Hola"), office_name: "Canal 2", open_url: "ftp://nope" }], s);
  assert.deepEqual([s.name, s.openUrl], ["Canal 2", "http://localhost:3000/"]);
});

test("the state given is never changed", () => {
  const before = office([agentState("a", "working"), askOpen("q1"), news("Hola")]);
  const copy = structuredClone(before);
  office([agentState("a", "error"), agentState("b", "idle"), askOpen("q2"), askClose("q1"), news("Adiós", "error")], before);
  officeSeen(before);
  assert.deepEqual(before, copy);
});

test("another office starts from nothing, and reset forgets the office", () => {
  const one = office([agentState("a", "working"), askOpen("q1"), news("Hola")]);
  const two = office([{ ...agentState("z", "idle"), office: "podcast" }], one);
  assert.deepEqual([two.id, two.agents.map((a) => a.id), two.asks, two.news], ["podcast", ["z"], [], []]);
  assert.equal(office([{ type: "reset" }], one), null);
  assert.equal(office([{ type: "reset", office: "podcast" }], one), null);
  assert.equal(office([{ type: "reset" }]), null);
  // After a reset the first event starts a new office.
  assert.deepEqual(office([{ type: "reset" }, agentState("b", "idle")], one).agents.map((a) => a.id), ["b"]);
});

test("at most twelve agents: the one heard from longest ago leaves, a resting one first", () => {
  const ids = (s) => s.agents.map((a) => a.id);
  const twelve = Array.from({ length: MAX_AGENTS }, (_, i) => agentState(`a${i}`, "working"));
  let s = office(twelve);
  assert.equal(s.agents.length, 12);

  // Everybody is busy: the one heard from longest ago makes room.
  s = office([agentState("new1", "working")], s);
  assert.deepEqual(ids(s), [...Array.from({ length: 11 }, (_, i) => `a${i + 1}`), "new1"]);

  // Agents with nothing in hand go before any busy one, the oldest of them first.
  s = office([agentState("a5", "done"), agentState("a3", "offline"), agentState("a9", "idle")], s);
  s = office([agentState("new2", "working")], s);
  assert.ok(!ids(s).includes("a5") && ids(s).includes("a3") && ids(s).includes("a1"));
  s = office([agentState("new3", "working")], s);
  assert.ok(!ids(s).includes("a3") && ids(s).includes("a9"));
  assert.equal(s.agents.length, 12);

  // An agent already there never pushes anyone out.
  const again = office([agentState("a1", "error")], s);
  assert.deepEqual(ids(again), ids(s));
});

test("at most twenty asks and the last five pieces of news", () => {
  let s = office(Array.from({ length: MAX_ASKS + 3 }, (_, i) => askOpen(`q${i}`, `¿${i}?`)));
  assert.equal(s.asks.length, 20);
  assert.deepEqual([s.asks[0].id, s.asks.at(-1).id], ["q3", "q22"]);
  assert.equal(waitingCount(s), 20);

  s = office(Array.from({ length: MAX_NEWS + 2 }, (_, i) => news(`n${i}`)), s);
  assert.deepEqual(s.news.map((n) => n.title), ["n2", "n3", "n4", "n5", "n6"]);
});

test("an ask waits until it is closed by its id; sent again it is brought up to date in place", () => {
  let s = office([askOpen("q1", "¿Uno?"), askOpen("q2", "¿Dos?")]);
  s = office([askOpen("q1", "¿Uno, de verdad?", { detail: "ahora con detalle" })], s);
  assert.deepEqual(s.asks.map((a) => [a.id, a.title, a.detail]), [
    ["q1", "¿Uno, de verdad?", "ahora con detalle"], ["q2", "¿Dos?", null],
  ]);
  s = office([askClose("nope")], s);
  assert.equal(waitingCount(s), 2);
  s = office([askClose("q2")], s);
  assert.deepEqual(s.asks.map((a) => a.id), ["q1"]);
  s = office([askClose("q1")], s);
  assert.equal(waitingCount(s), 0);
  assert.equal(waitingCount(null), 0);
});

test("an ask and a piece of news say who they come from, by name", () => {
  const s = office([
    agentState("guionista", "waiting", { agent: { id: "guionista", name: "Guionista" } }),
    { ...askOpen("q1"), agent: { id: "guionista" } },
    { ...news("Publicado"), agent: { id: "publicadora", name: "Publicadora" } },
    { ...news("Listo"), agent: { id: "nadie" } },
    news("Suelto"),
  ]);
  assert.equal(s.asks[0].by, "Guionista");
  assert.deepEqual(s.news.map((n) => n.by), ["Publicadora", "nadie", null]);
  // Naming an agent in passing does not make it one of the team.
  assert.deepEqual(s.agents.map((a) => a.id), ["guionista"]);
});

// ── Gone quiet ────────────────────────────────────────────────────────────────

test("a busy agent that has sent nothing for 15 minutes has no signal", () => {
  const s = office([
    agentState("w", "working"), agentState("q", "waiting"), agentState("b", "blocked"),
    agentState("i", "idle"), agentState("e", "error"), agentState("d", "done"), agentState("o", "offline"),
  ], null, T0);
  const stale = (now) => s.agents.filter((a) => isStale(a, now)).map((a) => a.id);
  assert.equal(STALE_AFTER_MS, 15 * MINUTE);
  // Each was heard from a minute after the one before.
  assert.deepEqual(stale(T0 + 15 * MINUTE - 1), []);
  assert.deepEqual(stale(T0 + 15 * MINUTE), ["w"]);
  assert.deepEqual(stale(T0 + 17 * MINUTE), ["w", "q", "b"]);
  // Only an agent that says it is on something can go quiet.
  assert.deepEqual(stale(T0 + 24 * 60 * MINUTE), ["w", "q", "b"]);
});

test("any word from an agent is a sign of life", () => {
  let s = office([agentState("w", "working", { agent: { id: "w", name: "W" } })], null, T0);
  const w = () => s.agents[0];
  assert.ok(isStale(w(), T0 + 20 * MINUTE));
  s = applyOfficeEvent(s, parseOfficeEvent(agentState("w", "working")), T0 + 20 * MINUTE);
  assert.ok(!isStale(w(), T0 + 30 * MINUTE));
  assert.ok(isStale(w(), T0 + 35 * MINUTE));
  // An ask or a piece of news that names it counts too.
  s = applyOfficeEvent(s, parseOfficeEvent({ ...news("Sigo"), agent: { id: "w" } }), T0 + 35 * MINUTE);
  assert.ok(!isStale(w(), T0 + 45 * MINUTE));
  s = applyOfficeEvent(s, parseOfficeEvent({ ...askOpen("q"), agent: { id: "w" } }), T0 + 50 * MINUTE);
  assert.ok(!isStale(w(), T0 + 60 * MINUTE));
  assert.equal(w().name, "W");
});

// ── What the island shows ─────────────────────────────────────────────────────

test("Liv: something waits, else an agent failed, else one works, else nothing", () => {
  const now = T0 + MINUTE;
  assert.equal(officeBotState(null, now), "idle");
  assert.equal(officeBotState(office([agentState("a", "idle"), agentState("b", "done"), agentState("c", "blocked")]), now), "idle");
  assert.equal(officeBotState(office([agentState("a", "idle"), agentState("b", "working")]), now), "working");
  assert.equal(officeBotState(office([agentState("a", "working"), agentState("b", "error")]), now), "error");
  assert.equal(officeBotState(office([agentState("a", "working"), agentState("b", "error"), askOpen("q")]), now), "approval");
  assert.equal(officeBotState(office([askOpen("q"), askClose("q"), agentState("a", "working")]), now + 2 * MINUTE), "working");
  // An agent gone quiet no longer counts as working — worked out from the clock it is asked with.
  const quiet = office([agentState("a", "working")], null, T0);
  assert.equal(officeBotState(quiet, T0 + 15 * MINUTE - 1), "working");
  assert.equal(officeBotState(quiet, T0 + 15 * MINUTE), "idle");
});

test("what the island does for each event, as the contract's table says", () => {
  const effect = (raw, state = null) => officeEffect(state, parseOfficeEvent(raw));
  assert.deepEqual(effect(askOpen("q")), { action: "open", badge: "approval", sound: "question" });
  assert.deepEqual(effect(agentState("a", "error")), { action: "peek", badge: "error", sound: "error" });
  assert.deepEqual(effect(news("Falló la subida", "error")), { action: "peek", badge: "error", sound: "error" });
  assert.deepEqual(effect(news("Vídeo 12 publicado", "success")), { action: "peek", badge: "finished", sound: "finish" });
  assert.deepEqual(effect(news("Queda poca cuota", "warning")), { action: "badge", badge: "approval", sound: null });
  // Everything else is taken in silently.
  for (const quiet of [
    news("Guion empezado", "info"), news("Guion empezado"), askClose("q"), { type: "reset" },
    ...["idle", "working", "waiting", "blocked", "done", "offline"].map((s) => agentState("a", s)),
  ]) {
    assert.equal(effect(quiet), null, JSON.stringify(quiet));
  }
});

test("only what is new alerts: an ask already waiting or a failure said again does not", () => {
  const s = office([askOpen("q1"), agentState("a", "error")]);
  const effect = (raw, state = s) => officeEffect(state, parseOfficeEvent(raw));
  assert.equal(effect(askOpen("q1", "¿Otra vez?")), null);
  assert.equal(effect(agentState("a", "error")), null);
  assert.ok(effect(askOpen("q2")));
  assert.ok(effect(agentState("b", "error")));
  // Back to work and failing again is a new failure; so is an ask opened again once closed.
  assert.ok(effect(agentState("a", "error"), office([agentState("a", "working")], s)));
  assert.ok(effect(askOpen("q1"), office([askClose("q1")], s)));
  // For another office nothing of this one counts.
  assert.ok(effect({ ...askOpen("q1"), office: "podcast" }));
});

test("the pill's badge: amber while something waits, else what happened since it was looked at", () => {
  assert.equal(officeBadge(null), null);
  let s = office([agentState("a", "working")]);
  assert.equal(officeBadge(s), null);
  s = office([news("Publicado", "success")], s);
  assert.equal(officeBadge(s), "finished");
  s = office([news("Queda poca cuota", "warning")], s);
  assert.equal(officeBadge(s), "approval");
  s = office([agentState("a", "error")], s);
  assert.equal(officeBadge(s), "error");
  // Looked at: nothing is new any more, and nothing else is forgotten.
  const seen = officeSeen(s);
  assert.equal(officeBadge(seen), null);
  assert.deepEqual({ ...seen, unseen: s.unseen }, s);
  assert.equal(officeSeen(seen), seen);
  assert.equal(officeSeen(null), null);
  // Something waiting keeps the amber badge, seen or not, until it is closed.
  s = officeSeen(office([askOpen("q")], seen));
  assert.equal(officeBadge(s), "approval");
  assert.equal(officeBadge(office([askClose("q")], s)), null);
  // A silent event leaves the badge as it was.
  assert.equal(officeBadge(office([news("Publicado", "success"), agentState("a", "idle"), news("Nota")], seen)), "finished");
});

// ── The card ──────────────────────────────────────────────────────────────────

test("no office and no address: a card with nothing to open", () => {
  assert.deepEqual(officeCard(null, "", T0), {
    name: null, agents: 0, waiting: 0, headline: { kind: "none" }, dots: [], more: 0,
    reviewUrl: null, officeUrl: null, jumpUrl: null,
  });
});

test("only an address in Settings: the card is a shortcut to it", () => {
  const card = officeCard(null, " http://localhost:3000 ", T0);
  assert.deepEqual(
    [card.headline, card.officeUrl, card.reviewUrl, card.jumpUrl],
    [{ kind: "none" }, "http://localhost:3000/", null, "http://localhost:3000/"],
  );
  // An address that is not one the island opens is no address at all.
  for (const bad of ["javascript:alert(1)", "file:///C:/x", "localhost:3000", "notaurl"]) {
    assert.equal(officeCard(null, bad, T0).officeUrl, null, bad);
  }
});

test("the office's own address comes before the one in Settings", () => {
  const s = office([{ ...agentState("a", "idle"), open_url: "https://oficina.example.com" }]);
  assert.equal(officeCard(s, "http://localhost:3000", T0).officeUrl, "https://oficina.example.com/");
  assert.equal(officeCard(office([agentState("a", "idle")]), "http://localhost:3000", T0).officeUrl, "http://localhost:3000/");
});

test("the headline: the latest ask, else the latest news, else the agent last heard from", () => {
  const dot = (name, state, summary = null) => ({ name, role: null, state, summary, stale: false });
  let s = office([agentState("a", "working", { summary: "Montando" }), agentState("b", "idle")]);
  assert.deepEqual(officeCard(s, "", T0 + 2 * MINUTE).headline, { kind: "agent", agent: dot("b", "idle") });
  s = office([agentState("a", "working")], s);
  assert.deepEqual(officeCard(s, "", T0 + 3 * MINUTE).headline, { kind: "agent", agent: dot("a", "working", "Montando") });

  s = office([news("Guion listo"), { ...news("Vídeo publicado", "success"), agent: { id: "a" } }], s);
  assert.deepEqual(officeCard(s, "", T0).headline, { kind: "news", title: "Vídeo publicado", by: "a" });

  s = office([askOpen("q1", "¿Uno?"), { ...askOpen("q2", "¿Dos?", { detail: "con detalle" }), agent: { id: "b" } }], s);
  assert.deepEqual(officeCard(s, "", T0).headline, { kind: "ask", title: "¿Dos?", detail: "con detalle", by: "b" });
  assert.equal(officeCard(s, "", T0).waiting, 2);
  // Closed, the one before it comes back; then the news again.
  s = office([askClose("q2")], s);
  assert.deepEqual(officeCard(s, "", T0).headline, { kind: "ask", title: "¿Uno?", detail: null, by: null });
  s = office([askClose("q1")], s);
  assert.equal(officeCard(s, "", T0).headline.kind, "news");
});

test("where the buttons go: the ask's own address, else the office's", () => {
  const OFFICE = "http://localhost:3000/";
  const urls = (s, settings = OFFICE) => {
    const card = officeCard(s, settings, T0);
    return [card.reviewUrl, card.officeUrl, card.jumpUrl];
  };
  let s = office([agentState("a", "working")]);
  assert.deepEqual(urls(s), [null, OFFICE, OFFICE], "nothing waits: no Review");

  s = office([news("Publicado", "success", { open_url: "https://youtu.be/abc" })], s);
  assert.deepEqual(urls(s), [null, OFFICE, "https://youtu.be/abc"], "↗ follows the headline");
  s = office([news("Sin enlace")], s);
  assert.deepEqual(urls(s), [null, OFFICE, OFFICE]);

  s = office([askOpen("q1", "¿Uno?", { open_url: "http://localhost:3000/videos/12/guion" })], s);
  assert.deepEqual(urls(s), ["http://localhost:3000/videos/12/guion", OFFICE, "http://localhost:3000/videos/12/guion"]);
  s = office([askOpen("q2", "¿Dos?")], s);
  assert.deepEqual(urls(s), [OFFICE, OFFICE, OFFICE], "the latest ask has no address of its own");
  // Nowhere to go at all: nothing is offered.
  assert.deepEqual(urls(s, ""), [null, null, null]);
  assert.deepEqual(urls(office([askClose("q2")], s), ""), ["http://localhost:3000/videos/12/guion", null, "http://localhost:3000/videos/12/guion"]);
});

test("the team: up to six dots in the order they appeared, the rest counted, the quiet ones marked", () => {
  const eight = office(Array.from({ length: 8 }, (_, i) => agentState(`a${i}`, i % 2 ? "working" : "idle", { summary: `s${i}` })), null, T0);
  const card = officeCard(eight, "", T0 + 18 * MINUTE);
  assert.equal(SHOWN_AGENTS, 6);
  assert.deepEqual([card.agents, card.dots.length, card.more], [8, 6, 2]);
  assert.deepEqual(card.dots.map((d) => [d.name, d.state, d.summary, d.stale]), [
    ["a0", "idle", "s0", false], ["a1", "working", "s1", true], ["a2", "idle", "s2", false],
    ["a3", "working", "s3", true], ["a4", "idle", "s4", false], ["a5", "working", "s5", false],
  ]);
  const three = officeCard(office([agentState("a", "idle"), agentState("b", "idle"), agentState("c", "idle")]), "", T0);
  assert.deepEqual([three.agents, three.dots.length, three.more], [3, 3, 0]);
});

test("nothing an office sends grows the state past its limits", () => {
  let s = null;
  const huge = "x".repeat(5000);
  for (let i = 0; i < 300; i++) {
    for (const raw of [
      { ...agentState(`agent-${i}`, "working", { summary: huge }), office_name: huge },
      askOpen(`ask-${i}`, huge, { detail: huge }),
      news(huge, "error"),
    ]) {
      s = applyOfficeEvent(s, parseOfficeEvent(raw), T0 + i);
    }
  }
  assert.deepEqual([s.agents.length, s.asks.length, s.news.length], [12, 20, 5]);
  assert.ok(JSON.stringify(s).length < 16_000, `${JSON.stringify(s).length} characters`);
});
