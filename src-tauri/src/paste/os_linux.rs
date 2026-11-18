// The paste on Linux. On X11: Ctrl+V through XTest. Wayland lets no app type
// into another one: there it goes through the RemoteDesktop portal (see
// wayland.rs).

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{self, ConnectionExt as _};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

// Keysyms (X11/keysymdef.h).
const XK_SHIFT_L: u32 = 0xffe1;
const XK_CONTROL_L: u32 = 0xffe3;
const XK_V: u32 = 0x0076;

/// Whether this session is Wayland (where X11 sees only XWayland's windows).
fn is_wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE").map(|v| v.eq_ignore_ascii_case("wayland")).unwrap_or(false)
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// The keyboard map: keycode → its keysyms.
struct Keymap {
    min: u8,
    per: usize,
    syms: Vec<u32>,
}

impl Keymap {
    fn read(conn: &RustConnection) -> Option<Keymap> {
        let setup = conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let reply = conn.get_keyboard_mapping(min, max - min + 1).ok()?.reply().ok()?;
        Some(Keymap { min, per: reply.keysyms_per_keycode as usize, syms: reply.keysyms })
    }

    fn keycode(&self, sym: u32) -> Option<u8> {
        (0..self.syms.len() / self.per.max(1)).find(|&k| self.syms[k * self.per..(k + 1) * self.per].first() == Some(&sym)).map(|k| k as u8 + self.min)
    }
}

/// Ctrl+V (Ctrl+Shift+V for a terminal) in the app in front: through XTest on
/// X11, through the RemoteDesktop portal on Wayland.
pub fn send_paste(shift: bool) -> Result<(), String> {
    if is_wayland() {
        return super::wayland::send_paste(shift);
    }
    let (conn, screen) = x11rb::connect(None).map_err(|e| e.to_string())?;
    let root = conn.setup().roots[screen].root;
    let keymap = Keymap::read(&conn).ok_or("no keyboard map")?;
    let ctrl = keymap.keycode(XK_CONTROL_L).ok_or("no Ctrl key")?;
    let shift_code = keymap.keycode(XK_SHIFT_L).ok_or("no Shift key")?;
    let v = keymap.keycode(XK_V).ok_or("no V key")?;
    let press = |code: u8, down: bool| {
        conn.xtest_fake_input(if down { xproto::KEY_PRESS_EVENT } else { xproto::KEY_RELEASE_EVENT }, code, 0, root, 0, 0, 0)
    };
    let mut seq = vec![(ctrl, true)];
    if shift {
        seq.push((shift_code, true));
    }
    seq.extend([(v, true), (v, false)]);
    if shift {
        seq.push((shift_code, false));
    }
    seq.push((ctrl, false));
    for (code, down) in seq {
        press(code, down).map_err(|e| e.to_string())?;
    }
    conn.sync().map_err(|e| e.to_string())?;
    Ok(())
}
