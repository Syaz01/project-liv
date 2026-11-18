// The pill catalog (src/core/pills.ts) and the declared pills in the app state.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAIN_PILL, MAX_DECLARED, PILL_CATALOG, PILL_CATEGORIES, chooseMainPill,
  mainPillChoices, orderPills, pillDefinition, sanitizeDeclared, sessionSubtitle,
  toggleDeclared,
} from "../src/core/pills.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { installFakeDom } from "./fakedom.mjs";
import { renderIntegrationCard } from "../src/views/integrations.ts";

installFakeDom();

// ── The catalog itself ────────────────────────────────────────────────────────

test("the catalog is Liv's pills, each with its ID, name, colour, category and subtitle", () => {
  // An ID is a contract value (settings, hook routing): it never changes once
  // shipped. A colour or a subtitle that drifts is a visible bug.
  assert.deepEqual(PILL_CATALOG.map((p) => [p.id, p.name, p.color, p.category, p.subtitle]), [
    ["integration_claude", "Claude Code", "#F5F6F8", "workspace", "Integration"],
    ["agent_cursor", "Cursor", "#C0C4CC", "workspace", "Integration"],
    ["agent_antigravity", "Antigravity", "#E879F9", "workspace", "Integration"],
    ["agent_codex", "Codex", "#2DD4BF", "workspace", "Integration"],
    ["agent_gemini", "Gemini CLI", "#8AB4F8", "agent", "Agent"],
    ["agent_copilot", "Copilot CLI", "#818CF8", "agent", "Agent"],
    ["agent_muse", "Muse Code", "#38BDF8", "agent", "Agent"],
    ["agent_opencode", "OpenCode", "#4ADE80", "agent", "Agent"],
    ["agent_amp", "Amp", "#F59E0B", "agent", "Agent"],
    ["agent_hermes", "Hermes", "#C084FC", "agent", "Agent"],
    ["agent_claude-desktop", "Claude Desktop", "#D97757", "agent", "Agent"],
    ["ai_anthropic", "Anthropic", "#E07950", "ai", "Chat"],
    ["ai_google", "Google AI", "#4285F4", "ai", "Chat"],
    ["ai_openai", "OpenAI", "#10A37F", "ai", "Chat"],
    ["ai_ollama", "Ollama", "#FACC15", "ai", "Chat"],
    ["ai_lmstudio", "LM Studio", "#A3E635", "ai", "Chat"],
    ["integration_office", "Office", "#FACC15", "service", "Integration"],
    ["integration_resend", "Resend", "#22C55E", "service", "Integration"],
    ["integration_n8n", "n8n", "#F29B38", "service", "Integration"],
    ["integration_vercel", "Vercel", "#7C5CFF", "service", "Integration"],
    ["integration_github", "GitHub", "#F4505E", "service", "Integration"],
    ["integration_gitlab", "GitLab", "#FC6D26", "service", "Integration"],
    ["integration_gitea", "Gitea", "#609926", "service", "Integration"],
    ["integration_notion", "Notion", "#8C8C8C", "service", "Integration"],
    ["integration_calcom", "Cal.com", "#C9956A", "service", "Integration"],
    ["integration_stripe", "Stripe", "#0570DE", "service", "Integration"],
    ["integration_spotify", "Music", "#1DB954", "service", "Integration"],
  ]);
  assert.deepEqual(PILL_CATEGORIES.map((c) => c.title), [
    "Where you code", "Agents", "AI for the chat", "Services",
  ]);
});

test("every pill is well formed: a unique ID, a colour, a known category, a way to connect", () => {
  const ids = PILL_CATALOG.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  const categories = PILL_CATEGORIES.map((c) => c.id);
  for (const p of PILL_CATALOG) {
    assert.match(p.id, /^(integration|agent|ai)_[a-z0-9-]+$/, p.id);
    assert.match(p.color, /^#[0-9A-F]{6}$/, p.id);
    assert.ok(categories.includes(p.category), p.id);
    assert.ok(p.name && p.subtitle, p.id);
    assert.ok(["claudeCode", "n8n", "agent"].includes(p.source), p.id);
    assert.ok(["hooks", "key", "server", "none"].includes(p.connect.kind), p.id);
    assert.equal(pillDefinition(p.id), p);
  }
  // The catalog is drawn section by section: its pills come grouped, in the sections' order.
  const order = PILL_CATALOG.map((p) => categories.indexOf(p.category));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(pillDefinition("integration_music"), undefined, "not a pill of this catalog");
});

test("each pill is connected by what is behind it: hooks, a key, a model server, or nothing", () => {
  const by = (kind) => PILL_CATALOG.filter((p) => p.connect.kind === kind).map((p) => p.id);
  assert.deepEqual(by("hooks"), [
    "integration_claude", "agent_cursor", "agent_antigravity", "agent_codex", "agent_gemini", "agent_copilot",
    "agent_muse", "agent_opencode", "agent_amp", "agent_hermes",
  ]);
  // The local servers are connected through Settings → Local models, not a key.
  assert.deepEqual(by("server"), ["ai_ollama", "ai_lmstudio"]);
  assert.deepEqual(pillDefinition("ai_ollama").connect, { kind: "server", field: "ollamaUrl" });
  assert.deepEqual(pillDefinition("ai_lmstudio").connect, { kind: "server", field: "lmstudioUrl" });
  // Nothing to set up: Claude Desktop is tagged by the relay, the office sends
  // its own events, Spotify is read from the system.
  assert.deepEqual(by("none"), ["agent_claude-desktop", "integration_office", "integration_spotify"]);
  // A key each, under a name of its own.
  const keys = PILL_CATALOG.filter((p) => p.connect.kind === "key").map((p) => p.connect.key);
  assert.equal(keys.length, PILL_CATALOG.length - 15);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(pillDefinition("ai_google").connect.key, "google-api-key");
  assert.equal(pillDefinition("integration_gitea").connect.key, "gitea-token");
});

test("the virtual office is a service with nothing to set up, first among the services", () => {
  assert.deepEqual(
    pillDefinition("integration_office"),
    { id: "integration_office", name: "Office", color: "#FACC15", category: "service",
      subtitle: "Integration", source: "n8n", connect: { kind: "none" } },
  );
  assert.equal(PILL_CATALOG.find((p) => p.category === "service").id, "integration_office");
  assert.ok(!mainPillChoices().some((p) => p.id === "integration_office"));
});

test("the office is declared like any other pill: one of at most four, in catalog order", () => {
  const d = { mainPill: "integration_claude", activeIntegrations: ["integration_github", "integration_office"] };
  assert.deepEqual(sanitizeDeclared(d).activeIntegrations, ["integration_github", "integration_office"]);
  assert.deepEqual(toggleDeclared(d, "integration_office"), ["integration_github"]);
  const full = { mainPill: "integration_claude", activeIntegrations: ["agent_gemini", "ai_openai", "integration_n8n", "integration_github"] };
  assert.equal(toggleDeclared(full, "integration_office"), null, "a fifth pill is never added");
  // Before the other services, after the agents and the chat providers.
  const order = orderPills(
    [{ id: "integration_github" }, { id: "integration_office" }, { id: "ai_openai" }, { id: "integration_claude" }],
    "integration_claude",
  ).map((t) => t.id);
  assert.deepEqual(order, ["integration_claude", "ai_openai", "integration_office", "integration_github"]);
});

test("a pill's source follows its kind: Claude Code's own, an agent's, or an integration's", () => {
  assert.equal(pillDefinition("integration_claude").source, "claudeCode");
  for (const p of PILL_CATALOG) {
    if (p.id === "integration_claude") continue;
    assert.equal(p.source, p.id.startsWith("agent_") ? "agent" : "n8n", p.id);
  }
});

test("the main pill is a workspace tool, Claude Code unless another is picked", () => {
  assert.deepEqual(mainPillChoices().map((p) => p.id), [
    "integration_claude", "agent_cursor", "agent_antigravity", "agent_codex",
  ]);
  assert.equal(DEFAULT_MAIN_PILL, "integration_claude");
  assert.equal(MAX_DECLARED, 4);
});

test("a live session names its tool next to the project", () => {
  assert.equal(sessionSubtitle("integration_claude"), "Claude Code");
  assert.equal(sessionSubtitle("agent_cursor"), "Cursor");
  assert.equal(sessionSubtitle("agent_claude-desktop"), "Claude Desktop");
  assert.equal(sessionSubtitle("agent_gemini"), "Agent");
  assert.equal(sessionSubtitle("agent_whatever"), "Agent");
});

// ── Declaring pills ──────────────────────────────────────────────────────────

test("a declaration from an older or edited settings file is made usable", () => {
  assert.deepEqual(
    sanitizeDeclared({ mainPill: "integration_stripe", activeIntegrations: ["integration_claude", "x"] }),
    { mainPill: "integration_claude", activeIntegrations: [] },
  );
  assert.deepEqual(
    sanitizeDeclared({ mainPill: "agent_cursor", activeIntegrations: ["agent_cursor", "integration_n8n", "integration_n8n", "integration_music"] }),
    { mainPill: "agent_cursor", activeIntegrations: ["integration_n8n"] },
  );
  // No mainPill at all: a settings.json from before this version.
  assert.deepEqual(
    sanitizeDeclared({ activeIntegrations: ["integration_github"] }),
    { mainPill: "integration_claude", activeIntegrations: ["integration_github"] },
  );
  assert.equal(sanitizeDeclared({ mainPill: "agent_claude-desktop", activeIntegrations: [] }).mainPill,
    "integration_claude");
});

test("up to four pills next to the main one, never the main one itself", () => {
  const d = {
    mainPill: "integration_claude",
    activeIntegrations: ["integration_n8n", "integration_github", "integration_stripe"],
  };
  const four = toggleDeclared(d, "agent_gemini");
  assert.equal(four.length, MAX_DECLARED);
  assert.equal(toggleDeclared({ ...d, activeIntegrations: four }, "ai_anthropic"), null);
  assert.equal(toggleDeclared(d, "integration_claude"), null);
  assert.equal(toggleDeclared(d, "integration_music"), null, "a pill the catalog does not have");
  assert.deepEqual(toggleDeclared(d, "integration_github"), ["integration_n8n", "integration_stripe"]);
  // Every pill of the catalog but the main one can be declared.
  for (const p of PILL_CATALOG) {
    if (p.id === d.mainPill || d.activeIntegrations.includes(p.id)) continue;
    assert.ok(toggleDeclared(d, p.id).includes(p.id), p.id);
  }
});

test("picking a main pill takes it out of the declared ones, and only workspace tools qualify", () => {
  const d = { mainPill: "integration_claude", activeIntegrations: ["agent_cursor", "integration_n8n"] };
  assert.deepEqual(chooseMainPill(d, "agent_cursor"), {
    mainPill: "agent_cursor", activeIntegrations: ["integration_n8n"],
  });
  assert.equal(chooseMainPill(d, "integration_n8n"), null);
  assert.equal(chooseMainPill(d, "agent_gemini"), null);
});

test("pills are ordered main first, then other agents, then the catalog's order", () => {
  const ids = (list) => list.map((t) => t.id);
  const tasks = ["integration_stripe", "agent_mine", "integration_n8n", "agent_cursor", "integration_claude", "agent_gemini"]
    .map((id) => ({ id }));
  assert.deepEqual(ids(orderPills(tasks, "integration_claude")), [
    "integration_claude", "agent_mine", "agent_cursor", "agent_gemini", "integration_n8n", "integration_stripe",
  ]);
  assert.deepEqual(ids(orderPills(tasks, "agent_cursor")).slice(0, 3), [
    "agent_cursor", "agent_mine", "integration_claude",
  ]);
});

// ── In the app state ─────────────────────────────────────────────────────────

beforeEach(() => {
  State.tasks = [];
  State.focusId = null;
  State.settings = { ...DEFAULT_SETTINGS };
});

const ids = () => State.tasks.map((t) => t.id);

test("the main pill always loads, the declared ones join it, and focus starts on it", () => {
  State.settings.mainPill = "agent_cursor";
  State.settings.activeIntegrations = ["integration_github", "agent_gemini"];
  State.loadIntegrationTasks();
  assert.deepEqual(ids(), ["agent_cursor", "agent_gemini", "integration_github"]);
  assert.equal(State.focusId, "agent_cursor");
  assert.equal(State.tasks[1].name, "Gemini CLI");
  assert.equal(State.tasks[1].color, "#8AB4F8");
});

test("a fresh install shows the main pill alone: no service is declared for the user", () => {
  assert.deepEqual(DEFAULT_SETTINGS.activeIntegrations, []);
  State.loadIntegrationTasks();
  assert.deepEqual(ids(), ["integration_claude"]);
  assert.equal(State.focusId, "integration_claude");
  assert.deepEqual(State.otherTasks, []);
});

test("an old settings file gets Claude Code as its main pill and keeps its integrations", () => {
  // What every install declared before: Resend, n8n, Vercel and GitHub.
  const declared = ["integration_resend", "integration_n8n", "integration_vercel", "integration_github"];
  State.settings = { ...DEFAULT_SETTINGS, mainPill: undefined, activeIntegrations: declared };
  State.loadIntegrationTasks();
  assert.deepEqual(ids(), ["integration_claude", ...declared]);
  assert.equal(State.settings.mainPill, "integration_claude");
  assert.equal(State.tasks[0].name, "Claude Code");
});

test("switching the main pill frees its slot and the old main pill goes when idle", () => {
  State.loadIntegrationTasks();
  State.settings.mainPill = "agent_codex";
  State.loadIntegrationTasks();
  assert.equal(ids()[0], "agent_codex");
  assert.ok(!ids().includes("integration_claude"));
  assert.equal(State.focusId, "agent_codex");
});

test("a pill in the middle of a session stays until the session ends", () => {
  State.loadIntegrationTasks();
  State.tasks[0].state = "working";
  State.settings.mainPill = "agent_cursor";
  State.loadIntegrationTasks();
  assert.ok(ids().includes("integration_claude"));
  State.removeTask("integration_claude");
  assert.ok(!ids().includes("integration_claude"));
});

test("the end of a session puts a kept pill back as it was, and removes any other", () => {
  State.settings.activeIntegrations = ["agent_gemini"];
  State.loadIntegrationTasks();
  const gemini = State.tasks.find((t) => t.id === "agent_gemini");
  Object.assign(gemini, { name: "proj", state: "finished", steps: ["a"], pillBadge: "finished" });
  State.removeTask("agent_gemini");
  assert.deepEqual(
    [gemini.name, gemini.state, gemini.steps, gemini.pillBadge],
    ["Gemini CLI", "idle", [], null],
  );
  State.upsertExternalAgent("agent_mine", "mine", "#22C55E");
  State.setFocus("agent_mine");
  State.removeTask("agent_mine");
  assert.ok(!ids().includes("agent_mine"));
  assert.equal(State.focusId, "integration_claude");
});

test("a Claude Code session gets its pill even when it is not loaded", () => {
  State.settings.mainPill = "agent_codex";
  State.loadIntegrationTasks();
  const t = State.upsertWorkspacePill("integration_claude", "proj", "/p");
  assert.equal(ids()[1], "integration_claude");
  assert.equal(t.name, "proj");
  assert.equal(t.sessionCwd, "/p");
  assert.equal(State.upsertWorkspacePill("not_a_pill", "x", ""), null);
});

test("a pill undeclared in Settings goes, and the focus it had goes back to the main pill", () => {
  State.settings.activeIntegrations = ["integration_n8n", "agent_gemini"];
  State.loadIntegrationTasks();
  State.setFocus("agent_gemini");
  State.settings.activeIntegrations = toggleDeclared(State.settings, "agent_gemini");
  State.loadIntegrationTasks();
  assert.deepEqual(ids(), ["integration_claude", "integration_n8n"]);
  assert.equal(State.focusId, "integration_claude");
});

test("the Claude Code idle card keeps the agent title when the task has a project name", () => {
  State.loadIntegrationTasks();
  const task = State.tasks.find((t) => t.id === "integration_claude");
  task.name = "my-project";
  const card = renderIntegrationCard(task, { openSettings() {} });
  assert.ok(card.textContent.includes("Claude Code"));
  assert.ok(!card.textContent.includes("my-project"));
  assert.ok(card.textContent.includes("Open VS Code"));
});

test("Settings… on the card of a pill that is not connected names that pill", () => {
  State.settings.activeIntegrations = ["integration_vercel"];
  State.loadIntegrationTasks();
  const asked = [];
  const hooks = { openSettings: (pillId) => asked.push(pillId) };
  for (const id of ["integration_claude", "integration_vercel"]) {
    const card = renderIntegrationCard(State.tasks.find((t) => t.id === id), hooks);
    card.find("button").find((b) => b.textContent === "Settings…").fire("click");
  }
  assert.deepEqual(asked, ["integration_claude", "integration_vercel"]);
});
