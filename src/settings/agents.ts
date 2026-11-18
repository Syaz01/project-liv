// Settings → Agents: one section for every agent other than Claude Code, all
// going through the same steps — preview the exact diff, click to confirm, and
// only then does agents.rs back the file up and write it.

import { Bridge, type AgentHookStatus, type AgyApprovalsStatus } from "../core/bridge";
import { clear, h } from "../views/dom";
import { renderDiff, statusDot } from "./parts";
import { t } from "../i18n/i18n";

/** In the current language (src/i18n); the settings window redraws on a change. */
const TEXT = {
  get title() { return t("Agents"); },
  get intro() {
    return t("Show other coding agents in the island. Liv adds its entries to each agent's own config: you see the exact change and where the backup goes before anything is written, and uninstalling removes only what Liv added.");
  },
  get none() { return t("Liv could not list the agents."); },
  get approvals() { return t("Sessions, and Allow / Deny from the island"); },
  get displayOnly() { return t("Sessions — approvals stay in the agent"); },
  get install() { return t("Install…"); },
  get reinstall() { return t("Reinstall…"); },
  get uninstall() { return t("Uninstall…"); },
  get relayMissing() { return t("The relay isn't installed yet. Restart Liv."); },
  // Antigravity: the Mac's own strings (hooks.antigravity.approvals*, Settings → Antigravity).
  get agyApprovals() { return t("Approve commands from the island"); },
  get agyApprovalsOn() { return t("Before Antigravity runs a shell command that none of its rules covers, the island asks you first: Allow, Deny or Reply in terminal. Antigravity waits up to 2 min, then asks in its terminal. Liv can't see Antigravity's mode, so in Auto mode the island also asks about commands Antigravity would have run on its own."); },
  get agyApprovalsOff() { return t("Antigravity asks for permission in its terminal, as usual."); },
  get agyApprovalsUpdate() { return t("Click Install hooks once more, then restart Antigravity: hooks from an older Liv don't let it wait for your answer."); },
  previewInstall: (name: string) => t("This is exactly what changes for {name}. Nothing else is touched.", { name }),
  get previewRemove() { return t("This removes Liv's entries only. Everything else stays."); },
  backup: (to: string) => (to ? t("Backup → {path}", { path: to }) : t("No existing file — nothing to back up.")),
  get confirmInstall() { return t("Back up and write"); },
  get confirmRemove() { return t("Back up and remove"); },
  get cancel() { return t("Cancel"); },
  get back() { return t("Back"); },
  done: (backups: string, note: string) => {
    const saved = backups
      ? t("Done. Previous version saved as {paths}.", { paths: backups.split("\n").join(", ") })
      : t("Done.");
    return `${saved} ${note}`;
  },
  failed: (err: unknown) => t("Could not write: {error}", { error: errorText(err) }),
};

function errorText(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "");
}

export function agentsSection(list: AgentHookStatus[] | null): HTMLElement {
  const blocks = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  if (!list || list.length === 0) {
    blocks.append(h("div", { class: "hint", text: TEXT.none }));
  }
  for (const status of list ?? []) blocks.append(agentBlock(status));
  return h(
    "section",
    { "data-anchor": "agents.others" },
    h("h2", {}, h("span", { text: TEXT.title })),
    h("div", { class: "hint", text: TEXT.intro }),
    blocks,
  );
}

function agentBlock(initial: AgentHookStatus): HTMLElement {
  let status = initial;
  /** Antigravity only: Approve commands from the island. */
  let agy: AgyApprovalsStatus | null = null;
  const head = h("div", { class: "row" });
  const body = h("div", { style: "display:flex;flex-direction:column;gap:10px" });
  const block = h("div", { style: "display:flex;flex-direction:column;gap:8px" }, head, body);

  async function refresh() {
    const fresh = (await Bridge.agentHooksList())?.find((a) => a.id === status.id);
    if (fresh) status = fresh;
    if (status.id === "antigravity") agy = await Bridge.agyApprovalsStatus();
    draw();
  }

  function draw() {
    clear(head);
    clear(body);
    const install = h("button", {
      class: "primary",
      text: status.installed ? TEXT.reinstall : TEXT.install,
      onclick: () => void showPreview(true),
    });
    // A hook pointing at a relay that isn't there would break the agent's hooks.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = TEXT.relayMissing;
    }
    head.append(
      h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px" },
        statusDot(status.installed),
        h("span", { style: "font-size:12.5px", text: status.name }),
      ),
      h("span", { class: "hint", text: status.approvals || agy?.enabled ? TEXT.approvals : TEXT.displayOnly }),
      h("span", { class: "spacer" }),
      install,
    );
    if (status.installed) {
      head.append(h("button", {
        class: "danger",
        text: TEXT.uninstall,
        onclick: () => void showPreview(false),
      }));
    }
    body.append(h("span", { class: "path", text: status.path }));
    if (status.id === "antigravity" && status.installed && agy) body.append(agyApprovalsRow(agy));
  }

  /**
   * Antigravity's commands waiting for Allow / Deny on the island, as on the Mac: off by
   * default, shown once the hooks are installed. Hooks written by an older Liv give
   * Antigravity 10 s, too short to wait for a click: they must be installed again.
   */
  function agyApprovalsRow(current: AgyApprovalsStatus): HTMLElement {
    const hint = h("div", { class: "hint" });
    const update = h("div", { class: "notice warn", text: TEXT.agyApprovalsUpdate });
    const note = h("div", { class: "hint" });
    // The same switch as every other setting's; it shows what Rust holds, so
    // a change that could not be saved leaves it where it was.
    const sw = h("button", { class: "switch" });
    const show = (s: AgyApprovalsStatus) => {
      sw.classList.toggle("on", s.enabled);
      sw.setAttribute("aria-pressed", String(s.enabled));
      hint.textContent = s.enabled ? TEXT.agyApprovalsOn : TEXT.agyApprovalsOff;
      update.style.display = s.enabled && !s.hooksReady ? "" : "none";
    };
    sw.addEventListener("click", () => {
      void (async () => {
        note.textContent = "";
        try {
          agy = await Bridge.agyApprovalsSetEnabled(!sw.classList.contains("on"));
          show(agy);
        } catch (err) {
          note.textContent = errorText(err);
        }
      })();
    });
    show(current);
    return h(
      "div",
      { style: "display:flex;flex-direction:column;gap:4px" },
      h("div", { class: "row" }, h("label", { text: TEXT.agyApprovals }), sw),
      hint,
      update,
      note,
    );
  }

  async function showPreview(install: boolean) {
    let plan;
    try {
      plan = await Bridge.agentHooksPreview(status.id, install);
    } catch (err) {
      // An unreadable or unexpected config stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: errorText(err) }),
        h("div", { class: "row" }, h("button", { text: TEXT.back, onclick: draw })),
      );
      return;
    }
    clear(body);
    body.append(
      h("div", { class: "hint", text: install ? TEXT.previewInstall(status.name) : TEXT.previewRemove }),
      renderDiff(plan.diff),
      h("div", { class: "row" }, h("span", { class: "path", text: TEXT.backup(plan.backup) })),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? TEXT.confirmInstall : TEXT.confirmRemove,
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backups = await Bridge.agentHooksApply(status.id, install, plan.fingerprint);
        clear(body);
        body.append(h("div", { class: "notice ok", text: TEXT.done(backups, install ? status.note : "") }));
        window.setTimeout(() => void refresh(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: TEXT.failed(err) }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", { text: TEXT.cancel, onclick: draw })));
  }

  draw();
  if (status.id === "antigravity") void refresh();
  return block;
}
