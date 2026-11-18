// How the chat shows who answers: the mark of four gems that opens the picker
// (one gem lit, in the provider's colour), and the colour Liv's shell takes
// while the chat is the open island's view. No DOM here.

import type { IslandMode, IslandViewName } from "./layout";
import { providerDef } from "./providers";
import type { RGB } from "../robot/look";

/** Where each gem of the mark sits. */
export type GemSlot = "top" | "left" | "right" | "bottom";

export interface Gem {
  slot: GemSlot;
  color: string;
  /** Lit: this is who answers. */
  on: boolean;
}

/** Anthropic above, Google and OpenAI at the sides; every other provider is the gem below. */
const NAMED: readonly (readonly [GemSlot, string])[] = [["top", "anthropic"], ["left", "google"], ["right", "openai"]];
/** The gem below while one of the three named answers: OpenRouter's colour. */
const OTHERS = "openrouter";

/**
 * The mark for `provider`: its gem lit, the others dimmed. The gem below
 * stands for whoever is not one of the three named, and takes its colour.
 */
export function markFor(provider: string): Gem[] {
  const active = providerDef(provider).id;
  const named = NAMED.some(([, id]) => id === active);
  const gems: Gem[] = NAMED.map(([slot, id]) => ({ slot, color: providerDef(id).accent, on: id === active }));
  gems.push({ slot: "bottom", color: providerDef(named ? OTHERS : active).accent, on: !named });
  return gems;
}

/**
 * The colour of Liv's shell for the chat: the provider's, while the chat is
 * what the open island shows. null anywhere else — Liv wears what it wore.
 */
export function chatShell(mode: IslandMode, view: IslandViewName, provider: string): string | null {
  return mode === "expanded" && view === "prompt" ? providerDef(provider).accent : null;
}

/** `current` a step of `dt` seconds nearer `target`: the shell changes colour, it does not jump. */
export function towards(current: RGB, target: RGB, dt: number, rate = 9): RGB {
  const k = Math.min(1, Math.max(0, dt * rate));
  const step = (a: number, b: number) => (Math.abs(b - a) < 0.004 ? b : a + (b - a) * k);
  return [step(current[0], target[0]), step(current[1], target[1]), step(current[2], target[2])];
}
