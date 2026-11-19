// A download that finishes in the user's Downloads folder, told to the island
// (Settings → General → Tell me when a download finishes): the island shows a
// card with the file's name and three things to do with it — open it, show it
// in its folder, put it on the shelf.
//
// Nothing here reads a file's contents, and nothing leaves the machine. A
// thread waits on the folder — it costs nothing until a name changes in it —
// and wakes a second one that looks at the folder's listing until what is new
// has stopped changing. What counts as a download:
// - a file that was not there when Liv started looking;
// - not a browser's partial file (`.crdownload`, `.part`…), and with none
//   still next to it;
// - marked by the browser as coming from the web (its `Zone.Identifier`), or
//   one whose partial file was seen first. A document saved into Downloads or
//   a file copied there is neither, and is not announced.
//
// The page is told a name and a size, never a path: what it asks to open is
// one of the downloads announced here, by its number.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::AppHandle;

/// What the island hears.
pub const EVENT: &str = "download";
/// A new file that has not changed for this long, in ms, is whole.
const SETTLE_MS: u64 = 1500;
/// How many announced downloads can still be opened from the island.
const KEPT: usize = 20;

// ── What is in the folder ─────────────────────────────────────────────────────

/// A file of the folder, as its listing shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub size: u64,
    /// When it was last written, in ms: only ever compared with itself.
    pub modified: u64,
    pub hidden: bool,
}

/// What a closer look at a file says.
pub struct Probe {
    /// It can be opened to read: whoever wrote it is done with it.
    pub readable: bool,
    /// The browser marked it as coming from the web.
    pub marked: bool,
}

/// A download that has just finished.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finished {
    pub name: String,
    pub size: u64,
}

/// The endings browsers and download tools give a file they are still writing.
const PARTIAL_ENDINGS: [&str; 10] =
    ["crdownload", "part", "partial", "download", "opdownload", "tmp", "filepart", "aria2", "!ut", "td"];

/// The name a partial file will have once whole (`video.mp4.part` → `video.mp4`); None for any other file.
pub fn partial_of(name: &str) -> Option<&str> {
    let (base, ending) = name.rsplit_once('.')?;
    let partial = PARTIAL_ENDINGS.iter().any(|e| ending.eq_ignore_ascii_case(e));
    (partial && !base.is_empty()).then_some(base)
}

/// A file that is never a download: a partial one, an editor's lock, the folder's own.
fn passed_over(entry: &Entry) -> bool {
    let name = entry.name.as_str();
    entry.hidden
        || partial_of(name).is_some()
        || name.starts_with('~')
        || name.starts_with(".~")
        || name.eq_ignore_ascii_case("desktop.ini")
        || name.eq_ignore_ascii_case("thumbs.db")
}

struct Seen {
    size: u64,
    modified: u64,
    /// When it last changed, on the caller's clock (ms).
    since: u64,
    /// It appeared while we were looking, and has not been judged yet.
    waiting: bool,
}

/// The folder as it was last seen, and what is new in it.
#[derive(Default)]
pub struct Tracker {
    known: HashMap<String, Seen>,
    /// The names partial files were seen for, lower case.
    announced_by_partial: HashSet<String>,
    looked: bool,
}

impl Tracker {
    /// The folder now, at `now` ms: the downloads that have just finished.
    /// The first look only learns what is already there. `probe` is asked
    /// about a file once it looks whole, never before.
    pub fn observe(&mut self, listing: &[Entry], now: u64, mut probe: impl FnMut(&str) -> Probe) -> Vec<Finished> {
        let first = !self.looked;
        self.looked = true;

        // The partial files there now, by the name they will have.
        let partial_now: HashSet<String> =
            listing.iter().filter_map(|e| partial_of(&e.name)).map(str::to_lowercase).collect();
        self.announced_by_partial.extend(partial_now.iter().cloned());

        let present: HashSet<&str> = listing.iter().map(|e| e.name.as_str()).collect();
        self.known.retain(|name, _| present.contains(name.as_str()));

        for entry in listing.iter().filter(|e| !passed_over(e)) {
            match self.known.get_mut(&entry.name) {
                None => {
                    self.known.insert(
                        entry.name.clone(),
                        Seen { size: entry.size, modified: entry.modified, since: now, waiting: !first },
                    );
                }
                Some(seen) if seen.size != entry.size || seen.modified != entry.modified => {
                    seen.size = entry.size;
                    seen.modified = entry.modified;
                    seen.since = now;
                }
                Some(_) => {}
            }
        }

        let mut finished = Vec::new();
        for (name, seen) in self.known.iter_mut() {
            let lower = name.to_lowercase();
            // Still being written: empty, just changed, or its partial file is still there.
            if !seen.waiting || seen.size == 0 || now.saturating_sub(seen.since) < SETTLE_MS || partial_now.contains(&lower)
            {
                continue;
            }
            let look = probe(name);
            if !look.readable {
                continue;
            }
            seen.waiting = false;
            if look.marked || self.announced_by_partial.contains(&lower) {
                finished.push(Finished { name: name.clone(), size: seen.size });
            }
        }
        // A partial file's name is remembered only while it, or the file it became, is still to be judged.
        let known = &self.known;
        self.announced_by_partial.retain(|name| {
            partial_now.contains(name) || known.iter().any(|(n, seen)| seen.waiting && n.to_lowercase() == *name)
        });
        finished.sort_by(|a, b| a.name.cmp(&b.name));
        finished
    }

    /// Something new is still being written, or waits to settle: look again soon.
    pub fn pending(&self) -> bool {
        self.known.values().any(|seen| seen.waiting)
    }
}

// ── What was announced ────────────────────────────────────────────────────────

/// What the island hears of a download.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Told {
    pub id: u64,
    pub name: String,
    pub size: u64,
}

#[derive(Default)]
struct Announced {
    next: u64,
    /// The last ones, oldest first: their number and where they are.
    kept: Vec<(u64, PathBuf)>,
}

impl Announced {
    fn add(&mut self, path: PathBuf) -> u64 {
        self.next += 1;
        self.kept.push((self.next, path));
        if self.kept.len() > KEPT {
            self.kept.remove(0);
        }
        self.next
    }

    fn path(&self, id: u64) -> Option<PathBuf> {
        self.kept.iter().find(|(n, _)| *n == id).map(|(_, path)| path.clone())
    }
}

static ANNOUNCED: Mutex<Announced> = Mutex::new(Announced { next: 0, kept: Vec::new() });
/// Settings → General → Tell me when a download finishes.
static ENABLED: AtomicBool = AtomicBool::new(false);
/// The watcher runs: it is started once, the first time the setting is on.
static STARTED: AtomicBool = AtomicBool::new(false);

fn announced() -> MutexGuard<'static, Announced> {
    ANNOUNCED.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The setting as it is now: the watcher starts with the first "on", and from
/// then on only speaks while it is on.
pub fn sync(app: &AppHandle, on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
    if on && !STARTED.swap(true, Ordering::Relaxed) {
        os::start(app.clone());
    }
}

/// An announced download that is still where it was.
fn still_there(id: u64) -> Option<String> {
    let path = announced().path(id)?;
    path.is_file().then(|| path.to_string_lossy().into_owned())
}

async fn off_main<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tauri::async_runtime::spawn_blocking(work).await.ok()
}

/// Opens the download with the app Windows has for it. False when the file has gone.
#[tauri::command]
pub async fn download_open(window: tauri::WebviewWindow, id: u64) -> Result<bool, String> {
    crate::from_island(&window)?;
    Ok(off_main(move || still_there(id).is_some_and(|path| crate::shelf::os::open(&path))).await.unwrap_or(false))
}

/// Explorer on the download's folder, with the file selected.
#[tauri::command]
pub async fn download_reveal(window: tauri::WebviewWindow, id: u64) -> Result<bool, String> {
    crate::from_island(&window)?;
    Ok(off_main(move || still_there(id).is_some_and(|path| crate::shelf::os::reveal(&path))).await.unwrap_or(false))
}

/// The download goes on the shelf (a reference to it, as for any file there).
#[tauri::command]
pub async fn download_shelve(app: AppHandle, window: tauri::WebviewWindow, id: u64) -> Result<bool, String> {
    crate::from_island(&window)?;
    Ok(off_main(move || still_there(id).is_some_and(|path| crate::shelf::add_path(&app, &path).is_some()))
        .await
        .unwrap_or(false))
}

// ── Windows: the folder, watched ──────────────────────────────────────────────

#[cfg(windows)]
mod os {
    use std::os::windows::fs::MetadataExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::Ordering;
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
    use std::time::{Duration, Instant, UNIX_EPOCH};

    use tauri::{AppHandle, Emitter};
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_FILE_NAME,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_Downloads, SHGetKnownFolderPath, KF_FLAG_DEFAULT};

    use super::{announced, Entry, Probe, Told, Tracker, ENABLED, EVENT};

    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    /// How often the folder is looked at while something new is being written:
    /// quickly at first, then at leisure for a long download.
    const LOOK: Duration = Duration::from_millis(600);
    const LOOK_SLOWLY: Duration = Duration::from_secs(3);
    const QUICK_FOR: Duration = Duration::from_secs(20);
    /// The folder could not be watched (it is gone, or on a share that says no): tried again after this.
    const RETRY: Duration = Duration::from_secs(60);

    /// Downloads, wherever the user moved it.
    fn downloads_dir() -> Option<PathBuf> {
        unsafe {
            let name = SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT, None).ok()?;
            let path = name.to_string().ok();
            CoTaskMemFree(Some(name.0 as *const _));
            path.filter(|path| !path.is_empty()).map(PathBuf::from)
        }
    }

    pub fn start(app: AppHandle) {
        let Some(dir) = downloads_dir() else {
            crate::log::line("downloads: no Downloads folder".to_string());
            return;
        };
        let (changed, changes) = mpsc::channel::<()>();
        let watched = dir.clone();
        let waiter = std::thread::Builder::new().name("liv-downloads-wait".into()).spawn(move || wait(&watched, changed));
        let looker = std::thread::Builder::new().name("liv-downloads".into()).spawn(move || look(app, dir, changes));
        if waiter.is_err() || looker.is_err() {
            crate::log::line("downloads: no watcher thread".to_string());
        }
    }

    /// Sleeps in the system until a name changes in the folder — a file made,
    /// renamed or removed — and says so. A browser renames its partial file
    /// when the download is whole, so the end of one is always a change of name.
    fn wait(dir: &Path, changed: Sender<()>) {
        loop {
            let Some(folder) = open_folder(dir) else {
                std::thread::sleep(RETRY);
                continue;
            };
            // What changed is not read from here: the listing says it.
            let mut news = [0u8; 4096];
            loop {
                let mut read = 0u32;
                let heard = unsafe {
                    ReadDirectoryChangesW(
                        folder,
                        news.as_mut_ptr().cast(),
                        news.len() as u32,
                        false,
                        FILE_NOTIFY_CHANGE_FILE_NAME,
                        Some(&mut read),
                        None,
                        None,
                    )
                };
                if heard.is_err() {
                    break;
                }
                if changed.send(()).is_err() {
                    unsafe {
                        let _ = CloseHandle(folder);
                    }
                    return;
                }
            }
            unsafe {
                let _ = CloseHandle(folder);
            }
            std::thread::sleep(RETRY);
        }
    }

    fn open_folder(dir: &Path) -> Option<HANDLE> {
        unsafe {
            CreateFileW(
                &HSTRING::from(dir.as_os_str()),
                FILE_LIST_DIRECTORY.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                None,
            )
            .ok()
        }
    }

    /// Looks at the folder after each change, and again until what is new has
    /// settled; in between it waits on the channel and costs nothing.
    fn look(app: AppHandle, dir: PathBuf, changes: Receiver<()>) {
        let clock = Instant::now();
        let mut tracker = Tracker::default();
        // What is already there is not news.
        tracker.observe(&listing(&dir), 0, |_| Probe { readable: false, marked: false });
        loop {
            if changes.recv().is_err() {
                return;
            }
            let busy_since = Instant::now();
            loop {
                let pause = if busy_since.elapsed() < QUICK_FOR { LOOK } else { LOOK_SLOWLY };
                match changes.recv_timeout(pause) {
                    Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                // Several changes at once are one look.
                while changes.try_recv().is_ok() {}
                let now = clock.elapsed().as_millis() as u64;
                let finished = tracker.observe(&listing(&dir), now, |name| probe(&dir.join(name)));
                if ENABLED.load(Ordering::Relaxed) {
                    for file in finished {
                        let id = announced().add(dir.join(&file.name));
                        let _ = app.emit_to(crate::island::WINDOW_LABEL, EVENT, Told { id, name: file.name, size: file.size });
                    }
                }
                if !tracker.pending() {
                    break;
                }
            }
        }
    }

    /// The files of the folder itself: no folders, nothing below them.
    fn listing(dir: &Path) -> Vec<Entry> {
        let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
        entries
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let meta = entry.metadata().ok()?;
                if !meta.is_file() {
                    return None;
                }
                let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
                Some(Entry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    size: meta.len(),
                    modified,
                    hidden: meta.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0,
                })
            })
            .collect()
    }

    /// Whether the file can be read by now, and whether it carries the mark a
    /// browser leaves on what came from the web (the `Zone.Identifier` stream;
    /// only that it exists is looked at).
    fn probe(path: &Path) -> Probe {
        let readable = std::fs::File::open(path).is_ok();
        let mut mark = path.as_os_str().to_os_string();
        mark.push(":Zone.Identifier");
        Probe { readable, marked: readable && std::fs::metadata(&mark).is_ok() }
    }
}

#[cfg(not(windows))]
mod os {
    use tauri::AppHandle;

    /// Downloads are not watched here yet.
    pub fn start(_app: AppHandle) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, size: u64, modified: u64) -> Entry {
        Entry { name: name.to_string(), size, modified, hidden: false }
    }

    fn whole(marked: bool) -> impl FnMut(&str) -> Probe {
        move |_| Probe { readable: true, marked }
    }

    fn names(finished: &[Finished]) -> Vec<&str> {
        finished.iter().map(|f| f.name.as_str()).collect()
    }

    #[test]
    fn a_partial_file_is_known_by_its_ending() {
        assert_eq!(partial_of("video.mp4.crdownload"), Some("video.mp4"));
        assert_eq!(partial_of("report.pdf.PART"), Some("report.pdf"));
        assert_eq!(partial_of("Unconfirmed 4213.crdownload"), Some("Unconfirmed 4213"));
        assert_eq!(partial_of("setup.exe.tmp"), Some("setup.exe"));
        assert_eq!(partial_of("video.mp4"), None);
        assert_eq!(partial_of("notes"), None);
        assert_eq!(partial_of(".part"), None);
    }

    #[test]
    fn what_was_already_there_is_not_a_download() {
        let mut tracker = Tracker::default();
        let old = [file("old.zip", 10, 1)];
        assert!(tracker.observe(&old, 0, whole(true)).is_empty());
        assert!(tracker.observe(&old, 10_000, whole(true)).is_empty());
        assert!(!tracker.pending());
        // Written again later: still not a download.
        assert!(tracker.observe(&[file("old.zip", 99, 2)], 20_000, whole(true)).is_empty());
        assert!(tracker.observe(&[file("old.zip", 99, 2)], 30_000, whole(true)).is_empty());
    }

    #[test]
    fn chrome_renames_its_partial_file_and_the_download_is_told_once_it_has_settled() {
        let mut tracker = Tracker::default();
        tracker.observe(&[], 0, whole(true));
        // Downloading: only the partial file.
        assert!(tracker.observe(&[file("Unconfirmed 1.crdownload", 500, 1)], 1000, whole(true)).is_empty());
        assert!(!tracker.pending(), "a partial file is nothing to wait on");
        // Renamed: there, but only just.
        let done = [file("video.mp4", 900, 5)];
        assert!(tracker.observe(&done, 2000, whole(true)).is_empty());
        assert!(tracker.pending());
        assert!(tracker.observe(&done, 3000, whole(true)).is_empty());
        // Unchanged for a second and a half: told, once.
        assert_eq!(tracker.observe(&done, 3500, whole(true)), [Finished { name: "video.mp4".into(), size: 900 }]);
        assert!(!tracker.pending());
        assert!(tracker.observe(&done, 9000, whole(true)).is_empty());
    }

    #[test]
    fn firefox_keeps_an_empty_file_next_to_its_partial_one_until_the_end() {
        let mut tracker = Tracker::default();
        tracker.observe(&[], 0, whole(false));
        let during = [file("doc.pdf", 0, 1), file("doc.pdf.part", 400, 2)];
        assert!(tracker.observe(&during, 1000, whole(false)).is_empty());
        assert!(tracker.observe(&during, 60_000, whole(false)).is_empty(), "however long it takes");
        assert!(tracker.pending());
        // The partial file became the file.
        let done = [file("doc.pdf", 800, 9)];
        assert!(tracker.observe(&done, 61_000, whole(false)).is_empty());
        // No mark from the browser, but its partial file was seen: a download.
        assert_eq!(names(&tracker.observe(&done, 62_500, whole(false))), ["doc.pdf"]);
    }

    #[test]
    fn a_file_still_growing_or_still_held_waits() {
        let mut tracker = Tracker::default();
        tracker.observe(&[], 0, whole(true));
        assert!(tracker.observe(&[file("big.iso", 100, 1)], 1000, whole(true)).is_empty());
        assert!(tracker.observe(&[file("big.iso", 200, 2)], 2400, whole(true)).is_empty());
        assert!(tracker.observe(&[file("big.iso", 300, 3)], 3800, whole(true)).is_empty(), "it changed again");
        // Settled, but whoever writes it has not let go.
        let held = |_: &str| Probe { readable: false, marked: true };
        assert!(tracker.observe(&[file("big.iso", 300, 3)], 5400, held).is_empty());
        assert!(tracker.pending());
        assert_eq!(names(&tracker.observe(&[file("big.iso", 300, 3)], 6000, whole(true))), ["big.iso"]);
    }

    #[test]
    fn a_file_saved_or_copied_into_the_folder_is_not_announced() {
        let mut tracker = Tracker::default();
        tracker.observe(&[], 0, whole(false));
        let saved = [file("notes.docx", 300, 1)];
        tracker.observe(&saved, 1000, whole(false));
        // No mark from a browser, no partial file before it: not a download, and not asked about again.
        assert!(tracker.observe(&saved, 3000, whole(false)).is_empty());
        assert!(!tracker.pending());
        let mut asked = 0;
        tracker.observe(&saved, 9000, |_| {
            asked += 1;
            Probe { readable: true, marked: true }
        });
        assert_eq!(asked, 0);
    }

    #[test]
    fn hidden_files_locks_and_the_folders_own_are_passed_over() {
        let mut tracker = Tracker::default();
        tracker.observe(&[], 0, whole(true));
        let noise = [
            Entry { hidden: true, ..file("secret.bin", 10, 1) },
            file("~$report.docx", 10, 1),
            file("desktop.ini", 10, 1),
            file("empty.txt", 0, 1),
        ];
        tracker.observe(&noise, 1000, whole(true));
        assert!(tracker.observe(&noise, 5000, whole(true)).is_empty());
    }

    #[test]
    fn several_at_once_are_told_together_and_one_removed_is_forgotten() {
        let mut tracker = Tracker::default();
        tracker.observe(&[], 0, whole(true));
        let two = [file("b.zip", 2, 1), file("a.zip", 1, 1)];
        tracker.observe(&two, 1000, whole(true));
        assert_eq!(names(&tracker.observe(&two, 2600, whole(true))), ["a.zip", "b.zip"]);
        // Deleted, then downloaded again under the same name: news again.
        tracker.observe(&[file("b.zip", 2, 1)], 3000, whole(true));
        let again = [file("b.zip", 2, 1), file("a.zip", 5, 7)];
        tracker.observe(&again, 4000, whole(true));
        assert_eq!(names(&tracker.observe(&again, 5600, whole(true))), ["a.zip"]);
    }

    #[test]
    fn only_the_last_downloads_can_still_be_opened() {
        let mut list = Announced::default();
        let first = list.add(PathBuf::from("one"));
        for n in 0..KEPT {
            list.add(PathBuf::from(format!("more-{n}")));
        }
        assert_eq!(list.path(first), None);
        let last = list.add(PathBuf::from("last"));
        assert_eq!(list.path(last), Some(PathBuf::from("last")));
        assert_eq!(list.path(9999), None);
        assert_ne!(first, last);
    }
}
