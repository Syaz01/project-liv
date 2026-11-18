// The words go where you type: onto the clipboard (kept out of the clipboard
// history), Ctrl+V in the app in front, and the clipboard gets back what it
// held 700 ms later — unless something else was copied meanwhile.

#[cfg(windows)]
#[path = "os_windows.rs"]
mod os;
#[cfg(target_os = "linux")]
#[path = "os_linux.rs"]
mod os;
#[cfg(target_os = "linux")]
mod wayland;

use std::sync::Mutex;
use std::time::Duration;

use arboard::Clipboard;

/// One clipboard for the app's whole life: on X11 the text stays served only
/// while its owner lives.
static CLIPBOARD: Mutex<Option<Clipboard>> = Mutex::new(None);

fn with_clipboard<T>(f: impl FnOnce(&mut Clipboard) -> T) -> Option<T> {
    let mut slot = CLIPBOARD.lock().unwrap();
    if slot.is_none() {
        *slot = Clipboard::new().ok();
    }
    slot.as_mut().map(f)
}

fn set_text(clipboard: &mut Clipboard, text: &str) -> Result<(), arboard::Error> {
    #[cfg(windows)]
    {
        use arboard::SetExtWindows;
        clipboard.set().exclude_from_history().exclude_from_cloud().text(text.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        use arboard::SetExtLinux;
        clipboard.set().exclude_from_history().text(text.to_string())
    }
}

/// Ctrl+V in the app in front, for what is already on the clipboard: an entry
/// of the clipboard history put back there (clipboard.rs).
#[cfg(windows)]
pub fn send_ctrl_v() -> Result<(), String> {
    os::send_paste(false)
}

/// Copies `text` and leaves it there (it could not be pasted).
pub fn copy(text: &str) -> bool {
    with_clipboard(|c| set_text(c, text).is_ok()).unwrap_or(false)
}

/// What happened to the words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Pasted,
    /// On the clipboard only: the keystroke could not be sent.
    Copied,
    Failed,
}

/// Pastes `text` in the app in front. `shift` sends Ctrl+Shift+V (terminals).
pub fn paste(text: &str, shift: bool) -> Outcome {
    let previous = with_clipboard(|c| c.get_text().ok()).flatten();
    if with_clipboard(|c| set_text(c, text)).map(|r| r.is_ok()) != Some(true) {
        return Outcome::Failed;
    }
    // Give the clipboard a moment to be announced before the app reads it.
    std::thread::sleep(Duration::from_millis(40));
    if let Err(err) = os::send_paste(shift) {
        crate::log::line(format!("paste: keystroke failed: {err}"));
        return Outcome::Copied;
    }
    let ours = text.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(700));
        let Some(previous) = previous else { return };
        with_clipboard(|c| {
            // Something else was copied meanwhile: leave it.
            // Put back the way ours went: what was there may have been a
            // copy no history may keep, and the clipboard history
            // (clipboard.rs) would take a plain copy of it for a new one.
            if c.get_text().ok().as_deref() == Some(ours.as_str()) {
                let _ = set_text(c, &previous);
            }
        });
    });
    Outcome::Pasted
}
