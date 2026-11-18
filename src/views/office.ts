// The virtual office's card — the overview's left card while the office's pill
// is in front (docs/OFICINA.md). Who is at work, how many things wait for the
// user, the line that matters most, and the way into the office.
//
// What it shows is worked out in core/office.ts (officeCard); this only draws
// it. Every text of the office's is set as text — a name, a title or a summary
// is never markup, never a class, never part of an address.

import { h, clear, dot } from "./dom";
import { State } from "../core/state";
import { OFFICE_PILL_ID, type OfficeAgentState, type OfficeCard, type OfficeDot } from "../core/office";
import { pillDefinition } from "../core/pills";
import { islandScale } from "../core/scale";
import { miniDot } from "../robot/mini";
import { currentOfficeCard, openOfficeUrl } from "../island/office";
import { N_, language, t, tn } from "../i18n/i18n";

/** The pieces every card is made of, as views.ts builds them. */
export interface CardParts {
  stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement;
  btn(label: string, kind: "primary" | "secondary", onClick: () => void): HTMLElement;
  /** The office's own box in Settings → Integrations, where its address is entered. */
  openSettings(): void;
}

/** Each agent's dot says its state — the colours the island already gives them. */
const STATE_COLORS: Record<OfficeAgentState, string> = {
  idle: "#8E939C",
  working: "#3B9EFF",
  waiting: "#F5A524",
  blocked: "#FC6D26",
  error: "#F4505E",
  done: "#22C55E",
  offline: "#4B5563",
};

/** …and its tooltip says it in words. */
const STATE_LABELS: Record<OfficeAgentState, string> = {
  idle: N_("no task"),
  working: N_("at work"),
  waiting: N_("waiting on you"),
  blocked: N_("held up"),
  error: N_("failed"),
  done: N_("task done"),
  offline: N_("no longer there"),
};

function stateLabel(agent: OfficeDot): string {
  return agent.stale ? t("no signal") : t(STATE_LABELS[agent.state]);
}

const parts = (...texts: (string | null)[]) => texts.filter((x) => x !== null).join(" — ");

/** The card's one line and what hovering it says in full. */
function headline(card: OfficeCard): { text: string; full: string } {
  const line = card.headline;
  switch (line.kind) {
    case "ask":
      return { text: line.title, full: parts(line.by, line.title, line.detail) };
    case "news":
      return { text: line.title, full: parts(line.by, line.title) };
    case "agent": {
      const text = `${line.agent.name} · ${line.agent.summary ?? stateLabel(line.agent)}`;
      return { text, full: text };
    }
    case "none": {
      const text = t("No news from the office yet.");
      return { text, full: text };
    }
  }
}

export function buildOfficeCard(make: CardParts): { el: HTMLElement; sync(): void } {
  const who = h("div", { class: "who-row office-who" });
  const title = h("div", {});
  const agents = h("div", { class: "office-agents" });
  const actions = h("div", { class: "actions" });
  const el = make.stack(108, 12, who, title, agents, actions);

  // Each row is rebuilt only when what it shows changes: a button replaced
  // between a mouse-down and a mouse-up would swallow the click.
  let shown = "";
  let shownActions = "";

  return {
    el,
    sync() {
      const card = currentOfficeCard();
      const color = State.tasks.find((x) => x.id === OFFICE_PILL_ID)?.color ?? pillDefinition(OFFICE_PILL_ID)!.color;
      // The island's size is in the key: the dots are painted for it.
      const scale = islandScale(State.settings.islandScale);

      const key = JSON.stringify([language(), color, scale, card]);
      if (key !== shown) {
        shown = key;
        clear(who);
        who.append(
          dot(color, 8),
          h("span", { class: "n", text: card.name ?? t("Office") }),
          card.waiting > 0
            ? h("span", {
                class: "office-waiting",
                text: tn("{count} waiting for you", "{count} waiting for you", card.waiting),
              })
            : h("span", {
                text: card.agents > 0
                  ? tn("{count} agent", "{count} agents", card.agents)
                  : t(pillDefinition(OFFICE_PILL_ID)!.subtitle),
              }),
        );

        // The card is 108 px tall: under the first row there is room for the
        // buttons and either two lines of text, or one line and the team. A
        // question for the user has to be read whole, so while one waits the
        // team makes way for it; with no team there are two lines anyway.
        const team = card.waiting === 0 ? card.dots : [];
        const line = headline(card);
        title.className = team.length > 0 ? "title one-line" : "title question-text";
        title.textContent = line.text;
        title.title = line.full;

        clear(agents);
        agents.style.display = team.length > 0 ? "" : "none";
        for (const agent of team) {
          const mark = miniDot(STATE_COLORS[agent.state], 13, scale);
          mark.title = parts(agent.name, agent.role, stateLabel(agent), agent.summary);
          if (agent.stale) mark.classList.add("stale");
          agents.append(mark);
        }
        if (team.length > 0 && card.more > 0) agents.append(h("span", { class: "more", text: `+${card.more}` }));
      }

      const actionsKey = JSON.stringify([language(), card.reviewUrl, card.officeUrl]);
      if (actionsKey !== shownActions) {
        shownActions = actionsKey;
        clear(actions);
        if (card.reviewUrl) {
          actions.append(make.btn(t("Review"), "primary", () => openOfficeUrl(card.reviewUrl)));
        }
        if (card.officeUrl) {
          actions.append(
            make.btn(t("Open office"), card.reviewUrl ? "secondary" : "primary", () => openOfficeUrl(card.officeUrl)),
          );
        }
        if (!card.reviewUrl && !card.officeUrl) {
          actions.append(h("button", {
            class: "link-btn sub", text: t("Set its address in Settings."), onclick: () => make.openSettings(),
          }));
        }
      }
    },
  };
}
