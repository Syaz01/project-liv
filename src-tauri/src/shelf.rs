// The shelf, for the island's Tools view: files kept at hand. Dropped on it,
// a file can later be dragged out into any app, copied, opened, or shown in
// its folder. Screenshots (capture.rs) land on it too.
//
// An item is a reference to the file where it is: nothing is copied, and
// nothing here ever moves, changes or deletes a file. The list — paths and
// times, nothing else — is kept in shelf.json next to the log, read when Liv
// starts; what is no longer there by then is dropped from it.
//
// The page names an item by its id, never by a path, and can only put on the
// shelf a path that a real drop just delivered (files.rs): it cannot make Liv
// open a file the user did not bring.
//
// Windows: thumbnails and icons come from the shell, made on a thread of
// their own and remembered by path and modification time; the drag out of the
// island is the shell's own (OLE), with the shell's data object for the file.
// Elsewhere the list works and the rest is inert.

// Off Windows nothing asks the shell, so what it would be asked for has no caller.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// The island's event: the whole list, on every change.
const EVENT: &str = "shelf";

/// How many items the shelf holds; the oldest make room.
pub const MAX_ITEMS: usize = 24;
/// The side of the square a thumbnail is asked for in, px.
pub const THUMB_PX: i32 = 96;
/// The list's file, in Liv's local folder.
const FILE: &str = "shelf.json";

// ── The list ──────────────────────────────────────────────────────────────────

/// One file on the shelf.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub id: u64,
    pub path: String,
    /// When it was put there, or put there again, last: Unix ms.
    pub added_at: u64,
}

/// Whether two paths name the same file, as far as their spelling tells:
/// Windows does not tell upper case from lower.
fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

/// The shelf itself: newest first, each item with an id that is never used twice.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Shelf {
    items: Vec<Item>,
    last_id: u64,
}

/// shelf.json: what is on the shelf, newest first.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    items: Vec<StoredItem>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredItem {
    path: String,
    #[serde(default)]
    added_at: u64,
}

impl Shelf {
    /// `path` is put on the shelf at `at`, on top. One that is there already
    /// moves to the top instead of appearing twice. Its id.
    pub fn add(&mut self, path: &str, at: u64) -> u64 {
        if let Some(index) = self.items.iter().position(|item| same_path(&item.path, path)) {
            let mut item = self.items.remove(index);
            item.added_at = at;
            let id = item.id;
            self.items.insert(0, item);
            return id;
        }
        self.last_id += 1;
        let id = self.last_id;
        self.items.insert(0, Item { id, path: path.to_string(), added_at: at });
        self.items.truncate(MAX_ITEMS);
        id
    }

    /// True when there was such an item.
    pub fn remove(&mut self, id: u64) -> bool {
        let before = self.items.len();
        self.items.retain(|item| item.id != id);
        self.items.len() != before
    }

    /// Empties the shelf. Ids are not reused. True when there was anything.
    pub fn clear(&mut self) -> bool {
        let had = !self.items.is_empty();
        self.items.clear();
        had
    }

    /// Drops what `there` says is gone. True when anything was dropped.
    pub fn prune(&mut self, there: impl Fn(&str) -> bool) -> bool {
        let before = self.items.len();
        self.items.retain(|item| there(&item.path));
        self.items.len() != before
    }

    /// The path of item `id`.
    pub fn path(&self, id: u64) -> Option<&str> {
        self.items.iter().find(|item| item.id == id).map(|item| item.path.as_str())
    }

    pub fn items(&self) -> &[Item] {
        &self.items
    }

    /// What was read from the file joins the shelf under what was put on it
    /// meanwhile: Liv reads its file off the main thread, and a drop may come
    /// first.
    pub fn absorb(&mut self, stored: Shelf) {
        for item in stored.items {
            if self.items.iter().any(|mine| same_path(&mine.path, &item.path)) {
                continue;
            }
            self.last_id += 1;
            self.items.push(Item { id: self.last_id, ..item });
        }
        self.items.truncate(MAX_ITEMS);
    }

    /// The list as it is written: paths and times, nothing else.
    pub fn to_json(&self) -> String {
        let stored = Stored {
            items: self.items.iter().map(|item| StoredItem { path: item.path.clone(), added_at: item.added_at }).collect(),
        };
        serde_json::to_string_pretty(&stored).unwrap_or_else(|_| "{}".into())
    }

    /// The list as it was written. Anything that is not one reads as an empty
    /// shelf; an entry that is not a full path, or is there twice, is left out.
    pub fn from_json(text: &str) -> Shelf {
        let stored: Stored = serde_json::from_str(text).unwrap_or_default();
        let mut items: Vec<Item> = Vec::new();
        for entry in stored.items {
            if items.len() == MAX_ITEMS {
                break;
            }
            if !Path::new(&entry.path).is_absolute() || items.iter().any(|item| same_path(&item.path, &entry.path)) {
                continue;
            }
            items.push(Item { id: 0, path: entry.path, added_at: entry.added_at });
        }
        // The newest has the highest id, as if they had been added one by one.
        let count = items.len() as u64;
        for (index, item) in items.iter_mut().enumerate() {
            item.id = count - index as u64;
        }
        Shelf { items, last_id: count }
    }
}

/// The shelf in `file`. No file, or one that cannot be read: an empty shelf.
pub fn read(file: &Path) -> Shelf {
    std::fs::read_to_string(file).map(|text| Shelf::from_json(&text)).unwrap_or_default()
}

/// Writes the shelf to `file`, whole or not at all: beside it first, then
/// over it. Its folder is made if it is not there, private to the user.
pub fn write(file: &Path, shelf: &Shelf) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        crate::platform::ensure_private_dir(dir)?;
    }
    let temp = file.with_extension(format!("json.liv-{}", std::process::id()));
    let written = std::fs::write(&temp, shelf.to_json()).and_then(|()| std::fs::rename(&temp, file));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

// ── What the page gets ────────────────────────────────────────────────────────

/// One item as the island shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: u64,
    pub path: String,
    /// The file's name, extension included.
    pub name: String,
    /// Bytes; 0 for a folder, or a file that has gone.
    pub size: u64,
    pub is_dir: bool,
    pub added_at: u64,
    /// A PNG data URL of its thumbnail or its type's icon; "" while there is none.
    pub thumb: String,
    /// The file is no longer where it was: the item can only be removed.
    pub missing: bool,
}

/// What the disk says of a file right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Facts {
    pub missing: bool,
    pub is_dir: bool,
    pub size: u64,
    /// When it last changed, Unix ms: a thumbnail made before that is stale.
    pub modified: u64,
}

pub fn facts(path: &str) -> Facts {
    match std::fs::metadata(path) {
        Ok(meta) => Facts {
            missing: false,
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified: meta
                .modified()
                .ok()
                .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since| since.as_millis() as u64)
                .unwrap_or(0),
        },
        Err(_) => Facts { missing: true, is_dir: false, size: 0, modified: 0 },
    }
}

/// The last part of a path: a file's name. A drive is its own name.
pub fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string())
}

pub fn entry(item: &Item, facts: Facts, thumb: String) -> Entry {
    Entry {
        id: item.id,
        path: item.path.clone(),
        name: file_name(&item.path),
        size: facts.size,
        is_dir: facts.is_dir,
        added_at: item.added_at,
        thumb: if facts.missing { String::new() } else { thumb },
        missing: facts.missing,
    }
}

/// A file as the clipboard holds it for Ctrl+V in Explorer or a chat app
/// (CF_HDROP): a 20-byte header that says where the names start and that
/// they are UTF-16, each path closed by a zero, and one more zero at the end.
pub fn hdrop_bytes(paths: &[&str]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&20u32.to_le_bytes());
    // No drop point, and not in a window's frame.
    bytes.extend_from_slice(&[0; 12]);
    bytes.extend_from_slice(&1u32.to_le_bytes());
    for path in paths {
        bytes.extend(path.encode_utf16().chain([0]).flat_map(u16::to_le_bytes));
    }
    bytes.extend_from_slice(&[0, 0]);
    bytes
}

// ── The app's shelf ───────────────────────────────────────────────────────────

/// A thumbnail that was made: for the file as it was at `modified`. `url` is
/// empty when the shell had nothing for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thumb {
    pub modified: u64,
    pub url: String,
}

#[derive(Default)]
struct State {
    shelf: Shelf,
    /// By path.
    thumbs: HashMap<String, Thumb>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State::default()));

fn state() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One write of shelf.json at a time, each of the shelf as it is by then.
static SAVE: Mutex<()> = Mutex::new(());

fn store() -> PathBuf {
    crate::settings::local_dir().join(FILE)
}

fn persist() {
    let _one = SAVE.lock().unwrap_or_else(PoisonError::into_inner);
    let shelf = state().shelf.clone();
    if let Err(err) = write(&store(), &shelf) {
        crate::log::line(format!("shelf: not saved: {err}"));
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The list for the page, and the thumbnails it still lacks: each a path and
/// the modification time it is wanted for. The disk is read with no lock
/// held: a file on a share that does not answer must not stop the rest.
pub fn listing(shelf: &Shelf, thumbs: &HashMap<String, Thumb>) -> (Vec<Entry>, Vec<(String, u64)>) {
    let mut wanted = Vec::new();
    let entries = shelf
        .items()
        .iter()
        .map(|item| {
            let facts = facts(&item.path);
            let thumb = thumbs.get(&item.path).filter(|thumb| thumb.modified == facts.modified);
            if thumb.is_none() && !facts.missing {
                wanted.push((item.path.clone(), facts.modified));
            }
            entry(item, facts, thumb.map(|thumb| thumb.url.clone()).unwrap_or_default())
        })
        .collect();
    (entries, wanted)
}

fn snapshot() -> (Vec<Entry>, Vec<(String, u64)>) {
    let (shelf, thumbs) = {
        let mut s = state();
        // The thumbnail of what left the shelf is forgotten.
        let State { shelf, thumbs } = &mut *s;
        thumbs.retain(|path, _| shelf.items().iter().any(|item| item.path == *path));
        (shelf.clone(), thumbs.clone())
    };
    listing(&shelf, &thumbs)
}

fn emit(app: &AppHandle, entries: Vec<Entry>) {
    let _ = app.emit_to(crate::island::WINDOW_LABEL, EVENT, entries);
}

/// The island hears the list as it is now, at once; the thumbnails it lacks
/// are made after, and the list comes again with them.
fn publish(app: &AppHandle) {
    let (entries, wanted) = snapshot();
    emit(app, entries);
    thumbs_later(app, wanted);
}

/// One thread makes thumbnails at a time.
static THUMBS: Mutex<()> = Mutex::new(());

#[cfg(windows)]
fn thumbs_later(app: &AppHandle, wanted: Vec<(String, u64)>) {
    if wanted.is_empty() {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("liv-shelf-thumbs".into()).spawn(move || {
        let _one = THUMBS.lock().unwrap_or_else(PoisonError::into_inner);
        let mut made = false;
        for (path, modified) in wanted {
            // Another list asked for the same one meanwhile, and it was made.
            if state().thumbs.get(&path).is_some_and(|thumb| thumb.modified == modified) {
                continue;
            }
            // Remembered even when the shell gave nothing: it is not asked again.
            let url = os::thumbnail(&path).unwrap_or_default();
            state().thumbs.insert(path, Thumb { modified, url });
            made = true;
        }
        if made {
            emit(&app, snapshot().0);
        }
    });
    if let Err(err) = spawned {
        crate::log::line(format!("shelf: no thumbnail thread: {err}"));
    }
}

#[cfg(not(windows))]
fn thumbs_later(_app: &AppHandle, _wanted: Vec<(String, u64)>) {}

/// At launch: the shelf is read from its file, off the main thread (a file on
/// a share that does not answer takes its time to say so). What has gone
/// since it was written is dropped.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("liv-shelf".into()).spawn(move || {
        let mut stored = read(&store());
        let pruned = stored.prune(|path| Path::new(path).exists());
        if stored.items().is_empty() && !pruned {
            return;
        }
        state().shelf.absorb(stored);
        if pruned {
            persist();
        }
        publish(&app);
    });
    if let Err(err) = spawned {
        crate::log::line(format!("shelf: not read: {err}"));
    }
}

/// What may be on the shelf: something that is there, by its full path.
pub fn shelvable(path: &str) -> bool {
    let path = Path::new(path);
    path.is_absolute() && path.exists()
}

/// Puts `path` on top of the shelf, from Rust: a screenshot just saved, the
/// original of a file Liv just took. Its id; `None` when there is no such file.
pub fn add_path(app: &AppHandle, path: &str) -> Option<u64> {
    if !shelvable(path) {
        return None;
    }
    let id = state().shelf.add(path, now_ms());
    persist();
    publish(app);
    Some(id)
}

/// `add_path` on a thread of its own, for a caller on the main thread.
pub fn add_later(app: &AppHandle, path: String) {
    let app = app.clone();
    let _ = std::thread::Builder::new().name("liv-shelf".into()).spawn(move || {
        add_path(&app, &path);
    });
}

/// The file of item `id`, when it is still there. When it has gone the page
/// hears the list again, and shows the item as missing.
fn present(app: &AppHandle, id: u64) -> Option<String> {
    let path = state().shelf.path(id).map(str::to_string)?;
    if Path::new(&path).exists() {
        Some(path)
    } else {
        publish(app);
        None
    }
}

// ── Commands (the island's alone) ─────────────────────────────────────────────
//
// All of them read the disk or ask the shell, which can take a moment: none
// runs on the main thread.

async fn off_main<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tauri::async_runtime::spawn_blocking(work).await.ok()
}

/// The list as it is now: the page asks as it starts and when the Tools view
/// comes up, which is also when a file that has gone is found out.
#[tauri::command]
pub async fn shelf_list(app: AppHandle, window: tauri::WebviewWindow) -> Result<Vec<Entry>, String> {
    crate::from_island(&window)?;
    let entries = off_main(move || {
        let (entries, wanted) = snapshot();
        thumbs_later(&app, wanted);
        entries
    })
    .await;
    Ok(entries.unwrap_or_default())
}

/// A file dropped on the shelf. Only a path that a real drop just delivered
/// is taken (files.rs), once: the page cannot shelve what the user did not bring.
#[tauri::command]
pub async fn shelf_add(app: AppHandle, window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    crate::from_island(&window)?;
    if !crate::files::take_dropped(&path) {
        return Err(crate::i18n::t("Only files dropped on the island can be added."));
    }
    off_main(move || add_path(&app, &path)).await;
    Ok(())
}

#[tauri::command]
pub async fn shelf_remove(app: AppHandle, window: tauri::WebviewWindow, id: u64) -> Result<(), String> {
    crate::from_island(&window)?;
    off_main(move || {
        if state().shelf.remove(id) {
            persist();
            publish(&app);
        }
    })
    .await;
    Ok(())
}

#[tauri::command]
pub async fn shelf_clear(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    crate::from_island(&window)?;
    off_main(move || {
        if state().shelf.clear() {
            persist();
            publish(&app);
        }
    })
    .await;
    Ok(())
}

/// Opens the item with the app Windows has for it. False when it could not,
/// or the file has gone.
#[tauri::command]
pub async fn shelf_open(app: AppHandle, window: tauri::WebviewWindow, id: u64) -> Result<bool, String> {
    crate::from_island(&window)?;
    Ok(off_main(move || present(&app, id).is_some_and(|path| os::open(&path))).await.unwrap_or(false))
}

/// Explorer, on the item's folder, with the item selected.
#[tauri::command]
pub async fn shelf_reveal(app: AppHandle, window: tauri::WebviewWindow, id: u64) -> Result<bool, String> {
    crate::from_island(&window)?;
    Ok(off_main(move || present(&app, id).is_some_and(|path| os::reveal(&path))).await.unwrap_or(false))
}

/// The file itself on the clipboard, for Ctrl+V in Explorer or a chat app:
/// "copied"; "gone" when the item or its file is no longer there; "failed"
/// when the clipboard would not take it.
#[tauri::command]
pub async fn shelf_copy(app: AppHandle, window: tauri::WebviewWindow, id: u64) -> Result<String, String> {
    crate::from_island(&window)?;
    let outcome = off_main(move || match present(&app, id) {
        Some(path) if os::copy(&path) => "copied",
        Some(_) => "failed",
        None => "gone",
    })
    .await;
    Ok(outcome.unwrap_or("failed").to_string())
}

/// The item is dragged out of the island: asked for by the page while the
/// button is still down, and answered when the file was let go, or the drag
/// given up. True when it was dropped somewhere that took it.
#[tauri::command]
pub async fn shelf_drag(app: AppHandle, window: tauri::WebviewWindow, id: u64) -> Result<bool, String> {
    crate::from_island(&window)?;
    Ok(off_main(move || present(&app, id).is_some_and(|path| os::drag(&app, path))).await.unwrap_or(false))
}

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod os {
    use super::*;
    use std::sync::mpsc;

    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{HWND, RPC_E_CHANGED_MODE, SIZE};
    use windows::Win32::Graphics::Gdi::DeleteObject;
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, IDataObject, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
    use windows::Win32::System::Ole::{
        IDropSource, OleInitialize, OleUninitialize, DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_NONE,
    };
    use windows::Win32::UI::Shell::{
        BHID_DataObject, ILCreateFromPathW, ILFree, IShellItem, IShellItemImageFactory, SHCreateItemFromParsingName,
        SHDoDragDrop, SHOpenFolderAndSelectItems, ShellExecuteExW, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
        SIIGBF_RESIZETOFIT,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    use crate::capture::{bgra_to_rgba, win::bitmap_bgra, Alpha};
    use crate::clipboard::{png_bytes, scale_down, thumb_size};

    /// Runs `work` with COM ready on this thread, in a single-threaded
    /// apartment as the shell wants. `None` when COM would not start.
    fn with_com<T>(work: impl FnOnce() -> T) -> Option<T> {
        unsafe {
            let started = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
            // A thread of the runtime may already be in another apartment:
            // it is used as it is, and left as it was.
            if started.is_err() && started != RPC_E_CHANGED_MODE {
                return None;
            }
            let out = work();
            if started.is_ok() {
                CoUninitialize();
            }
            Some(out)
        }
    }

    /// The shell's picture of a file, as a PNG data URL: a thumbnail of an
    /// image or a video, the type's icon for anything else.
    pub fn thumbnail(path: &str) -> Option<String> {
        with_com(|| unsafe {
            let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(path), None).ok()?;
            let bitmap = factory.GetImage(SIZE { cx: THUMB_PX, cy: THUMB_PX }, SIIGBF_RESIZETOFIT).ok()?;
            let pixels = bitmap_bgra(bitmap);
            let _ = DeleteObject(bitmap.into());
            let (width, height, bgra) = pixels?;
            let image = bgra_to_rgba(&bgra, width, height, Alpha::Premultiplied)?;
            let (width, height) = thumb_size(image.width, image.height);
            let png = png_bytes(&scale_down(&image, width, height))?;
            Some(format!("data:image/png;base64,{}", crate::claude::base64_for(&png)))
        })
        .flatten()
    }

    /// The app Windows opens this kind of file with — or its own "open with"
    /// when it has none.
    pub fn open(path: &str) -> bool {
        let file = HSTRING::from(path);
        with_com(|| unsafe {
            let mut info = SHELLEXECUTEINFOW {
                cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
                // This thread runs no messages: the call must be over when it returns.
                fMask: SEE_MASK_NOASYNC,
                lpVerb: w!("open"),
                lpFile: PCWSTR(file.as_ptr()),
                nShow: SW_SHOWNORMAL.0,
                ..Default::default()
            };
            ShellExecuteExW(&mut info).is_ok()
        })
        .unwrap_or(false)
    }

    /// Explorer on the file's folder, with the file selected.
    pub fn reveal(path: &str) -> bool {
        let file = HSTRING::from(path);
        with_com(|| unsafe {
            let item = ILCreateFromPathW(&file);
            if item.is_null() {
                return false;
            }
            // No list of children: the item itself is what its folder opens on.
            let shown = SHOpenFolderAndSelectItems(item, None, 0).is_ok();
            ILFree(Some(item as *const _));
            shown
        })
        .unwrap_or(false)
    }

    /// The file on the clipboard, to be pasted as a copy: never a cut.
    pub fn copy(path: &str) -> bool {
        let files = hdrop_bytes(&[path]);
        let effect = unsafe { RegisterClipboardFormatW(w!("Preferred DropEffect")) };
        let copy = DROPEFFECT_COPY.0.to_le_bytes();
        if effect == 0 {
            return crate::clipboard::put(&[(crate::clipboard::CF_HDROP, &files)]);
        }
        crate::clipboard::put(&[(crate::clipboard::CF_HDROP, &files), (effect, &copy)])
    }

    /// The drag itself. It runs on the main thread, which owns the island's
    /// window, and stays there until the file is let go.
    pub fn drag(app: &AppHandle, path: String) -> bool {
        let Some(island) = crate::island::window(app) else { return false };
        let Some(hwnd) = island.hwnd().ok().map(|hwnd| hwnd.0 as isize).filter(|raw| *raw != 0) else { return false };
        let (done, wait) = mpsc::channel();
        let asked = app.run_on_main_thread(move || {
            let _ = done.send(drag_on_main(hwnd, &path));
        });
        asked.is_ok() && wait.recv().unwrap_or(false)
    }

    fn drag_on_main(island: isize, path: &str) -> bool {
        // The button came up before this ran: a drag started now would stick
        // to the pointer until the next click.
        if !crate::platform::left_button_down() {
            return false;
        }
        unsafe {
            // A drag needs OLE on this thread. The windowing layer starts it
            // for its own drops; asked again it only counts one more, which is
            // given back below.
            let ole = OleInitialize(None);
            let dropped = (|| {
                // The shell's own data object for the file: every format an app
                // may ask a dragged file for, and the file's icon under the pointer.
                let item = SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(path), None).ok()?;
                let data = item.BindToHandler::<_, IDataObject>(None, &BHID_DataObject).ok()?;
                // Copy or link, never move: the file stays where it is. No drop
                // source of ours: the shell's default one.
                SHDoDragDrop(Some(HWND(island as *mut _)), &data, None::<&IDropSource>, DROPEFFECT_COPY | DROPEFFECT_LINK)
                    .ok()
            })();
            if ole.is_ok() {
                OleUninitialize();
            }
            dropped.is_some_and(|effect| effect != DROPEFFECT_NONE)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Asks the real shell for a picture of this very program, and opens
        /// nothing: run by hand, `cargo test -p liv -- --ignored real_desktop`.
        #[test]
        #[ignore]
        fn real_desktop_the_shell_gives_a_picture_of_a_file_and_of_a_folder() {
            let exe = std::env::current_exe().unwrap();
            for path in [exe.clone(), exe.parent().unwrap().to_path_buf()] {
                let url = thumbnail(&path.to_string_lossy()).expect("a picture");
                assert!(url.starts_with("data:image/png;base64,iVBOR"), "{}", &url[..40.min(url.len())]);
            }
            assert_eq!(thumbnail("Z:\\liv-test\\not-there.txt"), None);
        }
    }
}

#[cfg(not(windows))]
mod os {
    use super::*;

    pub fn open(_path: &str) -> bool {
        false
    }

    pub fn reveal(_path: &str) -> bool {
        false
    }

    pub fn copy(_path: &str) -> bool {
        false
    }

    pub fn drag(_app: &AppHandle, _path: String) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A full path on this system, for a file that need not exist.
    fn full(name: &str) -> String {
        std::env::temp_dir().join("liv-shelf-paths").join(name).to_string_lossy().to_string()
    }

    fn paths(shelf: &Shelf) -> Vec<&str> {
        shelf.items().iter().map(|item| item.path.as_str()).collect()
    }

    fn ids(shelf: &Shelf) -> Vec<u64> {
        shelf.items().iter().map(|item| item.id).collect()
    }

    /// A folder of its own for one test, emptied first.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("liv-shelf-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ── The list ──────────────────────────────────────────────────────────────

    #[test]
    fn the_newest_item_is_first_and_every_item_has_its_own_id() {
        let mut shelf = Shelf::default();
        assert_eq!(shelf.add("/a/one.txt", 10), 1);
        assert_eq!(shelf.add("/a/two.png", 20), 2);
        assert_eq!(shelf.add("/a/folder", 30), 3);
        assert_eq!(paths(&shelf), ["/a/folder", "/a/two.png", "/a/one.txt"]);
        assert_eq!(ids(&shelf), [3, 2, 1]);
        assert_eq!(shelf.items()[2], Item { id: 1, path: "/a/one.txt".into(), added_at: 10 });
        assert_eq!(shelf.path(2), Some("/a/two.png"));
        assert_eq!(shelf.path(9), None);
    }

    #[test]
    fn the_same_path_added_again_moves_to_the_top_instead_of_appearing_twice() {
        let mut shelf = Shelf::default();
        shelf.add("/a/one.txt", 10);
        shelf.add("/a/two.png", 20);
        shelf.add("/a/three.pdf", 30);
        assert_eq!(shelf.add("/a/one.txt", 40), 1, "it keeps its id");
        assert_eq!(ids(&shelf), [1, 3, 2]);
        assert_eq!(shelf.items()[0].added_at, 40);
        // Already on top: it stays, with the new time.
        assert_eq!(shelf.add("/a/one.txt", 50), 1);
        assert_eq!(ids(&shelf), [1, 3, 2]);
        assert_eq!(shelf.items()[0].added_at, 50);
        // Another file of the same name elsewhere is another item.
        assert_eq!(shelf.add("/b/one.txt", 60), 4);
        assert_eq!(shelf.items().len(), 4);
        // Windows does not tell upper case from lower; elsewhere they are two files.
        let again = shelf.add("/A/ONE.TXT", 70);
        if cfg!(windows) {
            assert_eq!(again, 1);
            assert_eq!(shelf.items()[0].path, "/a/one.txt", "as it was first spelled");
        } else {
            assert_eq!(again, 5);
        }
    }

    #[test]
    fn at_most_twenty_four_items_are_kept_and_the_oldest_go() {
        let mut shelf = Shelf::default();
        for n in 0..(MAX_ITEMS as u64 + 6) {
            shelf.add(&format!("/a/file-{n}.txt"), n);
        }
        assert_eq!(shelf.items().len(), MAX_ITEMS);
        assert_eq!(MAX_ITEMS, 24);
        assert_eq!(shelf.items()[0].path, "/a/file-29.txt");
        assert_eq!(shelf.items()[MAX_ITEMS - 1].path, "/a/file-6.txt");
        // One that is there moves up and pushes nothing off.
        shelf.add("/a/file-6.txt", 99);
        assert_eq!(shelf.items().len(), MAX_ITEMS);
        assert_eq!(shelf.items()[MAX_ITEMS - 1].path, "/a/file-7.txt");
    }

    #[test]
    fn removing_and_clearing_forget_items_and_never_reuse_an_id() {
        let mut shelf = Shelf::default();
        shelf.add("/a/one.txt", 10);
        shelf.add("/a/two.png", 20);
        assert!(shelf.remove(1));
        assert!(!shelf.remove(1));
        assert_eq!(ids(&shelf), [2]);
        assert!(shelf.clear());
        assert!(!shelf.clear());
        assert!(shelf.items().is_empty());
        assert_eq!(shelf.path(2), None);
        assert_eq!(shelf.add("/a/one.txt", 30), 3);
    }

    #[test]
    fn pruning_drops_what_is_gone_and_keeps_the_rest_in_order() {
        let mut shelf = Shelf::default();
        for name in ["one", "two", "three", "four"] {
            shelf.add(&format!("/a/{name}"), 1);
        }
        assert!(shelf.prune(|path| !path.ends_with("two") && !path.ends_with("four")));
        assert_eq!(paths(&shelf), ["/a/three", "/a/one"]);
        assert_eq!(ids(&shelf), [3, 1]);
        assert!(!shelf.prune(|_| true), "nothing was gone");
        assert!(shelf.prune(|_| false));
        assert!(shelf.items().is_empty());
    }

    // ── The file ──────────────────────────────────────────────────────────────

    #[test]
    fn the_list_is_written_as_paths_and_times_and_read_back_as_it_was() {
        let dir = scratch("round-trip");
        // In a folder that is not there yet: it is made.
        let file = dir.join("local").join("shelf.json");
        let mut shelf = Shelf::default();
        shelf.add(&full("one.txt"), 10);
        shelf.add(&full("carpeta ñ 你好"), 20);
        shelf.add(&full("two.png"), 30);
        shelf.remove(1);
        write(&file, &shelf).unwrap();

        // Paths and times, nothing else: no id, no thumbnail, no size.
        let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "items": [
                { "path": full("two.png"), "addedAt": 30 },
                { "path": full("carpeta ñ 你好"), "addedAt": 20 },
            ] })
        );

        let loaded = read(&file);
        assert_eq!(paths(&loaded), paths(&shelf));
        assert_eq!(loaded.items().iter().map(|item| item.added_at).collect::<Vec<_>>(), [30, 20]);
        // Ids start over, each its own, and the next one added gets a new one.
        assert_eq!(ids(&loaded), [2, 1]);
        let mut loaded = loaded;
        assert_eq!(loaded.add(&full("three.pdf"), 40), 3);

        // Written again over itself, and nothing is left beside it.
        write(&file, &loaded).unwrap();
        assert_eq!(read(&file), loaded);
        let left: Vec<String> =
            std::fs::read_dir(file.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(left, ["shelf.json"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_corrupt_file_reads_as_an_empty_shelf() {
        let dir = scratch("corrupt");
        let file = dir.join("shelf.json");
        assert_eq!(read(&file), Shelf::default(), "no file");
        for broken in ["", "{", "not json", "[]", "null", "7", r#"{"items":"all of them"}"#, r#"{"items":[{"addedAt":3}]}"#] {
            std::fs::write(&file, broken).unwrap();
            assert_eq!(read(&file), Shelf::default(), "{broken:?}");
        }
        // Not text at all.
        std::fs::write(&file, [0xFF, 0xFE, 0x00, 0x80]).unwrap();
        assert_eq!(read(&file), Shelf::default());
        // An empty object is an empty shelf too, and the shelf works after any of them.
        std::fs::write(&file, "{}").unwrap();
        let mut shelf = read(&file);
        assert_eq!(shelf.add(&full("one.txt"), 1), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_edited_by_hand_gives_only_full_paths_each_once_and_no_more_than_fit() {
        let (one, two) = (full("one.txt"), full("two.png"));
        let text = serde_json::json!({ "items": [
            { "path": one, "addedAt": 5 },
            { "path": "relative.txt", "addedAt": 4 },
            { "path": "", "addedAt": 4 },
            { "path": one, "addedAt": 3 },
            { "path": two },
        ], "somethingElse": true })
        .to_string();
        let shelf = Shelf::from_json(&text);
        assert_eq!(paths(&shelf), [one.as_str(), two.as_str()]);
        assert_eq!(shelf.items()[0].added_at, 5, "the first of the two counts");
        assert_eq!(shelf.items()[1].added_at, 0, "no time is no reason to drop it");

        let many: Vec<_> = (0..40).map(|n| serde_json::json!({ "path": full(&format!("f{n}")), "addedAt": n })).collect();
        let shelf = Shelf::from_json(&serde_json::json!({ "items": many }).to_string());
        assert_eq!(shelf.items().len(), MAX_ITEMS);
        assert_eq!(shelf.items()[0].path, full("f0"));
        assert_eq!(ids(&shelf)[0], MAX_ITEMS as u64);
    }

    #[test]
    fn what_is_read_at_launch_joins_under_what_was_dropped_meanwhile() {
        let mut stored = Shelf::default();
        stored.add(&full("old-1"), 1);
        stored.add(&full("shared"), 2);
        stored.add(&full("old-2"), 3);

        // Nothing was dropped yet: the stored shelf, as it was.
        let mut shelf = Shelf::default();
        shelf.absorb(stored.clone());
        assert_eq!(paths(&shelf), paths(&stored));
        assert_eq!(shelf.add(&full("new"), 9), 4);

        // A drop came first: it stays on top, and what it shares with the file is there once.
        let mut shelf = Shelf::default();
        shelf.add(&full("shared"), 50);
        shelf.add(&full("dropped"), 60);
        shelf.absorb(stored);
        assert_eq!(paths(&shelf), [full("dropped"), full("shared"), full("old-2"), full("old-1")]);
        assert_eq!(shelf.items()[1].added_at, 50);
        let mut seen = ids(&shelf);
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), 4, "every id once");

        // Never more than fit.
        let mut full_shelf = Shelf::default();
        for n in 0..MAX_ITEMS {
            full_shelf.add(&full(&format!("f{n}")), n as u64);
        }
        let mut shelf = Shelf::default();
        shelf.add(&full("dropped"), 99);
        shelf.absorb(full_shelf);
        assert_eq!(shelf.items().len(), MAX_ITEMS);
        assert_eq!(shelf.items()[0].path, full("dropped"));
    }

    #[test]
    fn at_launch_items_whose_file_has_gone_are_dropped_from_what_was_read() {
        let dir = scratch("prune");
        let kept = dir.join("kept.txt");
        let folder = dir.join("a folder");
        let gone = dir.join("gone.txt");
        std::fs::write(&kept, b"x").unwrap();
        std::fs::create_dir(&folder).unwrap();
        let mut shelf = Shelf::default();
        for path in [&kept, &gone, &folder] {
            shelf.add(&path.to_string_lossy(), 1);
        }
        let file = dir.join("shelf.json");
        write(&file, &shelf).unwrap();

        let mut loaded = read(&file);
        assert_eq!(loaded.items().len(), 3);
        assert!(loaded.prune(|path| Path::new(path).exists()));
        assert_eq!(paths(&loaded), [folder.to_string_lossy(), kept.to_string_lossy()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── What the page gets ────────────────────────────────────────────────────

    #[test]
    fn an_item_shows_its_name_its_size_and_whether_it_is_a_folder_or_gone() {
        let dir = scratch("entries");
        let file = dir.join("informe final.PDF");
        let folder = dir.join("fotos");
        let gone = dir.join("gone.txt");
        std::fs::write(&file, vec![0u8; 1234]).unwrap();
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("inside.bin"), vec![0u8; 99]).unwrap();

        let mut shelf = Shelf::default();
        for (path, at) in [(&file, 10), (&folder, 20), (&gone, 30)] {
            shelf.add(&path.to_string_lossy(), at);
        }
        let modified = facts(&file.to_string_lossy()).modified;
        assert!(modified > 0);
        let mut thumbs = HashMap::new();
        thumbs.insert(file.to_string_lossy().to_string(), Thumb { modified, url: "data:image/png;base64,AAAA".into() });
        // One made for a file that has since gone is not shown either.
        thumbs.insert(gone.to_string_lossy().to_string(), Thumb { modified: 0, url: "data:image/png;base64,BBBB".into() });

        let (entries, wanted) = listing(&shelf, &thumbs);
        assert_eq!(
            entries,
            [
                Entry { id: 3, path: gone.to_string_lossy().into(), name: "gone.txt".into(), size: 0, is_dir: false, added_at: 30, thumb: String::new(), missing: true },
                Entry { id: 2, path: folder.to_string_lossy().into(), name: "fotos".into(), size: 0, is_dir: true, added_at: 20, thumb: String::new(), missing: false },
                Entry { id: 1, path: file.to_string_lossy().into(), name: "informe final.PDF".into(), size: 1234, is_dir: false, added_at: 10, thumb: "data:image/png;base64,AAAA".into(), missing: false },
            ]
        );
        // The folder has no picture yet; the file has one; the one that has gone gets none.
        assert_eq!(wanted, [(folder.to_string_lossy().to_string(), facts(&folder.to_string_lossy()).modified)]);

        // The page's names for the fields.
        let json = serde_json::to_value(&entries[2]).unwrap();
        assert_eq!(
            json.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
            ["id", "path", "name", "size", "isDir", "addedAt", "thumb", "missing"]
        );

        // The file changed since its picture was made: the old one is not shown, a new one is wanted.
        thumbs.insert(file.to_string_lossy().to_string(), Thumb { modified: modified + 1, url: "data:image/png;base64,OLD".into() });
        let (entries, wanted) = listing(&shelf, &thumbs);
        assert_eq!(entries[2].thumb, "");
        assert!(wanted.contains(&(file.to_string_lossy().to_string(), modified)));
        // One the shell had nothing for is remembered as that, and not asked for again.
        thumbs.insert(file.to_string_lossy().to_string(), Thumb { modified, url: String::new() });
        let (entries, wanted) = listing(&shelf, &thumbs);
        assert_eq!(entries[2].thumb, "");
        assert!(!wanted.iter().any(|(path, _)| *path == file.to_string_lossy()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_name_is_the_last_part_of_the_path() {
        assert_eq!(file_name(&full("report.final.pdf")), "report.final.pdf");
        assert_eq!(file_name(&full("no extension")), "no extension");
        assert_eq!(file_name(&full(".gitignore")), ".gitignore");
        if cfg!(windows) {
            assert_eq!(file_name("C:\\Users\\me\\Pictures\\Liv\\Captura 2026-11-17 15.53.07.png"), "Captura 2026-11-17 15.53.07.png");
            assert_eq!(file_name("C:\\Users\\me\\Documents\\"), "Documents");
            assert_eq!(file_name("D:\\"), "D:\\", "a drive is its own name");
        }
    }

    #[test]
    fn only_what_is_there_by_its_full_path_can_be_shelved() {
        let dir = scratch("shelvable");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(shelvable(&file.to_string_lossy()));
        assert!(shelvable(&dir.to_string_lossy()), "a folder too");
        assert!(!shelvable(&dir.join("missing.txt").to_string_lossy()));
        assert!(!shelvable("a.txt"));
        assert!(!shelvable(""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_goes_on_the_clipboard_as_a_list_of_wide_paths_closed_by_two_zeros() {
        let bytes = hdrop_bytes(&["C:\\a\\ñ.txt"]);
        // The names start right after the 20-byte header, and are UTF-16.
        assert_eq!(&bytes[..4], &20u32.to_le_bytes());
        assert_eq!(&bytes[4..16], &[0; 12]);
        assert_eq!(&bytes[16..20], &1u32.to_le_bytes());
        let units: Vec<u16> = bytes[20..].chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        let expected: Vec<u16> = "C:\\a\\ñ.txt".encode_utf16().chain([0, 0]).collect();
        assert_eq!(units, expected);
        // Several: each closed by its zero, the list by one more.
        let two = hdrop_bytes(&["C:\\a", "D:\\b"]);
        let units: Vec<u16> = two[20..].chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        assert_eq!(String::from_utf16_lossy(&units), "C:\\a\0D:\\b\0\0");
    }

    #[test]
    fn only_a_path_a_real_drop_delivered_may_be_shelved_by_the_page_and_only_once() {
        // What `shelf_add` asks before anything else.
        let path = full("dropped-on-the-shelf.txt");
        assert!(!crate::files::take_dropped(&path), "never dropped");
        crate::files::allow_dropped([path.clone()]);
        assert!(crate::files::take_dropped(&path));
        assert!(!crate::files::take_dropped(&path), "good once");
    }
}
