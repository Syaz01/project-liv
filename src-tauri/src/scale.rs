// The island's size (Settings → General → Island size): the whole island drawn
// bigger, its text with it.
//
// The page is laid out in CSS px for a 720×320 panel (wider or taller when
// Settings → Appearance makes the open island so: appearance.rs) and never
// hears of the setting. The window grows by the scale and the webview zooms by the same
// factor, so one CSS px covers `scale` window-logical px, the page still sees
// its 720×320 and the webview draws everything at the higher pixel ratio
// (vector, never a stretched bitmap). What Rust exchanges with the page — the
// cursor, the island's shape, the closed island's size — is in page px, and is
// converted here at the window's edge. No Tauri in this file.

/// The sizes Settings offers.
pub const ALLOWED: [f64; 4] = [1.0, 1.1, 1.25, 1.5];

/// The allowed size nearest to `value`; 1 for a value that is not a number.
pub fn allowed(value: f64) -> f64 {
    if !value.is_finite() {
        return 1.0;
    }
    let mut best = ALLOWED[0];
    for size in ALLOWED {
        if (size - value).abs() < (best - value).abs() {
            best = size;
        }
    }
    best
}

/// Page px to physical px on a display of `monitor_scale`, at this island size.
/// Never zero: a window that small can't be placed.
pub fn physical(page: f64, scale: f64, monitor_scale: f64) -> u32 {
    (to_window(page, scale) * monitor_scale).round().max(1.0) as u32
}

/// The size in force on a display: the one asked for, or the largest allowed
/// one below it whose panel still fits the display's work area (physical px).
/// 1 when nothing fits, which is the island as it has always been.
pub fn fit(wanted: f64, panel: (f64, f64), monitor_scale: f64, work: (u32, u32)) -> f64 {
    let wanted = allowed(wanted);
    let fits = |size: f64| {
        physical(panel.0, size, monitor_scale) <= work.0 && physical(panel.1, size, monitor_scale) <= work.1
    };
    ALLOWED
        .iter()
        .rev()
        .copied()
        .find(|size| *size <= wanted && fits(*size))
        .unwrap_or(1.0)
}

/// Page px to window-logical px.
pub fn to_window(page: f64, scale: f64) -> f64 {
    page * scale
}

/// Window-logical px to page px.
pub fn to_page(window: f64, scale: f64) -> f64 {
    window / scale
}

/// The webview zoom once the island's size goes from `old` to `new`: the part
/// of it that corrects the pixel ratio (island::calculate_zoom_correction) stays.
pub fn rezoom(zoom: f64, old: f64, new: f64) -> f64 {
    zoom * new / old
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANEL: (f64, f64) = (720.0, 320.0);

    #[test]
    fn a_size_is_one_of_the_four_and_nonsense_is_the_usual_one() {
        for size in ALLOWED {
            assert_eq!(allowed(size), size);
        }
        assert_eq!(allowed(1.2), 1.25);
        assert_eq!(allowed(1.13), 1.1);
        assert_eq!(allowed(1.4), 1.5);
        assert_eq!(allowed(0.2), 1.0);
        assert_eq!(allowed(-3.0), 1.0);
        assert_eq!(allowed(9.0), 1.5);
        assert_eq!(allowed(f64::NAN), 1.0);
        assert_eq!(allowed(f64::INFINITY), 1.0);
    }

    #[test]
    fn the_usual_size_changes_no_pixel() {
        // Exactly what the window was sized to before the setting existed.
        for monitor_scale in [1.0f64, 1.25, 1.5, 1.75, 2.0] {
            for page in [720.0f64, 320.0, 240.0, 6.0, 137.0, 24.0] {
                let before = (page * monitor_scale).round().max(1.0) as u32;
                assert_eq!(physical(page, 1.0, monitor_scale), before);
            }
        }
        assert_eq!(physical(0.0, 1.0, 1.0), 1);
        assert_eq!(to_window(288.0, 1.0), 288.0);
        assert_eq!(to_page(288.0, 1.0), 288.0);
        assert_eq!(rezoom(0.8, 1.0, 1.0), 0.8);
    }

    #[test]
    fn the_window_grows_with_the_size_on_every_display_scale() {
        assert_eq!((physical(720.0, 1.5, 1.0), physical(320.0, 1.5, 1.0)), (1080, 480));
        assert_eq!((physical(720.0, 1.25, 1.5), physical(320.0, 1.25, 1.5)), (1350, 600));
        assert_eq!((physical(720.0, 1.1, 1.25), physical(320.0, 1.1, 1.25)), (990, 440));
        // The wake strip and a closed island follow.
        assert_eq!((physical(240.0, 1.5, 1.25), physical(6.0, 1.5, 1.25)), (450, 11));
        assert_eq!((physical(80.0, 1.25, 1.0), physical(24.0, 1.25, 1.0)), (100, 30));
    }

    #[test]
    fn the_page_still_sees_its_panel_at_every_size() {
        // The viewport in CSS px is the window in physical px over the pixel
        // ratio, which is the display's scale times the zoom.
        // The inherited panel, and the panels of an island made wider or
        // taller in Settings (appearance.rs).
        for panel in [PANEL, crate::appearance::panel(800.0, 40.0), crate::appearance::panel(960.0, 160.0)] {
            for monitor_scale in [1.0, 1.25, 1.5, 2.0] {
                for size in ALLOWED {
                    let ratio = monitor_scale * rezoom(1.0, 1.0, size);
                    let width = physical(panel.0, size, monitor_scale) as f64 / ratio;
                    let height = physical(panel.1, size, monitor_scale) as f64 / ratio;
                    assert!((width - panel.0).abs() < 0.5, "{width} at {size} on {monitor_scale}");
                    assert!((height - panel.1).abs() < 0.5, "{height} at {size} on {monitor_scale}");
                }
            }
        }
    }

    #[test]
    fn the_cursor_and_the_island_meet_in_page_px() {
        // The island's right edge, compact: 504 page px from the window's left.
        for size in ALLOWED {
            let edge = to_window(504.0, size);
            assert!((to_page(edge, size) - 504.0).abs() < 1e-9);
        }
        // A cursor 540 logical px into a window at 150 % is at 360, the middle.
        assert_eq!(to_page(540.0, 1.5), 360.0);
        assert_eq!(to_window(360.0, 1.5), 540.0);
    }

    #[test]
    fn the_zoom_follows_the_size_and_keeps_its_correction() {
        assert_eq!(rezoom(1.0, 1.0, 1.5), 1.5);
        assert_eq!(rezoom(1.5, 1.5, 1.0), 1.0);
        // A webview corrected by 0.8 (pixel ratio 1.25 on a display at 100 %).
        assert!((rezoom(0.8, 1.0, 1.25) - 1.0).abs() < 1e-12);
        assert!((rezoom(1.0, 1.25, 1.1) - 0.88).abs() < 1e-12);
    }

    #[test]
    fn a_panel_too_big_for_the_display_takes_the_largest_size_that_fits() {
        // 1920×1080 at 100 %, taskbar at the bottom: everything fits.
        assert_eq!(fit(1.5, PANEL, 1.0, (1920, 1032)), 1.5);
        assert_eq!(fit(1.0, PANEL, 1.0, (1920, 1032)), 1.0);
        // 1280×720 at 125 %: 1080 logical px wide would need 1350 physical.
        assert_eq!(fit(1.5, PANEL, 1.25, (1280, 672)), 1.25);
        // 1366×768 at 150 %: 910 logical px, room for 125 % (900) only.
        assert_eq!(fit(1.5, PANEL, 1.5, (1366, 720)), 1.25);
        assert_eq!(fit(1.1, PANEL, 1.5, (1366, 720)), 1.1);
        // 1920×1080 at 200 %: 960 logical px.
        assert_eq!(fit(1.5, PANEL, 2.0, (1920, 1000)), 1.25);
        // Exactly as wide as the panel at 150 %: it fits.
        assert_eq!(fit(1.5, PANEL, 1.0, (1080, 480)), 1.5);
        assert_eq!(fit(1.5, PANEL, 1.0, (1079, 480)), 1.25);
        // A display not tall enough.
        assert_eq!(fit(1.5, PANEL, 1.0, (1920, 400)), 1.25);
        // Nothing fits, or the system says nonsense: the usual size.
        assert_eq!(fit(1.5, PANEL, 1.0, (640, 300)), 1.0);
        assert_eq!(fit(1.5, PANEL, 1.0, (0, 0)), 1.0);
        // A size that is not one of the four is brought to one first.
        assert_eq!(fit(7.0, PANEL, 1.0, (1920, 1032)), 1.5);
        assert_eq!(fit(f64::NAN, PANEL, 1.0, (1920, 1032)), 1.0);
    }
}
