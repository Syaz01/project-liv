// A new Claude Code session from the island, and a file dropped on a session —
// ports of LaunchScript.swift, SessionLauncher.swift and SessionDrop.swift.
//
// Launch: the user's terminal opens in the project with `claude` and the
// prompt. The prompt is never spliced into a command line:
// - Linux: it travels in LIV_PROMPT, set on the terminal's process, and the
//   user's login shell runs `claude "$LIV_PROMPT"` (as the Mac's script).
// - Windows: Windows Terminal starts its tabs with a fresh environment, not
//   wt.exe's (microsoft/terminal#11094), so an environment variable set on
//   wt.exe never reaches the tab. The prompt goes into a file of ours in the
//   temp folder instead, as the one quoted word `claude` is started with
//   (cmd_word: `claude` may be a batch file, which cmd.exe runs); PowerShell
//   reads it into $env:LIV_PROMPT, deletes the file, and runs claude with
//   that variable. The folder and the file's path are the only things in the
//   command line, each written so that Windows Terminal and PowerShell take
//   it as text (ps_literal).
// The session then shows in the island like any other, through the hooks.
//
// Drop: the session's window comes forward (the same lookup as "Open
// terminal", session_window.rs) and the paths are pasted (paste/), escaped as
// a drag onto that terminal would write them.
//
// The command lines are built by the pure functions below, tested here; the
// spawning and the OS calls are the few lines after them.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crate::{herdr, paste, platform, session_window};

/// What to start: a program, its arguments, extra environment, its folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spawn {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub dir: String,
}

/// The prompt as it is handed over: trimmed, on one line.
pub fn clean_prompt(prompt: &str) -> String {
    prompt.split(['\r', '\n']).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
}

/// A folder a session may start in: an existing folder given by its full path.
pub fn valid_folder(folder: &str) -> bool {
    let p = Path::new(folder);
    !folder.is_empty() && p.is_absolute() && p.is_dir()
}

// ── Linux ─────────────────────────────────────────────────────────────────────

/// The shell's single quotes, only where needed: 'it'\''s' for it's.
#[cfg_attr(windows, allow(dead_code))]
pub fn sh_quote(s: &str) -> String {
    let plain = !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+=:@,".contains(c));
    if plain {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

/// What the terminal runs: the user's login shell (so `claude` is found as in
/// any terminal), Claude Code with the prompt from LIV_PROMPT, then the
/// shell again in the project once Claude Code quits.
#[cfg_attr(windows, allow(dead_code))]
pub fn shell_command(shell: &str, has_prompt: bool) -> Vec<String> {
    let run = if has_prompt { r#"claude "$LIV_PROMPT""# } else { "claude" };
    vec![shell.to_string(), "-lic".to_string(), format!("{run}; exec {} -l", sh_quote(shell))]
}

/// The terminals we know how to hand a command and a folder to, best first
/// after $TERMINAL: the desktop's own default (Debian's x-terminal-emulator),
/// then the usual ones.
#[cfg_attr(windows, allow(dead_code))]
pub const LINUX_TERMINALS: &[&str] = &[
    "x-terminal-emulator", "gnome-terminal", "ptyxis", "konsole", "kitty", "alacritty", "wezterm", "foot", "xterm",
];

/// The terminals to try, in order: $TERMINAL's program first, if set.
#[cfg_attr(windows, allow(dead_code))]
pub fn linux_candidates(env_terminal: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(first) = env_terminal.and_then(|t| t.split_whitespace().next()) {
        out.push(first.to_string());
    }
    for t in LINUX_TERMINALS {
        if !out.iter().any(|o| o == t) {
            out.push(t.to_string());
        }
    }
    out
}

/// The arguments that make `terminal` open a window in `dir` running `command`.
/// Unknown terminals get the common `-e` (as x-terminal-emulator must take).
/// konsole and wezterm are asked for a process of their own, so the window
/// gets this environment (LIV_PROMPT) and not the one of a running copy.
#[cfg_attr(windows, allow(dead_code))]
pub fn linux_terminal_args(terminal: &str, dir: &str, command: &[String]) -> Vec<String> {
    let name = Path::new(terminal).file_name().and_then(|n| n.to_str()).unwrap_or(terminal);
    let mut args: Vec<String> = match name {
        "gnome-terminal" => vec![format!("--working-directory={dir}"), "--".into()],
        "ptyxis" => vec!["--new-window".into(), "-d".into(), dir.into(), "--".into()],
        "konsole" => vec!["--separate".into(), "--workdir".into(), dir.into(), "-e".into()],
        "kitty" => vec!["--directory".into(), dir.into()],
        "alacritty" => vec!["--working-directory".into(), dir.into(), "-e".into()],
        "wezterm" => vec!["start".into(), "--always-new-process".into(), "--cwd".into(), dir.into(), "--".into()],
        "foot" => vec![format!("--working-directory={dir}")],
        _ => vec!["-e".into()],
    };
    args.extend(command.iter().cloned());
    args
}

/// The whole launch on Linux, `terminal` being the one found.
#[cfg_attr(windows, allow(dead_code))]
pub fn linux_spawn(terminal: &str, shell: &str, folder: &str, prompt: &str) -> Spawn {
    let prompt = clean_prompt(prompt);
    let command = shell_command(shell, !prompt.is_empty());
    let env = if prompt.is_empty() { Vec::new() } else { vec![("LIV_PROMPT".to_string(), prompt)] };
    Spawn { program: terminal.to_string(), args: linux_terminal_args(terminal, folder, &command), env, dir: folder.to_string() }
}

// ── Windows ───────────────────────────────────────────────────────────────────

/// `s` as a PowerShell expression for exactly that text, spelled so that
/// nothing on the way to PowerShell reads anything into it either:
/// - in single quotes, where PowerShell takes everything as it is but the
///   quote itself — the plain one and the four curly ones it also takes for
///   one — and each of those is written twice;
/// - with no `%` (Windows Terminal expands `%NAME%` in the command it starts)
///   and no `"` (wt.exe re-joins its arguments in double quotes): both are put
///   in by their character code.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn ps_literal(s: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut text = String::new();
    for c in s.chars() {
        match c {
            '%' | '"' => {
                parts.push(format!("'{text}'"));
                parts.push(format!("[char]{}", c as u32));
                text.clear();
            }
            '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => {
                text.push(c);
                text.push(c);
            }
            _ => text.push(c),
        }
    }
    if parts.is_empty() {
        return format!("'{text}'");
    }
    parts.push(format!("'{text}'"));
    format!("({})", parts.join(" + "))
}

/// The prompt as Windows gets it, on one line. A double quote becomes a single
/// one, which reads the same to Claude: to cmd.exe it would end the quoted
/// word the prompt is handed over as (see `cmd_word`).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_prompt(prompt: &str) -> String {
    clean_prompt(prompt).replace('"', "'")
}

/// `prompt` (see `windows_prompt`: no double quote in it) as one word of a
/// Windows command line, written so that cmd.exe reads nothing into it.
/// `claude` is often npm's claude.cmd, and a batch file is run by cmd.exe,
/// which reads the command line again: bare, `a&calc` runs calc and `%OS%`
/// becomes `Windows_NT`.
/// - The word is in double quotes, where `& | < > ^ ( )` and spaces are text.
/// - `%` is written `"%"`: the quotes close and open again around it, so the
///   name cmd.exe would look up between two of them is never a variable's.
/// - Backslashes right before a quote we add are doubled, or the program that
///   takes the word apart again would read `\"` as a quote of the text.
///
/// A program started directly (claude.exe) takes the same word apart into the
/// same prompt, so the one form serves both.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn cmd_word(prompt: &str) -> String {
    let mut word = String::from('"');
    let mut backslashes = 0;
    for c in prompt.chars() {
        match c {
            '%' => {
                word.push_str(&"\\".repeat(backslashes));
                word.push_str("\"%\"");
                backslashes = 0;
            }
            '\\' => {
                word.push(c);
                backslashes += 1;
            }
            _ => {
                word.push(c);
                backslashes = 0;
            }
        }
    }
    word.push_str(&"\\".repeat(backslashes));
    word.push('"');
    word
}

/// What the prompt file holds: the prompt as the one word Claude Code is started
/// with (`cmd_word`).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn prompt_file_text(prompt: &str) -> String {
    cmd_word(&windows_prompt(prompt))
}

/// What PowerShell runs: go to the project, then start Claude Code. With a
/// prompt: read the word from the file into LIV_PROMPT, delete the file, and
/// start Claude Code with that word, passed as it is (`Legacy`: PowerShell 7.3
/// and later would otherwise escape the quotes it is written with; the setting
/// lasts for that one call). `Get-Command -CommandType Application` takes
/// claude.exe or claude.cmd, never npm's claude.ps1, which the default
/// execution policy refuses to run.
///
/// The folder and the file's path are the only things spelled out, each as a
/// `ps_literal`; the script has no double quote and no `%` in it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn powershell_script(folder: &str, prompt_file: Option<&str>) -> String {
    let go = format!("Set-Location -LiteralPath {}", ps_literal(folder));
    let claude = "(Get-Command claude -CommandType Application -TotalCount 1)";
    match prompt_file {
        None => format!("{go}; & {claude}"),
        Some(file) => {
            let f = ps_literal(file);
            format!(
                "{go}; $env:LIV_PROMPT = Get-Content -LiteralPath {f} -Raw -Encoding UTF8; \
                 Remove-Item -LiteralPath {f}; \
                 & {{ $PSNativeCommandArgumentPassing = 'Legacy'; & {claude} $env:LIV_PROMPT }}"
            )
        }
    }
}

/// wt.exe splits its command line into several commands at each `;`: in the
/// command it hands the shell, they are written `\;`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn wt_escape(s: &str) -> String {
    s.replace(';', r"\;")
}

/// The whole launch on Windows: in Windows Terminal (`wt`, its path) when it
/// is installed, else PowerShell in a console of its own (the caller gives it
/// one). `shell` is pwsh.exe or powershell.exe. The folder is not handed to
/// wt.exe (`-d`), which would read `;` and `%NAME%` in it: the script goes
/// there itself.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_spawn(wt: Option<&str>, shell: &str, folder: &str, prompt_file: Option<&str>) -> Spawn {
    let script = powershell_script(folder, prompt_file);
    match wt {
        Some(wt) => Spawn {
            program: wt.to_string(),
            args: vec![shell.into(), "-NoExit".into(), "-NoLogo".into(), "-Command".into(), wt_escape(&script)],
            env: Vec::new(),
            dir: folder.to_string(),
        },
        None => Spawn {
            program: shell.to_string(),
            args: vec!["-NoExit".into(), "-NoLogo".into(), "-Command".into(), script],
            env: Vec::new(),
            dir: folder.to_string(),
        },
    }
}

// ── Drop ──────────────────────────────────────────────────────────────────────

/// What a file dropped on a session types into its prompt: the paths as a
/// terminal writes them when files are dragged onto it, then a space. Claude
/// Code takes them as files, an image path as the image. Windows Terminal
/// puts a path with a space in double quotes (a backslash is a separator
/// there); a Linux terminal, like the Mac's, puts a backslash before spaces
/// and shell characters.
pub fn drop_text(paths: &[String], windows: bool) -> String {
    let escaped: Vec<String> = paths
        .iter()
        .map(|path| {
            if windows {
                if path.chars().any(|c| c == ' ' || "&()[]{}^=;!'+,`~".contains(c)) {
                    format!("\"{path}\"")
                } else {
                    path.clone()
                }
            } else {
                let special = " ()'\"\\&;|<>*?[]{}$`!#~";
                path.chars().map(|c| if special.contains(c) { format!("\\{c}") } else { c.to_string() }).collect()
            }
        })
        .collect();
    format!("{} ", escaped.join(" "))
}

// ── Commands ──────────────────────────────────────────────────────────────────

fn start(spawn: &Spawn, new_console: bool) -> std::io::Result<()> {
    let mut cmd = Command::new(&spawn.program);
    cmd.args(&spawn.args).current_dir(&spawn.dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // PowerShell on its own needs a console window to show in; wt.exe
        // opens its own window and must not flash one.
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        if new_console {
            cmd.creation_flags(CREATE_NEW_CONSOLE);
        } else {
            platform::no_console(&mut cmd);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = new_console;
        // Liv's own GDK settings stay out of the terminal (platform/linux.rs).
        platform::no_console(&mut cmd);
    }
    for (k, v) in &spawn.env {
        cmd.env(k, v);
    }
    cmd.spawn().map(|_| ())
}

#[cfg(target_os = "linux")]
fn launch_here(folder: &str, prompt: &str) -> Result<String, String> {
    let shell = std::env::var("SHELL").ok().filter(|s| Path::new(s).is_absolute()).unwrap_or_else(|| "/bin/bash".into());
    let env_terminal = std::env::var("TERMINAL").ok();
    for candidate in linux_candidates(env_terminal.as_deref()) {
        let Some(path) = (if Path::new(&candidate).is_absolute() {
            Some(std::path::PathBuf::from(&candidate)).filter(|p| p.is_file())
        } else {
            platform::find_on_path(&candidate)
        }) else {
            continue;
        };
        let spawn = linux_spawn(&path.to_string_lossy(), &shell, folder, prompt);
        match start(&spawn, false) {
            Ok(()) => return Ok(candidate),
            Err(err) => crate::log::line(format!("launch: {candidate} didn't start: {err}")),
        }
    }
    Err("no terminal found".into())
}

#[cfg(windows)]
fn launch_here(folder: &str, prompt: &str) -> Result<String, String> {
    let prompt = windows_prompt(prompt);
    let file = if prompt.is_empty() {
        None
    } else {
        let mut bytes = [0u8; 8];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).map_err(|_| "no randomness")?;
        let name = format!("liv-prompt-{}.txt", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, prompt_file_text(&prompt).as_bytes()).map_err(|e| e.to_string())?;
        // PowerShell deletes it once read; this catches a terminal that never started.
        let stale = path.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(120));
            let _ = std::fs::remove_file(stale);
        });
        Some(path.to_string_lossy().to_string())
    };
    // By name, found on %PATH% by the terminal: a full path would carry the
    // spaces of "Program Files" through wt.exe's re-joined command line.
    let shell = if platform::find_on_path("pwsh").is_some() { "pwsh.exe" } else { "powershell.exe" };
    if let Some(wt) = platform::windows_terminal() {
        let spawn = windows_spawn(Some(&wt.to_string_lossy()), shell, folder, file.as_deref());
        match start(&spawn, false) {
            Ok(()) => return Ok("Windows Terminal".into()),
            Err(err) => crate::log::line(format!("launch: Windows Terminal didn't start: {err}")),
        }
    }
    let spawn = windows_spawn(None, shell, folder, file.as_deref());
    start(&spawn, true).map(|()| "PowerShell".into()).map_err(|e| e.to_string())
}

/// Opens the user's terminal in `folder` with Claude Code and the prompt.
/// False when the folder isn't one or no terminal could be started.
#[tauri::command]
pub fn launch_session(folder: String, prompt: String) -> bool {
    if !valid_folder(&folder) {
        return false;
    }
    let name = session_window::folder_name(&folder).to_string();
    match launch_here(&folder, &prompt) {
        Ok(terminal) => {
            crate::log::line(format!("launch: Claude Code in {name} with {terminal}"));
            true
        }
        Err(err) => {
            crate::log::line(format!("launch: couldn't open a terminal in {name}: {err}"));
            false
        }
    }
}

/// "Choose a folder…": the system's folder picker, `start` open in it.
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle, start: Option<String>) -> Option<String> {
    let title = crate::i18n::t("Choose a folder…");
    let start = start.filter(|s| valid_folder(s));
    tauri::async_runtime::spawn_blocking(move || platform::pick_folder(&app, start.as_deref(), &title))
        .await
        .ok()
        .flatten()
        .filter(|p| valid_folder(p))
}

/// Brings the session's window forward and pastes the paths into it.
/// "pasted"; "copied" when they could only be put on the clipboard (the
/// window wasn't found, or the keystroke was refused); "failed".
#[tauri::command]
pub async fn drop_into_session(session_id: String, path: Option<String>, paths: Vec<String>) -> String {
    let paths: Vec<String> = paths.into_iter().filter(|p| Path::new(p).is_absolute()).take(32).collect();
    if paths.is_empty() {
        return "failed".into();
    }
    let text = drop_text(&paths, cfg!(windows));
    let folder = path.as_deref().map(session_window::folder_name).unwrap_or_default().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let in_herdr = herdr::focus(&session_id);
        let focused = session_window::lookup(&session_id)
            .is_some_and(|owners| platform::focus_session_window(&owners, &folder))
            || in_herdr;
        crate::log::line(format!("drop: {} file(s) into a session, window found: {focused}", paths.len()));
        if !focused {
            return if paste::copy(&text) { "copied" } else { "failed" }.to_string();
        }
        // The window takes a moment to come forward and take the keyboard.
        std::thread::sleep(Duration::from_millis(250));
        // A Linux terminal pastes with Ctrl+Shift+V (VS Code's terminal too);
        // Windows Terminal, VS Code and the console with Ctrl+V.
        match paste::paste(&text, cfg!(target_os = "linux")) {
            paste::Outcome::Pasted => "pasted",
            paste::Outcome::Copied => "copied",
            paste::Outcome::Failed => "failed",
        }
        .to_string()
    })
    .await
    .unwrap_or_else(|_| "failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn the_prompt_is_trimmed_onto_one_line() {
        assert_eq!(clean_prompt("  fix the bug \n\r\n and test it  "), "fix the bug and test it");
        assert_eq!(clean_prompt("   "), "");
    }

    #[test]
    fn only_an_existing_absolute_folder_is_a_project() {
        let dir = std::env::temp_dir();
        assert!(valid_folder(&dir.to_string_lossy()));
        assert!(!valid_folder(""));
        assert!(!valid_folder("relative/path"));
        assert!(!valid_folder("/no/such/folder/liv-xyz"));
        let file = dir.join("liv-launch-test-file.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(!valid_folder(&file.to_string_lossy()), "a file is not a folder");
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn sh_quote_leaves_plain_paths_and_quotes_the_rest() {
        assert_eq!(sh_quote("/usr/bin/zsh"), "/usr/bin/zsh");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("/opt/my shell/fish"), "'/opt/my shell/fish'");
        assert_eq!(sh_quote(""), "''");
    }

    #[test]
    fn the_shell_runs_claude_with_the_variable_never_the_prompt() {
        assert_eq!(
            shell_command("/bin/zsh", true),
            s(&["/bin/zsh", "-lic", r#"claude "$LIV_PROMPT"; exec /bin/zsh -l"#])
        );
        assert_eq!(shell_command("/usr/bin/fish", false), s(&["/usr/bin/fish", "-lic", "claude; exec /usr/bin/fish -l"]));
    }

    #[test]
    fn terminal_is_tried_first_then_the_known_ones_without_duplicates() {
        let list = linux_candidates(Some("kitty -1"));
        assert_eq!(list[0], "kitty");
        assert_eq!(list.iter().filter(|t| *t == "kitty").count(), 1);
        assert_eq!(list[1], "x-terminal-emulator");
        assert_eq!(linux_candidates(None), s(LINUX_TERMINALS));
        assert_eq!(linux_candidates(Some("  ")), s(LINUX_TERMINALS));
    }

    #[test]
    fn each_terminal_gets_the_folder_and_the_command_its_way() {
        let cmd = s(&["/bin/bash", "-lic", "claude; exec /bin/bash -l"]);
        let dir = "/home/me/My Project";
        let with = |t: &str| linux_terminal_args(t, dir, &cmd);
        let tail = |args: Vec<String>, head: &[&str]| {
            let mut want = s(head);
            want.extend(cmd.iter().cloned());
            assert_eq!(args, want);
        };
        tail(with("/usr/bin/gnome-terminal"), &["--working-directory=/home/me/My Project", "--"]);
        tail(with("ptyxis"), &["--new-window", "-d", dir, "--"]);
        tail(with("konsole"), &["--separate", "--workdir", dir, "-e"]);
        tail(with("kitty"), &["--directory", dir]);
        tail(with("alacritty"), &["--working-directory", dir, "-e"]);
        tail(with("wezterm"), &["start", "--always-new-process", "--cwd", dir, "--"]);
        tail(with("foot"), &["--working-directory=/home/me/My Project"]);
        tail(with("x-terminal-emulator"), &["-e"]);
        tail(with("/opt/st/st"), &["-e"]);
    }

    #[test]
    fn linux_hands_the_prompt_in_the_environment_only() {
        let nasty = r#"fix the "login" bug; rm -rf / && echo $HOME `id` $(id)"#;
        let spawn = linux_spawn("/usr/bin/kitty", "/bin/zsh", "/home/me/p", nasty);
        assert_eq!(spawn.program, "/usr/bin/kitty");
        assert_eq!(spawn.dir, "/home/me/p");
        assert_eq!(spawn.env, vec![("LIV_PROMPT".to_string(), nasty.to_string())]);
        assert!(spawn.args.iter().all(|a| !a.contains("login") && !a.contains("rm -rf")), "{:?}", spawn.args);
        assert_eq!(spawn.args.last().unwrap(), r#"claude "$LIV_PROMPT"; exec /bin/zsh -l"#);

        let empty = linux_spawn("kitty", "/bin/zsh", "/home/me/p", "  \n ");
        assert!(empty.env.is_empty());
        assert_eq!(empty.args.last().unwrap(), "claude; exec /bin/zsh -l");
    }

    /// A folder and a prompt made of everything a shell on the way reads into.
    const HOSTILE_FOLDER: &str = "C:\\code\\it's a &;%OS% `$(x) (pro\u{2019}ject)";
    const HOSTILE_PROMPTS: &[&str] = &[
        "a&ver>pwned.txt",
        "a|ver",
        "%OS%",
        "50% of 100% & more",
        r#"fix the "login" bug; rm -rf / && echo $HOME `id` $(id) > pwned.txt"#,
        r"keep C:\dir\ and C:\dir\%OS%\",
        "it's ^caret^ <in> (paren) !bang!",
    ];

    #[test]
    fn a_powershell_literal_is_the_text_and_nothing_reads_into_it() {
        assert_eq!(ps_literal(r"C:\Users\me\AppData\Local\Temp\p.txt"), r"'C:\Users\me\AppData\Local\Temp\p.txt'");
        // The plain quote and the curly ones PowerShell also ends a string at: each twice.
        assert_eq!(ps_literal(r"C:\Users\O'Brien\p.txt"), r"'C:\Users\O''Brien\p.txt'");
        assert_eq!(ps_literal("a\u{2018}b\u{2019}c\u{201A}d\u{201B}e"), "'a\u{2018}\u{2018}b\u{2019}\u{2019}c\u{201A}\u{201A}d\u{201B}\u{201B}e'");
        // No % for Windows Terminal to expand, no double quote for wt.exe's re-joining.
        assert_eq!(ps_literal("C:\\a\\%OS%\\b"), "('C:\\a\\' + [char]37 + 'OS' + [char]37 + '\\b')");
        assert_eq!(ps_literal("say \"hi\""), "('say ' + [char]34 + 'hi' + [char]34 + '')");
        // What PowerShell takes as it is in single quotes stays as it is.
        assert_eq!(ps_literal("$(calc) `n $env:X ; & |"), "'$(calc) `n $env:X ; & |'");
        assert_eq!(ps_literal(""), "''");
        assert_eq!(wt_escape("a; b; c"), r"a\; b\; c");
    }

    #[test]
    fn the_prompt_is_one_word_to_cmd_whatever_it_holds() {
        assert_eq!(windows_prompt(r#"fix the "login" bug & exit"#), "fix the 'login' bug & exit");
        assert_eq!(cmd_word("fix it"), "\"fix it\"");
        // Without a space too: bare, cmd.exe would run what follows the &.
        assert_eq!(cmd_word("a&calc"), "\"a&calc\"");
        assert_eq!(cmd_word(""), "\"\"");
        // No name is left between two % for cmd.exe to look up.
        assert_eq!(cmd_word("%OS%"), "\"\"%\"OS\"%\"\"");
        assert_eq!(cmd_word("50% of it"), "\"50\"%\" of it\"");
        // A backslash before a quote we add is doubled; any other is left alone.
        assert_eq!(cmd_word(r"C:\dir\"), r#""C:\dir\\""#);
        assert_eq!(cmd_word(r"C:\dir\\%OS%"), r#""C:\dir\\\\"%"OS"%"""#);

        for prompt in HOSTILE_PROMPTS {
            let word = cmd_word(&windows_prompt(prompt));
            // Quotes come in pairs, so every & | < > ^ of the prompt is inside a pair…
            let mut inside = false;
            for c in word.chars() {
                match c {
                    '"' => inside = !inside,
                    '%' => assert!(!inside, "{word}"),
                    _ => assert!(inside, "{c:?} is outside the quotes in {word}"),
                }
            }
            assert!(!inside, "{word}");
            // …and that word, on its one line, is all the file carries.
            assert_eq!(prompt_file_text(prompt), word);
            assert!(!word.contains(['\r', '\n']));
        }
    }

    #[test]
    fn powershell_goes_to_the_folder_and_reads_the_prompt_from_our_file() {
        assert_eq!(
            powershell_script(r"C:\code\app", None),
            r"Set-Location -LiteralPath 'C:\code\app'; & (Get-Command claude -CommandType Application -TotalCount 1)"
        );
        assert_eq!(
            powershell_script(r"C:\code\app", Some(r"C:\Temp\liv-prompt-ab.txt")),
            "Set-Location -LiteralPath 'C:\\code\\app'; \
             $env:LIV_PROMPT = Get-Content -LiteralPath 'C:\\Temp\\liv-prompt-ab.txt' -Raw -Encoding UTF8; \
             Remove-Item -LiteralPath 'C:\\Temp\\liv-prompt-ab.txt'; \
             & { $PSNativeCommandArgumentPassing = 'Legacy'; \
             & (Get-Command claude -CommandType Application -TotalCount 1) $env:LIV_PROMPT }"
        );
        // Whatever the folder and the file are called: no double quote (wt.exe
        // re-joins its arguments in them), no % (Windows Terminal expands it),
        // and the prompt itself is nowhere in it.
        let file = format!("{HOSTILE_FOLDER}\\liv-prompt-ab.txt");
        for script in [powershell_script(HOSTILE_FOLDER, None), powershell_script(HOSTILE_FOLDER, Some(&file))] {
            assert!(!script.contains(['"', '%']), "{script}");
            assert!(script.starts_with(
                "Set-Location -LiteralPath ('C:\\code\\it''s a &;' + [char]37 + 'OS' + [char]37 + ' `$(x) (pro\u{2019}\u{2019}ject)'); "
            ), "{script}");
        }
    }

    #[test]
    fn windows_terminal_or_a_powershell_console() {
        let file = Some(r"C:\Temp\p.txt");
        let wt = windows_spawn(Some(r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\wt.exe"), "pwsh.exe", HOSTILE_FOLDER, file);
        // The folder is no argument of wt.exe's: it would split it at the ; and expand its %OS%.
        assert_eq!(wt.args[..4], s(&["pwsh.exe", "-NoExit", "-NoLogo", "-Command"]));
        assert_eq!(wt.args.len(), 5);
        let script = &wt.args[4];
        assert!(script.contains(r"\;") && !script.replace(r"\;", "").contains(';'), "every semicolon escaped for wt: {script}");
        assert_eq!(script.replace(r"\;", ";"), powershell_script(HOSTILE_FOLDER, file));
        assert_eq!(wt.dir, HOSTILE_FOLDER);
        assert!(wt.env.is_empty());

        let console = windows_spawn(None, "powershell.exe", r"C:\code", None);
        assert_eq!(console.program, "powershell.exe");
        assert_eq!(console.args, s(&["-NoExit", "-NoLogo", "-Command", &powershell_script(r"C:\code", None)]));
        assert_eq!(console.dir, r"C:\code");
    }

    /// The real thing, short of Claude Code itself: PowerShell runs the script
    /// with a batch file standing in for npm's claude.cmd, in a folder and with
    /// prompts made to be read into. The stand-in leaves a file in the folder it
    /// was started in and writes down its arguments as cmd.exe handed them over.
    #[cfg(windows)]
    #[test]
    fn a_hostile_folder_and_prompt_reach_a_batch_claude_as_text_and_run_nothing() {
        let root = std::env::temp_dir().join(format!("liv-launch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bin = root.join("bin");
        let folder = root.join(HOSTILE_FOLDER.rsplit('\\').next().unwrap());
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(bin.join("claude.cmd"), "@echo off\r\n>started-here.txt echo here\r\n>\"%~dp0args.txt\" echo(%*\r\n")
            .unwrap();
        // The stand-in is the only `claude` there is to find: the real one is not on this PATH.
        let system = std::path::PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot")).join("System32");
        let path = std::env::join_paths([bin.clone(), system.clone()]).unwrap();
        let powershell = system.join("WindowsPowerShell").join("v1.0").join("powershell.exe");
        let read = |name: &str| std::fs::read_to_string(bin.join(name)).unwrap_or_default().trim_end().to_string();

        for prompt in HOSTILE_PROMPTS {
            let file = folder.join("liv-prompt-test.txt");
            std::fs::write(&file, prompt_file_text(prompt)).unwrap();
            let _ = std::fs::remove_file(folder.join("started-here.txt"));
            let spawn = windows_spawn(None, "powershell.exe", &folder.to_string_lossy(), Some(&file.to_string_lossy()));
            // As launch_here starts it, less -NoExit: the test has no one to close the console.
            let args: Vec<&String> = spawn.args.iter().filter(|a| *a != "-NoExit").collect();
            let mut cmd = Command::new(&powershell);
            cmd.arg("-NoProfile").args(args).current_dir(&root).env("PATH", &path).stdin(std::process::Stdio::null());
            let status = platform::no_console(&mut cmd).status().expect("powershell starts");
            assert!(status.success(), "{prompt}");

            assert!(folder.join("started-here.txt").exists(), "started in the folder itself");
            assert_eq!(read("args.txt"), cmd_word(&windows_prompt(prompt)), "{prompt}");
            assert!(!file.exists(), "the prompt file is deleted once read");
            // Nothing in the prompt ran: its redirections would have left a file behind.
            let left: Vec<String> = [&root, &folder, &bin]
                .iter()
                .flat_map(|dir| std::fs::read_dir(dir).unwrap())
                .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
                .filter(|name| name.contains("pwned"))
                .collect();
            assert!(left.is_empty(), "{prompt}: {left:?}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dropped_paths_are_written_as_a_terminal_drag_writes_them() {
        assert_eq!(
            drop_text(&s(&["/tmp/Screenshot 2026-11-06 at 14.03.22.png"]), false),
            r"/tmp/Screenshot\ 2026-11-06\ at\ 14.03.22.png "
        );
        assert_eq!(drop_text(&s(&["/a/b.txt", "/c/it's (1).md"]), false), r"/a/b.txt /c/it\'s\ \(1\).md ");
        assert_eq!(drop_text(&s(&[r"C:\Users\me\a.png"]), true), r"C:\Users\me\a.png ");
        assert_eq!(
            drop_text(&s(&[r"C:\Users\me\My Shots\a.png", r"D:\x.txt"]), true),
            r#""C:\Users\me\My Shots\a.png" D:\x.txt "#
        );
    }
}
