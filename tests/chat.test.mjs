// The chat view (src/views/chat.ts) on a fake DOM, through the real bridge:
// the model switcher asks for a provider's models only once it is picked and
// has a key, picking saves the settings, and a streamed answer grows in place.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, emit, internals, sent } from "./tauri.mjs";

installFakeDom();
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { setSubscriptions } = await import("../src/core/subscriptions.ts");

/** What the mocked Rust side answers, by command. */
let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let view;
beforeEach(() => {
  calls.length = 0;
  answers = {};
  setSubscriptions([]);
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {} };
  State.chatHistory = [];
  State.stateOverride = null;
  State.view = "prompt";
  State.droppedFile = null;
  view = buildPrompt(() => {});
  view.sync();
});

const $ = (cls) => view.el.querySelector(cls);
const chips = () => view.el.find(".picker-provider").map((c) => c.textContent);
const models = () => view.el.find(".picker-model-name").map((m) => m.textContent);

test("the model button shows the active provider's model", () => {
  assert.equal($(".model-name").textContent, "claude-opus-5-5");
  State.settings = { ...State.settings, chatProvider: "google" };
  view.sync();
  assert.equal($(".model-name").textContent, "gemini-2.0-flash");
  State.settings = { ...State.settings, chatProvider: "ollama" };
  view.sync();
  assert.equal($(".model-name").textContent, "Choose a model");
});

test("a provider without a key is never asked for its models", async () => {
  answers.secret_present = false;
  answers.claude_ready = false;
  $(".model-btn").fire("click");
  await flush();
  assert.ok($(".chat-body").classList.contains("picking"));
  assert.deepEqual(chips(), ["Anthropic", "Google", "OpenAI", "OpenRouter"]);
  assert.equal(sent("claude_ready").length, 1);
  assert.deepEqual(sent("chat_models"), []);
  assert.match($(".picker-status").textContent, /No API key/);
});

test("without a key, Claude Code standing in still lists Claude's models", async () => {
  answers.secret_present = false;
  answers.claude_ready = true;
  answers.chat_models = [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }];
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(sent("secret_present"), []);
  assert.deepEqual(sent("chat_models"), [{ provider: "anthropic" }]);
  assert.deepEqual(models(), ["Claude Opus 5.5"]);
});

test("with a key, the models are listed and picking one saves it", async () => {
  answers.secret_present = true;
  answers.claude_ready = true;
  answers.chat_models = [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  ];
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_models"), [{ provider: "anthropic" }]);
  assert.deepEqual(models(), ["Claude Opus 5.5", "Claude Sonnet 5.5"]);
  view.el.find(".picker-model")[1].fire("click");
  assert.equal(State.settings.model, "claude-sonnet-5-5");
  assert.equal(sent("save_settings").at(-1).settings.model, "claude-sonnet-5-5");
  assert.ok(!$(".chat-body").classList.contains("picking"));
  assert.equal($(".model-name").textContent, "claude-sonnet-5-5");
});

test("switching provider saves it and asks the new provider only", async () => {
  answers.secret_present = (args) => args.key === "google-api-key";
  answers.chat_models = (args) => (args.provider === "google" ? [{ id: "gemini-2.5-flash", label: "gemini-2.5-flash" }] : []);
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_models"), []);
  view.el.find(".picker-provider")[1].fire("click");
  await flush();
  assert.equal(State.settings.chatProvider, "google");
  assert.deepEqual(sent("chat_models"), [{ provider: "google" }]);
  // The saved model was not offered: the flash one is kept instead, and saved.
  assert.equal(State.settings.chatModels.google, "gemini-2.5-flash");
  assert.equal(sent("save_settings").at(-1).settings.chatModels.google, "gemini-2.5-flash");
  assert.deepEqual(models(), ["gemini-2.5-flash"]);
});

test("on a subscription the tool's own models are listed, and the one picked is kept apart from the API's", async () => {
  State.settings = { ...State.settings, chatProvider: "openai", chatModels: { openai: "gpt-4o" } };
  answers.subscription_status = [
    { provider: "openai", tool: "Codex CLI", on: true, installed: true, signIn: "codex login", installUrl: "https://x", subscriptionOnly: false },
  ];
  answers.chat_models = [
    { id: "", label: "The model chosen in Codex CLI" },
    { id: "gpt-6.2-sol", label: "GPT-6.2-Sol" },
    { id: "gpt-6-luna", label: "GPT-6-Luna" },
  ];
  $(".model-btn").fire("click");
  await flush();
  // No key is needed, and the API's model is not one of the tool's: its own choice is the one picked.
  assert.deepEqual(sent("secret_present"), []);
  assert.deepEqual(models(), ["The model chosen in Codex CLI", "GPT-6.2-Sol", "GPT-6-Luna"]);
  assert.deepEqual(view.el.find(".picker-model").map((m) => m.classList.contains("on")), [true, false, false]);
  assert.equal($(".model-name").textContent, "Codex CLI");

  view.el.find(".picker-model")[1].fire("click");
  assert.equal(State.settings.chatToolModels.openai, "gpt-6.2-sol");
  assert.equal(State.settings.chatModels.openai, "gpt-4o");
  assert.equal(sent("save_settings").at(-1).settings.chatToolModels.openai, "gpt-6.2-sol");
  assert.ok(!$(".chat-body").classList.contains("picking"));
  assert.equal($(".model-name").textContent, "gpt-6.2-sol · Codex CLI");

  // Opened again the tool is asked again, the one picked is marked, and its own choice can be taken back.
  $(".model-btn").fire("click");
  await flush();
  assert.equal(sent("chat_models").length, 2);
  assert.deepEqual(view.el.find(".picker-model").map((m) => m.classList.contains("on")), [false, true, false]);
  view.el.find(".picker-model")[0].fire("click");
  assert.deepEqual(State.settings.chatToolModels, {});
  assert.equal($(".model-name").textContent, "Codex CLI");

  // A model the tool no longer lists: its own choice shows as picked.
  State.settings = { ...State.settings, chatToolModels: { openai: "gpt-gone" } };
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(view.el.find(".picker-model").map((m) => m.classList.contains("on")), [true, false, false]);
});

test("the picker: providers down the left, models beside them, and a taller island while it is open", async () => {
  let resized = 0;
  view = buildPrompt(() => resized++);
  view.sync();
  // Closed, the chat keeps its own height.
  assert.equal(view.height(), null);

  answers.secret_present = true;
  answers.claude_ready = true;
  answers.chat_models = [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "some-model-id", label: "some-model-id" },
  ];
  $(".model-btn").fire("click");
  await flush();
  // Open: the island is as tall as the chat gets, and was told once to resize.
  assert.equal(view.height(), 300);
  assert.equal(resized, 1);

  // Two columns, each under its heading.
  const [side, main] = view.el.find(".picker-col");
  assert.equal(side.find(".picker-head")[0].textContent, "AI");
  assert.equal(main.find(".picker-head")[0].textContent, "Model");
  assert.deepEqual(side.find(".picker-provider").map((p) => p.textContent), ["Anthropic", "Google", "OpenAI", "OpenRouter"]);
  assert.ok(side.find(".picker-provider")[0].classList.contains("on"));
  assert.equal(main.find(".picker-model").length, 2);

  // A model with a friendlier name also shows the id the provider knows it by;
  // one whose name is its id shows it once.
  const [named, bare] = main.find(".picker-model");
  assert.equal(named.find(".picker-model-id")[0].textContent, "claude-opus-5-5");
  assert.equal(bare.find(".picker-model-id").length, 0);

  // Picking a model closes it: the chat's own height again, one more resize.
  bare.fire("click");
  assert.equal(view.height(), null);
  assert.equal(resized, 2);

  // Leaving the chat folds it away too.
  $(".model-btn").fire("click");
  await flush();
  assert.equal(view.height(), 300);
  State.view = "overview";
  view.sync();
  assert.equal(view.height(), null);
  State.view = "prompt";
});

test("a local answer streams into one reply, then the finished text replaces it", async () => {
  let finish;
  answers.chat_send = () => new Promise((resolve) => (finish = resolve));
  const input = $(".chat-input");
  input.value = "hello";
  $(".send-btn").fire("click");
  await flush();
  view.sync(); // what State.notify() does in the island
  assert.ok($(".model-btn").disabled, "no switching mid-answer");
  assert.ok($(".typing"), "dots until the first visible text");

  emit("chat-delta", ""); // still thinking
  assert.ok($(".typing"));
  emit("chat-delta", "Hel");
  emit("chat-delta", "Hello **there**");
  view.sync(); // another view update mid-stream must not wipe the live answer
  assert.equal($(".typing"), null);
  const replies = view.el.find(".reply");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].find("STRONG")[0].textContent, "there");

  finish({ text: "Hello **there**!" });
  await flush();
  view.sync();
  assert.equal(view.el.find(".reply").length, 1);
  assert.equal(view.el.find(".reply")[0].textContent, "Hello there!");
  assert.deepEqual(State.chatHistory.map((m) => m.role), ["user", "assistant"]);
  assert.ok(!$(".model-btn").disabled);
});

test("once the answer is in, the field takes the focus back, enabled", async () => {
  let finish;
  answers.chat_send = () => new Promise((resolve) => (finish = resolve));
  const input = $(".chat-input");
  const focused = [];
  input.focus = () => focused.push(input.disabled ? "disabled" : "enabled");
  input.value = "hello";
  $(".send-btn").fire("click");
  await flush();
  view.sync(); // mid-answer: the field is disabled
  assert.ok(input.disabled);

  finish({ text: "Hi!" });
  await flush(); // no sync yet: in the island it runs on the next frame
  assert.equal(input.disabled, false);
  assert.deepEqual(focused, ["enabled"]);
});

test("a failed answer leaves the chat for the note without taking the focus", async () => {
  answers.chat_send = () => Promise.reject(new Error("no key"));
  const input = $(".chat-input");
  const focused = [];
  input.focus = () => focused.push(true);
  input.value = "hello";
  $(".send-btn").fire("click");
  await flush();
  await flush();
  assert.equal(State.view, "note");
  assert.deepEqual(focused, []);
});
