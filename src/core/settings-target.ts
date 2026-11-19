// Where a "Settings…" link of the island lands in the Liv window: a page and,
// on it, the section to scroll to. The anchors are the sections' `data-anchor`
// (src/settings), the same ids the settings search points at (hub/search.ts).
// No DOM here: the island asks, Rust passes the text on, the window reads it.

import { OFFICE_PILL_ID } from "./office";
import { pillDefinition } from "./pills";
import { providerDef } from "./providers";

export const SETTINGS_PAGES = ["general", "island", "appearance", "pills", "agents", "chat", "integrations", "shortcuts"] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];

export interface SettingsTarget {
  page: SettingsPage;
  /** The section's `data-anchor`; without one the page opens at its top. */
  anchor?: string;
}

/** As one text, for the `page` Rust hands to the window: "chat#chat.claude". */
export function encodeTarget(target: SettingsTarget): string {
  return target.anchor ? `${target.page}#${target.anchor}` : target.page;
}

/** The target in a text made by encodeTarget, or null when its page is none of ours. */
export function parseTarget(text: string): SettingsTarget | null {
  const [page, anchor] = text.split("#");
  if (!(SETTINGS_PAGES as readonly string[]).includes(page)) return null;
  return anchor ? { page: page as SettingsPage, anchor } : { page: page as SettingsPage };
}

/** Where the chat's provider gets what it needs: its key, its server or its subscription. */
export function chatSettingsTarget(provider: string): SettingsTarget {
  const p = providerDef(provider);
  if (p.id === "anthropic") return { page: "chat", anchor: "chat.claude" };
  if (p.key) return { page: "chat", anchor: "chat.providers" };
  if (p.urlField) return { page: "chat", anchor: "chat.local" };
  return { page: "chat", anchor: "chat.subscriptions" };
}

/** Where a pill that is not connected yet gets connected. */
export function pillSettingsTarget(pillId: string): SettingsTarget {
  if (pillId === OFFICE_PILL_ID) return { page: "integrations", anchor: "integrations.office" };
  const def = pillDefinition(pillId);
  switch (def?.connect.kind) {
    case "hooks":
      // Cursor's pill shows Claude Code in Cursor's terminal: the same hooks.
      return pillId === "integration_claude" || pillId === "agent_cursor"
        ? { page: "agents", anchor: "agents.claude-code" }
        : { page: "agents", anchor: "agents.others" };
    case "server":
      return { page: "chat", anchor: "chat.local" };
    case "key":
      if (def.category !== "ai") return { page: "integrations", anchor: "integrations.services" };
      return def.id === "ai_anthropic"
        ? { page: "chat", anchor: "chat.claude" }
        : { page: "chat", anchor: "chat.providers" };
    default:
      return { page: "general" };
  }
}
