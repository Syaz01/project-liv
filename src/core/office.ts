// A virtual office as the island knows it: a team of agents working on its own
// in another program, which tells Liv what happens by sending small events
// through `liv-hook office`. docs/OFICINA.md is the contract; this file is all
// of it that needs no DOM and no Tauri — reading an event, the office's state,
// and what the island shows and does for it.
//
// Everything in an event is untrusted: each field is checked on its way in,
// text is cut to its length, an address is only ever http or https, and the
// state is bounded however much is sent. Nothing here keeps time: what depends
// on the clock (an agent gone quiet) is worked out from the `now` it is asked
// with, when something is drawn.

import type { BotStateName } from "./layout";
import type { PillBadge } from "./state";

/** The office's pill in the catalog (core/pills.ts). */
export const OFFICE_PILL_ID = "integration_office";
/** The office an event belongs to when it names none. */
export const DEFAULT_OFFICE_ID = "office";

export const MAX_AGENTS = 12;
export const MAX_ASKS = 20;
export const MAX_NEWS = 5;
/** Agents drawn as dots on the card; the rest are counted ("+n"). */
export const SHOWN_AGENTS = 6;
/** A busy agent that has sent nothing for this long is shown as "no signal". */
export const STALE_AFTER_MS = 15 * 60_000;

const OFFICE_AGENT_STATES = ["idle", "working", "waiting", "blocked", "error", "done", "offline"] as const;
export type OfficeAgentState = (typeof OFFICE_AGENT_STATES)[number];

const NEWS_LEVELS = ["info", "success", "warning", "error"] as const;
type OfficeNewsLevel = (typeof NEWS_LEVELS)[number];

/** The states that say "I am on it": the ones that can go quiet. */
const BUSY: ReadonlySet<OfficeAgentState> = new Set(["working", "waiting", "blocked"]);
/** The states of an agent with nothing in hand: the first to make room. */
const RESTING: ReadonlySet<OfficeAgentState> = new Set(["idle", "done", "offline"]);

/** An office's or an agent's identifier: lowercase, digits and hyphens. */
const ID = /^[a-z0-9-]{1,24}$/;
/** Longest text kept for each field, in characters. */
const MAX = {
  officeName: 40, agentName: 32, agentRole: 32, summary: 140,
  askId: 48, askTitle: 100, askDetail: 140, newsTitle: 100,
  itemTitle: 100, itemStage: 32, url: 2048,
};

// ── Reading an event ──────────────────────────────────────────────────────────

/** The agent an event names. Its name and role are remembered once given. */
export interface OfficeAgentRef {
  id: string;
  name: string | null;
  role: string | null;
}

interface EventCommon {
  /** The office the event belongs to. */
  office: string;
  officeName: string | null;
  /** Where "Open office" goes, when the event says. */
  openUrl: string | null;
}

export type OfficeEvent = EventCommon & (
  | { type: "agent.state"; agent: OfficeAgentRef; state: OfficeAgentState; summary: string | null }
  | { type: "ask.open"; agent: OfficeAgentRef | null; id: string; title: string; detail: string | null; url: string | null }
  | { type: "ask.close"; id: string }
  | { type: "news"; agent: OfficeAgentRef | null; title: string; level: OfficeNewsLevel; url: string | null }
  | { type: "reset" }
);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * One line of text out of an event: line breaks, tabs and control characters
 * become a space, and what is longer than `max` characters is cut, its last
 * character an ellipsis. Null when it is not text or nothing is left of it.
 */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (!line) return null;
  // By code point, so a cut never leaves half an emoji behind.
  const chars = Array.from(line);
  if (chars.length <= max) return line;
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

/**
 * An ask's identifier, taken as it is (it has to match again when the ask is
 * closed): any text of up to 48 characters. A longer one is not cut — two
 * asks could then pass for the same one — it is refused.
 */
function askId(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Array.from(value).length <= MAX.askId ? value : null;
}

/**
 * The address as it may be opened: an http or https one, written out in full
 * by the URL parser, or null. Used when an event is read and again right
 * before anything is opened.
 */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX.url) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.hostname ? url.href : null;
}

function agentRef(value: unknown): OfficeAgentRef | null {
  const agent = record(value);
  const id = identifier(agent?.id);
  if (!agent || !id) return null;
  return { id, name: text(agent.name, MAX.agentName), role: text(agent.role, MAX.agentRole) };
}

/** The piece an agent works on, as one line: "Vídeo 12 · edición". */
function itemLine(value: unknown): string | null {
  const item = record(value);
  if (!item) return null;
  const parts = [text(item.title, MAX.itemTitle), text(item.stage, MAX.itemStage)].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The event in what a relay sent, or null when it is not one this version
 * understands: then nothing happens, and nobody is told. A field that is
 * optional and wrong is left out; one that is required and wrong (the type, an
 * agent's id or state, an ask's id or title, a piece of news' title, the
 * office's id) costs the whole event.
 */
export function parseOfficeEvent(raw: unknown): OfficeEvent | null {
  const event = record(raw);
  if (!event) return null;
  if (event.v !== undefined && event.v !== 1) return null;
  const office = event.office === undefined ? DEFAULT_OFFICE_ID : identifier(event.office);
  if (!office) return null;
  const common: EventCommon = {
    office,
    officeName: text(event.office_name, MAX.officeName),
    openUrl: safeUrl(event.open_url),
  };

  switch (event.type) {
    case "agent.state": {
      const agent = agentRef(event.agent);
      const state = OFFICE_AGENT_STATES.find((s) => s === event.state);
      if (!agent || !state) return null;
      const summary = text(event.summary, MAX.summary) ?? itemLine(event.item);
      return { ...common, type: "agent.state", agent, state, summary };
    }
    case "ask.open": {
      const ask = record(event.ask);
      const id = askId(ask?.id);
      const title = text(ask?.title, MAX.askTitle);
      if (!ask || !id || !title) return null;
      return {
        ...common, type: "ask.open", agent: agentRef(event.agent), id, title,
        detail: text(ask.detail, MAX.askDetail), url: safeUrl(ask.open_url),
      };
    }
    case "ask.close": {
      const id = askId(record(event.ask)?.id);
      return id ? { ...common, type: "ask.close", id } : null;
    }
    case "news": {
      const news = record(event.news);
      const title = text(news?.title, MAX.newsTitle);
      if (!news || !title) return null;
      const level = NEWS_LEVELS.find((l) => l === news.level) ?? "info";
      return { ...common, type: "news", agent: agentRef(event.agent), title, level, url: safeUrl(news.open_url) };
    }
    case "reset":
      return { ...common, type: "reset" };
    default:
      return null;
  }
}

// ── The office ────────────────────────────────────────────────────────────────

export interface OfficeAgent {
  id: string;
  /** The name it gave, else its id. */
  name: string;
  role: string | null;
  state: OfficeAgentState;
  /** What it is doing now, one line. */
  summary: string | null;
  /** The office's `rev` when it was last heard from: the higher, the more recent. */
  rev: number;
  /** When it was last heard from, in the clock `applyOfficeEvent` was given. */
  seenAt: number;
}

/** Something waiting for the user's decision, until the office closes it. */
export interface OfficeAsk {
  id: string;
  title: string;
  detail: string | null;
  /** Where to go and decide; null means the office itself. */
  url: string | null;
  /** The agent asking, by name. */
  by: string | null;
}

export interface OfficeNews {
  title: string;
  url: string | null;
  by: string | null;
}

export interface OfficeState {
  id: string;
  /** The name it gave; null shows as "Office". */
  name: string | null;
  openUrl: string | null;
  /** In the order they first appeared, at most MAX_AGENTS. */
  agents: OfficeAgent[];
  /** Oldest first, at most MAX_ASKS. */
  asks: OfficeAsk[];
  /** Oldest first, the last MAX_NEWS. */
  news: OfficeNews[];
  /** Events taken so far. */
  rev: number;
  /** The badge of what happened since the pill was last looked at. */
  unseen: PillBadge | null;
}

function emptyOffice(id: string): OfficeState {
  return { id, name: null, openUrl: null, agents: [], asks: [], news: [], rev: 0, unseen: null };
}

/**
 * Room for one more agent. With the office full, the agent heard from longest
 * ago leaves — among those with nothing in hand (idle, done, offline) when
 * there is one, else among all of them.
 */
function makeRoom(agents: OfficeAgent[]): OfficeAgent[] {
  if (agents.length < MAX_AGENTS) return agents;
  const resting = agents.filter((a) => RESTING.has(a.state));
  const leaving = (resting.length > 0 ? resting : agents).reduce((a, b) => (b.rev < a.rev ? b : a));
  return agents.filter((a) => a !== leaving);
}

/** An ask or a piece of news names its agent: that counts as hearing from it. */
function heardFrom(agents: OfficeAgent[], ref: OfficeAgentRef | null, rev: number, now: number): OfficeAgent[] {
  if (!ref) return agents;
  return agents.map((a) =>
    a.id === ref.id ? { ...a, name: ref.name ?? a.name, role: ref.role ?? a.role, rev, seenAt: now } : a,
  );
}

function nameOf(agents: OfficeAgent[], ref: OfficeAgentRef | null): string | null {
  if (!ref) return null;
  return ref.name ?? agents.find((a) => a.id === ref.id)?.name ?? ref.id;
}

/**
 * The office after `event`, at `now` (milliseconds, any clock that only goes
 * forward). Null is "no office": before the first event and after `reset`. An
 * event of another office starts again from nothing with that one. The state
 * given is never changed.
 */
export function applyOfficeEvent(state: OfficeState | null, event: OfficeEvent, now: number): OfficeState | null {
  if (event.type === "reset") return null;
  const base = state && state.id === event.office ? state : emptyOffice(event.office);
  const rev = base.rev + 1;
  const next: OfficeState = {
    ...base,
    name: event.officeName ?? base.name,
    openUrl: event.openUrl ?? base.openUrl,
    rev,
    unseen: officeEffect(base, event)?.badge ?? base.unseen,
  };

  switch (event.type) {
    case "agent.state": {
      const known = base.agents.find((a) => a.id === event.agent.id);
      const agent: OfficeAgent = {
        id: event.agent.id,
        name: event.agent.name ?? known?.name ?? event.agent.id,
        role: event.agent.role ?? known?.role ?? null,
        state: event.state,
        // A line says what it does now: it outlives a repeat of the same state, not a change.
        summary: event.summary ?? (known?.state === event.state ? known.summary : null),
        rev,
        seenAt: now,
      };
      next.agents = known
        ? base.agents.map((a) => (a === known ? agent : a))
        : [...makeRoom(base.agents), agent];
      break;
    }
    case "ask.open": {
      const ask: OfficeAsk = {
        id: event.id, title: event.title, detail: event.detail, url: event.url,
        by: nameOf(base.agents, event.agent),
      };
      // Sent again, an ask is brought up to date where it is; a new one goes
      // last, and past the limit the oldest is forgotten.
      next.asks = base.asks.some((a) => a.id === ask.id)
        ? base.asks.map((a) => (a.id === ask.id ? ask : a))
        : [...base.asks, ask].slice(-MAX_ASKS);
      next.agents = heardFrom(base.agents, event.agent, rev, now);
      break;
    }
    case "ask.close":
      next.asks = base.asks.filter((a) => a.id !== event.id);
      break;
    case "news":
      next.news = [...base.news, { title: event.title, url: event.url, by: nameOf(base.agents, event.agent) }]
        .slice(-MAX_NEWS);
      next.agents = heardFrom(base.agents, event.agent, rev, now);
      break;
  }
  return next;
}

/** The pill has been looked at: what was new no longer is. */
export function officeSeen(state: OfficeState | null): OfficeState | null {
  return state && state.unseen ? { ...state, unseen: null } : state;
}

// ── What the island does for an event ─────────────────────────────────────────

export interface OfficeEffect {
  /**
   * `open`: an alert, the island opens on the office's card (when alerts may
   * take the screen). `peek`: the compact island shows itself. `badge`: only
   * the pill's badge changes.
   */
  action: "open" | "peek" | "badge";
  badge: PillBadge;
  /** One of the island's own sounds (core/sound.ts), or none. */
  sound: "question" | "error" | "finish" | null;
}

/**
 * What the island does when `event` arrives with the office as `state` (before
 * the event is applied), per the table in docs/OFICINA.md; null for an event
 * that only brings the card up to date. Only what is new alerts: an ask that is
 * already waiting, or an agent saying again that it failed, does not.
 */
export function officeEffect(state: OfficeState | null, event: OfficeEvent): OfficeEffect | null {
  const office = state && state.id === event.office ? state : null;
  switch (event.type) {
    case "ask.open":
      if (office?.asks.some((a) => a.id === event.id)) return null;
      return { action: "open", badge: "approval", sound: "question" };
    case "agent.state":
      if (event.state !== "error") return null;
      if (office?.agents.find((a) => a.id === event.agent.id)?.state === "error") return null;
      return { action: "peek", badge: "error", sound: "error" };
    case "news":
      return NEWS_EFFECTS[event.level];
    default:
      return null;
  }
}

const NEWS_EFFECTS: Record<OfficeNewsLevel, OfficeEffect | null> = {
  info: null,
  success: { action: "peek", badge: "finished", sound: "finish" },
  warning: { action: "badge", badge: "approval", sound: null },
  error: { action: "peek", badge: "error", sound: "error" },
};

// ── What the island shows ─────────────────────────────────────────────────────

/** True for a busy agent that has sent nothing for STALE_AFTER_MS: "no signal". */
export function isStale(agent: OfficeAgent, now: number): boolean {
  return BUSY.has(agent.state) && now - agent.seenAt >= STALE_AFTER_MS;
}

/** How many things wait for the user's decision. */
export function waitingCount(state: OfficeState | null): number {
  return state?.asks.length ?? 0;
}

/**
 * The office as one state of Liv's, for the island's figure while its pill is in front:
 * something waits for the user, else an agent failed, else one is at work
 * (and has not gone quiet), else nothing.
 */
export function officeBotState(state: OfficeState | null, now: number): BotStateName {
  if (!state) return "idle";
  if (state.asks.length > 0) return "approval";
  if (state.agents.some((a) => a.state === "error")) return "error";
  if (state.agents.some((a) => a.state === "working" && !isStale(a, now))) return "working";
  return "idle";
}

/**
 * The badge on the office's pill while another pill is in front: amber for as
 * long as something waits for the user, else that of what happened since the
 * pill was last looked at.
 */
export function officeBadge(state: OfficeState | null): PillBadge | null {
  if (!state) return null;
  return state.asks.length > 0 ? "approval" : state.unseen;
}

/** One agent on the card. */
export interface OfficeDot {
  name: string;
  role: string | null;
  state: OfficeAgentState;
  summary: string | null;
  /** Busy by its own word, but quiet for too long: drawn dimmed. */
  stale: boolean;
}

/** The card's one line: what matters most right now. */
export type OfficeHeadline =
  | { kind: "ask"; title: string; detail: string | null; by: string | null }
  | { kind: "news"; title: string; by: string | null }
  | { kind: "agent"; agent: OfficeDot }
  | { kind: "none" };

/** Everything the office's card shows, ready to draw (views/office.ts). */
export interface OfficeCard {
  /** The office's own name; null shows as "Office". */
  name: string | null;
  /** The size of the team: every agent known. */
  agents: number;
  /** How many things wait for the user. */
  waiting: number;
  headline: OfficeHeadline;
  /** The first SHOWN_AGENTS agents… */
  dots: OfficeDot[];
  /** …and how many more there are. */
  more: number;
  /** Where "Review" goes: the latest ask, else the office. Null with nothing waiting, or nowhere to go. */
  reviewUrl: string | null;
  /** Where "Open office" goes: what the office said, else `settingsUrl`. */
  officeUrl: string | null;
  /** Where the ↗ button goes: what the headline is about, else the office. */
  jumpUrl: string | null;
}

/**
 * The card for the office as it is at `now`. `settingsUrl` is the address from
 * Settings: without any event it is all there is, and the card is then a
 * shortcut to it.
 */
export function officeCard(state: OfficeState | null, settingsUrl: string, now: number): OfficeCard {
  const officeUrl = safeUrl(state?.openUrl) ?? safeUrl(settingsUrl);
  const agents = state?.agents ?? [];
  const dot = (a: OfficeAgent): OfficeDot => ({
    name: a.name, role: a.role, state: a.state, summary: a.summary, stale: isStale(a, now),
  });
  const ask = state?.asks.at(-1);
  const news = state?.news.at(-1);

  let headline: OfficeHeadline = { kind: "none" };
  let jumpUrl = officeUrl;
  if (ask) {
    headline = { kind: "ask", title: ask.title, detail: ask.detail, by: ask.by };
    jumpUrl = safeUrl(ask.url) ?? officeUrl;
  } else if (news) {
    headline = { kind: "news", title: news.title, by: news.by };
    jumpUrl = safeUrl(news.url) ?? officeUrl;
  } else if (agents.length > 0) {
    headline = { kind: "agent", agent: dot(agents.reduce((a, b) => (b.rev > a.rev ? b : a))) };
  }

  return {
    name: state?.name ?? null,
    agents: agents.length,
    waiting: waitingCount(state),
    headline,
    dots: agents.slice(0, SHOWN_AGENTS).map(dot),
    more: Math.max(0, agents.length - SHOWN_AGENTS),
    reviewUrl: ask ? jumpUrl : null,
    officeUrl,
    jumpUrl,
  };
}
