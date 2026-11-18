// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView /
// ModelPickerView from IslandViewContent.swift.
//
// Answers are rendered as Markdown (markdown.ts). A local model streams its
// answer: Rust sends `chat-delta` events with the text visible so far. The
// mark above the send button — four gems, the one of who answers lit — opens
// the picker: the providers down the
// left, the chosen one's models beside them with the room they need — asked
// for only once it is picked. While it is open the island is as tall as the
// chat gets, so the list shows several models at once.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./markdown";
import { Bridge, onEvent, type ChatContext, type ModelInfo } from "../core/bridge";
import { markFor, type GemSlot } from "../core/chat-look";
import { paintParticles, particleCount, seedParticles, type Particle, type Point } from "../core/particles";
import {
  activeModel, pickModel, providerDef, toolModel, visibleProviders, withModel, withToolModel, type ProviderDef,
} from "../core/providers";
import { chatSettingsTarget } from "../core/settings-target";
import { Sound } from "../core/sound";
import { chipLabel, loadSubscriptions, subscribedProviders, subscription } from "../core/subscriptions";
import { State, type ChatMessage } from "../core/state";
import { hexToRGB } from "../robot/look";
import type { ViewHost } from "./views";
import { N_, t, tl, type Msg } from "../i18n/i18n";

const STRINGS = {
  placeholderFirst: N_("Ask me anything…"),
  placeholderNext: N_("Continue…"),
  send: N_("Send"),
  switchModel: N_("Switch provider or model"),
  newChat: N_("Start a new chat"),
  noModel: N_("Choose a model"),
  loading: N_("Loading models…"),
  noKey: N_("No API key — add it in Settings."),
  openSettings: N_("Open Settings"),
  ai: N_("AI"),
  model: N_("Model"),
};

/** The open island's height while the picker is up: the chat's tallest (layout.ts). */
export const PICKER_HEIGHT = 300;

let nextId = 1;

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = h("div", { class: "reply" });
  renderMarkdown(reply, message.content);
  return h("div", { class: "chat-row" }, reply);
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

function saveSettings() {
  void Bridge.saveSettings(State.settings);
}

// ── Model picker ──────────────────────────────────────────────────────────────

interface Picker {
  el: HTMLElement;
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

/**
 * Two columns: who answers (the providers, one under another) and, beside
 * them, the chosen provider's models with their whole names.
 */
function buildPicker(onChange: () => void): Picker {
  const chips = h("div", { class: "picker-providers" });
  const list = h("div", { class: "picker-list" });
  const el = h(
    "div",
    { class: "picker" },
    h("div", { class: "picker-col picker-side" }, h("div", { class: "picker-head", text: tl(STRINGS.ai) }), chips),
    h("div", { class: "picker-rule" }),
    h("div", { class: "picker-col picker-main" }, h("div", { class: "picker-head", text: tl(STRINGS.model) }), list),
  );

  /** Models already asked for, by provider; a model server or a subscription's tool is asked again each time. */
  const cache = new Map<string, ModelInfo[]>();
  let isOpen = false;
  let request = 0;

  function drawChips() {
    clear(chips);
    for (const p of visibleProviders(State.settings, subscribedProviders())) {
      const on = p.id === State.settings.chatProvider;
      const chip = h(
        "button",
        { class: on ? "picker-provider on" : "picker-provider", style: `--accent:${p.accent}` },
        h("i", { class: "picker-dot" }),
        h("span", { class: "picker-provider-name", text: tl(p.name) }),
      );
      chip.addEventListener("click", () => {
        if (p.id === State.settings.chatProvider) return;
        State.settings = { ...State.settings, chatProvider: p.id };
        saveSettings();
        Sound.play("pop");
        drawChips();
        void loadModels();
        onChange();
      });
      chips.append(chip);
    }
  }

  function status(text: string | Msg, withSettings = false) {
    clear(list);
    const line = h("div", { class: "picker-status", text });
    if (withSettings) {
      line.append(
        h("button", {
          class: "picker-link",
          text: tl(STRINGS.openSettings),
          onclick: () => void Bridge.openSettingsWindow(chatSettingsTarget(State.settings.chatProvider)),
        }),
      );
    }
    list.append(line);
  }

  function drawModels(p: ProviderDef, models: ModelInfo[]) {
    clear(list);
    // Through a subscription, a tool other than Claude Code has models of its
    // own: the one it chose itself (""), then the ones it lists.
    const ownModel = Boolean(subscription(p.id)?.on) && p.id !== "anthropic";
    const picked = ownModel ? toolModel(State.settings, p.id) : activeModel(State.settings);
    // One the tool no longer offers: its own choice is what shows as picked.
    const current = ownModel && !models.some((m) => m.id === picked) ? "" : picked;
    for (const m of models) {
      const on = m.id === current;
      const row = h(
        "button",
        { class: on ? "picker-model on" : "picker-model", style: `--accent:${p.accent}`, title: m.id },
        h("span", { class: "picker-model-name", text: m.label }),
        // The id the provider knows it by, when the name shown is a friendlier one.
        m.id && m.id !== m.label ? h("span", { class: "picker-model-id", text: m.id }) : null,
        on ? svg(ICONS.check, 11, { stroke: 2.2 }) : null,
      );
      row.addEventListener("click", () => {
        if (ownModel) State.settings = withToolModel(State.settings, p.id, m.id);
        else if (!m.id) return close();
        else State.settings = withModel(State.settings, p.id, m.id);
        saveSettings();
        Sound.play("blip");
        close();
      });
      list.append(row);
    }
    list.querySelector(".picker-model.on")?.scrollIntoView({ block: "nearest" });
  }

  async function loadModels() {
    const p = providerDef(State.settings.chatProvider);
    const ticket = ++request;
    const subscribed = subscription(p.id)?.on ?? false;
    const cacheKey = `${p.id}:${subscribed}`;
    // A model server is asked each time, and so is a subscription's tool: its
    // list is its own to change, and Rust keeps it for a while (cli_relay.rs).
    const asked = Boolean(p.urlField) || (subscribed && p.id !== "anthropic");
    const cached = asked ? undefined : cache.get(cacheKey);
    if (cached) {
      drawModels(p, cached);
      return;
    }
    // Nothing is asked of a provider that has no key yet (its subscription needs none).
    if (!subscribed && p.key && !(await Bridge.keyReady(p.key))) {
      if (ticket === request) status(tl(STRINGS.noKey), true);
      return;
    }
    if (ticket !== request) return;
    status(tl(STRINGS.loading));
    try {
      const models = await Bridge.chatModels(p.id);
      if (ticket !== request) return;
      if (!asked) cache.set(cacheKey, models);
      const keep = subscribed && p.id !== "anthropic" ? null : pickModel(p, models.map((m) => m.id), activeModel(State.settings));
      if (keep && keep !== activeModel(State.settings)) {
        State.settings = withModel(State.settings, p.id, keep);
        saveSettings();
        onChange();
      }
      drawModels(p, models);
    } catch (err) {
      if (ticket === request) status(String(err).replace(/^Error:\s*/, ""), Boolean(p.key));
    }
  }

  function open() {
    isOpen = true;
    el.classList.add("on");
    drawChips();
    onChange();
    // Which subscriptions are on may have changed in Settings: ask, then list.
    void loadSubscriptions().then(() => {
      if (!isOpen) return;
      drawChips();
      onChange();
      void loadModels();
    });
  }

  function close() {
    isOpen = false;
    request++;
    el.classList.remove("on");
    onChange();
  }

  return {
    el,
    open,
    close,
    get isOpen() {
      return isOpen;
    },
  };
}

// ── View ──────────────────────────────────────────────────────────────────────

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: t(STRINGS.placeholderFirst),
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: tl(STRINGS.send) }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  // Above the send button: the mark of who answers, which opens the picker
  // (the model's name is its tooltip, and what a screen reader says), and
  // beside it, once there is a conversation, the button that starts a new one.
  const mark = buildMark();
  const modelName = h("span", { class: "model-name" });
  const modelBtn = h("button", { class: "chat-tool model-btn", title: tl(STRINGS.switchModel) }, mark.el, modelName);
  const fresh = h(
    "button",
    { class: "chat-tool new-chat", title: tl(STRINGS.newChat) },
    svg(ICONS.arrowClockwise, 13, { stroke: 2.2 }),
  );
  const modelRow = h("div", { class: "model-row" }, fresh, modelBtn);

  const body = h("div", { class: "chat-body" });
  let pickerShown = false;
  const picker = buildPicker(() => {
    body.classList.toggle("picking", picker.isOpen);
    drawModelButton();
    // Opening or closing it changes how tall the island is.
    if (pickerShown !== picker.isOpen) {
      pickerShown = picker.isOpen;
      onHeightChange();
    }
  });
  body.append(chipRow, log, picker.el, modelRow, bar);
  void loadSubscriptions().then(() => drawModelButton());

  // Behind Liv, in the room the card leaves it: the specks of the Liv window.
  const stars = buildStars();
  const card = h("div", { class: "card wash chat-card" }, stars.el, body);
  card.style.setProperty("--wash", "rgba(99,102,241,0.5)");
  card.addEventListener("pointermove", (e) => stars.pointer(e as PointerEvent));
  card.addEventListener("pointerleave", () => stars.pointer(null));
  const el = h("div", { class: "view" }, card);

  let sending = false;
  let renderedCount = -1;
  // A local model answers token by token: where its text so far is shown.
  let live: HTMLElement | null = null;

  function drawModelButton() {
    const p = providerDef(State.settings.chatProvider);
    const label = chipLabel(State.settings, activeModel(State.settings)) || t(STRINGS.noModel);
    mark.draw(p.id);
    modelName.textContent = label;
    modelBtn.title = `${tl(p.name)} · ${label}`;
    modelBtn.classList.toggle("open", picker.isOpen);
    modelBtn.disabled = sending;
    // Nothing to start over from an empty chat; and not while an answer is on its way.
    fresh.style.display = State.chatHistory.length > 0 || State.droppedFile ? "" : "none";
    fresh.disabled = sending;
  }

  fresh.addEventListener("click", () => {
    // An answer on its way would land in the new chat.
    if (sending || State.stateOverride === "thinking") return;
    if (picker.isOpen) picker.close();
    State.chatHistory = [];
    State.droppedFile = null;
    void Bridge.chatReset();
    Sound.play("blip");
    State.notify();
    onHeightChange();
    input.focus();
  });

  modelBtn.addEventListener("click", () => {
    if (sending) return;
    if (picker.isOpen) picker.close();
    else picker.open();
  });

  void onEvent<string>("chat-delta", (text) => {
    if (!sending || !text) return; // nothing visible yet: the dots stay
    if (!live) {
      live = h("div", { class: "reply" });
      log.querySelector(".typing")?.parentElement?.remove();
      log.append(h("div", { class: "chat-row" }, live));
    }
    renderMarkdown(live, text);
    log.scrollTop = log.scrollHeight;
  });

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    if (picker.isOpen) picker.close();
    input.value = "";
    sending = true;
    drawModelButton();
    Sound.play("send");

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      const reply = await Bridge.chatSend(query, context);
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      live = null;
      renderedCount = -1; // the finished answer replaces the streamed one
      drawModelButton();
      State.notify();
      onHeightChange();
      // Back to typing without a click. The field was disabled while the
      // answer came, which took the focus away, and the sync that enables it
      // again is a frame away: a disabled field can't take the focus.
      if (State.view === "prompt") {
        input.disabled = false;
        input.focus();
      }
    }
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (key === "Escape" && picker.isOpen) {
      e.preventDefault();
      picker.close();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount && !live) {
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      // Leaving the chat folds the picker away.
      if (State.view !== "prompt" && picker.isOpen) picker.close();
      drawModelButton();

      input.placeholder = t(State.chatHistory.length === 0 ? STRINGS.placeholderFirst : STRINGS.placeholderNext);
      input.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
    /** Room for the picker's lists while it is open; the chat's own height otherwise. */
    height() {
      return picker.isOpen ? PICKER_HEIGHT : null;
    },
    /**
     * The specks drift where somebody sees them: on the open island, which
     * already draws every frame for Liv's breath. Folded, parked or paused
     * they stand still and ask for nothing.
     */
    tick(nowMs) {
      if (State.mode !== "expanded" || State.parked || State.paused) {
        stars.rest();
        return false;
      }
      stars.draw(nowMs, providerDef(State.settings.chatProvider).accent);
      return true;
    },
  };
}

// ── Who answers, as a mark ────────────────────────────────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";
/** The centre of each gem in the mark's 24 × 24 box, and how far its points reach. */
const GEM_AT: Record<GemSlot, readonly [number, number]> = { top: [12, 6.4], left: [6.4, 12], right: [17.6, 12], bottom: [12, 17.6] };
const GEM_REACH = 4;

/** Four gems: the one of who answers lit, in its colour (core/chat-look.ts). */
function buildMark(): { el: SVGSVGElement; draw(provider: string): void } {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("class", "model-mark");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", "20");
  el.setAttribute("height", "20");
  el.setAttribute("aria-hidden", "true");
  const gems = new Map<GemSlot, SVGPathElement>();
  for (const slot of Object.keys(GEM_AT) as GemSlot[]) {
    const [cx, cy] = GEM_AT[slot];
    const gem = document.createElementNS(SVG_NS, "path");
    gem.setAttribute("d", `M${cx} ${cy - GEM_REACH}L${cx + GEM_REACH} ${cy}L${cx} ${cy + GEM_REACH}L${cx - GEM_REACH} ${cy}Z`);
    gem.setAttribute("stroke-width", "1.1");
    gem.setAttribute("stroke-linejoin", "round");
    gems.set(slot, gem);
    el.append(gem);
  }
  let drawn = "";
  return {
    el,
    draw(provider) {
      if (provider === drawn) return;
      drawn = provider;
      for (const { slot, color, on } of markFor(provider)) {
        const gem = gems.get(slot)!;
        gem.setAttribute("fill", color);
        gem.setAttribute("stroke", color);
        gem.setAttribute("class", on ? "gem on" : "gem");
      }
    },
  };
}

// ── The specks behind Liv ─────────────────────────────────────────────────────

/** One speck for every this many px² of the room, within these counts: fewer than in the Liv window's wide bands. */
const STARS = { per: 1100, min: 10, max: 40 } as const;
/** How tall the room is counted as when they are first spread: the chat's card at its usual height. */
const ROOM_H = 230;

function buildStars() {
  const el = h("canvas", { class: "chat-stars" }) as HTMLCanvasElement;
  let field: Particle[] = [];
  let pointer: Point | null = null;
  let strength = 0;
  let last = 0;
  /** The room they were last drawn in, px. */
  let room = { w: 0, h: 0 };
  /** "r,g,b" of the colour the specks were last drawn in. */
  let tinted = { hex: "", rgb: "" };
  return {
    el,
    /** Where the pointer is over the card, to push them away; null once it leaves. */
    pointer(e: PointerEvent | null) {
      if (!e) {
        pointer = null;
        return;
      }
      const box = el.getBoundingClientRect();
      pointer = { x: e.clientX - box.left, y: e.clientY - box.top };
    },
    /** The next frame comes after a pause: no jump when they move again. */
    rest() {
      last = 0;
    },
    draw(nowMs: number, color: string) {
      const w = el.clientWidth;
      const height = el.clientHeight;
      const ctx = w && height ? el.getContext?.("2d") : null;
      if (!ctx) return;
      const dt = last ? Math.min(0.05, (nowMs - last) / 1000) : 0;
      last = nowMs;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(height * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(height * dpr);
      }
      if (field.length === 0) field = seedParticles(w, height, particleCount(w, ROOM_H, STARS.per, STARS.min, STARS.max));
      // The card grows with the conversation, and from nothing as the island
      // opens: they keep their places in it, spread over the whole room.
      if (room.w !== w || room.h !== height) {
        if (room.w && room.h) for (const p of field) (p.x *= w / room.w), (p.y *= height / room.h);
        room = { w, h: height };
      }
      if (tinted.hex !== color) {
        const [r, g, b] = hexToRGB(color);
        tinted = { hex: color, rgb: `${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}` };
      }
      strength += ((pointer ? 1 : 0) - strength) * Math.min(1, dt * 4);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintParticles(ctx, field, dt, nowMs / 1000, w, height, pointer, strength, (white, alpha) =>
        `rgba(${white ? "255,255,255" : tinted.rgb},${alpha})`,
      );
    },
  };
}
