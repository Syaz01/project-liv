// How the chat shows who answers (src/core/chat-look.ts): the mark of four
// gems, and the colour Liv's shell takes in the chat.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chatShell, markFor, towards } from "../src/core/chat-look.ts";
import { providerDef } from "../src/core/providers.ts";

const lit = (provider) => markFor(provider).filter((g) => g.on).map((g) => g.slot);
const colors = (provider) => Object.fromEntries(markFor(provider).map((g) => [g.slot, g.color]));

test("the three named providers each have their gem, in their colour", () => {
  assert.deepEqual(markFor("anthropic").map((g) => g.slot), ["top", "left", "right", "bottom"]);
  assert.deepEqual(colors("anthropic"), { top: "#E07950", left: "#4285F4", right: "#10A37F", bottom: "#6467F2" });
  assert.deepEqual(lit("anthropic"), ["top"]);
  assert.deepEqual(lit("google"), ["left"]);
  assert.deepEqual(lit("openai"), ["right"]);
  // Whoever answers, the other gems keep their colours.
  assert.deepEqual(colors("google"), colors("anthropic"));
});

test("any other provider is the gem below, in its own colour", () => {
  assert.deepEqual(lit("openrouter"), ["bottom"]);
  assert.equal(colors("openrouter").bottom, "#6467F2");
  for (const id of ["ollama", "lmstudio", "custom", "cursor", "copilot"]) {
    assert.deepEqual(lit(id), ["bottom"], id);
    assert.equal(colors(id).bottom, providerDef(id).accent, id);
    assert.equal(colors(id).top, "#E07950", id);
  }
  // One this build does not know is read as Claude, as everywhere else.
  assert.deepEqual(lit("nope"), ["top"]);
});

test("Liv wears the provider's colour only while the chat is the open island's view", () => {
  assert.equal(chatShell("expanded", "prompt", "anthropic"), "#E07950");
  assert.equal(chatShell("expanded", "prompt", "google"), "#4285F4");
  assert.equal(chatShell("expanded", "prompt", "openai"), "#10A37F");
  assert.equal(chatShell("expanded", "prompt", "ollama"), "#FACC15");
  assert.equal(chatShell("expanded", "overview", "google"), null);
  for (const mode of ["hidden", "compact", "peek"]) assert.equal(chatShell(mode, "prompt", "google"), null, mode);
});

test("from one provider's colour to the next's in steps, landing on it exactly", () => {
  const from = [1, 0, 0];
  const to = [0, 0, 1];
  const step = towards(from, to, 1 / 60);
  assert.ok(step[0] < 1 && step[0] > 0.8 && step[2] > 0 && step[2] < 0.2);
  assert.equal(step[1], 0);
  let color = from;
  for (let i = 0; i < 90; i++) color = towards(color, to, 1 / 60);
  assert.deepEqual(color, to);
  // A long frame goes straight there, never past it.
  assert.deepEqual(towards(from, to, 5), to);
  assert.deepEqual(towards(from, from, 0.016), from);
});
