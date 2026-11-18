// The Claude models Liv offers before it can ask the account: one list, in
// claude-models.json, read by the settings, the chat and Rust (claude.rs).
// With an API key the account's own list replaces it.

import FILE from "./claude-models.json";

export interface ClaudeModel {
  id: string;
  label: string;
}

export const CLAUDE_MODELS: readonly ClaudeModel[] = FILE.models;
export const DEFAULT_CLAUDE_MODEL: string = FILE.default;
