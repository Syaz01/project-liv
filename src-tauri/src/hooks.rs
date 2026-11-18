// Claude Code hook installation.
//
// The rule from CLAUDE.md is strict and is followed to the letter:
// read %USERPROFILE%\.claude\settings.json, take a dated backup, merge without
// touching anybody else's hooks, show the diff, and write only after an explicit
// click. Uninstall removes Liv's entries and nothing else.
//
// Each hook is written in Claude Code's exec form: `command` is the relay's path
// alone and `args` the event name, so Claude Code starts the relay itself with
// no shell. (The shell form Liv wrote before, `"<path>" <Event>`, only ran in
// Git Bash: without it Claude Code hands the string to PowerShell, which refuses
// it, and a PreToolUse hook that fails there blocks the tool call.) Entries in
// either form are recognised as Liv's, so installing again replaces an old one
// and uninstalling removes both.
//
// Reading, the diff, the backup and the write itself live in config_file.rs,
// shared with every other agent's installer (agents.rs).

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use crate::agents::Relay;
use crate::config_file::{self, FileEdit};
use crate::{platform, settings};

/// Every event the island reacts to, with the hook timeout written to settings.json.
/// PermissionRequest waits for a human, so it gets the decision timeout + 10 s.
/// SessionEnd gets 1 s: Claude Code gives all SessionEnd hooks 1.5 s between them
/// and raises that to the longest timeout written in the settings, so anything
/// longer here would make every other SessionEnd hook of the user's wait longer.
pub const HOOK_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 1),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PostToolUseFailure", 10),
    ("PermissionRequest", 120),
    ("Notification", 10),
    ("Stop", 10),
    ("StopFailure", 10),
    ("SubagentStart", 10),
    ("SubagentStop", 10),
];

/// Marker that identifies a Liv entry inside settings.json: the relay's file
/// name. Another island's relay in the same file (`coucou-hook`) never matches.
pub(crate) const MARKER: &str = "liv-hook";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub installed: bool,
    /// Liv's status line relay (plan usage) is the one in settings.json.
    pub plan_relay_installed: bool,
    pub settings_path: String,
    pub hook_path: String,
    pub hook_ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookPreview {
    pub diff: String,
    pub backup: String,
    pub settings_path: String,
    /// Identifies the bytes this diff was computed from; handed back to `write`
    /// so we only ever apply what the user actually looked at.
    pub fingerprint: String,
}

pub fn settings_path() -> PathBuf {
    claude_dir(std::env::var_os("CLAUDE_CONFIG_DIR"), &platform::home_dir()).join("settings.json")
}

/// Claude Code's own folder: `CLAUDE_CONFIG_DIR` when the user moved it there,
/// as Claude Code itself reads it, otherwise `~/.claude`. Hooks written
/// anywhere else are never run.
fn claude_dir(config_dir: Option<std::ffi::OsString>, home: &std::path::Path) -> PathBuf {
    match config_dir {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home.join(".claude"),
    }
}

/// The settings as they are, or an empty object when we cannot tell. Only for
/// read-only paths like `status()`, which must never fail loudly; anything that
/// writes goes through `config_file`, which surfaces the error instead.
fn read_settings_lossy() -> Value {
    config_file::read(&settings_path())
        .ok()
        .and_then(|bytes| config_file::parse_json(bytes.as_deref(), "settings.json").ok())
        .unwrap_or_else(|| json!({}))
}

/// One hook of Liv's, in the exec form: the relay started directly with the
/// event's name as its only argument.
fn handler(relay: &Relay, event: &str, timeout: u64) -> Value {
    json!({
        "type": "command",
        "command": relay.program(),
        "args": [event],
        "timeout": timeout,
    })
}

/// True for a hook that runs Liv's relay, in the exec form (`command` is its
/// path) or the shell form Liv wrote before (`command` starts with it, quoted).
fn handler_is_ours(handler: &Value) -> bool {
    handler.get("command").and_then(Value::as_str).is_some_and(|c| c.contains(MARKER))
}

/// True for a group holding a hook of Liv's.
fn entry_is_ours(entry: &Value) -> bool {
    entry.get("hooks").and_then(Value::as_array).is_some_and(|hooks| hooks.iter().any(handler_is_ours))
}

/// `entry` (one group of an event: a matcher and its hooks) without Liv's hooks.
/// A group that also holds hooks of the user's keeps them, and its matcher;
/// `None` when nothing but Liv's was in it.
fn without_our_handlers(entry: &Value) -> Option<Value> {
    if !entry_is_ours(entry) {
        return Some(entry.clone());
    }
    let mut group = entry.clone();
    let hooks = group.get_mut("hooks").and_then(Value::as_array_mut)?;
    hooks.retain(|h| !handler_is_ours(h));
    (!hooks.is_empty()).then_some(group)
}

/// The status line in settings.json is Liv's relay (`liv-hook --statusline`).
fn status_line_is_ours(v: &Value) -> bool {
    v.get("command").and_then(Value::as_str).is_some_and(|c| c.contains(MARKER))
}

/// Settings with Liv's hooks added; everything else is left untouched. A
/// `hooks` (or one of its events) that is not what Claude Code documents is
/// refused rather than replaced.
fn merged(existing: &Value, relay: &Relay) -> Result<Value, String> {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = match root.get("hooks") {
        None => Map::new(),
        Some(Value::Object(h)) => h.clone(),
        Some(_) => return Err(unexpected("\"hooks\"")),
    };

    for (event, timeout) in HOOK_EVENTS {
        let list = match hooks.get(*event) {
            None => Vec::new(),
            Some(Value::Array(list)) => list.clone(),
            Some(_) => return Err(unexpected(&format!("\"hooks\".\"{event}\""))),
        };
        let mut list: Vec<Value> = list.iter().filter_map(without_our_handlers).collect();
        list.push(json!({ "hooks": [handler(relay, event, *timeout)] }));
        hooks.insert((*event).to_string(), Value::Array(list));
    }

    root.insert("hooks".into(), Value::Object(hooks));
    Ok(Value::Object(root))
}

fn unexpected(what: &str) -> String {
    crate::i18n::tf("settings.json: {what} has an unexpected type — Liv has not touched it.", &[("what", what)])
}

/// Settings with every Liv entry removed, and nothing else changed.
fn without_ours(existing: &Value) -> Result<Value, String> {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let hooks = match root.get("hooks") {
        None => return Ok(Value::Object(root)),
        Some(Value::Object(h)) => h.clone(),
        Some(_) => return Err(unexpected("\"hooks\"")),
    };
    let mut out = Map::new();
    for (event, value) in hooks {
        match value.as_array() {
            Some(list) => {
                let kept: Vec<Value> = list.iter().filter_map(without_our_handlers).collect();
                if !kept.is_empty() {
                    out.insert(event, Value::Array(kept));
                }
            }
            None => {
                out.insert(event, value);
            }
        }
    }
    if out.is_empty() {
        root.remove("hooks");
    } else {
        root.insert("hooks".into(), Value::Object(out));
    }
    Ok(Value::Object(root))
}

fn edits(install: bool) -> Vec<FileEdit<'static>> {
    edits_at(settings_path(), Relay::current(), install)
}

/// The install (or removal) as an edit of the settings file at `path`.
fn edits_at(path: PathBuf, relay: Relay, install: bool) -> Vec<FileEdit<'static>> {
    vec![FileEdit {
        path,
        edit: config_file::json_edit("settings.json".into(), move |current| {
            if install { merged(current, &relay).map(Some) } else { without_ours(current).map(Some) }
        }),
    }]
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn status() -> HookStatus {
    let current = read_settings_lossy();
    let installed = current
        .get("hooks")
        .and_then(Value::as_object)
        .map(|hooks| {
            hooks
                .values()
                .filter_map(Value::as_array)
                .flatten()
                .any(entry_is_ours)
        })
        .unwrap_or(false);
    let hook_path = settings::hook_exe_path();
    HookStatus {
        installed,
        plan_relay_installed: plan_relay_installed(&current),
        settings_path: settings_path().to_string_lossy().to_string(),
        hook_ready: hook_path.exists(),
        hook_path: hook_path.to_string_lossy().to_string(),
    }
}

pub fn preview(install: bool) -> Result<HookPreview, String> {
    Ok(plan_to_preview(config_file::preview(&edits(install))?))
}

fn plan_to_preview(plan: config_file::Plan) -> HookPreview {
    HookPreview {
        diff: plan.diff,
        backup: plan.backup,
        settings_path: plan.path,
        fingerprint: plan.fingerprint,
    }
}

/// Writes the merged (or cleaned) settings after taking a dated backup, and
/// returns where the backup went ("" when there was no file to back up).
///
/// `fingerprint` is the one the preview was computed from: a settings.json that
/// changed in between is refused rather than overwritten (see config_file).
pub fn write(install: bool, fingerprint: &str) -> Result<String, String> {
    let backups = config_file::apply(&edits(install), fingerprint)?;
    Ok(backups.first().map(|p| p.to_string_lossy().to_string()).unwrap_or_default())
}

// ── Status line (plan usage) ──────────────────────────────────────────────────
//
// Claude Code runs one `statusLine` command and hands it the plan limits. Liv
// puts its relay there; a status line the user already had is kept in
// statusline-previous.json in local_dir() (outside bin/, surviving uninstaller),
// and the relay still runs it, so it keeps working. Installing and removing it
// is separate from the hooks, and goes through the same hardened writer
// (config_file.rs): strict read, diff, fingerprint, dated backup, then the write.

/// Where the user's own status line waits while the relay stands in for it.
pub fn status_line_previous_path() -> PathBuf {
    settings::local_dir().join("statusline-previous.json")
}

fn read_status_line_previous() -> Option<Value> {
    let bytes = std::fs::read(status_line_previous_path()).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok().filter(Value::is_object)
}

/// True when the `statusLine` in settings.json is Liv's relay.
pub fn plan_relay_installed(settings: &Value) -> bool {
    settings.get("statusLine").is_some_and(status_line_is_ours)
}

/// `statusLine` as it reads after installing or removing the relay. `None`: the
/// key goes. Installing swaps only `command`, so `padding`, `refreshInterval`
/// and the rest of the user's status line stay as they were.
fn status_line_after(existing: Option<&Value>, install: bool, previous: Option<&Value>, relay: &Relay) -> Option<Value> {
    if install {
        let mut sl = existing.filter(|v| v.is_object()).cloned().unwrap_or_else(|| json!({}));
        let obj = sl.as_object_mut().expect("an object");
        obj.entry("type").or_insert_with(|| json!("command"));
        obj.insert("command".into(), json!(relay.status_line_command()));
        Some(sl)
    } else if existing.is_some_and(status_line_is_ours) {
        previous.cloned()
    } else {
        existing.cloned() // not ours any more (the user changed it): leave it alone
    }
}

fn status_line_settings(current: &Value, install: bool, previous: Option<&Value>, relay: &Relay) -> Result<Value, String> {
    let mut root = current.as_object().cloned().unwrap_or_default();
    // A statusLine that is not an object is something we do not understand:
    // refuse rather than replace it.
    if install && root.get("statusLine").is_some_and(|v| !v.is_object()) {
        return Err(unexpected("\"statusLine\""));
    }
    match status_line_after(root.get("statusLine"), install, previous, relay) {
        Some(sl) => root.insert("statusLine".into(), sl),
        None => root.remove("statusLine"),
    };
    Ok(Value::Object(root))
}

fn status_line_edits(install: bool, previous: Option<Value>) -> Vec<FileEdit<'static>> {
    vec![FileEdit {
        path: settings_path(),
        edit: config_file::json_edit("settings.json".into(), move |current| {
            Ok(Some(status_line_settings(current, install, previous.as_ref(), &Relay::current())?))
        }),
    }]
}

/// The diff the user has to look at before the relay goes in or out.
pub fn status_line_preview(install: bool) -> Result<HookPreview, String> {
    Ok(plan_to_preview(config_file::preview(&status_line_edits(install, read_status_line_previous()))?))
}

/// Installs or removes the relay, after the same backup and fingerprint checks as
/// the hooks. Installing first saves a status line of the user's own, removing
/// puts it back (or removes the key if there was none).
pub fn status_line_write(install: bool, fingerprint: &str) -> Result<String, String> {
    let before = config_file::read(&settings_path())
        .and_then(|bytes| config_file::parse_json(bytes.as_deref(), "settings.json"))?;
    let previous = read_status_line_previous();
    let own = before.get("statusLine").filter(|v| !status_line_is_ours(v)).cloned();
    let saved = match (install, own.as_ref()) {
        (true, Some(own)) => {
            save_status_line_previous(own).map_err(|_| {
                crate::i18n::t("Could not save your current status line next to the relay; nothing was changed.")
            })?;
            true
        }
        _ => false,
    };
    let result = config_file::apply(&status_line_edits(install, previous), fingerprint);
    match &result {
        // Back in settings.json: the saved copy has done its job.
        Ok(_) if !install => {
            let _ = std::fs::remove_file(status_line_previous_path());
        }
        // Nothing was written: do not leave a stale copy behind.
        Err(_) if saved => {
            let _ = std::fs::remove_file(status_line_previous_path());
        }
        _ => {}
    }
    let backups = result?;
    Ok(backups.first().map(|p| p.to_string_lossy().to_string()).unwrap_or_default())
}

fn save_status_line_previous(status_line: &Value) -> std::io::Result<()> {
    let path = status_line_previous_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    config_file::write_like(&path, &path, config_file::pretty(status_line).as_bytes())
}

/// Copies the relay (liv-hook.exe / liv-hook) into the local data dir's
/// bin/ on launch. In a bundled install it comes from the app resources; in
/// `tauri dev` it sits next to the app binary in the workspace target directory.
///
/// Every candidate is tried rather than just the first, because getting this
/// wrong is silent and fatal: with no relay, no hook reaches the island.
pub fn ensure_hook_exe(app: &AppHandle) {
    let dest = settings::hook_exe_path();
    let Some(dir) = dest.parent() else { return };
    // Nobody else may swap the relay Claude Code runs: its folder is ours only.
    if platform::ensure_private_dir(&settings::local_dir()).is_err()
        || std::fs::create_dir_all(dir).is_err()
    {
        return;
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve(platform::HOOK_EXE, tauri::path::BaseDirectory::Resource) {
        candidates.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Installed build, then `tauri dev` (target/debug) next to the
            // release hook the pre-build step produces.
            candidates.push(parent.join(platform::HOOK_EXE));
            candidates.push(parent.join("../release").join(platform::HOOK_EXE));
        }
    }

    let tried: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
    let Some(src) = candidates.into_iter().find(|p| p.exists()) else {
        crate::log::line(format!(
            "{} not found — Claude Code hooks cannot work. Looked in: {}",
            platform::HOOK_EXE,
            tried.join(", ")
        ));
        return;
    };
    install_relay(&src, &dest);
}

#[cfg(windows)]
fn install_relay(src: &Path, dest: &Path) {
    let same = match (std::fs::metadata(src), std::fs::metadata(dest)) {
        (Ok(a), Ok(b)) => a.len() == b.len() && a.modified().ok() == b.modified().ok(),
        _ => false,
    };
    if same {
        return;
    }
    // A hook may be running right now and hold the file open; keeping the old
    // copy is fine, it is the same relay.
    if let Err(err) = std::fs::copy(src, dest) {
        if !dest.exists() {
            crate::log::line(format!("could not install {}: {err}", platform::HOOK_EXE));
        }
    }
}

/// Linux does not keep the modification time on copy, so the contents decide.
/// The new relay is written beside the old one and renamed over it: a hook
/// starting at that moment runs either the old relay or the new one, never half
/// of one, and a relay that is running right now does not block the update.
#[cfg(unix)]
fn install_relay(src: &Path, dest: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if matches!((std::fs::read(src), std::fs::read(dest)), (Ok(a), Ok(b)) if a == b) {
        return;
    }
    let temp = dest.with_extension(format!("new-{}", std::process::id()));
    let result = std::fs::copy(src, &temp)
        .and_then(|_| std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755)))
        .and_then(|_| std::fs::rename(&temp, dest));
    if let Err(err) = result {
        let _ = std::fs::remove_file(&temp);
        crate::log::line(format!("could not install {}: {err}", platform::HOOK_EXE));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The relay where Liv installs it on Windows, for a user called `user`.
    fn relay_of(user: &str) -> Relay {
        Relay { exe: format!(r"C:\Users\{user}\AppData\Local\Liv\bin\liv-hook.exe"), windows: true }
    }

    fn relay() -> Relay {
        relay_of("david")
    }

    fn merged(existing: &Value) -> Result<Value, String> {
        super::merged(existing, &relay())
    }

    fn status_line_settings(current: &Value, install: bool, previous: Option<&Value>) -> Result<Value, String> {
        super::status_line_settings(current, install, previous, &relay())
    }

    /// The hook Liv wrote before the exec form: one string for Git Bash.
    fn old_form(event: &str) -> Value {
        json!({ "hooks": [{
            "type": "command",
            "command": format!("\"C:/Users/david/AppData/Local/Liv/bin/liv-hook.exe\" {event}"),
            "timeout": 10,
        }] })
    }

    #[test]
    fn each_hook_is_written_in_the_exec_form_with_no_shell_to_parse_it() {
        let after = merged(&json!({})).unwrap();
        assert_eq!(
            after["hooks"]["PreToolUse"],
            json!([{ "hooks": [{
                "type": "command",
                "command": "C:/Users/david/AppData/Local/Liv/bin/liv-hook.exe",
                "args": ["PreToolUse"],
                "timeout": 10,
            }] }])
        );
        // One group per event, each with the event's own name as the only argument.
        for (event, timeout) in HOOK_EVENTS {
            let groups = after["hooks"][*event].as_array().unwrap();
            assert_eq!(groups.len(), 1, "{event}");
            let hook = &groups[0]["hooks"][0];
            assert_eq!(hook["args"], json!([event]), "{event}");
            assert_eq!(hook["timeout"], json!(timeout), "{event}");
            // Nothing a shell would have to read: no quote, no backslash, no space.
            let command = hook["command"].as_str().unwrap();
            assert!(!command.contains(['"', '\'', '\\', ' ']), "{command}");
        }
        // A path with a space is still one program, as it is: there is no shell to split it.
        let spaced = super::merged(&json!({}), &relay_of("Jane O'Neil")).unwrap();
        assert_eq!(
            spaced["hooks"]["Stop"][0]["hooks"][0]["command"],
            "C:/Users/Jane O'Neil/AppData/Local/Liv/bin/liv-hook.exe"
        );
        // Linux: the path as it is.
        let linux = Relay { exe: "/home/me/.local/share/liv/bin/liv-hook".into(), windows: false };
        let hook = &super::merged(&json!({}), &linux).unwrap()["hooks"]["Stop"][0]["hooks"][0];
        assert_eq!(hook["command"], "/home/me/.local/share/liv/bin/liv-hook");
        assert_eq!(hook["args"], json!(["Stop"]));
    }

    #[test]
    fn the_session_end_hook_never_raises_the_users_session_end_budget() {
        // Claude Code: "SessionEnd hooks share a 1.5-second budget; if your settings
        // set a longer per-hook timeout, Claude Code raises the budget to match".
        let timeout = HOOK_EVENTS.iter().find(|(event, _)| *event == "SessionEnd").unwrap().1;
        assert_eq!(timeout, 1);
    }

    #[test]
    fn an_entry_in_the_old_shell_form_is_ours_too_and_installing_again_replaces_it() {
        let old = json!({ "hooks": {
            "PreToolUse": [old_form("PreToolUse")],
            "Stop": [old_form("Stop")],
        } });
        assert!(entry_is_ours(&old["hooks"]["PreToolUse"][0]));
        let fresh = merged(&json!({})).unwrap();
        assert!(entry_is_ours(&fresh["hooks"]["PreToolUse"][0]));

        // Installing over the old form leaves what a fresh install writes: one
        // hook of ours per event, in the exec form.
        let migrated = merged(&old).unwrap();
        for (event, _) in HOOK_EVENTS {
            assert_eq!(migrated["hooks"][*event], fresh["hooks"][*event], "{event}");
        }
        // Uninstalling removes either form, and the emptied `hooks` with it.
        assert_eq!(without_ours(&old).unwrap(), json!({}));
        assert_eq!(without_ours(&fresh).unwrap(), json!({}));
        assert_eq!(without_ours(&migrated).unwrap(), json!({}));
    }

    #[test]
    fn a_group_shared_with_the_users_own_hook_only_loses_ours() {
        let theirs = json!({ "type": "command", "command": "node", "args": ["C:/tools/audit.js"] });
        let ours_old = old_form("PreToolUse")["hooks"][0].clone();
        let ours_new = handler(&relay(), "PreToolUse", 10);
        for ours in [ours_old, ours_new] {
            let shared = json!({ "hooks": { "PreToolUse": [
                { "matcher": "Bash", "hooks": [theirs.clone(), ours.clone()] }
            ] } });
            let users_alone = json!({ "hooks": { "PreToolUse": [
                { "matcher": "Bash", "hooks": [theirs.clone()] }
            ] } });

            // Uninstall: the group stays, with its matcher and the user's hook.
            assert_eq!(without_ours(&shared).unwrap(), users_alone);

            // Install: ours leaves the shared group and goes in a group of its own.
            let after = merged(&shared).unwrap();
            let groups = after["hooks"]["PreToolUse"].as_array().unwrap();
            assert_eq!(groups.len(), 2);
            assert_eq!(groups[0], users_alone["hooks"]["PreToolUse"][0]);
            assert_eq!(groups[1], json!({ "hooks": [handler(&relay(), "PreToolUse", 10)] }));
            // And removing it again leaves the user's group as it was.
            assert_eq!(without_ours(&after).unwrap(), users_alone);
        }
    }

    #[test]
    fn the_status_line_command_runs_in_git_bash_and_in_powershell_when_the_path_allows() {
        // No exec form for the status line: one string that both shells run.
        assert_eq!(
            relay().status_line_command(),
            "C:/Users/david/AppData/Local/Liv/bin/liv-hook.exe --statusline"
        );
        // A path with a space can only be quoted for one of them: Git Bash, as before.
        assert_eq!(
            relay_of("Jane Roe").status_line_command(),
            "\"C:/Users/Jane Roe/AppData/Local/Liv/bin/liv-hook.exe\" --statusline"
        );
        let linux = Relay { exe: "/home/me/.local/share/liv/bin/liv-hook".into(), windows: false };
        assert_eq!(linux.status_line_command(), "'/home/me/.local/share/liv/bin/liv-hook' --statusline");
        // Either way it is recognised as ours.
        for relay in [relay(), relay_of("Jane Roe"), linux] {
            assert!(status_line_is_ours(&json!({ "type": "command", "command": relay.status_line_command() })));
        }
    }

    #[test]
    fn installing_then_uninstalling_gives_the_file_back_byte_for_byte() {
        let dir = config_file::tests::scratch("hooks-round-trip");
        let path = dir.join("settings.json");
        let settings = json!({
            "model": "claude-opus-5",
            "permissions": { "allow": ["Bash(npm test)"], "deny": [] },
            "hooks": { "PreToolUse": [
                { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node", "args": ["C:/tools/audit.js"] }] }
            ] },
            "statusLine": { "type": "command", "command": "~/bin/línea.sh", "padding": 2 }
        });
        let canonical = config_file::pretty(&settings);
        let run = |install: bool| {
            let plan = config_file::preview(&edits_at(path.clone(), relay(), install)).unwrap();
            config_file::apply(&edits_at(path.clone(), relay(), install), &plan.fingerprint).unwrap();
        };
        for bom in [false, true] {
            for eol in ["\n", "\r\n"] {
                for last in ["", eol] {
                    let mut original = if bom { vec![0xEF, 0xBB, 0xBF] } else { Vec::new() };
                    original.extend_from_slice(canonical.replace('\n', eol).as_bytes());
                    original.extend_from_slice(last.as_bytes());
                    std::fs::write(&path, &original).unwrap();

                    run(true);
                    let installed = std::fs::read(&path).unwrap();
                    assert_ne!(installed, original);
                    assert_eq!(installed.starts_with(&[0xEF, 0xBB, 0xBF]), bom, "the BOM stays as it was");
                    let text = String::from_utf8(installed).unwrap();
                    assert_eq!(text.matches('\n').count(), text.matches(eol).count(), "one kind of line ending: {eol:?}");
                    assert_eq!(text.contains('\r'), eol == "\r\n");
                    assert_eq!(text.ends_with('\n'), !last.is_empty(), "the final newline stays as it was");

                    run(false);
                    assert_eq!(std::fs::read(&path).unwrap(), original, "bom={bom} eol={eol:?} last={last:?}");
                }
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_hooks_leave_the_status_line_alone() {
        let theirs = json!({ "statusLine": { "type": "command", "command": "~/bin/my-line" } });
        assert_eq!(merged(&theirs).unwrap()["statusLine"], theirs["statusLine"]);
        assert_eq!(without_ours(&theirs).unwrap()["statusLine"], theirs["statusLine"]);
        assert!(merged(&json!({})).unwrap().get("statusLine").is_none());
    }

    #[test]
    fn the_relay_takes_the_status_line_and_keeps_the_users_other_fields() {
        // None yet: ours is added.
        let fresh = status_line_settings(&json!({ "model": "opus" }), true, None).unwrap();
        assert!(status_line_is_ours(&fresh["statusLine"]));
        assert_eq!(fresh["statusLine"]["type"], "command");
        assert_eq!(fresh["model"], "opus");

        // Their own: only the command is swapped; padding and refresh stay.
        let own = json!({ "statusLine": { "type": "command", "command": "~/bin/my-line", "padding": 2, "refreshInterval": 5 } });
        let taken = status_line_settings(&own, true, None).unwrap();
        assert!(status_line_is_ours(&taken["statusLine"]));
        assert_eq!(taken["statusLine"]["padding"], 2);
        assert_eq!(taken["statusLine"]["refreshInterval"], 5);

        // Installing again keeps ours and its extra fields.
        let again = status_line_settings(&taken, true, None).unwrap();
        assert_eq!(again["statusLine"]["padding"], 2);
        assert!(status_line_is_ours(&again["statusLine"]));
    }

    #[test]
    fn removing_the_relay_restores_what_was_there_and_never_touches_anything_else() {
        let previous = json!({ "type": "command", "command": "~/bin/my-line", "padding": 2 });
        let ours = status_line_settings(&json!({}), true, None).unwrap();

        // There was one before: it comes back exactly.
        assert_eq!(status_line_settings(&ours, false, Some(&previous)).unwrap()["statusLine"], previous);
        // There was none: the key goes.
        assert!(status_line_settings(&ours, false, None).unwrap().get("statusLine").is_none());
        // The user changed it since: not ours, so untouched.
        let theirs = json!({ "statusLine": { "type": "command", "command": "~/bin/other" } });
        assert_eq!(status_line_settings(&theirs, false, Some(&previous)).unwrap()["statusLine"], theirs["statusLine"]);
        // A statusLine we do not understand is refused, never replaced.
        assert!(status_line_settings(&json!({ "statusLine": "echo hi" }), true, None).is_err());
    }

    #[test]
    fn merging_keeps_every_other_setting_and_every_foreign_hook() {
        let existing = serde_json::json!({
            "model": "claude-opus-5",
            "theme": "dark",
            "enabledPlugins": ["a", "b"],
            "hooks": {
                "PreToolUse": [
                    { "hooks": [{ "type": "command", "command": "someone-elses-tool.exe" }] }
                ],
                "SomeEventWeDoNotTouch": [
                    { "hooks": [{ "type": "command", "command": "keep-me.exe" }] }
                ]
            }
        });

        let after = merged(&existing).unwrap();
        assert_eq!(after["model"], "claude-opus-5");
        assert_eq!(after["theme"], "dark");
        assert_eq!(after["enabledPlugins"], serde_json::json!(["a", "b"]));

        let pre = after["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(
            pre.iter().any(|e| serde_json::to_string(e).unwrap().contains("someone-elses-tool.exe")),
            "another tool's hook was dropped"
        );
        assert!(pre.iter().any(entry_is_ours), "our own hook was not added");
        assert!(after["hooks"]["SomeEventWeDoNotTouch"].is_array());

        // Installing twice still leaves one entry of ours per event. (Compared
        // by count: another test points HOME elsewhere meanwhile, which moves
        // the relay path.)
        let twice = merged(&after).unwrap();
        assert_eq!(twice["hooks"]["PreToolUse"].as_array().unwrap().iter().filter(|e| entry_is_ours(e)).count(), 1);

        // And removing ours puts it back exactly as it was.
        let cleaned = without_ours(&after).unwrap();
        assert_eq!(cleaned, existing);
    }

    #[test]
    fn another_islands_hooks_and_status_line_are_never_ours() {
        // Coucou on the same computer: its relay is `coucou-hook`, ours `liv-hook`.
        let relay = "\"C:/Users/me/AppData/Local/Coucou/bin/coucou-hook.exe\"";
        let theirs = json!({
            "statusLine": { "type": "command", "command": format!("{relay} --statusline") },
            "hooks": { "SessionStart": [
                { "hooks": [{ "type": "command", "command": format!("{relay} SessionStart") }] }
            ] }
        });
        assert!(!entry_is_ours(&theirs["hooks"]["SessionStart"][0]));
        assert!(!plan_relay_installed(&theirs));
        // Installing adds ours beside theirs; removing takes only ours out again.
        let both = merged(&theirs).unwrap();
        assert_eq!(both["hooks"]["SessionStart"].as_array().unwrap().len(), 2);
        assert_eq!(without_ours(&both).unwrap(), theirs);
        assert_eq!(without_ours(&theirs).unwrap(), theirs);
    }

    #[test]
    fn values_of_an_unexpected_type_are_refused_not_replaced() {
        for odd in [
            json!({ "hooks": "a string" }),
            json!({ "hooks": [1, 2] }),
            json!({ "hooks": { "PreToolUse": { "not": "a list" } } }),
        ] {
            assert!(merged(&odd).is_err(), "{odd}");
        }
        assert!(without_ours(&json!({ "hooks": 3 })).is_err());
        // An event we do not install stays as it is, whatever its shape.
        let kept = json!({ "hooks": { "Custom": "anything" } });
        assert_eq!(without_ours(&kept).unwrap(), kept);
    }

    #[test]
    fn a_moved_claude_folder_is_where_the_settings_are() {
        let home = std::path::Path::new("C:/Users/me");
        assert_eq!(claude_dir(None, home), home.join(".claude"));
        assert_eq!(claude_dir(Some("".into()), home), home.join(".claude"));
        assert_eq!(claude_dir(Some("E:/Claude/data".into()), home), PathBuf::from("E:/Claude/data"));
    }

    /// Everything filesystem-shaped lives in one test on purpose: it points
    /// the home directory at a temp directory, and that is process-wide.
    #[test]
    fn writing_backs_up_preserves_and_refuses_a_changed_file() {
        let tmp = std::env::temp_dir().join(format!("liv-hooks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".claude")).unwrap();
        std::env::set_var(platform::HOME_VAR, &tmp);
        // A moved Claude folder would point outside the temp directory.
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let path = settings_path();
        assert!(path.starts_with(&tmp), "the test must not touch the real home");

        // A real-shaped file, written the way PowerShell 5 would: UTF-8 with BOM.
        let original = r#"{"model":"claude-opus-5","theme":"dark","tui":{"x":1},"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"other-tool.exe"}]}]}}"#;
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(original.as_bytes());
        std::fs::write(&path, &bytes).unwrap();

        // Install.
        let plan = preview(true).expect("a BOM must not stop the preview");
        assert!(plan.diff.contains("liv-hook"), "the diff must show what changes");
        let backup = write(true, &plan.fingerprint).expect("install should succeed");

        // The backup holds the original bytes, BOM and all.
        assert_eq!(std::fs::read(&backup).unwrap(), bytes);

        // Everything else survived, the file's BOM included, and so did the other tool's hook.
        let written = std::fs::read(&path).unwrap();
        assert!(written.starts_with(&[0xEF, 0xBB, 0xBF]));
        let after = config_file::parse_json(Some(&written), "settings.json").unwrap();
        assert_eq!(after["model"], "claude-opus-5");
        assert_eq!(after["theme"], "dark");
        assert_eq!(after["tui"]["x"], 1);
        let pre = after["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(pre.iter().any(|e| serde_json::to_string(e).unwrap().contains("other-tool.exe")));
        assert!(status().installed);

        // A file that moved since the preview is refused, and left alone.
        let stale = preview(false).unwrap();
        std::fs::write(&path, br#"{"model":"someone-else-edited-this"}"#).unwrap();
        let err = write(false, &stale.fingerprint).unwrap_err();
        assert!(err.contains("changed since the preview"), "got: {err}");
        let untouched: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(untouched["model"], "someone-else-edited-this");

        // Content we cannot parse is refused before anything is written.
        std::fs::write(&path, b"{ broken").unwrap();
        assert!(preview(true).is_err());
        assert!(write(true, "whatever").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{ broken");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
