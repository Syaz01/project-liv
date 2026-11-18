// The chat on the user's own subscription, as the island sees it: which
// providers answer through their terminal tool (cli_relay.rs), asked of Rust
// and kept until the next ask.

import { Bridge, type SubscriptionStatus } from "./bridge";
import { toolModel } from "./providers";
import type { Settings } from "./state";

let rows: SubscriptionStatus[] = [];

/** Asks Rust again (it looks for the tools on every call). */
export async function loadSubscriptions(): Promise<SubscriptionStatus[]> {
  rows = (await Bridge.subscriptionStatus()) ?? rows;
  return rows;
}

export function setSubscriptions(next: SubscriptionStatus[] | null | undefined) {
  if (next) rows = next;
}

export function subscription(provider: string): SubscriptionStatus | undefined {
  return rows.find((r) => r.provider === provider);
}

/** The providers whose switch is on. */
export function subscribedProviders(): Set<string> {
  return new Set(rows.filter((r) => r.on).map((r) => r.provider));
}

/**
 * The model chip: the tool's name when it answers, after the model it was
 * asked for — Claude's for Claude Code, one of its own for the others, none
 * when the choice is left to the tool.
 */
export function chipLabel(settings: Settings, model: string): string {
  const sub = subscription(settings.chatProvider);
  if (!sub?.on) return model;
  const asked = settings.chatProvider === "anthropic" ? model : toolModel(settings, settings.chatProvider);
  return asked ? `${asked} · ${sub.tool}` : sub.tool;
}
