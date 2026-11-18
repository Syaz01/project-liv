// Notification-area icon: Open (the island), Weekly recap, Wardrobe (what Liv
// wears), Settings (the Liv window), Pause — which reads Resume while Liv is
// paused — and Quit.
// "Update Liv to X…" shows under Open only while a new version is out
// (update.rs). While one waits, the tray icon turns blue like Liv on the island.

use std::sync::atomic::Ordering;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::image::Image;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::i18n::{n_, t, tf};
use crate::island::WINDOW_LABEL;

/// The menu's items, id and English label, in order. The labels are shown in
/// the interface language (i18n.rs) and follow it when it changes.
const ITEMS: [(&str, &str); 6] = [
    ("open", n_("Open Liv")),
    ("recap", n_("Weekly recap")),
    ("wardrobe", n_("Wardrobe…")),
    ("settings", n_("Settings…")),
    ("pause", n_("Pause")),
    ("quit", n_("Quit")),
];

/// What the pause item offers while Liv is paused.
const RESUME: &str = n_("Resume");

/// The label of the item `id` now: the pause item says what a click on it does.
fn label_now(id: &str, label: &'static str, paused: bool) -> &'static str {
    if id == "pause" && paused {
        RESUME
    } else {
        label
    }
}

fn paused() -> bool {
    crate::integrations::PAUSED.load(Ordering::Relaxed)
}

/// Kept so a change of language, or of pause, relabels the menu without
/// rebuilding the tray: each item with its id and its English label.
struct Items(Vec<(&'static str, &'static str, MenuItem<Wry>)>);

/// "Update Liv to X…": in the menu only while `version` is set.
struct UpdateItem {
    menu: Menu<Wry>,
    item: MenuItem<Wry>,
    version: Mutex<Option<String>>,
}

fn update_label(version: &str) -> String {
    tf("Update Liv to {version}…", &[("version", version)])
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let mut items = Vec::new();
    for (id, label) in ITEMS {
        let text = t(label_now(id, label, paused()));
        items.push((id, label, MenuItem::with_id(app, id, text, true, None::<&str>)?));
    }
    let [open, recap, wardrobe, settings, pause, quit] = [0, 1, 2, 3, 4, 5].map(|i| &items[i].2);
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    // What the island shows first, then what is Liv's own: its wardrobe and its settings.
    let menu = Menu::with_items(app, &[open, recap, &sep1, wardrobe, settings, pause, &sep2, quit])?;
    app.manage(Items(items));
    // Its click goes to the island like the others (id "update"): it opens the update card.
    let update = MenuItem::with_id(app, "update", "", true, None::<&str>)?;
    app.manage(UpdateItem { menu: menu.clone(), item: update, version: Mutex::new(None) });

    let mut builder = TrayIconBuilder::with_id("liv")
        .tooltip("Liv")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            // The Liv window: every setting.
            "settings" => crate::show_settings_window(app),
            // The rest is the island's to do: open itself, the recap, the
            // wardrobe, the update card, and pausing (it tells Rust: `set_paused`).
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// Relabels the menu: in the current language, and for whether Liv is paused.
pub fn retitle(app: &AppHandle) {
    let Some(items) = app.try_state::<Items>() else { return };
    let paused = paused();
    for (id, label, item) in &items.0 {
        let _ = item.set_text(t(label_now(id, label, paused)));
    }
    if let Some(update) = app.try_state::<UpdateItem>() {
        // Copied out first: the menu calls wait for the main thread, never under the lock.
        let version = update.version.lock().unwrap().clone();
        if let Some(version) = version {
            let _ = update.item.set_text(update_label(&version));
        }
    }
}

/// Shows "Update Liv to `version`…" right under Open, or takes it out (None).
pub fn set_update(app: &AppHandle, version: Option<&str>) {
    let Some(update) = app.try_state::<UpdateItem>() else { return };
    let was_shown = {
        let mut shown = update.version.lock().unwrap();
        if shown.as_deref() == version {
            return;
        }
        let was = shown.is_some();
        *shown = version.map(str::to_string);
        was
    };
    match version {
        Some(v) => {
            let _ = update.item.set_text(update_label(v));
            if !was_shown {
                let _ = update.menu.insert(&update.item, 1);
            }
        }
        None => {
            let _ = update.menu.remove(&update.item);
        }
    }
}

/// Liv's update blue, #3B82F6, the colour of Liv's shell while a new version waits.
const UPDATE_BLUE: [f32; 3] = [59.0, 130.0, 246.0];

/// The tray icon in the update blue: the light body takes the blue and keeps its
/// shading, the dark outline stays as it is, transparency untouched.
pub fn tint_blue(rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba.len());
    for p in rgba.chunks_exact(4) {
        let light = (0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32) / 255.0;
        // 0 for the outline, 1 for the white body.
        let body = ((light - 0.35) / 0.65).clamp(0.0, 1.0);
        for (i, blue) in UPDATE_BLUE.iter().enumerate() {
            let shaded = blue * (0.8 + 0.2 * light);
            out.push((p[i] as f32 * (1.0 - body) + shaded * body).round().clamp(0.0, 255.0) as u8);
        }
        out.push(p[3]);
    }
    out
}

/// The island says whether a new version waits (consent, newer, not put off with
/// Later): the blue icon in the tray, or the usual one.
#[tauri::command]
pub fn tray_update_hint(app: AppHandle, on: bool) {
    let Some(tray) = app.tray_by_id("liv") else { return };
    let Some(base) = app.default_window_icon() else { return };
    let icon = if on {
        Image::new_owned(tint_blue(base.rgba()), base.width(), base.height())
    } else {
        base.clone().to_owned()
    };
    let _ = tray.set_icon(Some(icon));
}

#[cfg(test)]
mod tests {
    use super::{label_now, tint_blue, ITEMS};

    #[test]
    fn the_pause_item_offers_to_resume_while_liv_is_paused() {
        let label = |id: &str, paused: bool| {
            let (_, label) = ITEMS.iter().find(|(item, _)| *item == id).unwrap();
            label_now(id, label, paused)
        };
        assert_eq!(label("pause", false), "Pause");
        assert_eq!(label("pause", true), "Resume");
        // Every other item reads the same, paused or not.
        for (id, text) in ITEMS.iter().filter(|(id, _)| *id != "pause") {
            assert_eq!(label(id, true), *text);
            assert_eq!(label(id, false), *text);
        }
    }

    #[test]
    fn the_wardrobe_has_its_item_between_the_recap_and_the_settings() {
        let ids: Vec<&str> = ITEMS.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, ["open", "recap", "wardrobe", "settings", "pause", "quit"]);
        crate::i18n::set_for_test("es");
        assert_eq!(crate::i18n::t(label_now("wardrobe", "Wardrobe…", false)), "Vestuario…");
        crate::i18n::set_for_test("en");
        assert_eq!(crate::i18n::t(label_now("wardrobe", "Wardrobe…", true)), "Wardrobe…");
    }

    #[test]
    fn both_labels_of_the_pause_item_are_translated() {
        crate::i18n::set_for_test("es");
        assert_eq!(crate::i18n::t(label_now("pause", "Pause", false)), "Pausar");
        assert_eq!(crate::i18n::t(label_now("pause", "Pause", true)), "Reanudar");
        crate::i18n::set_for_test("en");
    }

    #[test]
    fn the_body_turns_blue_the_outline_stays() {
        let px = [
            245, 240, 235, 255, // the off-white body
            10, 10, 10, 255, // the outline
            250, 250, 250, 0, // transparent around it
        ];
        let out = tint_blue(&px);
        let body = &out[0..4];
        assert!(body[2] > 220 && body[0] < 80 && body[1] > 100 && body[1] < 150, "body {body:?}");
        assert_eq!(&out[4..8], &[10, 10, 10, 255], "the outline stays dark");
        assert_eq!(out[11], 0, "transparency is kept");
        assert_eq!(out.len(), px.len());
    }
}
