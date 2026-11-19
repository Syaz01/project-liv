// Windows: Win32 for the island window and the cursor, %APPDATA% for files.

use std::collections::HashMap;
use std::os::windows::io::RawHandle;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

use tauri::{AppHandle, Manager, WebviewWindow};

use ::windows::core::{w, BOOL, HSTRING, PWSTR};
use ::windows::Win32::Foundation::{
    CloseHandle, HANDLE, HLOCAL, HWND, LPARAM, LocalFree, POINT, RECT, RPC_E_CHANGED_MODE,
};
use ::windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use ::windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use ::windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use ::windows::Win32::Security::{
    GetTokenInformation, RevertToSelf, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
    TOKEN_QUERY, TOKEN_USER,
};
use ::windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use ::windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use ::windows::Win32::System::Ole::RevokeDragDrop;
use ::windows::Win32::System::Pipes::{GetNamedPipeClientProcessId, ImpersonateNamedPipeClient};
use ::windows::Win32::System::Registry::{
    RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
};
use ::windows::Win32::System::SystemInformation::GetLocalTime;
use ::windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcess, GetCurrentProcessId, GetCurrentThread, GetCurrentThreadId,
    OpenProcessToken, OpenThreadToken,
};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyboardLayoutList, MapVirtualKeyExW, ToUnicodeEx, HKL, MAPVK_VK_TO_VSC,
    VK_CONTROL, VK_LBUTTON, VK_MENU, VK_SHIFT,
};
use ::windows::Win32::UI::Shell::{
    ShellExecuteExW, SHELLEXECUTEINFOW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumChildWindows, EnumWindows, GetClassNameW, GetCursorPos,
    GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed, SetForegroundWindow,
    SetWindowLongPtrW, ShowWindow, GWL_EXSTYLE, GWL_STYLE, GW_OWNER, SW_RESTORE, SW_SHOW,
    SW_SHOWNORMAL, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use super::LocalTime;
use crate::fullscreen::{self, Foreground, Rect};
use crate::session_window::{self, Proc};

/// File name of the Claude Code relay.
pub const HOOK_EXE: &str = "liv-hook.exe";

/// Environment variable holding the home directory.
pub const HOME_VAR: &str = "USERPROFILE";

/// Keeps spawned helpers from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Files ─────────────────────────────────────────────────────────────────────

/// %APPDATA%\Liv — preferences.
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Liv")
}

/// %LOCALAPPDATA%\Liv — where liv-hook.exe, the inbox and the log live.
pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Liv")
}

/// Where a saved image goes, best first: Pictures (also where OneDrive moves
/// it), then Downloads and the profile folder. The caller takes the first one
/// that exists. Read from the environment rather than the Known Folders API: a
/// relocated Pictures folder falls back to Downloads, which is fine for a PNG.
pub fn picture_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    if let Some(home) = &home {
        dirs.push(home.join("Pictures"));
    }
    if let Some(onedrive) = std::env::var_os("OneDrive").map(PathBuf::from) {
        dirs.push(onedrive.join("Pictures"));
    }
    if let Some(home) = home {
        dirs.push(home.join("Downloads"));
        dirs.push(home);
    }
    dirs
}

/// %APPDATA% and %LOCALAPPDATA% are already private to the user.
pub fn ensure_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Nothing to set up before the webview starts.
pub fn prepare_environment() {}

pub fn local_time() -> LocalTime {
    let t = unsafe { GetLocalTime() };
    LocalTime {
        year: t.wYear.into(),
        month: t.wMonth.into(),
        day: t.wDay.into(),
        hour: t.wHour.into(),
        minute: t.wMinute.into(),
        second: t.wSecond.into(),
    }
}

// ── Processes ─────────────────────────────────────────────────────────────────

/// Spawned helpers must never flash a console window.
pub fn no_console(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

pub fn open_url(url: &str) {
    let _ = no_console(Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url]))
        .spawn();
}

pub fn reveal_folder(path: &str) {
    let _ = Command::new("explorer").arg(path).spawn();
}

/// Our own `where`: walks %PATH% against %PATHEXT%, no shell involved.
/// Rust quotes arguments correctly for `.cmd`/`.bat` targets since 1.77, so
/// spawning `code.cmd` directly is safe.
///
/// The folders this process was started with come first, then the ones Windows
/// has now: an installer adds its folder to the PATH in the registry, and a
/// program already running never sees it. So a tool installed while Liv runs
/// is found at once, without starting Liv again.
pub fn find_on_path(stem: &str) -> Option<PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let mut dirs: Vec<PathBuf> =
        std::env::var_os("PATH").map(|path| std::env::split_paths(&path).collect()).unwrap_or_default();
    dirs.extend(path_dirs_now());
    search_dirs(&dirs, &exts, stem)
}

/// The first `stem` with one of `exts` (`.COM;.EXE;…`) in `dirs`, in their order.
fn search_dirs(dirs: &[PathBuf], exts: &str, stem: &str) -> Option<PathBuf> {
    for dir in dirs {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{stem}{}", ext.to_lowercase()));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The folders of the machine's `Path` and the user's, as the registry holds them now.
fn path_dirs_now() -> Vec<PathBuf> {
    let env = |name: &str| std::env::var(name).ok();
    [
        (HKEY_LOCAL_MACHINE, w!("SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")),
        (HKEY_CURRENT_USER, w!("Environment")),
    ]
    .into_iter()
    .filter_map(|(root, key)| registry_string(root, key, w!("Path")))
    .flat_map(|value| path_value_dirs(&value, env))
    .collect()
}

/// A string of the registry as it is written there; None when there is none.
fn registry_string(root: HKEY, key: ::windows::core::PCWSTR, name: ::windows::core::PCWSTR) -> Option<String> {
    let kinds = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
    unsafe {
        let mut bytes = 0u32;
        RegGetValueW(root, key, name, kinds, None, None, Some(&mut bytes)).ok().ok()?;
        let mut text = vec![0u16; (bytes as usize).div_ceil(2) + 1];
        let mut bytes = (text.len() * 2) as u32;
        RegGetValueW(root, key, name, kinds, None, Some(text.as_mut_ptr().cast()), Some(&mut bytes)).ok().ok()?;
        let end = text.iter().position(|c| *c == 0).unwrap_or(text.len());
        Some(String::from_utf16_lossy(&text[..end]))
    }
}

/// The folders of a `Path` value: split on `;`, its `%VARIABLES%` filled in
/// from `env`, quotes dropped. Only whole paths count: a relative one would
/// mean a different folder for every program.
fn path_value_dirs(value: &str, env: impl Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    value
        .split(';')
        .map(|dir| expand_variables(dir.trim().trim_matches('"'), &env))
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .collect()
}

/// `text` with each `%NAME%` that `env` knows replaced by its value; one it
/// does not know stays as written, as Windows leaves it.
fn expand_variables(text: &str, env: &impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => match env(&after[..end]).filter(|_| end > 0) {
                Some(value) => {
                    out.push_str(&value);
                    rest = &after[end + 1..];
                }
                None => {
                    out.push('%');
                    rest = after;
                }
            },
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Where a CLI such as `codex` or `claude` may be, best first: %PATH% (the
/// .exe or npm's .cmd), then npm's global folder, the Volta / Bun / pnpm ones
/// and the native installers' %USERPROFILE%\.local\bin. Rust quotes arguments
/// safely for a `.cmd` (see find_on_path).
pub fn cli_candidates(name: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = find_on_path(name).into_iter().collect();
    let var = |k: &str| std::env::var_os(k).map(PathBuf::from).filter(|p| p.is_absolute());
    if let Some(appdata) = var("APPDATA") {
        out.push(appdata.join("npm").join(format!("{name}.cmd")));
    }
    if let Some(local) = var("LOCALAPPDATA") {
        out.push(local.join("Volta").join("bin").join(format!("{name}.exe")));
        out.push(local.join("pnpm").join(format!("{name}.cmd")));
    }
    if let Some(home) = var("USERPROFILE") {
        out.push(home.join(".bun").join("bin").join(format!("{name}.exe")));
        out.push(home.join(".local").join("bin").join(format!("{name}.exe")));
    }
    out.retain(|p| p.is_file());
    out
}

// ── Who we are ────────────────────────────────────────────────────────────────
//
// Named pipes share one machine-wide namespace, so the SID in the name is what
// keeps two accounts on the same machine from ever meeting on `liv-*`.
// liv-hook computes the same string (hook/src/win.rs) and additionally checks
// that the process serving the pipe really is us.

/// The SID of the account this process runs as, as `S-1-5-21-…`.
pub fn current_user_sid() -> Option<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;
        token_user_sid(token)
    }
}

/// The SID of the account `token` is for, as `S-1-5-21-…`. Closes `token`.
unsafe fn token_user_sid(token: HANDLE) -> Option<String> {
    // First call sizes the buffer, second fills it.
    let mut needed = 0u32;
    let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
    if needed == 0 {
        let _ = CloseHandle(token);
        return None;
    }
    let mut buf = vec![0u8; needed as usize];
    let ok = GetTokenInformation(
        token,
        TokenUser,
        Some(buf.as_mut_ptr().cast()),
        needed,
        &mut needed,
    )
    .is_ok();
    let _ = CloseHandle(token);
    if !ok {
        return None;
    }

    let user = &*(buf.as_ptr() as *const TOKEN_USER);
    let mut text = PWSTR::null();
    ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
    let sid = text.to_string().ok();
    let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
    sid
}

/// Calls `create` with the security attributes of something only this account
/// may open, and no other account on the machine: the relay pipe. Left to
/// Windows' default, a named pipe can also be read by everyone.
///
/// Fails, creating nothing, when our own SID cannot be read: a pipe is never
/// opened with looser access than this.
pub fn with_owner_only_access<T>(
    create: impl FnOnce(*mut std::ffi::c_void) -> std::io::Result<T>,
) -> std::io::Result<T> {
    let sid = current_user_sid().ok_or_else(|| std::io::Error::other("this account's SID cannot be read"))?;
    // A DACL (D:) that inherits nothing (P) and has one entry: allow (A) full
    // access (GA) to this account.
    let sddl = HSTRING::from(format!("D:P(A;;GA;;;{sid})"));
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(&sddl, SDDL_REVISION_1, &mut descriptor, None)
            .map_err(std::io::Error::other)?;
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        let created = create((&mut attributes as *mut SECURITY_ATTRIBUTES).cast());
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        created
    }
}

/// True when the relay on the other end of the pipe `handle` runs as the same
/// account we do. The pipe itself is asked — it holds the identity its client
/// connected with — and not the client's process, which for most events has
/// exited by the time we look. To be called once something has been read from
/// the pipe: Windows refuses to say whose it is before.
///
/// Anything that fails reads as "not ours": refusing a relay costs one hook
/// event, while serving one we cannot vouch for would let another account put
/// requests on the island.
pub fn pipe_client_is_same_user(handle: RawHandle) -> bool {
    let Some(mine) = current_user_sid() else { return false };
    let theirs = unsafe {
        if ImpersonateNamedPipeClient(HANDLE(handle)).is_err() {
            return false;
        }
        // Opened as ourselves: the client's identity may be one that could not
        // open its own token here.
        let mut token = HANDLE::default();
        let opened = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, &mut token);
        // The thread is itself again before anything else runs on it. If Windows
        // cannot put it back, nothing may go on under someone else's identity.
        if RevertToSelf().is_err() {
            std::process::abort();
        }
        if opened.is_err() {
            return false;
        }
        token_user_sid(token)
    };
    theirs.as_deref() == Some(mine.as_str())
}

// The display name only feeds the user's first name (identity.rs). The calls are
// declared here by hand, with their documented C signatures, so they need no
// extra `windows` crate features.
#[link(name = "secur32")]
extern "system" {
    fn GetUserNameExW(name_format: i32, name_buffer: *mut u16, size: *mut u32) -> u8;
}

#[link(name = "netapi32")]
extern "system" {
    fn NetUserGetInfo(server: *const u16, user: *const u16, level: u32, buffer: *mut *mut u8) -> u32;
    fn NetApiBufferFree(buffer: *mut core::ffi::c_void) -> u32;
}

/// EXTENDED_NAME_FORMAT::NameDisplay.
const NAME_DISPLAY: i32 = 3;

/// The account's display name ("Ana Torres"): the directory's for a domain
/// or Entra account, else the local account's "Full name", else nothing.
pub fn user_full_name() -> Option<String> {
    directory_display_name().or_else(local_full_name).filter(|n| !n.trim().is_empty())
}

fn directory_display_name() -> Option<String> {
    let mut buf = [0u16; 256];
    let mut size = buf.len() as u32;
    // On success `size` is the length copied, without the terminating null.
    let ok = unsafe { GetUserNameExW(NAME_DISPLAY, buf.as_mut_ptr(), &mut size) } != 0;
    if !ok || size as usize > buf.len() {
        return None;
    }
    String::from_utf16(&buf[..size as usize]).ok()
}

fn local_full_name() -> Option<String> {
    let user = std::env::var("USERNAME").ok().filter(|u| !u.is_empty())?;
    let wide: Vec<u16> = user.encode_utf16().chain(std::iter::once(0)).collect();
    let mut info: *mut u8 = std::ptr::null_mut();
    // Level 10 is USER_INFO_10 { name, comment, usr_comment, full_name }, four
    // wide-string pointers; any user may read it about themselves.
    let status = unsafe { NetUserGetInfo(std::ptr::null(), wide.as_ptr(), 10, &mut info) };
    if status != 0 || info.is_null() {
        return None;
    }
    unsafe {
        let full = *(info as *const *const u16).add(3);
        let text = if full.is_null() {
            None
        } else {
            let mut len = 0usize;
            while len < 256 && *full.add(len) != 0 {
                len += 1;
            }
            String::from_utf16(std::slice::from_raw_parts(full, len)).ok()
        };
        NetApiBufferFree(info.cast());
        text
    }
}

// ── Cursor ────────────────────────────────────────────────────────────────────

/// The 60 Hz poll reads the cursor and flips click-through from it.
pub const CURSOR_POLL: bool = true;

/// Folded, the island's window stays exactly as it is — same size, same place,
/// whole — and only lets the mouse through; the poll watches for the cursor on
/// the closed island (island.rs: `wake_if_hovered`). Nothing about the window
/// changes as it wakes, so nothing can be seen to change:
/// - shrunk to the closed island, it had to grow and move back, and for a
///   frame the webview still laid the page out for the small window — the
///   closed island was seen at the left before it opened;
/// - cut down to the closed island with a window region, Windows painted the
///   part that came back white before the webview drew it.
pub const FOLDS_IN_PLACE: bool = true;

/// Cursor position in physical screen pixels.
pub fn cursor_physical() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

/// True while the left mouse button is held — the only signal we get that a
/// drag might be in flight before it reaches the window.
pub fn left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

// ── Island window ─────────────────────────────────────────────────────────────

fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
    let raw = win.hwnd().ok()?.0 as isize;
    if raw == 0 {
        return None;
    }
    Some(HWND(raw as *mut _))
}

/// Keeps the settings window from showing the "no drop" cursor.
///
/// wry installs its drop target by walking the webview's child windows **once**,
/// when the webview is created. WebView2 creates `Chrome_RenderWidgetHostHWND`
/// later and registers its own target on it; being the innermost window, that one
/// wins, and since the page has no HTML5 drop handler it refuses everything.
/// Revoking it makes OLE fall through to wry's target. The island is the other
/// way round: it takes drops through WebView2's own target (see webview_drop.rs),
/// so its windows are left alone.
///
/// Cheap and idempotent, so it is simply re-run whenever a drag might be starting.
pub fn unblock_webview_drops(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else { return };
    let Some(hwnd) = hwnd_of(&win) else { return };
    unsafe {
        let _ = EnumChildWindows(Some(hwnd), Some(revoke_render_widget), LPARAM(0));
    }
}

unsafe extern "system" fn revoke_render_widget(hwnd: HWND, _: LPARAM) -> BOOL {
    let mut name = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut name) };
    if len > 0 {
        let class = String::from_utf16_lossy(&name[..len as usize]);
        if class == "Chrome_RenderWidgetHostHWND" {
            let _ = unsafe { RevokeDragDrop(hwnd) };
        }
    }
    true.into()
}

/// The island has the keyboard: a text field in it is being typed in, or its
/// own shortcuts are in use. Written by `set_activating` alone, and read by
/// everything that writes the island's extended style.
static ISLAND_HAS_KEYBOARD: AtomicBool = AtomicBool::new(false);

/// The window that was in front when the island took the keyboard (0: none):
/// it gets the keyboard back when the island lets go of it.
static FRONT_BEFORE_ISLAND: AtomicIsize = AtomicIsize::new(0);

/// The island's extended style, from the one the windowing layer left. An
/// overlay, not an app: a tool window without WS_EX_APPWINDOW, so no taskbar
/// (Windows' own, or a replacement like Bloom) and no Alt+Tab lists it, and
/// WS_EX_NOACTIVATE, so a click on it never takes the keyboard from the app
/// being typed in — except while the island itself has the keyboard. Every
/// other bit (click-through among them) stays as it was.
fn overlay_ex_style(ex: isize, has_keyboard: bool) -> isize {
    let ex = (ex | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize);
    if has_keyboard {
        ex & !(WS_EX_NOACTIVATE.0 as isize)
    } else {
        ex | WS_EX_NOACTIVATE.0 as isize
    }
}

/// Whether the overlay window labelled `label` may be activated: only the
/// island, and only while it has the keyboard. Liv's desktop window never is,
/// whatever the island is doing.
fn overlay_has_keyboard(label: &str, island_has_keyboard: bool) -> bool {
    label == crate::island::WINDOW_LABEL && island_has_keyboard
}

/// Puts an overlay window's extended style the way `overlay_ex_style` wants it.
fn apply_overlay_style(win: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else { return };
    let has_keyboard = overlay_has_keyboard(win.label(), ISLAND_HAS_KEYBOARD.load(Ordering::Relaxed));
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = overlay_ex_style(ex, has_keyboard);
        if want != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
        }
    }
}

/// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the
/// window out of Alt-Tab. For the island and for Liv's desktop window.
pub fn make_non_activating(win: &WebviewWindow) {
    apply_overlay_style(win);
}

/// The island takes the keyboard, so a text field inside it can be typed in,
/// or gives it back. Taking it, the window in front is remembered (the caller
/// focuses the island right after); giving it back, that window is put in
/// front again, as long as the island still is the one in front.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Some(hwnd) = hwnd_of(win) else { return };
    let island = hwnd.0 as isize;
    let front = unsafe { GetForegroundWindow() }.0 as isize;
    ISLAND_HAS_KEYBOARD.store(activating, Ordering::Relaxed);
    apply_overlay_style(win);
    if activating {
        let remembered = FRONT_BEFORE_ISLAND.load(Ordering::Relaxed);
        FRONT_BEFORE_ISLAND.store(front_to_remember(island, front, remembered), Ordering::Relaxed);
        return;
    }
    let remembered = FRONT_BEFORE_ISLAND.swap(0, Ordering::Relaxed);
    let previous = HWND(remembered as *mut _);
    let still_there = remembered != 0
        && unsafe { IsWindow(Some(previous)).as_bool() && IsWindowVisible(previous).as_bool() && !IsIconic(previous).as_bool() };
    if let Some(back) = front_to_restore(island, front, remembered, still_there) {
        let _ = unsafe { SetForegroundWindow(HWND(back as *mut _)) };
    }
}

/// The window to give the keyboard back to, as the island takes it: the one in
/// front now. When that is the island already (it took the keyboard earlier
/// and still has it), the one remembered then stays.
fn front_to_remember(island: isize, front: isize, remembered: isize) -> isize {
    if front == island {
        remembered
    } else {
        front
    }
}

/// The window put in front again as the island gives the keyboard back, if
/// any: only while the island still is the window in front (the user has not
/// gone elsewhere meanwhile), and only a window that is still there to take it.
fn front_to_restore(island: isize, front: isize, remembered: isize, still_there: bool) -> Option<isize> {
    (front == island && remembered != 0 && remembered != island && still_there).then_some(remembered)
}

/// Click-through on or off. The windowing layer rebuilds the extended style
/// from its own flags when it does this, dropping the overlay bits and
/// WS_EX_NOACTIVATE, so they are put back right after, queued on the UI thread
/// behind that change (the cursor polls call this from their own threads).
pub fn set_click_through(win: &WebviewWindow, ignore: bool) {
    let _ = win.set_ignore_cursor_events(ignore);
    let w = win.clone();
    let _ = win.run_on_main_thread(move || apply_overlay_style(&w));
}

#[cfg(test)]
mod overlay_tests {
    use super::*;
    use ::windows::Win32::UI::WindowsAndMessaging::{
        WS_EX_ACCEPTFILES, WS_EX_LAYERED, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_EX_WINDOWEDGE,
    };

    const NOACTIVATE: isize = WS_EX_NOACTIVATE.0 as isize;
    const TOOLWINDOW: isize = WS_EX_TOOLWINDOW.0 as isize;
    const APPWINDOW: isize = WS_EX_APPWINDOW.0 as isize;
    /// What click-through is in the extended style.
    const CLICK_THROUGH: isize = (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize;

    /// The extended style as the windowing layer rebuilds it from its own
    /// flags: none of the overlay's bits, and no WS_EX_NOACTIVATE.
    fn rebuilt(click_through: bool) -> isize {
        let base = (WS_EX_WINDOWEDGE.0 | WS_EX_ACCEPTFILES.0 | WS_EX_TOPMOST.0) as isize | APPWINDOW;
        if click_through { base | CLICK_THROUGH } else { base }
    }

    #[test]
    fn the_island_never_activates_unless_it_has_the_keyboard() {
        for click_through in [false, true] {
            for has_keyboard in [false, true] {
                let what = format!("click-through {click_through}, keyboard {has_keyboard}");
                let ex = overlay_ex_style(rebuilt(click_through), has_keyboard);
                assert_eq!(ex & NOACTIVATE != 0, !has_keyboard, "{what}");
                // Still an overlay: out of the taskbar and of Alt+Tab.
                assert_eq!(ex & TOOLWINDOW, TOOLWINDOW, "{what}");
                assert_eq!(ex & APPWINDOW, 0, "{what}");
                // Click-through and the rest are the windowing layer's to say.
                assert_eq!(ex & CLICK_THROUGH != 0, click_through, "{what}");
                let untouched = !(NOACTIVATE | TOOLWINDOW | APPWINDOW);
                assert_eq!(ex & untouched, rebuilt(click_through) & untouched, "{what}");
                // Applied twice, nothing more changes.
                assert_eq!(overlay_ex_style(ex, has_keyboard), ex, "{what}");
            }
        }
    }

    #[test]
    fn livs_desktop_window_never_activates_even_while_the_island_has_the_keyboard() {
        assert!(overlay_has_keyboard("island", true));
        assert!(!overlay_has_keyboard("island", false));
        for island_has_keyboard in [false, true] {
            assert!(!overlay_has_keyboard("pet", island_has_keyboard));
            for click_through in [false, true] {
                let ex = overlay_ex_style(rebuilt(click_through), overlay_has_keyboard("pet", island_has_keyboard));
                assert_eq!(ex & NOACTIVATE, NOACTIVATE);
                assert_eq!(ex & TOOLWINDOW, TOOLWINDOW);
                assert_eq!(ex & APPWINDOW, 0);
            }
        }
    }

    #[test]
    fn giving_the_keyboard_back_makes_the_island_non_activating_again() {
        for click_through in [false, true] {
            let typing = overlay_ex_style(rebuilt(click_through), true);
            assert_eq!(typing & NOACTIVATE, 0);
            assert_eq!(overlay_ex_style(typing, false) & NOACTIVATE, NOACTIVATE);
        }
    }

    const ISLAND: isize = 0x1000;
    const EDITOR: isize = 0x2000;
    const BROWSER: isize = 0x3000;

    #[test]
    fn the_window_in_front_is_remembered_as_the_island_takes_the_keyboard() {
        assert_eq!(front_to_remember(ISLAND, EDITOR, 0), EDITOR);
        // A later one replaces it.
        assert_eq!(front_to_remember(ISLAND, BROWSER, EDITOR), BROWSER);
        // Asked again while the island already has the keyboard: the one from before stays.
        assert_eq!(front_to_remember(ISLAND, ISLAND, EDITOR), EDITOR);
        // No window in front: nothing to give the keyboard back to.
        assert_eq!(front_to_remember(ISLAND, 0, EDITOR), 0);
    }

    #[test]
    fn the_keyboard_goes_back_only_while_the_island_still_is_in_front() {
        assert_eq!(front_to_restore(ISLAND, ISLAND, EDITOR, true), Some(EDITOR));
        // The user already clicked elsewhere: nobody fights that.
        assert_eq!(front_to_restore(ISLAND, BROWSER, EDITOR, true), None);
        assert_eq!(front_to_restore(ISLAND, EDITOR, EDITOR, true), None);
        assert_eq!(front_to_restore(ISLAND, 0, EDITOR, true), None);
        // Closed, hidden or minimized meanwhile.
        assert_eq!(front_to_restore(ISLAND, ISLAND, EDITOR, false), None);
        // Nothing was remembered, or only the island itself.
        assert_eq!(front_to_restore(ISLAND, ISLAND, 0, true), None);
        assert_eq!(front_to_restore(ISLAND, ISLAND, ISLAND, true), None);
    }
}

/// Click-through here is the poll's WS_EX_TRANSPARENT toggle, not a region.
pub fn set_input_region(_win: &WebviewWindow, _rect: Option<(f64, f64, f64, f64)>) {}

/// The cursor poll already parks itself with the island (island.rs): nothing to do.
pub fn set_pointer_watch(_active: bool) {}

/// `set_position` already places a Win32 window on the right display.
pub fn pin_to_monitor(_win: &WebviewWindow, _x: i32, _y: i32) {}

/// WebView2 counts its zoom in `devicePixelRatio`, as Edge does: the island's
/// size (scale.rs) is part of the ratio the page reports to `fit_zoom`.
pub const ZOOM_IN_PIXEL_RATIO: bool = true;

// ── Another app in full screen (fullscreen.rs) ────────────────────────────────

/// Whether the window in front is full screen on the display that holds the
/// physical point `anchor` (where the island sits). A handful of calls that
/// read what the system already knows; fullscreen.rs decides. None when no
/// window is in front at this instant (one is being activated): there is
/// nothing to judge by, and the next look will have one.
pub fn fullscreen_in_front(anchor: (i32, i32)) -> Option<bool> {
    let window = foreground()?;
    Some(display_at(anchor).is_some_and(|display| fullscreen::is_fullscreen(&window, display)))
}

fn foreground() -> Option<Foreground> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).ok()?;
        let mut name = [0u16; 64];
        let len = GetClassNameW(hwnd, &mut name).max(0) as usize;
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
        // Not cloaked when the system can't say.
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            (&mut cloaked as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );
        Some(Foreground {
            rect: (rect.left, rect.top, rect.right, rect.bottom),
            class: String::from_utf16_lossy(&name[..len]),
            style: GetWindowLongPtrW(hwnd, GWL_STYLE) as u32,
            zoomed: IsZoomed(hwnd).as_bool(),
            same_process: pid == GetCurrentProcessId(),
            visible: IsWindowVisible(hwnd).as_bool(),
            cloaked: cloaked != 0,
        })
    }
}

/// The whole rect (taskbar included) of the display at, or nearest to, a point.
fn display_at((x, y): (i32, i32)) -> Option<Rect> {
    unsafe {
        let monitor = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let r = info.rcMonitor;
        Some((r.left, r.top, r.right, r.bottom))
    }
}

// ── Session windows ("Open terminal") ─────────────────────────────────────────
//
// See session_window.rs: the relay's ancestors lead to the terminal or editor
// window a Claude Code session runs in.

/// The process on the other end of a relay connection.
pub fn pipe_client_pid(handle: RawHandle) -> Option<u32> {
    let mut pid = 0u32;
    unsafe { GetNamedPipeClientProcessId(HANDLE(handle), &mut pid).ok()? };
    (pid != 0).then_some(pid)
}

/// Every process, by ID: its parent and its executable's name.
fn process_table() -> HashMap<u32, Proc> {
    let mut out = HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            out.insert(
                entry.th32ProcessID,
                Proc {
                    parent: entry.th32ParentProcessID,
                    exe: String::from_utf16_lossy(&entry.szExeFile[..len]),
                },
            );
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    out
}

/// The ancestors of a process, nearest first, below the desktop shell.
pub fn process_ancestors(pid: u32) -> Vec<u32> {
    session_window::ancestors(&process_table(), pid)
}

/// Visible top-level windows that are nobody's dialog and have a title:
/// (handle, process ID, title).
fn top_windows() -> Vec<(isize, u32, String)> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = unsafe { &mut *(lparam.0 as *mut Vec<(isize, u32, String)>) };
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || GetWindow(hwnd, GW_OWNER).is_ok() {
                return true.into();
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
            let mut text = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut text);
            if len > 0 {
                list.push((hwnd.0 as isize, pid, String::from_utf16_lossy(&text[..len as usize])));
            }
        }
        true.into()
    }
    let mut list: Vec<(isize, u32, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut list as *mut _ as isize));
    }
    list
}

/// The first of `pids` that owns a window.
pub fn first_with_window(pids: &[u32]) -> Option<u32> {
    let windows = top_windows();
    pids.iter().copied().find(|pid| windows.iter().any(|(_, owner, _)| owner == pid))
}

/// What a session remembers: the ancestor that owns a window, or nothing.
pub fn window_owners(ancestors: &[u32]) -> Vec<u32> {
    first_with_window(ancestors).into_iter().collect()
}

fn bring_forward(raw: isize) -> bool {
    let hwnd = HWND(raw as *mut _);
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return false;
        }
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        } else {
            let _ = ShowWindow(hwnd, SW_SHOW);
        }

        // The island window has WS_EX_NOACTIVATE, so clicks on it do not make Liv
        // the active foreground window. Windows blocks SetForegroundWindow unless the
        // calling thread is attached to the foreground thread or owns foreground rights.
        let fg_hwnd = GetForegroundWindow();
        if fg_hwnd == hwnd {
            return true;
        }

        let cur_thread = GetCurrentThreadId();
        let fg_thread = if fg_hwnd.0.is_null() {
            0
        } else {
            GetWindowThreadProcessId(fg_hwnd, None)
        };
        let target_thread = GetWindowThreadProcessId(hwnd, None);

        let attached_fg = if fg_thread != 0 && fg_thread != cur_thread {
            AttachThreadInput(cur_thread, fg_thread, true).as_bool()
        } else {
            false
        };

        let attached_target = if target_thread != 0 && target_thread != cur_thread && target_thread != fg_thread {
            AttachThreadInput(cur_thread, target_thread, true).as_bool()
        } else {
            false
        };

        let _ = BringWindowToTop(hwnd);
        let ok = SetForegroundWindow(hwnd).as_bool();

        if attached_target {
            let _ = AttachThreadInput(cur_thread, target_thread, false);
        }
        if attached_fg {
            let _ = AttachThreadInput(cur_thread, fg_thread, false);
        }

        ok || GetForegroundWindow() == hwnd
    }
}

/// Brings `pid`'s window forward — the one titled after `folder` if there are several.
pub fn focus_process_window(pid: u32, folder: &str) -> bool {
    let candidates: Vec<(isize, String)> = top_windows()
        .into_iter()
        .filter(|(_, owner, _)| *owner == pid)
        .map(|(hwnd, _, title)| (hwnd, title))
        .collect();
    session_window::pick_window(&candidates, folder).is_some_and(|hwnd| bring_forward(*hwnd))
}

/// Brings forward the window a session remembered (`window_owners`).
pub fn focus_session_window(owners: &[u32], folder: &str) -> bool {
    owners.first().is_some_and(|pid| focus_process_window(*pid, folder))
}

/// Brings forward the window of a running app, by executable name.
fn focus_app(exe: &str) -> bool {
    let pids: Vec<u32> = process_table()
        .into_iter()
        .filter(|(_, p)| p.exe.eq_ignore_ascii_case(exe))
        .map(|(pid, _)| pid)
        .collect();
    top_windows()
        .into_iter()
        .find(|(_, owner, _)| pids.contains(owner))
        .is_some_and(|(hwnd, _, _)| bring_forward(hwnd))
}

/// The Claude desktop app: brought forward when it runs (Claude Code's own
/// `claude.exe` has no window of its own, so it is never the one picked),
/// started from the Squirrel path or its registered MSIX protocol otherwise.
pub fn open_claude_desktop() -> bool {
    open_claude_with(
        || focus_app("claude.exe"),
        || {
            std::env::var_os("LOCALAPPDATA").is_some_and(|base| {
                let exe = PathBuf::from(base).join("AnthropicClaude").join("claude.exe");
                exe.is_file() && Command::new(exe).spawn().is_ok()
            })
        },
        activate_claude_protocol,
    )
}

fn open_claude_with(
    focus: impl FnOnce() -> bool,
    squirrel: impl FnOnce() -> bool,
    protocol: impl FnOnce() -> bool,
) -> bool {
    focus() || squirrel() || protocol()
}

/// The MSIX manifest registers `claude`; let Windows resolve its current install.
fn activate_claude_protocol() -> bool {
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        // A Tauri thread may already use MTA. Keep that apartment: the Shell can
        // delegate activation, and we must not uninitialize someone else's COM.
        if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
            return false;
        }
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC,
            lpVerb: w!("open"),
            lpFile: w!("claude://"),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        let opened = ShellExecuteExW(&mut info).is_ok();
        if initialized.is_ok() {
            CoUninitialize();
        }
        opened
    }
}

// ── New Claude Code session (launch.rs) ───────────────────────────────────────

/// Windows Terminal's `wt.exe`, when it is installed: on %PATH%, or as the
/// app execution alias the Store package puts in WindowsApps (a reparse point,
/// so it is looked at without being followed).
pub fn windows_terminal() -> Option<PathBuf> {
    find_on_path("wt").or_else(|| {
        let alias = PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
            .join("Microsoft")
            .join("WindowsApps")
            .join("wt.exe");
        std::fs::symlink_metadata(&alias).is_ok().then_some(alias)
    })
}

/// "Choose a folder…": the system's folder picker (IFileOpenDialog with
/// FOS_PICKFOLDERS), over the island, `start` open in it. Runs on a thread of
/// its own, in a single-threaded apartment as the Shell's dialogs want.
pub fn pick_folder(app: &AppHandle, start: Option<&str>, title: &str) -> Option<String> {
    use ::windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER};
    use ::windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName, FOS_FORCEFILESYSTEM,
        FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
    };

    let owner = app
        .get_webview_window(crate::island::WINDOW_LABEL)
        .and_then(|w| hwnd_of(&w))
        .map(|h| h.0 as isize);
    let start = start.map(HSTRING::from);
    let title = HSTRING::from(title);
    std::thread::spawn(move || unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
            return None;
        }
        let picked = (|| -> Option<String> {
            let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
            let options = dialog.GetOptions().ok()?;
            dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM).ok()?;
            let _ = dialog.SetTitle(&title);
            if let Some(start) = &start {
                if let Ok(folder) = SHCreateItemFromParsingName::<_, _, IShellItem>(start, None) {
                    let _ = dialog.SetFolder(&folder);
                }
            }
            // Cancelled: an error, and nothing picked.
            dialog.Show(owner.map(|raw| HWND(raw as *mut _))).ok()?;
            let item = dialog.GetResult().ok()?;
            let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
            let path = name.to_string().ok();
            CoTaskMemFree(Some(name.0 as *const _));
            path
        })();
        if initialized.is_ok() {
            CoUninitialize();
        }
        picked
    })
    .join()
    .ok()
    .flatten()
}

#[cfg(test)]
mod claude_launch_tests {
    use super::open_claude_with;
    use std::cell::RefCell;

    #[test]
    fn tries_launchers_in_order_and_stops_after_success() {
        for (focus, squirrel, protocol, expected, calls) in [
            (true, true, true, true, vec!["focus"]),
            (false, true, true, true, vec!["focus", "squirrel"]),
            (false, false, true, true, vec!["focus", "squirrel", "protocol"]),
            (false, false, false, false, vec!["focus", "squirrel", "protocol"]),
        ] {
            let seen = RefCell::new(Vec::new());
            let result = open_claude_with(
                || {
                    seen.borrow_mut().push("focus");
                    focus
                },
                || {
                    seen.borrow_mut().push("squirrel");
                    squirrel
                },
                || {
                    seen.borrow_mut().push("protocol");
                    protocol
                },
            );
            assert_eq!(result, expected);
            assert_eq!(seen.into_inner(), calls);
        }
    }
}

// ── Global shortcuts ──────────────────────────────────────────────────────────

/// RegisterHotKey works in every Windows session.
pub fn global_shortcuts_blocked() -> Option<&'static str> {
    None
}

/// The character Ctrl+Alt(+Shift)+`vk` types on one of the installed keyboard
/// layouts, if any. Windows reads Ctrl+Alt as AltGr, so registering such a
/// combination as a global shortcut would stop the user typing that character
/// (AltGr+E is € on most European layouts, AltGr+A is ą in Polish).
pub fn ctrl_alt_types(vk: u16, shift: bool) -> Option<String> {
    let mut layouts = [HKL::default(); 32];
    let count = unsafe { GetKeyboardLayoutList(Some(&mut layouts[..])) };
    let count = usize::try_from(count).unwrap_or(0).min(layouts.len());

    let mut state = [0u8; 256];
    state[VK_CONTROL.0 as usize] = 0x80;
    state[VK_MENU.0 as usize] = 0x80;
    if shift {
        state[VK_SHIFT.0 as usize] = 0x80;
    }
    for &layout in &layouts[..count] {
        let scan = unsafe { MapVirtualKeyExW(u32::from(vk), MAPVK_VK_TO_VSC, Some(layout)) };
        let mut buf = [0u16; 8];
        // Flag 0x4: leave the keyboard state alone, so a dead key met here
        // doesn't change what the user types next (Windows 10 1607 and later).
        let n = unsafe { ToUnicodeEx(u32::from(vk), scan, &state, &mut buf, 0x4, Some(layout)) };
        let typed = match n {
            // A dead key (´ ^ ¨…) is still something the user types with it.
            n if n < 0 => String::from_utf16_lossy(&buf[..1]),
            0 => continue,
            n => String::from_utf16_lossy(&buf[..(n as usize).min(buf.len())]),
        };
        if typed.chars().any(|c| !c.is_control()) {
            return Some(typed);
        }
    }
    None
}

#[cfg(test)]
mod path_tests {
    use super::*;

    fn env(name: &str) -> Option<String> {
        match name.to_ascii_uppercase().as_str() {
            "LOCALAPPDATA" => Some(r"C:\Users\ana\AppData\Local".into()),
            "SYSTEMROOT" => Some(r"C:\Windows".into()),
            _ => None,
        }
    }

    #[test]
    fn the_variables_of_a_path_are_filled_in() {
        assert_eq!(expand_variables(r"%LOCALAPPDATA%\agy\bin", &env), r"C:\Users\ana\AppData\Local\agy\bin");
        assert_eq!(expand_variables(r"%SystemRoot%\system32;%SystemRoot%", &env), r"C:\Windows\system32;C:\Windows");
        // One Windows does not know stays as written; so does a lone percent sign.
        assert_eq!(expand_variables(r"%NOPE%\bin", &env), r"%NOPE%\bin");
        assert_eq!(expand_variables(r"C:\100%\bin", &env), r"C:\100%\bin");
        assert_eq!(expand_variables("%%", &env), "%%");
        assert_eq!(expand_variables("", &env), "");
    }

    #[test]
    fn a_path_value_gives_its_whole_folders_in_order() {
        let value = r#"%LOCALAPPDATA%\Programs\OpenAI\Codex\bin; "C:\Program Files\nodejs" ;;relative\bin;%NOPE%\x;C:\tools"#;
        assert_eq!(
            path_value_dirs(value, env),
            [
                PathBuf::from(r"C:\Users\ana\AppData\Local\Programs\OpenAI\Codex\bin"),
                PathBuf::from(r"C:\Program Files\nodejs"),
                PathBuf::from(r"C:\tools"),
            ]
        );
        assert!(path_value_dirs("", env).is_empty());
    }

    #[test]
    fn a_tool_is_found_in_the_first_folder_that_has_it() {
        let root = std::env::temp_dir().join(format!("liv-path-{}", std::process::id()));
        let (first, second) = (root.join("first"), root.join("second"));
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(second.join("agy.exe"), b"").unwrap();
        std::fs::write(second.join("codex.cmd"), b"").unwrap();
        std::fs::write(first.join("codex.exe"), b"").unwrap();
        let dirs = [root.join("missing"), first.clone(), second.clone()];
        let exts = ".COM;.EXE;.BAT;.CMD";
        // A folder added after the others still counts: that is the one the registry gives.
        assert_eq!(search_dirs(&dirs, exts, "agy"), Some(second.join("agy.exe")));
        assert_eq!(search_dirs(&dirs, exts, "codex"), Some(first.join("codex.exe")));
        assert_eq!(search_dirs(&dirs[..2], exts, "agy"), None);
        assert_eq!(search_dirs(&dirs, exts, "gemini"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_registry_gives_the_path_windows_has_now() {
        // This machine has a Path, with the system folder in it.
        let dirs = path_dirs_now();
        assert!(!dirs.is_empty());
        assert!(dirs.iter().all(|dir| dir.is_absolute()));
        assert!(dirs.iter().any(|dir| dir.join("cmd.exe").is_file()), "{dirs:?}");
    }
}
