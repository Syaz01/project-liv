// Liv on the desktop: its own small window, wherever the user left it.
//
// The island's page decides when Liv goes out and comes home
// (src/pet/outing.ts) and designs the way there (src/pet/travel.ts); the
// window's page draws Liv (src/pet/main.ts). This file owns the window: where
// it is, which part of it takes the mouse, moving it along a way, carrying it
// under the pointer, and the spot it is remembered at.
//
// The window is created with the app and never hidden: at home it waits far
// off every display, as the island does while another app is full screen. A
// WebView2 window created late comes up blank, and showing a hidden one again
// can take the keyboard from the app in front; a move never does.
//
// Its cursor poll runs only while Liv is out. Home, the thread sleeps on a
// condition and nothing else runs for the window at all.
//
// Positions are the window's top-left corner in physical desktop px. Lengths
// of the page are in page px: one is `unit` physical px, the display's scale
// times the island's size (scale.rs), which the window shares.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::island::{self, DisplayId, PollGate};
use crate::platform;
use crate::settings::{self, PetSpot};

pub const LABEL: &str = "pet";

/// The window, in page px: what Liv needs around it so that nothing of it is
/// ever cut, and where its head's centre rests in it. Worked out from the
/// figure in src/pet/shape.ts (PET_WINDOW); tests/pet.test.mjs keeps the two
/// in step.
pub const PAGE_W: f64 = 102.0;
pub const PAGE_H: f64 = 109.0;
pub const HEAD_X: f64 = 51.0;
pub const HEAD_Y: f64 = 68.0;

/// Kept between the window and the edges of a display's work area, page px.
const MARGIN: f64 = 8.0;
/// The window is given a new place this often on its way, ms.
const STEP_MS: u64 = 8;
/// A way is never longer than this, ms, nor made of more points.
const MAX_WAY_MS: u64 = 2000;
const MAX_WAY_POINTS: usize = 512;

/// Liv leaves the island only where a window can be put anywhere and the
/// cursor can be read: Windows. Elsewhere nothing is created.
const SUPPORTED: bool = cfg!(windows);

// ── Pure geometry ─────────────────────────────────────────────────────────────

pub mod logic {
    use super::{DisplayId, PetSpot};
    use serde::Deserialize;

    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Rect {
        pub x: f64,
        pub y: f64,
        pub w: f64,
        pub h: f64,
    }

    impl Rect {
        pub fn contains(&self, p: (f64, f64)) -> bool {
            p.0 >= self.x && p.0 < self.x + self.w && p.1 >= self.y && p.1 < self.y + self.h
        }

        pub fn center(&self) -> (f64, f64) {
            (self.x + self.w / 2.0, self.y + self.h / 2.0)
        }
    }

    /// A connected display, in physical px: its whole area, the part windows
    /// may use (no taskbar), its scale, and what it is remembered by.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Display {
        pub id: DisplayId,
        pub frame: Rect,
        pub work: Rect,
        pub scale: f64,
    }

    /// A disc of Liv's silhouette, in page px from the window's corner.
    #[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
    pub struct Disc {
        pub x: f64,
        pub y: f64,
        pub r: f64,
    }

    /// Whether a pointer at `local` (page px in the window) is on Liv. With no
    /// shape nothing is: every click goes to what is underneath.
    pub fn over_shape(local: (f64, f64), shape: &[Disc]) -> bool {
        shape.iter().any(|d| (local.0 - d.x).hypot(local.1 - d.y) <= d.r)
    }

    /// A silhouette the page may hand over: a few discs, each inside the window.
    pub fn valid_shape(shape: &[Disc], page: (f64, f64)) -> bool {
        !shape.is_empty()
            && shape.len() <= 16
            && shape.iter().all(|d| {
                d.x.is_finite()
                    && d.y.is_finite()
                    && d.r.is_finite()
                    && d.r > 0.0
                    && d.x - d.r >= 0.0
                    && d.y - d.r >= 0.0
                    && d.x + d.r <= page.0
                    && d.y + d.r <= page.1
            })
    }

    /// The window's size on `display`, physical px, with the island at `island` size.
    pub fn size_on(display: &Display, page: (f64, f64), island: f64) -> (f64, f64) {
        let unit = display.scale * island;
        (page.0 * unit, page.1 * unit)
    }

    /// Keeps a window of `size` inside `work`, `margin` from each edge. On a
    /// work area too small for that, the top-left corner wins.
    pub fn clamp_origin(origin: (f64, f64), size: (f64, f64), work: Rect, margin: f64) -> (f64, f64) {
        (
            origin.0.min(work.x + work.w - size.0 - margin).max(work.x + margin),
            origin.1.min(work.y + work.h - size.1 - margin).max(work.y + margin),
        )
    }

    /// The display whose frame holds `p`, or else the one whose centre is closest.
    pub fn display_near(p: (f64, f64), displays: &[Display]) -> Option<&Display> {
        let dist2 = |d: &Display| {
            let c = d.frame.center();
            (p.0 - c.0).powi(2) + (p.1 - c.1).powi(2)
        };
        displays
            .iter()
            .find(|d| d.frame.contains(p))
            .or_else(|| displays.iter().min_by(|a, b| dist2(a).total_cmp(&dist2(b))))
    }

    /// The display a window with its corner at `origin` is on: the one under
    /// its centre, or the nearest.
    fn display_of(origin: (f64, f64), displays: &[Display], page: (f64, f64), island: f64) -> Option<&Display> {
        let first = display_near(origin, displays)?;
        let size = size_on(first, page, island);
        display_near((origin.0 + size.0 / 2.0, origin.1 + size.1 / 2.0), displays)
    }

    /// Where a window left with its corner at `origin` settles: inside the
    /// work area of the display it is on. Whatever `origin` is — a drop half
    /// off the screen, a place a page made up — the answer is on a display.
    /// None only when no display is connected, or `origin` is not a place.
    pub fn settle(
        origin: (f64, f64),
        displays: &[Display],
        page: (f64, f64),
        island: f64,
        margin: f64,
    ) -> Option<(f64, f64)> {
        if !(origin.0.is_finite() && origin.1.is_finite()) {
            return None;
        }
        let d = display_of(origin, displays, page, island)?;
        Some(clamp_origin(origin, size_on(d, page, island), d.work, margin * d.scale * island))
    }

    /// The first time out: the bottom-right corner of the display's work area.
    pub fn default_spot(d: &Display, page: (f64, f64), island: f64, margin: f64) -> (f64, f64) {
        let size = size_on(d, page, island);
        let m = margin * d.scale * island;
        clamp_origin((d.work.x + d.work.w, d.work.y + d.work.h), size, d.work, m)
    }

    /// What a window with its corner at `origin` is remembered by: the display
    /// it is on, and its centre from that display's corner in logical px — so
    /// the spot survives a change of the display's scale or of the island's size.
    pub fn spot_of(origin: (f64, f64), displays: &[Display], page: (f64, f64), island: f64) -> Option<PetSpot> {
        let d = display_of(origin, displays, page, island)?;
        let size = size_on(d, page, island);
        Some(PetSpot {
            display: d.id.key(),
            x: (origin.0 + size.0 / 2.0 - d.frame.x) / d.scale,
            y: (origin.1 + size.1 / 2.0 - d.frame.y) / d.scale,
        })
    }

    /// The window's corner for a remembered spot, on the displays connected
    /// now. None when its display is gone (island::pick_display says which
    /// display a key means): Liv then stays in the island. A spot that is
    /// still on its display is pulled back inside the work area.
    pub fn restore_spot(
        spot: &PetSpot,
        displays: &[Display],
        page: (f64, f64),
        island: f64,
        margin: f64,
    ) -> Option<(f64, f64)> {
        if !(spot.x.is_finite() && spot.y.is_finite()) {
            return None;
        }
        let ids: Vec<DisplayId> = displays.iter().map(|d| d.id.clone()).collect();
        let d = &displays[crate::island::pick_display(&spot.display, &ids)?];
        let size = size_on(d, page, island);
        let origin = (d.frame.x + spot.x * d.scale - size.0 / 2.0, d.frame.y + spot.y * d.scale - size.1 / 2.0);
        Some(clamp_origin(origin, size, d.work, margin * d.scale * island))
    }

    /// The window's corner when Liv's head is to be at `point`: where it
    /// leaves the island from, and comes back to.
    pub fn origin_for_head(point: (f64, f64), head: (f64, f64), unit: f64) -> (f64, f64) {
        (point.0 - head.0 * unit, point.1 - head.1 * unit)
    }

    /// A way the island's page may hand over: at least two points, not too
    /// many, each of them a place.
    pub fn valid_way(points: &[(f64, f64)], max: usize) -> bool {
        (2..=max).contains(&points.len()) && points.iter().all(|p| p.0.is_finite() && p.1.is_finite())
    }

    /// Where the window is `t` of the time into a way (0…1), its points evenly
    /// spaced in time: on the line between the two it is between.
    pub fn along(points: &[(f64, f64)], t: f64) -> (f64, f64) {
        let Some(last) = points.last().copied() else { return (0.0, 0.0) };
        if points.len() < 2 || t.is_nan() || t >= 1.0 {
            return last;
        }
        let at = t.max(0.0) * (points.len() - 1) as f64;
        let i = (at.floor() as usize).min(points.len() - 2);
        let k = at - i as f64;
        let (a, b) = (points[i], points[i + 1]);
        (a.0 + (b.0 - a.0) * k, a.1 + (b.1 - a.1) * k)
    }
}

use logic::{Disc, Display, Rect};

// ── State ─────────────────────────────────────────────────────────────────────

/// Where the pointer picked Liv up.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Island,
    Desktop,
}

/// Where a way ends.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Arrive {
    /// At its spot on the desktop: it lands there.
    Spot,
    /// In the island: the window is put away.
    Home,
}

#[derive(Clone, Copy)]
struct Carry {
    /// The pointer from the window's corner, physical px: kept as it moves.
    grab: (f64, f64),
    from: Source,
}

struct Inner {
    /// Liv is out of the island: its window belongs on screen.
    out: bool,
    /// It stands on the desktop and takes clicks (not on its way, not carried).
    landed: bool,
    asleep: bool,
    carry: Option<Carry>,
    /// Where the window belongs, even while it waits off-screen.
    pos: (f64, f64),
    /// Physical px for one page px there.
    unit: f64,
    /// Liv's silhouette, from its page.
    shape: Vec<Disc>,
    /// The click-through last applied; None when it must be applied again.
    ignoring: Option<bool>,
    /// Another app is full screen on its display: it waits off-screen.
    covered: bool,
    /// The island is paused from the tray: so is Liv.
    paused: bool,
}

impl Inner {
    fn on_screen(&self) -> bool {
        self.out && !self.covered && !self.paused
    }
}

pub struct Pet {
    /// The window was created: Liv can leave the island.
    pub exists: bool,
    /// Wakes the cursor poll, and holds the window's zoom (the island's size).
    gate: PollGate,
    inner: Mutex<Inner>,
    /// Bumped by every way: an older one still running stops moving the window.
    way: AtomicU64,
}

impl Pet {
    fn new(exists: bool) -> Self {
        Self {
            exists,
            gate: PollGate::new(),
            inner: Mutex::new(Inner {
                out: false,
                landed: false,
                asleep: false,
                carry: None,
                pos: PARKED,
                unit: 1.0,
                shape: Vec::new(),
                ignoring: None,
                covered: false,
                paused: false,
            }),
            way: AtomicU64::new(0),
        }
    }
}

const PARKED: (f64, f64) = (island::PARKED_AT as f64, island::PARKED_AT as f64);

#[derive(Serialize, Clone)]
struct Cursor {
    x: f64,
    y: f64,
}

#[derive(Serialize, Clone)]
struct Dropped {
    x: f64,
    y: f64,
    from: Source,
}

#[derive(Serialize, Clone)]
struct Travel {
    dx: f64,
    dy: f64,
    ms: u64,
    way: &'static str,
}

/// The two ends of a way, for the island's page to draw the way between.
#[derive(Serialize)]
pub struct Route {
    from: (f64, f64),
    to: (f64, f64),
    /// Physical px for one page px, so the way's time follows its length as it looks.
    unit: f64,
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn state(app: &AppHandle) -> Option<Arc<Pet>> {
    app.try_state::<Arc<Pet>>().map(|pet| pet.inner().clone())
}

// ── Setup ─────────────────────────────────────────────────────────────────────

/// Creates the window with the app, like the Liv window: before the island's
/// webview is busy, then only moved. A window that cannot be made leaves Liv
/// in the island, and the island as it was.
pub fn setup(app: &AppHandle) {
    let win = if SUPPORTED { create_window(app) } else { None };
    let pet = Arc::new(Pet::new(win.is_some()));
    app.manage(pet.clone());
    let Some(win) = win else { return };
    platform::make_non_activating(&win);
    #[cfg(windows)]
    crate::webview_guard::install(&win);
    // Nothing of it takes the mouse until Liv stands on the desktop.
    platform::set_click_through(&win, true);
    pet.inner.lock().unwrap().ignoring = Some(true);
    spawn_poll(app.clone(), pet);
}

fn page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/pet.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("pet.html".into())
}

fn create_window(app: &AppHandle) -> Option<WebviewWindow> {
    let built = WebviewWindowBuilder::new(app, LABEL, page_url(app))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Liv")
        .inner_size(PAGE_W, PAGE_H)
        .position(PARKED.0, PARKED.1)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        // Never the window in front, and never one a click can make so.
        .focused(false)
        .focusable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .disable_drag_drop_handler()
        .visible(true)
        .build();
    match built {
        Ok(win) => {
            // The builder's position is not honoured that far off-screen (the
            // window came up at 234,234, invisible but there): put it away again.
            let _ = win.set_position(PhysicalPosition::new(PARKED.0 as i32, PARKED.1 as i32));
            crate::webview_memory::set_low(&win, true); // Liv starts at home
            Some(win)
        }
        Err(err) => {
            crate::log::line(format!("Liv's desktop window failed: {err} — Liv stays in the island"));
            None
        }
    }
}

// ── Where things are ──────────────────────────────────────────────────────────

fn displays(app: &AppHandle) -> Vec<Display> {
    let Ok(monitors) = app.available_monitors() else { return Vec::new() };
    monitors
        .iter()
        .map(|m| {
            let (p, s, wa) = (m.position(), m.size(), m.work_area());
            Display {
                id: island::describe(m),
                frame: Rect { x: p.x as f64, y: p.y as f64, w: s.width as f64, h: s.height as f64 },
                work: Rect {
                    x: wa.position.x as f64,
                    y: wa.position.y as f64,
                    w: wa.size.width as f64,
                    h: wa.size.height as f64,
                },
                scale: m.scale_factor(),
            }
        })
        .collect()
}

const PAGE: (f64, f64) = (PAGE_W, PAGE_H);

/// The island's size in force, which the window shares.
fn island_size(app: &AppHandle) -> f64 {
    app.try_state::<crate::Shared>().map(|s| s.gate.scale()).unwrap_or(1.0)
}

/// Physical px for one page px, for a window whose corner is at `origin`.
fn unit_at(origin: (f64, f64), all: &[Display], island: f64) -> f64 {
    logic::display_near((origin.0 + 1.0, origin.1 + 1.0), all).map(|d| d.scale).unwrap_or(1.0) * island
}

/// The point of the island's page (`x`, `y`, page px) on the desktop, and the
/// unit there. While the island waits off-screen, or before it is placed: the
/// top centre of its display.
fn island_point(app: &AppHandle, x: f64, y: f64) -> Option<((f64, f64), f64)> {
    let shared = app.try_state::<crate::Shared>()?;
    let all = displays(app);
    let island = shared.gate.scale();
    let point = island::screen_point(app, &shared.gate, (x, y))
        .or_else(|| shared.gate.anchor().map(|(ax, ay)| (ax as f64, ay as f64)))?;
    Some((point, unit_at(point, &all, island)))
}

/// The window's corner when Liv is at the island's point (`x`, `y`).
fn island_end(app: &AppHandle, x: f64, y: f64) -> Option<(f64, f64)> {
    let (point, unit) = island_point(app, x, y)?;
    Some(logic::origin_for_head(point, (HEAD_X, HEAD_Y), unit))
}

/// Where Liv goes when it goes out: the spot it is remembered at, while its
/// display is still there; with `anywhere`, else the corner of the island's
/// display. None: it stays in the island.
fn spot(app: &AppHandle, anywhere: bool) -> Option<(f64, f64)> {
    let all = displays(app);
    let island = island_size(app);
    let saved = app.try_state::<crate::Shared>().and_then(|s| s.settings.lock().unwrap().pet_spot.clone());
    let restored = saved.and_then(|spot| logic::restore_spot(&spot, &all, PAGE, island, MARGIN));
    if restored.is_some() || !anywhere {
        return restored;
    }
    let ((x, y), _) = island_point(app, 0.0, 0.0)?;
    let home = logic::display_near((x, y + 1.0), &all)?;
    Some(logic::default_spot(home, PAGE, island, MARGIN))
}

// ── The window ────────────────────────────────────────────────────────────────

/// Puts the window where Liv is, or leaves it waiting off-screen while Liv is
/// not to be seen.
fn place(app: &AppHandle, pet: &Pet, pos: (f64, f64)) {
    let on_screen = {
        let mut i = pet.inner.lock().unwrap();
        i.pos = pos;
        i.on_screen()
    };
    if !on_screen {
        return;
    }
    if let Some(win) = window(app) {
        let _ = win.set_position(PhysicalPosition::new(pos.0.round() as i32, pos.1.round() as i32));
    }
}

/// The window's size and zoom for the island's size in force, on the display
/// it is on.
fn resize(app: &AppHandle, pet: &Pet) {
    let Some(win) = window(app) else { return };
    let island = island_size(app);
    pet.gate.rescale(&win, island);
    let all = displays(app);
    {
        let mut i = pet.inner.lock().unwrap();
        i.unit = unit_at(i.pos, &all, island);
    }
    let _ = win.set_size(LogicalSize::new(PAGE_W * island, PAGE_H * island));
}

/// Shows or puts away the window as things stand, wakes or parks the poll,
/// and tells the page whether anybody sees it.
fn sync(app: &AppHandle, pet: &Pet) {
    let (on_screen, pos, polled) = {
        let i = pet.inner.lock().unwrap();
        (i.on_screen(), i.pos, i.out && !i.paused)
    };
    if let Some(win) = window(app) {
        crate::webview_memory::set_low(&win, !on_screen);
        let at = if on_screen { pos } else { PARKED };
        let _ = win.set_position(PhysicalPosition::new(at.0.round() as i32, at.1.round() as i32));
        if on_screen {
            let _ = win.set_always_on_top(true);
        }
    }
    refresh(app, pet);
    pet.gate.set_active(polled);
    let _ = app.emit_to(LABEL, "pet-shown", on_screen);
}

/// What takes the mouse while the poll is not the one to say: nothing while
/// Liv is away, on its way, or carried out of the island (the island's page
/// holds the mouse then); the whole window while it is carried on the desktop.
/// Standing there, the poll decides from the silhouette at its next tick.
fn refresh(app: &AppHandle, pet: &Pet) {
    let ignore = {
        let mut i = pet.inner.lock().unwrap();
        let ignore = match i.carry {
            _ if !i.on_screen() => Some(true),
            Some(carry) => Some(carry.from == Source::Island),
            None if !i.landed => Some(true),
            None => None,
        };
        let changed = ignore.is_some() && ignore != i.ignoring;
        i.ignoring = ignore;
        ignore.filter(|_| changed)
    };
    if let (Some(ignore), Some(win)) = (ignore, window(app)) {
        platform::set_click_through(&win, ignore);
    }
}

/// Writes what changed about where Liv lives, and tells every window when it
/// moved between the island and the desktop.
fn remember(app: &AppHandle, change: impl FnOnce(&mut settings::Settings)) {
    let Some(shared) = app.try_state::<crate::Shared>() else { return };
    let (snapshot, moved) = {
        let mut s = shared.settings.lock().unwrap();
        let before = s.pet_out;
        change(&mut s);
        (s.clone(), s.pet_out != before)
    };
    if let Err(err) = settings::save(&snapshot) {
        crate::log::line(format!("could not save settings: {err}"));
    }
    if moved {
        let _ = app.emit("pet-out", snapshot.pet_out);
    }
}

/// Liv stands at `pos`: inside its display's work area, clicked on by its
/// silhouette, and remembered there.
fn land(app: &AppHandle, pet: &Pet, pos: (f64, f64)) {
    let all = displays(app);
    let island = island_size(app);
    let at = logic::settle(pos, &all, PAGE, island, MARGIN).unwrap_or(pos);
    {
        let mut i = pet.inner.lock().unwrap();
        i.landed = true;
        i.carry = None;
    }
    place(app, pet, at);
    resize(app, pet);
    refresh(app, pet);
    let spot = logic::spot_of(at, &all, PAGE, island);
    remember(app, |s| {
        s.pet_out = true;
        if spot.is_some() {
            s.pet_spot = spot;
        }
    });
}

/// The window is put away: Liv is in the island.
fn put_away(app: &AppHandle, pet: &Pet) {
    {
        let mut i = pet.inner.lock().unwrap();
        i.out = false;
        i.landed = false;
        i.carry = None;
        i.asleep = false;
    }
    sync(app, pet);
}

/// The island's size changed, or its display: the window follows, around the
/// same centre.
pub fn apply_scale(app: &AppHandle) {
    let Some(pet) = state(app) else { return };
    if !pet.exists {
        return;
    }
    let all = displays(app);
    let island = island_size(app);
    let standing = {
        let i = pet.inner.lock().unwrap();
        let unit = unit_at(i.pos, &all, island);
        let centre = (i.pos.0 + PAGE_W * i.unit / 2.0, i.pos.1 + PAGE_H * i.unit / 2.0);
        (i.out && i.landed && unit != i.unit).then(|| (centre.0 - PAGE_W * unit / 2.0, centre.1 - PAGE_H * unit / 2.0))
    };
    match standing {
        Some(pos) => land(app, &pet, pos),
        None => resize(app, &pet),
    }
}

/// Liv stands where no display is any more, or under a taskbar that has
/// grown: it is brought back inside the nearest work area, and remembered
/// there. The poll looks while Liv is out, as the island's does for its own
/// display.
fn keep_on_a_display(app: &AppHandle, pet: &Pet) {
    let pos = {
        let i = pet.inner.lock().unwrap();
        if !i.landed || i.carry.is_some() {
            return;
        }
        i.pos
    };
    let Some(at) = logic::settle(pos, &displays(app), PAGE, island_size(app), MARGIN) else { return };
    if (at.0 - pos.0).abs() >= 1.0 || (at.1 - pos.1).abs() >= 1.0 {
        crate::log::line("Liv's spot is no longer on a display — it moves onto the nearest".to_string());
        land(app, pet, at);
    }
}

/// The island is paused from the tray, or back: Liv leaves the screen with it.
pub fn set_paused(app: &AppHandle, paused: bool) {
    let Some(pet) = state(app) else { return };
    if !pet.exists {
        return;
    }
    {
        let mut i = pet.inner.lock().unwrap();
        if i.paused == paused {
            return;
        }
        i.paused = paused;
    }
    sync(app, &pet);
}

// ── The poll ──────────────────────────────────────────────────────────────────

/// Parks the window while another app is full screen on the display Liv is
/// on (when Settings says so), and brings it back when that ends.
fn watch_fullscreen(app: &AppHandle, pet: &Pet) {
    let wanted = app
        .try_state::<crate::Shared>()
        .is_some_and(|shared| shared.settings.lock().unwrap().hide_on_fullscreen);
    let covered = if wanted {
        let centre = {
            let i = pet.inner.lock().unwrap();
            ((i.pos.0 + PAGE_W * i.unit / 2.0).round() as i32, (i.pos.1 + PAGE_H * i.unit / 2.0).round() as i32)
        };
        // Nothing to judge by at this instant: things stay as they are.
        let Some(covered) = platform::fullscreen_in_front(centre) else { return };
        covered
    } else {
        false
    };
    {
        let mut i = pet.inner.lock().unwrap();
        if i.covered == covered {
            return;
        }
        i.covered = covered;
    }
    crate::log::line(
        if covered { "an app is full screen — Liv's window parked" } else { "full screen over — Liv's window back" }
            .to_string(),
    );
    sync(app, pet);
}

/// The poll's period, ms: the island's own cadences. Asleep or parked, the
/// slowest; with the pointer far, slow; near or carried, every frame.
fn period(covered: bool, asleep: bool, carried: bool, far: bool) -> u64 {
    if carried {
        16
    } else if covered || asleep {
        island::PARKED_PERIOD_MS
    } else if far {
        island::FAR_PERIOD_MS
    } else {
        16
    }
}

/// Runs only while Liv is out: carries the window under the pointer, makes it
/// click-through everywhere but on Liv, tells the page where the pointer is
/// while it is near, and about twice a second looks for a full-screen app
/// and for a display that went away.
fn spawn_poll(app: AppHandle, pet: Arc<Pet>) {
    std::thread::spawn(move || loop {
        pet.gate.wait_until_active();
        let mut last = (f64::MIN, f64::MIN);
        let mut far = false;
        let mut looked: Option<Instant> = None;
        while pet.gate.is_active() {
            let (covered, asleep, carried) = {
                let i = pet.inner.lock().unwrap();
                (i.covered, i.asleep, i.carry.is_some())
            };
            std::thread::sleep(Duration::from_millis(period(covered, asleep, carried, far)));
            if !pet.gate.is_active() {
                break;
            }
            if looked.is_none_or(|at| at.elapsed() >= island::FULLSCREEN_PERIOD) {
                looked = Some(Instant::now());
                keep_on_a_display(&app, &pet);
                watch_fullscreen(&app, &pet);
            }
            let Some((cx, cy)) = platform::cursor_physical() else { continue };

            let carry = pet.inner.lock().unwrap().carry;
            if let Some(carry) = carry {
                if platform::left_button_down() {
                    let pos = (cx - carry.grab.0, cy - carry.grab.1);
                    if pos != pet.inner.lock().unwrap().pos {
                        place(&app, &pet, pos);
                    }
                } else {
                    let_go(&app, &pet, carry.from, (cx, cy));
                }
                last = (f64::MIN, f64::MIN);
                continue;
            }

            let (landed, on_screen, pos, unit) = {
                let i = pet.inner.lock().unwrap();
                (i.landed, i.on_screen(), i.pos, i.unit)
            };
            // On its way, or off-screen: no pointer can be on it.
            if !landed || !on_screen {
                last = (f64::MIN, f64::MIN);
                continue;
            }
            let local = ((cx - pos.0) / unit, (cy - pos.1) / unit);
            let accept = {
                let mut i = pet.inner.lock().unwrap();
                let accept = logic::over_shape(local, &i.shape);
                let changed = i.ignoring != Some(!accept);
                i.ignoring = Some(!accept);
                changed.then_some(accept)
            };
            if let (Some(accept), Some(win)) = (accept, window(&app)) {
                platform::set_click_through(&win, !accept);
            }
            if (local.0 - last.0).abs() < 1.0 && (local.1 - last.1).abs() < 1.0 {
                continue;
            }
            last = local;
            // Far from Liv: the page hears it once, then nothing.
            let near = island::is_near(local.0, local.1, PAGE);
            if !near && far {
                continue;
            }
            far = !near;
            let _ = app.emit_to(LABEL, "pet-cursor", Cursor { x: local.0, y: local.1 });
        }
    });
}

/// The pointer let go of Liv. It stands where it is at once, so a click finds
/// it; the island's page says whether that is home or its new spot
/// (src/pet/drag.ts), and answers with `pet_settle` or `pet_hide`.
fn let_go(app: &AppHandle, pet: &Pet, from: Source, cursor: (f64, f64)) {
    {
        let mut i = pet.inner.lock().unwrap();
        i.carry = None;
        i.landed = true;
    }
    refresh(app, pet);
    let _ = app.emit_to(LABEL, "pet-held", false);
    // Where the pointer is in the island's page; nowhere near it while the
    // island is not on screen.
    let (x, y) = app
        .try_state::<crate::Shared>()
        .and_then(|shared| island::page_point(app, &shared.gate, cursor))
        .unwrap_or((-10_000.0, -10_000.0));
    let _ = app.emit_to(island::WINDOW_LABEL, "pet-dropped", Dropped { x, y, from });
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// The window's page hands over Liv's silhouette, in page px.
#[tauri::command]
pub fn pet_shape(pet: State<Arc<Pet>>, shape: Vec<Disc>) {
    if !logic::valid_shape(&shape, PAGE) {
        return;
    }
    let mut i = pet.inner.lock().unwrap();
    i.shape = shape;
}

/// The window's page reports its pixel ratio: the zoom is corrected when it
/// is not the display's scale times the island's size. True when it changed.
#[tauri::command]
pub fn pet_fit_zoom(app: AppHandle, pet: State<Arc<Pet>>, dpr: f64) -> bool {
    let Some(win) = window(&app) else { return false };
    pet.gate.fit_zoom(&win, dpr)
}

/// The window's page asks once as it loads, in case it missed the event:
/// whether the window is on screen.
#[tauri::command]
pub fn pet_shown(pet: State<Arc<Pet>>) -> bool {
    pet.inner.lock().unwrap().on_screen()
}

/// The window's page fell asleep, or woke: asleep, the poll drops to its
/// slowest cadence.
#[tauri::command]
pub fn pet_asleep(pet: State<Arc<Pet>>, asleep: bool) {
    pet.inner.lock().unwrap().asleep = asleep;
}

/// The two ends of a way between the island and Liv's spot, for the island's
/// page to draw the way between them. (`x`, `y`): where Liv is in the
/// island's page. None when there is nowhere to go: no window, no spot it can
/// go back to (it is then remembered as living in the island), or — for the
/// way home — a Liv that is not out.
#[tauri::command]
pub fn pet_route(app: AppHandle, pet: State<Arc<Pet>>, to: Arrive, x: f64, y: f64, anywhere: bool) -> Option<Route> {
    if !pet.exists {
        return None;
    }
    let island = island_end(&app, x, y)?;
    let all = displays(&app);
    let (from, to) = match to {
        Arrive::Spot => {
            let Some(spot) = spot(&app, anywhere) else {
                crate::log::line("Liv's spot is on a display that is gone — it stays in the island".to_string());
                remember(&app, |s| s.pet_out = false);
                return None;
            };
            (island, spot)
        }
        Arrive::Home => {
            let i = pet.inner.lock().unwrap();
            if !i.out {
                return None;
            }
            (i.pos, island)
        }
    };
    Some(Route { from, to, unit: unit_at(to, &all, island_size(&app)) })
}

/// Moves the window along `points`, evenly spaced over `ms`, and Liv arrives:
/// at its spot it lands (held inside its display, whatever the last point
/// says) and is remembered there; home, the window is put away. False when a
/// later way, a grab or a `pet_hide` took over before the end.
#[tauri::command]
pub async fn pet_travel(app: AppHandle, points: Vec<(f64, f64)>, ms: u64, to: Arrive) -> bool {
    let Some(pet) = state(&app) else { return false };
    if !pet.exists || !logic::valid_way(&points, MAX_WAY_POINTS) {
        return false;
    }
    let ms = ms.clamp(1, MAX_WAY_MS);
    let token = pet.way.fetch_add(1, Ordering::SeqCst) + 1;
    let (first, last) = (points[0], points[points.len() - 1]);
    let coming_out = {
        let mut i = pet.inner.lock().unwrap();
        let coming_out = !i.out;
        i.out = true;
        i.landed = false;
        i.carry = None;
        i.asleep = false;
        i.pos = first;
        coming_out
    };
    resize(&app, &pet);
    let unit = pet.inner.lock().unwrap().unit;
    let way = match (to, coming_out) {
        (Arrive::Home, _) => "home",
        (Arrive::Spot, true) => "out",
        (Arrive::Spot, false) => "move",
    };
    // Said before the window shows: the page's first frame already has Liv
    // as it sets off, small in the island's place.
    let _ = app.emit_to(LABEL, "pet-travel", Travel { dx: (last.0 - first.0) / unit, dy: (last.1 - first.1) / unit, ms, way });
    sync(&app, &pet);

    let handle = app.clone();
    let mover = pet.clone();
    let arrived = tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        loop {
            if mover.way.load(Ordering::SeqCst) != token {
                return false;
            }
            let t = started.elapsed().as_secs_f64() * 1000.0 / ms as f64;
            place(&handle, &mover, logic::along(&points, t));
            if t >= 1.0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(STEP_MS));
        }
    })
    .await
    .unwrap_or(false);
    if !arrived || pet.way.load(Ordering::SeqCst) != token {
        return false;
    }
    match to {
        Arrive::Spot => land(&app, &pet, last),
        Arrive::Home => put_away(&app, &pet),
    }
    true
}

/// Liv starts where it was left on the desktop, without the way there. False
/// when its spot is on a display that is gone: it is then remembered as
/// living in the island.
#[tauri::command]
pub fn pet_appear(app: AppHandle, pet: State<Arc<Pet>>) -> bool {
    if !pet.exists {
        return false;
    }
    let Some(spot) = spot(&app, false) else {
        crate::log::line("Liv's spot is on a display that is gone — it stays in the island".to_string());
        remember(&app, |s| s.pet_out = false);
        return false;
    };
    pet.way.fetch_add(1, Ordering::SeqCst);
    {
        let mut i = pet.inner.lock().unwrap();
        i.out = true;
        i.asleep = false;
        i.pos = spot;
    }
    resize(&app, &pet);
    sync(&app, &pet);
    land(&app, &pet, spot);
    true
}

/// Dragged out of the island: the window appears with Liv's head under the
/// pointer, and the poll carries it from here on. False when it cannot — no
/// window, Liv already out, or no button held any more.
#[tauri::command]
pub fn pet_pick_up(app: AppHandle, pet: State<Arc<Pet>>) -> bool {
    if !pet.exists || pet.inner.lock().unwrap().out || !platform::left_button_down() {
        return false;
    }
    let Some(cursor) = platform::cursor_physical() else { return false };
    pet.way.fetch_add(1, Ordering::SeqCst);
    let unit = unit_at(cursor, &displays(&app), island_size(&app));
    let grab = (HEAD_X * unit, HEAD_Y * unit);
    {
        let mut i = pet.inner.lock().unwrap();
        i.out = true;
        i.landed = false;
        i.asleep = false;
        i.carry = Some(Carry { grab, from: Source::Island });
        i.pos = (cursor.0 - grab.0, cursor.1 - grab.1);
    }
    resize(&app, &pet);
    sync(&app, &pet);
    let _ = app.emit_to(LABEL, "pet-held", true);
    true
}

/// The window's page saw a drag start on Liv: the poll carries the window
/// from here on. False when Liv does not stand there, or no button is held.
#[tauri::command]
pub fn pet_grab(app: AppHandle, pet: State<Arc<Pet>>) -> bool {
    if !platform::left_button_down() {
        return false;
    }
    let Some(cursor) = platform::cursor_physical() else { return false };
    {
        let mut i = pet.inner.lock().unwrap();
        if !i.landed || !i.on_screen() || i.carry.is_some() {
            return false;
        }
        i.landed = false;
        i.asleep = false;
        i.carry = Some(Carry { grab: (cursor.0 - i.pos.0, cursor.1 - i.pos.1), from: Source::Desktop });
    }
    pet.way.fetch_add(1, Ordering::SeqCst);
    refresh(&app, &pet);
    let _ = app.emit_to(LABEL, "pet-held", true);
    let _ = app.emit_to(island::WINDOW_LABEL, "pet-grabbed", ());
    true
}

/// Dropped on the desktop: Liv stays there, and that is its spot.
#[tauri::command]
pub fn pet_settle(app: AppHandle, pet: State<Arc<Pet>>) {
    let pos = {
        let i = pet.inner.lock().unwrap();
        if !i.out || i.carry.is_some() {
            return;
        }
        i.pos
    };
    land(&app, &pet, pos);
}

/// The window is put away, now: Liv is in the island. `forget`: it lives
/// there again, and the next launch leaves it there.
#[tauri::command]
pub fn pet_hide(app: AppHandle, pet: State<Arc<Pet>>, forget: bool) {
    if !pet.exists {
        return;
    }
    pet.way.fetch_add(1, Ordering::SeqCst);
    put_away(&app, &pet);
    if forget {
        remember(&app, |s| s.pet_out = false);
    }
}

/// The switch in Settings: Liv on the desktop, or back in the island. The
/// island's page does it, as it does for the shortcut. False when Liv cannot
/// leave the island here.
#[tauri::command]
pub fn pet_ask(app: AppHandle, pet: State<Arc<Pet>>, out: bool) -> bool {
    if pet.exists {
        let _ = app.emit_to(island::WINDOW_LABEL, "pet-ask", out);
    }
    pet.exists
}

#[cfg(test)]
mod tests {
    use super::logic::*;
    use super::{period, DisplayId, PetSpot, HEAD_X, HEAD_Y, PAGE_H, PAGE_W};
    use crate::island;

    const PAGE: (f64, f64) = (PAGE_W, PAGE_H);
    const MARGIN: f64 = 8.0;

    fn display(name: &str, frame: Rect, taskbar: f64, scale: f64) -> Display {
        Display {
            id: DisplayId {
                name: name.into(),
                x: (frame.x / scale).round() as i32,
                y: (frame.y / scale).round() as i32,
                w: (frame.w / scale).round() as i32,
                h: (frame.h / scale).round() as i32,
            },
            frame,
            work: Rect { h: frame.h - taskbar, ..frame },
            scale,
        }
    }

    /// A 1920×1080 laptop at 100 %, and a 4K monitor at 200 % on its right,
    /// in physical px; both with a taskbar at the bottom.
    fn two_displays() -> Vec<Display> {
        vec![
            display("eDP-1", Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 }, 48.0, 1.0),
            display("DELL U2720Q", Rect { x: 1920.0, y: -200.0, w: 3840.0, h: 2160.0 }, 96.0, 2.0),
        ]
    }

    // ── The silhouette ────────────────────────────────────────────────────────

    #[test]
    fn only_the_silhouette_takes_the_mouse() {
        let shape = [Disc { x: 51.0, y: 68.0, r: 28.0 }, Disc { x: 21.0, y: 82.0, r: 5.0 }];
        assert!(over_shape((51.0, 68.0), &shape), "the middle of the head");
        assert!(over_shape((51.0 + 27.5, 68.0), &shape), "just inside its edge");
        assert!(!over_shape((51.0 + 28.5, 68.0), &shape), "just outside it");
        assert!(over_shape((19.0, 84.0), &shape), "a hand");
        assert!(!over_shape((2.0, 2.0), &shape), "the corner of the window");
        assert!(!over_shape((51.0, 10.0), &shape), "the air above the head");
        // Before the page has said what Liv looks like, nothing is Liv.
        assert!(!over_shape((51.0, 68.0), &[]));
    }

    #[test]
    fn a_silhouette_is_a_few_discs_inside_the_window() {
        let head = Disc { x: HEAD_X, y: HEAD_Y, r: 28.0 };
        assert!(valid_shape(&[head], PAGE));
        assert!(!valid_shape(&[], PAGE));
        assert!(!valid_shape(&[head; 17], PAGE));
        for bad in [
            Disc { r: 0.0, ..head },
            Disc { r: -3.0, ..head },
            Disc { r: f64::NAN, ..head },
            Disc { x: f64::INFINITY, ..head },
            // A disc that would take clicks beyond the window, or all of it.
            Disc { x: 10.0, ..head },
            Disc { r: 500.0, ..head },
        ] {
            assert!(!valid_shape(&[head, bad], PAGE), "{bad:?}");
        }
    }

    // ── Spots ─────────────────────────────────────────────────────────────────

    #[test]
    fn a_window_is_kept_inside_the_work_area() {
        let work = Rect { x: 0.0, y: 0.0, w: 1440.0, h: 860.0 };
        let size = (102.0, 109.0);
        assert_eq!(clamp_origin((600.0, 400.0), size, work, 8.0), (600.0, 400.0));
        assert_eq!(clamp_origin((-50.0, 400.0), size, work, 8.0).0, 8.0);
        assert_eq!(clamp_origin((2000.0, 400.0), size, work, 8.0).0, 1440.0 - 102.0 - 8.0);
        assert_eq!(clamp_origin((400.0, -50.0), size, work, 8.0).1, 8.0);
        assert_eq!(clamp_origin((400.0, 2000.0), size, work, 8.0).1, 860.0 - 109.0 - 8.0, "above the taskbar");
        // A work area smaller than the window: its top-left corner is what shows.
        let tiny = Rect { x: 100.0, y: 50.0, w: 60.0, h: 40.0 };
        assert_eq!(clamp_origin((0.0, 0.0), size, tiny, 8.0), (108.0, 58.0));
    }

    #[test]
    fn a_drop_settles_on_the_display_under_it_at_that_displays_scale() {
        let d = two_displays();
        // In the open: it stays where it was dropped.
        assert_eq!(settle((800.0, 500.0), &d, PAGE, 1.0, MARGIN), Some((800.0, 500.0)));
        // Against the right edge of the laptop, its centre still on it.
        assert_eq!(settle((1860.0, 500.0), &d, PAGE, 1.0, MARGIN), Some((1920.0 - 102.0 - 8.0, 500.0)));
        // Its centre over the 4K display: it moves onto it, twice as big.
        assert_eq!(settle((1900.0, 500.0), &d, PAGE, 1.0, MARGIN), Some((1920.0 + 16.0, 500.0)));
        // Under the taskbar of the 4K display.
        let (_, y) = settle((3000.0, 1900.0), &d, PAGE, 1.0, MARGIN).unwrap();
        assert_eq!(y, -200.0 + 2160.0 - 96.0 - 218.0 - 16.0);
        // The island bigger: so is the window, and its margin.
        let (x, _) = settle((1900.0, 500.0), &d[..1], PAGE, 1.5, MARGIN).unwrap();
        assert_eq!(x, 1920.0 - 153.0 - 12.0);
    }

    #[test]
    fn whatever_a_page_asks_for_the_window_ends_on_a_display() {
        let d = two_displays();
        for wild in [(-90_000.0, 40.0), (1e12, -1e12), (500.0, 99_999.0), (-32_000.0, -32_000.0)] {
            let (x, y) = settle(wild, &d, PAGE, 1.0, MARGIN).unwrap();
            let on = d.iter().find(|m| m.work.contains((x, y))).unwrap_or_else(|| panic!("{wild:?} -> {x},{y}"));
            let size = size_on(on, PAGE, 1.0);
            assert!(on.work.contains((x + size.0 - 1.0, y + size.1 - 1.0)), "{wild:?}: all of it");
        }
        // Not a place at all, or no display to be on.
        assert_eq!(settle((f64::NAN, 0.0), &d, PAGE, 1.0, MARGIN), None);
        assert_eq!(settle((0.0, f64::INFINITY), &d, PAGE, 1.0, MARGIN), None);
        assert_eq!(settle((10.0, 10.0), &[], PAGE, 1.0, MARGIN), None);
    }

    #[test]
    fn the_first_time_out_is_the_bottom_right_corner_of_the_work_area() {
        let d = two_displays();
        assert_eq!(default_spot(&d[0], PAGE, 1.0, MARGIN), (1920.0 - 110.0, 1032.0 - 117.0));
        assert_eq!(
            default_spot(&d[1], PAGE, 1.0, MARGIN),
            (1920.0 + 3840.0 - 204.0 - 16.0, -200.0 + 2064.0 - 218.0 - 16.0)
        );
        // With the island at 125 % the window is bigger, and still all inside.
        let (x, y) = default_spot(&d[0], PAGE, 1.25, MARGIN);
        assert_eq!((x, y), (1920.0 - 127.5 - 10.0, 1032.0 - 136.25 - 10.0));
    }

    #[test]
    fn a_spot_is_found_again_where_it_was_left() {
        let d = two_displays();
        for origin in [(800.0, 500.0), (1810.0, 915.0), (3000.0, 1000.0)] {
            let spot = spot_of(origin, &d, PAGE, 1.0).unwrap();
            assert_eq!(restore_spot(&spot, &d, PAGE, 1.0, MARGIN), Some(origin), "{origin:?}");
        }
        // It is its centre that is kept, from its display's corner, in logical px.
        let spot = spot_of((3000.0, 1000.0), &d, PAGE, 1.0).unwrap();
        assert_eq!(spot.display, d[1].id.key());
        assert_eq!((spot.x, spot.y), ((3000.0 + 102.0 - 1920.0) / 2.0, (1000.0 + 109.0 + 200.0) / 2.0));
        assert_eq!(spot_of((10.0, 10.0), &[], PAGE, 1.0), None);
    }

    #[test]
    fn a_spot_survives_a_change_of_scale_and_of_the_islands_size() {
        let d = two_displays();
        let spot = spot_of((800.0, 500.0), &d, PAGE, 1.0).unwrap();
        // The island at 150 %: the same centre, a bigger window around it.
        let (x, y) = restore_spot(&spot, &d, PAGE, 1.5, MARGIN).unwrap();
        assert_eq!((x + 153.0 / 2.0, y + 163.5 / 2.0), (851.0, 554.5));
        // The laptop now at 125 % (2400×1350 physical): the same place on it.
        let scaled = vec![display("eDP-1", Rect { x: 0.0, y: 0.0, w: 2400.0, h: 1350.0 }, 60.0, 1.25)];
        let (x, y) = restore_spot(&spot, &scaled, PAGE, 1.0, MARGIN).unwrap();
        assert_eq!((x + 127.5 / 2.0, y + 136.25 / 2.0), (851.0 * 1.25, 554.5 * 1.25));
    }

    #[test]
    fn a_spot_on_a_display_that_is_gone_is_refused() {
        let d = two_displays();
        let on_dell = spot_of((3000.0, 1000.0), &d, PAGE, 1.0).unwrap();
        assert_eq!(restore_spot(&on_dell, &d[..1], PAGE, 1.0, MARGIN), None, "unplugged");
        assert_eq!(restore_spot(&on_dell, &[], PAGE, 1.0, MARGIN), None);
        // Still there after the layout was rearranged: found by its name.
        let moved = vec![
            display("DELL U2720Q", Rect { x: 0.0, y: 0.0, w: 3840.0, h: 2160.0 }, 96.0, 2.0),
            display("eDP-1", Rect { x: 3840.0, y: 0.0, w: 1920.0, h: 1080.0 }, 48.0, 1.0),
        ];
        let (x, y) = restore_spot(&on_dell, &moved, PAGE, 1.0, MARGIN).unwrap();
        assert_eq!((x, y), (3000.0 - 1920.0, 1000.0 + 200.0));
        // A key nobody can read, or numbers that are not a place.
        let nonsense = PetSpot { display: "somewhere".into(), x: 10.0, y: 10.0 };
        assert_eq!(restore_spot(&nonsense, &d, PAGE, 1.0, MARGIN), None);
        let nowhere = PetSpot { x: f64::NAN, ..on_dell.clone() };
        assert_eq!(restore_spot(&nowhere, &d, PAGE, 1.0, MARGIN), None);
    }

    #[test]
    fn a_spot_a_taller_taskbar_now_covers_moves_up_and_one_off_its_display_comes_back_in() {
        let d = two_displays();
        let spot = spot_of((800.0, 915.0), &d, PAGE, 1.0).unwrap();
        let taller = vec![display("eDP-1", Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 }, 120.0, 1.0)];
        assert_eq!(restore_spot(&spot, &taller, PAGE, 1.0, MARGIN), Some((800.0, 960.0 - 109.0 - 8.0)));
        // Written by hand, far outside its display.
        let far = PetSpot { x: 50_000.0, y: -50_000.0, ..spot };
        assert_eq!(restore_spot(&far, &d, PAGE, 1.0, MARGIN), Some((1920.0 - 110.0, 8.0)));
    }

    // ── Ways ──────────────────────────────────────────────────────────────────

    #[test]
    fn the_window_leaves_the_island_with_livs_head_where_it_was() {
        assert_eq!(origin_for_head((960.0, 16.0), (HEAD_X, HEAD_Y), 1.0), (909.0, -52.0));
        assert_eq!(origin_for_head((2880.0, 30.0), (HEAD_X, HEAD_Y), 2.0), (2778.0, -106.0));
    }

    #[test]
    fn a_way_is_followed_point_to_point_evenly_in_time() {
        let way = [(0.0, 0.0), (10.0, 0.0), (10.0, 20.0)];
        assert_eq!(along(&way, 0.0), (0.0, 0.0));
        assert_eq!(along(&way, 0.25), (5.0, 0.0));
        assert_eq!(along(&way, 0.5), (10.0, 0.0));
        assert_eq!(along(&way, 0.75), (10.0, 10.0));
        assert_eq!(along(&way, 1.0), (10.0, 20.0));
        // Before the start and past the end it is at the ends.
        assert_eq!(along(&way, -3.0), (0.0, 0.0));
        assert_eq!(along(&way, 7.0), (10.0, 20.0));
        assert_eq!(along(&way, f64::NAN), (10.0, 20.0));
        assert_eq!(along(&[(4.0, 5.0)], 0.3), (4.0, 5.0));
    }

    #[test]
    fn a_way_is_at_least_two_places_and_not_too_many() {
        assert!(valid_way(&[(0.0, 0.0), (5.0, 5.0)], 512));
        assert!(!valid_way(&[], 512));
        assert!(!valid_way(&[(0.0, 0.0)], 512));
        assert!(!valid_way(&vec![(1.0, 1.0); 513], 512));
        assert!(!valid_way(&[(0.0, 0.0), (f64::NAN, 5.0)], 512));
        assert!(!valid_way(&[(0.0, f64::NEG_INFINITY), (1.0, 5.0)], 512));
    }

    // ── The poll ──────────────────────────────────────────────────────────────

    #[test]
    fn the_poll_keeps_the_islands_cadences() {
        // Near: every frame. Far: slow. Asleep or parked: the slowest.
        assert_eq!(period(false, false, false, false), 16);
        assert_eq!(period(false, false, false, true), island::FAR_PERIOD_MS);
        assert_eq!(period(false, true, false, false), island::PARKED_PERIOD_MS);
        assert_eq!(period(false, true, false, true), island::PARKED_PERIOD_MS);
        assert_eq!(period(true, false, false, false), island::PARKED_PERIOD_MS);
        assert!(island::PARKED_PERIOD_MS > island::FAR_PERIOD_MS && island::FAR_PERIOD_MS > 16);
        // Carried, it follows the pointer every frame, whatever else.
        assert_eq!(period(false, true, true, true), 16);
    }
}
