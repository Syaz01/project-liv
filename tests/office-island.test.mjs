// A virtual office's events → the island (src/island/office.ts) and its card
// (src/views/office.ts), driven through the real bridge: events come in the
// way Rust emits them, and what the island asks of Rust is read from the
// commands it invokes — for an office, only ever opening an address on a click.

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { calls, emit, sent } from "./tauri.mjs";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const { registerOfficeHandlers, officeSettingsChanged, openOfficeUrl, currentOfficeCard } = await import("../src/island/office.ts");
const { restoreAlertFocus } = await import("../src/island/hooks.ts");
const { buildOfficeCard } = await import("../src/views/office.ts");
const { h } = await import("../src/views/dom.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { Sound } = await import("../src/core/sound.ts");
const { setLanguage } = await import("../src/i18n/i18n.ts");

const OFFICE = "integration_office";
const CLAUDE = "integration_claude";

/** What the handler asked the island to do, in order. */
let asked;
/** Whether Liv comes out of the island when asked: not while it is parked off-screen. */
let popsOut;
const island = {
  alert: (view) => asked.push(`alert:${view}`),
  setView: (view) => asked.push(`setView:${view}`),
  reveal: () => asked.push("reveal"),
  // Liv pops out in a state's colours; a click on it opens `view`.
  peek: (look, view) => {
    asked.push(`peek:${look}>${view}`);
    return popsOut;
  },
};
registerOfficeHandlers(island);

/** The sounds played, in order. */
let played;

const office = (payload) => emit("office", payload);
const pill = () => State.tasks.find((t) => t.id === OFFICE);
const ids = () => State.tasks.map((t) => t.id);
const working = (id, extra = {}) => ({ type: "agent.state", agent: { id }, state: "working", ...extra });
const ask = (id, extra = {}) => ({ type: "ask.open", ask: { id, title: `¿${id}?`, ...extra } });

beforeEach((t) => {
  setLanguage("en");
  played = [];
  t.mock.method(Sound, "play", (name) => played.push(name));
  State.settings = { ...DEFAULT_SETTINGS };
  State.paused = false;
  office({ type: "reset" });
  asked = [];
  popsOut = true;
  calls.length = 0;
  State.tasks = [];
  State.focusId = null;
  State.mode = "hidden";
  State.view = "overview";
  State.pendingApproval = null;
  State.loadIntegrationTasks();
  restoreAlertFocus();
});

// ── The pill ──────────────────────────────────────────────────────────────────

test("the pill comes with the office's first event, next to the main one, under the office's name", () => {
  assert.equal(pill(), undefined);
  office(working("editora"));
  assert.deepEqual(ids().slice(0, 2), [CLAUDE, OFFICE]);
  assert.deepEqual([pill().name, pill().color, pill().state, pill().isIntegration], ["Office", "#FACC15", "working", true]);
  office({ ...working("ideas"), office_name: "Canal YouTube" });
  assert.equal(pill().name, "Canal YouTube");
  assert.equal(ids().filter((id) => id === OFFICE).length, 1);
  // Liv only listens: nothing was asked of Rust, and nothing moved or sounded.
  assert.deepEqual(calls, []);
  assert.deepEqual([asked, played], [[], []]);
});

test("the pill's name follows the language until the office gives its own", () => {
  office(working("editora"));
  setLanguage("es");
  State.notify();
  assert.equal(pill().name, "Oficina");
  office({ ...working("editora"), office_name: "Mi canal" });
  assert.equal(pill().name, "Mi canal");
});

test("what is not an event leaves no trace", () => {
  for (const raw of [null, "reset", [], {}, { type: "agent.state", agent: { id: "Bad Id" }, state: "working" }, { type: "nope" }, { v: 2, ...working("a") }]) {
    office(raw);
  }
  assert.equal(pill(), undefined);
  assert.deepEqual([asked, played, calls], [[], [], []]);
});

test("reset takes the pill away, unless it is declared in Settings", () => {
  office(working("editora"));
  State.setFocus(OFFICE);
  office({ type: "reset" });
  assert.equal(pill(), undefined);
  assert.equal(State.focusId, CLAUDE);

  State.settings.activeIntegrations = [OFFICE];
  State.loadIntegrationTasks();
  assert.deepEqual([pill().name, pill().state], ["Office", "idle"], "declared: there before any event");
  office({ ...working("editora"), office_name: "Canal" });
  office(ask("guion"));
  office({ type: "reset" });
  assert.deepEqual([pill().name, pill().state, pill().pillBadge ?? null], ["Office", "idle", null]);
  assert.equal(currentOfficeCard().headline.kind, "none");
});

test("a change of settings keeps the pill of an office that is there, declared or not", () => {
  office({ type: "agent.state", agent: { id: "editora" }, state: "idle" });
  assert.equal(pill().state, "idle");
  State.setFocus(OFFICE);
  State.settings = { ...State.settings, soundVolume: 0.05 };
  State.loadIntegrationTasks();
  officeSettingsChanged();
  assert.ok(pill());
  assert.equal(State.focusId, OFFICE);
  // Once the office is gone, so is a pill nobody declared.
  office({ type: "reset" });
  State.loadIntegrationTasks();
  assert.equal(pill(), undefined);
});

test("switched off, an office is not listened to, and one that was there is forgotten", () => {
  State.settings.officeEnabled = false;
  office(working("editora"));
  office(ask("guion"));
  assert.equal(pill(), undefined);
  assert.deepEqual([asked, played], [[], []]);

  State.settings.officeEnabled = true;
  office(working("editora"));
  assert.ok(pill());
  State.settings.officeEnabled = false;
  officeSettingsChanged();
  assert.equal(pill(), undefined);
  assert.equal(currentOfficeCard().agents, 0);
});

// ── Liv and the badge ─────────────────────────────────────────────────────────

test("the pill's state is the office's: waiting for you, failed, at work, nothing", () => {
  office(working("editora"));
  assert.equal(pill().state, "working");
  office({ type: "agent.state", agent: { id: "ideas" }, state: "error" });
  assert.equal(pill().state, "error");
  office(ask("guion"));
  assert.equal(pill().state, "approval");
  office({ type: "ask.close", ask: { id: "guion" } });
  assert.equal(pill().state, "error");
  office({ type: "agent.state", agent: { id: "ideas" }, state: "idle" });
  assert.equal(pill().state, "working");
  office({ type: "agent.state", agent: { id: "editora" }, state: "done" });
  assert.equal(pill().state, "idle");
});

test("an agent gone quiet stops counting as working the next time anything moves — no timer", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
  office(working("editora"));
  assert.equal(pill().state, "working");
  t.mock.timers.tick(14 * 60_000);
  State.notify();
  assert.equal(pill().state, "working");
  // Fifteen minutes on, nothing has run by itself…
  t.mock.timers.tick(60_000);
  assert.equal(pill().state, "working");
  // …and the first thing that redraws the island sees it.
  State.notify();
  assert.equal(pill().state, "idle");
  assert.equal(currentOfficeCard().dots[0].stale, true);
  office(working("editora"));
  assert.equal(pill().state, "working");
});

test("the badge shows on the office's pill while another pill is in front", () => {
  office(working("editora"));
  assert.equal(State.focusId, CLAUDE);
  office({ type: "news", news: { title: "Vídeo 12 publicado", level: "success" } });
  assert.equal(pill().pillBadge, "finished");
  office({ type: "news", news: { title: "Queda poca cuota", level: "warning" } });
  assert.equal(pill().pillBadge, "approval");
  office({ type: "agent.state", agent: { id: "editora" }, state: "error" });
  assert.equal(pill().pillBadge, "error");
  // Looked at, it goes — and does not come back when another pill takes the front.
  State.setFocus(OFFICE);
  assert.equal(pill().pillBadge ?? null, null);
  State.setFocus(CLAUDE);
  assert.equal(pill().pillBadge ?? null, null);
  // Something waiting for you is different: amber for as long as it waits.
  office(ask("guion"));
  State.setFocus(OFFICE);
  assert.equal(pill().pillBadge ?? null, null);
  State.setFocus(CLAUDE);
  assert.equal(pill().pillBadge, "approval");
  office({ type: "ask.close", ask: { id: "guion" } });
  assert.equal(pill().pillBadge ?? null, null);
});

// ── Alerts: the same rules as an agent's ──────────────────────────────────────

test("an ask opens the island on the office's card when its pill is in front", () => {
  office(working("editora"));
  State.setFocus(OFFICE);
  office(ask("guion"));
  assert.deepEqual([asked, played], [["alert:overview"], ["question"]]);
  // Already open on a card that only shows how things stand: the overview is
  // brought up, nothing reopens.
  State.mode = "expanded";
  State.view = "finished";
  office(ask("miniatura"));
  assert.deepEqual(asked, ["alert:overview", "setView:overview"]);
  // The same ask sent again is no news.
  office(ask("guion"));
  assert.deepEqual([asked.length, played], [2, ["question", "question"]]);
});

test("an ask opens the island from another pill too, whatever the alerts setting", () => {
  office(working("editora"));
  assert.equal(State.settings.alertsFromAllPills, false);
  office(ask("guion"));
  assert.deepEqual([asked, played], [["alert:overview"], ["question"]]);
  assert.equal(State.focusId, OFFICE, "its pill borrows the front");
  // The island closes: the pill you were on comes back, and the ask still waits.
  restoreAlertFocus();
  assert.deepEqual([State.focusId, pill().pillBadge], [CLAUDE, "approval"]);
});

test("an ask never covers what is being typed, from the pill in front either", () => {
  office(working("editora"));
  let n = 0;
  for (const focus of [OFFICE, CLAUDE]) {
    for (const view of ["prompt", "launch", "settings"]) {
      State.setFocus(focus);
      State.mode = "expanded";
      State.view = view;
      asked = [];
      played = [];
      office(ask(`guion-${++n}`));
      assert.deepEqual(asked, [], `${focus} ${view}`);
      // It still sounds, and waits on the office's pill.
      assert.deepEqual(played, ["question"], `${focus} ${view}`);
      assert.equal(State.focusId, focus, "nobody's pill is taken from the front");
      assert.equal(pill().state, "approval");
    }
  }
  assert.equal(pill().pillBadge, "approval", "behind another pill, its badge says so");
});

test("an ask never covers a card that waits for an answer", () => {
  office(working("editora"));
  State.setFocus(OFFICE);
  State.settings.alertsFromAllPills = true;
  State.pendingApproval = { requestId: "r1", sessionId: "s", pillId: CLAUDE, tool: "Bash", command: "Bash · ls" };
  office(ask("guion"));
  assert.deepEqual(asked, []);
  assert.equal(State.pendingApproval.requestId, "r1");
  // And no office event ever answers it.
  assert.deepEqual(sent("approval_decision"), []);
  assert.deepEqual(sent("approval_answer"), []);
  assert.deepEqual(sent("approval_decline"), []);
  assert.deepEqual(sent("approval_ack"), []);
});

test("a failure and a success make the hidden island peek; a warning and the rest do not move it", () => {
  office(working("editora"));
  office({ type: "agent.state", agent: { id: "editora" }, state: "error" });
  assert.deepEqual([asked, played], [["reveal"], ["error"]]);
  office({ type: "news", news: { title: "Falló la subida", level: "error" } });
  office({ type: "news", news: { title: "Vídeo 12 publicado", level: "success" } });
  assert.deepEqual([asked, played], [["reveal", "reveal", "reveal"], ["error", "error", "finish"]]);

  office({ type: "news", news: { title: "Queda poca cuota", level: "warning" } });
  office({ type: "news", news: { title: "Guion empezado" } });
  office({ type: "agent.state", agent: { id: "editora" }, state: "error" });
  office(working("ideas"));
  office({ type: "ask.close", ask: { id: "nope" } });
  assert.deepEqual([asked.length, played.length], [3, 3]);

  // Already on screen, compact or open, nothing moves: only the sound and the badge.
  State.mode = "compact";
  office({ type: "news", news: { title: "Otra", level: "success" } });
  State.mode = "expanded";
  office({ type: "news", news: { title: "Y otra", level: "error" } });
  assert.deepEqual([asked.length, played.slice(3)], [3, ["finish", "error"]]);
});

test("with the office's pill in front, a failure and a success make Liv pop out in their colours", () => {
  office(working("editora"));
  State.setFocus(OFFICE);
  office({ type: "agent.state", agent: { id: "editora" }, state: "error" });
  office({ type: "news", news: { title: "Falló la subida", level: "error" } });
  office({ type: "news", news: { title: "Vídeo 12 publicado", level: "success" } });
  // A click on the pocket opens the office's own card: the overview.
  assert.deepEqual(asked, ["peek:error>overview", "peek:error>overview", "peek:finished>overview"]);
  assert.deepEqual(played, ["error", "error", "finish"]);

  // From the compact island too, and again while Liv is already out.
  for (const mode of ["compact", "peek"]) {
    State.mode = mode;
    asked = [];
    office({ type: "news", news: { title: "Otra", level: "success" } });
    assert.deepEqual(asked, ["peek:finished>overview"], mode);
  }
  // On the open island nothing moves: its card is already there.
  State.mode = "expanded";
  asked = [];
  office({ type: "news", news: { title: "Y otra", level: "error" } });
  assert.deepEqual(asked, []);
  // A warning never moves the island.
  State.mode = "hidden";
  office({ type: "news", news: { title: "Queda poca cuota", level: "warning" } });
  assert.deepEqual(asked, []);
});

test("from another pill Liv pops out for the office only with alerts from all pills on, and the front comes back", () => {
  office(working("editora"));
  assert.equal(State.focusId, CLAUDE);
  office({ type: "news", news: { title: "Vídeo 12 publicado", level: "success" } });
  assert.deepEqual(asked, ["reveal"], "off: the compact island shows itself, as it always did");
  assert.equal(State.focusId, CLAUDE);
  assert.equal(pill().pillBadge, "finished");

  State.settings.alertsFromAllPills = true;
  asked = [];
  office({ type: "news", news: { title: "Vídeo 13 publicado", level: "success" } });
  assert.deepEqual(asked, ["peek:finished>overview"]);
  assert.equal(State.focusId, OFFICE, "its pill borrows the front while Liv is out");
  // Liv goes back in (island.ts): the pill you were on comes back.
  restoreAlertFocus();
  assert.equal(State.focusId, CLAUDE);
});

test("Liv never pops out for the office over a card that waits, and where it cannot come out nothing keeps the front", () => {
  office(working("editora"));
  State.settings.alertsFromAllPills = true;
  State.pendingApproval = { requestId: "r1", sessionId: "s", pillId: CLAUDE, tool: "Bash", command: "Bash · ls" };
  State.mode = "compact";
  office({ type: "news", news: { title: "Falló", level: "error" } });
  assert.deepEqual(asked, [], "the folded card keeps the compact island");
  State.pendingApproval = null;

  // Parked off-screen: Liv stays in, the island does as it did, and the pill you were on stays in front.
  State.mode = "hidden";
  popsOut = false;
  office({ type: "news", news: { title: "Falló otra vez", level: "error" } });
  assert.deepEqual(asked, ["peek:error>overview", "reveal"]);
  assert.equal(State.focusId, CLAUDE);
});

test("a paused island takes the events in and stays quiet", () => {
  State.paused = true;
  office(working("editora"));
  State.setFocus(OFFICE);
  office(ask("guion"));
  office({ type: "news", news: { title: "Falló", level: "error" } });
  assert.deepEqual([asked, played], [[], []]);
  assert.deepEqual([pill().state, currentOfficeCard().waiting], ["approval", 1]);
});

// ── Opening an address ────────────────────────────────────────────────────────

test("an address is opened only when it is http or https, checked again at the click", () => {
  for (const bad of [null, "", "javascript:alert(1)", "file:///C:/Windows/System32/calc.exe", "ms-settings:privacy", "calc.exe", "localhost:3000"]) {
    openOfficeUrl(bad);
  }
  assert.deepEqual(sent("open_url"), []);
  openOfficeUrl("http://localhost:3000/videos/12");
  assert.deepEqual(sent("open_url"), [{ url: "http://localhost:3000/videos/12" }]);
});

// ── The card ──────────────────────────────────────────────────────────────────

/** How often the card asked for the office's box in Settings. */
let settingsAsked = 0;

/** The card as views.ts builds it, with stand-ins for its shared pieces. */
function card() {
  const built = buildOfficeCard({
    stack: (_left, _right, ...children) => h("div", { class: "stack" }, ...children),
    btn: (label, kind, onClick) => h("button", { class: `btn ${kind}`, onclick: onClick }, h("span", { text: label })),
    openSettings: () => settingsAsked++,
  });
  built.sync();
  const [who, title, agents, actions] = built.el.children;
  return {
    ...built, who, title, agents, actions,
    buttons: () => actions.find("button").map((b) => [b.className, b.textContent]),
    dots: () => agents.find(".mini"),
  };
}

test("with only an address in Settings the card is a shortcut", () => {
  State.settings.activeIntegrations = [OFFICE];
  State.settings.officeUrl = "http://localhost:3000";
  State.loadIntegrationTasks();
  const c = card();
  assert.equal(c.who.textContent, "OfficeIntegration");
  assert.equal(c.title.textContent, "No news from the office yet.");
  assert.equal(c.title.className, "title question-text");
  assert.equal(c.agents.style.display, "none");
  assert.deepEqual(c.buttons(), [["btn primary", "Open office"]]);
  c.actions.find("button")[0].fire("click");
  assert.deepEqual(sent("open_url"), [{ url: "http://localhost:3000/" }]);
});

test("without any address the card says where to set one, and a click on it opens Settings there", () => {
  office(working("editora", { summary: "Montando" }));
  const c = card();
  // No button of the office's: only the way to its box in Settings, drawn as the line it was.
  assert.deepEqual(c.buttons(), [["link-btn sub", "Set its address in Settings."]]);
  assert.equal(c.actions.textContent, "Set its address in Settings.");
  settingsAsked = 0;
  c.actions.children[0].fire("click");
  assert.equal(settingsAsked, 1);
  assert.deepEqual(sent("open_url"), [], "nothing of the office's is opened");
});

test("the team at work: its size, the agent last heard from, one dot each with its story", () => {
  office({ ...working("ideas", { agent: { id: "ideas", name: "Ideas", role: "Guion" }, summary: "Buscando temas" }), office_name: "Canal YouTube", open_url: "http://localhost:3000" });
  office({ type: "agent.state", agent: { id: "editora", name: "Editora" }, state: "blocked" });
  const c = card();
  assert.deepEqual(c.who.children.map((x) => x.textContent), ["", "Canal YouTube", "2 agents"]);
  assert.equal(c.title.textContent, "Editora · held up");
  assert.equal(c.title.className, "title one-line");
  assert.deepEqual(c.dots().map((d) => d.title), ["Ideas — Guion — at work — Buscando temas", "Editora — held up"]);
  assert.deepEqual(c.buttons(), [["btn primary", "Open office"]]);

  office({ type: "agent.state", agent: { id: "ideas" }, state: "working", summary: "Tres temas listos" });
  c.sync();
  assert.equal(c.title.textContent, "Ideas · Tres temas listos");
  setLanguage("es");
  c.sync();
  assert.deepEqual([c.who.children[2].textContent, c.dots()[1].title], ["2 agentes", "Editora — bloqueado"]);
  assert.deepEqual(c.buttons(), [["btn primary", "Abrir oficina"]]);
});

test("more than six agents: six dots and the rest counted; a quiet one is dimmed and says so", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  office(working("a0"));
  t.mock.timers.tick(16 * 60_000);
  for (let i = 1; i < 9; i++) office(working(`a${i}`));
  const c = card();
  assert.equal(c.dots().length, 6);
  assert.equal(c.agents.find(".more")[0].textContent, "+3");
  assert.deepEqual(c.dots().map((d) => d.className), ["mini stale", "mini", "mini", "mini", "mini", "mini"]);
  assert.equal(c.dots()[0].title, "a0 — no signal");
  assert.equal(c.who.children[2].textContent, "9 agents");
});

test("while something waits the card is about it: the count, the question whole, Review first", () => {
  office({ ...working("guionista", { agent: { id: "guionista", name: "Guionista" } }), open_url: "http://localhost:3000" });
  const c = card();
  assert.equal(c.dots().length, 1);
  office({ ...ask("guion-12", { detail: "8 minutos", open_url: "http://localhost:3000/videos/12/guion" }), agent: { id: "guionista" } });
  c.sync();
  assert.deepEqual(c.who.children.map((x) => [x.className, x.textContent]).slice(1), [
    ["n", "Office"], ["office-waiting", "1 waiting for you"],
  ]);
  assert.equal(c.title.textContent, "¿guion-12?");
  assert.equal(c.title.title, "Guionista — ¿guion-12? — 8 minutos");
  assert.equal(c.title.className, "title question-text");
  assert.equal(c.agents.style.display, "none");
  assert.deepEqual(c.buttons(), [["btn primary", "Review"], ["btn secondary", "Open office"]]);

  const [review, open] = c.actions.find("button");
  review.fire("click");
  open.fire("click");
  assert.deepEqual(sent("open_url"), [{ url: "http://localhost:3000/videos/12/guion" }, { url: "http://localhost:3000/" }]);

  // A second ask without an address of its own: Review goes to the office.
  office(ask("miniatura"));
  c.sync();
  assert.equal(c.who.children[2].textContent, "2 waiting for you");
  calls.length = 0;
  c.actions.find("button")[0].fire("click");
  assert.deepEqual(sent("open_url"), [{ url: "http://localhost:3000/" }]);

  // Both closed: the team is back, and Open office is the one button.
  office({ type: "ask.close", ask: { id: "guion-12" } });
  office({ type: "ask.close", ask: { id: "miniatura" } });
  c.sync();
  assert.equal(c.agents.style.display, "");
  assert.deepEqual(c.buttons(), [["btn primary", "Open office"]]);
});

test("the buttons are not rebuilt while what they open stays the same", () => {
  office({ ...working("editora"), open_url: "http://localhost:3000" });
  const c = card();
  const button = c.actions.find("button")[0];
  office(working("ideas", { summary: "Buscando temas" }));
  office({ type: "news", news: { title: "Guion listo" } });
  c.sync();
  assert.equal(c.title.textContent, "Guion listo");
  assert.equal(c.actions.find("button")[0], button);
});

test("whatever an office writes is shown as text and opens nothing by itself", () => {
  const markup = `<img src=x onerror="alert(1)">`;
  office({
    type: "agent.state", office_name: markup, open_url: "javascript:alert(1)",
    agent: { id: "a", name: markup, role: "\"><script>x</script>" }, state: "working", summary: markup,
  });
  office({ type: "ask.open", ask: { id: markup, title: markup, detail: markup, open_url: "file:///C:/Windows/System32/calc.exe" } });
  office({ type: "news", news: { title: markup, level: "error", open_url: "ms-settings:privacy" } });
  // The fake DOM throws on innerHTML: building the card at all proves it is never used.
  const c = card();
  assert.equal(c.who.find(".n")[0].textContent, markup);
  assert.equal(c.title.textContent, markup);
  assert.equal(c.el.find("img").length + c.el.find("script").length, 0);
  // No address worth opening came with any of it: no button of the office's, and nothing was opened.
  assert.deepEqual(c.buttons(), [["link-btn sub", "Set its address in Settings."]]);
  const now = currentOfficeCard();
  assert.deepEqual([now.reviewUrl, now.officeUrl, now.jumpUrl], [null, null, null]);
  assert.deepEqual(sent("open_url"), []);
  assert.equal(pill().name, markup);
});
