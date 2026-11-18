// The model chip through a subscription (src/core/subscriptions.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chipLabel, pillTool, setSubscriptions, subscribedProviders } from "../src/core/subscriptions.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { idleStatus } = await import("../src/views/integrations.ts");

const row = (provider, tool, on) => ({
  provider, tool, on, installed: true, signIn: "x", installUrl: "https://x", subscriptionOnly: false,
});

test("the chip names the tool that answers", () => {
  setSubscriptions([row("anthropic", "Claude Code", true), row("google", "Antigravity CLI", true), row("openai", "Codex CLI", false)]);
  assert.equal(chipLabel({ ...DEFAULT_SETTINGS, chatProvider: "anthropic" }, "claude-opus-5-5"), "claude-opus-5-5 · Claude Code");
  assert.equal(chipLabel({ ...DEFAULT_SETTINGS, chatProvider: "google" }, "gemini-2.0-flash"), "Antigravity CLI");
  // One of the tool's own models picked: it goes before the tool's name. The API's never does.
  const picked = { ...DEFAULT_SETTINGS, chatProvider: "google", chatToolModels: { google: "gemini-4-argon-high" } };
  assert.equal(chipLabel(picked, "gemini-2.0-flash"), "gemini-4-argon-high · Antigravity CLI");
  // Off: the API model, as before.
  assert.equal(chipLabel({ ...DEFAULT_SETTINGS, chatProvider: "openai" }, "gpt-4o"), "gpt-4o");
  assert.deepEqual([...subscribedProviders()], ["anthropic", "google"]);
});

test("a chat provider's pill answered on the subscription says so, and asks for no key", () => {
  setSubscriptions([
    row("anthropic", "Claude Code", false),
    row("google", "Antigravity CLI", true),
    { ...row("openai", "Codex CLI", true), installed: false },
  ]);
  // The tool that answers: its switch on, and installed.
  assert.equal(pillTool("ai_google"), "Antigravity CLI");
  assert.equal(pillTool("ai_anthropic"), null);
  assert.equal(pillTool("ai_openai"), null);
  // Only the chat's pills: an agent's pill of the same maker is not one.
  assert.equal(pillTool("agent_gemini"), null);
  assert.equal(pillTool("integration_github"), null);

  const noKey = { configured: false, error: null };
  assert.deepEqual(idleStatus("ai_google", noKey, "claude-opus-5-5", pillTool("ai_google")), {
    label: "On your subscription · Antigravity CLI", color: "#22C55E",
  });
  // Without the subscription, a missing key is still a missing key.
  assert.equal(idleStatus("ai_openai", noKey, "claude-opus-5-5", pillTool("ai_openai")).label, "Key not configured");
  assert.equal(idleStatus("ai_google", noKey, "claude-opus-5-5").label, "Key not configured");
  // An error comes first, whoever answers.
  assert.equal(idleStatus("ai_google", { configured: false, error: "boom" }, "m", "Antigravity CLI").label, "boom");
  setSubscriptions([]);
});
