// The Liv window (settings.html): under Island, every setting of the island
// — the place where anything that writes to disk is confirmed. The window's
// frame and the pages that draw themselves live in ../hub; the island's
// settings are drawn here, one page at a time.

import "./settings.css";
import { Bridge, onEvent, type HookPreview, type HookStatus, type ShortcutsReport, type SubscriptionStatus } from "../core/bridge";
import { CUSTOM_SERVER_KEY, providerDef, urlExposure } from "../core/providers";
import {
  ISLAND_SHORTCUTS, SHORTCUTS, SHORTCUT_TEXT, activeKeys, displayKeys, duplicates, effective,
  recordPress, type Binding,
} from "../core/shortcuts";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { loadSubscriptions, pillTool, setSubscriptions } from "../core/subscriptions";
import { closedIsland } from "../core/closed";
import { safeUrl } from "../core/office";
import { guardPage } from "../core/guards";
import { ISLAND_SCALES, clampedScale, islandScale, scaleLabel } from "../core/scale";
import { PET_EVENTS } from "../pet/wire";
import { OUTFIT_CHOICES, outfitChoice, wornOutfit } from "../robot/outfits";
import type { UpdateStatus } from "../core/update";
import { SOUND_NAMES } from "../core/sound";
import {
  MAX_DECLARED, PILL_CATALOG, PILL_CATEGORIES, chooseMainPill, mainPillChoices,
  sanitizeDeclared, toggleDeclared, type PillDefinition,
} from "../core/pills";
import { h, clear } from "../views/dom";
import { writeClipboard } from "../views/markdown";
import { startHub, type PageId } from "../hub/shell";
import { dressTroupe } from "../hub/hero";
import { claudeModelControl } from "./claude-models";
import { agentsSection } from "./agents";
import { appearanceSection } from "./appearance";
import { updateRows, updatesListener } from "./updates";
import { colorDot } from "./colors";
import { renderDiff, statusDot } from "./parts";
import {
  LANGUAGES, N_, onLanguageChange, resolveLanguage, setLanguage, systemLanguages, t, tn,
} from "../i18n/i18n";

/** Where secrets.rs keeps the keys on this OS (a key of the string table, shown with `t`). */
const KEY_STORE = navigator.userAgent.includes("Windows")
  ? N_("Windows Credential Manager")
  : N_("Secret Service (GNOME Keyring, KWallet)");

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const windowRoot = document.getElementById("hub")!;
/** Where the page being shown draws its sections. */
let root: HTMLElement = windowRoot;
let hub: { redraw(): void } | null = null;

async function save() {
  await Bridge.saveSettings(settings);
}

/**
 * The Liv of the General page wears what Liv wears. "Auto" follows the
 * season, so today counts: asked when the window starts, when it is shown
 * and when the settings change — never by a timer.
 */
function dressLiv() {
  dressTroupe(wornOutfit(outfitChoice(settings.livOutfit), new Date()));
}

/** A colour was picked for a pill's figure (see ./colors.ts): the island follows. */
function pickColor(next: Record<string, string>) {
  settings.pillColors = next;
  void save();
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

/** Shows a switch made by toggle() as on or off, without calling its onChange. */
function setSwitch(el: HTMLElement, on: boolean) {
  el.classList.toggle("on", on);
  el.setAttribute("aria-pressed", String(on));
}

// ── Changes to Claude Code's settings.json ────────────────────────────────────

/** One kind of change to ~/.claude/settings.json, with the words that go with it. */
interface Change {
  preview: (install: boolean) => Promise<HookPreview | null>;
  apply: (install: boolean, fingerprint: string) => Promise<string | null>;
  installText: string;
  removeText: string;
  installButton: string;
  removeButton: string;
  /** The note once written; `backup` is "" when there was no file to back up. */
  done: (backup: string) => string;
}

const HOOKS_CHANGE: Change = {
  preview: Bridge.hooksPreview,
  apply: Bridge.hooksApply,
  get installText() { return t("This is exactly what will change in your settings.json. Your own hooks are left untouched."); },
  get removeText() { return t("This removes Liv's entries only. Your own hooks are left untouched."); },
  get installButton() { return t("Back up and write"); },
  get removeButton() { return t("Back up and remove"); },
  done: (backup) => backup
    ? t("Done. Previous settings saved as {backup}. Open a new Claude Code session to pick the hooks up.", { backup })
    : t("Done. Open a new Claude Code session to pick the hooks up."),
};

const STATUS_LINE_CHANGE: Change = {
  preview: Bridge.statusLinePreview,
  apply: Bridge.statusLineApply,
  get installText() { return t("This is exactly what will change: only the status line. If you already have one it keeps working, Liv's relay runs it for you."); },
  get removeText() { return t("This puts your previous status line back, or removes the entry if there was none."); },
  get installButton() { return t("Back up and write"); },
  get removeButton() { return t("Back up and remove"); },
  done: (backup) => backup
    ? t("Done. Previous settings saved as {backup}. The numbers appear after the next reply of a Claude Code session.", { backup })
    : t("Done. The numbers appear after the next reply of a Claude Code session."),
};

/**
 * Shows the diff of a change in `body` and writes it only after an explicit
 * click, and only if settings.json still matches the diff that was shown.
 * `back` redraws the section; `applied` runs a moment after a successful write.
 */
async function reviewChange(
  body: HTMLElement,
  change: Change,
  install: boolean,
  back: () => void,
  applied: () => void,
) {
  let preview;
  try {
    preview = await change.preview(install);
  } catch (err) {
    // An unreadable or invalid settings.json stops here rather than being
    // treated as empty and written over.
    clear(body);
    body.append(
      h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
      h("div", { class: "row" }, h("button", { text: t("Back"), onclick: back })),
    );
    return;
  }
  if (!preview) return;
  clear(body);
  body.append(
    h("div", { class: "hint", text: install ? change.installText : change.removeText }),
    renderDiff(preview.diff),
    h("div", { class: "row" },
      h("span", {
        class: "path",
        text: preview.backup
          ? t("Backup → {path}", { path: preview.backup })
          : t("No settings.json yet — nothing to back up."),
      }),
    ),
  );
  const confirm = h("button", {
    class: install ? "primary" : "danger",
    text: install ? change.installButton : change.removeButton,
  });
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      const backup = await change.apply(install, preview.fingerprint);
      clear(body);
      body.append(h("div", { class: "notice ok", text: change.done(backup ?? "") }));
      window.setTimeout(applied, 2600);
    } catch (err) {
      confirm.disabled = false;
      body.append(h("div", { class: "notice err", text: t("Could not write: {error}", { error: String(err) }) }));
    }
  });
  body.append(h("div", { class: "row" }, confirm, h("button", { text: t("Cancel"), onclick: back })));
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    { "data-anchor": "agents.claude-code" },
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const redraw = () => {
    clear(body);
    draw();
  };
  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    redraw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? t("Liv is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there.")
          : t("Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing."),
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: t("Relay") }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: t("The relay is missing: reinstall Liv."),
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? t("Reinstall hooks…") : t("Install hooks…"),
      onclick: () => void reviewChange(body, HOOKS_CHANGE, true, redraw, () => void rebuild()),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = t("The relay isn't installed yet.");
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: t("Uninstall hooks…"),
        onclick: () => void reviewChange(body, HOOKS_CHANGE, false, redraw, () => void rebuild()),
      }));
    }
    body.append(actions);
  }

  draw();
  return section;
}

// ── Plan usage section ────────────────────────────────────────────────────────

/**
 * The 5-hour and weekly limits in the island's header. They come from Claude
 * Code's status line, so the relay has to be the status line first: turning the
 * switch on without it starts the install, and the switch only stays on once
 * that has been confirmed. A status line the user had keeps working.
 */
const PLAN_SETTINGS_TEXT = {
  get claude() { return t("Shows your Claude plan usage (5-hour and weekly limits) in the island's header. Liv adds a status line relay in ~/.claude/settings.json. If you already have a status line, it keeps working as before. Pro and Max plans only."); },
  get claudeCli() { return t("The numbers come from the Claude Code command-line tool. The Claude desktop app does not report them, so the gauge stays empty if you only use the desktop app."); },
  get showClaude() { return t("Show in the island's header"); },
  get showClaudeCompact() { return t("Show in compact island"); },
  get codex() { return t("Shows your Codex plan usage (weekly limit and free resets left) in the island's header. Liv asks the Codex CLI (codex app-server) when the pill shows; nothing is installed. Codex must be signed in with ChatGPT."); },
  get showCodex() { return t("Show Codex plan in the island's header"); },
};

function planSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h("section", { "data-anchor": "agents.plan" }, h("h2", {}, h("span", { text: t("Plan usage") })), body);

  const redraw = () => {
    clear(body);
    draw();
  };
  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    settings.planRelayInstalled = status.planRelayInstalled;
    // Cancelled or failed: a switch that was waiting for the install falls back.
    if (!status.planRelayInstalled) {
      settings.showPlanInNotch = false;
      settings.showPlanInCompactIsland = false;
    }
    redraw();
  };

  function draw() {
    // The switch shows "on" while the install it asked for is being reviewed.
    const sw = toggle(settings.showPlanInNotch, (on) => {
      if (!on) {
        settings.showPlanInNotch = false;
        void save();
      } else if (status.planRelayInstalled) {
        settings.showPlanInNotch = true;
        void save();
      } else {
        // Turned on before the relay is in: install it first; it stays on once confirmed.
        void reviewChange(body, STATUS_LINE_CHANGE, true, () => void rebuild(), () => {
          settings.planRelayInstalled = true;
          settings.showPlanInNotch = true;
          void save().then(rebuild);
        });
      }
    });
    const swCompact = toggle(settings.showPlanInCompactIsland, (on) => {
      if (!on) {
        settings.showPlanInCompactIsland = false;
        void save();
      } else if (status.planRelayInstalled) {
        settings.showPlanInCompactIsland = true;
        void save();
      } else {
        void reviewChange(body, STATUS_LINE_CHANGE, true, () => void rebuild(), () => {
          settings.planRelayInstalled = true;
          settings.showPlanInCompactIsland = true;
          void save().then(rebuild);
        });
      }
    });
    body.append(
      h("div", {
        class: "hint",
        text: PLAN_SETTINGS_TEXT.claude,
      }),
      h("div", { class: "hint", text: PLAN_SETTINGS_TEXT.claudeCli }),
      h("div", { class: "row" }, h("label", { text: PLAN_SETTINGS_TEXT.showClaude }), sw),
      h("div", { class: "row" }, h("label", { text: PLAN_SETTINGS_TEXT.showClaudeCompact }), swCompact),
      h("div", { class: "row" },
        h("label", { text: t("Relay") }),
        statusDot(status.planRelayInstalled),
        h("span", { class: "hint", text: status.planRelayInstalled ? t("installed") : t("not installed") }),
        status.planRelayInstalled
          ? h("button", {
              class: "danger",
              text: t("Uninstall relay…"),
              onclick: () => void reviewChange(body, STATUS_LINE_CHANGE, false, redraw, () => void rebuild()),
            })
          : h("button", {
              class: "primary",
              text: t("Install relay…"),
              onclick: () => void reviewChange(body, STATUS_LINE_CHANGE, true, redraw, () => void rebuild()),
            }),
      ),
      // Codex: nothing to install, Liv asks the Codex CLI when the pill shows.
      h("div", { class: "hint", text: PLAN_SETTINGS_TEXT.codex }),
      h("div", { class: "row" },
        h("label", { text: PLAN_SETTINGS_TEXT.showCodex }),
        toggle(settings.showCodexPlanInNotch, (on) => {
          settings.showCodexPlanInNotch = on;
          void save();
        }),
      ),
    );
  }

  draw();
  return section;
}

// ── Your AI subscriptions ─────────────────────────────────────────────────────

/** The plan people know, by provider. */
const SUBSCRIPTION_NAMES: Record<string, string> = {
  anthropic: "Claude", google: "Google Gemini", openai: "ChatGPT", cursor: "Cursor", copilot: "GitHub Copilot",
};

/**
 * One switch per provider (cli_relay.rs): on, the chat goes through its
 * official terminal tool, signed in with the user's own account; off, through
 * its API key. Says whether the tool is installed and how to sign in.
 */
function subscriptionsSection(): HTMLElement {
  const list = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const draw = (rows: SubscriptionStatus[]) => {
    clear(list);
    for (const row of rows) {
      const p = providerDef(row.provider);
      const sw = toggle(row.on, (on) => {
        void Bridge.subscriptionSet(row.provider, on).then((next) => {
          setSubscriptions(next);
          if (next) draw(next);
        });
      });
      const lines: HTMLElement[] = [];
      if (row.installed) {
        lines.push(h("div", { class: "hint", style: "color:#22c55e", text: t("{tool} found ✓", { tool: row.tool }) }));
        lines.push(h("div", {
          class: "hint",
          text: t("Not signed in yet? Run this once in a terminal: {command}", { command: row.signIn }),
        }));
      } else {
        lines.push(h("div", { class: "row" },
          h("span", { class: "hint", text: t("{tool} not found.", { tool: row.tool }) }),
          h("button", { text: t("Install it"), onclick: () => void Bridge.openUrl(row.installUrl) }),
        ));
      }
      if (!row.subscriptionOnly && !row.on) {
        lines.push(h("div", { class: "hint", text: t("Off: the chat uses your API key below.") }));
      }
      list.append(h("div", {},
        h("div", { class: "row" },
          h("i", { class: "dot", style: `background:${p.accent}` }),
          h("label", { text: SUBSCRIPTION_NAMES[row.provider] ?? p.name }),
          sw,
        ),
        ...lines,
      ));
    }
  };
  void loadSubscriptions().then((rows) => draw(rows));
  return h(
    "section",
    { "data-anchor": "chat.subscriptions" },
    h("h2", { text: t("Your AI subscriptions") }),
    h("div", {
      class: "hint",
      text: t("Chat on the plan you already pay for. Liv asks your AI's official terminal tool, signed in with your own account: it never sees your password or your key."),
    }),
    list,
  );
}

// ── Claude API section ────────────────────────────────────────────────────────

/** The state line under Claude: the key, else Claude Code (switched on above), else what is missing. */
function apiState(hasKey: boolean, relay: boolean): string {
  if (hasKey) return t("Key saved in the {store}.", { store: t(KEY_STORE) });
  return relay
    ? t("No key: the chat can go through your Claude subscription above.")
    : t("No key yet — the chat needs one.");
}

function apiSection(hasKey: boolean, relay: boolean): HTMLElement {
  const dot = statusDot(hasKey || relay);
  const state = h("span", { class: "hint", text: apiState(hasKey, relay) });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? `••••••••••••  ${t("(stored)")}` : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: t("Save key") });
  const clearBtn = h("button", { class: "danger", text: t("Remove") });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    const ready = (await Bridge.claudeReady()) ?? false;
    dot.style.background = ready ? "#22c55e" : "#f4505e";
    state.textContent = apiState(present, ready && !present);
    field.placeholder = present ? `••••••••••••  ${t("(stored)")}` : "sk-ant-...";
    clearBtn.style.display = present ? "" : "none";
    void model.reload(present);
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: t("Saved. It never touches disk.") }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: t("Could not save: {error}", { error: String(err) }) }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: t("Key removed.") }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: t("Could not remove: {error}", { error: String(err) }) }));
    }
  });

  const model = claudeModelControl(() => settings.model, async (value) => {
    await Bridge.saveSettings({ ...settings, model: value });
    settings.model = value;
  });
  void model.reload(hasKey);

  clearBtn.style.display = hasKey ? "" : "none";

  return h(
    "section",
    { "data-anchor": "chat.claude" },
    h("h2", {}, dot, h("span", { text: "Claude" })),
    state,
    h("div", { class: "row" }, h("label", { text: t("API key") }), field, saveBtn, clearBtn),
    model.element,
    feedback,
  );
}

// ── Active pills section ──────────────────────────────────────────────────────

/**
 * The tools you use: pick the main workspace tool, which is
 * always on and takes no slot, and declare the agents and chat providers you
 * want as pills. Services are declared in Integrations below, next to their keys.
 */
function activePillsSection(connected: Record<string, boolean>): HTMLElement {
  const slots = h("div", { class: "hint" });
  const main = h("select", {}) as HTMLSelectElement;
  for (const def of mainPillChoices()) main.append(h("option", { value: def.id, text: def.name }));
  main.addEventListener("change", () => {
    const next = chooseMainPill(settings, main.value);
    if (!next) return;
    settings.mainPill = next.mainPill;
    settings.activeIntegrations = next.activeIntegrations;
    declaredChanged();
  });
  const groups = h("div", { style: "display:flex;flex-direction:column;gap:12px" });

  /** Why a pill would show nothing yet, as on the Mac's row. */
  function hint(def: PillDefinition): string | null {
    if (def.connect.kind === "hooks" && !connected[def.id]) return t("Hooks not installed");
    if (def.connect.kind === "key" && !connected[def.id] && !pillTool(def.id)) return t("Key not configured");
    if (def.connect.kind === "server" && !settings[def.connect.field]) return t("Not connected");
    return null;
  }

  function row(def: PillDefinition): HTMLElement {
    const isMain = def.id === settings.mainPill;
    const on = settings.activeIntegrations.includes(def.id);
    const full = !isMain && !on && settings.activeIntegrations.length >= MAX_ACTIVE;
    const el = h("div", { class: full ? "pill-row full" : "pill-row" },
      colorDot(def, "width:10px;height:10px", () => settings.pillColors, pickColor),
      h("span", { class: "name", text: def.name }),
    );
    if (isMain) {
      el.append(h("span", { class: "state", text: t("Main") }));
      return el;
    }
    const why = hint(def);
    el.append(h("span", { class: "state", text: why ?? "" }));
    const sw = h("button", { class: on ? "switch on" : "switch" }) as HTMLButtonElement;
    sw.disabled = full;
    sw.addEventListener("click", () => {
      const next = toggleDeclared(settings, def.id);
      if (!next) return;
      settings.activeIntegrations = next;
      declaredChanged();
    });
    el.append(sw);
    return el;
  }

  function draw() {
    const used = settings.activeIntegrations.length;
    slots.textContent = t("{used}/{max} slots in use — the main tool doesn't take one.", { used, max: MAX_ACTIVE });
    slots.classList.toggle("full", used >= MAX_ACTIVE);
    main.value = settings.mainPill;
    clear(groups);
    for (const cat of PILL_CATEGORIES) {
      if (cat.id === "service") continue;
      const pills = PILL_CATALOG.filter((p) => p.category === cat.id);
      if (pills.length === 0) continue;
      groups.append(h("div", { class: "pill-group" }, h("h3", { text: t(cat.title) }), ...pills.map(row)));
    }
  }
  declaredViews.push(draw);
  draw();

  return h(
    "section",
    { "data-anchor": "pills.active" },
    h("h2", {}, h("span", { text: t("Active pills") })),
    h("div", { class: "hint", text: t("Choose the tools you use. Liv only shows what you declare here.") }),
    slots,
    h("div", { class: "row" }, h("label", { text: t("Main tool") }), main),
    groups,
  );
}

// ── Chat providers section ────────────────────────────────────────────────────

const CHAT_STRINGS = {
  get providersTitle() { return t("Chat providers"); },
  get providersHint() { return t("Chat with Google AI, OpenAI or OpenRouter instead of Claude: add a key here, then click the model name above the chat box to switch provider and model. Keys stay in the {store}. These providers get no web search and no tools: they can answer, never act on this computer.", { store: t(KEY_STORE) }); },
  get stored() { return `••••••••  ${t("(stored)")}`; },
  get save() { return t("Save"); },
  get remove() { return t("Remove"); },
  get localTitle() { return t("Local models"); },
  get localHint() { return t("Chat with a model you run yourself: Ollama or LM Studio (leave the address empty for the usual one on this computer), or any server that speaks the OpenAI API, such as vLLM or llama.cpp. Once connected, pick it above the chat box."); },
  get connect() { return t("Connect"); },
  get connecting() { return t("Connecting…"); },
  get disconnect() { return t("Disconnect"); },
  get useInChat() { return t("Use in chat"); },
  get inUse() { return t("In use"); },
  get keyOptional() { return t("API key (optional)"); },
  get localOnly() { return t("Nothing leaves your PC: the server runs on this computer."); },
  get remote() { return t("This address is another machine: what you ask is sent to it."); },
  get remoteHttp() { return t("This address is another machine, over plain http: what you ask travels unencrypted."); },
  get keyOverHttp() { return t("Warning: the key would be sent unencrypted (http://) to another machine. Use https://, or a server on this computer."); },
  get invalid() { return t("Not a valid http:// or https:// address."); },
  noModels: (name: string) => t("No models yet. Download one in {name} first.", { name }),
  models: (n: number) => tn("{count} model", "{count} models", n),
};

interface CloudDef {
  id: "google" | "openai" | "openrouter";
  name: string;
  placeholder: string;
  where: string;
}

const CLOUD: CloudDef[] = [
  { id: "google", name: "Google AI", placeholder: "AIza…", where: "aistudio.google.com" },
  { id: "openai", name: "OpenAI", placeholder: "sk-…", where: "platform.openai.com" },
  { id: "openrouter", name: "OpenRouter", placeholder: "sk-or-…", where: "openrouter.ai/keys" },
];

function chatProvidersSection(
  present: Record<string, boolean>,
  keyChanged: (key: string, on: boolean) => void,
): HTMLElement {
  const list = h("div", { style: "display:flex;flex-direction:column;gap:8px" });
  for (const def of CLOUD) {
    const p = providerDef(def.id);
    const key = p.key!;
    const input = h("input", {
      type: "password",
      placeholder: present[key] ? CHAT_STRINGS.stored : def.placeholder,
      autocomplete: "off",
      spellcheck: "false",
      style: "flex:1 1 auto;min-width:0",
    }) as HTMLInputElement;
    const dotEl = statusDot(present[key] ?? false);
    const saveBtn = h("button", { text: CHAT_STRINGS.save });
    const removeBtn = h("button", { class: "danger", text: CHAT_STRINGS.remove });
    const refresh = () => {
      input.placeholder = present[key] ? CHAT_STRINGS.stored : def.placeholder;
      dotEl.style.background = present[key] ? "#22c55e" : "#f4505e";
      removeBtn.style.display = present[key] ? "" : "none";
    };
    saveBtn.addEventListener("click", async () => {
      const value = input.value.trim();
      if (!value) return;
      try {
        await Bridge.secretSet(key, value);
        present[key] = true;
        input.value = "";
        keyChanged(key, true);
      } catch {
        dotEl.style.background = "#f5a524";
        return;
      }
      refresh();
    });
    removeBtn.addEventListener("click", async () => {
      try {
        await Bridge.secretClear(key);
        present[key] = false;
        keyChanged(key, false);
      } catch {
        dotEl.style.background = "#f5a524";
        return;
      }
      refresh();
    });
    refresh();
    list.append(
      h("div", { class: "row" },
        h("label", {},
          h("i", { class: "dot", style: `background:${p.accent};margin-right:8px` }),
          h("span", { text: def.name }),
        ),
        input, saveBtn, removeBtn, dotEl,
      ),
      h("div", { class: "hint", style: "margin:-4px 0 0 144px", text: t("Key from {site}", { site: def.where }) }),
    );
  }
  return h(
    "section",
    { "data-anchor": "chat.providers" },
    h("h2", {}, h("span", { text: CHAT_STRINGS.providersTitle })),
    h("div", { class: "hint", text: CHAT_STRINGS.providersHint }),
    list,
  );
}

// ── Local models section ──────────────────────────────────────────────────────

type LocalId = "ollama" | "lmstudio" | "custom";

/** Redraws the local models section after a change made elsewhere (the island). */
let localRedraw: (() => void) | null = null;

const LOCAL: Record<LocalId, { name: string; usual: string }> = {
  ollama: { name: "Ollama", usual: "http://127.0.0.1:11434" },
  lmstudio: { name: "LM Studio", usual: "http://127.0.0.1:1234" },
  // No usual address: any server that speaks the OpenAI API.
  custom: { name: N_("OpenAI-compatible"), usual: "" },
};

/** What an address means for the user's data, as a hint line. */
function exposureNotice(url: string, withKey: boolean): HTMLElement | null {
  switch (urlExposure(url)) {
    case "local":
      return h("div", { class: "hint", text: CHAT_STRINGS.localOnly });
    case "remote":
      return h("div", { class: "hint", text: CHAT_STRINGS.remote });
    case "remote-http":
      return withKey
        ? h("div", { class: "notice warn", text: CHAT_STRINGS.keyOverHttp })
        : h("div", { class: "hint", text: CHAT_STRINGS.remoteHttp });
    case "invalid":
      return url.trim() ? h("div", { class: "notice err", text: CHAT_STRINGS.invalid }) : null;
  }
}

function localSection(customKey: boolean): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  const section = h(
    "section",
    { "data-anchor": "chat.local" },
    h("h2", {}, h("span", { text: CHAT_STRINGS.localTitle })),
    h("div", { class: "hint", text: CHAT_STRINGS.localHint }),
    body,
  );
  const redraw = () => {
    clear(body);
    for (const id of Object.keys(LOCAL) as LocalId[]) body.append(serverBlock(id));
  };

  function serverBlock(id: LocalId): HTMLElement {
    const def = LOCAL[id];
    const p = providerDef(id);
    const field = p.urlField!;
    const connected = settings[field] !== "";
    const status = h("div", {});
    const exposure = h("div", {});
    const label = h("label", {},
      h("i", { class: "dot", style: `background:${p.accent};margin-right:8px` }),
      h("span", { text: t(def.name) }),
    );
    const block = h("div", { style: "display:flex;flex-direction:column;gap:6px" });

    if (connected) {
      const inUse = settings.chatProvider === id;
      const use = h("button", { class: inUse ? "" : "primary", text: inUse ? CHAT_STRINGS.inUse : CHAT_STRINGS.useInChat });
      use.disabled = inUse;
      use.addEventListener("click", () => {
        settings.chatProvider = id;
        void save().then(redraw);
      });
      const disconnect = h("button", { class: "danger", text: CHAT_STRINGS.disconnect });
      disconnect.addEventListener("click", async () => {
        settings[field] = "";
        if (settings.chatProvider === id) settings.chatProvider = "anthropic";
        if (id === "custom") {
          await Bridge.secretClear(CUSTOM_SERVER_KEY).catch(() => {});
          customKey = false;
        }
        await save();
        redraw();
      });
      block.append(
        h("div", { class: "row" }, label, h("span", { class: "path", text: settings[field] }), statusDot(true), use, disconnect),
        status,
      );
      exposure.append(exposureNotice(settings[field], id === "custom" && customKey) ?? "");
      block.append(exposure);
      return block;
    }

    const input = h("input", {
      type: "text",
      placeholder: def.usual || "https://llm.example.com",
      style: "flex:1 1 auto;min-width:0",
      spellcheck: "false",
      autocomplete: "off",
    }) as HTMLInputElement;
    // A custom server may want a key; it goes to the keychain, never to settings.json.
    const key = h("input", {
      type: "password",
      placeholder: customKey ? CHAT_STRINGS.stored : CHAT_STRINGS.keyOptional,
      style: "flex:1 1 auto;min-width:0",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const connect = h("button", { class: "primary", text: CHAT_STRINGS.connect });

    const showExposure = () => {
      clear(exposure);
      const withKey = id === "custom" && (customKey || key.value.trim() !== "");
      const notice = exposureNotice(input.value || def.usual, withKey);
      if (notice) exposure.append(notice);
    };
    input.addEventListener("input", showExposure);
    key.addEventListener("input", showExposure);

    connect.addEventListener("click", async () => {
      connect.disabled = true;
      clear(status);
      status.append(h("div", { class: "hint", text: CHAT_STRINGS.connecting }));
      try {
        if (id === "custom" && key.value.trim()) {
          // Stored with this address: the key is only ever sent there.
          await Bridge.localSetKey(input.value || def.usual, key.value.trim());
          key.value = "";
          customKey = true;
        }
        const server = await Bridge.localConnect(id, input.value);
        if (!server.models.length) {
          clear(status);
          status.append(h("div", { class: "notice err", text: CHAT_STRINGS.noModels(t(def.name)) }));
        } else {
          settings[field] = server.url;
          if (!server.models.includes(settings.chatModels[id] ?? "")) {
            settings.chatModels = { ...settings.chatModels, [id]: server.models[0] };
          }
          await save();
          redraw();
          return;
        }
      } catch (err) {
        clear(status);
        status.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
      }
      connect.disabled = false;
    });

    block.append(h("div", { class: "row" }, label, input, connect));
    if (id === "custom") block.append(h("div", { class: "row" }, h("label", { text: "" }), key));
    block.append(status, exposure);
    showExposure();
    return block;
  }

  redraw();
  localRedraw = redraw;
  return section;
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
  /** What the key needs, shown under its field. */
  hint?: string;
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: N_("Secret key"), placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: N_("Token"), placeholder: "ghp_…", secret: true }],
    hint: N_("Classic token with the repo scope, or fine-grained with read access to Pull requests, Commit statuses and Actions.") },
  { id: "integration_gitlab", name: "GitLab", color: "#FC6D26",
    fields: [
      { key: "gitlab-url", label: N_("Instance URL"), placeholder: "https://gitlab.com", secret: false },
      { key: "gitlab-token", label: N_("Token"), placeholder: "glpat-…", secret: true },
    ],
    hint: N_("Personal access token with read_api and read_user scopes.") },
  { id: "integration_gitea", name: "Gitea", color: "#609926",
    fields: [
      { key: "gitea-url", label: N_("Instance URL"), placeholder: "https://gitea.example.com", secret: false },
      { key: "gitea-token", label: N_("Token"), placeholder: "…", secret: true },
    ] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: N_("Token"), placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: N_("Instance URL"), placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: N_("API key"), placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: N_("API key"), placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: N_("Integration token"), placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: N_("API key"), placeholder: "cal_…", secret: true }] },
  // Nothing to enter: what plays is read from the OS (src-tauri/src/spotify.rs).
  { id: "integration_spotify", name: N_("Music"), color: "#1DB954", fields: [],
    hint: N_("Shows what is playing in any app: Spotify, the browser or another player.") },
  // Nothing to enter here either: the virtual office has its own box below.
  // Its name is not a proper one, so it is the one shown translated.
  { id: "integration_office", name: N_("Office"), color: "#FACC15", fields: [] },
];

const MAX_ACTIVE = MAX_DECLARED;

/** Everything that shows the declared pills, redrawn when any of them changes. */
const declaredViews: (() => void)[] = [];

function declaredChanged() {
  for (const redraw of declaredViews) redraw();
  void save();
}

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  /** Each service's switch, shown as it is declared: on, off, or off with no slot left. */
  const switches: [string, HTMLButtonElement][] = [];

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = t("Pick up to {max} pills to show next to Liv — {used}/{max} in use. Keys are stored in the {store}, never on disk.", { max: MAX_ACTIVE, used, store: t(KEY_STORE) });
    for (const [id, sw] of switches) {
      const on = settings.activeIntegrations.includes(id);
      sw.classList.toggle("on", on);
      // Every slot taken: a pill that is off cannot be turned on, and says so.
      sw.disabled = !on && used >= MAX_ACTIVE;
    }
  }
  declaredViews.push(updateNote);

  const offered = new Set(PILL_CATALOG.map((p) => p.id));
  for (const def of INTEGRATIONS.filter((d) => offered.has(d.id))) {
    const name = t(def.name);
    const sw = h("button", { class: "switch" });
    switches.push([def.id, sw]);
    sw.addEventListener("click", () => {
      const next = toggleDeclared(settings, def.id);
      if (!next) return;
      settings.activeIntegrations = next;
      declaredChanged();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? CHAT_STRINGS.stored : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: t("Save") });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? CHAT_STRINGS.stored : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: t(field.label) }),
          input, saveBtn, dotEl,
        ),
      );
    }

    if (def.hint) rows.append(h("div", { class: "hint", text: t(def.hint) }));

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          colorDot({ ...def, name }, "", () => settings.pillColors, pickColor),
          h("span", { style: "font-size:12.5px", text: name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h(
    "section",
    { "data-anchor": "integrations.services" },
    h("h2", {}, h("span", { text: t("Integrations") })),
    note,
    list,
  );
}

// ── Virtual office section ────────────────────────────────────────────────────

/** What a virtual office runs to tell Liv something, one JSON event on stdin (docs/OFICINA.md). */
const OFFICE_COMMAND = String.raw`%LOCALAPPDATA%\Liv\bin\liv-hook.exe office`;
/** An event to try it with, as PowerShell takes it: an agent of the office starts working. */
const OFFICE_EXAMPLE =
  `'{"type":"agent.state","agent":{"id":"editor","name":"Editor"},"state":"working","summary":"Hello from my office"}' | ` +
  String.raw`& "$env:LOCALAPPDATA\Liv\bin\liv-hook.exe" office`;

/**
 * The virtual office (docs/OFICINA.md): whether its events are listened to,
 * the address its pill opens, and what the office runs to send an event. Its
 * pill is declared in the list above, like any other service's.
 */
function officeSection(): HTMLElement {
  const enabled = toggle(settings.officeEnabled, (v) => { settings.officeEnabled = v; void save(); });

  const address = h("input", {
    type: "text",
    placeholder: "http://localhost:3000",
    style: "flex:1 1 auto;min-width:0",
    spellcheck: "false",
    autocomplete: "off",
  }) as HTMLInputElement;
  address.value = settings.officeUrl;
  const problem = h("div", {});
  // As for a key above: green once there is one, red while there is none.
  const stored = statusDot(settings.officeUrl !== "");
  const saveAddress = h("button", { text: t("Save") });
  saveAddress.addEventListener("click", () => {
    const typed = address.value.trim();
    clear(problem);
    // Only an address the island would open is kept; an empty one clears it.
    if (typed && !safeUrl(typed)) {
      problem.append(h("div", { class: "notice err", text: CHAT_STRINGS.invalid }));
      return;
    }
    settings.officeUrl = typed;
    stored.style.background = typed ? "#22c55e" : "#f4505e";
    void save();
  });

  const copy = h("button", { text: t("Copy example") });
  copy.addEventListener("click", async () => {
    await writeClipboard(OFFICE_EXAMPLE);
    copy.textContent = t("Copied");
    window.setTimeout(() => { copy.textContent = t("Copy example"); }, 1500);
  });

  return h(
    "section",
    { "data-anchor": "integrations.office" },
    h("h2", {}, h("span", { text: t("Virtual office") })),
    h("div", { class: "hint", text: t("A team of AI agents you run in another program can show here who is working, what waits for you, errors and milestones. Liv only listens and takes you there.") }),
    h("div", { class: "row" }, h("label", { text: t("Show my virtual office") }), enabled),
    h("div", { class: "hint", text: t("Its pill appears on its own with the office's first event. Off, its events are ignored.") }),
    h("div", { class: "row" }, h("label", { text: t("Office address") }), address, saveAddress, stored),
    problem,
    h("div", { class: "hint", text: t("What the Open office button opens, unless the office names an address itself. To keep the pill as a shortcut, turn on Office in the list above.") }),
    h("div", { class: "row" },
      h("label", { text: t("Send events with") }),
      h("span", { class: "path", text: OFFICE_COMMAND }),
      copy,
    ),
    h("div", { class: "hint", text: t("One JSON event on standard input. The format is described in docs/OFICINA.md, in Liv's repository.") }),
  );
}

// ── General section ───────────────────────────────────────────────────────────

/**
 * Puts the General fields back in line with the settings after a change made
 * elsewhere (the island's own settings change sound, volume and auto-close).
 */
let generalSync: (() => void) | null = null;

/**
 * The island's size in force, as Rust reports it at boot and then with
 * `island-scale`: the size picked, or less on a display too small for it.
 * Null until it is known.
 */
let scaleInForce: number | null = null;

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
    "aria-label": t("Volume"),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  // Your own sounds (Liv ships none): the folder, a reload, and how many are there.
  const customCount = h("span", { class: "hint" });
  const countCustom = () =>
    void Bridge.customSounds(SOUND_NAMES).then((own) => {
      const n = own?.length ?? 0;
      customCount.textContent = n > 0 ? t("{0} custom", { 0: n }) : "";
    });
  countCustom();
  const soundsFolder = h("button", { text: t("Open sounds folder"), onclick: () => void Bridge.revealSoundsFolder() });
  const reloadSounds = h("button", {
    text: t("Reload sounds"),
    onclick: () => void Bridge.reloadSounds().then(() => window.setTimeout(countCustom, 300)),
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  // The closed island (core/closed.ts): what stays at the top of the screen.
  const closed = h("select", {}) as HTMLSelectElement;
  closed.append(
    h("option", { value: "robot", text: t("Liv") }),
    h("option", { value: "time", text: t("The time") }),
    h("option", { value: "datetime", text: t("The date and the time") }),
    h("option", { value: "claude", text: t("Claude usage") }),
    h("option", { value: "music", text: t("What's playing") }),
    h("option", { value: "empty", text: t("Nothing, just the island") }),
    h("option", { value: "hidden", text: t("Hide the island") }),
  );
  closed.value = closedIsland(settings.closedIsland);
  closed.addEventListener("change", () => {
    settings.closedIsland = closed.value;
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: t("Main display") }),
    h("option", { value: "cursor", text: t("Display under the cursor") }),
  );
  screen.value = settings.screen;
  void Bridge.listMonitors().then((list) => {
    for (const m of list ?? []) screen.append(h("option", { value: m.key, text: m.label }));
    // Set again now the option exists. A display saved under an older key (moved,
    // resized, or saved before names were kept) is shown by its place or its
    // name; one that is gone shows as the main one.
    const saved = settings.screen;
    const [place, name] = saved.split("|");
    const keys = (list ?? []).map((m) => m.key);
    screen.value =
      keys.find((k) => k === saved) ??
      (saved.startsWith("at:") ? keys.find((k) => k.split("|")[0] === place) : undefined) ??
      (name ? keys.find((k) => k.split("|")[1] === name) : undefined) ??
      saved;
    if (!screen.value) screen.value = "primary";
  });
  screen.addEventListener("change", () => {
    settings.screen = screen.value;
    void save();
  });

  // The island's size (core/scale.ts): one button per size, the one picked
  // filled in. The island follows at once. On a display too small for it the
  // island stays smaller, and a line under the buttons says which size it has.
  const sizes = ISLAND_SCALES.map((size) =>
    h("button", {
      text: scaleLabel(size),
      onclick: () => {
        // Another size: what this display makes of it is not known until Rust says.
        if (islandScale(settings.islandScale) !== size) scaleInForce = null;
        settings.islandScale = size;
        showSize();
        void save();
      },
    }),
  );
  const sizeClamped = h("div", { class: "hint" });
  const showSize = () => {
    const current = islandScale(settings.islandScale);
    sizes.forEach((button, i) => {
      const on = ISLAND_SCALES[i] === current;
      button.classList.toggle("primary", on);
      button.setAttribute("aria-pressed", String(on));
    });
    const fits = clampedScale(settings.islandScale, scaleInForce);
    sizeClamped.textContent = fits == null ? "" : t("This screen only fits {size}.", { size: scaleLabel(fits) });
    sizeClamped.style.display = fits == null ? "none" : "";
  };
  showSize();

  const sound = toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); });
  const openOnHover = toggle(settings.openOnHover, (v) => { settings.openOnHover = v; void save(); });
  const hideOnFullscreen = toggle(settings.hideOnFullscreen, (v) => { settings.hideOnFullscreen = v; void save(); });
  const autostart = toggle(settings.autostart, (v) => { settings.autostart = v; void save(); });
  const openWindow = toggle(settings.openWindowAtLaunch, (v) => { settings.openWindowAtLaunch = v; void save(); });
  // Liv on the desktop: the switch shows where Liv lives, and asks the island
  // to send it out or to call it home. The setting itself is Rust's to write
  // (pet.rs), and comes back as `pet-out`.
  const petOut: HTMLElement = toggle(settings.petOut, (v) => {
    void Bridge.petAsk(v).then((able) => {
      // Where Liv cannot leave the island, the switch goes back.
      if (!able) setSwitch(petOut, settings.petOut);
    });
  });
  // What Liv wears: the wardrobe's choices (robot/outfits.ts). The Liv on top of this page puts it on.
  const outfit = h("select", {}) as HTMLSelectElement;
  for (const choice of OUTFIT_CHOICES) outfit.append(h("option", { value: choice.id, text: t(choice.name) }));
  outfit.value = outfitChoice(settings.livOutfit);
  outfit.addEventListener("change", () => {
    settings.livOutfit = outfitChoice(outfit.value);
    dressLiv();
    void save();
  });
  const petHint = h("div", { class: "hint" });
  // The hint names the shortcut as it is bound now, or leaves it out when it has no key.
  const showPetHint = () => {
    const keys = activeKeys(settings.shortcuts).find(([id]) => id === "desktopToggle")?.[1];
    petHint.textContent = keys
      ? t("Drag Liv out of the island, or press {keys}. Double-click brings it home.", { keys: displayKeys(keys) })
      : t("Drag Liv out of the island. Double-click brings it home.");
  };
  showPetHint();
  generalSync = () => {
    setSwitch(sound, settings.soundEnabled);
    setSwitch(openOnHover, settings.openOnHover);
    setSwitch(petOut, settings.petOut);
    showPetHint();
    outfit.value = outfitChoice(settings.livOutfit);
    setSwitch(hideOnFullscreen, settings.hideOnFullscreen);
    setSwitch(autostart, settings.autostart);
    setSwitch(openWindow, settings.openWindowAtLaunch);
    showSize();
    // A field being edited keeps what is in it; it catches up when it is left.
    if (document.activeElement !== volume) volume.value = String(settings.soundVolume);
    if (document.activeElement !== autoClose) {
      autoClose.value = String(Math.round(settings.autoCloseInterval));
    }
  };
  volume.addEventListener("blur", () => generalSync?.());
  autoClose.addEventListener("blur", () => generalSync?.());

  return h(
    "section",
    { "data-anchor": "general.general" },
    h("h2", {}, h("span", { text: t("General") })),
    h("div", { class: "row" },
      h("label", { text: t("Sound") }),
      sound,
      volume,
    ),
    h("div", { class: "row" }, soundsFolder, reloadSounds, customCount),
    h("div", { class: "hint", text: t("Liv has its own sounds. To replace one, put a file named peek, open, close, blip, tick, pop, send, work, finish, error, approval, question, approve or rate (.wav, .mp3, .ogg, .m4a, .aac or .flac) in the sounds folder, then Reload.") }),
    h("div", { class: "row" },
      h("label", { text: t("Open on hover") }),
      openOnHover,
    ),
    h("div", { class: "hint", text: t("Hovering the island opens it; it folds again shortly after the pointer leaves. Click inside to keep it open.") }),
    h("div", { class: "row" },
      h("label", { text: t("Open for every pill’s alerts") }),
      toggle(settings.alertsFromAllPills, (v) => { settings.alertsFromAllPills = v; void save(); }),
    ),
    h("div", { class: "hint", text: t("When a pill other than the one shown finishes or hits an error, the island shows it for a moment, then the pill you had comes back.") }),
    h("div", { class: "row" },
      h("label", { text: t("Show clock in the island") }),
      toggle(settings.showClock, (v) => { settings.showClock = v; void save(); }),
    ),
    h("div", { class: "hint", text: t("The date and the time in the middle of the island when it is compact.") }),
    h("div", { class: "row" },
      h("label", { text: t("Closed island shows") }),
      closed,
    ),
    h("div", { class: "hint", text: t("Once closed, a small island stays at the top of the screen. Hover it to bring Liv back. If hidden, move the pointer to the middle of the top edge of the screen.") }),
    h("div", { class: "row" },
      h("label", { text: t("Auto-close") }),
      autoClose,
      h("span", { class: "hint", text: t("seconds after you leave the island") }),
    ),
    h("div", { class: "row" },
      h("label", { text: t("Island lives on") }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: t("Island size") }),
      ...sizes,
    ),
    sizeClamped,
    h("div", { class: "hint", text: t("Makes the island and its text bigger.") }),
    h("div", { class: "row" },
      h("label", { text: t("Hide when an app is full screen") }),
      hideOnFullscreen,
    ),
    h("div", { class: "hint", text: t("For films, games and presentations: the island comes back when you leave full screen.") }),
    h("div", { class: "row" },
      h("label", { text: t("Liv on the desktop") }),
      petOut,
    ),
    petHint,
    h("div", { class: "row" },
      h("label", { text: t("Liv wears") }),
      outfit,
    ),
    h("div", { class: "hint", text: t("Auto follows the season. Right-click Liv to try things on; with the island folded, only the star fits.") }),
    h("div", { class: "row" },
      h("label", { text: t("Launch at startup") }),
      autostart,
    ),
    h("div", { class: "row" },
      h("label", { text: t("Open this window when Liv starts") }),
      openWindow,
    ),
    h("div", { class: "hint", text: t("Not when Liv starts with the computer.") }),
    ...recapRows(),
    ...updateRows(toggle, version),
    languageRow(),
  );
}

// ── Appearance ────────────────────────────────────────────────────────────────

/** Shows the Appearance section's sliders as the settings have them, after a change made elsewhere. */
let appearanceSync: (() => void) | null = null;

/** Settings → General → Appearance: the open island's shape (./appearance.ts). */
function appearanceBox(): HTMLElement {
  const section = appearanceSection(() => settings, save);
  appearanceSync = section.sync;
  return section.el;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

/** Shows the Tools section's switches as the settings have them, after a change made elsewhere. */
let toolsSync: (() => void) | null = null;

/**
 * Settings → General → Tools: what the island's Tools view keeps. The
 * clipboard's history is the one setting; the hint names the shortcut that
 * opens the view as it is bound now, or leaves it out when it has no key.
 * Under it, where screenshots go, and the way to that folder.
 */
function toolsSection(): HTMLElement {
  const history = toggle(settings.clipboardHistory, (v) => { settings.clipboardHistory = v; void save(); });
  const opens = h("div", { class: "hint" });
  toolsSync = () => {
    setSwitch(history, settings.clipboardHistory);
    const keys = activeKeys(settings.shortcuts).find(([id]) => id === "toolsToggle")?.[1];
    opens.textContent = keys
      ? t("What you copy is listed in the island's Tools view: press {keys}, then click an entry to paste it where you were typing.", { keys: displayKeys(keys) })
      : t("What you copy is listed in the island's Tools view: click an entry to paste it where you were typing.");
  };
  toolsSync();
  return h(
    "section",
    { "data-anchor": "general.tools" },
    h("h2", {}, h("span", { text: t("Tools") })),
    h("div", { class: "row" },
      h("label", { text: t("Clipboard history") }),
      history,
    ),
    opens,
    h("div", { class: "hint", text: t("Kept in memory only, never on disk, and forgotten when Liv quits. Copies that a password manager marks as private are skipped.") }),
    h("div", { class: "row" },
      h("label", { text: t("Screenshots") }),
      h("button", { text: t("Open screenshots folder"), onclick: () => void Bridge.openCapturesFolder() }),
    ),
    h("div", { class: "hint", text: t("Screenshots are saved as PNG in the Liv folder inside Pictures. Each one is also copied to the clipboard and put on the shelf.") }),
  );
}

/**
 * Settings → General → Language, as on the Mac: "System" follows the
 * system's language when Liv has it (else English), or one of ours.
 * Both windows and the tray switch in place, without a restart.
 */
function languageRow(): HTMLElement {
  const select = h("select", {}) as HTMLSelectElement;
  select.append(h("option", { value: "", text: t("System") }));
  for (const { code, name } of LANGUAGES) select.append(h("option", { value: code, text: name, lang: code }));
  select.value = LANGUAGES.some((l) => l.code === settings.language) ? settings.language : "";
  select.addEventListener("change", () => {
    settings.language = select.value;
    void save();
    applyLanguage();
  });
  return h("div", { class: "row" }, h("label", { text: t("Language") }), select);
}

// ── Shortcuts section ─────────────────────────────────────────────────────────

const SHORTCUTS_UI = {
  get title() { return t("Shortcuts"); },
  get hint() { return t("Work from any app. Click a shortcut to change it, then press the new keys — Esc cancels, Backspace removes it."); },
  get global() { return t("From anywhere"); },
  get island() { return t("In the open island"); },
  get recording() { return t("Press keys…"); },
  get none() { return t("None"); },
  get reset() { return t("Reset to defaults"); },
  get inUse() { return t("In use by another app"); },
  get duplicate() { return t("Used twice"); },
  get invalid() { return t("Not a valid shortcut"); },
  get unavailable() { return t("Not available"); },
  types: (ch: string) => t("Types “{char}”", { char: ch }),
  typesNote: (keys: string, ch: string) =>
    t("{keys} types “{char}” on your keyboard, so it can't be a shortcut. Pick another key.", { keys, char: ch }),
  get needsModifier() { return t("Hold Ctrl, Alt or the Windows key with it."); },
  get unsupportedKey() { return t("That key can't be used in a shortcut."); },
  get wayland() {
    return t("Your Wayland desktop doesn't let apps listen for keys outside their own windows. Add the shortcuts in your system's keyboard settings instead, with these commands:");
  },
  get noDisplay() { return t("No display server was found, so global shortcuts are off."); },
  get portalPending() {
    return t("Asking your desktop to register the shortcuts. It may show its own window to confirm them.");
  },
  get portalActive() {
    return t("These shortcuts are registered with your desktop. It may ask you to confirm them or to pick other keys; when it says which keys it uses, they show next to each shortcut.");
  },
  get portalFallback() {
    return t("If one doesn't work, you can also add it in your system's keyboard settings with these commands:");
  },
  desktopKeys: (keys: string) => t("Desktop: {keys}", { keys }),
  get refused() { return t("Not set by your desktop"); },
};

function shortcutsSection(initial: ShortcutsReport | null): HTMLElement {
  let report = initial;
  const list = h("div", { class: "shortcut-list" });
  const feedback = h("div", {});
  const blockedNote = h("div", {});

  let stopRecording: (() => void) | null = null;

  function store(id: string, binding: Binding) {
    settings.shortcuts = { ...settings.shortcuts, [id]: binding };
    void save();
  }

  function tagFor(id: string, dups: Set<string>): HTMLElement | null {
    if (dups.has(id)) return h("span", { class: "tag err", text: SHORTCUTS_UI.duplicate });
    const st = report?.actions.find((a) => a.id === id);
    switch (st?.status) {
      case "inUse": return h("span", { class: "tag warn", text: SHORTCUTS_UI.inUse });
      case "duplicate": return h("span", { class: "tag err", text: SHORTCUTS_UI.duplicate });
      case "invalid": return h("span", { class: "tag err", text: SHORTCUTS_UI.invalid });
      case "typesCharacter": return h("span", { class: "tag warn", text: SHORTCUTS_UI.types(st.typed ?? "?") });
      case "unsupported": return h("span", { class: "tag", text: SHORTCUTS_UI.unavailable });
      case "refused": return h("span", { class: "tag warn", text: SHORTCUTS_UI.refused });
      // Wayland: the desktop may run it on other keys than the ones asked for.
      case "active": return st.trigger ? h("span", { class: "tag", text: SHORTCUTS_UI.desktopKeys(st.trigger) }) : null;
      default: return null;
    }
  }

  function record(id: string, binding: Binding, button: HTMLButtonElement) {
    stopRecording?.();
    clear(feedback);
    button.classList.add("recording");
    button.textContent = SHORTCUTS_UI.recording;
    void Bridge.shortcutsSuspend(true);

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const result = recordPress(e);
      switch (result.kind) {
        case "pending":
          return;
        case "keys":
          finish();
          store(id, { keys: result.keys, enabled: true });
          return;
        case "clear":
          finish();
          store(id, { keys: "", enabled: binding.enabled });
          return;
        case "typesCharacter":
          finish();
          feedback.append(h("div", {
            class: "notice warn",
            text: SHORTCUTS_UI.typesNote(displayKeys(result.keys), result.typed),
          }));
          return;
        case "needsModifier":
          feedback.replaceChildren(h("div", { class: "notice warn", text: SHORTCUTS_UI.needsModifier }));
          return;
        case "unsupported":
          feedback.replaceChildren(h("div", { class: "notice warn", text: SHORTCUTS_UI.unsupportedKey }));
          return;
        case "cancel":
          finish();
          return;
      }
    };
    const onBlur = () => finish();

    function finish() {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      stopRecording = null;
      // Takes the global shortcuts back, from what is saved by now.
      void Bridge.shortcutsSuspend(false);
      draw();
    }
    stopRecording = finish;
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
  }

  function draw() {
    clear(list);
    const dups = duplicates(activeKeys(settings.shortcuts));
    for (const d of SHORTCUTS) {
      const binding = effective(d, settings.shortcuts);
      const keycap = h("button", {
        class: "keycap",
        text: binding.keys ? displayKeys(binding.keys) : SHORTCUTS_UI.none,
      }) as HTMLButtonElement;
      keycap.disabled = !binding.enabled;
      keycap.addEventListener("click", () => record(d.id, binding, keycap));
      const sw = toggle(binding.enabled, (on) => store(d.id, { keys: binding.keys, enabled: on }));
      const tag = binding.enabled ? tagFor(d.id, dups) : null;
      list.append(h("div", { class: binding.enabled ? "row shortcut" : "row shortcut off" },
        sw,
        h("span", { class: "shortcut-name", text: t(SHORTCUT_TEXT[d.id]) }),
        ...(tag ? [tag] : []),
        keycap,
      ));
    }

    clear(blockedNote);
    const commands = (command: string) => {
      const list = h("div", { class: "diff" });
      for (const d of SHORTCUTS) list.append(h("div", { class: "ctx", text: `${command} ${d.id}` }));
      return list;
    };
    if (report?.portal) {
      // Wayland, through the desktop's GlobalShortcuts portal; the commands
      // stay as a way around a shortcut the desktop didn't take.
      const active = report.portal === "active";
      blockedNote.append(
        h("div", {
          class: active ? "notice ok" : "notice",
          text: active ? SHORTCUTS_UI.portalActive : SHORTCUTS_UI.portalPending,
        }),
        h("div", { class: "hint", text: SHORTCUTS_UI.portalFallback }),
        commands(report.command),
      );
    } else if (report?.blocked === "wayland") {
      blockedNote.append(h("div", { class: "notice warn", text: SHORTCUTS_UI.wayland }), commands(report.command));
    } else if (report?.blocked) {
      blockedNote.append(h("div", { class: "notice warn", text: SHORTCUTS_UI.noDisplay }));
    }
  }

  const islandList = h("div", { class: "shortcut-list" });
  for (const row of ISLAND_SHORTCUTS) {
    islandList.append(h("div", { class: "row shortcut" },
      h("span", { class: "shortcut-name", text: t(row.description) }),
      h("span", { class: "keycap static", text: row.keys }),
    ));
  }

  const reset = h("button", {
    text: SHORTCUTS_UI.reset,
    onclick: () => {
      stopRecording?.();
      settings.shortcuts = {};
      clear(feedback);
      void save();
      draw();
    },
  });

  // The events are listened to once (see main); only the section on screen redraws.
  shortcutsListener = {
    report(fresh) {
      report = fresh;
      if (!stopRecording) draw();
    },
    settingsChanged() {
      if (!stopRecording) draw();
    },
  };

  draw();
  return h(
    "section",
    { "data-anchor": "shortcuts.all" },
    h("h2", {}, h("span", { text: SHORTCUTS_UI.title })),
    h("div", { class: "hint", text: SHORTCUTS_UI.hint }),
    h("div", { class: "subhead", text: SHORTCUTS_UI.global }),
    list,
    blockedNote,
    feedback,
    h("div", { class: "row" }, reset),
    h("div", { class: "subhead", text: SHORTCUTS_UI.island }),
    islandList,
  );
}

/** Settings → General → Weekly recap. The prefs live with the history in Rust. */
function recapRows(): HTMLElement[] {
  const T = {
    label: t("Weekly recap"),
    keep: t("Keep a history of my coding sessions"),
    clear: t("Clear history"),
    cleared: t("History cleared."),
    about: t("Counts and project names only — never commands, files or prompts. Kept on this computer for 12 weeks."),
  };
  const feedback = h("span", { class: "hint" });
  const sw = toggle(true, (v) => { void Bridge.recapSetEnabled(v); });
  void Bridge.recapPrefs().then((prefs) => {
    if (prefs) sw.classList.toggle("on", prefs.enabled);
  });
  const clearBtn = h("button", {
    class: "danger",
    text: T.clear,
    onclick: async () => {
      clearBtn.disabled = true;
      await Bridge.recapClear();
      feedback.textContent = T.cleared;
      window.setTimeout(() => {
        clearBtn.disabled = false;
        feedback.textContent = "";
      }, 2400);
    },
  }) as HTMLButtonElement;
  return [
    h("div", { class: "row" },
      h("label", { text: T.label }),
      sw,
      h("span", { class: "hint", text: T.keep }),
    ),
    h("div", { class: "row" },
      h("label", {}),
      clearBtn,
      feedback,
    ),
    h("div", { class: "row" },
      h("label", {}),
      h("span", { class: "hint", style: "flex:1 1 0;min-width:0", text: T.about }),
    ),
  ];
}

// ── Language ──────────────────────────────────────────────────────────────────

/** The shortcuts section on screen, told about the events listened to once in main. */
let shortcutsListener: { report(fresh: ShortcutsReport): void; settingsChanged(): void } | null = null;

/**
 * Shows the language Settings asks for. A change redraws the window in place,
 * where it was scrolled to: nothing reloads, nothing is written.
 */
function applyLanguage() {
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  guardPage(window);
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
    scaleInForce = boot.scaleInForce;
  }
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
  dressLiv();
  hub = await startHub(windowRoot, {
    version,
    renderIsland: async (page, container) => {
      islandPage = page;
      root = container;
      await render();
    },
  });
  onLanguageChange(() => hub?.redraw());

  void onEvent<ShortcutsReport>("shortcuts-status", (fresh) => shortcutsListener?.report(fresh));
  void onEvent<UpdateStatus>("update-status", (fresh) => updatesListener?.(fresh));
  void onEvent<number>("island-scale", (size) => {
    scaleInForce = size;
    generalSync?.();
  });
  // The window comes on screen, maybe on another day than it was last seen.
  void onEvent<boolean>("hub-visible", (shown) => {
    if (shown) dressLiv();
  });
  // Liv went out to the desktop or came home, however it was asked to.
  void onEvent<boolean>(PET_EVENTS.out, (out) => {
    settings.petOut = out;
    generalSync?.();
  });
  void onEvent<Settings>("settings-changed", (s) => {
    const before = `${settings.chatProvider}|${settings.ollamaUrl}|${settings.lmstudioUrl}|${settings.customUrl}`;
    settings = { ...settings, ...s };
    dressLiv();
    shortcutsListener?.settingsChanged();
    generalSync?.();
    appearanceSync?.();
    toolsSync?.();
    for (const redraw of declaredViews) redraw();
    const after = `${settings.chatProvider}|${settings.ollamaUrl}|${settings.lmstudioUrl}|${settings.customUrl}`;
    if (before !== after) localRedraw?.();
    applyLanguage();
  });
}

/** The page being shown. */
let islandPage: PageId = "general";

/** Reads what the sections of the page show and draws them. */
async function render() {
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, planRelayInstalled: false, settingsPath: "", hookPath: "", hookReady: false,
  };
  const agents = await Bridge.agentHooksList();

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  const claudeRelay = !hasKey && ((await Bridge.claudeReady()) ?? false);
  const shortcutReport = await Bridge.shortcutsStatus();

  const keys = [
    "stripe-api-key", "github-token", "gitlab-url", "gitlab-token", "gitea-url", "gitea-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  // A main pill this build can run, and no pill declared twice.
  settings = { ...settings, ...sanitizeDeclared(settings) };
  const connected: Record<string, boolean> = { ...((await Bridge.agentHooksStatus()) ?? {}) };
  for (const def of PILL_CATALOG) {
    if (def.connect.kind === "key") {
      connected[def.id] = present[def.connect.key] ?? (await Bridge.keyReady(def.connect.key)) ?? false;
    }
  }
  /** A chat provider's key was saved or removed: its pill's row says so at once. */
  const keyChanged = (key: string, on: boolean) => {
    for (const def of PILL_CATALOG) {
      if (def.connect.kind === "key" && def.connect.key === key) connected[def.id] = on;
    }
    for (const redraw of declaredViews) redraw();
  };
  const chatKeys: Record<string, boolean> = {};
  for (const def of CLOUD) {
    const key = providerDef(def.id).key!;
    chatKeys[key] = (await Bridge.secretPresent(key)) ?? false;
  }
  const customKey = (await Bridge.secretPresent(CUSTOM_SERVER_KEY)) ?? false;

  declaredViews.length = 0;
  localRedraw = null;
  shortcutsListener = null;
  generalSync = null;
  appearanceSync = null;
  toolsSync = null;
  clear(root);
  const sections: Partial<Record<PageId, () => HTMLElement[]>> = {
    general: () => [generalSection(), appearanceBox(), toolsSection()],
    pills: () => [activePillsSection(connected)],
    agents: () => [claudeSection(status), agentsSection(agents), planSection(status)],
    chat: () => [subscriptionsSection(), apiSection(hasKey, claudeRelay), chatProvidersSection(chatKeys, keyChanged), localSection(customKey)],
    integrations: () => [integrationsSection(present), officeSection()],
    shortcuts: () => [shortcutsSection(shortcutReport)],
  };
  root.append(...(sections[islandPage]?.() ?? []));
  if (islandPage === "general") {
    root.append(h("div", {
      class: "hint",
      text: t("No telemetry. Network requests only go to the services you configure yourself."),
    }));
  }
}

void main();
