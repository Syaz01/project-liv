// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { encodeTarget, type SettingsTarget } from "./settings-target";
import type { AppearanceSettings } from "./appearance";
import type { Settings } from "./state";
import type { RecapHistory, RecapPrefs } from "../recap/summary";
import type { SpotifyState } from "./spotify";
import type { UpdateStatus } from "./update";
import type { Disc } from "../pet/shape";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[liv] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  version: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
  /** The island waits off-screen while another app is full screen (`island-parked` tells when it changes). */
  parked: boolean;
  /**
   * The island's size in force: the one Settings asks for, or less on a
   * display too small for it (`island-scale` tells when it changes).
   */
  scaleInForce: number;
  /** Liv started with the computer, not opened by hand: it does not come out to greet. */
  atLogin: boolean;
  /** Liv's desktop window exists: it can leave the island (src-tauri/src/pet.rs). */
  pet: boolean;
}

/** The two ends of a way of Liv's window, in physical desktop px, and how many of them make a page px. */
export interface PetRoute {
  from: [number, number];
  to: [number, number];
  unit: number;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),
  /** The system's languages as the webview sees them, for Rust's own texts (i18n.rs). */
  setSystemLanguages: (languages: string[]) => call<void>("set_system_languages", { languages }),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /**
   * Settings → Appearance while a slider is dragged: the island takes the
   * shape at once and nothing is written; saveSettings keeps it afterwards.
   */
  previewAppearance: (shape: AppearanceSettings) =>
    call<void>("preview_appearance", {
      width: shape.islandWidth,
      extraHeight: shape.islandExtraHeight,
      radius: shape.islandRadius,
      opacity: shape.islandOpacity,
    }),

  /** Folds the window to `width`×`height` CSS px (the closed island) or grows it back to the panel. */
  setCollapsed: (collapsed: boolean, width?: number, height?: number) =>
    call<void>("set_collapsed", { collapsed, width: width ?? null, height: height ?? null }),

  /**
   * Pushes the island shape in the page's coordinates (CSS px). Rust flips
   * click-through from its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),
  fitZoom: (dpr: number) => call<boolean>("fit_zoom", { dpr }),

  /** Displays the island can be pinned to: `key` is what `settings.screen` stores. */
  listMonitors: () => call<{ key: string; label: string }[]>("list_monitors"),

  openUrl: (url: string) => call<void>("open_url", { url }),
  /** Opens a GitLab link only when it belongs to the configured instance. */
  openGitLabUrl: (url: string) => call<void>("open_gitlab_url", { url }),
  /** Opens the configured Gitea instance without exposing its URL to the page. */
  openGitea: () => call<void>("open_gitea"),
  /** Opens a Gitea link only if it belongs to the configured instance. */
  openGiteaUrl: (url: string) => call<void>("open_gitea_url", { url }),

  /** Which of these sounds have a file of the user's own in the sounds folder. */
  customSounds: (names: readonly string[]) => call<string[]>("custom_sounds", { names }),
  /** The user's file for one sound, as raw bytes. */
  customSound: (name: string) => call<ArrayBuffer>("custom_sound", { name }),
  revealSoundsFolder: () => call<void>("reveal_sounds_folder"),
  /** Tells the island to read the sounds folder again ("sounds-changed"). */
  reloadSounds: () => call<void>("reload_sounds"),

  /** "Open terminal" → opens the folder in VS Code when `code` is on PATH. */
  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),

  /**
   * "Open terminal": the window the session runs in when Rust found it
   * (Windows; Linux on X11 and KDE Plasma), else the folder in VS Code.
   */
  openSession: (sessionId: string | null, path: string | null) =>
    call<boolean>("open_session", { sessionId, path }),

  /** The Claude desktop app, for the Claude Desktop pill. */
  openClaudeDesktop: () => call<boolean>("open_claude_desktop"),

  /**
   * A new Claude Code session: the user's terminal in `folder`, running
   * Claude Code with the prompt (src-tauri/src/launch.rs). False when it couldn't.
   */
  launchSession: (folder: string, prompt: string) => call<boolean>("launch_session", { folder, prompt }),

  /** The system's folder picker, `start` open in it; null when cancelled. */
  pickFolder: (start: string | null) => call<string | null>("pick_folder", { start }),

  /**
   * A file dropped on a session: its window comes forward and the paths are
   * pasted into it. "pasted", "copied" (on the clipboard only) or "failed".
   */
  dropIntoSession: (sessionId: string, path: string | null, paths: string[]) =>
    call<"pasted" | "copied" | "failed">("drop_into_session", { sessionId, path, paths }),

  /** The diff card's ↗: an existing file, in VS Code; never launched by its type. */
  openFileInVSCode: (path: string) => call<boolean>("open_file_in_vscode", { path }),

  /** The Liv window, on the page and the section a link is about; General without one. */
  openSettingsWindow: (target?: SettingsTarget) =>
    call<void>("open_settings_window", { page: target ? encodeTarget(target) : null }),
  /** The Liv window is on screen (shown, not minimised); `hub-visible` tells when it changes. */
  hubShown: () => call<boolean>("hub_shown"),

  /** Writes to %LOCALAPPDATA%\Liv\liv.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: () => call<HookStatus>("hooks_status"),
  /** Pill ID → whether that agent's hooks reach Liv (read-only). */
  agentHooksStatus: () => call<Record<string, boolean>>("agent_hooks_status"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  // ── Other agents (Gemini CLI, Codex, Cursor…) ─────────────────────────────
  agentHooksList: () => call<AgentHookStatus[]>("agent_hooks_list"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  agentHooksPreview: (agent: string, install: boolean) =>
    callOrThrow<AgentHookPlan>("agent_hooks_preview", { agent, install }),
  /**
   * Writes the agent's config — only ever after an explicit click, and only when
   * it still matches the preview the user looked at. Returns the backups taken.
   */
  agentHooksApply: (agent: string, install: boolean, fingerprint: string) =>
    callOrThrow<string>("agent_hooks_apply", { agent, install, fingerprint }),
  /** Settings → Agents → Antigravity → Approve commands from the island, and whether its hooks can wait. */
  agyApprovalsStatus: () => call<AgyApprovalsStatus>("agy_approvals_status"),
  /** Off by default; only from the switch in Settings. */
  agyApprovalsSetEnabled: (enabled: boolean) =>
    callOrThrow<AgyApprovalsStatus>("agy_approvals_set_enabled", { enabled }),
  // ── Plan usage: the status line relay, installed apart from the hooks ──────
  /** Diff of the status line change. `install: false` previews taking the relay out. */
  statusLinePreview: (install: boolean) => callOrThrow<HookPreview>("status_line_preview", { install }),
  /** Same rules as hooksApply: an explicit click, and only for the diff that was shown. */
  statusLineApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("status_line_apply", { install, fingerprint }),
  /**
   * Asks the Codex CLI (`codex app-server`) for its plan limits, as Codex's
   * /status does. The raw `account/rateLimits/read` result, or null when Codex
   * is missing, not signed in or slow (15 s).
   */
  codexPlanUsage: () => call<unknown>("codex_plan_usage"),

  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** Answers a question Claude Code asked: question text → chosen label. */
  approvalAnswer: (requestId: string, answers: Record<string, string | string[]>) =>
    call<void>("approval_answer", { requestId, answers }),

  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /** One chat turn. The API key and any file bytes never leave Rust. */
  chatSend: (query: string, context: ChatContext | null) =>
    callOrThrow<{ text: string }>("chat_send", { query, context }),
  chatReset: () => call<void>("chat_reset"),
  /**
   * The models a provider offers, for the picker in the chat view. Rust asks
   * the provider only when it has a key (or a server address).
   */
  chatModels: (provider: string) => callOrThrow<ModelInfo[]>("chat_models", { provider }),
  claudeApiModels: () => callOrThrow<ModelInfo[]>("claude_api_models"),
  /** The custom server's key, bound to the address it is entered for. */
  localSetKey: (url: string, key: string) => call<void>("local_set_key", { url, key }),
  /** Settings → Local models → Connect: does the server answer, and with which models? */
  localConnect: (provider: "ollama" | "lmstudio" | "custom", url: string) =>
    callOrThrow<LocalServer>("local_connect", { provider, url }),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  /** Whether Claude can answer: the API key, or else the user's own Claude Code. */
  claudeReady: () => call<boolean>("claude_ready"),
  /** Settings → Chat → Your AI subscriptions: each switch and whether its tool is installed. */
  subscriptionStatus: () => call<SubscriptionStatus[]>("subscription_status"),
  /** Moves a switch; returns the rows as they are now. */
  subscriptionSet: (provider: string, on: boolean) =>
    call<SubscriptionStatus[]>("subscription_set", { provider, on }),
  /** Whether a provider can answer with this key: Claude Code stands in for a missing Anthropic one. */
  keyReady: (key: string) =>
    key === "anthropic-api-key" ? call<boolean>("claude_ready") : call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** The GitHub card is on screen: refetch that part if it is stale. */
  githubRefresh: (section: "pulse" | "activity") => call<void>("github_refresh", { section }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),

  // ── Global shortcuts ──────────────────────────────────────────────────────
  /** How each global shortcut went when Rust last registered them. */
  shortcutsStatus: () => call<ShortcutsReport>("shortcuts_status"),
  /** Lets go of every global shortcut while Settings records a new one. */
  shortcutsSuspend: (suspended: boolean) => call<void>("shortcuts_suspend", { suspended }),

  // ── Weekly recap ──────────────────────────────────────────────────────────
  /** Turns and decisions from `since` (Unix seconds) on, plus the recap prefs. */
  recapHistory: (since: number) => call<RecapHistory>("recap_history", { since: Math.floor(since) }),
  recapPrefs: () => call<RecapPrefs>("recap_prefs"),
  recapSetEnabled: (enabled: boolean) => call<void>("recap_set_enabled", { enabled }),
  recapSetHideProjects: (hide: boolean) => call<void>("recap_set_hide_projects", { hide }),
  /** `week` is the Monday (YYYY-MM-DD) the recap opened on its own for. */
  recapMarkShown: (week: string) => call<void>("recap_mark_shown", { week }),
  recapClear: () => call<void>("recap_clear"),
  /** Writes the PNG (a data URL) into Pictures or Downloads; returns its path. */
  recapSavePng: (data: string, week: string) => callOrThrow<string>("recap_save_png", { data, week }),
  /** Opens the folder of the image saved last. */
  recapRevealSaved: () => call<void>("recap_reveal_saved"),

  // ── Liv on the desktop (src-tauri/src/pet.rs) ─────────────────────────────
  /** The window's page: Liv's silhouette, the only part of the window that takes the mouse. */
  petShape: (shape: Disc[]) => call<void>("pet_shape", { shape }),
  /** The window's page: its pixel ratio, for the zoom that follows the island's size. */
  petFitZoom: (dpr: number) => call<boolean>("pet_fit_zoom", { dpr }),
  /** The window's page: whether the window is on screen (`pet-shown` tells when it changes). */
  petShown: () => call<boolean>("pet_shown"),
  /** The window's page: asleep, the cursor poll drops to its slowest. */
  petAsleep: (asleep: boolean) => call<void>("pet_asleep", { asleep }),
  /**
   * The two ends of the way to Liv's spot, or home; (x, y) is where Liv is in
   * the island's page. Null: nowhere to go (`anywhere` picks a spot when the
   * remembered one is gone).
   */
  petRoute: (to: "spot" | "home", x: number, y: number, anywhere: boolean) =>
    call<PetRoute>("pet_route", { to, x, y, anywhere }),
  /** Moves the window along `points` over `ms`; resolves once Liv is there, false when overtaken. */
  petTravel: (points: [number, number][], ms: number, to: "spot" | "home") =>
    call<boolean>("pet_travel", { points, ms, to }),
  /** Liv starts at its spot, without the way there. False: the spot is gone. */
  petAppear: () => call<boolean>("pet_appear"),
  /** Dragged out of the island: the window appears under the pointer, which carries it. */
  petPickUp: () => call<boolean>("pet_pick_up"),
  /** The window's page: a drag started on Liv, the pointer carries the window. */
  petGrab: () => call<boolean>("pet_grab"),
  /** Dropped on the desktop: Liv stays there. */
  petSettle: () => call<void>("pet_settle"),
  /** The window is put away. `forget`: Liv lives in the island again. */
  petHide: (forget: boolean) => call<void>("pet_hide", { forget }),
  /** Settings: Liv on the desktop, or back home. False where it cannot leave the island. */
  petAsk: (out: boolean) => call<boolean>("pet_ask", { out }),

  // ── Spotify (src-tauri/src/spotify.rs) ────────────────────────────────────
  /** Reads the player again (the card came on screen) and reports it. */
  spotifyRefresh: () => call<SpotifyState | null>("spotify_refresh"),
  /** True when Spotify took it. `value`: seconds for seek, 0/1 for shuffle and repeat, 0…100 for volume. */
  spotifyControl: (action: SpotifyAction, value?: number) =>
    call<boolean>("spotify_control", { action, value: value ?? null }),
  /** Brings Spotify forward or starts it, when it is the player shown or nothing plays. */
  spotifyOpen: () => call<boolean>("spotify_open"),

  // ── Clipboard history (src-tauri/src/clipboard.rs), the island's alone ────
  /** The list as it is now; `clipboard-history` brings every change. Read it through clipEntries(). */
  clipboardHistory: () => call<unknown>("clipboard_history"),
  /**
   * Puts an entry back on the clipboard and pastes it in the app in front:
   * "pasted", "copied" (on the clipboard only), "gone" (no such entry any
   * more) or "failed". An id, never a text.
   */
  clipboardPaste: (id: number) => call<string>("clipboard_paste", { id }),
  clipboardRemove: (id: number) => call<void>("clipboard_remove", { id }),
  clipboardClear: () => call<void>("clipboard_clear"),

  // ── The shelf (src-tauri/src/shelf.rs), the island's alone ────────────────
  /** The list as it is now; `shelf` brings every change. Read it through shelfItems(). */
  /** A download Rust announced, by its number: opened, shown in its folder, or put on the shelf. False when it has gone. */
  downloadOpen: (id: number) => call<boolean>("download_open", { id }),
  downloadReveal: (id: number) => call<boolean>("download_reveal", { id }),
  downloadShelve: (id: number) => call<boolean>("download_shelve", { id }),
  shelfList: () => call<unknown>("shelf_list"),
  /** A file dropped on the shelf: Rust only takes a path that a real drop just delivered. */
  shelfAdd: (path: string) => call<void>("shelf_add", { path }),
  shelfRemove: (id: number) => call<void>("shelf_remove", { id }),
  shelfClear: () => call<void>("shelf_clear"),
  /** Opens the item with the app the system has for it. */
  shelfOpen: (id: number) => call<boolean>("shelf_open", { id }),
  /** The file manager on the item's folder, the item selected. */
  shelfReveal: (id: number) => call<boolean>("shelf_reveal", { id }),
  /** The file itself onto the clipboard: "copied", "gone" (no such file any more) or "failed". */
  shelfCopy: (id: number) => call<string>("shelf_copy", { id }),
  /**
   * Drags the item out of the island, into whatever app it is let go on.
   * Asked for while the button is still down; answers when the drag is over.
   */
  shelfDrag: (id: number) => call<boolean>("shelf_drag", { id }),

  // ── Screenshots (src-tauri/src/capture.rs) ────────────────────────────────
  /** The display the pointer is on; `capture` says how it went. */
  captureScreen: () => call<void>("capture_screen"),
  /** An area the user drags out; `capture` says how it went, and nothing when it was cancelled. */
  captureArea: () => call<void>("capture_area"),
  /** Settings: the folder screenshots are saved in, made if it is not there. */
  openCapturesFolder: () => call<void>("open_captures_folder"),

  // ── New versions (src-tauri/src/update.rs) ────────────────────────────────
  updateStatus: () => call<UpdateStatus>("update_status"),
  /** The island's question or Settings' toggle: may Liv look at GitHub on its own? */
  updateSetConsent: (allowed: boolean) => call<void>("update_set_consent", { allowed }),
  /** "Check now": one look at GitHub, the toggle on or off. */
  updateCheck: () => call<UpdateStatus>("update_check"),
  /** The island opened the card Rust offered ("ask" or "announce"). */
  updateShown: (kind: "ask" | "announce") => call<void>("update_shown", { kind }),
  /** Settings → Install X: opens the island's update card. */
  updateShow: () => call<void>("update_show"),
  updateLater: () => call<void>("update_later"),
  /** The tray icon turns blue while a new version waits (tray.rs). */
  trayUpdateHint: (on: boolean) => call<void>("tray_update_hint", { on }),
  updateDismiss: () => call<void>("update_dismiss"),
  /** "Update now" (Windows): download, check the SHA-256, run the installer, quit. */
  updateInstall: () => call<void>("update_install"),
  /** The release's page on github.com. */
  updateOpenPage: () => call<void>("update_open_page"),
};

export type SpotifyAction = "playPause" | "next" | "previous" | "seek" | "shuffle" | "repeat" | "volume";

export type ShortcutStatus =
  | "active" | "off" | "inUse" | "duplicate" | "invalid"
  | "typesCharacter" | "unsupported"
  /** Wayland: handed to the desktop's portal, no answer yet / left out by it. */
  | "pending" | "refused";

export interface ShortcutsReport {
  /** `trigger`: on Wayland, the keys the desktop says run it, in its words. */
  actions: { id: string; status: ShortcutStatus; typed?: string; trigger?: string }[];
  /** "wayland" or "no-display" when no key grab can be made. */
  blocked: string | null;
  /** `<executable> --shortcut`: append an action id for a desktop shortcut. */
  command: string;
  /** Wayland: the shortcuts went to the desktop's GlobalShortcuts portal. */
  portal?: "pending" | "active" | null;
}

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export interface ChatContext {
  kind: "file";
  name: string;
  path: string;
}

export interface ModelInfo {
  id: string;
  label: string;
}

/** One row of Settings → Chat → Your AI subscriptions (cli_relay.rs `Status`). */
export interface SubscriptionStatus {
  provider: string;
  /** The terminal tool that answers, or would once installed. */
  tool: string;
  installed: boolean;
  on: boolean;
  /** What to type once in a terminal to sign in. */
  signIn: string;
  installUrl: string;
  subscriptionOnly: boolean;
}

export interface LocalServer {
  /** The address as it is stored. */
  url: string;
  models: string[];
}

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface HookStatus {
  installed: boolean;
  /** Liv's status line relay (plan usage) is the status line in settings.json. */
  planRelayInstalled: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

export interface AgyApprovalsStatus {
  enabled: boolean;
  /** Liv's PreToolUse hook can wait for a click (120 s); older hooks (10 s) must be installed again. */
  hooksReady: boolean;
}

/** One agent other than Claude Code, as agents.rs reports it. */
export interface AgentHookStatus {
  /** The `--agent` name; its pill is `agent_<id>`. */
  id: string;
  name: string;
  installed: boolean;
  /** The file (or files, one per line) Liv writes. */
  path: string;
  hookReady: boolean;
  /** The island can allow or deny this agent's permission requests. */
  approvals: boolean;
  /** What to do once it is written. */
  note: string;
}

export interface AgentHookPlan {
  diff: string;
  /** Where each existing file is copied first, one per line; "" when none. */
  backup: string;
  path: string;
  fingerprint: string;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Liv");
  return invoke<T>(cmd, args);
}

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
  /** Where the pointer is, in physical pixels of the webview (Tauri's own drag events, Linux). */
  position?: { x: number; y: number };
}

interface WebView2Bridge {
  postMessageWithAdditionalObjects(message: unknown, objects: ArrayLike<unknown>): void;
}

/**
 * Files dragged onto the island. Only reaches us when the window takes the mouse.
 *
 * On Windows WebView2 takes the drop itself, as in Edge — Tauri's drop handling
 * never sees drags from the classic Explorer folder view (see
 * src-tauri/src/webview_drop.rs). Enter/over/leave come straight from the page;
 * the drop hands the File objects to Rust, which answers with their real paths
 * as a `file-drag` event. Elsewhere (Linux) Tauri's own drag events still do it.
 */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  const webview = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
  if (!webview) {
    return getCurrentWebview().onDragDropEvent((event) => {
      handler(event.payload as DragDropPayload);
    });
  }
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
  // dragenter/dragleave fire for every element crossed; only the outermost pair counts.
  let depth = 0;

  // A link or a piece of text dragged in is refused. Left to the webview, a
  // dropped link is followed, and the island's page is gone with all it holds.
  const refuse = (e: DragEvent) => {
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };

  const onEnter = (e: DragEvent) => {
    e.preventDefault();
    if (!hasFiles(e)) return refuse(e);
    if (depth++ === 0) handler({ type: "enter" });
  };
  const onOver = (e: DragEvent) => {
    // Without this WebView2 refuses the drop — or navigates to the file.
    e.preventDefault();
    if (!hasFiles(e)) return refuse(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    handler({ type: "over" });
  };
  const onLeave = (e: DragEvent) => {
    if (!hasFiles(e) || depth === 0) return;
    if (--depth === 0) handler({ type: "leave" });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (!hasFiles(e)) return;
    depth = 0;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      handler({ type: "drop", paths: [] });
      return;
    }
    webview.postMessageWithAdditionalObjects("liv-file-drop", files);
  };

  window.addEventListener("dragenter", onEnter);
  window.addEventListener("dragover", onOver);
  window.addEventListener("dragleave", onLeave);
  window.addEventListener("drop", onDrop);
  const unlisten = await listen<DragDropPayload>("file-drag", (e) => handler(e.payload));
  return () => {
    window.removeEventListener("dragenter", onEnter);
    window.removeEventListener("dragover", onOver);
    window.removeEventListener("dragleave", onLeave);
    window.removeEventListener("drop", onDrop);
    unlisten();
  };
}

/** An event for one window only (the island ⇄ Liv's desktop window). Never throws. */
export async function emitToWindow(label: string, event: string, payload?: unknown) {
  if (!IS_TAURI) return;
  try {
    await emitTo(label, event, payload);
  } catch (err) {
    console.error(`[liv] emit ${event} failed`, err);
  }
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
