// The icons of the What's new card, as strokes on the 24×24 grid of
// views/icons.ts (drawn with svg(path, size, { stroke })). The Mac maps the
// same names to SF Symbols (WhatsNew.swift).

import type { IconName } from "./whats-new";

export const WHATS_NEW_ICONS: Record<IconName, string> = {
  // terminal
  terminal: "M4 5h16v14H4zM7.5 9.5 10 12l-2.5 2.5M12 15h4.5",
  // sparkles
  sparkles: "M10 3.5l1.6 4.4L16 9.5l-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6zM17.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
  // clock
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3.5 2",
};

/** Small icons on the "Your Liv so far" chips. */
export const STAT_ICONS = {
  agentSessions: WHATS_NEW_ICONS.terminal,
  agentTime: WHATS_NEW_ICONS.clock,
  linesAdded: "M8.5 7 4 12l4.5 5M15.5 7 20 12l-4.5 5",
  approvals: "M5 12.5 9.5 17 19 7.5",
} as const;
