// What a webview does by itself as a browser, switched off at the source in
// the installed app: its right-click menu (Refresh, Back, Print…) and its own
// keys (F5, Ctrl+R, Ctrl+F, Ctrl+P…). A Refresh reloads the page, and the
// island's page holds the tasks and the cards agents are waiting on.
//
// Tauri's window options pass neither setting on to WebView2, so they are set
// on it directly, as soon as the webview exists: WebView2 applies a setting
// changed after a page started loading only from the next page on. The pages
// refuse the same things themselves (src/core/guards.ts), and that is what
// holds if this comes too late. A dev build keeps both, for the inspector.

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
use wv2_core::Interface;

pub fn install(win: &WebviewWindow) {
    if cfg!(dev) {
        return;
    }
    let label = win.label().to_string();
    let result = win.with_webview(move |webview| {
        let outcome = (|| -> wv2_core::Result<()> {
            unsafe {
                let settings = webview.controller().CoreWebView2()?.Settings()?;
                settings.SetAreDefaultContextMenusEnabled(false)?;
                settings.cast::<ICoreWebView2Settings3>()?.SetAreBrowserAcceleratorKeysEnabled(false)
            }
        })();
        if let Err(err) = outcome {
            crate::log::line(format!("webview guard ({label}): {err}"));
        }
    });
    if let Err(err) = result {
        crate::log::line(format!("webview guard: {err}"));
    }
}
