// Clipboard history, for the island's Tools view: what was copied, newest
// first, and a click that pastes one of them where the user is typing.
//
// It lives in memory only. Nothing that was copied is ever written to disk or
// to the log, and it is gone when Liv exits or the setting is turned off.
//
// Windows: a thread with a message-only window is told by the system each time
// the clipboard changes (AddClipboardFormatListener). It sleeps in GetMessage
// between two copies: no timer, nothing polled. A copy that its owner marks as
// private — what password managers do — is never read. Text and images are
// kept; files copied in Explorer are not.
//
// Elsewhere the module is inert: the history stays empty.

// Off Windows nothing listens, so what the listener calls has no caller.
#![cfg_attr(not(windows), allow(dead_code))]

use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// The island's event: the whole list, on every change.
const EVENT: &str = "clipboard-history";

/// How many entries are kept, images included.
pub const MAX_ENTRIES: usize = 30;
/// How many of them may be images: each can hold megabytes.
pub const MAX_IMAGES: usize = 4;
/// A longer text is not kept.
pub const MAX_TEXT_CHARS: usize = 200_000;
/// A bigger image is not kept.
pub const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
/// How much of a text the page gets. The whole text never leaves Rust.
pub const PREVIEW_CHARS: usize = 300;
/// The box a thumbnail fits in, px.
pub const THUMB_MAX_W: u32 = 256;
pub const THUMB_MAX_H: u32 = 96;

// The standard clipboard formats this module knows by number.
pub(crate) const CF_DIB: u32 = 8;
const CF_UNICODETEXT: u32 = 13;
pub(crate) const CF_HDROP: u32 = 15;
const CF_DIBV5: u32 = 17;

/// What an app puts on the clipboard next to a copy that no clipboard monitor
/// may keep: the format Windows documents for it, and the older convention
/// password managers still set.
const EXCLUDE_FORMAT: &str = "ExcludeClipboardContentFromMonitorProcessing";
const VIEWER_IGNORE_FORMAT: &str = "Clipboard Viewer Ignore";
/// With a DWORD of 0: this copy stays out of any history. It is what arboard's
/// `exclude_from_history` sets, so what Liv itself pastes (paste/mod.rs) is
/// skipped by this rule.
const CAN_INCLUDE_FORMAT: &str = "CanIncludeInClipboardHistory";
/// Liv's own mark on an entry it put back on the clipboard: the history
/// already has it, so the listener leaves it alone.
const OWN_FORMAT: &str = "Liv Clipboard Entry";

// ── What is kept ──────────────────────────────────────────────────────────────

/// One thing that was copied, as it goes back on the clipboard.
#[derive(Debug, Clone, PartialEq)]
pub enum Content {
    Text(String),
    Image(Image),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    /// CF_DIB or CF_DIBV5: the format the bytes were read as, and go back as.
    pub format: u32,
    /// The bitmap as the clipboard held it, header first.
    pub dib: Arc<[u8]>,
    pub width: u32,
    pub height: u32,
    /// A small PNG of it as a data URL, for the row in the island.
    pub thumb: String,
}

/// Whether `a` is `b` copied again. An image is told by its bytes alone.
fn same(a: &Content, b: &Content) -> bool {
    match (a, b) {
        (Content::Text(a), Content::Text(b)) => a == b,
        (Content::Image(a), Content::Image(b)) => a.format == b.format && a.dib == b.dib,
        _ => false,
    }
}

#[derive(Debug, Clone)]
struct Item {
    id: u64,
    /// When it was copied, or put back, last: Unix ms.
    at: u64,
    content: Content,
}

/// What the page gets for one entry. Never the whole text, never the image.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: u64,
    /// "text" or "image".
    pub kind: &'static str,
    /// Text: its first `PREVIEW_CHARS` characters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// Text: how many characters the whole of it has.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chars: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Image: a PNG data URL no taller than `THUMB_MAX_H`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
    pub at: u64,
}

/// The history itself: newest first, each entry with an id that is never used twice.
#[derive(Debug, Default)]
pub struct History {
    items: Vec<Item>,
    last_id: u64,
}

impl History {
    /// Something was copied at `at`. Copied again, an entry moves to the top
    /// instead of appearing twice. Returns the entry's id.
    pub fn push(&mut self, content: Content, at: u64) -> u64 {
        if let Some(index) = self.items.iter().position(|item| same(&item.content, &content)) {
            let mut item = self.items.remove(index);
            item.at = at;
            let id = item.id;
            self.items.insert(0, item);
            return id;
        }
        self.last_id += 1;
        let id = self.last_id;
        self.items.insert(0, Item { id, at, content });
        // The oldest images go first, then the oldest entries.
        let mut images = 0;
        self.items.retain(|item| {
            if !matches!(item.content, Content::Image(_)) {
                return true;
            }
            images += 1;
            images <= MAX_IMAGES
        });
        self.items.truncate(MAX_ENTRIES);
        id
    }

    /// The entry `id` is put back on the clipboard at `at`: it moves to the
    /// top. Its content, or `None` when it is no longer there.
    pub fn touch(&mut self, id: u64, at: u64) -> Option<Content> {
        let index = self.items.iter().position(|item| item.id == id)?;
        let mut item = self.items.remove(index);
        item.at = at;
        let content = item.content.clone();
        self.items.insert(0, item);
        Some(content)
    }

    /// True when there was such an entry.
    pub fn remove(&mut self, id: u64) -> bool {
        let before = self.items.len();
        self.items.retain(|item| item.id != id);
        self.items.len() != before
    }

    /// Forgets everything. Ids are not reused. True when there was anything.
    pub fn clear(&mut self) -> bool {
        let had = !self.items.is_empty();
        self.items.clear();
        had
    }

    /// The list as the page shows it.
    pub fn entries(&self) -> Vec<Entry> {
        self.items
            .iter()
            .map(|item| match &item.content {
                Content::Text(text) => Entry {
                    id: item.id,
                    kind: "text",
                    preview: Some(text.chars().take(PREVIEW_CHARS).collect()),
                    chars: Some(text.chars().count()),
                    width: None,
                    height: None,
                    thumb: None,
                    at: item.at,
                },
                Content::Image(image) => Entry {
                    id: item.id,
                    kind: "image",
                    preview: None,
                    chars: None,
                    width: Some(image.width),
                    height: Some(image.height),
                    thumb: Some(image.thumb.clone()),
                    at: item.at,
                },
            })
            .collect()
    }
}

// ── What is recorded ──────────────────────────────────────────────────────────

/// One format the clipboard offers right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipFormat {
    pub id: u32,
    /// The name of a registered format; empty for the standard ones.
    pub name: String,
    /// The DWORD it holds, read only for the formats whose value matters.
    pub value: Option<u32>,
}

/// What to read from the clipboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Take {
    /// Private, Liv's own, files, or nothing this history keeps.
    Nothing,
    Text,
    /// The bitmap, in this format (CF_DIB or CF_DIBV5).
    Image(u32),
}

/// Decides from the formats on the clipboard, in the order the clipboard lists
/// them, what is recorded. Nothing has been read from the clipboard yet when
/// this is asked, and nothing is when the answer is `Nothing`.
pub fn what_to_take(formats: &[ClipFormat]) -> Take {
    let named = |name: &str| formats.iter().find(|f| f.name.eq_ignore_ascii_case(name));
    if named(EXCLUDE_FORMAT).is_some() || named(VIEWER_IGNORE_FORMAT).is_some() || named(OWN_FORMAT).is_some() {
        return Take::Nothing;
    }
    // 0 keeps it out. So does a value that could not be read: whoever set the
    // format had something to say about this copy.
    if named(CAN_INCLUDE_FORMAT).is_some_and(|f| f.value.is_none_or(|v| v == 0)) {
        return Take::Nothing;
    }
    let has = |id: u32| formats.iter().any(|f| f.id == id);
    // Files copied in Explorer: not this history's.
    if has(CF_HDROP) {
        return Take::Nothing;
    }
    // A cell range or a paragraph comes with a picture of itself: the text is what was copied.
    if has(CF_UNICODETEXT) {
        return Take::Text;
    }
    // The first of the two is the one the app put there; the other is made from it.
    match formats.iter().find(|f| f.id == CF_DIB || f.id == CF_DIBV5) {
        Some(f) => Take::Image(f.id),
        None => Take::Nothing,
    }
}

/// Whether a copied text is kept: not empty, not blank, not too long.
pub fn keeps_text(text: &str) -> bool {
    !text.trim().is_empty() && text.chars().count() <= MAX_TEXT_CHARS
}

// ── Images ────────────────────────────────────────────────────────────────────

/// An image as 8-bit RGBA, top row first, alpha not premultiplied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

const BI_RGB: u32 = 0;
const BI_BITFIELDS: u32 = 3;
/// No screen is this wide: a header that says more is not believed.
const MAX_SIDE: u32 = 32_768;

/// One channel of a pixel, by its mask, as 0…255.
fn channel(pixel: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let max = u64::from(mask >> shift);
    (u64::from((pixel & mask) >> shift) * 255 / max) as u8
}

/// Reads a device-independent bitmap as the clipboard holds it (CF_DIB or
/// CF_DIBV5): the header, then the pixels. 24 and 32 bits per pixel,
/// uncompressed, rows bottom-up or top-down. `None` for anything else, or for
/// a bitmap whose bytes do not hold what its header says.
pub fn dib_to_rgba(dib: &[u8]) -> Option<Rgba> {
    let u16_at = |at: usize| Some(u16::from_le_bytes(dib.get(at..at + 2)?.try_into().ok()?));
    let u32_at = |at: usize| Some(u32::from_le_bytes(dib.get(at..at + 4)?.try_into().ok()?));

    let header = u32_at(0)? as usize;
    if header < 40 || header > dib.len() {
        return None;
    }
    let width = u32_at(4)? as i32;
    let rows = u32_at(8)? as i32;
    let bits = u16_at(14)?;
    let compression = u32_at(16)?;
    let colors = u32_at(32)? as usize;
    if width <= 0 || rows == 0 || rows == i32::MIN {
        return None;
    }
    let (width, height, top_down) = (width as u32, rows.unsigned_abs(), rows < 0);
    if width > MAX_SIDE || height > MAX_SIDE || colors > 256 {
        return None;
    }

    // Where each channel is in a 32-bit pixel. `None`: blue, green, red, alpha, a byte each.
    let masks = match (bits, compression) {
        (24, BI_RGB) | (32, BI_RGB) => None,
        (32, BI_BITFIELDS) => {
            // In the header from its 52nd byte on (V2 and later); right after a 40-byte one.
            let alpha = if header >= 56 { u32_at(52)? } else { 0 };
            Some([u32_at(40)?, u32_at(44)?, u32_at(48)?, alpha])
        }
        _ => return None,
    };
    let mut offset = header + colors * 4;
    if compression == BI_BITFIELDS && header == 40 {
        offset += 12;
    }
    let stride = (width as usize * usize::from(bits)).div_ceil(32) * 4;
    let needed = stride.checked_mul(height as usize)?;
    // The clipboard's own CF_DIBV5 repeats the three masks after the header.
    let repeated = offset.checked_add(12).and_then(|at| at.checked_add(needed));
    if compression == BI_BITFIELDS && header > 40 && repeated == Some(dib.len()) {
        offset += 12;
    }
    let data = dib.get(offset..offset.checked_add(needed)?)?;

    let step = usize::from(bits / 8);
    let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
    for y in 0..height as usize {
        let row = if top_down { y } else { height as usize - 1 - y };
        let line = &data[row * stride..row * stride + width as usize * step];
        for px in line.chunks_exact(step) {
            match (masks, step) {
                (_, 3) => pixels.extend_from_slice(&[px[2], px[1], px[0], 255]),
                (None, _) => pixels.extend_from_slice(&[px[2], px[1], px[0], px[3]]),
                (Some([r, g, b, a]), _) => {
                    let pixel = u32::from_le_bytes([px[0], px[1], px[2], px[3]]);
                    let alpha = if a == 0 { 255 } else { channel(pixel, a) };
                    pixels.extend_from_slice(&[channel(pixel, r), channel(pixel, g), channel(pixel, b), alpha]);
                }
            }
        }
    }
    // Most 32-bit bitmaps leave the fourth byte at zero and mean "opaque".
    if step == 4 && pixels.chunks_exact(4).all(|p| p[3] == 0) {
        for p in pixels.chunks_exact_mut(4) {
            p[3] = 255;
        }
    }
    Some(Rgba { width, height, pixels })
}

/// The size of the thumbnail of a `width` × `height` image: the same shape,
/// inside the thumbnail's box, never bigger than the image and never empty.
pub fn thumb_size(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (1, 1);
    }
    let scale = (f64::from(THUMB_MAX_W) / f64::from(width)).min(f64::from(THUMB_MAX_H) / f64::from(height)).min(1.0);
    let side = |v: u32| ((f64::from(v) * scale).round() as u32).clamp(1, v);
    (side(width), side(height))
}

/// `image` brought down to `width` × `height`: each pixel is the average of
/// the block of the image it stands for, weighted by how opaque each is.
pub fn scale_down(image: &Rgba, width: u32, height: u32) -> Rgba {
    let (width, height) = (width.clamp(1, image.width.max(1)), height.clamp(1, image.height.max(1)));
    if image.width == 0 || image.height == 0 || (width == image.width && height == image.height) {
        return image.clone();
    }
    let (src_w, src_h) = (image.width as usize, image.height as usize);
    let (w, h) = (width as usize, height as usize);
    let mut pixels = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        let (y0, y1) = (y * src_h / h, ((y + 1) * src_h / h).max(y * src_h / h + 1));
        for x in 0..w {
            let (x0, x1) = (x * src_w / w, ((x + 1) * src_w / w).max(x * src_w / w + 1));
            let (mut r, mut g, mut b, mut a) = (0u64, 0u64, 0u64, 0u64);
            for sy in y0..y1 {
                let line = &image.pixels[(sy * src_w + x0) * 4..(sy * src_w + x1) * 4];
                for p in line.chunks_exact(4) {
                    let alpha = u64::from(p[3]);
                    r += u64::from(p[0]) * alpha;
                    g += u64::from(p[1]) * alpha;
                    b += u64::from(p[2]) * alpha;
                    a += alpha;
                }
            }
            let count = ((y1 - y0) * (x1 - x0)) as u64;
            if a == 0 {
                pixels.extend_from_slice(&[0, 0, 0, 0]);
            } else {
                // Rounded to the nearest: a block of one colour keeps that colour.
                let mean = |sum: u64| ((sum + a / 2) / a) as u8;
                pixels.extend_from_slice(&[mean(r), mean(g), mean(b), ((a + count / 2) / count) as u8]);
            }
        }
    }
    Rgba { width, height, pixels }
}

/// `image` as a PNG file.
pub fn png_bytes(image: &Rgba) -> Option<Vec<u8>> {
    if image.pixels.len() != image.width as usize * image.height as usize * 4 {
        return None;
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&image.pixels).ok()?;
    }
    Some(out)
}

/// A copied bitmap, ready to be kept: its size and its thumbnail. `None` when
/// it is not a bitmap this history can show.
pub fn image_from_dib(format: u32, dib: Vec<u8>) -> Option<Image> {
    if dib.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let full = dib_to_rgba(&dib)?;
    let (width, height) = thumb_size(full.width, full.height);
    let png = png_bytes(&scale_down(&full, width, height))?;
    Some(Image {
        format,
        dib: Arc::from(dib),
        width: full.width,
        height: full.height,
        thumb: format!("data:image/png;base64,{}", crate::claude::base64_for(&png)),
    })
}

// ── The app's history ─────────────────────────────────────────────────────────

struct State {
    history: History,
    /// The setting is on.
    active: bool,
    /// Bumped on every start and stop: a listener from an older one quits.
    generation: u64,
    /// The listener's window, to tell it to stop; 0 while there is none.
    window: isize,
}

static STATE: LazyLock<Mutex<State>> =
    LazyLock::new(|| Mutex::new(State { history: History::default(), active: false, generation: 0, window: 0 }));

fn state() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit(app: &AppHandle, entries: Vec<Entry>) {
    let _ = app.emit_to(crate::island::WINDOW_LABEL, EVENT, entries);
}

/// Follows the "Clipboard history" setting: called at launch and after every
/// save. On, the listener starts; off, it ends and the history is forgotten.
pub fn sync(app: &AppHandle, on: bool) {
    let (generation, window) = {
        let mut s = state();
        if s.active == on {
            return;
        }
        s.active = on;
        s.generation += 1;
        s.history.clear();
        (s.generation, std::mem::take(&mut s.window))
    };
    #[cfg(windows)]
    {
        win::stop(window);
        if on {
            win::start(app.clone(), generation);
        }
    }
    #[cfg(not(windows))]
    let _ = (generation, window);
    // On or off, the page starts from an empty list.
    emit(app, Vec::new());
}

// ── Commands (the island's alone) ─────────────────────────────────────────────

/// The list as it is now: the page asks once as it starts.
#[tauri::command]
pub fn clipboard_history(window: tauri::WebviewWindow) -> Result<Vec<Entry>, String> {
    crate::from_island(&window)?;
    Ok(state().history.entries())
}

/// A click on an entry: it goes back on the clipboard and is pasted in the app
/// in front. "pasted"; "copied" when it could only be put on the clipboard;
/// "gone" when the entry is no longer there; "failed" when the clipboard
/// would not take it. An id, never a text: the page cannot make Liv type
/// anything that was not copied.
#[tauri::command]
pub async fn clipboard_paste(app: AppHandle, window: tauri::WebviewWindow, id: u64) -> Result<String, String> {
    crate::from_island(&window)?;
    let outcome = tauri::async_runtime::spawn_blocking(move || paste(&app, id)).await.unwrap_or("failed");
    Ok(outcome.to_string())
}

#[tauri::command]
pub fn clipboard_remove(app: AppHandle, window: tauri::WebviewWindow, id: u64) -> Result<(), String> {
    crate::from_island(&window)?;
    let entries = {
        let mut s = state();
        if !s.history.remove(id) {
            return Ok(());
        }
        s.history.entries()
    };
    emit(&app, entries);
    Ok(())
}

#[tauri::command]
pub fn clipboard_clear(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    crate::from_island(&window)?;
    let cleared = state().history.clear();
    if cleared {
        emit(&app, Vec::new());
    }
    Ok(())
}

#[cfg(windows)]
fn paste(app: &AppHandle, id: u64) -> &'static str {
    win::paste(app, id)
}

/// Puts `formats` on the clipboard, each with its bytes, as an ordinary copy:
/// a file of the shelf (shelf.rs), a screenshot (capture.rs). Without Liv's
/// mark, so a screenshot is listed in the history like any image copied.
/// False when the clipboard would not take the first of them.
#[cfg(windows)]
pub(crate) fn put(formats: &[(u32, &[u8])]) -> bool {
    win::put(formats)
}

/// Nothing is ever recorded here, so there is nothing to paste.
#[cfg(not(windows))]
fn paste(_app: &AppHandle, _id: u64) -> &'static str {
    "gone"
}

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    use windows::core::{w, HSTRING};
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, WPARAM};
    use windows::Win32::System::DataExchange::{
        AddClipboardFormatListener, CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
        GetClipboardFormatNameW, OpenClipboard, RegisterClipboardFormatW, RemoveClipboardFormatListener,
        SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, GetForegroundWindow, GetMessageW,
        GetWindowThreadProcessId, PostMessageW, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP,
        WM_CLIPBOARDUPDATE,
    };

    /// Posted to the listener's window: the setting was turned off.
    const WM_STOP: u32 = WM_APP + 1;
    /// Registered formats start here; below are the standard ones, which have no name.
    const FIRST_REGISTERED: u32 = 0xC000;
    /// Another app may still hold the clipboard just after it changed.
    const OPEN_TRIES: u32 = 8;
    const OPEN_WAIT: Duration = Duration::from_millis(15);

    // ── The listener ──────────────────────────────────────────────────────────

    pub fn start(app: AppHandle, generation: u64) {
        let spawned = std::thread::Builder::new()
            .name("liv-clipboard".into())
            .spawn(move || listen(app, generation));
        if let Err(err) = spawned {
            crate::log::line(format!("clipboard: no listener thread: {err}"));
        }
    }

    /// Tells the listener that owns `window` to end.
    pub fn stop(window: isize) {
        if window != 0 {
            let _ = unsafe { PostMessageW(Some(HWND(window as *mut _)), WM_STOP, WPARAM(0), LPARAM(0)) };
        }
    }

    /// Waits for the clipboard to change and records what was copied.
    fn listen(app: AppHandle, generation: u64) {
        run(generation, |hwnd| on_update(&app, generation, hwnd));
    }

    /// The listener's life: `changed` is called each time the clipboard
    /// changes, until `stop`. Nothing runs between two changes: the thread
    /// sleeps in GetMessage.
    fn run(generation: u64, mut changed: impl FnMut(HWND)) {
        // A message-only window of a class the system already has: all it does
        // is receive what is posted to it, which the loop below reads.
        let created = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("liv-clipboard"),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
        };
        let hwnd = match created {
            Ok(hwnd) => hwnd,
            Err(err) => {
                crate::log::line(format!("clipboard: listener failed, no window: {err}"));
                return;
            }
        };
        if let Err(err) = unsafe { AddClipboardFormatListener(hwnd) } {
            crate::log::line(format!("clipboard: listener failed: {err}"));
            let _ = unsafe { DestroyWindow(hwnd) };
            return;
        }
        // Under the lock: a stop that came first found no window to tell, and
        // this thread sees here that it was overtaken.
        let current = {
            let mut s = state();
            let current = s.active && s.generation == generation;
            if current {
                s.window = hwnd.0 as isize;
            }
            current
        };
        if current {
            crate::log::line("clipboard: listener started");
            let mut msg = MSG::default();
            while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
                match msg.message {
                    WM_CLIPBOARDUPDATE => changed(hwnd),
                    WM_STOP if msg.hwnd == hwnd => break,
                    _ => {
                        unsafe { DispatchMessageW(&msg) };
                    }
                }
            }
        }
        unsafe {
            let _ = RemoveClipboardFormatListener(hwnd);
            let _ = DestroyWindow(hwnd);
        }
        crate::log::line("clipboard: listener stopped");
    }

    /// The clipboard changed: what was copied joins the history, if it may.
    fn on_update(app: &AppHandle, generation: u64, hwnd: HWND) {
        let content = match read(hwnd) {
            Some(Raw::Text(text)) if keeps_text(&text) => Content::Text(text),
            Some(Raw::Image { format, dib }) => match image_from_dib(format, dib) {
                Some(image) => Content::Image(image),
                None => return,
            },
            _ => return,
        };
        let entries = {
            let mut s = state();
            if !(s.active && s.generation == generation) {
                return;
            }
            s.history.push(content, now_ms());
            s.history.entries()
        };
        emit(app, entries);
    }

    // ── The clipboard ─────────────────────────────────────────────────────────

    /// The clipboard, open; closed again when this is dropped.
    struct Open;

    impl Open {
        fn new(owner: Option<HWND>) -> Option<Open> {
            for attempt in 0..OPEN_TRIES {
                if unsafe { OpenClipboard(owner) }.is_ok() {
                    return Some(Open);
                }
                if attempt + 1 < OPEN_TRIES {
                    std::thread::sleep(OPEN_WAIT);
                }
            }
            None
        }
    }

    impl Drop for Open {
        fn drop(&mut self) {
            let _ = unsafe { CloseClipboard() };
        }
    }

    enum Raw {
        Text(String),
        Image { format: u32, dib: Vec<u8> },
    }

    /// Reads what `what_to_take` allows, and nothing else.
    fn read(hwnd: HWND) -> Option<Raw> {
        let _open = Open::new(Some(hwnd))?;
        match what_to_take(&formats()) {
            Take::Nothing => None,
            Take::Text => {
                // Two UTF-16 units a character at most, and the closing zero;
                // a block is a little bigger than what was asked for.
                let bytes = data(CF_UNICODETEXT, MAX_TEXT_CHARS * 4 + 64)?;
                let units: Vec<u16> = bytes
                    .chunks_exact(2)
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                    .take_while(|unit| *unit != 0)
                    .collect();
                Some(Raw::Text(String::from_utf16_lossy(&units)))
            }
            Take::Image(format) => Some(Raw::Image { format, dib: data(format, MAX_IMAGE_BYTES)? }),
        }
    }

    /// The formats on the open clipboard, in its order.
    fn formats() -> Vec<ClipFormat> {
        let mut formats = Vec::new();
        let mut id = 0;
        while formats.len() < 256 {
            id = unsafe { EnumClipboardFormats(id) };
            if id == 0 {
                break;
            }
            let name = if id >= FIRST_REGISTERED {
                let mut buffer = [0u16; 128];
                let len = unsafe { GetClipboardFormatNameW(id, &mut buffer) }.max(0) as usize;
                String::from_utf16_lossy(&buffer[..len.min(buffer.len())])
            } else {
                String::new()
            };
            let value = if name.eq_ignore_ascii_case(CAN_INCLUDE_FORMAT) {
                data(id, 64).and_then(|bytes| Some(u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?)))
            } else {
                None
            };
            formats.push(ClipFormat { id, name, value });
        }
        formats
    }

    /// The bytes the open clipboard holds in `format`, when there are no more than `max` of them.
    fn data(format: u32, max: usize) -> Option<Vec<u8>> {
        unsafe {
            let handle = GetClipboardData(format).ok()?;
            let memory = HGLOBAL(handle.0);
            let size = GlobalSize(memory);
            if size == 0 || size > max {
                return None;
            }
            let pointer = GlobalLock(memory) as *const u8;
            if pointer.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(pointer, size).to_vec();
            let _ = GlobalUnlock(memory);
            Some(bytes)
        }
    }

    /// Hands `bytes` to the open clipboard as `format`.
    fn set(format: u32, bytes: &[u8]) -> bool {
        unsafe {
            let Ok(memory) = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)) else { return false };
            let pointer = GlobalLock(memory) as *mut u8;
            if pointer.is_null() {
                let _ = GlobalFree(Some(memory));
                return false;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, bytes.len());
            let _ = GlobalUnlock(memory);
            // Once taken, the memory is the clipboard's.
            if SetClipboardData(format, Some(HANDLE(memory.0))).is_err() {
                let _ = GlobalFree(Some(memory));
                return false;
            }
            true
        }
    }

    /// Puts `content` on the clipboard as an ordinary copy, with Liv's mark
    /// next to it so the listener does not record it a second time.
    fn write(content: &Content) -> bool {
        let Some(_open) = Open::new(None) else { return false };
        if unsafe { EmptyClipboard() }.is_err() {
            return false;
        }
        let written = match content {
            Content::Text(text) => {
                let bytes: Vec<u8> = text.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect();
                set(CF_UNICODETEXT, &bytes)
            }
            Content::Image(image) => set(image.format, &image.dib),
        };
        let mark = unsafe { RegisterClipboardFormatW(&HSTRING::from(OWN_FORMAT)) };
        if mark != 0 {
            set(mark, &1u32.to_le_bytes());
        }
        written
    }

    /// Empties the clipboard and hands it `formats`. What counts is the
    /// first: the others only say more about it.
    pub fn put(formats: &[(u32, &[u8])]) -> bool {
        let Some(_open) = Open::new(None) else { return false };
        if unsafe { EmptyClipboard() }.is_err() {
            return false;
        }
        let mut taken = false;
        for (index, (format, bytes)) in formats.iter().enumerate() {
            let set = set(*format, bytes);
            if index == 0 {
                taken = set;
            }
            if !taken {
                break;
            }
        }
        taken
    }

    // ── Pasting ───────────────────────────────────────────────────────────────

    pub fn paste(app: &AppHandle, id: u64) -> &'static str {
        let (content, entries) = {
            let mut s = state();
            match s.history.touch(id, now_ms()) {
                Some(content) => (content, s.history.entries()),
                None => return "gone",
            }
        };
        emit(app, entries);
        if !write(&content) {
            return "failed";
        }
        // Opened with its shortcut the island has the keyboard: it gives it
        // back to the app the user was typing in.
        hand_back_keyboard(app);
        // A moment for the clipboard to be announced, and for that app to be in front again.
        std::thread::sleep(Duration::from_millis(60));
        // Liv's own window in front (Settings), or none: there is nowhere to paste.
        if !front_is_another_app() {
            return "copied";
        }
        match crate::paste::send_ctrl_v() {
            Ok(()) => "pasted",
            Err(err) => {
                crate::log::line(format!("clipboard: keystroke failed: {err}"));
                "copied"
            }
        }
    }

    /// The island, when it is the window in front, puts back the one that was
    /// (platform: set_activating). On the main thread, as when the page asks.
    fn hand_back_keyboard(app: &AppHandle) {
        let Some(island) = crate::island::window(app) else { return };
        let in_front = island
            .hwnd()
            .is_ok_and(|hwnd| hwnd.0 as isize == unsafe { GetForegroundWindow() }.0 as isize);
        if !in_front {
            return;
        }
        let (done, wait) = mpsc::channel();
        let asked = app.run_on_main_thread(move || {
            crate::platform::set_activating(&island, false);
            let _ = done.send(());
        });
        if asked.is_ok() {
            let _ = wait.recv_timeout(Duration::from_millis(500));
        }
    }

    /// Whether a window of another process is in front, to take the keystroke.
    fn front_is_another_app() -> bool {
        unsafe {
            let front = GetForegroundWindow();
            if front.0.is_null() {
                return false;
            }
            let mut process = 0u32;
            GetWindowThreadProcessId(front, Some(&mut process as *mut u32));
            process != 0 && process != GetCurrentProcessId()
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// The listener's window and loop, for real — it only asks to be told
        /// of changes: nothing is read from the clipboard, nothing written.
        #[test]
        fn the_listener_waits_on_a_window_of_its_own_and_ends_when_told() {
            let generation = {
                let mut s = state();
                s.active = true;
                s.generation += 1;
                s.window = 0;
                s.generation
            };
            // One from before the setting last changed sees it was overtaken, and ends by itself.
            run(generation - 1, |_| {});
            assert_eq!(state().window, 0);

            let (ended, wait) = mpsc::channel();
            let listener = std::thread::spawn(move || {
                run(generation, |_| {});
                let _ = ended.send(());
            });
            let window = (0..500)
                .find_map(|_| {
                    let window = state().window;
                    if window == 0 {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    (window != 0).then_some(window)
                })
                .expect("the listener has its window");
            assert!(wait.recv_timeout(Duration::from_millis(100)).is_err(), "it waits for the clipboard to change");
            stop(window);
            wait.recv_timeout(Duration::from_secs(5)).expect("told to stop, it ends");
            listener.join().unwrap();

            let mut s = state();
            s.active = false;
            s.generation += 1;
            s.window = 0;
        }

        /// Touches the real clipboard: run by hand, with nothing on it you
        /// care about (`cargo test -p liv -- --ignored real_clipboard`).
        #[test]
        #[ignore]
        fn real_clipboard_an_entry_put_back_is_an_ordinary_copy_that_the_listener_skips() {
            assert!(write(&Content::Text("liv clipboard test — ñ 你好".into())));
            let _open = Open::new(None).expect("the clipboard opens");
            let formats = formats();
            assert!(formats.iter().any(|f| f.id == CF_UNICODETEXT));
            assert!(formats.iter().any(|f| f.name == OWN_FORMAT));
            assert_eq!(what_to_take(&formats), Take::Nothing);
            // Without the mark it reads back as it was written.
            let unmarked: Vec<ClipFormat> = formats.into_iter().filter(|f| f.name != OWN_FORMAT).collect();
            assert_eq!(what_to_take(&unmarked), Take::Text);
            let bytes = data(CF_UNICODETEXT, 1024).unwrap();
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .take_while(|unit| *unit != 0)
                .collect();
            assert_eq!(String::from_utf16_lossy(&units), "liv clipboard test — ñ 你好");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> Content {
        Content::Text(s.to_string())
    }

    fn image(seed: u8) -> Content {
        Content::Image(Image {
            format: CF_DIB,
            dib: Arc::from(vec![seed; 8]),
            width: 2,
            height: 1,
            thumb: format!("data:image/png;base64,{seed}"),
        })
    }

    fn ids(history: &History) -> Vec<u64> {
        history.entries().iter().map(|e| e.id).collect()
    }

    // ── The history ───────────────────────────────────────────────────────────

    #[test]
    fn the_newest_copy_is_first_and_every_entry_has_its_own_id() {
        let mut history = History::default();
        assert_eq!(history.push(text("one"), 10), 1);
        assert_eq!(history.push(text("two"), 20), 2);
        assert_eq!(history.push(image(1), 30), 3);
        assert_eq!(ids(&history), [3, 2, 1]);
        let entries = history.entries();
        assert_eq!((entries[0].kind, entries[0].at), ("image", 30));
        assert_eq!((entries[2].kind, entries[2].preview.as_deref(), entries[2].at), ("text", Some("one"), 10));
    }

    #[test]
    fn the_same_text_copied_again_moves_to_the_top_instead_of_appearing_twice() {
        let mut history = History::default();
        history.push(text("one"), 10);
        history.push(text("two"), 20);
        assert_eq!(history.push(text("one"), 30), 1);
        assert_eq!(ids(&history), [1, 2]);
        assert_eq!(history.entries()[0].at, 30);
        // Not the same text: a space more is another copy.
        history.push(text("one "), 40);
        assert_eq!(ids(&history), [3, 1, 2]);
        // The same image too, by its bytes; another image is another entry.
        history.push(image(7), 50);
        history.push(image(8), 60);
        assert_eq!(history.push(image(7), 70), 4);
        assert_eq!(ids(&history), [4, 5, 3, 1, 2]);
    }

    #[test]
    fn at_most_thirty_entries_are_kept_and_the_oldest_go() {
        let mut history = History::default();
        for n in 0..(MAX_ENTRIES as u64 + 5) {
            history.push(text(&format!("copy {n}")), n);
        }
        let kept = ids(&history);
        assert_eq!(kept.len(), MAX_ENTRIES);
        assert_eq!(kept.first(), Some(&(MAX_ENTRIES as u64 + 5)));
        assert_eq!(kept.last(), Some(&6));
    }

    #[test]
    fn at_most_four_images_are_kept_whatever_text_is_between_them() {
        let mut history = History::default();
        for n in 0..6u8 {
            history.push(image(n), u64::from(n));
            history.push(text(&format!("text {n}")), u64::from(n));
        }
        let entries = history.entries();
        let images: Vec<u64> = entries.iter().filter(|e| e.kind == "image").map(|e| e.id).collect();
        // Ids 1, 3, 5… are the images: the two oldest went.
        assert_eq!(images, [11, 9, 7, 5]);
        assert_eq!(entries.iter().filter(|e| e.kind == "text").count(), 6);
    }

    #[test]
    fn an_entry_put_back_moves_to_the_top_and_one_that_is_gone_says_so() {
        let mut history = History::default();
        history.push(text("one"), 10);
        history.push(text("two"), 20);
        history.push(text("three"), 30);
        assert_eq!(history.touch(1, 40), Some(text("one")));
        assert_eq!(ids(&history), [1, 3, 2]);
        assert_eq!(history.entries()[0].at, 40);
        assert_eq!(history.touch(99, 50), None);
        assert_eq!(ids(&history), [1, 3, 2]);
    }

    #[test]
    fn removing_and_clearing_forget_entries_and_never_reuse_an_id() {
        let mut history = History::default();
        history.push(text("one"), 10);
        history.push(text("two"), 20);
        assert!(history.remove(1));
        assert!(!history.remove(1));
        assert_eq!(ids(&history), [2]);
        assert!(history.clear());
        assert!(!history.clear());
        assert_eq!(ids(&history), [0u64; 0]);
        assert_eq!(history.touch(2, 30), None);
        assert_eq!(history.push(text("one"), 40), 3);
    }

    #[test]
    fn the_page_gets_a_preview_of_a_text_and_never_the_whole_of_it() {
        let mut history = History::default();
        let long = "añ🙂".repeat(200);
        history.push(text(&long), 5);
        history.push(image(3), 6);
        let entries = history.entries();
        let shown = entries[1].preview.as_deref().unwrap();
        assert_eq!(shown.chars().count(), PREVIEW_CHARS);
        assert!(long.starts_with(shown));
        assert_eq!(entries[1].chars, Some(600));

        let json = serde_json::to_value(&entries).unwrap();
        assert_eq!(
            json[1].as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
            ["id", "kind", "preview", "chars", "at"]
        );
        assert_eq!(
            json[0],
            serde_json::json!({ "id": 2, "kind": "image", "width": 2, "height": 1, "thumb": "data:image/png;base64,3", "at": 6 })
        );
    }

    // ── What is recorded ──────────────────────────────────────────────────────

    fn standard(id: u32) -> ClipFormat {
        ClipFormat { id, name: String::new(), value: None }
    }

    fn named(name: &str, value: Option<u32>) -> ClipFormat {
        ClipFormat { id: 0xC123, name: name.to_string(), value }
    }

    #[test]
    fn text_is_taken_and_an_image_when_there_is_no_text() {
        // Notepad: text in its three encodings and the locale.
        assert_eq!(what_to_take(&[standard(13), standard(16), standard(1), standard(7)]), Take::Text);
        // A screenshot: the bitmap, and the formats the clipboard makes from it.
        assert_eq!(what_to_take(&[standard(2), standard(CF_DIB), standard(CF_DIBV5)]), Take::Image(CF_DIB));
        assert_eq!(what_to_take(&[standard(CF_DIBV5), standard(CF_DIB), standard(2)]), Take::Image(CF_DIBV5));
        // Cells from a spreadsheet: their text, not the picture of them.
        assert_eq!(what_to_take(&[standard(CF_DIB), named("HTML Format", None), standard(13)]), Take::Text);
        // Files from Explorer, and anything this history does not know.
        assert_eq!(what_to_take(&[standard(CF_HDROP), named("Shell IDList Array", None)]), Take::Nothing);
        assert_eq!(what_to_take(&[standard(CF_HDROP), standard(13)]), Take::Nothing);
        assert_eq!(what_to_take(&[named("HTML Format", None), standard(3)]), Take::Nothing);
        assert_eq!(what_to_take(&[]), Take::Nothing);
    }

    #[test]
    fn a_copy_marked_private_is_never_taken() {
        let text = standard(13);
        for private in [
            named("ExcludeClipboardContentFromMonitorProcessing", None),
            named("Clipboard Viewer Ignore", None),
            named("CanIncludeInClipboardHistory", Some(0)),
            // The format is there and its value cannot be read: on the safe side.
            named("CanIncludeInClipboardHistory", None),
            // Format names do not tell upper case from lower.
            named("excludeclipboardcontentfrommonitorprocessing", None),
            named("CLIPBOARD VIEWER IGNORE", None),
        ] {
            assert_eq!(what_to_take(&[text.clone(), private.clone()]), Take::Nothing, "{private:?}");
            assert_eq!(what_to_take(&[private.clone(), standard(CF_DIB)]), Take::Nothing, "{private:?}");
        }
        // Explicitly allowed, or a format that only keeps it off the cloud: taken.
        assert_eq!(what_to_take(&[text.clone(), named("CanIncludeInClipboardHistory", Some(1))]), Take::Text);
        assert_eq!(what_to_take(&[text.clone(), named("CanUploadToCloudClipboard", Some(0))]), Take::Text);
    }

    #[test]
    fn what_liv_puts_on_the_clipboard_itself_is_not_recorded_again() {
        // An entry put back by a click (win::write).
        assert_eq!(what_to_take(&[standard(13), named(OWN_FORMAT, Some(1))]), Take::Nothing);
        assert_eq!(what_to_take(&[standard(CF_DIBV5), named(OWN_FORMAT, Some(1))]), Take::Nothing);
        // A dropped file's path pasted into a terminal, and what was there put
        // back after it (paste/mod.rs): arboard's exclude_from_history and
        // exclude_from_cloud, each a format holding a DWORD of 0.
        let own_paste = [
            standard(13),
            named("CanUploadToCloudClipboard", Some(0)),
            named("CanIncludeInClipboardHistory", Some(0)),
        ];
        assert_eq!(what_to_take(&own_paste), Take::Nothing);
    }

    #[test]
    fn empty_blank_and_very_long_texts_are_not_kept() {
        assert!(keeps_text("a"));
        assert!(keeps_text("  two words\n"));
        for blank in ["", " ", "\r\n", "\t \u{a0}\n"] {
            assert!(!keeps_text(blank), "{blank:?}");
        }
        assert!(keeps_text(&"x".repeat(MAX_TEXT_CHARS)));
        assert!(!keeps_text(&"x".repeat(MAX_TEXT_CHARS + 1)));
        // Characters, not bytes.
        assert!(keeps_text(&"ñ".repeat(MAX_TEXT_CHARS)));
    }

    // ── Bitmaps ───────────────────────────────────────────────────────────────

    const RED: [u8; 4] = [255, 0, 0, 255];
    const GREEN: [u8; 4] = [0, 255, 0, 255];
    const BLUE: [u8; 4] = [0, 0, 255, 255];
    const WHITE: [u8; 4] = [255, 255, 255, 255];

    /// A 40-byte header (BITMAPINFOHEADER), `rows` negative for a top-down bitmap.
    fn header(width: i32, rows: i32, bits: u16, compression: u32) -> Vec<u8> {
        let mut h = Vec::new();
        h.extend_from_slice(&40u32.to_le_bytes());
        h.extend_from_slice(&width.to_le_bytes());
        h.extend_from_slice(&rows.to_le_bytes());
        h.extend_from_slice(&1u16.to_le_bytes());
        h.extend_from_slice(&bits.to_le_bytes());
        h.extend_from_slice(&compression.to_le_bytes());
        h.extend_from_slice(&[0; 20]);
        h
    }

    /// The same picture every time: red green / blue white, 2 × 2.
    fn picture() -> Rgba {
        Rgba { width: 2, height: 2, pixels: [RED, GREEN, BLUE, WHITE].concat() }
    }

    /// One pixel as a 24-bit bitmap stores it: blue, green, red.
    fn bgr(p: [u8; 4]) -> [u8; 3] {
        [p[2], p[1], p[0]]
    }

    #[test]
    fn a_24_bit_bitmap_is_read_bottom_up_or_top_down_with_its_rows_padded() {
        // Rows of 2 pixels are 6 bytes, padded to 8.
        let row = |a: [u8; 4], b: [u8; 4]| [&bgr(a)[..], &bgr(b)[..], &[0, 0]].concat();
        let mut bottom_up = header(2, 2, 24, BI_RGB);
        bottom_up.extend(row(BLUE, WHITE));
        bottom_up.extend(row(RED, GREEN));
        assert_eq!(dib_to_rgba(&bottom_up), Some(picture()));

        let mut top_down = header(2, -2, 24, BI_RGB);
        top_down.extend(row(RED, GREEN));
        top_down.extend(row(BLUE, WHITE));
        assert_eq!(dib_to_rgba(&top_down), Some(picture()));
    }

    #[test]
    fn a_32_bit_bitmap_is_read_both_ways_and_an_unused_alpha_means_opaque() {
        let bgra = |p: [u8; 4], alpha: u8| [p[2], p[1], p[0], alpha];
        let mut bottom_up = header(2, 2, 32, BI_RGB);
        for p in [BLUE, WHITE, RED, GREEN] {
            bottom_up.extend(bgra(p, 0));
        }
        assert_eq!(dib_to_rgba(&bottom_up), Some(picture()));

        let mut top_down = header(2, -2, 32, BI_RGB);
        for p in [RED, GREEN, BLUE, WHITE] {
            top_down.extend(bgra(p, 0));
        }
        assert_eq!(dib_to_rgba(&top_down), Some(picture()));

        // An alpha that is used is kept.
        let mut see_through = header(2, -1, 32, BI_RGB);
        see_through.extend(bgra(RED, 128));
        see_through.extend(bgra(GREEN, 0));
        assert_eq!(
            dib_to_rgba(&see_through),
            Some(Rgba { width: 2, height: 1, pixels: vec![255, 0, 0, 128, 0, 255, 0, 0] })
        );
    }

    #[test]
    fn a_bitmap_with_colour_masks_is_read_wherever_its_channels_are() {
        // Red, green, blue, alpha a byte each from the lowest: the reverse of the usual order.
        let masks: [u32; 3] = [0x0000_00FF, 0x0000_FF00, 0x00FF_0000];
        let mut dib = header(2, -1, 32, BI_BITFIELDS);
        for mask in masks {
            dib.extend_from_slice(&mask.to_le_bytes());
        }
        dib.extend_from_slice(&[255, 0, 0, 0]);
        dib.extend_from_slice(&[0, 0, 255, 0]);
        assert_eq!(dib_to_rgba(&dib), Some(Rgba { width: 2, height: 1, pixels: [RED, BLUE].concat() }));

        // A V5 header (124 bytes) carries its masks, alpha included, inside it —
        // and the clipboard's own repeats the three after it.
        let v5 = |repeated: bool| {
            let mut dib = header(1, 1, 32, BI_BITFIELDS);
            dib[..4].copy_from_slice(&124u32.to_le_bytes());
            for mask in [0x00FF_0000u32, 0x0000_FF00, 0x0000_00FF, 0xFF00_0000] {
                dib.extend_from_slice(&mask.to_le_bytes());
            }
            dib.resize(124, 0);
            if repeated {
                dib.extend_from_slice(&[0xAA; 12]);
            }
            dib.extend_from_slice(&[0x10, 0x20, 0x30, 0x80]);
            dib
        };
        let expected = Some(Rgba { width: 1, height: 1, pixels: vec![0x30, 0x20, 0x10, 0x80] });
        assert_eq!(dib_to_rgba(&v5(false)), expected);
        assert_eq!(dib_to_rgba(&v5(true)), expected);
        // Five bits a channel are stretched to the full range.
        assert_eq!(channel(0b11111 << 10, 0b11111 << 10), 255);
        assert_eq!(channel(0, 0b11111 << 10), 0);
        assert_eq!(channel(0xFFFF_FFFF, 0), 0);
    }

    #[test]
    fn what_is_not_a_bitmap_this_history_can_show_is_refused_without_a_panic() {
        let mut whole = header(2, 2, 24, BI_RGB);
        whole.extend_from_slice(&[0; 16]);
        assert!(dib_to_rgba(&whole).is_some());
        // Cut short anywhere: the header, the pixels.
        for len in 0..whole.len() {
            assert_eq!(dib_to_rgba(&whole[..len]), None, "{len} bytes");
        }
        // 8 bits with a palette, 16 bits, compressed, no width, no height, absurd sizes.
        let with = |width: i32, rows: i32, bits: u16, compression: u32| {
            let mut dib = header(width, rows, bits, compression);
            dib.extend_from_slice(&[0; 64]);
            dib
        };
        assert_eq!(dib_to_rgba(&with(2, 2, 8, BI_RGB)), None);
        assert_eq!(dib_to_rgba(&with(2, 2, 16, BI_RGB)), None);
        assert_eq!(dib_to_rgba(&with(2, 2, 24, 1)), None);
        assert_eq!(dib_to_rgba(&with(2, 2, 24, BI_BITFIELDS)), None);
        assert_eq!(dib_to_rgba(&with(0, 2, 24, BI_RGB)), None);
        assert_eq!(dib_to_rgba(&with(-2, 2, 24, BI_RGB)), None);
        assert_eq!(dib_to_rgba(&with(2, 0, 24, BI_RGB)), None);
        assert_eq!(dib_to_rgba(&with(2, i32::MIN, 24, BI_RGB)), None);
        assert_eq!(dib_to_rgba(&with(i32::MAX, i32::MAX, 32, BI_RGB)), None);
        assert_eq!(dib_to_rgba(&with(40_000, 1, 32, BI_RGB)), None);
        // A header that says it is longer than the bytes there are.
        let mut lying = with(1, 1, 32, BI_RGB);
        lying[..4].copy_from_slice(&4000u32.to_le_bytes());
        assert_eq!(dib_to_rgba(&lying), None);
    }

    // ── Thumbnails ────────────────────────────────────────────────────────────

    #[test]
    fn a_thumbnail_keeps_the_shape_fits_its_box_and_is_never_bigger_than_the_image() {
        assert_eq!(thumb_size(1920, 1080), (171, 96));
        assert_eq!(thumb_size(1080, 1920), (54, 96));
        // Very wide: the width is what limits it.
        assert_eq!(thumb_size(4000, 100), (256, 6));
        // Small already: as it is.
        assert_eq!(thumb_size(64, 48), (64, 48));
        assert_eq!(thumb_size(256, 96), (256, 96));
        // Never nothing.
        assert_eq!(thumb_size(10_000, 1), (256, 1));
        assert_eq!(thumb_size(1, 10_000), (1, 96));
        assert_eq!(thumb_size(0, 0), (1, 1));
        for (w, h) in [(1920, 1080), (4000, 100), (1, 10_000), (3, 3), (32_768, 32_768)] {
            let (tw, th) = thumb_size(w, h);
            assert!(tw <= THUMB_MAX_W && th <= THUMB_MAX_H && tw >= 1 && th >= 1, "{w}×{h}");
        }
    }

    #[test]
    fn scaling_down_averages_each_block_and_leaves_a_small_image_alone() {
        // 4 × 2: a red block and a blue block → 2 × 1.
        let image = Rgba { width: 4, height: 2, pixels: [RED, RED, BLUE, BLUE, RED, RED, BLUE, BLUE].concat() };
        assert_eq!(scale_down(&image, 2, 1), Rgba { width: 2, height: 1, pixels: [RED, BLUE].concat() });
        // Down to one pixel: the mean of all of it.
        let mixed = Rgba { width: 2, height: 1, pixels: [[0, 0, 0, 255], [255, 255, 255, 255]].concat() };
        assert_eq!(scale_down(&mixed, 1, 1).pixels, [128, 128, 128, 255]);
        // What cannot be seen gives no colour: red next to nothing stays red, half as opaque.
        let edge = Rgba { width: 2, height: 1, pixels: [RED, [0, 255, 0, 0]].concat() };
        assert_eq!(scale_down(&edge, 1, 1).pixels, [255, 0, 0, 128]);
        let nothing = Rgba { width: 2, height: 1, pixels: vec![9, 9, 9, 0, 7, 7, 7, 0] };
        assert_eq!(scale_down(&nothing, 1, 1).pixels, [0, 0, 0, 0]);
        // The same size, or a bigger one asked for: as it is.
        assert_eq!(scale_down(&picture(), 2, 2), picture());
        assert_eq!(scale_down(&picture(), 8, 8), picture());
        // Sizes that do not divide evenly still cover every pixel once.
        let odd = Rgba { width: 5, height: 3, pixels: WHITE.repeat(15) };
        let small = scale_down(&odd, 2, 2);
        assert_eq!((small.width, small.height), (2, 2));
        assert_eq!(small.pixels, WHITE.repeat(4));
    }

    fn decode(png_file: &[u8]) -> Rgba {
        let decoder = png::Decoder::new(std::io::Cursor::new(png_file));
        let mut reader = decoder.read_info().unwrap();
        let (width, height) = (reader.info().width, reader.info().height);
        let mut pixels = vec![0; width as usize * height as usize * 4];
        let frame = reader.next_frame(&mut pixels).unwrap();
        assert_eq!((frame.color_type, frame.bit_depth), (png::ColorType::Rgba, png::BitDepth::Eight));
        Rgba { width, height, pixels }
    }

    #[test]
    fn the_png_holds_the_picture() {
        let file = png_bytes(&picture()).unwrap();
        assert!(file.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(decode(&file), picture());
        // Pixels that do not match the size: no file.
        assert_eq!(png_bytes(&Rgba { width: 2, height: 2, pixels: vec![0; 15] }), None);
    }

    #[test]
    fn a_copied_bitmap_is_kept_whole_with_its_size_and_a_thumbnail_that_fits() {
        // 400 × 300, top-down, one colour.
        let (width, height) = (400u32, 300u32);
        let mut dib = header(width as i32, -(height as i32), 32, BI_RGB);
        for _ in 0..width * height {
            dib.extend_from_slice(&[0x54, 0xB9, 0x1D, 0]); // #1DB954, as blue green red
        }
        let image = image_from_dib(CF_DIB, dib.clone()).unwrap();
        assert_eq!((image.format, image.width, image.height), (CF_DIB, 400, 300));
        assert_eq!(&image.dib[..], &dib[..], "what goes back on the clipboard is what came from it");

        let encoded = image.thumb.strip_prefix("data:image/png;base64,").unwrap();
        let file = unbase64(encoded);
        let thumb = decode(&file);
        assert_eq!((thumb.width, thumb.height), (128, 96));
        assert!(thumb.pixels.chunks_exact(4).all(|p| p == [0x1D, 0xB9, 0x54, 255]));

        // Not a bitmap, or too big to keep.
        assert_eq!(image_from_dib(CF_DIB, vec![1, 2, 3]), None);
        let mut huge = header(1, 1, 32, BI_RGB);
        huge.resize(MAX_IMAGE_BYTES + 1, 0);
        assert_eq!(image_from_dib(CF_DIB, huge), None);
    }

    /// Standard base64, for reading a data URL back.
    fn unbase64(text: &str) -> Vec<u8> {
        const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let (mut buffer, mut bits) = (0u32, 0);
        for byte in text.bytes().filter(|b| *b != b'=') {
            buffer = (buffer << 6) | TABLE.iter().position(|c| *c == byte).unwrap() as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buffer >> bits) as u8);
            }
        }
        out
    }
}
