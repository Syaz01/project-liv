// Hook events from Claude Code and every other agent → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.
// The relay has already mapped every agent's events and fields onto Claude
// Code's (hook/src/normalize.rs), so one handler serves them all.

import { alertShows } from "../core/alerts";
import { Bridge, onEvent } from "../core/bridge";
import { buildFileDiff, fileName, makeDiffStep, toOneLine } from "../core/diff";
import { Sound } from "../core/sound";
import { State, type ApprovalInfo, type AskedQuestion } from "../core/state";
import { pillDefinition } from "../core/pills";
import { agentColor, agentName, takesCard, validateAgent } from "./agents";
import type { Island } from "./island";
import { parseClaudePlan, restorePlanUsage } from "../core/plan";
import { setClaudePlanUsage, storedClaudePlanUsage } from "../views/usage";
import { N_, t } from "../i18n/i18n";
import { Launch } from "../core/launch";

const CLAUDE_ID = "integration_claude";
const CURSOR_ID = "agent_cursor";

/** Most requests waiting at once, the one on the card included (Mac ApprovalQueue.maxPending). */
const MAX_PENDING = 5;

/**
 * Each request gives up on its own clock: 110 s after it arrived, whether it
 * is on the card or still in line, it goes (the relay has stopped waiting by
 * then). Checked by id, so it can never take down a request that came later.
 */
function armRequestTimeout(island: Island, requestId: string) {
  window.setTimeout(() => {
    if (State.pendingApproval?.requestId === requestId) dropPendingCard(island);
    else dropQueued((x) => x.requestId === requestId);
  }, 110_000);
}

/** Takes requests out of the line (their relay is released by the caller or gone). */
function dropQueued(match: (x: ApprovalInfo) => boolean): ApprovalInfo[] {
  const gone = State.approvalQueue.filter(match);
  if (gone.length === 0) return gone;
  State.approvalQueue = State.approvalQueue.filter((x) => !match(x));
  for (const pill of new Set(gone.map((x) => x.pillId))) {
    if (!State.approvalQueue.some((x) => x.pillId === pill)) State.setPillBadge(pill, null);
  }
  State.notify();
  return gone;
}

/** Takes the approval or question card down and gives the island back. */
export function dropPendingCard(island: Island): void {
  if (!State.pendingApproval) return;
  State.endApproval();
  if (State.pendingApproval) {
    // The next request in line takes the card, the way a new one comes up.
    const view = State.pendingApproval.questions ? "question" : "approval";
    Sound.play(view);
    island.alert(view);
    State.notify();
    return;
  }
  island.dropPin();
  if (State.view === "approval" || State.view === "question") {
    // The card was folded away: the island stays as it is (setView would
    // spring it open), and only what it opens on next changes.
    if (State.mode === "expanded") island.setView(State.defaultView());
    else State.view = State.defaultView();
  }
  State.notify();
}

/** The return to idle that Stop arms, per pill, so the next turn can cancel it. */
const stopTimers = new Map<string, number>();

function cancelStopTimer(id: string): boolean {
  const timer = stopTimers.get(id);
  if (timer == null) return false;
  window.clearTimeout(timer);
  stopTimers.delete(id);
  return true;
}

/** The pill that was focused before another pill's alert borrowed the front. */
let focusBeforeAlert: string | null = null;
let alertPill: string | null = null;

/**
 * Whether an alert of `pill` may take the screen (the rule is core/alerts.ts):
 * never over a card waiting for an answer, nor over what the user is doing in
 * the open island; else always when it is the pill in front, and from another
 * pill only with "Alerts from all pills" on — its pill then borrows the front
 * until the island closes. False means the alert is only a badge. Shared with
 * the virtual office (island/office.ts), whose requests wait for the user as a
 * permission card does: `waitsForYou` lets them through whatever that setting.
 */
export function showsAlert(pill: string, focused: boolean, waitsForYou = false): boolean {
  const shows = alertShows({
    focused,
    waitsForYou,
    alertsFromAllPills: State.settings.alertsFromAllPills,
    cardWaiting: State.pendingApproval != null,
    expanded: State.mode === "expanded",
    view: State.view,
  });
  if (!shows || focused) return shows;
  if (focusBeforeAlert == null) focusBeforeAlert = State.focusId;
  alertPill = pill;
  State.setFocus(pill);
  return true;
}

export function restoreAlertFocus(): void {
  if (!focusBeforeAlert) return;
  const prev = focusBeforeAlert;
  const borrowed = alertPill;
  focusBeforeAlert = null;
  alertPill = null;
  if (
    !State.pendingApproval &&
    State.focusId === borrowed &&
    borrowed !== prev &&
    State.tasks.some((t) => t.id === prev)
  ) {
    State.setFocus(prev);
  }
}

/** Events after which a pending permission request of the same session is moot. */
const TURN_OVER = new Set(["Stop", "StopFailure", "UserPromptSubmit", "SessionEnd", "Interrupt"]);

/**
 * The pills whose session waits for an answer in its own terminal, with no
 * card on the island: a request the island cannot put to you whole or cannot
 * answer for, or a prompt Claude Code shows that no hook asks about.
 */
const terminalWaits = new Set<string>();
/** Events that show the session has moved on from what waited in its terminal. */
const MOVED_ON = new Set([...TURN_OVER, "PreToolUse", "PostToolUse", "PostToolUseFailure"]);

/**
 * Claude Code's `notification_type` for a prompt it is showing in the terminal
 * and waiting on: a permission (also a sandboxed command's network request,
 * which no PermissionRequest announces) or an MCP server's form or link.
 */
const TERMINAL_PROMPTS = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog"]);

/**
 * The longest text the card asks you about, in characters. The card shows all
 * of it, three and a half lines at a time: a thousand characters are some
 * fifteen lines of its box, four screens of scrolling, which is about as much
 * as anyone reads there before pressing Allow. A longer one goes back to the
 * terminal, where it is shown whole at a size made for reading.
 */
export const REVIEW_LIMIT = 1000;

/**
 * True when `name` (from `agentId`'s session) shows the pending card was
 * settled somewhere else: the turn is over (interrupted, a new prompt, the
 * session ended), or the very tool call it asked about has run, so it was
 * allowed in the terminal or the Claude app. A tool result of another call (a
 * subagent working alongside) does not count. The relay hanging up is the
 * fastest sign of all; it arrives as `approval-expired`.
 */
export function settledElsewhere(
  pending: ApprovalInfo,
  name: string,
  agentId: string,
  sessionId: string,
  tool: string | undefined,
  input: Record<string, unknown> | undefined,
): boolean {
  if (pending.pillId !== agentId || pending.sessionId !== sessionId) return false;
  if (TURN_OVER.has(name)) return true;
  if (name !== "PostToolUse" && name !== "PostToolUseFailure") return false;
  const t = tool ?? "Tool";
  return t === pending.tool && approvalTarget(t, input ?? {}).text === pending.command;
}

/**
 * A prompt as the session's step line. Claude Code also submits text the
 * user never typed (a background task's `<task-notification>`, system
 * reminders, slash-command echoes): those show as their summary or command,
 * or not at all, never as raw tags.
 */
export function promptStep(raw: string): string | null {
  const tag = (name: string) => raw.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
  if (raw.includes("<task-notification>")) return tag("summary") ?? null;
  const command = tag("command-name");
  if (command) return command;
  const text = raw
    .replace(/<(system-reminder|local-command-\w+)>[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 60) : null;
}

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  /**
   * Stop: the turn's final answer (Markdown) — Claude Code's, Hermes's, Codex's.
   * StopFailure (Claude Code): the error as the conversation shows it.
   */
  last_assistant_message?: string;
  /** StopFailure (Claude Code): more about the error, when there is more. */
  error_details?: string;
  /** StopFailure (Claude Code): the kind of error ("rate_limit", "server_error"…). */
  error?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Set by the relay when an edit was too big to forward whole (> 256 KB). */
  liv_diff_truncated?: boolean;
  /** PermissionRequest: the fields of `tool_input` the relay had to cut short (hook/src/main.rs). */
  liv_cut?: unknown;
  /** Notification (Claude Code): which notification this is — "idle_prompt", "permission_prompt"… */
  notification_type?: unknown;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  liv_agent?: string;
  /** "agy_pre_tool": an Antigravity command Liv may show on the card (agents.ts). */
  liv_kind?: string;
  /** Hermes: where the session runs (telegram, discord…; "cli" in a terminal). */
  platform?: string;
  /** "cursor" when Claude Code runs in Cursor's terminal (set by the relay). */
  term_editor?: string;
  /** StatusLine (the plan usage relay): Claude Code's 5-hour and weekly limits. */
  rate_limits?: unknown;
  /** SubagentStart / SubagentStop: "Explore", "general-purpose"…; "" for Claude Code's own helpers. */
  agent_type?: string;
}

/**
 * What a StopFailure says went wrong, on one line: the error as the agent's
 * own conversation shows it, else its details, else the kind of error. Null
 * when the event says nothing (most agents only report that the turn failed).
 */
export function failureLine(payload: {
  last_assistant_message?: unknown;
  error_details?: unknown;
  message?: unknown;
  error?: unknown;
}): string | null {
  for (const said of [payload.last_assistant_message, payload.error_details, payload.message, payload.error]) {
    const line = typeof said === "string" ? toOneLine(said) : "";
    if (line) return line;
  }
  return null;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * localizedStep() — same labels as the macOS app, in English and shown in the
 * interface language (src/i18n) when the step is recorded.
 */
const TOOL_LABELS: Record<string, string> = {
  Bash: N_("Runs"),
  Read: N_("Reads"),
  Write: N_("Writes"),
  Edit: N_("Edits"),
  Glob: N_("Searches"),
  Grep: N_("Searches"),
  WebSearch: N_("Searches the web"),
  WebFetch: N_("Fetches"),
  TodoWrite: N_("Tasks"),
  Task: N_("Agent"),
  LS: N_("Lists"),
  MultiEdit: N_("Edits"),
  NotebookEdit: N_("Notebook"),
  PowerShell: N_("Runs"),
  // Antigravity's tools.
  run_command: N_("Runs"),
  view_file: N_("Reads"),
  write_to_file: N_("Writes"),
  replace_file_content: N_("Edits"),
  read_url_content: N_("Fetches"),
  search_web: N_("Searches the web"),
  ask_question: N_("Needs input"),
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const labelTool = tool === "ask_question" || tool.endsWith(":ask_question") ? "ask_question" : tool;
  const label = TOOL_LABELS[labelTool] ? t(TOOL_LABELS[labelTool]) : tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  if (
    (tool === "ask_question" || tool.endsWith(":ask_question")) &&
    Array.isArray(input.questions) &&
    input.questions.length > 0
  ) {
    const firstQ = input.questions[0];
    if (typeof firstQ === "object" && firstQ !== null && typeof (firstQ as Record<string, unknown>).question === "string") {
      const q = ((firstQ as Record<string, unknown>).question as string).trim();
      if (q) return `${label} · ${q.slice(0, 40)}`;
    }
  }
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Read, Write, Edit, MultiEdit
  "notebook_path", // NotebookEdit
  "path", // LS, Glob, Grep
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(
  tool: string,
  input: Record<string, unknown>,
): { text: string; field: string | null; value: string } {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return { text: `${tool} · ${value.trim()}`, field, value: value.trim() };
    }
  }
  // A tool that names none of these (an MCP server's, an agent's own): what it
  // would do is in its input, so that is what the card shows, all of it.
  const all = Object.keys(input).length > 0 ? JSON.stringify(input) : "";
  return { text: all ? `${tool} · ${all}` : tool, field: null, value: all };
}

/**
 * Whether the card can show all of what it would be asking about: the command,
 * path or address it names (`field`), or the whole input when it names none, is
 * neither something the relay had to cut short (`cut`, the payload's `liv_cut`)
 * nor longer than REVIEW_LIMIT. Allow is never offered on a text you only see
 * the beginning of.
 */
function shownWhole(target: { field: string | null; value: string }, cut: unknown[]): boolean {
  const wasCut = target.field ? cut.includes(target.field) : cut.length > 0;
  return !wasCut && target.value.length <= REVIEW_LIMIT;
}

/** The most questions one AskUserQuestion call asks, and the most options one of them has. */
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;

/**
 * The questions of an AskUserQuestion call, if the island can show all of them
 * as options to pick from. Anything it cannot is left to the terminal.
 */
function askedQuestions(tool: string, input: Record<string, unknown>): AskedQuestion[] | null {
  if (tool !== "AskUserQuestion" || !Array.isArray(input.questions)) return null;
  if (input.questions.length > MAX_QUESTIONS) return null;
  const out: AskedQuestion[] = [];
  for (const raw of input.questions as Record<string, unknown>[]) {
    const question = typeof raw?.question === "string" ? raw.question : "";
    const options = (Array.isArray(raw?.options) ? (raw.options as Record<string, unknown>[]) : [])
      .filter((o) => typeof o?.label === "string" && o.label)
      .map((o) => ({
        label: o.label as string,
        description: typeof o.description === "string" ? o.description : "",
      }));
    // A question cut short by the relay would be answered under the wrong text.
    if (!question || question.endsWith("…") || options.length < 2 || options.length > MAX_OPTIONS) return null;
    out.push({ question, options, multiSelect: raw.multiSelect === true });
  }
  return out.length > 0 ? out : null;
}

/** The Claude Code session's pill, named after its project for the session. */
function upsert(id: string, projectName: string, cwd: string, sessionId: string) {
  const t = State.upsertWorkspacePill(id, projectName, cwd);
  if (t && sessionId) t.sessionId = sessionId;
}

/** The session is over: the pill goes back as it was, or away if it was only there for it. */
function clearSession(id: string) {
  const t = State.tasks.find((x) => x.id === id);
  if (!t) return;
  if (!State.isKept(id)) {
    State.removeTask(id);
    return;
  }
  t.state = "idle";
  t.steps = [];
  t.stepIndex = 0;
  delete t.stepSeq;
  t.name = pillDefinition(id)?.name ?? t.name;
  t.pillBadge = null;
  t.sessionId = null;
  t.finalLine = null;
  t.errorLine = null;
}

/** The final message, or the error, stays on the card until the next turn starts. */
function clearFinalLine(id: string) {
  const t = State.tasks.find((x) => x.id === id);
  if (!t) return;
  t.finalLine = null;
  t.errorLine = null;
}

/**
 * PostToolUse of Edit / MultiEdit / Write → a diff stored for the pill and a
 * ticker step with its +N −M counts. Nothing is kept for a pill that does not
 * exist, so a stray event cannot grow memory. An edit the relay had to cut
 * would give wrong counts: the PreToolUse step ("Edits · file") stands alone.
 */
function recordDiff(agentId: string, payload: HookPayload) {
  if (payload.liv_diff_truncated) return;
  if (!State.tasks.some((t) => t.id === agentId)) return;
  const diff = buildFileDiff(payload.tool_name ?? "", payload.tool_input ?? {});
  if (!diff) return;
  const id = State.appendSessionDiff(agentId, diff);
  State.appendStep(agentId, makeDiffStep(fileName(diff.path), diff.added, diff.removed, id));
}

export function registerHookHandlers(island: Island) {
  // The last plan numbers seen survive a restart, as on the Mac.
  State.planUsage ??= restorePlanUsage(storedClaudePlanUsage());
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
  // The relay stopped waiting without a decision and the terminal has taken
  // over: a card still up for that request would be lying.
  void onEvent<string>("approval-expired", (requestId) => {
    dropQueued((x) => x.requestId === requestId);
    if (State.pendingApproval?.requestId !== requestId) return;
    dropPendingCard(island);
  });
}

/** Alerts force the island open; work events only reveal the compact island. */
export function surfaceIsland(island: Island, view: Parameters<Island["alert"]>[0], isAlert: boolean) {
  if (State.mode === "expanded") {
    if (isAlert) island.setView(view);
  } else if (isAlert) {
    island.alert(view);
  } else if (State.mode === "hidden") {
    island.reveal();
  }
}

/**
 * A session finished or failed, and its alert may take the screen
 * (showsAlert): on the open island its card comes up; on a folded one Liv
 * pops out in that state's colours, and a click on it opens the card. Where
 * Liv cannot come out (the island parked off-screen) the card opens as before.
 */
function announce(island: Island, view: "finished" | "error") {
  if (State.mode === "expanded") island.setView(view);
  else if (!island.peek(view, view)) island.alert(view);
}

function handleHook(island: Island, payload: HookPayload) {
  // Account-wide numbers from the status line relay, not part of any session:
  // keep the latest, nothing else (no reveal, no sound), paused or not.
  if (payload.hook_event_name === "StatusLine") {
    const usage = parseClaudePlan(payload.rate_limits);
    if (usage) setClaudePlanUsage(usage);
    return;
  }

  // Nobody can answer a card on an island that is paused, or parked off-screen
  // while another app is full screen. Silence here used to cost Claude Code
  // nearly two minutes: the relay waited for a decision from an island nobody
  // was looking at. Say so, and the terminal takes the question immediately.
  if ((State.paused || State.parked) && payload.request_id) {
    void Bridge.approvalDecline(payload.request_id);
    return;
  }
  // Paused, nothing else is listened to either; parked, the work goes on showing.
  if (State.paused) return;

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = raw || "Session";

  // Route to the right pill. Valid liv_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code's own pill: Cursor's
  // when it runs in Cursor's terminal, VS Code's otherwise.
  const validAgent = validateAgent(payload.liv_agent);
  const workspaceId = payload.term_editor === "cursor" ? CURSOR_ID : CLAUDE_ID;
  const agentId = validAgent ? `agent_${validAgent}` : workspaceId;
  const isExternalAgent = validAgent !== null;
  const sessionId = payload.session_id ?? "";

  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => surfaceIsland(island, view, isAlert);

  /** Ensure the agent pill exists (no-op for Claude Code). */
  const ensurePill = () => {
    if (isExternalAgent) {
      State.upsertExternalAgent(agentId, agentName(validAgent!), agentColor(validAgent!));
      const t = State.tasks.find((x) => x.id === agentId);
      if (t && cwd) t.sessionCwd = cwd;
      if (t && sessionId) t.sessionId = sessionId;
    } else {
      upsert(agentId, projectName, cwd, sessionId);
    }
  };

  /**
   * Called where a handler is about to replace `finished` with a newer state:
   * the timer Stop armed would otherwise put the pill back to idle over it. The
   * badge that timer was going to clear goes now.
   */
  const supersedeStop = () => {
    if (cancelStopTimer(agentId)) State.setPillBadge(agentId, null);
  };

  /**
   * The session waits for an answer in its own terminal and no card comes up
   * here: its pill says so (the state, a badge when it is not the one in
   * front, a line in its steps) until the session moves on.
   */
  const waitsInTerminal = (state: "approval" | "question") => {
    ensurePill();
    supersedeStop();
    State.updateTask(agentId, state);
    if (!terminalWaits.has(agentId)) {
      terminalWaits.add(agentId);
      State.appendStep(agentId, t("Waiting for you in the terminal"));
      // Parked off-screen for a full-screen app, the island asks for nothing aloud.
      if (!State.parked) Sound.play(state);
    }
    if (State.focusId !== agentId) State.setPillBadge(agentId, "approval");
    surface("overview", false);
  };

  // What waited in the terminal has its answer: the session is doing something else.
  if (MOVED_ON.has(name) && terminalWaits.delete(agentId)) State.setPillBadge(agentId, null);

  // Requests of a turn that is over still in line are moot: released at once,
  // before the card below goes, so none of them can take its place.
  if (TURN_OVER.has(name)) {
    const moot = dropQueued((x) => x.pillId === agentId && x.sessionId === (payload.session_id ?? ""));
    for (const x of moot) if (x.requestId) void Bridge.approvalDecline(x.requestId);
  }

  // The turn that asked for a permission is over — answered in the terminal,
  // interrupted, or a new prompt — so the card would be lying. It goes, and the
  // relay is released without a decision. Same rule as the Mac.
  const pending = State.pendingApproval;
  if (pending && settledElsewhere(pending, name, agentId, sessionId, payload.tool_name, payload.tool_input)) {
    if (pending.requestId) void Bridge.approvalDecline(pending.requestId);
    dropPendingCard(island);
  }

  // Read after the card above is dropped: its pill may have handed the front
  // back to the pill you were on.
  const focused = State.focusId === agentId;

  // Each Claude Code session teaches the launch card a project (Mac: SessionLauncher.remember).
  if ((name === "SessionStart" || name === "UserPromptSubmit") && !payload.liv_agent && cwd) Launch.remember(cwd);

  switch (name) {
    case "SessionStart":
      ensurePill();
      clearFinalLine(agentId);
      // Hermes through its gateway says where the session comes from.
      if (validAgent === "hermes" && payload.platform && payload.platform !== "cli") {
        State.appendStep(agentId, payload.platform.charAt(0).toUpperCase() + payload.platform.slice(1));
      }
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      supersedeStop();
      clearFinalLine(agentId);
      State.updateTask(agentId, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = promptStep(payload.prompt ?? payload.message ?? "");
      if (asked) State.appendStep(agentId, asked);
      // A new turn: the finished card would show the prompt as if it were the answer.
      if (State.mode === "expanded" && State.view === "finished" && State.focusId === agentId) island.setView("overview");
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      ensurePill();
      supersedeStop();
      clearFinalLine(agentId);
      const tool = payload.tool_name ?? "Tool";
      const isQuestion = tool === "ask_question" || tool.endsWith(":ask_question");
      if (isQuestion) {
        State.updateTask(agentId, "question");
        State.appendStep(agentId, stepLabel(tool, payload.tool_input ?? {}));
        Sound.play("question");
        surface("overview", true);
      } else {
        State.updateTask(agentId, "working");
        State.appendStep(agentId, stepLabel(tool, payload.tool_input ?? {}));
        surface("overview", false);
      }
      break;
    }

    case "PostToolUse":
      supersedeStop();
      // The question was answered in the terminal: the card would be lying.
      if (
        payload.tool_name === "AskUserQuestion" &&
        State.pendingApproval?.questions &&
        State.pendingApproval.sessionId === (payload.session_id ?? "")
      ) {
        dropPendingCard(island);
      }
      State.updateTask(agentId, "working");
      recordDiff(agentId, payload);
      break;

    case "PostToolUseFailure":
      supersedeStop();
      State.updateTask(agentId, "working");
      State.appendStep(agentId, t("⚠ failed"));
      break;

    case "Notification": {
      // Claude Code says which notification this is: nothing is guessed from its text.
      const kind = payload.notification_type;
      if (typeof kind === "string") {
        const task = State.tasks.find((x) => x.id === agentId);
        const sameSession = !task?.sessionId || !sessionId || task.sessionId === sessionId;
        const hasCard = [State.pendingApproval, ...State.approvalQueue].some(
          (x) => x?.pillId === agentId && x.sessionId === sessionId,
        );
        if (kind === "idle_prompt") {
          // A minute at its prompt with nothing typed: the turn is over, even
          // when no Stop said so (Claude Code sends none after an interrupt).
          const busy = task?.state === "working" || task?.state === "thinking" || terminalWaits.has(agentId);
          if (busy && sameSession && !hasCard) {
            supersedeStop();
            terminalWaits.delete(agentId);
            State.updateTask(agentId, "idle");
            State.setPillBadge(agentId, null);
          }
        } else if (TERMINAL_PROMPTS.has(kind) && !hasCard) {
          // A prompt in the terminal that no card here stands for.
          waitsInTerminal("approval");
        }
        break;
      }
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        supersedeStop();
        State.updateTask(agentId, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        supersedeStop();
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
      }
      break;
    }

    case "Stop": {
      State.updateTask(agentId, "finished");
      // Claude Code puts the turn's answer in the Stop payload itself, so there is
      // no transcript to read (the relay does not even forward its path). Other
      // agents report their last words the same way (Hermes, Codex) or as
      // `message`.
      const finalText = toOneLine(payload.last_assistant_message ?? payload.message ?? "");
      if (finalText) {
        State.appendStep(agentId, finalText);
        const t = State.tasks.find((x) => x.id === agentId);
        if (t) t.finalLine = finalText;
      }
      Sound.play("finish");
      // A card waiting for an answer is never covered by another alert.
      if (showsAlert(agentId, focused)) announce(island, "finished");
      else State.setPillBadge(agentId, "finished");
      cancelStopTimer(agentId);
      stopTimers.set(
        agentId,
        window.setTimeout(() => {
          stopTimers.delete(agentId);
          // While the island is open, or Liv is still out in its pocket, the
          // alert stays on its own pill, and the pill you had comes back when
          // the island closes or Liv goes back in (island.ts), as on the Mac.
          // An agent pill about to go hands the front back now.
          if (isExternalAgent || (State.mode !== "expanded" && State.mode !== "peek")) restoreAlertFocus();
          if (isExternalAgent) {
            State.removeTask(agentId);
          } else {
            State.updateTask(agentId, "idle");
            State.setPillBadge(agentId, null);
          }
        }, 5200),
      );
      break;
    }

    case "Interrupt":
      // Codex: the user stopped the turn. Back to idle, nothing to celebrate.
      supersedeStop();
      State.updateTask(agentId, "idle");
      State.setPillBadge(agentId, null);
      break;

    case "StopFailure": {
      supersedeStop();
      State.updateTask(agentId, "error");
      const failed = State.tasks.find((x) => x.id === agentId);
      if (failed) failed.errorLine = failureLine(payload);
      Sound.play("error");
      if (showsAlert(agentId, focused)) announce(island, "error");
      else State.setPillBadge(agentId, "error");
      break;
    }

    case "SessionEnd":
      // Nothing left for the timer to do, and it must not outlive the session: a
      // pill recreated within 5.2 s would be removed by it.
      cancelStopTimer(agentId);
      State.clearSessionDiffs(agentId);
      if (isExternalAgent) {
        State.removeTask(agentId);
      } else {
        State.updateTask(agentId, "idle");
        clearSession(agentId);
      }
      break;

    case "SubagentStart":
      State.appendStep(agentId, t("+ subagent"));
      break;

    case "SubagentStop":
      // Claude Code's own helpers (the prompt suggestion after each turn) end
      // with a SubagentStop of empty agent_type and never start one. Shown, it
      // pushed the turn's last edit off the ticker a few seconds after Stop.
      if (payload.agent_type === "") break;
      State.appendStep(agentId, t("• subagent done"));
      break;

    case "PermissionRequest": {
      // Only Claude Code and the agents the relay can answer for (Codex, Copilot
      // CLI, Muse Code, and Antigravity's commands when that is turned on — same
      // as the Mac) get a card. Anyone else's request is declined at once, so the
      // agent asks in its own terminal.
      if (isExternalAgent && !takesCard(validAgent, payload.liv_kind)) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // If this exact request is already showing or queued, ack again and leave it alone
      if (State.pendingApproval?.requestId === requestId || State.approvalQueue.some((x) => x.requestId === requestId)) {
        if (requestId) void Bridge.approvalAck(requestId);
        break;
      }

      // Several requests can wait at once (several sessions or agents): they
      // queue and the card shows the oldest. Past the cap, the newest goes back
      // to its own terminal.
      const totalPending = (State.pendingApproval ? 1 : 0) + State.approvalQueue.length;
      if (totalPending >= MAX_PENDING) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }

      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      // Claude Code (including Claude Desktop) asking a question is not a permission to grant: the island
      // shows the options and sends back the one that was picked.
      const isClaude = !isExternalAgent || validAgent === "claude-desktop";
      const cut = Array.isArray(payload.liv_cut) ? payload.liv_cut : [];
      const questions = isClaude && !cut.includes("questions") ? askedQuestions(tool, input) : null;
      const view = questions ? "question" : "approval";
      const target = approvalTarget(tool, input);

      // What the island cannot answer for, or cannot put to you whole, is asked
      // in the terminal, at once, and never shown as a card:
      // - Claude Code only takes an allow for AskUserQuestion and ExitPlanMode
      //   together with the answer (`updatedInput`); a bare Allow would leave
      //   its prompt up as if nothing had been clicked. A question the island
      //   cannot show as options, and a plan, have no answer to send from here.
      // - a command, path or address too long to review here, or cut by the relay.
      const noAnswerFromHere = isClaude && (tool === "ExitPlanMode" || (tool === "AskUserQuestion" && !questions));
      if (noAnswerFromHere || (!questions && !shownWhole(target, cut))) {
        if (requestId) void Bridge.approvalDecline(requestId);
        waitsInTerminal(tool === "AskUserQuestion" ? "question" : "approval");
        break;
      }

      ensurePill();
      supersedeStop();
      const info: ApprovalInfo = {
        requestId,
        sessionId,
        pillId: agentId,
        tool,
        command: target.text,
        ...(questions ? { questions } : {}),
      };

      // Liv answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      armRequestTimeout(island, requestId);
      Sound.play(view);
      if (State.pendingApproval) {
        // Another card is up: this one waits in line, its pill badged, and the
        // card on screen stays as it is.
        State.approvalQueue.push(info);
        State.setPillBadge(agentId, "approval");
        if (requestId) void Bridge.approvalAck(requestId);
        break;
      }
      // The card always comes up, even over another pill or an island that is
      // already open: its pill comes to the front, and the one you were on
      // comes back once you answer.
      State.beginApproval(info);
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(agentId, view);
      // Any agent's card (Claude Code, Codex, Copilot CLI, Muse Code) comes up
      // the same way: beginApproval brought its pill to the front.
      island.alert(view);
      break;
    }

    default:
      break;
  }
  State.notify();
}
