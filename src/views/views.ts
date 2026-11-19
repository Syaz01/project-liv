// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import {
  APPROVAL_LONG_H, approvalLineWidth, commandNeedsRoom, washRGBA, type IslandViewName, type Wash,
} from "../core/layout";
import { appearance } from "../core/appearance";
import { islandScale } from "../core/scale";
import { miniRobot } from "../robot/mini";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { highlightRow, listRows, openRow } from "./github";
import { pillDefinition, sessionSubtitle } from "../core/pills";
import {
  PlanCard, buildPlanPill, claudePillVisible, codexPillVisible, planCardOpen, refreshCodexPlanUsage,
} from "./usage";
import { buildDiffCard } from "./diff";
import { lastTextStep } from "../core/diff";
import { Bridge } from "../core/bridge";
import { chatReady, providerDef } from "../core/providers";
import { autoCloseChoices } from "../core/autoclose";
import { pillSettingsTarget, type SettingsTarget } from "../core/settings-target";
import { loadSubscriptions, subscription } from "../core/subscriptions";
import { addStars } from "./stars";
import { Downloads, useDownload } from "../island/downloads";
import { sizeLabel } from "../core/tools";
import { buildRecap } from "./recap";
import { buildUpdate } from "./update";
import { buildWhatsNew } from "./whatsnew";
import { buildLaunch } from "./launch";
import { buildWardrobe } from "./wardrobe";
import { buildTools } from "./tools";
import { buildSpotifyCard, buildSpotifyPill, type SpotifyPillHost } from "./spotify";
import { SPOTIFY_ID } from "../core/spotify";
import { buildOfficeCard } from "./office";
import { OFFICE_PILL_ID } from "../core/office";
import type { Outfit, OutfitChoice } from "../robot/outfits";
import { language, t, tl, tn, type Msg } from "../i18n/i18n";
import type { ViewCommand } from "../island/shortcuts";

export interface ViewActions {
  setView(v: IslandViewName): void;
  /** "Cancel" on a dropped file: forgets it and goes back home. */
  cancelDrop(): void;
  collapse(): void;
  /** Folds a waiting card to the compact island without answering it. */
  foldApproval(): void;
  setFocus(id: string): void;
  /** The header's office tab: the office's card, or where the office is set up while there is none. */
  openOffice(): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  /**
   * Allow or Deny, for the request the card showed when the button was pressed
   * (`requestId`): if another one has the card by now, nothing is answered.
   */
  decide(d: "allow" | "deny", requestId: string): void;
  /** Answers the question Claude Code asked: question text → chosen label. Same rule. */
  answer(answers: Record<string, string | string[]>, requestId: string): void;
  /** Hands the request back to the terminal. Same rule. */
  answerInTerminal(requestId: string): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  /** The Liv window: on General, or on the page and section the link is about. */
  openSettingsWindow(target?: SettingsTarget): void;
  blip(): void;
  /** The island takes the keyboard (a text field in a card) or gives it back. */
  keyboard(on: boolean): void;
  /** Something is being typed in a card: the island stays open until it is sent or cleared. */
  holdOpen(on: boolean): void;
  /** A Claude Code session was started from the launch card: the island folds. */
  launched(): void;
  /** The wardrobe: Liv tries `outfit` on while the pointer is on its chip; null puts back what it wears. */
  previewOutfit(outfit: Outfit | null): void;
  /** The wardrobe: what Liv wears from now on. */
  chooseOutfit(choice: OutfitChoice): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. True = needs another frame. */
  tick?(nowMs: number): boolean | void;
  /** Ctrl+O / Ctrl+E while the view is on screen (island/shortcuts.ts). */
  command?(command: ViewCommand): void;
  /** The open island's height for what the view shows now, when it is not its layout's (null). */
  height?(): number | null;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

/** The colour of a card's specks: the pill in front, as Liv's shell and its dot. */
function starColor(): string {
  return State.focusTask?.color ?? "#FFFFFF";
}

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string | Msg,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: tl("Overview"), onclick: () => goHome() }, svg(ICONS.house, 17));
  const tabChat = h("button", { class: "tab", title: tl("Ask"), onclick: () => go("prompt") }, svg(ICONS.bubbleRound, 19));
  const tabDrop = h("button", { class: "tab", title: tl("Drop"), onclick: () => go("upload") }, svg(ICONS.plus, 16));
  // A new Claude Code session, in a project, from here (Mac: the terminal tab).
  const tabLaunch = h(
    "button",
    { class: "tab", title: tl("New Claude Code session"), onclick: () => go("launch") },
    svg(ICONS.terminal, 17, { stroke: 1.7 }),
  );
  // The tools: what was copied, and the shelf.
  const tabTools = h(
    "button",
    { class: "tab", title: tl("Tools"), onclick: () => go("tools") },
    svg(ICONS.clipboard, 17, { stroke: 1.7 }),
  );

  // The virtual office (docs/OFICINA.md): its card once there is one, else
  // where it is set up.
  const tabOffice = h(
    "button",
    { class: "tab", title: tl("Office"), onclick: () => { actions.blip(); actions.openOffice(); } },
    svg(ICONS.office, 17, { stroke: 1.7 }),
  );

  const gearBtn = h("button", { title: tl("Settings"), onclick: () => go("settings") }, svg(ICONS.gearLine, 18, { stroke: 1.6 }));
  const soundBtn = h("button", { title: tl("Mute"), onclick: () => actions.toggleSound() }, svg(ICONS.speakerLine, 18, { stroke: 1.6 }));
  // Folds back to the compact island now, without waiting for the timer (the
  // Mac's ✕). A card waiting for an answer keeps the island open: no ✕ then.
  const closeBtn = h("button", { class: "close", title: tl("Close"), onclick: () => actions.collapse() }, svg(ICONS.xmark, 17));
  // Plan usage pills (off by default): before the gear, Claude first, as on the Mac.
  const claudePill = buildPlanPill(false);
  const codexPill = buildPlanPill(true);
  const planPills = h("div", { class: "plan-pills" }, claudePill.el, codexPill.el);
  let codexShown = false;

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  /** Home from the office's tab is the main pill again: the office has its own tab. */
  function goHome() {
    if (State.focusId === OFFICE_PILL_ID && State.mainPillId !== OFFICE_PILL_ID) actions.setFocus(State.mainPillId);
    else actions.blip();
    actions.setView("overview");
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop, tabLaunch, tabTools, tabOffice),
    h("div", { class: "header-actions" }, planPills, gearBtn, soundBtn, closeBtn),
  );
  const headerActions = el.lastElementChild as HTMLElement;

  return {
    el,
    sync() {
      const v = State.view;
      // The overview with the office's pill in front is the office's tab.
      const office = v === "overview" && State.focusId === OFFICE_PILL_ID;
      tabHome.classList.toggle("on", (v === "overview" || v === "empty") && !office);
      tabOffice.classList.toggle("on", office);
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      tabLaunch.classList.toggle("on", v === "launch");
      tabTools.classList.toggle("on", v === "tools");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(v === "settings" ? svg(ICONS.gearFill, 18) : svg(ICONS.gearLine, 18, { stroke: 1.6 }));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerLine : ICONS.speakerSlashLine, 18, { stroke: 1.6 }));
      closeBtn.style.display = State.pendingApproval ? "none" : "";
      syncPlanPills();
    },
  };

  function syncPlanPills() {
    const claudeOn = claudePillVisible();
    const codexOn = codexPillVisible();
    claudePill.el.style.display = claudeOn ? "" : "none";
    codexPill.el.style.display = codexOn ? "" : "none";
    planPills.classList.toggle("on", claudeOn || codexOn);
    // Both pills: the right side tightens so it still clears the screen edge.
    headerActions.classList.toggle("both-plans", claudeOn && codexOn);
    if (claudeOn) claudePill.sync();
    if (codexOn) codexPill.sync();
    // Codex is asked when its pill comes into view (stale answers only).
    const shown = codexOn && State.mode === "expanded";
    if (shown && !codexShown) refreshCodexPlanUsage();
    codexShown = shown;
  }
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  /** The diff open in the left card (a FileDiff id), as activeDiffId on macOS. */
  let activeDiffId: number | null = null;
  const closeDiff = () => {
    if (activeDiffId == null) return;
    activeDiffId = null;
    State.notify();
  };
  const ticker = new Ticker((diffId) => {
    actions.blip();
    activeDiffId = diffId;
    State.notify();
  });
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: tl("Open"), onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 12),
  );
  const left = card(null, leftBody, jump);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);
  // The specks of the Liv window (stars.ts), in the colour of the pill in
  // front: behind Liv on the left, and all over the pills' card.
  const leftStars = addStars(left, "side");
  const rightStars = addStars(right, "whole");
  // Opened from a plan pill in the header: stands in for the left card.
  const plan = new PlanCard();
  let planTimer: number | null = null;
  // Spotify's card and pill are kept and updated in place: the progress bar
  // runs on, and a slider being dragged must not be rebuilt under the pointer.
  const spotifyCard = buildSpotifyCard();
  let spotifyPill: SpotifyPillHost | null = null;
  // The virtual office's card, kept and updated in place too: its buttons
  // stay put while events keep coming.
  const officeCard = buildOfficeCard({
    stack, btn, openSettings: () => actions.openSettingsWindow(pillSettingsTarget(OFFICE_PILL_ID)),
  });

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | "plan" | "diff" | "spotify" | "office" | null = null;
  let cardKey = "";
  /** The list row highlighted at the last sync, to scroll only when it moves. */
  let shownSelection: number | null = null;

  // Leaving the overview or folding the island closes the diff, as on macOS.
  State.subscribe(() => {
    if (activeDiffId != null && (State.view !== "overview" || State.mode !== "expanded")) {
      activeDiffId = null;
    }
  });
  // Escape steps back out of the diff before it closes the island.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || activeDiffId == null || State.view !== "overview") return;
      e.stopImmediatePropagation();
      closeDiff();
    },
    true,
  );

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: (pillId) => actions.openSettingsWindow(pillSettingsTarget(pillId)),
  };

  /** The countdowns move every 30 s while a card is open, and only then. */
  function syncPlanTimer(open: boolean) {
    const stop = () => {
      if (planTimer != null) window.clearInterval(planTimer);
      planTimer = null;
    };
    if (!open) return stop();
    if (planTimer != null) return;
    planTimer = window.setInterval(() => {
      if (planCardOpen() && State.mode === "expanded") State.notify();
      else stop();
    }, 30_000);
  }

  return {
    el,
    tick(nowMs: number) {
      const color = starColor();
      const drifting = [leftStars.tick(nowMs, color), rightStars.tick(nowMs, color)].includes(true);
      if (mode !== "ticker") return drifting;
      ticker.tick(nowMs);
      return ticker.animating || drifting;
    },
    command(command) {
      if (command === "openSelection") {
        // Ctrl+O: what a click on the highlighted row does.
        if (mode !== "card" || State.cardSelection == null) return;
        openRow(listRows(leftBody)[State.cardSelection]);
        return;
      }
      // Ctrl+E (⌘E, islandToggleDiff): closes the diff that is open, else
      // opens the focused pill's latest edit.
      if (activeDiffId != null) {
        closeDiff();
        return;
      }
      const task = State.focusTask;
      const diffs = task ? State.sessionDiffs.get(task.id) : undefined;
      const last = diffs?.[diffs.length - 1];
      if (last?.id == null) return;
      activeDiffId = last.id;
      State.notify();
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        activeDiffId = null;
        cardKey = "";
        mode = null;
      }

      // A workspace or agent pill with a live session keeps the ticker; every
      // other pill shows its own card, exactly like IntegrationCardView.
      const sessionActive = task != null && hasSessionTicker(task);

      const planOpen = planCardOpen();
      if (mode === "plan" && !planOpen) {
        mode = null;
        cardKey = "";
      }
      syncPlanTimer(planOpen);

      // A diff that has since been dropped (cap, expiry, session end) just closes.
      const diff = task && activeDiffId != null ? State.findDiff(task.id, activeDiffId) : null;
      if (!diff) activeDiffId = null;

      if (planOpen) {
        if (mode !== "plan") {
          clear(leftBody);
          leftBody.append(plan.el);
          mode = "plan";
        }
        plan.sync();
      } else if (task && diff) {
        const key = `diff~${task.id}~${diff.id}`;
        if (key !== cardKey) {
          cardKey = key;
          mode = "diff";
          clear(leftBody);
          leftBody.append(buildDiffCard(diff, {
            dismiss: () => {
              actions.blip();
              closeDiff();
            },
            open: (path) => void Bridge.openFileInVSCode(path),
          }));
        }
      } else if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        // The agent's name is already the pill's: the label says what kind of
        // pill it is, as on the Mac (PillDefinition.sessionSubtitle).
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: t(sessionSubtitle(task.id)) }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task && task.id === SPOTIFY_ID) {
        // Its own card for every state: playing, idle, not installed.
        if (mode !== "spotify") {
          clear(leftBody);
          leftBody.append(spotifyCard.el);
          mode = "spotify";
          cardKey = "";
        }
        spotifyCard.sync();
      } else if (task && task.id === OFFICE_PILL_ID) {
        // Its own card too: what the office's events say, or just the way in.
        if (mode !== "office") {
          clear(leftBody);
          leftBody.append(officeCard.el);
          mode = "office";
          cardKey = "";
        }
        officeCard.sync();
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          language(), task.id, task.color, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen || mode === "plan" || mode === "diff" ? "none" : "";

      // Ctrl+↓ Ctrl+↑ walk the open GitHub list (cardItemCount / cardSelection).
      const rows = mode === "card" ? listRows(leftBody) : [];
      State.cardItemCount = rows.length;
      if (State.cardSelection != null && State.cardSelection >= rows.length) State.cardSelection = null;
      highlightRow(rows, State.cardSelection, State.cardSelection !== shownSelection);
      shownSelection = State.cardSelection;

      const others = State.otherTasks.slice(0, 4);
      // The island's size is in the key: the minis are painted for it.
      const pillKey = `${islandScale(State.settings.islandScale)}|` +
        others.map((t) => `${t.id}:${t.color}:${t.pillBadge ?? ""}:${t.name}`).join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        clear(pills);
        spotifyPill = null;
        for (const t of others) {
          if (t.id === SPOTIFY_ID) {
            spotifyPill = buildSpotifyPill(t, () => actions.setFocus(t.id));
            pills.append(spotifyPill.el);
          } else {
            pills.append(buildPill(t, actions));
          }
        }
        // No other pill (a fresh install declares none): the way to add some,
        // rather than a card with nothing in it.
        if (others.length === 0) {
          pills.append(h("button", {
            class: "link-btn",
            style: "grid-column:1 / -1;color:#8e939c",
            text: tl("Add pills…"),
            onclick: () => actions.openSettingsWindow({ page: "pills", anchor: "pills.active" }),
          }));
        }
      }
      spotifyPill?.sync();
    },
  };
}

/**
 * IntegrationCardView.agentSessionActive: a workspace tool or an agent — or
 * any other tagged agent — with something going on.
 */
export function hasSessionTicker(task: AgentTask): boolean {
  // A pill made for an agent's session (Gemini CLI, Codex… not declared) only
  // exists while that session does: it keeps the ticker from the first event.
  if (task.source === "agent" && !task.isIntegration) return true;
  const category = pillDefinition(task.id)?.category;
  const isSession = category === "workspace" || category === "agent" ||
    (category == null && task.id.startsWith("agent_"));
  return isSession && (task.state !== "idle" || task.steps.length > 0);
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.id === "integration_claude" ? pillDefinition(task.id)!.name : task.name;
  const mini = miniRobot(task.color, 24, islandScale(State.settings.islandScale));
  const pill = h(
    "div",
    { class: "pill", onclick: () => actions.setFocus(task.id) },
    mini,
    h("span", { class: "lbl", text: label }),
  );
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: tl("Nothing running right now.") }),
      h("div", { class: "sub", text: tl("Drop a file, or ask me anything.") }),
    ),
    h("div", { class: "grow" }),
    btn(tl("Ask Claude"), "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

/** How long a fresh permission card ignores clicks on its buttons. */
const CLICK_GUARD_MS = 600;

/**
 * The ⌃ in the corner of a waiting card: folds the island to its compact size
 * and leaves the request waiting — nothing is answered. Opening the
 * island again brings the card back.
 */
function foldButton(actions: ViewActions): HTMLElement {
  return h(
    "button",
    { class: "icon-btn fold", title: tl("Later — keep it waiting"), onclick: () => actions.foldApproval() },
    svg(ICONS.chevronUp, 8, { stroke: 2.4 }),
  );
}

/**
 * The buttons of a card that answers a request. Such a card comes up under a
 * pointer that was busy with something else, and the request it shows can give
 * way to the next one in line while the pointer is on it. So a button acts
 * for the request the card showed when the pointer went down on it, and not at
 * all in the first moments after that request took the card: a click meant for
 * the window underneath, or for the request before, answers nothing.
 */
class RequestButtons {
  private shown: string | null = null;
  private down: string | null = null;

  /** The request the card now shows (null: none). */
  show(requestId: string | null) {
    this.shown = requestId;
  }

  /** A press starts now: it is for the request on the card, unless that one has only just come up. */
  private press() {
    const fresh = performance.now() - State.approvalSince < CLICK_GUARD_MS;
    this.down = fresh ? null : this.shown;
  }

  /** Makes `button` one of the card's. */
  arm<T extends HTMLElement>(button: T): T {
    button.addEventListener("pointerdown", () => this.press());
    return button;
  }

  /** A click handler: `act` runs with the request the pointer went down on, once. */
  click(act: (requestId: string) => void): (event?: Event) => void {
    return (event) => {
      // A button pressed with the keyboard has no pointer going down first
      // (`detail` 0): the press is the click itself.
      if ((event as MouseEvent | undefined)?.detail === 0) this.press();
      const requestId = this.down;
      this.down = null;
      if (requestId != null) act(requestId);
    };
  }
}

/**
 * The width of `text` as `el` draws it on one line, in page pixels. Where
 * nothing can be measured (no canvas), as its widest font would draw it.
 */
function textWidth(el: HTMLElement, text: string): number {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return text.length * 7.3;
  const style = getComputedStyle(el);
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return ctx.measureText(text).width;
}

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" },
    card("amber", stack(116, 16, who, code, row), foldButton(actions)));
  let rowKey = "";
  const buttons = new RequestButtons();
  const answer = (label: Msg, kind: "primary" | "secondary", act: (requestId: string) => void, kbd?: string) =>
    buttons.arm(btn(label, kind, buttons.click(act), kbd));

  /** What the card asks about: the command, the file path or the URL, whole. */
  const asked = () => State.pendingApproval?.command || State.pendingApproval?.tool || "…";
  // Whether it takes more than the box's one line, measured once per request
  // and per width of the island (Settings → Appearance makes the line longer).
  let measured = "";
  let long = false;
  const isLong = () => {
    const line = approvalLineWidth(appearance(State.settings).width);
    const key = `${State.pendingApproval?.requestId ?? ""}\n${line}\n${asked()}`;
    if (key !== measured) {
      measured = key;
      long = commandNeedsRoom(asked(), (text) => textWidth(code, text), line);
    }
    return long;
  };
  // More of the command below what the box shows: its lower edge fades out.
  // Asked again when the box is scrolled and when its size changes (it takes
  // its height as the island opens).
  const markMore = () => {
    code.classList.toggle("more", code.scrollHeight - code.scrollTop - code.clientHeight > 1);
  };
  code.addEventListener("scroll", markMore);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(markMore).observe(code);

  return {
    el,
    height: () => (State.pendingApproval && isLong() ? APPROVAL_LONG_H : null),
    sync() {
      buttons.show(State.pendingApproval?.requestId ?? null);
      clear(who);
      who.append(agentWho(State.focusTask, t("needs permission")));
      // The whole point of approving here rather than in the terminal: this box
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking — all of it. On one line when it fits; else
      // wrapped, and scrolled inside the box past three lines and a half.
      if (code.textContent !== asked()) {
        code.textContent = asked();
        code.scrollTop = 0;
        markMore();
      }
      // Two buttons, built once per kind of card. Rebuilding them between a
      // mouse-down and a mouse-up would swallow the click. "Always" is gone until
      // the remembered-rules list exists to back it. Antigravity waits on the card:
      // a third button hands the command back to its own prompt in the terminal,
      // where its "Always allow" lives (as on the Mac).
      const agy = State.pendingApproval?.pillId === "agent_antigravity";
      const key = agy ? "agy" : "built";
      if (rowKey === key) return;
      rowKey = key;
      clear(row);
      row.append(
        answer(tl("Deny"), "secondary", (requestId) => actions.decide("deny", requestId), "N"),
        answer(tl("Allow"), "primary", (requestId) => actions.decide("allow", requestId), "Y"),
      );
      if (agy) row.append(answer(tl("Reply in terminal"), "secondary", (requestId) => actions.answerInTerminal(requestId)));
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title question-text" });
  const row = h("div", { class: "actions options" });
  const fold = foldButton(actions);
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row), fold));

  // Where we are in the request on screen: which question, what is answered so
  // far, and what is ticked in a pick-several question.
  let requestId = "";
  let index = 0;
  let answers: Record<string, string | string[]> = {};
  let picked = new Set<string>();
  // The buttons are only rebuilt when what they show changes: rebuilding them
  // between a mouse-down and a mouse-up would swallow the click.
  let rowKey = "";
  // As on the permission card: a button answers the request it was pressed on.
  const buttons = new RequestButtons();
  /** `act` for a press on the request this card still shows; any other press is dropped. */
  const press = (act: () => void) => buttons.click((pressedOn) => {
    if (pressedOn === requestId) act();
  });

  const next = (question: string, answer: string | string[], total: number) => {
    answers[question] = answer;
    picked = new Set();
    index += 1;
    if (index >= total) actions.answer(answers, requestId);
    else State.notify();
  };

  return {
    el,
    sync() {
      const questions = State.pendingApproval?.questions;
      buttons.show(questions ? State.pendingApproval!.requestId : null);
      clear(who);
      // Only a request that is waiting can be folded away and come back.
      fold.style.display = State.pendingApproval ? "" : "none";

      // A question that arrived as a notification has nothing to pick from.
      if (!questions) {
        who.append(agentWho(State.focusTask, t("is asking a question")));
        const task = State.focusTask;
        title.textContent = (task && lastTextStep(task.steps)) ?? t("Claude needs an answer.");
        if (rowKey !== "terminal") {
          rowKey = "terminal";
          clear(row);
          row.append(h("div", { class: "sub", text: tl("Answer it in your terminal.") }));
        }
        return;
      }

      if (State.pendingApproval!.requestId !== requestId) {
        requestId = State.pendingApproval!.requestId;
        index = 0;
        answers = {};
        picked = new Set();
      }
      const q = questions[Math.min(index, questions.length - 1)];
      const asking = questions.length > 1
        ? t("is asking ({index} of {total})", { index: index + 1, total: questions.length })
        : t("is asking");
      who.append(agentWho(State.focusTask, asking));
      title.textContent = q.question;
      title.title = q.question;

      const key = `${requestId}:${index}:${[...picked].join("|")}`;
      if (rowKey === key) return;
      rowKey = key;
      clear(row);
      for (const option of q.options) {
        const on = picked.has(option.label);
        const button = buttons.arm(btn(option.label, on ? "primary" : "secondary", press(() => {
          if (!q.multiSelect) {
            next(q.question, option.label, questions.length);
            return;
          }
          if (on) picked.delete(option.label);
          else picked.add(option.label);
          State.notify();
        })));
        if (option.description) button.title = option.description;
        row.append(button);
      }
      if (q.multiSelect) {
        const done = buttons.arm(btn(tl("Done"), "primary", press(() => {
          if (picked.size > 0) next(q.question, [...picked], questions.length);
        })));
        if (picked.size === 0) done.classList.add("off");
        row.append(done);
      }
      row.append(
        buttons.arm(h("button", {
          class: "link-btn",
          style: "color:#8e939c",
          text: tl("Answer in terminal"),
          onclick: press(() => actions.answerInTerminal(requestId)),
        })),
      );
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  // The buttons are built once per kind of card: rebuilding them between a
  // mouse-down and a mouse-up would swallow the click.
  let rowKey = "";
  return {
    el,
    sync() {
      const task = State.focusTask;
      const n8n = task?.id === "integration_n8n";
      clear(who);
      // agentWho already shows an agent's name: its label is just the kind.
      const whoLabel = n8n ? "n8n" : task?.source === "agent" ? t("Agent") : "Claude Code";
      who.append(agentWho(task, whoLabel));
      title.textContent = n8n ? t("Workflow stopped.") : t("Session stopped on an error.");
      // What the agent said went wrong, else the last step that is not a diff.
      detail.textContent = task?.errorLine || (task && lastTextStep(task.steps)) || t("No detail available.");

      // A session's way back is its terminal (the Claude app for a session
      // from there), as on the finished card; a workflow's is n8n.
      const key = n8n ? "n8n" : task?.id === "agent_claude-desktop" ? "claude" : "terminal";
      if (rowKey === key) return;
      rowKey = key;
      clear(row);
      row.append(
        key === "n8n"
          ? btn(tl("Open in n8n"), "primary", () => actions.openTarget())
          : btn(key === "claude" ? tl("Open Claude") : tl("Open terminal"), "primary", () => actions.openTerminal()),
        btn(tl("OK"), "secondary", () => actions.collapse()),
      );
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title one-line" });
  const open = btn(tl("Open terminal"), "primary", () => actions.openTerminal());
  const row = h("div", { class: "actions" },
    open,
    btn(tl("OK"), "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      const agent = State.focusTask?.source === "agent";
      who.append(agentWho(State.focusTask, agent ? t("finished") : t("Claude Code finished")));
      // The final message, else the last step that is not a diff (FinishedView).
      const task = State.focusTask;
      title.textContent = task?.finalLine || (task && lastTextStep(task.steps)) || t("Session finished");
      // Sessions from the Claude desktop app live there, not in a terminal.
      const label = task?.id === "agent_claude-desktop" ? t("Open Claude") : t("Open terminal");
      const span = open.firstElementChild as HTMLElement;
      if (span.textContent !== label) span.textContent = label;
    },
  };
}

// ── A download that finished ──────────────────────────────────────────────────

/**
 * The card of the last download (island/downloads.ts): its name, its size, and
 * what to do with it. The file is asked of Rust by the download's number; one
 * that has gone since says so, and only the way to its folder is left.
 */
export function buildDownload(actions: ViewActions): ViewHost {
  const who = h("div", { class: "who-row" });
  const title = h("div", { class: "title one-line" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  // Rebuilt only when what they act on changes: a button replaced between a
  // mouse-down and a mouse-up would swallow the click.
  let shown = "";
  return {
    el,
    sync() {
      const { latest, fresh, gone } = Downloads.state;
      clear(who);
      who.append(
        dot("#22C55E", 8),
        h("span", {
          class: "n",
          text: gone
            ? t("The file is no longer there")
            : fresh > 1
              ? tn("{count} download finished", "{count} downloads finished", fresh)
              : t("Download finished"),
        }),
        ...(latest && !gone ? [h("span", { text: sizeLabel(latest.size) })] : []),
      );
      title.textContent = latest?.name ?? t("No download yet.");
      title.title = latest?.name ?? "";

      const key = `${language()}|${latest?.id ?? 0}|${gone}`;
      if (key === shown) return;
      shown = key;
      clear(row);
      if (!latest) return;
      const id = latest.id;
      if (!gone) {
        row.append(
          btn(t("Open"), "primary", () => void useDownload("open", id).then((done) => done && actions.collapse())),
          btn(t("Show in folder"), "secondary", () => void useDownload("reveal", id)),
          // On the shelf it is at hand for later: the tools come up to show it there.
          btn(t("To the shelf"), "secondary", () => void useDownload("shelve", id).then((done) => done && actions.setView("tools"))),
        );
      } else {
        row.append(btn(tl("OK"), "secondary", () => actions.collapse()));
      }
    },
  };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const seg = h("div", { class: "seg" });
  // The choices are rebuilt only when they change, never under a click.
  let segKey = "";
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  // Whether the chat can answer with the provider picked: asked of Rust each
  // time this view comes on screen, never while it is not.
  let chatAnswers = false;
  let shown = false;
  async function askChat() {
    const p = providerDef(State.settings.chatProvider);
    const [, keyReady] = await Promise.all([loadSubscriptions(), p.key ? Bridge.keyReady(p.key) : null]);
    const ready = chatReady(State.settings, subscription(p.id), keyReady ?? false);
    if (ready === chatAnswers) return;
    chatAnswers = ready;
    State.notify();
  }
  State.subscribe(() => {
    const now = State.mode === "expanded" && State.view === "settings";
    if (now && !shown) void askChat();
    shown = now;
  });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: tl("Sound") }), volume),
    h("div", { class: "settings-row" }, svg(ICONS.timer, 12), autoLabel, seg),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: tl("Settings…"),
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  const stars = addStars(el.querySelector(".card") as HTMLElement, "side");

  return {
    el,
    tick: (nowMs: number) => stars.tick(nowMs, starColor()),
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      const current = Math.round(s.autoCloseInterval);
      autoLabel.textContent = t("Auto-close · {seconds}s", { seconds: current });
      // The usual choices, and the one picked in Settings when it is none of them.
      const choices = autoCloseChoices(current);
      const key = `${choices.join()}|${current}`;
      if (key !== segKey) {
        segKey = key;
        clear(seg);
        for (const seconds of choices) {
          seg.append(h(
            "button",
            { class: seconds === current ? "on" : "", onclick: () => actions.setAutoClose(seconds) },
            `${seconds}s`,
          ));
        }
      }
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot(chatAnswers ? "#22C55E" : "#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("download", buildDownload(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  map.set("recap", buildRecap(actions));
  map.set("update", buildUpdate());
  map.set("whatsNew", buildWhatsNew());
  map.set("launch", buildLaunch(actions));
  map.set("wardrobe", buildWardrobe(actions));
  map.set("tools", buildTools(actions));
  return map;
}
