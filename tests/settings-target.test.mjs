// Where the island's "Settings…" links land in the Liv window
// (src/core/settings-target.ts): the page, and the section on it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_PAGES, chatSettingsTarget, encodeTarget, parseTarget, pillSettingsTarget,
} from "../src/core/settings-target.ts";
import { PILL_CATALOG } from "../src/core/pills.ts";
import { PROVIDERS } from "../src/core/providers.ts";
import { SETTINGS_ENTRIES } from "../src/hub/search.ts";

/** A target lands somewhere real: its page, and a section the settings search knows on that page. */
function lands(target, what) {
  assert.ok(SETTINGS_PAGES.includes(target.page), `${what}: ${target.page}`);
  if (target.anchor === undefined) return;
  const entry = SETTINGS_ENTRIES.find((e) => e.id === target.anchor);
  assert.ok(entry, `${what}: no section ${target.anchor}`);
  assert.equal(entry.page, target.page, what);
}

test("a pill that is not connected opens where it gets connected", () => {
  // Hooks: the Agents page — Claude Code's own section for its pill and Cursor's.
  assert.deepEqual(pillSettingsTarget("integration_claude"), { page: "agents", anchor: "agents.claude-code" });
  assert.deepEqual(pillSettingsTarget("agent_cursor"), { page: "agents", anchor: "agents.claude-code" });
  assert.deepEqual(pillSettingsTarget("agent_codex"), { page: "agents", anchor: "agents.others" });
  assert.deepEqual(pillSettingsTarget("agent_gemini"), { page: "agents", anchor: "agents.others" });
  // A service's key: Integrations ("Key not configured" used to open General).
  for (const id of ["integration_resend", "integration_n8n", "integration_vercel", "integration_github", "integration_gitlab"]) {
    assert.deepEqual(pillSettingsTarget(id), { page: "integrations", anchor: "integrations.services" }, id);
  }
  // The office's address has a box of its own.
  assert.deepEqual(pillSettingsTarget("integration_office"), { page: "integrations", anchor: "integrations.office" });
  // The chat's providers: the Chat page.
  assert.deepEqual(pillSettingsTarget("ai_anthropic"), { page: "chat", anchor: "chat.claude" });
  assert.deepEqual(pillSettingsTarget("ai_openai"), { page: "chat", anchor: "chat.providers" });
  assert.deepEqual(pillSettingsTarget("ai_ollama"), { page: "chat", anchor: "chat.local" });
  // Nothing to set up, or not a pill: the window's first page.
  assert.deepEqual(pillSettingsTarget("integration_spotify"), { page: "general" });
  assert.deepEqual(pillSettingsTarget("not_a_pill"), { page: "general" });
});

test("the chat's model picker opens the Chat page, on what the provider needs", () => {
  assert.deepEqual(chatSettingsTarget("anthropic"), { page: "chat", anchor: "chat.claude" });
  for (const id of ["openai", "google", "openrouter"]) {
    assert.deepEqual(chatSettingsTarget(id), { page: "chat", anchor: "chat.providers" }, id);
  }
  for (const id of ["ollama", "lmstudio", "custom"]) {
    assert.deepEqual(chatSettingsTarget(id), { page: "chat", anchor: "chat.local" }, id);
  }
  for (const id of ["cursor", "copilot"]) {
    assert.deepEqual(chatSettingsTarget(id), { page: "chat", anchor: "chat.subscriptions" }, id);
  }
  // A provider this build does not have reads as Claude, as everywhere.
  assert.deepEqual(chatSettingsTarget("deepseek"), { page: "chat", anchor: "chat.claude" });
});

test("every link lands on a section the settings pages draw", () => {
  for (const pill of PILL_CATALOG) lands(pillSettingsTarget(pill.id), pill.id);
  for (const provider of PROVIDERS) lands(chatSettingsTarget(provider.id), provider.id);
});

test("a target travels as one text, and only a page of the window is read back", () => {
  assert.equal(encodeTarget({ page: "general" }), "general");
  assert.equal(encodeTarget({ page: "chat", anchor: "chat.claude" }), "chat#chat.claude");
  for (const target of [{ page: "shortcuts" }, { page: "integrations", anchor: "integrations.office" }]) {
    assert.deepEqual(parseTarget(encodeTarget(target)), target);
  }
  // What Rust sends on its own: a page.
  assert.deepEqual(parseTarget("general"), { page: "general" });
  assert.deepEqual(parseTarget("agents#"), { page: "agents" });
  for (const odd of ["", "nowhere", "nowhere#chat.claude", "#chat.claude", "General"]) {
    assert.equal(parseTarget(odd), null, odd);
  }
});
