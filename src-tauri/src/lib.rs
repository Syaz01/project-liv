// Liv for Windows — app wiring and the commands the island calls.

mod agent_hooks;
mod agents;
mod agy_approvals;
mod agy_rules;
mod appearance;
mod chat;
mod claude;
mod claude_code;
mod cli_relay;
mod clipboard;
mod codex_plan;
mod config_file;
mod downloads;
mod files;
mod fullscreen;
mod github;
mod herdr;
mod hooks;
mod i18n;
mod identity;
mod integrations;
mod calcom;
mod capture;
mod island;
mod launch;
mod local_chat;
mod log;
mod net;
mod openai_compat;
mod paste;
mod pet;
mod pipe;
mod platform;
#[cfg(target_os = "linux")]
mod portal;
mod recap;
mod scale;
mod secrets;
mod session_window;
mod settings;
mod shelf;
mod shortcuts;
mod sounds;
mod spotify;
mod tray;
mod unhook;
mod update;
#[cfg(windows)]
mod webview_drop;
#[cfg(windows)]
mod webview_guard;
mod webview_memory;

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use chat::{Chat, ChatContext, ChatReply, ModelInfo};
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::PollGate;
use pipe::Pending;
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    version: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
    /// The island waits off-screen while another app is full screen. The page
    /// may have missed the `island-parked` event that said so at launch.
    parked: bool,
    /// The island's size in force (scale.rs): the one Settings asks for, or
    /// less on a display too small for it.
    scale_in_force: f64,
    /// Liv started with the computer, not opened by the user: the island
    /// shows itself without the greeting.
    at_login: bool,
    /// Liv's desktop window exists (pet.rs): it can leave the island.
    pet: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    let hooks_status = hooks::status();
    settings.hooks_installed = hooks_status.installed;
    settings.plan_relay_installed = hooks_status.plan_relay_installed;
    BootInfo {
        settings,
        version: env!("CARGO_PKG_VERSION").to_string(),
        cursor_poll: platform::CURSOR_POLL,
        parked: shared.gate.parked(),
        scale_in_force: shared.gate.scale(),
        at_login: launched_at_login(),
        pet: app.try_state::<Arc<pet::Pet>>().is_some_and(|pet| pet.exists),
    }
}

/// The island's window, Liv's and what Settings shows follow a change of the
/// island's geometry: its display, its size, or the panel of its shape.
fn geometry_changed(app: &AppHandle, gate: &PollGate) {
    island::apply_geometry(app);
    // Liv on the desktop is the island's size.
    pet::apply_scale(app);
    // Settings hears the size in force even when it stayed the same: a
    // bigger size was asked for than this display fits.
    let _ = app.emit(island::SCALE_EVENT, gate.scale());
}

/// How long the window waits before it follows a panel that got smaller: the
/// island folds to its new size first (340 ms, src/core/anim.ts), or the
/// window would cut it on the way.
const PANEL_SHRINK_DELAY: std::time::Duration = std::time::Duration::from_millis(380);

/// Puts the panel of the open island's shape in force (appearance.rs), and
/// resizes the window when it changed: at once when the island grows, a
/// moment later when it only shrinks, and then only for the last of a run of
/// changes (a slider being dragged). True when the window was resized now.
fn panel_changed(app: &AppHandle, gate: &Arc<PollGate>, panel: (f64, f64)) -> bool {
    let old = gate.set_panel(panel);
    if old == panel {
        return false;
    }
    if panel.0 > old.0 || panel.1 > old.1 {
        geometry_changed(app, gate);
        return true;
    }
    let ticket = gate.note_shrink();
    let (handle, gate) = (app.clone(), gate.clone());
    std::thread::spawn(move || {
        std::thread::sleep(PANEL_SHRINK_DELAY);
        if !gate.last_shrink(ticket) {
            return;
        }
        let main = handle.clone();
        let _ = handle.run_on_main_thread(move || geometry_changed(&main, &gate));
    });
    false
}

/// The four settings of the open island's shape, as the island's page hears
/// them while a slider is dragged (`preview_appearance`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppearancePreview {
    island_width: f64,
    island_extra_height: f64,
    island_radius: f64,
    island_opacity: f64,
}

/// Settings → Appearance, while a slider is dragged: the island takes the new
/// shape at once — the settings in memory, the window's panel, the page —
/// and nothing is written to disk. The settings window saves a moment after
/// the last move (`save_settings`), which is what keeps it.
#[tauri::command]
fn preview_appearance(
    app: AppHandle,
    shared: State<Shared>,
    width: f64,
    extra_height: f64,
    radius: f64,
    opacity: f64,
) {
    let (preview, panel) = {
        let mut current = shared.settings.lock().unwrap();
        current.island_width = width;
        current.island_extra_height = extra_height;
        current.island_radius = radius;
        current.island_opacity = opacity;
        appearance::clamp(&mut current);
        let preview = AppearancePreview {
            island_width: current.island_width,
            island_extra_height: current.island_extra_height,
            island_radius: current.island_radius,
            island_opacity: current.island_opacity,
        };
        (preview, appearance::panel_of(&current))
    };
    // The window first, so the island never grows past it.
    panel_changed(&app, &shared.gate, panel);
    let _ = app.emit_to(island::WINDOW_LABEL, "island-appearance", preview);
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (settings, place_changed, fullscreen_changed, autostart_changed, shortcuts_changed) = {
        let mut current = shared.settings.lock().unwrap();
        // The display the island lives on, or its size.
        let place_changed = current.screen != settings.screen || current.island_scale != settings.island_scale;
        let fullscreen_changed = current.hide_on_fullscreen != settings.hide_on_fullscreen;
        let autostart_changed = current.autostart != settings.autostart;
        let shortcuts_changed = current.shortcuts != settings.shortcuts;
        let mut settings = settings.clone();
        // Antigravity approvals: only their own switch changes them (agy_approvals.rs).
        settings.agy_approvals_enabled = current.agy_approvals_enabled;
        // Where Liv lives and where it was left are pet.rs's to say, not a webview's.
        settings.pet_out = current.pet_out;
        settings.pet_spot = current.pet_spot.clone();
        // The open island's shape, each number inside its range whatever was sent.
        appearance::clamp(&mut settings);
        *current = settings;
        (current.clone(), place_changed, fullscreen_changed, autostart_changed, shortcuts_changed)
    };
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[liv] autostart: {err}");
        }
    }
    // The open island made wider or taller: its window follows. One resize
    // serves both when the display or the island's size changed too.
    let resized = panel_changed(&app, &shared.gate, appearance::panel_of(&settings));
    if place_changed && !resized {
        geometry_changed(&app, &shared.gate);
    }
    // "Hide when an app is full screen" switched: the island leaves or comes
    // back now, not at the poll's next look.
    if fullscreen_changed {
        island::watch_fullscreen(&app, &shared.gate);
    }
    integrations::settings_saved(&app, &settings.active_integrations);
    spotify::sync(&app, &settings.active_integrations);
    // "Clipboard history" switched: the listener starts, or ends and forgets.
    clipboard::sync(&app, settings.clipboard_history);
    // "Tell me when a download finishes" switched.
    downloads::sync(&app, settings.download_alerts);
    if shortcuts_changed {
        shortcuts::apply(&app, &settings.shortcuts);
    }
    if i18n::set_picked(&settings.language) {
        language_changed(&app);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// The island reports the system's languages at launch, for "System" in
/// Settings → Language (WebView2 and WebKitGTK know them best).
#[tauri::command]
fn set_system_languages(app: AppHandle, languages: Vec<String>) {
    if i18n::set_system(languages) {
        language_changed(&app);
    }
}

/// What Rust labels itself follows the new language: the tray menu. The
/// webviews switch on their own.
fn language_changed(app: &AppHandle) {
    tray::retitle(app);
}

/// Hidden island → the cursor poll parks, and the window waits for the cursor
/// on the closed island (the invisible wake strip when it shows nothing): on
/// Windows it stays as it is and lets the mouse through, elsewhere it shrinks
/// to the closed island (island::apply_geometry). Anything else → full panel
/// and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool, width: Option<f64>, height: Option<f64>) {
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    // No size: the wake strip.
    let size = island::clamp_collapsed(
        (width.unwrap_or(island::STRIP_W), height.unwrap_or(island::STRIP_H)),
        shared.gate.panel(),
    );
    *shared.gate.collapsed_size.lock().unwrap() = size;
    // The poll stops first: a tick of it after this could make the closed
    // island click-through again (see spawn_cursor_poll).
    if collapsed {
        shared.gate.set_active(false);
    }
    island::apply_geometry(&app);
    // Folded, the closed island must be found by the mouse (or, in place, by the
    // poll); open, the window takes the mouse until the next tick decides.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed);
    platform::set_pointer_watch(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle) {
    island::apply_geometry(&app);
    pet::apply_scale(&app);
}

/// The panel is laid out in CSS px against the window's own scale. If the webview
/// reports a different devicePixelRatio (it ends up bigger than the window and gets
/// cut), correct its zoom so one CSS px is one logical px again — or, with the
/// island drawn bigger (Settings → Island size), as many logical px as that size.
#[tauri::command]
fn fit_zoom(app: AppHandle, shared: State<Shared>, dpr: f64) -> bool {
    let Some(win) = island::window(&app) else { return false };
    shared.gate.fit_zoom(&win, dpr)
}


/// The displays the island can be pinned to, for Settings.
#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<island::MonitorChoice> {
    island::monitor_choices(&app)
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

/// Opens a GitLab link only when it belongs to the configured instance. This
/// also covers self-hosted installations without exposing their token.
#[tauri::command]
fn open_gitlab_url(url: String) {
    let base = secrets::get("gitlab-url").unwrap_or_else(|| "https://gitlab.com".into());
    let (Ok(target), Ok(instance)) = (reqwest::Url::parse(&url), reqwest::Url::parse(base.trim())) else { return };
    if is_forge_instance_url(&target, &instance) {
        open_url(url);
    }
}

fn is_forge_instance_url(target: &reqwest::Url, instance: &reqwest::Url) -> bool {
    if !matches!(target.scheme(), "http" | "https")
        || target.scheme() != instance.scheme()
        || target.host_str() != instance.host_str()
        || target.port_or_known_default() != instance.port_or_known_default()
    {
        return false;
    }
    let base = instance.path().trim_end_matches('/');
    base.is_empty() || target.path() == base || target.path().starts_with(&format!("{base}/"))
}

/// The configured Gitea address is a credential-store value, so the island
/// asks Rust to open it instead of ever receiving it.
#[tauri::command]
fn open_gitea() {
    if let Some(url) = secrets::get("gitea-url") {
        open_url(url);
    }
}

#[tauri::command]
fn open_gitea_url(url: String) {
    let (Ok(target), Some(base)) = (reqwest::Url::parse(&url), secrets::get("gitea-url")) else { return };
    let Ok(instance) = reqwest::Url::parse(&base) else { return };
    if is_forge_instance_url(&target, &instance) {
        open_url(url);
    }
}

/// "Open terminal" opens the working folder in VS Code when `code` is on PATH,
/// and falls back to the file manager otherwise.
#[tauri::command]
fn open_in_vscode(path: Option<String>) -> bool {
    // No shell anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and a shell would happily read `&`, `^`, `%`
    // or `$` in a folder name as syntax. Finding the launcher ourselves and
    // handing the path over as a separate argument keeps it a path.
    let path = path.filter(|p| !p.is_empty());
    // It arrives in a hook payload: only an existing folder, given by its full
    // path, goes any further. `code` would read `--something` as an option, and
    // xdg-open would launch a file with whatever handles its type.
    if let Some(p) = path.as_deref() {
        let p = std::path::Path::new(p);
        if !(p.is_absolute() && p.is_dir()) {
            return false;
        }
    }
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref() {
            cmd.arg(p);
        }
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref() {
        platform::reveal_folder(p);
    }
    false
}

/// "Open terminal": brings forward the terminal or editor window the session
/// runs in, when it was found (see session_window.rs); otherwise opens the
/// folder in VS Code, as before. A session in herdr also gets its pane selected,
/// and never falls back to VS Code.
#[tauri::command]
fn open_session(session_id: Option<String>, path: Option<String>) -> bool {
    let in_herdr = session_id.as_deref().is_some_and(herdr::focus);
    let Some(owners) = session_id.as_deref().and_then(session_window::lookup) else {
        return in_herdr || open_in_vscode(path);
    };
    let folder = path.as_deref().map(session_window::folder_name).unwrap_or_default().to_string();
    #[cfg(windows)]
    {
        if platform::focus_session_window(&owners, &folder) || in_herdr {
            return true;
        }
        open_in_vscode(path)
    }
    // Linux asks the display server, KWin or the terminal, which can take a
    // moment: never on the UI thread a sync command runs on. VS Code still
    // opens when none of them could bring the window forward.
    #[cfg(target_os = "linux")]
    {
        std::thread::spawn(move || {
            if !platform::focus_session_window(&owners, &folder) && !in_herdr {
                open_in_vscode(path);
            }
        });
        true
    }
}

/// The Claude Desktop pill's target: the Claude app (Windows, and Linux with
/// Anthropic's .deb).
#[tauri::command]
fn open_claude_desktop() -> bool {
    platform::open_claude_desktop()
}

/// The file behind a live diff, if it may be handed to the editor: an existing
/// regular file given by its full path. Anything else — a relative path, a
/// folder, a path `code` could read as an option — goes no further.
fn diff_file(path: &str) -> Option<&std::path::Path> {
    let p = std::path::Path::new(path);
    (p.is_absolute() && p.is_file()).then_some(p)
}

/// The diff card's ↗: opens the edited file in VS Code when `code` is on PATH,
/// otherwise shows its folder. The file itself is never opened by its type —
/// xdg-open or Explorer would run a script that Claude just wrote.
#[tauri::command]
fn open_file_in_vscode(path: String) -> bool {
    let Some(file) = diff_file(&path) else { return false };
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        cmd.arg(file);
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(folder) = file.parent().filter(|d| d.is_dir()) {
        platform::reveal_folder(&folder.to_string_lossy());
    }
    false
}

/// Tray → Pause, or anything else that pauses or resumes the island. Paused
/// means paused: the pollers stop talking to the network, not just the island
/// stopping showing things. The tray's item then offers the way back. Liv on
/// the desktop leaves the screen with the island, and comes back with it.
#[tauri::command]
fn set_paused(app: AppHandle, paused: bool) {
    integrations::set_paused(paused);
    pet::set_paused(&app, paused);
    tray::retitle(&app);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

/// Pill ID → whether that agent's hooks reach Liv. Read-only.
#[tauri::command]
fn agent_hooks_status() -> std::collections::HashMap<String, bool> {
    agent_hooks::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        if let Err(err) = settings::save(&current) {
            log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

// ── Other agents' hooks and plugins ──────────────────────────────────────────

#[tauri::command]
fn agent_hooks_list() -> Vec<agents::AgentStatus> {
    agents::list()
}

/// The diff the user has to look at before anything is written.
#[tauri::command]
fn agent_hooks_preview(agent: String, install: bool) -> Result<config_file::Plan, String> {
    agents::preview(&agent, install)
}

/// Only ever called from an explicit click in the settings window, with the
/// fingerprint of the preview the user looked at.
#[tauri::command]
fn agent_hooks_apply(agent: String, install: bool, fingerprint: String) -> Result<String, String> {
    let backups = agents::apply(&agent, install, &fingerprint)?;
    let done = if install { "installed" } else { "removed" };
    log::line(format!("agent hooks {done} for {agent}"));
    Ok(backups)
}

// ── Plan usage ────────────────────────────────────────────────────────────────

/// The diff of putting the plan usage relay into (or taking it out of) the
/// status line, before anything is written.
#[tauri::command]
fn status_line_preview(install: bool) -> Result<HookPreview, String> {
    hooks::status_line_preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn status_line_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    let backup = hooks::status_line_write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.plan_relay_installed = install;
        // As on the Mac: taking the relay out turns the pill off with it.
        if !install {
            current.show_plan_in_notch = false;
            current.show_plan_in_compact_island = false;
        }
        if let Err(err) = settings::save(&current) {
            log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

/// Codex plan usage, asked of the Codex CLI (`codex app-server`) when its pill
/// shows. Off the main thread: it can take a few seconds.
#[tauri::command]
async fn codex_plan_usage() -> Option<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(codex_plan::read).await.ok().flatten()
}

/// A permission request is answered on the island's card and nowhere else: the
/// four commands below refuse a call from any other window (the Liv window,
/// Liv on the desktop), whatever it says. So do the clipboard history's
/// (clipboard.rs), the shelf's (shelf.rs) and the screenshots' (capture.rs):
/// what was copied or kept at hand is the island's to show, paste and open.
pub(crate) fn from_island(window: &tauri::WebviewWindow) -> Result<(), String> {
    island_only(window.label())
}

fn island_only(label: &str) -> Result<(), String> {
    if label == island::WINDOW_LABEL {
        Ok(())
    } else {
        Err("only the island may answer a request".into())
    }
}

#[tauri::command]
fn approval_decision(
    app: AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
    decision: String,
) -> Result<(), String> {
    from_island(&window)?;
    recap::record_decision(&app, &request_id, &decision);
    pipe::answer(&app, &request_id, &decision);
    Ok(())
}

/// An option picked on the island for a question Claude Code asked.
#[tauri::command]
fn approval_answer(
    app: AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
    answers: std::collections::HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    from_island(&window)?;
    // An answered question is not an Allow / Deny: nothing for the recap.
    recap::forget_request(&app, &request_id);
    pipe::answer_question(&app, &request_id, &answers);
    Ok(())
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, window: tauri::WebviewWindow, request_id: String) -> Result<(), String> {
    from_island(&window)?;
    pipe::acknowledge(&app, &request_id);
    Ok(())
}

/// Nobody can act on this request — the island is paused or parked off-screen
/// for a full-screen app, or another card is already up. Claude Code falls back
/// to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, window: tauri::WebviewWindow, request_id: String) -> Result<(), String> {
    from_island(&window)?;
    recap::forget_request(&app, &request_id);
    pipe::decline(&app, &request_id);
    Ok(())
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// One chat turn with the provider picked in the chat view. API keys and any
/// file bytes stay on the Rust side.
#[tauri::command]
async fn chat_send(
    app: AppHandle,
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let settings = shared.settings.lock().unwrap().clone();
    chat::send(&app, &chat, &settings, query, context).await
}

/// The models a provider offers, for the picker in the chat view. Only asked
/// once the user picked that provider, and only with its key or address.
#[tauri::command]
async fn chat_models(shared: State<'_, Shared>, provider: String) -> Result<Vec<ModelInfo>, String> {
    let settings = shared.settings.lock().unwrap().clone();
    chat::models(&settings, &provider).await
}

/// The Claude API settings use their own key even when chat uses a CLI plan.
#[tauri::command]
async fn claude_api_models() -> Result<Vec<ModelInfo>, String> {
    claude::available_models().await
}

/// Settings → Local models → Connect: does the server answer, and with which models?
#[tauri::command]
async fn local_connect(provider: String, url: String) -> Result<local_chat::Connected, String> {
    local_chat::connect(&provider, &url).await
}

/// Stores the custom server's key for the address typed next to it; it is only
/// ever sent to that address.
#[tauri::command]
fn local_set_key(url: String, key: String) -> Result<(), String> {
    local_chat::set_custom_key(&url, &key)
}

#[tauri::command]
fn chat_reset(chat: State<Chat>) {
    chat.reset();
}

/// Copies a dropped file into the inbox and reports its name back. What Liv
/// takes is also kept at hand: the original goes on the shelf (shelf.rs).
#[tauri::command]
fn ingest_file(app: AppHandle, path: String) -> Result<DroppedFile, String> {
    let file = files::ingest(&path)?;
    shelf::add_later(&app, path);
    Ok(file)
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

/// Whether Claude can answer: an API key, or else the user's own Claude Code.
#[tauri::command]
fn claude_ready() -> bool {
    claude::ready()
}

/// Settings → Chat → Your AI subscriptions: each provider's switch and
/// whether its terminal tool is installed (looked up again on every call).
#[tauri::command]
fn subscription_status(shared: State<Shared>) -> Vec<cli_relay::Status> {
    let settings = shared.settings.lock().unwrap().clone();
    cli_relay::status(&settings)
}

/// A switch under "Your AI subscriptions" moved: saved, and both windows told.
#[tauri::command]
fn subscription_set(app: AppHandle, shared: State<Shared>, provider: String, on: bool) -> Vec<cli_relay::Status> {
    let settings = {
        let mut current = shared.settings.lock().unwrap();
        cli_relay::set(&mut current, &provider, on);
        current.clone()
    };
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    let status = cli_relay::status(&settings);
    let _ = app.emit("settings-changed", settings);
    status
}

#[tauri::command]
fn secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    // Bound to its server's address: only local_set_key may store it.
    if key == local_chat::CUSTOM_KEY {
        return Err("use local_set_key".into());
    }
    let before = (key == "github-token").then(|| secrets::get(&key));
    secrets::set(&key, &value)?;
    if let Some(before) = before {
        if secrets::get(&key) != before {
            integrations::github_token_changed(&app);
        }
    }
    if key == "gitea-token" || key == "gitea-url" {
        integrations::gitea_credentials_changed(&app);
    }
    Ok(())
}

#[tauri::command]
fn secret_clear(app: AppHandle, key: String) -> Result<(), String> {
    let had = key == "github-token" && secrets::present(&key);
    secrets::clear(&key)?;
    if had {
        integrations::github_token_changed(&app);
    }
    if key == "gitea-token" || key == "gitea-url" {
        integrations::gitea_credentials_changed(&app);
    }
    Ok(())
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// The GitHub card was opened: refetch its `section` ("pulse" or "activity")
/// if it is stale. The pollers still decline while the pill is off or paused.
#[tauri::command]
fn github_refresh(section: String) {
    integrations::github_refresh_if_stale(&section);
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Global shortcuts ──────────────────────────────────────────────────────────

/// How each global shortcut went: registered, taken by another app, and so on.
#[tauri::command]
fn shortcuts_status(app: AppHandle) -> shortcuts::Report {
    shortcuts::status(&app)
}

/// Settings is recording a new combination: let go of ours meanwhile, so the
/// keys reach the recorder instead of running an action. `false` takes them back.
#[tauri::command]
fn shortcuts_suspend(app: AppHandle, shared: State<Shared>, suspended: bool) {
    if suspended {
        shortcuts::suspend(&app);
    } else {
        let stored = shared.settings.lock().unwrap().shortcuts.clone();
        shortcuts::apply(&app, &stored);
    }
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
pub(crate) const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The Liv window (every setting of the island), labelled "settings" since
/// it grew out of the settings window.
pub const HUB_LABEL: &str = "settings";

/// The Liv window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, HUB_LABEL, url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Liv")
        .inner_size(1100.0, 720.0)
        .min_inner_size(820.0, 560.0)
        .resizable(true)
        .visible(false)
        // Hidden, it must not be the window in front: show_hub focuses it
        // when it shows it.
        .focused(false)
        .center()
        .build()
    {
        Ok(win) => {
            #[cfg(windows)]
            webview_guard::install(&win);
            let this = win.clone();
            win.on_window_event(move |event| match event {
                // Closing it must only hide it, or it could never be reopened.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = this.hide();
                    set_hub_shown(&this, false);
                    webview_memory::set_low(&this, true);
                }
                // Minimised (a 0×0 resize on Windows) or back from it.
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(true) => {
                    let on = this.is_visible().unwrap_or(false) && !this.is_minimized().unwrap_or(false);
                    set_hub_shown(&this, on);
                }
                _ => {}
            });
            webview_memory::set_low(&win, true); // created hidden
        }
        Err(err) => log::line(format!("Liv window failed: {err}")),
    }
}

/// Whether the Liv window is on screen (shown and not minimised). Its page
/// animates its canvases only then (hub/hero.ts): WebKitGTK can keep
/// `document.visibilityState` at "visible" for a hidden window, and its
/// animation loop then kept a core busy with the window closed.
static HUB_SHOWN: AtomicBool = AtomicBool::new(false);

fn set_hub_shown(win: &tauri::WebviewWindow, shown: bool) {
    if HUB_SHOWN.swap(shown, Ordering::Relaxed) != shown {
        let _ = win.emit_to(HUB_LABEL, "hub-visible", shown);
    }
}

/// The page asks once at load, in case it missed the event.
#[tauri::command]
fn hub_shown() -> bool {
    HUB_SHOWN.load(Ordering::Relaxed)
}

pub fn show_settings_window(app: &AppHandle) {
    show_hub(app, Some("general"));
}

/// Shows the Liv window, on `page` when given ("general", "shortcuts"…).
pub fn show_hub(app: &AppHandle, page: Option<&str>) {
    let Some(win) = app.get_webview_window(HUB_LABEL) else {
        // Creating it at startup can fail on some machines (WebView2
        // 0x80070578): try again now, on the main thread, where
        // window creation can't deadlock a command.
        log::line("Liv window missing, creating it again");
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            create_settings_window(&handle);
            if let Some(win) = handle.get_webview_window(HUB_LABEL) {
                webview_memory::set_low(&win, false);
                let _ = win.show();
                let _ = win.set_focus();
                set_hub_shown(&win, true);
            }
        });
        return;
    };
    if let Some(page) = page {
        let _ = win.emit("hub-page", page.to_string());
    }
    webview_memory::set_low(&win, false);
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    set_hub_shown(&win, true);
}

/// Liv's windows only ever show Liv's own pages: the ones bundled with the app
/// or, in a dev build, the ones Vite serves — and the empty page a webview
/// starts from. Anything else is a webview being taken somewhere (a link
/// dropped on it), and the island's page holds the tasks and the cards agents
/// are waiting on.
fn is_own_page(url: &tauri::Url, dev_server: Option<&tauri::Url>) -> bool {
    let bundled = match (url.scheme(), url.host_str()) {
        ("http" | "https", Some("tauri.localhost")) => url.port().is_none(),
        ("tauri", Some("localhost")) => true,
        _ => false,
    };
    let served = dev_server.is_some_and(|dev| {
        dev.scheme() == url.scheme()
            && dev.host_str() == url.host_str()
            && dev.port_or_known_default() == url.port_or_known_default()
    });
    bundled || served || url.as_str() == "about:blank"
}

/// Refuses every navigation of a window away from Liv's own pages.
fn navigation_guard() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let dev_server = if cfg!(dev) { webview.config().build.dev_url.as_ref() } else { None };
            let own = is_own_page(url, dev_server);
            if !own {
                log::line(format!("{}: navigation away from Liv refused", webview.label()));
            }
            own
        })
        .build()
}

/// The argument the login item starts Liv with.
const AUTOSTART_ARG: &str = "--autostart";

/// Liv started with the computer, not opened by the user: the window stays hidden.
pub fn launched_at_login() -> bool {
    std::env::args().any(|a| a == AUTOSTART_ARG)
}

/// Whether the Liv window shows as Liv starts: only when the user opened Liv
/// (never at login), and unless Settings → General says not to. Opening Liv
/// again while it runs always shows it (the single-instance handler in `run`).
fn shows_window_at_launch(at_login: bool, settings: &Settings) -> bool {
    !at_login && settings.open_window_at_launch
}

/// The island's "Settings…" links. `page` is a page of the window, or a page
/// and one of its sections ("chat#chat.claude"): handed to the window as it
/// comes, which reads it (src/core/settings-target.ts) and ignores what it
/// does not know.
#[tauri::command]
fn open_settings_window(app: AppHandle, page: Option<String>) {
    show_hub(&app, Some(page.as_deref().unwrap_or("general")));
}

pub fn run() {
    platform::prepare_environment();
    let loaded = settings::load();
    i18n::set_picked(&loaded.language);
    // The uninstaller, once the user said yes: Liv's hooks leave the agents'
    // config files, and that is all this run does (unhook.rs).
    if unhook::asked(std::env::args()) {
        std::process::exit(unhook::run());
    }
    let gate = Arc::new(PollGate::new());
    // The window's panel for the open island as Settings shapes it, before
    // the window is first sized (apply_geometry, in setup).
    gate.set_panel(appearance::panel_of(&loaded));

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // `liv --shortcut <action>`: what a desktop's own keyboard
            // settings run where we can't listen for keys ourselves (Wayland).
            match shortcuts::from_args(&argv) {
                Some(action) => shortcuts::dispatch(app, action),
                // Opening Liv again (its shortcut, the Start menu) shows its window.
                None => show_hub(app, None),
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_ARG])))
        .plugin(navigation_guard());
    // Where no global shortcut can work, the plugin isn't even started.
    if platform::global_shortcuts_blocked().is_none() {
        builder = builder.plugin(shortcuts::plugin());
    }

    builder
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(Chat::default())
        .manage(shortcuts::Registry::default())
        .manage(recap::load())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            preview_appearance,
            set_system_languages,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            fit_zoom,
            hub_shown,
            list_monitors,
            open_url,
            open_gitlab_url,
            open_gitea,
            open_gitea_url,
            open_in_vscode,
            open_session,
            launch::launch_session,
            launch::pick_folder,
            launch::drop_into_session,
            open_claude_desktop,
            open_file_in_vscode,
            hooks_status,
            agent_hooks_status,
            hooks_preview,
            hooks_apply,
            agent_hooks_list,
            agent_hooks_preview,
            agent_hooks_apply,
            status_line_preview,
            status_line_apply,
            codex_plan_usage,
            approval_decision,
            approval_answer,
            approval_ack,
            approval_decline,
            agy_approvals::agy_approvals_status,
            agy_approvals::agy_approvals_set_enabled,
            log_line,
            chat_send,
            chat_models,
            claude_api_models,
            local_connect,
            local_set_key,
            chat_reset,
            ingest_file,
            secret_present,
            claude_ready,
            subscription_status,
            subscription_set,
            secret_set,
            secret_clear,
            refresh_integration,
            github_refresh,
            open_n8n,
            open_settings_window,
            set_paused,
            shortcuts_status,
            shortcuts_suspend,
            recap::recap_history,
            recap::recap_prefs,
            recap::recap_set_enabled,
            recap::recap_set_hide_projects,
            recap::recap_mark_shown,
            recap::recap_clear,
            recap::recap_save_png,
            recap::recap_reveal_saved,
            pet::pet_shown,
            pet::pet_shape,
            pet::pet_fit_zoom,
            pet::pet_asleep,
            pet::pet_route,
            pet::pet_travel,
            pet::pet_appear,
            pet::pet_pick_up,
            pet::pet_grab,
            pet::pet_settle,
            pet::pet_hide,
            pet::pet_ask,
            sounds::custom_sounds,
            sounds::custom_sound,
            sounds::reveal_sounds_folder,
            sounds::reload_sounds,
            spotify::spotify_refresh,
            spotify::spotify_control,
            spotify::spotify_open,
            downloads::download_open,
            downloads::download_reveal,
            downloads::download_shelve,
            clipboard::clipboard_history,
            clipboard::clipboard_paste,
            clipboard::clipboard_remove,
            clipboard::clipboard_clear,
            shelf::shelf_list,
            shelf::shelf_add,
            shelf::shelf_remove,
            shelf::shelf_clear,
            shelf::shelf_open,
            shelf::shelf_reveal,
            shelf::shelf_copy,
            shelf::shelf_drag,
            capture::capture_screen,
            capture::capture_area,
            capture::open_captures_folder,
            update::update_status,
            update::update_set_consent,
            update::update_check,
            update::update_shown,
            update::update_show,
            update::update_later,
            tray::tray_update_hint,
            update::update_dismiss,
            update::update_install,
            update::update_open_page,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            // First of all, while the island's page has not started loading
            // (see webview_guard.rs).
            #[cfg(windows)]
            if let Some(win) = island::window(&handle) {
                webview_guard::install(&win);
            }
            secrets::warm_up();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);
            // The same goes for Liv's desktop window, which waits off-screen.
            pet::setup(&handle);

            // The island starts as the full panel: apply_geometry reads it here.
            gate.collapsed.store(false, Ordering::Relaxed);
            if let Some(win) = island::window(&handle) {
                // Where Tauri takes the drop itself (Linux), its paths are the
                // ones ingest_file may copy (files.rs).
                win.on_window_event(|event| {
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                        files::allow_dropped(paths.iter().map(|p| p.to_string_lossy().to_string()));
                    }
                });
                platform::make_non_activating(&win);
                #[cfg(windows)]
                webview_drop::install(&handle);
                island::apply_geometry(&handle);
                pet::apply_scale(&handle);
                let _ = win.show();
            }
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Liv {} started ---", env!("CARGO_PKG_VERSION")));
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            spotify::sync(&handle, &loaded.active_integrations);
            clipboard::sync(&handle, loaded.clipboard_history);
            downloads::sync(&handle, loaded.download_alerts);
            // The shelf as it was left, minus what has gone since.
            shelf::start(&handle);
            shortcuts::apply(&handle, &loaded.shortcuts);
            // New versions: nothing goes to GitHub until the user agrees (update.rs).
            update::start(handle.clone());
            if loaded.autostart {
                // A login item without --autostart would show the window at login:
                // writing it again adds it, so the window stays hidden at login.
                let _ = handle.autolaunch().enable();
            }
            if shows_window_at_launch(launched_at_login(), &loaded) {
                show_hub(&handle, None);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Liv")
        .run(|_app, _event| {});
}

#[cfg(test)]
mod tests {
    use super::{diff_file, is_forge_instance_url, is_own_page, island, island_only, shows_window_at_launch, HUB_LABEL};
    use crate::settings::Settings;

    #[test]
    fn the_window_shows_at_a_launch_by_hand_unless_settings_say_not_to() {
        let wanted = Settings::default();
        let unwanted = Settings { open_window_at_launch: false, ..Settings::default() };
        assert!(shows_window_at_launch(false, &wanted));
        assert!(!shows_window_at_launch(false, &unwanted));
        // Started with the computer: never, whatever the setting.
        assert!(!shows_window_at_launch(true, &wanted));
        assert!(!shows_window_at_launch(true, &unwanted));
    }

    #[test]
    fn a_window_only_ever_shows_livs_own_pages() {
        let url = |s: &str| tauri::Url::parse(s).unwrap();
        let dev = url("http://localhost:1420");
        // The installed app, on Windows and elsewhere.
        for own in ["http://tauri.localhost/", "http://tauri.localhost/settings.html", "https://tauri.localhost/index.html", "tauri://localhost/settings.html", "about:blank"] {
            assert!(is_own_page(&url(own), None), "{own}");
        }
        // A dev build is served by Vite, and reloads there.
        assert!(is_own_page(&url("http://localhost:1420/settings.html"), Some(&dev)));
        assert!(is_own_page(&url("http://localhost:1420/dev/island-preview.html"), Some(&dev)));
        // The installed app is not: whatever listens on that port is not Liv.
        assert!(!is_own_page(&url("http://localhost:1420/"), None));
        // A link or a file dropped on a window, and anything else.
        for other in [
            "https://example.com/",
            "http://tauri.localhost.example.com/",
            "http://tauri.localhost:8080/",
            "http://localhost:3000/",
            "https://localhost:1420/",
            "file:///C:/Users/me/page.html",
            "javascript:alert(1)",
            "data:text/html,<p>x</p>",
            "ms-settings:privacy",
        ] {
            assert!(!is_own_page(&url(other), Some(&dev)), "{other}");
        }
    }

    #[test]
    fn only_the_island_window_answers_a_permission_request() {
        assert!(island_only(island::WINDOW_LABEL).is_ok());
        // The Liv window, Liv on the desktop, and any label that is not exactly the island's.
        for other in [HUB_LABEL, "pet", "", "Island", "island ", "island2"] {
            assert!(island_only(other).is_err(), "{other:?}");
        }
    }

    #[test]
    fn forge_links_stay_on_the_configured_instance() {
        let instance = reqwest::Url::parse("https://git.example.com/team/").unwrap();
        assert!(is_forge_instance_url(
            &reqwest::Url::parse("https://git.example.com/team/me/project").unwrap(),
            &instance,
        ));
        assert!(!is_forge_instance_url(
            &reqwest::Url::parse("https://git.example.com/other/project").unwrap(),
            &instance,
        ));
        assert!(!is_forge_instance_url(
            &reqwest::Url::parse("https://evil.example/team/me/project").unwrap(),
            &instance,
        ));
    }

    #[test]
    fn only_an_existing_file_by_its_full_path_reaches_the_editor() {
        let dir = std::env::temp_dir().join(format!("liv-diff-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("edited.ts");
        std::fs::write(&file, "x").unwrap();

        assert!(diff_file(&file.to_string_lossy()).is_some());
        // A folder, a missing file, a relative path or an option never pass.
        assert!(diff_file(&dir.to_string_lossy()).is_none());
        assert!(diff_file(&dir.join("missing.ts").to_string_lossy()).is_none());
        assert!(diff_file("edited.ts").is_none());
        assert!(diff_file("--help").is_none());
        assert!(diff_file("").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
