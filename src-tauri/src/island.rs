// Island window: placement on the chosen display, the two window sizes (full
// panel / folded to the closed island, or to an invisible wake strip when it
// shows nothing), click-through and the cursor poll.
//
// There is no notch on a PC, so the island is a black shape drawn at the top
// centre of the main display inside a borderless, transparent, always-on-top
// window that never takes focus.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::platform::{self, cursor_physical, left_button_down};
use crate::scale;

/// Logical size of the full window — the largest island view, like the macOS panel.
/// In page px: the window is this times the island's size (scale.rs).
/// This is the inherited panel: an island made wider or taller in Settings →
/// Appearance has a panel that grows with it (appearance.rs: `panel`), and the
/// one in force is `PollGate::panel`.
pub const PANEL_W: f64 = 720.0;
pub const PANEL_H: f64 = 320.0;
/// Logical size of the invisible strip that wakes the island when it is hidden
/// and the closed island is set to show nothing.
pub const STRIP_W: f64 = 240.0;
pub const STRIP_H: f64 = 6.0;

pub const WINDOW_LABEL: &str = "island";

/// Around the window, how far the cursor is still worth telling the page
/// about (the island's frames run on it), in page px. Past it the page hears once
/// that the cursor left, then nothing until it comes back: a cursor working in
/// another app costs neither messages nor island frames.
const NEAR_ZONE: f64 = 420.0;
/// The poll's period while the cursor is far from the island, in ms.
pub(crate) const FAR_PERIOD_MS: u64 = 50;

/// Where the window waits while another app is full screen on its display
/// (fullscreen.rs), in physical px: far off every display, where Windows itself
/// keeps minimized windows. Moved, never hidden: showing a window again can
/// take the focus from the app in front, and a move never does.
pub(crate) const PARKED_AT: i32 = -32000;
/// How often the poll looks for a full-screen app and for a change of
/// displays: about twice a second, awake, folded or parked.
pub(crate) const FULLSCREEN_PERIOD: Duration = Duration::from_millis(450);

/// The island's size in force, told to every window when it changes or is
/// asked for again: Settings shows it next to the size the user picked.
pub const SCALE_EVENT: &str = "island-scale";
/// The poll's period while the window is parked, in ms: there is no cursor to
/// follow, only the full-screen app to see leave.
pub(crate) const PARKED_PERIOD_MS: u64 = 250;

/// Whether a cursor at (x, y), in page px, is near a window of `size`.
pub(crate) fn is_near(x: f64, y: f64, size: (f64, f64)) -> bool {
    x >= -NEAR_ZONE && x <= size.0 + NEAR_ZONE && y >= -NEAR_ZONE && y <= size.1 + NEAR_ZONE
}

/// Margin around the island that still counts as "on the island", in page px.
/// Wider than the macOS 6 pt because a click must never be swallowed.
const HIT_MARGIN: f64 = 14.0;

/// How near the island a file being dragged has to come for the window to
/// take it, in page px: right in front of the island. Anywhere else under the
/// panel the drag goes on to what is behind — a file being moved about the
/// desktop is not a file for Liv.
const DROP_MARGIN: f64 = 20.0;

/// Whether (x, y) is on `rect` or within `margin` of it; never on an island with no shape yet.
fn within(rect: &IslandRect, margin: f64, x: f64, y: f64) -> bool {
    rect.w > 0.0
        && x >= rect.x - margin
        && x <= rect.x + rect.w + margin
        && y >= rect.y - margin
        && y <= rect.y + rect.h + margin
}

/// Whether the window takes the mouse for a button held down. A press that
/// began on the island keeps the whole panel while it lasts (a slider dragged
/// past the edge, text being selected, something on its way out of the
/// shelf); one that began elsewhere is a file being brought, and counts only
/// in the drop zone around the island.
fn takes_drag(down: bool, pressed_on_island: bool, in_panel: bool, in_drop_zone: bool) -> bool {
    down && if pressed_on_island { in_panel } else { in_drop_zone }
}

#[derive(Serialize, Clone)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
}

/// The island shape in page px, pushed by the front end.
/// The poll thread owns the click-through decision so it lands in the same 16 ms
/// tick as the cursor read — an IPC round trip here loses clicks.
#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Wakes / parks the cursor poll thread so a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub collapsed: AtomicBool,
    /// The window's size while collapsed, in page px: the closed island the
    /// page draws, or the wake strip.
    pub collapsed_size: Mutex<(f64, f64)>,
    /// Folded where the window stays as it is (platform::FOLDS_IN_PLACE): the
    /// part of it that is the closed island, in px of the window; None open.
    pub folded_part: Mutex<Option<(i32, i32, i32, i32)>>,
    pub rect: Mutex<IslandRect>,
    /// Mirrors the window flag so we only call into the OS when it changes.
    ignoring: AtomicBool,
    /// The island's size in force (scale.rs), as the bits of an f64: what
    /// Settings asks for, or less on a display too small for it.
    scale: AtomicU64,
    /// The webview's zoom: the island's size times the pixel-ratio correction.
    zoom: Mutex<f64>,
    /// The zoom before the island's size last changed, until the page reports
    /// a ratio measured under the new one (measured_before_rezoom).
    zoom_before: Mutex<Option<f64>>,
    /// Another app is full screen on the island's display: the window waits
    /// off-screen (see PARKED_AT).
    parked: AtomicBool,
    /// Where the island sits, top centre, in physical screen px: the display
    /// under it is the one a full-screen app has to cover.
    anchor: Mutex<Option<(i32, i32)>>,
    /// The full window's size in page px, as the bits of two f64: the
    /// inherited panel, or more for an island made wider or taller
    /// (appearance.rs). Set at launch and whenever the settings change, so
    /// nobody needs the settings' lock to know it.
    panel_w: AtomicU64,
    panel_h: AtomicU64,
    /// Counts the times the panel got smaller: the window follows a moment
    /// later, and only for the last of them (lib.rs: `panel_changed`).
    shrinks: AtomicU64,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            collapsed: AtomicBool::new(true),
            collapsed_size: Mutex::new((STRIP_W, STRIP_H)),
            folded_part: Mutex::new(None),
            rect: Mutex::new(IslandRect::default()),
            ignoring: AtomicBool::new(false),
            scale: AtomicU64::new(1.0f64.to_bits()),
            zoom: Mutex::new(1.0),
            zoom_before: Mutex::new(None),
            parked: AtomicBool::new(false),
            anchor: Mutex::new(None),
            panel_w: AtomicU64::new(PANEL_W.to_bits()),
            panel_h: AtomicU64::new(PANEL_H.to_bits()),
            shrinks: AtomicU64::new(0),
        }
    }

    /// The full window's size in force, in page px.
    pub fn panel(&self) -> (f64, f64) {
        (
            f64::from_bits(self.panel_w.load(Ordering::Relaxed)),
            f64::from_bits(self.panel_h.load(Ordering::Relaxed)),
        )
    }

    /// Puts a new panel in force and gives back the one it replaces. The
    /// window itself is resized by `apply_geometry`, which the caller asks for.
    pub fn set_panel(&self, (w, h): (f64, f64)) -> (f64, f64) {
        (
            f64::from_bits(self.panel_w.swap(w.to_bits(), Ordering::Relaxed)),
            f64::from_bits(self.panel_h.swap(h.to_bits(), Ordering::Relaxed)),
        )
    }

    /// The panel just got smaller: the ticket of this time, for `last_shrink`.
    pub fn note_shrink(&self) -> u64 {
        self.shrinks.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Whether the panel has not got smaller again since `ticket` was given.
    pub fn last_shrink(&self, ticket: u64) -> bool {
        self.shrinks.load(Ordering::Relaxed) == ticket
    }

    /// The island's size in force: page px times this are window-logical px.
    pub fn scale(&self) -> f64 {
        f64::from_bits(self.scale.load(Ordering::Relaxed))
    }

    /// Puts a new size in force for `win`'s page: its webview's zoom follows at
    /// once. The size it replaces and the new zoom, when it changed. Liv's
    /// desktop window keeps a gate of its own and follows the island's size
    /// through this (pet.rs).
    pub(crate) fn rescale(&self, win: &WebviewWindow, size: f64) -> Option<(f64, f64)> {
        let mut zoom = self.zoom.lock().unwrap();
        let old = f64::from_bits(self.scale.swap(size.to_bits(), Ordering::Relaxed));
        if old == size {
            return None;
        }
        *self.zoom_before.lock().unwrap() = Some(*zoom);
        *zoom = scale::rezoom(*zoom, old, size);
        let _ = win.set_zoom(*zoom);
        Some((old, *zoom))
    }

    /// Puts a new island size in force; the webview's zoom follows in the same
    /// breath as the window's size, so the page never sees one without the other.
    fn set_scale(&self, win: &WebviewWindow, size: f64) {
        if let Some((old, zoom)) = self.rescale(win, size) {
            crate::log::line(format!("island size {old} -> {size} — setting zoom {zoom:.3}"));
            let _ = win.emit(SCALE_EVENT, size);
        }
    }

    /// The page reports its devicePixelRatio: if it is not the window's scale
    /// times the island's size, the zoom is corrected. True when it changed.
    pub fn fit_zoom(&self, win: &WebviewWindow, dpr: f64) -> bool {
        let window_scale = win.scale_factor().unwrap_or(1.0);
        let size = if platform::ZOOM_IN_PIXEL_RATIO { self.scale() } else { 1.0 };
        let mut zoom = self.zoom.lock().unwrap();
        let mut before = self.zoom_before.lock().unwrap();
        if before.is_some_and(|b| measured_before_rezoom(dpr, b, *zoom, window_scale * size)) {
            return false;
        }
        *before = None;
        let Some(new_zoom) = calculate_zoom_correction(*zoom, window_scale * size, dpr) else { return false };
        *zoom = new_zoom;
        crate::log::line(format!(
            "webview dpr {dpr} != window scale {window_scale} x island size {size} — setting zoom {new_zoom:.3}"
        ));
        let _ = win.set_zoom(new_zoom);
        true
    }

    /// The window waits off-screen while another app is full screen.
    pub fn parked(&self) -> bool {
        self.parked.load(Ordering::Relaxed)
    }

    /// Where the island sits, top centre, in physical screen px; None until it is placed.
    pub fn anchor(&self) -> Option<(i32, i32)> {
        *self.anchor.lock().unwrap()
    }

    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
    }

    /// Forces the next poll tick to re-apply the flag (after a window resize).
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        *guard = on;
        self.cv.notify_all();
    }

    /// Waits until the gate opens, however long that takes: Liv's desktop
    /// window has nothing to look at while Liv is home (pet.rs).
    pub(crate) fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !*guard {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    /// Waits until the gate opens or `timeout` passes; true when it is open.
    pub(crate) fn wait_active_for(&self, timeout: Duration) -> bool {
        let guard = self.active.lock().unwrap();
        if *guard {
            return true;
        }
        let (guard, _) = self.cv.wait_timeout(guard, timeout).unwrap();
        *guard
    }

    pub(crate) fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// A display's logical origin, the key `at:<x>,<y>` preferences are matched on.
/// Names are no good for that: two monitors of the same model share one.
fn logical_origin(m: &Monitor) -> (i32, i32) {
    let scale = m.scale_factor();
    let p = m.position();
    ((p.x as f64 / scale).round() as i32, (p.y as f64 / scale).round() as i32)
}

/// One entry of the "Island lives on" list in Settings.
#[derive(Serialize, Clone)]
pub struct MonitorChoice {
    pub key: String,
    pub label: String,
}

pub fn monitor_choices(app: &AppHandle) -> Vec<MonitorChoice> {
    let Ok(monitors) = app.available_monitors() else { return Vec::new() };
    monitors
        .iter()
        .map(|m| {
            let d = describe(m);
            MonitorChoice {
                key: d.key(),
                label: crate::i18n::tf(
                    "{name} — {width}×{height} at {x},{y}",
                    &[
                        ("name", &d.name),
                        ("width", &d.w.to_string()),
                        ("height", &d.h.to_string()),
                        ("x", &d.x.to_string()),
                        ("y", &d.y.to_string()),
                    ],
                ),
            }
        })
        .collect()
}

/// What a display is remembered by: its logical origin, plus its name and
/// logical size, so it is still found after the layout is rearranged or the
/// resolution changes (the Mac keeps the display's UUID for the same reason;
/// Tauri has no stable ID).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DisplayId {
    pub(crate) name: String,
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) w: i32,
    pub(crate) h: i32,
}

impl DisplayId {
    /// `at:<x>,<y>` stays first, so a preference saved before still matches.
    pub(crate) fn key(&self) -> String {
        format!("at:{},{}|{}|{}x{}", self.x, self.y, self.name.replace('|', " "), self.w, self.h)
    }
}

pub(crate) fn describe(m: &Monitor) -> DisplayId {
    let (x, y) = logical_origin(m);
    let scale = m.scale_factor();
    let s = m.size();
    DisplayId {
        name: m.name().cloned().unwrap_or_else(|| "Display".into()),
        x,
        y,
        w: (s.width as f64 / scale).round() as i32,
        h: (s.height as f64 / scale).round() as i32,
    }
}

/// Which display a saved `at:` preference points at, best match first: same
/// place and name; the same name and size elsewhere (layout rearranged); the
/// same name alone when unique (resolution changed); the same place. None
/// means unplugged, and the caller falls back to the primary display.
pub(crate) fn pick_display(pref: &str, displays: &[DisplayId]) -> Option<usize> {
    let rest = pref.strip_prefix("at:")?;
    let mut parts = rest.split('|');
    let (x, y) = parts.next()?.split_once(',')?;
    let (x, y) = (x.trim().parse::<i32>().ok()?, y.trim().parse::<i32>().ok()?);
    let name = parts.next();
    let size = parts.next().and_then(|s| {
        let (w, h) = s.split_once('x')?;
        Some((w.parse::<i32>().ok()?, h.parse::<i32>().ok()?))
    });
    let at = |d: &DisplayId| d.x == x && d.y == y;
    if let Some(name) = name {
        if let Some(i) = displays.iter().position(|d| at(d) && d.name == name) {
            return Some(i);
        }
        if let Some((w, h)) = size {
            if let Some(i) = displays.iter().position(|d| d.name == name && d.w == w && d.h == h) {
                return Some(i);
            }
        }
        let mut same_name = displays.iter().enumerate().filter(|(_, d)| d.name == name);
        if let (Some((i, _)), None) = (same_name.next(), same_name.next()) {
            return Some(i);
        }
    }
    displays.iter().position(at)
}

/// The display the island lives on: a chosen one, the primary one, or the one
/// under the cursor.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    let ids: Vec<DisplayId> = monitors.iter().map(describe).collect();
    if let Some(i) = pick_display(pref, &ids) {
        return Some(monitors[i].clone());
    }
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor_physical() {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

#[cfg(test)]
mod display_tests {
    use super::*;

    fn d(name: &str, x: i32, y: i32, w: i32, h: i32) -> DisplayId {
        DisplayId { name: name.into(), x, y, w, h }
    }

    #[test]
    fn a_display_is_found_again_after_changes() {
        let dell = d("DELL U2720Q", 1920, 0, 2560, 1440);
        let lap = d("eDP-1", 0, 0, 1920, 1200);
        let key = dell.key();
        assert_eq!(pick_display(&key, &[lap.clone(), dell.clone()]), Some(1));
        // Rearranged: the Dell moved to the left of the laptop.
        let moved = [d("eDP-1", 2560, 0, 1920, 1200), d("DELL U2720Q", 0, 0, 2560, 1440)];
        assert_eq!(pick_display(&key, &moved), Some(1));
        // Resolution changed, still the only Dell.
        let rescaled = [lap.clone(), d("DELL U2720Q", 1920, 0, 1920, 1080)];
        assert_eq!(pick_display(&key, &rescaled), Some(1));
        // Unplugged: nothing, so the caller falls back to the primary display.
        assert_eq!(pick_display(&key, &[lap.clone()]), None);
    }

    #[test]
    fn two_identical_monitors_are_told_apart_by_place() {
        let a = d("LG 27UL500", 0, 0, 1920, 1080);
        let b = d("LG 27UL500", 1920, 0, 1920, 1080);
        assert_eq!(pick_display(&b.key(), &[a.clone(), b.clone()]), Some(1));
        assert_eq!(pick_display(&a.key(), &[a, b]), Some(0));
    }

    #[test]
    fn preferences_saved_before_still_match() {
        let lap = d("eDP-1", 0, 0, 1920, 1200);
        let ext = d("HDMI-1", 1920, 0, 1920, 1080);
        assert_eq!(pick_display("at:1920,0", &[lap.clone(), ext.clone()]), Some(1));
        assert_eq!(pick_display("primary", &[lap, ext]), None);
        assert_eq!(pick_display("at:nonsense", &[]), None);
    }
}

/// Calculates the zoom correction factor so that 1 CSS pixel equals 1 window logical pixel.
/// If WebView2's devicePixelRatio differs from the window's scale factor (e.g. system text
/// scaling or multi-monitor DPI mismatch), adjusting the webview zoom ensures the island
/// canvas (PANEL_W / EXPANDED_W) fits within the window without clipping.
/// `scale` is the ratio the page should report: the window's scale factor, times
/// the island's size where the zoom shows in the ratio (PollGate::fit_zoom).
/// The webview applies a zoom a moment after it is asked to, so a ratio the
/// page reports just after the island's size changed may still be the old
/// zoom's. Such a report is not a display mismatch: correcting on it would zoom
/// twice (the island at 150 % came up at 225 %). True when `dpr` is off under
/// the zoom now in force and right under the one `before` it.
fn measured_before_rezoom(dpr: f64, before: f64, zoom: f64, scale: f64) -> bool {
    let close = |ratio: f64| ratio.is_finite() && scale > 0.0 && (ratio - scale).abs() / scale < 0.02;
    before > 0.0 && !close(dpr) && close(dpr * zoom / before)
}

pub fn calculate_zoom_correction(current_zoom: f64, scale: f64, dpr: f64) -> Option<f64> {
    if dpr <= 0.0 || !dpr.is_finite() || scale <= 0.0 || !scale.is_finite() {
        return None;
    }
    if (dpr - scale).abs() / scale < 0.02 {
        return None;
    }
    let new_zoom = (current_zoom * (scale / dpr)).clamp(0.25, 4.0);
    Some(new_zoom)
}

#[cfg(test)]
mod zoom_tests {
    use super::*;

    #[test]
    fn a_ratio_measured_before_the_new_size_took_hold_is_not_a_mismatch() {
        // A display at 125 %, the island going from 100 % to 150 %: zoom 1 -> 1.5,
        // the page should come to report 1.875.
        // Still the old zoom's ratio: correcting on it would zoom to 2.25.
        assert!(measured_before_rezoom(1.25, 1.0, 1.5, 1.875));
        // The new zoom's ratio: nothing stale about it.
        assert!(!measured_before_rezoom(1.875, 1.0, 1.5, 1.875));
        // Off under both zooms: a real mismatch, for the correction to handle.
        assert!(!measured_before_rezoom(1.5, 1.0, 1.5, 1.875));
        // Going back down, 150 % to 100 %.
        assert!(measured_before_rezoom(1.875, 1.5, 1.0, 1.25));
    }

    #[test]
    fn zoom_correction_is_none_when_dpr_matches_window_scale() {
        assert_eq!(calculate_zoom_correction(1.0, 1.0, 1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.25, 1.25), None);
        // Within 2% threshold
        assert_eq!(calculate_zoom_correction(1.0, 1.0, 1.01), None);
    }

    #[test]
    fn zoom_correction_adjusts_for_dpi_mismatch() {
        // 100% scale display (scale 1.0) but WebView2 dpr = 1.25
        let zoom = calculate_zoom_correction(1.0, 1.0, 1.25);
        assert_eq!(zoom, Some(0.8));

        // 125% display with 125% text scale (dpr 1.5625 vs scale 1.25)
        let zoom = calculate_zoom_correction(1.0, 1.25, 1.5625);
        assert_eq!(zoom, Some(0.8));

        // 150% display with 100% webview dpr
        let zoom = calculate_zoom_correction(1.0, 1.5, 1.0);
        assert_eq!(zoom, Some(1.5));
    }

    #[test]
    fn zoom_correction_counts_the_island_size_in_the_ratio() {
        // The island at 150 % on a display at 125 %: the page reports 1.875
        // once the zoom is 1.5, and nothing is left to correct.
        assert_eq!(calculate_zoom_correction(1.5, 1.25 * 1.5, 1.875), None);
        // Text scaling on top (the ratio comes out 25 % too high): the
        // correction is the same 0.8, on top of the island's 1.5.
        let zoom = calculate_zoom_correction(1.5, 1.0 * 1.5, 1.875).unwrap();
        assert!((zoom - 1.2).abs() < 1e-12);
        // Moved to a display at 100 % before the webview caught up.
        let zoom = calculate_zoom_correction(1.25, 1.0 * 1.25, 1.5625).unwrap();
        assert!((zoom - 1.0).abs() < 1e-12);
    }

    #[test]
    fn only_a_cursor_near_the_island_is_followed() {
        let size = (PANEL_W, PANEL_H);
        assert!(is_near(360.0, 10.0, size));
        assert!(is_near(-400.0, PANEL_H + 400.0, size));
        assert!(!is_near(-500.0, 10.0, size));
        assert!(!is_near(360.0, PANEL_H + 900.0, size));
    }

    #[test]
    fn a_closed_island_stays_inside_the_panel() {
        let panel = (PANEL_W, PANEL_H);
        assert_eq!(clamp_collapsed((160.0, 26.0), panel), (160.0, 26.0));
        assert_eq!(clamp_collapsed((5000.0, 900.0), panel), (PANEL_W, PANEL_H));
        assert_eq!(clamp_collapsed((0.0, -3.0), panel), (1.0, 1.0));
        assert_eq!(clamp_collapsed((f64::NAN, 26.0), panel), (PANEL_W, 26.0));
        // The panel of an island made wider and taller.
        let wide = crate::appearance::panel(960.0, 160.0);
        assert_eq!(clamp_collapsed((5000.0, 900.0), wide), (1040.0, 480.0));
        assert_eq!(clamp_collapsed((160.0, 26.0), wide), (160.0, 26.0));
    }

    #[test]
    fn the_gate_holds_the_panel_in_force_and_starts_with_the_inherited_one() {
        let gate = PollGate::new();
        assert_eq!(gate.panel(), (PANEL_W, PANEL_H));
        // A new one gives back the one it replaces.
        let wide = crate::appearance::panel(900.0, 40.0);
        assert_eq!(gate.set_panel(wide), (PANEL_W, PANEL_H));
        assert_eq!(gate.panel(), (980.0, 360.0));
        assert_eq!(gate.set_panel((PANEL_W, PANEL_H)), (980.0, 360.0));
        assert_eq!(gate.panel(), (PANEL_W, PANEL_H));
        // The window follows only the last time the panel got smaller.
        let first = gate.note_shrink();
        assert!(gate.last_shrink(first));
        let second = gate.note_shrink();
        assert!(!gate.last_shrink(first));
        assert!(gate.last_shrink(second));
    }

    #[test]
    fn zoom_correction_handles_invalid_inputs() {
        assert_eq!(calculate_zoom_correction(1.0, 0.0, 1.0), None);
        assert!(!measured_before_rezoom(1.25, 0.0, 1.5, 1.875));
        assert!(!measured_before_rezoom(f64::NAN, 1.0, 1.5, 1.875));
        assert_eq!(calculate_zoom_correction(1.0, 1.0, -1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, f64::NAN, 1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.0, f64::INFINITY), None);
    }

    #[test]
    fn a_change_of_displays_is_told_once_and_the_first_look_is_none() {
        let laptop = (0, 0, 1920u32, 1200u32, 1.25f64.to_bits());
        let docked = (0, 0, 2560u32, 1440u32, 1.0f64.to_bits());
        let mut last = None;
        // The first look only learns where the island is.
        assert!(!screen_changed(&mut last, Some(laptop)));
        assert!(!screen_changed(&mut last, Some(laptop)));
        // Another display, resolution or scale: once.
        assert!(screen_changed(&mut last, Some(docked)));
        assert!(!screen_changed(&mut last, Some(docked)));
        // No display to be found for a moment: nothing is forgotten.
        assert!(!screen_changed(&mut last, None));
        assert_eq!(last, Some(docked));
        assert!(screen_changed(&mut last, Some(laptop)));
    }

    #[test]
    fn a_top_taskbar_moves_the_island_down_and_nothing_else_does() {
        // Taskbar at the bottom (or none): the work area starts at the top.
        assert_eq!(top_inset_from(0, 0), 0);
        // A 48 px taskbar at the top of a display placed at y = -1080.
        assert_eq!(top_inset_from(-1080, -1032), 48);
        // Nonsense from the system never pushes the island off the display.
        assert_eq!(top_inset_from(0, -20), 0);
        assert_eq!(top_inset_from(0, 900), 0);
    }
}


/// Windows: how far a taskbar docked at the top of this display (or another
/// app bar there) pushes the island down, read from the display's work area,
/// so the island sits under it. An auto-hidden taskbar takes no work
/// area and moves nothing. Linux anchors the island to the screen edge: 0.
fn top_inset(m: &tauri::Monitor) -> i32 {
    if cfg!(windows) {
        top_inset_from(m.position().y, m.work_area().position.y)
    } else {
        0
    }
}

fn top_inset_from(monitor_y: i32, work_y: i32) -> i32 {
    let inset = work_y - monitor_y;
    if (0..200).contains(&inset) { inset } else { 0 }
}

/// Places and sizes the window from what is in force: the display and the
/// island's size from the settings, and from the poll's gate the full panel or,
/// collapsed, the size the closed island needs (the wake strip when it shows
/// nothing). Main thread only.
pub fn apply_geometry(app: &AppHandle) {
    let Some(win) = window(app) else { return };
    let Some(shared) = app.try_state::<crate::Shared>() else { return };
    let gate = &shared.gate;
    let (pref, wanted) = {
        let settings = shared.settings.lock().unwrap();
        (settings.screen.clone(), settings.island_scale)
    };
    let Some(m) = target_monitor(app, &pref) else { return };
    let collapsed = gate
        .collapsed
        .load(Ordering::Relaxed)
        .then(|| *gate.collapsed_size.lock().unwrap());

    let scale = m.scale_factor();
    let mp = *m.position();
    let ms = *m.size();

    // The island's size: the one Settings asks for, as long as the panel fits
    // this display — the panel of the island as wide and as tall as Settings
    // makes it. The zoom follows before the window is resized.
    let panel = gate.panel();
    let work = m.work_area().size;
    let island = scale::fit(wanted, panel, scale, (work.width, work.height));
    gate.set_scale(&win, island);

    let closed = collapsed.map(|size| clamp_collapsed(size, panel));
    // Folded, the window is the closed island — or, where the platform folds
    // in place, still the whole panel: there the window never changes.
    let (lw, lh) = if platform::FOLDS_IN_PLACE { panel } else { closed.unwrap_or(panel) };
    let pw = scale::physical(lw, island, scale);
    let ph = scale::physical(lh, island, scale);
    let part = closed
        .filter(|_| platform::FOLDS_IN_PLACE)
        .map(|(w, h)| folded_part(pw, scale::physical(w, island, scale), scale::physical(h, island, scale)));
    *gate.folded_part.lock().unwrap() = part;
    let x = mp.x + (ms.width as i32 - pw as i32) / 2;
    let y = mp.y + top_inset(&m);
    *gate.anchor.lock().unwrap() = Some((mp.x + ms.width as i32 / 2, y));

    // GTK never sizes a non-resizable window below its natural size (200 px
    // here), so on Linux the 6 px wake strip would stay a 200 px block. tao
    // re-applies the config's `resizable: false` after the first configure, so
    // this is asked every time, just before the resize. Undecorated, the window
    // still offers the user nothing to resize it by. (Found by @YossiYad.)
    #[cfg(target_os = "linux")]
    let _ = win.set_resizable(true);
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    // Another app is full screen: the window keeps the size it should have
    // (the page goes on as usual, and is found as it left things) and waits
    // off-screen. Whoever asks for the geometry meanwhile — the island folding
    // or opening, a new display, another island size — lands here and leaves
    // it there.
    if gate.parked() {
        let _ = win.set_position(PhysicalPosition::new(PARKED_AT, PARKED_AT));
        return;
    }
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let (lx, ly) = logical_origin(&m);
    platform::pin_to_monitor(&win, lx, ly);
    // Moving across displays can rescale the window: re-assert the physical size.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_always_on_top(true);

    // On Windows, moving across displays or waking from the strip can clamp or lag
    // the resize. If the physical inner size differs from what was requested, retry once.
    if let Ok(got) = win.inner_size() {
        if got.width != pw || got.height != ph {
            crate::log::line(format!(
                "window size mismatch: wanted {pw}x{ph}, got {}x{} (scale {scale}, monitor {}x{})",
                got.width, got.height, ms.width, ms.height
            ));
            let _ = win.set_size(PhysicalSize::new(pw, ph));
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// The closed island's place in a window `window_w` px wide that keeps the
/// panel's size: in the middle of its top edge, where the page draws it. One
/// px more on each side and below, so a cursor on its very edge counts.
pub fn folded_part(window_w: u32, closed_w: u32, closed_h: u32) -> (i32, i32, i32, i32) {
    let w = closed_w.min(window_w) as i32;
    let x = (window_w as i32 - w) / 2;
    ((x - 1).max(0), 0, (w + 2).min(window_w as i32), closed_h as i32 + 1)
}

/// A closed island never grows past the panel in force, and never shrinks
/// below one pixel (a zero-sized window can't be placed).
pub fn clamp_collapsed((w, h): (f64, f64), panel: (f64, f64)) -> (f64, f64) {
    let ok = |v: f64, max: f64| if v.is_finite() { v.clamp(1.0, max) } else { max };
    (ok(w, panel.0), ok(h, panel.1))
}

/// Whether the island's display changed since the last look, which `now`
/// replaces. The first look only learns where the island is, and a look that
/// finds no display changes nothing.
fn screen_changed<K: PartialEq>(last: &mut Option<K>, now: Option<K>) -> bool {
    if now.is_none() || now == *last {
        return false;
    }
    let first = last.is_none();
    *last = now;
    !first
}

/// Position, size and scale of the monitor the island lives on. Any change here
/// means the island has to be placed again.
fn current_screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let p = m.position();
    let size = m.size();
    Some((p.x, p.y + top_inset(&m), size.width, size.height, m.scale_factor().to_bits()))
}

/// Parks the window while another app is full screen on the island's display
/// (when Settings says so), and brings it back when that ends: where and how
/// it should be by then, and without taking the focus. Called by the cursor
/// poll about twice a second, and when the setting changes. The page hears
/// `island-parked`, and stops drawing meanwhile.
pub fn watch_fullscreen(app: &AppHandle, gate: &PollGate) {
    let wanted = app
        .try_state::<crate::Shared>()
        .is_some_and(|shared| shared.settings.lock().unwrap().hide_on_fullscreen);
    let covered = if wanted {
        let anchor = *gate.anchor.lock().unwrap();
        // Not placed yet, or nothing to judge by: things stay as they are.
        let Some(covered) = anchor.and_then(platform::fullscreen_in_front) else { return };
        covered
    } else {
        false
    };
    if gate.parked.swap(covered, Ordering::Relaxed) == covered {
        return;
    }
    crate::log::line(
        if covered { "an app is full screen — island parked" } else { "full screen over — island back" }.to_string(),
    );
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || apply_geometry(&handle));
    if covered {
        // The pointer can't be on an island that is not there.
        let _ = app.emit_to(WINDOW_LABEL, "cursor", CursorPayload { x: -10_000.0, y: -10_000.0 });
    }
    let _ = app.emit_to(WINDOW_LABEL, "island-parked", covered);
}

/// A point of the desktop (physical px) in the island's page, as the cursor
/// poll reports the pointer. None while the island is not on screen: it waits
/// off-screen for a full-screen app, or has no window.
pub fn page_point(app: &AppHandle, gate: &PollGate, (px, py): (f64, f64)) -> Option<(f64, f64)> {
    if gate.parked() {
        return None;
    }
    let win = window(app)?;
    let origin = win.outer_position().ok()?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let island = gate.scale();
    Some((
        scale::to_page((px - origin.x as f64) / scale, island),
        scale::to_page((py - origin.y as f64) / scale, island),
    ))
}

/// A point of the island's page on the desktop, in physical px: the other way
/// round. None while the island is not on screen.
pub fn screen_point(app: &AppHandle, gate: &PollGate, (x, y): (f64, f64)) -> Option<(f64, f64)> {
    if gate.parked() {
        return None;
    }
    let win = window(app)?;
    let origin = win.outer_position().ok()?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let island = gate.scale();
    Some((
        origin.x as f64 + scale::to_window(x, island) * scale,
        origin.y as f64 + scale::to_window(y, island) * scale,
    ))
}

/// Emits `cursor` (page px) at ~60 Hz while the island is
/// visible. Parked on a condvar the rest of the time.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut was_down = false;
        // The press now held began on the island (see `takes_drag`).
        let mut pressed_on_island = false;
        // A full-screen app and a change of displays are looked for on the
        // poll's own wake-ups, awake, folded or parked: no thread or timer of
        // their own.
        let mut looked = Instant::now();
        let mut last_screen: Option<(i32, i32, u32, u32, u64)> = None;
        let mut look_around = || {
            if looked.elapsed() < FULLSCREEN_PERIOD {
                return;
            }
            looked = Instant::now();
            watch_fullscreen(&app, &gate);
            // Monitors get plugged in, unplugged, rearranged and rescaled, and
            // an island pinned to coordinates that no longer exist is an island
            // nobody can reach — folded and parked too, where it would stay put
            // until it next woke. The poll is already awake, so this costs one
            // monitor query.
            if screen_changed(&mut last_screen, current_screen_key(&app)) {
                crate::log::line("display layout changed — repositioning".to_string());
                let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
            }
        };
        // Without a cursor to read (Linux) the loop only watches the display
        // layout, and twice a second is plenty for that: waking at 60 Hz just to
        // find no cursor costs CPU for nothing.
        let period = if platform::CURSOR_POLL { 16 } else { 500 };
        loop {
            // Parked. Folded on Windows, a glance at the cursor four times a
            // second: on the closed island, it is told to wake up, whether or
            // not the webview delivers the pointer to such a small window.
            loop {
                if gate.wait_active_for(Duration::from_millis(folded_period_ms())) {
                    break;
                }
                look_around();
                if platform::CURSOR_POLL && gate.collapsed.load(Ordering::Relaxed) && !gate.parked() {
                    wake_if_hovered(&app, &gate);
                }
            }
            let mut last = (f64::MIN, f64::MIN);
            // The cursor was far at the last tick, and the page has been told.
            let mut far = false;
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(if gate.parked() {
                    PARKED_PERIOD_MS
                } else if far {
                    FAR_PERIOD_MS
                } else {
                    period
                }));
                if !gate.is_active() {
                    break;
                }
                look_around();

                // Parked off-screen: no cursor can reach the island, so there
                // is nothing to hit-test and nothing to tell the page. Once it
                // is back, the first tick says where the cursor is, moved or not.
                if gate.parked() {
                    last = (f64::MIN, f64::MIN);
                    continue;
                }

                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                let scale = win.scale_factor().unwrap_or(1.0);
                let Some((cx, cy)) = cursor_physical() else { continue };
                // In page px from here on, like the island's shape: physical
                // px over the display's scale, over the island's size.
                let island = gate.scale();
                let x = scale::to_page((cx - origin.x as f64) / scale, island);
                let y = scale::to_page((cy - origin.y as f64) / scale, island);
                let size = match win.inner_size() {
                    Ok(s) => (
                        scale::to_page(s.width as f64 / scale, island),
                        scale::to_page(s.height as f64 / scale, island),
                    ),
                    Err(_) => gate.panel(),
                };
                if (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 {
                    continue;
                }
                last = (x, y);

                // Click-through: the window only takes the mouse over the island
                // shape. A small entry margin means the flag is already off by the
                // time a moving cursor reaches a button.
                let r = *gate.rect.lock().unwrap();
                let on_island = within(&r, HIT_MARGIN, x, y);

                // A file being dragged has to be able to find us. WS_EX_TRANSPARENT
                // — what click-through is on Windows — hides the window from
                // WindowFromPoint, so OLE finds no drop target and shows the "no
                // drop" cursor. macOS has no such problem: AppKit delivers drags to
                // registered destinations whatever ignoresMouseEvents says. So while
                // a button is held with the cursor right in front of the island, the
                // window takes the mouse (`takes_drag`) — not anywhere under the
                // panel, where a file only being moved about the desktop would land
                // on Liv. A press may be the start of a drag: make sure the drop
                // target is ours before the file arrives.
                let down = left_button_down();
                if down && !was_down {
                    pressed_on_island = on_island;
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || platform::unblock_webview_drops(&handle));
                }
                was_down = down;

                let in_panel = x >= 0.0 && x <= size.0 && y >= 0.0 && y <= size.1;
                let dragging = takes_drag(down, pressed_on_island, in_panel, within(&r, DROP_MARGIN, x, y));

                let accept = on_island || dragging;
                if gate.ignoring.load(Ordering::Relaxed) == accept {
                    // Under the gate's lock, and only while it is open: a tick
                    // still running as the island folds must not make the
                    // closed island click-through after set_collapsed made it
                    // take the mouse — nothing would ever wake it again.
                    let active = gate.active.lock().unwrap();
                    if !*active {
                        break;
                    }
                    gate.ignoring.store(!accept, Ordering::Relaxed);
                    platform::set_click_through(&win, !accept);
                }

                // Far from the island: the page hears it once, then nothing.
                let near = dragging || is_near(x, y, size);
                if !near && far {
                    continue;
                }
                far = !near;
                let _ = win.emit("cursor", CursorPayload { x, y });
            }
        }
    });
}

/// How often the folded island looks for the cursor, in ms. Where the window
/// folds in place this look is all that wakes the island, so it is quick
/// enough to feel immediate — one read of the cursor's position twenty times a
/// second; elsewhere the window itself takes the mouse and this is a fallback.
fn folded_period_ms() -> u64 {
    if platform::FOLDS_IN_PLACE { 50 } else { 250 }
}

/// The cursor is on the folded window: it takes the mouse, and the page hears
/// `closed-hover` (it opens the compact island).
fn wake_if_hovered(app: &AppHandle, gate: &PollGate) {
    let Some(win) = window(app) else { return };
    let (Ok(origin), Ok(size), Some((cx, cy))) = (win.outer_position(), win.inner_size(), cursor_physical()) else { return };
    let x = cx - origin.x as f64;
    let y = cy - origin.y as f64;
    // The closed island: the whole window, or its place in a window that folds in place.
    let (left, top, w, h) = match *gate.folded_part.lock().unwrap() {
        Some((px, py, pw, ph)) => (px as f64, py as f64, pw as f64, ph as f64),
        None => (0.0, 0.0, size.width as f64, size.height as f64),
    };
    if x >= left && y >= top && x <= left + w && y <= top + h + 2.0 {
        gate.ignoring.store(false, Ordering::Relaxed);
        platform::set_click_through(&win, false);
        let _ = win.emit("closed-hover", ());
    }
}

/// Re-applies click-through after the window or the island changed shape.
///
/// With the cursor poll (Windows) the window takes the mouse again and the next
/// tick decides from the cursor. Without it (Linux) the input region is set to
/// the island itself, or to the whole wake strip while collapsed.
pub fn refresh_click_through(app: &AppHandle, gate: &PollGate) {
    if platform::CURSOR_POLL {
        // Folded in place, the whole window lets the mouse through: the poll
        // finds the cursor on the closed island and wakes it (wake_if_hovered).
        let through = platform::FOLDS_IN_PLACE && gate.collapsed.load(Ordering::Relaxed);
        set_ignore_cursor(app, through);
        gate.ignoring.store(through, Ordering::Relaxed);
        return;
    }
    let Some(win) = window(app) else { return };
    // The shapes are in page px; the region is in the window's.
    let island = gate.scale();
    let in_window = |(x, y, w, h): (f64, f64, f64, f64)| {
        let px = |v: f64| scale::to_window(v, island);
        (px(x), px(y), px(w), px(h))
    };
    let region = if gate.collapsed.load(Ordering::Relaxed) {
        // The closed island (or the wake strip) itself, never "the whole
        // window": if the window ever fails to shrink, the rest of it must not
        // swallow clicks meant for whatever sits under the top of the screen.
        let (w, h) = clamp_collapsed(*gate.collapsed_size.lock().unwrap(), gate.panel());
        Some((0.0, 0.0, w, h))
    } else {
        let r = *gate.rect.lock().unwrap();
        if r.w <= 0.0 {
            // Nothing drawn yet: nothing takes the mouse.
            Some((0.0, 0.0, 0.0, 0.0))
        } else {
            let x0 = (r.x - HIT_MARGIN).max(0.0);
            let y0 = (r.y - HIT_MARGIN).max(0.0);
            let x1 = r.x + r.w + HIT_MARGIN;
            let y1 = r.y + r.h + HIT_MARGIN;
            Some((x0, y0, x1 - x0, y1 - y0))
        }
    };
    platform::set_input_region(&win, region.map(in_window));
}

pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(win) = window(app) {
        platform::set_click_through(&win, ignore);
    }
}

#[cfg(test)]
mod drop_zone_tests {
    use super::*;

    /// The compact island in the middle of a 720 px panel.
    const COMPACT: IslandRect = IslandRect { x: 216.0, y: 0.0, w: 288.0, h: 32.0 };

    #[test]
    fn a_file_counts_only_right_in_front_of_the_island() {
        let zone = |x: f64, y: f64| within(&COMPACT, DROP_MARGIN, x, y);
        // On it, and a little past each edge.
        assert!(zone(360.0, 16.0));
        assert!(zone(216.0 - 20.0, 16.0) && zone(504.0 + 20.0, 16.0) && zone(360.0, 32.0 + 20.0));
        // A little further, and anywhere else under the panel: not for Liv.
        assert!(!zone(216.0 - 21.0, 16.0) && !zone(504.0 + 21.0, 16.0) && !zone(360.0, 32.0 + 21.0));
        assert!(!zone(360.0, 200.0) && !zone(40.0, 16.0) && !zone(700.0, 300.0));
        // An island with no shape yet takes nothing.
        assert!(!within(&IslandRect::default(), DROP_MARGIN, 0.0, 0.0));
    }

    #[test]
    fn a_press_begun_on_the_island_keeps_the_panel_a_file_from_elsewhere_only_the_drop_zone() {
        // A file brought from the desktop: under the panel but away from the island, it goes on.
        assert!(!takes_drag(true, false, true, false));
        assert!(takes_drag(true, false, true, true));
        // A slider or a shelf item dragged past the island's edge: still ours while in the panel.
        assert!(takes_drag(true, true, true, false));
        assert!(!takes_drag(true, true, false, false));
        // No button, no drag.
        assert!(!takes_drag(false, true, true, true));
        assert!(!takes_drag(false, false, true, true));
    }
}

#[cfg(test)]
mod folded_part_tests {
    use super::*;

    #[test]
    fn the_closed_island_is_cut_out_of_the_middle_of_the_windows_top_edge() {
        // A 1080 px window, a closed island of 120 × 48: centred, a px to spare around it.
        assert_eq!(folded_part(1080, 120, 48), (479, 0, 122, 49));
        // The wake strip: as thin as it is.
        assert_eq!(folded_part(1080, 300, 9), (389, 0, 302, 10));
        // Never wider than the window, never outside it.
        assert_eq!(folded_part(100, 400, 30), (0, 0, 100, 31));
        let (x, _, w, _) = folded_part(101, 100, 30);
        assert!(x >= 0 && x + w <= 101);
    }
}
