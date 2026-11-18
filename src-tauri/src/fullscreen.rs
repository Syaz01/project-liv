// Is another app full screen on the island's display? (Settings → General →
// Hide when an app is full screen.) A film, a game or a presentation takes the
// whole display, and the island would sit on top of the picture.
//
// The decision only, over plain data: the platform gathers what the window in
// front looks like (platform/windows.rs) and island.rs parks the window.

/// Left, top, right, bottom, in physical screen px.
pub type Rect = (i32, i32, i32, i32);

/// The window in front, as the system describes it.
pub struct Foreground {
    pub rect: Rect,
    pub class: String,
    /// Its window style (WS_*).
    pub style: u32,
    /// Maximized.
    pub zoomed: bool,
    /// One of Liv's own windows.
    pub same_process: bool,
    pub visible: bool,
    /// Kept hidden by the system (another virtual desktop, a suspended Store app).
    pub cloaked: bool,
}

/// WS_CAPTION: a title bar.
const WS_CAPTION: u32 = 0x00C0_0000;

/// The desktop and the shell's own surfaces. Several of them cover the whole
/// display (the desktop always does) and none is an app gone full screen: the
/// wallpaper, the taskbars, the Alt+Tab and Task view switchers, and the
/// shell's panels (Start, search, the notification centre).
const SHELL_CLASSES: [&str; 8] = [
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "XamlExplorerHostIslandWindow",
    "MultitaskingViewFrame",
    "ForegroundStaging",
    "Windows.UI.Core.CoreWindow",
];

/// The frame Windows puts around a Store (UWP) app. It can keep its title-bar
/// style, and stay maximized, while the app is full screen, so its style says
/// nothing then: full screen, it is exactly the display; maximized, its borders
/// reach past the display.
const STORE_APP_FRAME: &str = "ApplicationFrameWindow";

fn contains(outer: Rect, inner: Rect) -> bool {
    outer.0 <= inner.0 && outer.1 <= inner.1 && outer.2 >= inner.2 && outer.3 >= inner.3
}

/// Whether `window`, the one in front, is full screen on `display` (the whole
/// display, taskbar included — not its work area).
pub fn is_fullscreen(window: &Foreground, display: Rect) -> bool {
    if !window.visible || window.cloaked || window.same_process {
        return false;
    }
    if SHELL_CLASSES.contains(&window.class.as_str()) {
        return false;
    }
    if !contains(window.rect, display) {
        return false;
    }
    if window.class == STORE_APP_FRAME && window.rect == display {
        return true;
    }
    // An ordinary maximized window: with a taskbar that hides itself it covers
    // the whole display too, and it is still a window, title bar and all.
    let maximized = window.zoomed && window.style & WS_CAPTION == WS_CAPTION;
    !maximized
}

#[cfg(test)]
mod tests {
    use super::*;

    const DISPLAY: Rect = (0, 0, 1920, 1080);
    /// A maximized window's borders reach 8 px past the display on every side.
    const MAXIMIZED: Rect = (-8, -8, 1928, 1088);

    const WS_POPUP: u32 = 0x8000_0000;
    const WS_VISIBLE: u32 = 0x1000_0000;
    const WS_CLIPSIBLINGS: u32 = 0x0400_0000;
    const WS_OVERLAPPEDWINDOW: u32 = 0x00CF_0000;

    fn window(class: &str, rect: Rect, style: u32, zoomed: bool) -> Foreground {
        Foreground {
            rect,
            class: class.into(),
            style: style | WS_VISIBLE,
            zoomed,
            same_process: false,
            visible: true,
            cloaked: false,
        }
    }

    #[test]
    fn a_browser_playing_a_film_full_screen_counts() {
        // Chrome, Edge and Firefox drop the title bar and take the display,
        // for a video as for F11.
        assert!(is_fullscreen(&window("Chrome_WidgetWin_1", DISPLAY, WS_POPUP | WS_CLIPSIBLINGS, false), DISPLAY));
        assert!(is_fullscreen(&window("MozillaWindowClass", DISPLAY, WS_POPUP, false), DISPLAY));
        // Full screen entered from a maximized window: still no title bar.
        assert!(is_fullscreen(&window("Chrome_WidgetWin_1", DISPLAY, WS_CLIPSIBLINGS, true), DISPLAY));
    }

    #[test]
    fn games_and_players_count_borderless_or_exclusive() {
        assert!(is_fullscreen(&window("UnrealWindow", DISPLAY, WS_POPUP, false), DISPLAY));
        assert!(is_fullscreen(&window("SDL_app", DISPLAY, WS_POPUP, false), DISPLAY));
        assert!(is_fullscreen(&window("mpv", DISPLAY, WS_POPUP, false), DISPLAY));
        // A game that covers more than the display (its window spans two).
        assert!(is_fullscreen(&window("UnityWndClass", (0, 0, 3840, 1080), WS_POPUP, false), DISPLAY));
    }

    #[test]
    fn a_store_app_counts_once_it_is_exactly_the_display() {
        // Full screen, its frame keeps the title-bar style and may stay maximized.
        assert!(is_fullscreen(&window(STORE_APP_FRAME, DISPLAY, WS_OVERLAPPEDWINDOW, false), DISPLAY));
        assert!(is_fullscreen(&window(STORE_APP_FRAME, DISPLAY, WS_OVERLAPPEDWINDOW, true), DISPLAY));
        // Or drops it, like any other app.
        assert!(is_fullscreen(&window(STORE_APP_FRAME, DISPLAY, WS_POPUP, false), DISPLAY));
        // Maximized over a taskbar that hides itself: a window like any other.
        assert!(!is_fullscreen(&window(STORE_APP_FRAME, MAXIMIZED, WS_OVERLAPPEDWINDOW, true), DISPLAY));
    }

    #[test]
    fn a_maximized_window_is_not_full_screen_even_over_a_hidden_taskbar() {
        assert!(!is_fullscreen(&window("Notepad", MAXIMIZED, WS_OVERLAPPEDWINDOW, true), DISPLAY));
        assert!(!is_fullscreen(&window("Chrome_WidgetWin_1", MAXIMIZED, WS_OVERLAPPEDWINDOW, true), DISPLAY));
        assert!(!is_fullscreen(&window("CASCADIA_HOSTING_WINDOW_CLASS", DISPLAY, WS_OVERLAPPEDWINDOW, true), DISPLAY));
    }

    #[test]
    fn a_window_that_leaves_part_of_the_display_free_is_not_full_screen() {
        // Maximized above the taskbar: the work area, not the display.
        assert!(!is_fullscreen(&window("Notepad", (-8, -8, 1928, 1040), WS_OVERLAPPEDWINDOW, true), DISPLAY));
        // A borderless window that stops short of one edge.
        assert!(!is_fullscreen(&window("SDL_app", (0, 0, 1920, 1079), WS_POPUP, false), DISPLAY));
        assert!(!is_fullscreen(&window("SDL_app", (1, 0, 1920, 1080), WS_POPUP, false), DISPLAY));
        assert!(!is_fullscreen(&window("SDL_app", (200, 100, 1000, 700), WS_POPUP, false), DISPLAY));
    }

    #[test]
    fn full_screen_on_another_display_leaves_the_island_alone() {
        let second: Rect = (1920, 0, 4480, 1440);
        assert!(!is_fullscreen(&window("Chrome_WidgetWin_1", second, WS_POPUP, false), DISPLAY));
        assert!(is_fullscreen(&window("Chrome_WidgetWin_1", second, WS_POPUP, false), second));
        // A display to the left or above has negative coordinates.
        let left: Rect = (-2560, 0, 0, 1440);
        assert!(is_fullscreen(&window("mpv", left, WS_POPUP, false), left));
        assert!(!is_fullscreen(&window("mpv", left, WS_POPUP, false), DISPLAY));
    }

    #[test]
    fn the_desktop_and_the_shell_are_never_full_screen() {
        for class in SHELL_CLASSES {
            assert!(!is_fullscreen(&window(class, DISPLAY, WS_POPUP, false), DISPLAY), "{class}");
        }
        // The desktop of several displays is one window over all of them.
        assert!(!is_fullscreen(&window("Progman", (0, 0, 4480, 1440), WS_POPUP, false), DISPLAY));
    }

    #[test]
    fn our_own_windows_and_windows_nobody_sees_do_not_count() {
        let ours = Foreground { same_process: true, ..window("Tauri Window", DISPLAY, WS_POPUP, false) };
        assert!(!is_fullscreen(&ours, DISPLAY));
        let hidden = Foreground { visible: false, ..window("SDL_app", DISPLAY, WS_POPUP, false) };
        assert!(!is_fullscreen(&hidden, DISPLAY));
        let cloaked = Foreground { cloaked: true, ..window(STORE_APP_FRAME, DISPLAY, WS_OVERLAPPEDWINDOW, false) };
        assert!(!is_fullscreen(&cloaked, DISPLAY));
    }
}
