// Screenshots, for the shelf of the island's Tools view: the screen the
// pointer is on, or an area of it the user drags out.
//
// A screenshot is saved as a PNG in Pictures\Liv, put on the clipboard as an
// image (an ordinary copy: the clipboard history lists it) and on top of the
// shelf; the island then hears `capture`. Nothing is sent anywhere.
//
// Windows: the picture is read with GDI from the screen's device context, in
// physical pixels (the process is per-monitor DPI aware), without the pointer.
// Liv's own windows — the island, Liv on the desktop — are told to stay out of
// captures for the moment it takes. The area is chosen on a window of its own:
// plain Win32, no webview, on its own thread; it dims the display and leaves a
// clear hole where the selection is.
//
// Elsewhere the module is inert: a capture answers that it could not be taken.

// Off Windows nothing grabs the screen, so what the grab feeds has no caller.
#![cfg_attr(not(windows), allow(dead_code))]

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::clipboard::{png_bytes, Rgba};
use crate::platform::LocalTime;

/// The island's event: how a capture went.
const EVENT: &str = "capture";

/// A selection smaller than this on either side is a slip of the hand, px.
pub const MIN_SIDE: i32 = 4;
/// The folder inside Pictures.
const FOLDER: &str = "Liv";

// ── The selection ─────────────────────────────────────────────────────────────

/// A rectangle of the desktop, or of a window, in physical px.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// The rectangle between two points, whichever way the drag went, kept inside
/// `bounds`. It may be empty.
pub fn span(a: (i32, i32), b: (i32, i32), bounds: Rect) -> Rect {
    let within = |v: i32, from: i32, size: i32| v.clamp(from, from.saturating_add(size.max(0)));
    let (ax, bx) = (within(a.0, bounds.x, bounds.w), within(b.0, bounds.x, bounds.w));
    let (ay, by) = (within(a.1, bounds.y, bounds.h), within(b.1, bounds.y, bounds.h));
    Rect { x: ax.min(bx), y: ay.min(by), w: (ax - bx).abs(), h: (ay - by).abs() }
}

/// What a drag from `a` to `b` selects: `span`, when it is big enough to be
/// meant. `None` cancels.
pub fn selection(a: (i32, i32), b: (i32, i32), bounds: Rect) -> Option<Rect> {
    let rect = span(a, b, bounds);
    (rect.w >= MIN_SIDE && rect.h >= MIN_SIDE).then_some(rect)
}

// ── The file ──────────────────────────────────────────────────────────────────

/// The file's name without its extension: "Screenshot 2026-11-17 15.53.07",
/// "Captura …" in Spanish. No character a file name cannot have.
pub fn file_stem(time: &LocalTime) -> String {
    format!(
        "{} {:04}-{:02}-{:02} {:02}.{:02}.{:02}",
        crate::i18n::t("Screenshot"),
        time.year,
        time.month,
        time.day,
        time.hour,
        time.minute,
        time.second
    )
}

/// Writes `png` in `dir` (made if it is not there) as "`stem`.png", or
/// "`stem` (2).png" and so on when that name is taken: nothing is ever
/// written over. Where it went.
pub fn save_png(dir: &Path, stem: &str, png: &[u8]) -> std::io::Result<PathBuf> {
    use std::io::ErrorKind;
    std::fs::create_dir_all(dir)?;
    for n in 1..1000 {
        let name = if n == 1 { format!("{stem}.png") } else { format!("{stem} ({n}).png") };
        let path = dir.join(name);
        // Created only if it does not exist: two captures in the same second
        // cannot take the same name.
        match std::fs::File::options().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(err) = file.write_all(png) {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                    return Err(err);
                }
                return Ok(path);
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(ErrorKind::AlreadyExists, "too many screenshots with this name"))
}

/// Where screenshots go: Pictures\Liv. `None` when there is no Pictures folder.
pub fn captures_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let pictures = win::pictures_dir().or_else(|| crate::platform::picture_dirs().into_iter().next());
    #[cfg(not(windows))]
    let pictures = crate::platform::picture_dirs().into_iter().find(|dir| dir.is_dir());
    pictures.map(|dir| dir.join(FOLDER))
}

// ── Pixels ────────────────────────────────────────────────────────────────────

/// What the fourth byte of a pixel read from a GDI bitmap means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Alpha {
    /// Nothing: the screen is opaque.
    Ignored,
    /// How opaque the pixel is, its colours already multiplied by it — what
    /// the shell hands out for an icon. All zeros means it is not used.
    Premultiplied,
}

/// Pixels as GDI gives them (blue, green, red, alpha; top row first) as RGBA
/// that is not premultiplied. `None` when there are not `width` × `height` of them.
pub fn bgra_to_rgba(bgra: &[u8], width: u32, height: u32, alpha: Alpha) -> Option<Rgba> {
    let count = (width as usize).checked_mul(height as usize)?;
    if count == 0 || Some(bgra.len()) != count.checked_mul(4) {
        return None;
    }
    let used = alpha == Alpha::Premultiplied && bgra.chunks_exact(4).any(|p| p[3] != 0);
    let mut pixels = Vec::with_capacity(bgra.len());
    for p in bgra.chunks_exact(4) {
        if !used {
            pixels.extend_from_slice(&[p[2], p[1], p[0], 255]);
            continue;
        }
        let a = u32::from(p[3]);
        if a == 0 {
            pixels.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        let whole = |c: u8| ((u32::from(c) * 255 + a / 2) / a).min(255) as u8;
        pixels.extend_from_slice(&[whole(p[2]), whole(p[1]), whole(p[0]), p[3]]);
    }
    Some(Rgba { width, height, pixels })
}

/// `image` as the clipboard holds a picture (CF_DIB): a 40-byte header, then
/// 24 bits a pixel, bottom row first, each row padded to four bytes — the form
/// every app that pastes images reads. What cannot be seen through is all a
/// screenshot has, so its alpha is left out.
pub fn rgba_to_dib(image: &Rgba) -> Option<Vec<u8>> {
    let (width, height) = (image.width as usize, image.height as usize);
    if width == 0 || height == 0 || image.pixels.len() != width.checked_mul(height)?.checked_mul(4)? {
        return None;
    }
    let stride = (width * 3).div_ceil(4) * 4;
    let size = stride.checked_mul(height)?;
    let mut dib = Vec::with_capacity(40 + size);
    dib.extend_from_slice(&40u32.to_le_bytes());
    dib.extend_from_slice(&i32::try_from(width).ok()?.to_le_bytes());
    dib.extend_from_slice(&i32::try_from(height).ok()?.to_le_bytes());
    dib.extend_from_slice(&1u16.to_le_bytes());
    dib.extend_from_slice(&24u16.to_le_bytes());
    // Uncompressed, then its size; no resolution, no palette.
    dib.extend_from_slice(&0u32.to_le_bytes());
    dib.extend_from_slice(&u32::try_from(size).ok()?.to_le_bytes());
    dib.extend_from_slice(&[0; 16]);
    for row in image.pixels.chunks_exact(width * 4).rev() {
        for p in row.chunks_exact(4) {
            dib.extend_from_slice(&[p[2], p[1], p[0]]);
        }
        dib.resize(dib.len() + stride - width * 3, 0);
    }
    Some(dib)
}

// ── What the island hears ─────────────────────────────────────────────────────

/// The `capture` event: `{ ok: true, id, name, width, height }` — `id` is the
/// screenshot's item on the shelf — or `{ ok: false }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Captured {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

impl Captured {
    pub fn taken(id: Option<u64>, name: String, width: u32, height: u32) -> Captured {
        Captured { ok: true, id, name: Some(name), width: Some(width), height: Some(height) }
    }

    pub fn failed() -> Captured {
        Captured { ok: false, id: None, name: None, width: None, height: None }
    }
}

/// A picture was taken, or could not be: it is saved, copied and shelved, and
/// the island is told either way.
fn finish(app: &AppHandle, image: Option<Rgba>) {
    let outcome = image.and_then(|image| keep(app, &image)).unwrap_or_else(|| {
        crate::log::line("capture: no screenshot");
        Captured::failed()
    });
    let _ = app.emit_to(crate::island::WINDOW_LABEL, EVENT, outcome);
}

fn keep(app: &AppHandle, image: &Rgba) -> Option<Captured> {
    let png = png_bytes(image)?;
    let dir = captures_dir()?;
    let path = match save_png(&dir, &file_stem(&crate::platform::local_time()), &png) {
        Ok(path) => path,
        Err(err) => {
            crate::log::line(format!("capture: not saved: {err}"));
            return None;
        }
    };
    // The file is what matters: a clipboard that is busy does not undo it.
    if !copy(image) {
        crate::log::line("capture: saved, but the clipboard would not take it");
    }
    let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    let id = crate::shelf::add_path(app, &path.to_string_lossy());
    crate::log::line(format!("capture: {} × {} saved", image.width, image.height));
    Some(Captured::taken(id, name, image.width, image.height))
}

#[cfg(windows)]
fn copy(image: &Rgba) -> bool {
    rgba_to_dib(image).is_some_and(|dib| crate::clipboard::put(&[(crate::clipboard::CF_DIB, &dib)]))
}

#[cfg(not(windows))]
fn copy(_image: &Rgba) -> bool {
    false
}

// ── Taking one ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Screen,
    Area,
}

/// Takes a screenshot on a thread of its own: the area's window has its own
/// message loop, and neither waits on the caller's.
fn start(app: AppHandle, kind: Kind) {
    let spawned = std::thread::Builder::new().name("liv-capture".into()).spawn(move || match kind {
        Kind::Screen => screen(&app),
        Kind::Area => area(&app),
    });
    if let Err(err) = spawned {
        crate::log::line(format!("capture: no thread: {err}"));
    }
}

#[cfg(windows)]
fn screen(app: &AppHandle) {
    // While an area is being chosen its window dims the display: no picture of that.
    if win::selecting() {
        return;
    }
    let image = win::monitor_under_cursor().and_then(|display| win::grab_without_liv(app, display));
    finish(app, image);
}

#[cfg(windows)]
fn area(app: &AppHandle) {
    // One at a time: a second request while the first is up is ignored.
    let Some(_only) = win::Selecting::begin() else { return };
    let Some(display) = win::monitor_under_cursor() else {
        finish(app, None);
        return;
    };
    // Cancelled — Esc, a right click, a selection too small to be meant:
    // nothing happened, and nothing is said.
    let Some(rect) = win::select_area(display, true) else { return };
    finish(app, win::grab_without_liv(app, rect));
}

#[cfg(not(windows))]
fn screen(app: &AppHandle) {
    finish(app, None);
}

#[cfg(not(windows))]
fn area(app: &AppHandle) {
    finish(app, None);
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// The display the pointer is on. The island's alone, like what it leads to:
/// the clipboard and the shelf.
#[tauri::command]
pub fn capture_screen(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    crate::from_island(&window)?;
    start(app, Kind::Screen);
    Ok(())
}

/// An area the user drags out on the display the pointer is on.
#[tauri::command]
pub fn capture_area(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    crate::from_island(&window)?;
    start(app, Kind::Area);
    Ok(())
}

/// Settings → Tools → Open screenshots folder: creates it if needed and shows it.
#[tauri::command]
pub fn open_captures_folder() {
    let Some(dir) = captures_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    crate::platform::reveal_folder(&dir.to_string_lossy());
}

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(windows)]
pub(crate) mod win {
    use super::*;
    use std::cell::Cell;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    use windows::core::w;
    use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Dwm::DwmFlush;
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateSolidBrush, DeleteDC, DeleteObject,
        EndPaint, FillRect, GetDC, GetDIBits, GetMonitorInfoW, GetObjectW, InvalidateRect, MonitorFromPoint,
        ReleaseDC, SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP,
        HDC, MONITORINFO, MONITOR_DEFAULTTONEAREST, PAINTSTRUCT, SRCCOPY,
    };
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, ReleaseCapture, SetCapture, SetFocus, VK_ESCAPE,
    };
    use windows::Win32::UI::Shell::{FOLDERID_Pictures, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos, GetForegroundWindow,
        GetMessageW, GetWindowThreadProcessId, IsWindow, KillTimer, LoadCursorW, PostQuitMessage, RegisterClassExW,
        SetForegroundWindow, SetLayeredWindowAttributes, SetTimer, SetWindowDisplayAffinity, SetWindowPos, ShowWindow,
        HWND_TOPMOST, IDC_CROSS, LWA_ALPHA, LWA_COLORKEY, MSG, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE,
        SW_SHOW, WDA_EXCLUDEFROMCAPTURE, WDA_NONE, WM_DESTROY, WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN,
        WM_LBUTTONUP, WM_MOUSEMOVE, WM_PAINT, WM_RBUTTONDOWN, WM_TIMER, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_TOOLWINDOW,
        WS_EX_TOPMOST, WS_POPUP,
    };

    /// No display is this wide: a bitmap that says more is not believed.
    const MAX_SIDE: i32 = 32_768;

    // ── Where ─────────────────────────────────────────────────────────────────

    /// The display the pointer is on, whole (the taskbar is part of the screen).
    pub fn monitor_under_cursor() -> Option<Rect> {
        unsafe {
            let mut at = POINT::default();
            GetCursorPos(&mut at).ok()?;
            let monitor = MonitorFromPoint(at, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if !GetMonitorInfoW(monitor, &mut info).as_bool() {
                return None;
            }
            let r = info.rcMonitor;
            Some(Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top })
        }
    }

    /// Pictures, wherever the user or OneDrive moved it.
    pub fn pictures_dir() -> Option<PathBuf> {
        unsafe {
            let name = SHGetKnownFolderPath(&FOLDERID_Pictures, KF_FLAG_DEFAULT, None).ok()?;
            let path = name.to_string().ok();
            CoTaskMemFree(Some(name.0 as *const _));
            path.filter(|path| !path.is_empty()).map(PathBuf::from)
        }
    }

    // ── The picture ───────────────────────────────────────────────────────────

    /// The pixels of a bitmap that is in no device context: its size, and blue,
    /// green, red, alpha for each pixel, top row first.
    ///
    /// # Safety
    /// `bitmap` must be a live bitmap handle.
    pub(crate) unsafe fn bitmap_bgra(bitmap: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
        let mut about: BITMAP = unsafe { std::mem::zeroed() };
        let read = unsafe {
            GetObjectW(bitmap.into(), std::mem::size_of::<BITMAP>() as i32, Some(&mut about as *mut BITMAP as *mut _))
        };
        if read == 0 {
            return None;
        }
        let (width, height) = (about.bmWidth, about.bmHeight.abs());
        if width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE {
            return None;
        }
        // 32 bits a pixel, uncompressed; a negative height asks for the top row first.
        let mut wanted = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let lines = unsafe {
            let screen = GetDC(None);
            let lines =
                GetDIBits(screen, bitmap, 0, height as u32, Some(pixels.as_mut_ptr() as *mut _), &mut wanted, DIB_RGB_COLORS);
            ReleaseDC(None, screen);
            lines
        };
        (lines == height).then_some((width as u32, height as u32, pixels))
    }

    /// A copy of part of the screen, still a bitmap of Windows' own; freed
    /// when this is dropped. Taking it is quick; reading its pixels is not,
    /// and can be done on another thread.
    pub struct Shot(isize);

    // A bitmap that is in no device context belongs to the process, not to a thread.
    unsafe impl Send for Shot {}

    impl Shot {
        /// What is on screen in `rect` right now, without the pointer.
        pub fn take(rect: Rect) -> Option<Shot> {
            if rect.w <= 0 || rect.h <= 0 || rect.w > MAX_SIDE || rect.h > MAX_SIDE {
                return None;
            }
            unsafe {
                let screen = GetDC(None);
                if screen.is_invalid() {
                    return None;
                }
                let memory = CreateCompatibleDC(Some(screen));
                let bitmap = CreateCompatibleBitmap(screen, rect.w, rect.h);
                let mut copied = false;
                if !memory.is_invalid() && !bitmap.is_invalid() {
                    let before = SelectObject(memory, bitmap.into());
                    // CAPTUREBLT: layered windows are part of what is on screen.
                    copied =
                        BitBlt(memory, 0, 0, rect.w, rect.h, Some(screen), rect.x, rect.y, SRCCOPY | CAPTUREBLT).is_ok();
                    SelectObject(memory, before);
                }
                if !memory.is_invalid() {
                    let _ = DeleteDC(memory);
                }
                ReleaseDC(None, screen);
                if bitmap.is_invalid() {
                    return None;
                }
                // From here on the bitmap is the shot's to free.
                let shot = Shot(bitmap.0 as isize);
                copied.then_some(shot)
            }
        }

        /// Its pixels. The screen is opaque, whatever its fourth byte says.
        pub fn image(&self) -> Option<Rgba> {
            let (width, height, bgra) = unsafe { bitmap_bgra(HBITMAP(self.0 as *mut _)) }?;
            bgra_to_rgba(&bgra, width, height, Alpha::Ignored)
        }
    }

    impl Drop for Shot {
        fn drop(&mut self) {
            let _ = unsafe { DeleteObject(HBITMAP(self.0 as *mut _).into()) };
        }
    }

    /// What is on screen in `rect` right now, without the pointer.
    pub fn grab(rect: Rect) -> Option<Rgba> {
        Shot::take(rect)?.image()
    }

    /// Liv's windows, kept out of captures until this is dropped: whatever
    /// happens meanwhile, they are put back.
    struct OutOfThePicture(Vec<isize>);

    impl OutOfThePicture {
        /// On the thread that owns the windows. One that will not take it
        /// (before Windows 10 2004) simply stays in the picture.
        fn new(windows: &[isize]) -> OutOfThePicture {
            let hidden = windows
                .iter()
                .copied()
                .filter(|raw| unsafe { SetWindowDisplayAffinity(HWND(*raw as *mut _), WDA_EXCLUDEFROMCAPTURE) }.is_ok())
                .collect();
            OutOfThePicture(hidden)
        }
    }

    impl Drop for OutOfThePicture {
        fn drop(&mut self) {
            for raw in &self.0 {
                let _ = unsafe { SetWindowDisplayAffinity(HWND(*raw as *mut _), WDA_NONE) };
            }
        }
    }

    /// The shot, on the thread that owns Liv's windows, with them out of the
    /// picture for the moment it takes — and back in it whatever happens.
    fn shot_without(windows: &[isize], rect: Rect) -> Option<Shot> {
        let hidden = OutOfThePicture::new(windows);
        if !hidden.0.is_empty() {
            // The screen is composed without them from the next frame on; one
            // more for a compositor that was already at work on this one.
            unsafe {
                let _ = DwmFlush();
                let _ = DwmFlush();
            }
        }
        Shot::take(rect)
    }

    /// What is on screen in `rect`, without the island or Liv on the desktop
    /// in it. The main thread, which owns them, only takes the shot; its
    /// pixels are read here. If that thread cannot be asked, or does not
    /// answer, the picture is taken as the screen is.
    pub fn grab_without_liv(app: &AppHandle, rect: Rect) -> Option<Rgba> {
        let windows: Vec<isize> = [crate::island::window(app), crate::pet::window(app)]
            .into_iter()
            .flatten()
            .filter_map(|window| window.hwnd().ok().map(|hwnd| hwnd.0 as isize))
            .filter(|raw| *raw != 0)
            .collect();
        if windows.is_empty() {
            return grab(rect);
        }
        let (done, wait) = mpsc::channel();
        let asked = app.run_on_main_thread(move || {
            // Nobody waits any more: the shot is freed as the error is dropped.
            let _ = done.send(shot_without(&windows, rect));
        });
        if asked.is_err() {
            return grab(rect);
        }
        match wait.recv_timeout(Duration::from_secs(3)) {
            Ok(shot) => shot?.image(),
            Err(_) => grab(rect),
        }
    }

    // ── Choosing an area ──────────────────────────────────────────────────────

    /// An area is being chosen.
    static SELECTING: AtomicBool = AtomicBool::new(false);

    pub fn selecting() -> bool {
        SELECTING.load(Ordering::Relaxed)
    }

    /// The one selection there may be at a time, until it is dropped.
    pub struct Selecting(());

    impl Selecting {
        /// `None` while another one is up.
        pub fn begin() -> Option<Selecting> {
            (!SELECTING.swap(true, Ordering::SeqCst)).then_some(Selecting(()))
        }
    }

    impl Drop for Selecting {
        fn drop(&mut self) {
            SELECTING.store(false, Ordering::SeqCst);
        }
    }

    /// The window's class: registered once, and how it is found from outside.
    const CLASS: windows::core::PCWSTR = w!("LivCaptureOverlay");
    /// Painted over the display: dark, and as see-through as `DIM_ALPHA` says.
    const DIM: COLORREF = COLORREF(0x0000_0000);
    const DIM_ALPHA: u8 = 110;
    /// Painted where the selection is: the colour the window is not drawn in — a clear hole.
    const HOLE: COLORREF = COLORREF(0x00FF_00FF);
    /// Around the hole.
    const EDGE: COLORREF = COLORREF(0x00FF_FFFF);
    const EDGE_PX: i32 = 2;
    /// The timer that looks for Esc and keeps the window above the island.
    const WATCH: usize = 1;
    const WATCH_MS: u32 = 50;

    /// The selection as the window's procedure sees it. Plain values in a
    /// cell: Windows calls the procedure from inside calls the procedure makes.
    #[derive(Clone, Copy, Default)]
    struct Drag {
        /// The window's client area: (0, 0) and its size.
        bounds: Rect,
        /// Where the button went down, while it is down.
        from: Option<(i32, i32)>,
        /// Where the pointer is.
        to: (i32, i32),
        /// What was selected, once the button came up on something big enough.
        picked: Option<Rect>,
    }

    impl Drag {
        /// The clear hole: what is selected so far, when it is anything at all.
        fn hole(&self) -> Option<Rect> {
            let hole = span(self.from?, self.to, self.bounds);
            (hole.w > 0 && hole.h > 0).then_some(hole)
        }

        /// The hole with its edge around it: what the selection changes on screen.
        fn framed(&self) -> Option<Rect> {
            let hole = self.hole()?;
            Some(Rect { x: hole.x - EDGE_PX, y: hole.y - EDGE_PX, w: hole.w + 2 * EDGE_PX, h: hole.h + 2 * EDGE_PX })
        }
    }

    thread_local! {
        static DRAG: Cell<Drag> = const { Cell::new(Drag { bounds: Rect { x: 0, y: 0, w: 0, h: 0 }, from: None, to: (0, 0), picked: None }) };
    }

    /// A mouse message's point, in the window's client px.
    fn point(lparam: LPARAM) -> (i32, i32) {
        let raw = lparam.0 as u32;
        (i32::from(raw as u16 as i16), i32::from((raw >> 16) as u16 as i16))
    }

    /// Ends the selection: the window leaves the screen, then is gone.
    fn close(hwnd: HWND) {
        unsafe {
            let _ = ReleaseCapture();
            let _ = ShowWindow(hwnd, SW_HIDE);
            let _ = DestroyWindow(hwnd);
        }
    }

    /// Plain mouse and key messages, with client coordinates: the button down,
    /// a drag, the button up selects; Esc or the right button cancels.
    unsafe extern "system" fn overlay_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match message {
            WM_LBUTTONDOWN => {
                let at = point(lparam);
                let mut drag = DRAG.get();
                let before = drag.framed();
                drag.from = Some(at);
                drag.to = at;
                DRAG.set(drag);
                unsafe { SetCapture(hwnd) };
                repaint(hwnd, before, drag.framed());
                LRESULT(0)
            }
            WM_MOUSEMOVE => {
                let mut drag = DRAG.get();
                if drag.from.is_some() {
                    let before = drag.framed();
                    drag.to = point(lparam);
                    DRAG.set(drag);
                    repaint(hwnd, before, drag.framed());
                }
                LRESULT(0)
            }
            WM_LBUTTONUP => {
                let mut drag = DRAG.get();
                if let Some(from) = drag.from.take() {
                    drag.picked = selection(from, point(lparam), drag.bounds);
                    DRAG.set(drag);
                    close(hwnd);
                }
                LRESULT(0)
            }
            WM_RBUTTONDOWN => {
                cancel(hwnd);
                LRESULT(0)
            }
            WM_KEYDOWN if wparam.0 == usize::from(VK_ESCAPE.0) => {
                cancel(hwnd);
                LRESULT(0)
            }
            WM_TIMER if wparam.0 == WATCH => {
                unsafe {
                    // The island puts itself on top again whenever it changes shape.
                    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                    // Esc, when Windows would not give this window the keyboard.
                    if (GetAsyncKeyState(i32::from(VK_ESCAPE.0)) as u16 & 0x8000) != 0 {
                        cancel(hwnd);
                    }
                }
                LRESULT(0)
            }
            WM_ERASEBKGND => LRESULT(1),
            WM_PAINT => {
                unsafe { paint(hwnd) };
                LRESULT(0)
            }
            WM_DESTROY => {
                unsafe {
                    let _ = KillTimer(Some(hwnd), WATCH);
                    PostQuitMessage(0);
                }
                LRESULT(0)
            }
            _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        }
    }

    fn cancel(hwnd: HWND) {
        let mut drag = DRAG.get();
        drag.from = None;
        drag.picked = None;
        DRAG.set(drag);
        close(hwnd);
    }

    fn win_rect(rect: Rect) -> RECT {
        RECT { left: rect.x, top: rect.y, right: rect.x + rect.w, bottom: rect.y + rect.h }
    }

    /// The selection changed from `before` to `after` (each with its edge):
    /// only where either is has to be drawn again.
    fn repaint(hwnd: HWND, before: Option<Rect>, after: Option<Rect>) {
        for changed in [before, after].into_iter().flatten() {
            let _ = unsafe { InvalidateRect(Some(hwnd), Some(&win_rect(changed)), false) };
        }
    }

    /// Dark everywhere but the selection, which is the hole with its edge
    /// around it. Every pixel is painted once, in its final colour: no frame
    /// shows the window half drawn. Windows clips it all to what changed.
    unsafe fn paint(hwnd: HWND) {
        let drag = DRAG.get();
        let (width, height) = (drag.bounds.w, drag.bounds.h);
        unsafe {
            let mut painting = PAINTSTRUCT::default();
            let window = BeginPaint(hwnd, &mut painting);
            let fill = |window: HDC, rect: Rect, colour: COLORREF| {
                if rect.w <= 0 || rect.h <= 0 {
                    return;
                }
                let brush = CreateSolidBrush(colour);
                FillRect(window, &win_rect(rect), brush);
                let _ = DeleteObject(brush.into());
            };
            match (drag.hole(), drag.framed()) {
                (Some(hole), Some(frame)) => {
                    // Around the frame: above, below, left, right.
                    fill(window, Rect { x: 0, y: 0, w: width, h: frame.y }, DIM);
                    fill(window, Rect { x: 0, y: frame.y + frame.h, w: width, h: height - frame.y - frame.h }, DIM);
                    fill(window, Rect { x: 0, y: frame.y, w: frame.x, h: frame.h }, DIM);
                    fill(window, Rect { x: frame.x + frame.w, y: frame.y, w: width - frame.x - frame.w, h: frame.h }, DIM);
                    // The edge: the same four sides, between the frame and the hole.
                    fill(window, Rect { h: EDGE_PX, ..frame }, EDGE);
                    fill(window, Rect { y: hole.y + hole.h, h: EDGE_PX, ..frame }, EDGE);
                    fill(window, Rect { x: frame.x, y: hole.y, w: EDGE_PX, h: hole.h }, EDGE);
                    fill(window, Rect { x: hole.x + hole.w, y: hole.y, w: EDGE_PX, h: hole.h }, EDGE);
                    fill(window, hole, HOLE);
                }
                _ => fill(window, Rect { x: 0, y: 0, w: width, h: height }, DIM),
            }
            let _ = EndPaint(hwnd, &painting);
        }
    }

    /// Whether `window` belongs to another process: one the keyboard goes back to.
    fn of_another_app(window: HWND) -> bool {
        if window.0.is_null() || !unsafe { IsWindow(Some(window)) }.as_bool() {
            return false;
        }
        let mut process = 0u32;
        unsafe { GetWindowThreadProcessId(window, Some(&mut process as *mut u32)) };
        process != 0 && process != unsafe { GetCurrentProcessId() }
    }

    /// Puts the window in front with the keyboard, for Esc. Windows grants it
    /// to the app that just took a click or a shortcut, which is how a
    /// selection starts; when it does not, the window still takes the mouse,
    /// and its timer looks for Esc. Nothing is forced: joining the input of
    /// the app in front would hang this window with it if that app hangs.
    fn take_keyboard(hwnd: HWND) {
        unsafe {
            let _ = SetForegroundWindow(hwnd);
            let _ = SetFocus(Some(hwnd));
        }
    }

    /// The area the user drags out on `display`, in desktop px; `None` when it
    /// was cancelled. Blocks, running the window's messages on this thread.
    /// `shown` false keeps the window off the screen (the tests post it the
    /// messages a mouse would).
    pub fn select_area(display: Rect, shown: bool) -> Option<Rect> {
        unsafe {
            let instance = HINSTANCE(GetModuleHandleW(None).ok()?.0);
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(overlay_proc),
                hInstance: instance,
                hCursor: LoadCursorW(None, IDC_CROSS).unwrap_or_default(),
                lpszClassName: CLASS,
                ..Default::default()
            };
            // Zero when it is registered already: creating the window says if it is not.
            RegisterClassExW(&class);

            DRAG.set(Drag { bounds: Rect { x: 0, y: 0, w: display.w, h: display.h }, ..Default::default() });
            let front = GetForegroundWindow();
            let created = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                CLASS,
                w!("Liv"),
                WS_POPUP,
                display.x,
                display.y,
                display.w,
                display.h,
                None,
                None,
                Some(instance),
                None,
            );
            let hwnd = match created {
                Ok(hwnd) => hwnd,
                Err(err) => {
                    crate::log::line(format!("capture: no window to select on: {err}"));
                    return None;
                }
            };
            // Everything painted is seen through by DIM_ALPHA, and what is
            // painted in HOLE is not there at all.
            let _ = SetLayeredWindowAttributes(hwnd, HOLE, DIM_ALPHA, LWA_ALPHA | LWA_COLORKEY);
            if shown {
                let _ = ShowWindow(hwnd, SW_SHOW);
                take_keyboard(hwnd);
                SetTimer(Some(hwnd), WATCH, WATCH_MS, None);
            }

            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                DispatchMessageW(&message);
            }

            // The app that was being used has the keyboard again.
            if shown && of_another_app(front) && GetForegroundWindow() != front {
                let _ = SetForegroundWindow(front);
            }
            let picked = DRAG.get().picked?;
            if shown {
                // The window is gone from the next frame on.
                let _ = DwmFlush();
            }
            Some(Rect { x: display.x + picked.x, y: display.y + picked.y, ..picked })
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, PostMessageW};

        fn lparam(x: i32, y: i32) -> LPARAM {
            LPARAM(((y as u16 as u32) << 16 | (x as u16 as u32)) as isize)
        }

        /// The window as a script finds it, once it is there.
        fn overlay() -> isize {
            (0..500)
                .find_map(|_| {
                    let found = unsafe { FindWindowW(CLASS, None) }.ok().filter(|hwnd| !hwnd.0.is_null());
                    if found.is_none() {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    found.map(|hwnd| hwnd.0 as isize)
                })
                .expect("the window is there")
        }

        fn post(window: isize, message: u32, wparam: usize, lparam: LPARAM) {
            unsafe { PostMessageW(Some(HWND(window as *mut _)), message, WPARAM(wparam), lparam) }.expect("posted");
        }

        /// The window itself and its procedure, for real but never on screen:
        /// it is not shown, takes no keyboard and looks at no key. One test:
        /// there is one such window at a time.
        #[test]
        fn the_window_selects_from_plain_mouse_messages_and_cancels_on_esc_or_a_right_click() {
            let display = Rect { x: 100, y: 50, w: 800, h: 600 };
            let select = |act: fn(isize)| {
                let selecting = std::thread::spawn(move || select_area(display, false));
                act(overlay());
                selecting.join().unwrap()
            };

            // Down, across, up: the rectangle, in desktop px.
            let picked = select(|window| {
                post(window, WM_LBUTTONDOWN, 1, lparam(10, 20));
                post(window, WM_MOUSEMOVE, 1, lparam(200, 150));
                post(window, WM_LBUTTONUP, 0, lparam(310, 220));
            });
            assert_eq!(picked, Some(Rect { x: 110, y: 70, w: 300, h: 200 }));

            // Dragged up and to the left, and past the window's edge: the same way, kept inside.
            let picked = select(|window| {
                post(window, WM_LBUTTONDOWN, 1, lparam(300, 200));
                post(window, WM_LBUTTONUP, 0, lparam(-40, -40));
            });
            assert_eq!(picked, Some(Rect { x: 100, y: 50, w: 300, h: 200 }));

            // Too small to be meant.
            let picked = select(|window| {
                post(window, WM_LBUTTONDOWN, 1, lparam(300, 200));
                post(window, WM_LBUTTONUP, 0, lparam(302, 260));
            });
            assert_eq!(picked, None);

            // Esc, before or in the middle of a drag; the right button; a move
            // or a release with no button down selects nothing.
            let picked = select(|window| {
                post(window, WM_MOUSEMOVE, 0, lparam(50, 50));
                post(window, WM_LBUTTONUP, 0, lparam(400, 400));
                post(window, WM_LBUTTONDOWN, 1, lparam(10, 20));
                post(window, WM_MOUSEMOVE, 1, lparam(200, 150));
                post(window, WM_KEYDOWN, usize::from(VK_ESCAPE.0), LPARAM(0));
            });
            assert_eq!(picked, None);
            let picked = select(|window| {
                post(window, WM_LBUTTONDOWN, 1, lparam(10, 20));
                post(window, WM_RBUTTONDOWN, 2, lparam(200, 150));
            });
            assert_eq!(picked, None);
            // Another key is not Esc.
            let picked = select(|window| {
                post(window, WM_KEYDOWN, 0x41, LPARAM(0));
                post(window, WM_LBUTTONDOWN, 1, lparam(0, 0));
                post(window, WM_LBUTTONUP, 0, lparam(8, 8));
            });
            assert_eq!(picked, Some(Rect { x: 100, y: 50, w: 8, h: 8 }));
        }

        /// A bitmap made here, in memory — nothing of the screen is read: its
        /// pixels come back top row first, each colour in its place.
        #[test]
        fn a_bitmaps_pixels_are_read_top_row_first_in_their_colours() {
            let (width, height) = (5, 3);
            let image = unsafe {
                let screen = GetDC(None);
                let memory = CreateCompatibleDC(Some(screen));
                let bitmap = CreateCompatibleBitmap(screen, width, height);
                ReleaseDC(None, screen);
                assert!(!memory.is_invalid() && !bitmap.is_invalid());
                let before = SelectObject(memory, bitmap.into());
                let fill = |rect: Rect, colour: u32| {
                    let brush = CreateSolidBrush(COLORREF(colour));
                    FillRect(memory, &win_rect(rect), brush);
                    let _ = DeleteObject(brush.into());
                };
                // COLORREF is 0x00BBGGRR: a red top row, a green one, and a
                // bottom row that is blue but for its last pixel, white.
                fill(Rect { x: 0, y: 0, w: width, h: 1 }, 0x0000_00FF);
                fill(Rect { x: 0, y: 1, w: width, h: 1 }, 0x0000_FF00);
                fill(Rect { x: 0, y: 2, w: width, h: 1 }, 0x00FF_0000);
                fill(Rect { x: width - 1, y: 2, w: 1, h: 1 }, 0x00FF_FFFF);
                SelectObject(memory, before);
                let _ = DeleteDC(memory);
                // Read the way a shot of the screen is, and freed with it.
                Shot(bitmap.0 as isize).image().expect("its pixels")
            };
            assert_eq!((image.width, image.height), (5, 3));
            let pixel = |x: usize, y: usize| &image.pixels[(y * 5 + x) * 4..(y * 5 + x) * 4 + 4];
            for x in 0..5 {
                assert_eq!(pixel(x, 0), [255, 0, 0, 255], "red, {x}");
                assert_eq!(pixel(x, 1), [0, 255, 0, 255], "green, {x}");
            }
            assert_eq!(pixel(0, 2), [0, 0, 255, 255]);
            assert_eq!(pixel(3, 2), [0, 0, 255, 255]);
            assert_eq!(pixel(4, 2), [255, 255, 255, 255]);
            // Nothing to take: no shot.
            assert!(Shot::take(Rect { x: 0, y: 0, w: 0, h: 10 }).is_none());
            assert!(Shot::take(Rect { x: 0, y: 0, w: 10, h: -1 }).is_none());
            assert!(Shot::take(Rect { x: 0, y: 0, w: MAX_SIDE + 1, h: 10 }).is_none());
        }

        #[test]
        fn only_one_selection_at_a_time() {
            let first = Selecting::begin().expect("nothing is up");
            assert!(selecting());
            assert!(Selecting::begin().is_none(), "a second one is refused");
            drop(first);
            assert!(!selecting());
            assert!(Selecting::begin().is_some());
        }

        /// Reads the real screen (nothing is saved, nothing copied): run by
        /// hand, `cargo test -p liv -- --ignored real_desktop`.
        #[test]
        #[ignore]
        fn real_desktop_the_display_under_the_pointer_is_grabbed_whole_and_opaque() {
            let display = monitor_under_cursor().expect("a display");
            assert!(display.w > 0 && display.h > 0);
            let image = grab(display).expect("a picture");
            assert_eq!((image.width as i32, image.height as i32), (display.w, display.h));
            assert!(image.pixels.chunks_exact(4).all(|p| p[3] == 255));
            let corner = grab(Rect { w: 16, h: 16, ..display }).expect("a corner of it");
            assert_eq!((corner.width, corner.height), (16, 16));
            assert_eq!(&corner.pixels[..64], &image.pixels[..64]);
            assert!(pictures_dir().is_some_and(|dir| dir.is_absolute()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::dib_to_rgba;

    const DISPLAY: Rect = Rect { x: 0, y: 0, w: 1920, h: 1080 };

    #[test]
    fn a_selection_is_the_rectangle_between_two_points_whichever_way_the_drag_went() {
        let expected = Some(Rect { x: 100, y: 200, w: 300, h: 150 });
        assert_eq!(selection((100, 200), (400, 350), DISPLAY), expected);
        assert_eq!(selection((400, 350), (100, 200), DISPLAY), expected);
        assert_eq!(selection((400, 200), (100, 350), DISPLAY), expected);
        assert_eq!(selection((100, 350), (400, 200), DISPLAY), expected);
    }

    #[test]
    fn a_selection_is_kept_inside_the_display() {
        // The pointer went past every edge while the button was down.
        assert_eq!(selection((1800, 1000), (2500, 1300), DISPLAY), Some(Rect { x: 1800, y: 1000, w: 120, h: 80 }));
        assert_eq!(selection((50, 60), (-300, -10), DISPLAY), Some(Rect { x: 0, y: 0, w: 50, h: 60 }));
        assert_eq!(selection((-5, -5), (5000, 5000), DISPLAY), Some(DISPLAY));
        // A display to the left of the main one, and above it: its own coordinates.
        let left = Rect { x: -2560, y: -200, w: 2560, h: 1440 };
        assert_eq!(selection((-2000, 0), (-1000, 500), left), Some(Rect { x: -2000, y: 0, w: 1000, h: 500 }));
        assert_eq!(selection((-3000, -900), (-2500, -100), left), Some(Rect { x: -2560, y: -200, w: 60, h: 100 }));
        assert_eq!(selection((-100, 1000), (400, 2000), left), Some(Rect { x: -100, y: 1000, w: 100, h: 240 }));
        // Both ends outside, on the same side: nothing of the display is in it.
        assert_eq!(selection((2000, 10), (3000, 500), DISPLAY), None);
    }

    #[test]
    fn a_selection_smaller_than_four_pixels_a_side_cancels() {
        assert_eq!(selection((10, 10), (10, 10), DISPLAY), None, "a click");
        assert_eq!(selection((10, 10), (13, 400), DISPLAY), None);
        assert_eq!(selection((10, 10), (400, 13), DISPLAY), None);
        assert_eq!(selection((10, 10), (14, 14), DISPLAY), Some(Rect { x: 10, y: 10, w: 4, h: 4 }));
        assert_eq!(selection((14, 14), (10, 10), DISPLAY), Some(Rect { x: 10, y: 10, w: 4, h: 4 }));
        // What is drawn while dragging has no such rule, and may be empty.
        assert_eq!(span((10, 10), (12, 11), DISPLAY), Rect { x: 10, y: 10, w: 2, h: 1 });
        assert_eq!(span((10, 10), (10, 10), DISPLAY), Rect { x: 10, y: 10, w: 0, h: 0 });
        // A display with no size selects nothing, and panics on nothing.
        assert_eq!(selection((0, 0), (100, 100), Rect::default()), None);
        assert_eq!(selection((i32::MIN, i32::MIN), (i32::MAX, i32::MAX), DISPLAY), Some(DISPLAY));
    }

    #[test]
    fn a_screenshot_is_named_for_its_moment_in_the_apps_language() {
        let time = LocalTime { year: 2026, month: 11, day: 17, hour: 15, minute: 53, second: 7 };
        assert_eq!(file_stem(&time), "Screenshot 2026-11-17 15.53.07");
        crate::i18n::set_for_test("es");
        assert_eq!(file_stem(&time), "Captura 2026-11-17 15.53.07");
        crate::i18n::set_for_test("en");
        let early = LocalTime { year: 2027, month: 1, day: 2, hour: 3, minute: 4, second: 5 };
        assert_eq!(file_stem(&early), "Screenshot 2027-01-02 03.04.05");
        // Nothing in it that a file name cannot have.
        assert!(!file_stem(&time).contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']));
    }

    #[test]
    fn a_screenshot_never_takes_the_name_of_another() {
        let dir = std::env::temp_dir().join(format!("liv-capture-{}", std::process::id())).join("Pictures").join("Liv");
        let _ = std::fs::remove_dir_all(&dir);
        let stem = "Captura 2026-11-17 15.53.07";

        // The folder is made on the way.
        let first = save_png(&dir, stem, b"one").unwrap();
        assert_eq!(first, dir.join("Captura 2026-11-17 15.53.07.png"));
        let second = save_png(&dir, stem, b"two").unwrap();
        assert_eq!(second, dir.join("Captura 2026-11-17 15.53.07 (2).png"));
        let third = save_png(&dir, stem, b"three").unwrap();
        assert_eq!(third, dir.join("Captura 2026-11-17 15.53.07 (3).png"));
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
        assert_eq!(std::fs::read(&second).unwrap(), b"two");
        assert_eq!(std::fs::read(&third).unwrap(), b"three");
        // A name that was freed is taken again; another moment has its own.
        std::fs::remove_file(&second).unwrap();
        assert_eq!(save_png(&dir, stem, b"again").unwrap(), second);
        assert_eq!(save_png(&dir, "Captura 2026-11-17 15.53.08", b"next").unwrap(), dir.join("Captura 2026-11-17 15.53.08.png"));
        // Nowhere to write: an error, not a panic.
        let blocked = dir.join("Captura 2026-11-17 15.53.08.png").join("inside");
        assert!(save_png(&blocked, stem, b"x").is_err());

        let _ = std::fs::remove_dir_all(dir.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn screen_pixels_are_read_as_blue_green_red_and_are_opaque() {
        // Blue, green, red, and a fourth byte the screen leaves at anything.
        let bgra = [255, 0, 0, 0, 0, 255, 0, 77, 0, 0, 255, 255, 0x54, 0xB9, 0x1D, 0];
        let image = bgra_to_rgba(&bgra, 2, 2, Alpha::Ignored).unwrap();
        assert_eq!((image.width, image.height), (2, 2));
        assert_eq!(image.pixels, [0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0x1D, 0xB9, 0x54, 255]);
        // Not the pixels the size says: nothing.
        assert_eq!(bgra_to_rgba(&bgra, 2, 1, Alpha::Ignored), None);
        assert_eq!(bgra_to_rgba(&bgra[..15], 2, 2, Alpha::Ignored), None);
        assert_eq!(bgra_to_rgba(&[], 0, 0, Alpha::Ignored), None);
        assert_eq!(bgra_to_rgba(&[], u32::MAX, u32::MAX, Alpha::Ignored), None);
    }

    #[test]
    fn an_icons_pixels_get_their_colours_back_from_under_their_alpha() {
        // Half-opaque red, stored as (0, 0, 128, 128); nothing at all; opaque white.
        let bgra = [0, 0, 128, 128, 9, 9, 9, 0, 255, 255, 255, 255];
        let image = bgra_to_rgba(&bgra, 3, 1, Alpha::Premultiplied).unwrap();
        assert_eq!(image.pixels, [255, 0, 0, 128, 0, 0, 0, 0, 255, 255, 255, 255]);
        // A thumbnail of a photo has no alpha at all: opaque, its colours as they are.
        let photo = [10, 20, 30, 0, 40, 50, 60, 0];
        assert_eq!(bgra_to_rgba(&photo, 2, 1, Alpha::Premultiplied).unwrap().pixels, [30, 20, 10, 255, 60, 50, 40, 255]);
        // A colour brighter than its alpha allows stays a colour.
        assert_eq!(bgra_to_rgba(&[200, 0, 0, 100], 1, 1, Alpha::Premultiplied).unwrap().pixels, [0, 0, 255, 100]);
    }

    #[test]
    fn the_clipboards_bitmap_holds_the_picture_bottom_row_first_with_its_rows_padded() {
        const RED: [u8; 4] = [255, 0, 0, 255];
        const GREEN: [u8; 4] = [0, 255, 0, 255];
        const BLUE: [u8; 4] = [0, 0, 255, 255];
        const WHITE: [u8; 4] = [255, 255, 255, 255];
        // 3 × 2: rows of 9 bytes, padded to 12.
        let picture = Rgba { width: 3, height: 2, pixels: [RED, GREEN, BLUE, WHITE, RED, GREEN].concat() };
        let dib = rgba_to_dib(&picture).unwrap();
        assert_eq!(dib.len(), 40 + 2 * 12);
        assert_eq!(&dib[..4], &40u32.to_le_bytes());
        assert_eq!(&dib[4..8], &3i32.to_le_bytes());
        assert_eq!(&dib[8..12], &2i32.to_le_bytes(), "a positive height: bottom-up");
        assert_eq!(&dib[14..16], &24u16.to_le_bytes());
        assert_eq!(&dib[16..20], &0u32.to_le_bytes());
        // The bottom row comes first, each pixel blue, green, red.
        assert_eq!(&dib[40..52], &[255, 255, 255, 0, 0, 255, 0, 255, 0, 0, 0, 0]);
        // What the clipboard history reads back is the picture.
        assert_eq!(dib_to_rgba(&dib), Some(picture));
        // A width that needs no padding, and one pixel.
        let wide = Rgba { width: 4, height: 1, pixels: [RED, GREEN, BLUE, WHITE].concat() };
        assert_eq!(dib_to_rgba(&rgba_to_dib(&wide).unwrap()), Some(wide));
        let one = Rgba { width: 1, height: 1, pixels: BLUE.to_vec() };
        assert_eq!(dib_to_rgba(&rgba_to_dib(&one).unwrap()), Some(one));
        // Alpha is not carried: the screen has none.
        let faint = Rgba { width: 1, height: 1, pixels: vec![1, 2, 3, 40] };
        assert_eq!(dib_to_rgba(&rgba_to_dib(&faint).unwrap()).unwrap().pixels, [1, 2, 3, 255]);
        // Pixels that do not match the size, or no size: nothing.
        assert_eq!(rgba_to_dib(&Rgba { width: 2, height: 2, pixels: vec![0; 15] }), None);
        assert_eq!(rgba_to_dib(&Rgba { width: 0, height: 0, pixels: vec![] }), None);
    }

    #[test]
    fn the_island_hears_what_was_taken_or_only_that_nothing_was() {
        let taken = Captured::taken(Some(7), "Captura 2026-11-17 15.53.07.png".into(), 1920, 1080);
        assert_eq!(
            serde_json::to_value(&taken).unwrap(),
            serde_json::json!({ "ok": true, "id": 7, "name": "Captura 2026-11-17 15.53.07.png", "width": 1920, "height": 1080 })
        );
        assert_eq!(
            serde_json::to_value(&taken).unwrap().as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
            ["ok", "id", "name", "width", "height"]
        );
        assert_eq!(serde_json::to_value(Captured::failed()).unwrap(), serde_json::json!({ "ok": false }));
        // Saved, but the shelf would not have it: still taken, with no item to point at.
        let unshelved = serde_json::to_value(Captured::taken(None, "a.png".into(), 4, 4)).unwrap();
        assert_eq!(unshelved, serde_json::json!({ "ok": true, "name": "a.png", "width": 4, "height": 4 }));
    }
}
