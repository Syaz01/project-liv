// The open island as its owner shaped it (Settings → General → Appearance):
// its width, what is added to every view's height, the radius of its corners
// and the whole island's opacity.
//
// The page draws all four (src/core/appearance.ts has the same ranges, and
// tests/appearance.test.mjs checks the two agree). Rust keeps them in
// settings.json, each inside its range, and gives the page a window big
// enough for the island it asks for: the inherited panel, wider by what the
// island is wider and taller by what it is taller. The corners and the opacity
// are the page's business only. No Tauri in this file.

use crate::settings::Settings;

/// One setting's range: what it may be, in steps of `step`, and the inherited
/// island's value, which a missing or unusable setting reads as.
pub struct Range {
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub initial: f64,
}

impl Range {
    /// `value` on one of the range's steps, inside the range; the inherited
    /// value for anything that is not a number.
    pub fn clamp(&self, value: f64) -> f64 {
        if !value.is_finite() {
            return self.initial;
        }
        let stepped = self.min + ((value - self.min) / self.step).round() * self.step;
        stepped.clamp(self.min, self.max)
    }
}

/// Width of the open island, page px.
pub const WIDTH: Range = Range { min: 640.0, max: 960.0, step: 10.0, initial: 640.0 };
/// Added to the height of every open view, page px.
pub const EXTRA_HEIGHT: Range = Range { min: 0.0, max: 160.0, step: 10.0, initial: 0.0 };
/// Radius of the open island's lower corners, page px.
pub const RADIUS: Range = Range { min: 0.0, max: 40.0, step: 1.0, initial: 22.0 };
/// Opacity of the whole island, percent.
pub const OPACITY: Range = Range { min: 40.0, max: 100.0, step: 1.0, initial: 100.0 };

/// The inherited panel (island.rs PANEL_W × PANEL_H), in page px: 80 wider
/// than the inherited island, 20 taller than its tallest view.
pub const BASE_PANEL: (f64, f64) = (720.0, 320.0);
/// Room the panel keeps on both sides of the open island together, page px.
const PANEL_MARGIN_W: f64 = BASE_PANEL.0 - WIDTH.initial;

/// Brings the four settings into their ranges, as they are kept and saved.
pub fn clamp(settings: &mut Settings) {
    settings.island_width = WIDTH.clamp(settings.island_width);
    settings.island_extra_height = EXTRA_HEIGHT.clamp(settings.island_extra_height);
    settings.island_radius = RADIUS.clamp(settings.island_radius);
    settings.island_opacity = OPACITY.clamp(settings.island_opacity);
}

/// The window the page gets while the island is not folded away, in page px,
/// for an open island `island_width` wide that adds `extra_height` to its
/// views. Never smaller than the inherited panel, whatever it is handed.
pub fn panel(island_width: f64, extra_height: f64) -> (f64, f64) {
    let width = WIDTH.clamp(island_width);
    let extra = EXTRA_HEIGHT.clamp(extra_height);
    (BASE_PANEL.0.max(width + PANEL_MARGIN_W), BASE_PANEL.1 + extra)
}

/// The same, read from the settings.
pub fn panel_of(settings: &Settings) -> (f64, f64) {
    panel(settings.island_width, settings.island_extra_height)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scale;

    #[test]
    fn a_value_is_brought_onto_a_step_inside_its_range() {
        assert_eq!(WIDTH.clamp(640.0), 640.0);
        assert_eq!(WIDTH.clamp(800.0), 800.0);
        assert_eq!(WIDTH.clamp(960.0), 960.0);
        assert_eq!(WIDTH.clamp(100.0), 640.0);
        assert_eq!(WIDTH.clamp(5000.0), 960.0);
        assert_eq!(WIDTH.clamp(-1.0), 640.0);
        // Between two steps: the nearest.
        assert_eq!(WIDTH.clamp(804.0), 800.0);
        assert_eq!(WIDTH.clamp(806.0), 810.0);
        assert_eq!(EXTRA_HEIGHT.clamp(0.0), 0.0);
        assert_eq!(EXTRA_HEIGHT.clamp(160.0), 160.0);
        assert_eq!(EXTRA_HEIGHT.clamp(-20.0), 0.0);
        assert_eq!(EXTRA_HEIGHT.clamp(999.0), 160.0);
        assert_eq!(EXTRA_HEIGHT.clamp(74.0), 70.0);
        assert_eq!(RADIUS.clamp(0.0), 0.0);
        assert_eq!(RADIUS.clamp(40.0), 40.0);
        assert_eq!(RADIUS.clamp(41.0), 40.0);
        assert_eq!(RADIUS.clamp(-3.0), 0.0);
        assert_eq!(RADIUS.clamp(12.4), 12.0);
        assert_eq!(OPACITY.clamp(100.0), 100.0);
        assert_eq!(OPACITY.clamp(40.0), 40.0);
        assert_eq!(OPACITY.clamp(0.0), 40.0);
        assert_eq!(OPACITY.clamp(250.0), 100.0);
        assert_eq!(OPACITY.clamp(59.6), 60.0);
    }

    #[test]
    fn what_is_not_a_number_is_the_inherited_island() {
        for range in [&WIDTH, &EXTRA_HEIGHT, &RADIUS, &OPACITY] {
            assert_eq!(range.clamp(f64::NAN), range.initial);
            assert_eq!(range.clamp(f64::INFINITY), range.initial);
            assert_eq!(range.clamp(f64::NEG_INFINITY), range.initial);
            // And the inherited value is one of the range's own.
            assert_eq!(range.clamp(range.initial), range.initial);
        }
    }

    #[test]
    fn the_defaults_are_the_inherited_island() {
        let fresh = Settings::default();
        assert_eq!(fresh.island_width, 640.0);
        assert_eq!(fresh.island_extra_height, 0.0);
        assert_eq!(fresh.island_radius, 22.0);
        assert_eq!(fresh.island_opacity, 100.0);
        assert_eq!(
            (fresh.island_width, fresh.island_extra_height, fresh.island_radius, fresh.island_opacity),
            (WIDTH.initial, EXTRA_HEIGHT.initial, RADIUS.initial, OPACITY.initial)
        );
        // Clamping them changes nothing.
        let mut clamped = fresh.clone();
        clamp(&mut clamped);
        assert_eq!(
            (clamped.island_width, clamped.island_extra_height, clamped.island_radius, clamped.island_opacity),
            (640.0, 0.0, 22.0, 100.0)
        );
    }

    #[test]
    fn the_panel_is_the_inherited_one_until_the_island_grows() {
        assert_eq!(BASE_PANEL, (crate::island::PANEL_W, crate::island::PANEL_H));
        assert_eq!(panel(640.0, 0.0), (720.0, 320.0));
        assert_eq!(panel_of(&Settings::default()), (720.0, 320.0));
        // 80 px wider than the open island, 20 px taller than its tallest view.
        assert_eq!(panel(800.0, 0.0), (880.0, 320.0));
        assert_eq!(panel(960.0, 160.0), (1040.0, 480.0));
        assert_eq!(panel(640.0, 60.0), (720.0, 380.0));
        // Never smaller than the inherited panel, never bigger than the largest island's.
        assert_eq!(panel(0.0, -50.0), (720.0, 320.0));
        assert_eq!(panel(f64::NAN, f64::NAN), (720.0, 320.0));
        assert_eq!(panel(9000.0, 9000.0), (1040.0, 480.0));
    }

    #[test]
    fn a_wide_or_tall_panel_that_no_longer_fits_the_display_steps_the_size_down() {
        let widest = panel(960.0, 160.0);
        // 1920×1080 at 100 %, taskbar at the bottom: 1040 × 1.5 = 1560 fits.
        assert_eq!(scale::fit(1.5, widest, 1.0, (1920, 1032)), 1.5);
        // 1920×1080 at 125 % (1536 logical px wide): the inherited panel fits
        // at 150 % (1080), the widest only at 125 % (1300).
        assert_eq!(scale::fit(1.5, panel(640.0, 0.0), 1.25, (1920, 1032)), 1.5);
        assert_eq!(scale::fit(1.5, widest, 1.25, (1920, 1032)), 1.25);
        // 1366×768 at 100 %: 1040 × 1.25 = 1300 fits, × 1.5 does not.
        assert_eq!(scale::fit(1.5, widest, 1.0, (1366, 720)), 1.25);
        // 1280×720 at 100 %: only 110 % (1144) fits the width.
        assert_eq!(scale::fit(1.5, widest, 1.0, (1280, 672)), 1.1);
        // The height can be what holds it back: 480 × 1.5 = 720 on a work area of 700.
        assert_eq!(scale::fit(1.5, panel(640.0, 160.0), 1.0, (1920, 700)), 1.25);
        assert_eq!(scale::fit(1.5, panel(640.0, 0.0), 1.0, (1920, 700)), 1.5);
        // A display the widest panel does not fit at any size: the usual one,
        // as for the inherited panel (scale.rs).
        assert_eq!(scale::fit(1.5, widest, 1.0, (1024, 728)), 1.0);
        // A narrower island on the same display gets its size back.
        assert_eq!(scale::fit(1.25, panel(700.0, 0.0), 1.0, (1024, 728)), 1.25);
    }
}
