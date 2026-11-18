// Relay server for liv-hook.
//
// Windows: the named pipe `\\.\pipe\liv-<sid>`, one instance per connection.
// Linux: the Unix socket `$XDG_RUNTIME_DIR/liv.sock`. Every hook event is
// forwarded to the island as a `hook` event. `PermissionRequest` keeps its
// connection open: it waits for the island's decision and writes it back on the
// same connection, which is how approving from the island works. Antigravity's
// `PreToolUse` (tagged `agy_pre_tool`) is the other one: it is answered `ask` at
// once, or `pending` and then the click when its command is put on the card
// (agy_pre_tool below, agy_approvals.rs).
//
// A line tagged `office` is not a hook event: it is one event of a virtual
// office (docs/OFICINA.md) and goes to the island as an `office` event, by a
// path of its own (office_event below).
//
// Who may talk to us: the pipe is created for this account alone (its name
// carries our SID, and its access list names nobody else), every connection is
// checked to come from a process of this account, and one that sends nothing
// within two seconds is dropped. Nothing a connection sends reaches the log as
// it came.
//
// Claude Code is never blocked by us. Three things guarantee it:
//   * liv-hook gives the connection 300 ms and exits cleanly if we are closed;
//   * we only wait for a human once the island has *confirmed* the card is on
//     screen, so a paused island or a webview that is not listening costs a few
//     hundred milliseconds, not two minutes;
//   * whatever happens we drop the connection after the decision timeout, and
//     the terminal takes over.
//
// What we write back is the bare word `allow` or `deny` — or, when the request
// was Claude Code asking a question, `{"answers":{…}}` with what was picked on
// the island. Turning either into the documented hookSpecificOutput JSON is
// liv-hook's job, so the wire format Claude Code expects lives in exactly
// one place.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;

use crate::agy_approvals;
use crate::island::WINDOW_LABEL;
use crate::log;
use crate::session_window;

/// Slightly under liv-hook's own 110 s wait, so we always answer first.
const DECISION_TIMEOUT: Duration = Duration::from_secs(108);
/// How long the island gets to say "the card is up". This is the whole of B4:
/// without it, an island that is paused, hidden behind a crashed webview or
/// simply not listening would leave Claude Code staring at a prompt nobody can
/// see for nearly two minutes.
const ACK_TIMEOUT: Duration = Duration::from_millis(800);
/// How long a connection has to send its line. The relay writes it the moment
/// it connects; a connection that says nothing would otherwise hold its task,
/// and an instance of the pipe, for as long as it liked.
const FIRST_LINE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PAYLOAD: usize = 1 << 20;
/// The event names the relay sends (hook/src/normalize.rs maps every agent's
/// onto these). The log names an event only when it is one of them: what a
/// connection sends is never written to the log as it came.
const KNOWN_EVENTS: &[&str] = &[
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "PermissionRequest", "Notification", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "Interrupt",
];
/// What `liv_kind` says in a line sent by `liv-hook office` (hook/src/office.rs).
const OFFICE_KIND: &str = "office";
/// The longest line taken as an office event: twice the 16 KB the relay
/// forwards, so nothing it sends is refused for the few bytes its tag adds.
const MAX_OFFICE_LINE: usize = 32 * 1024;

/// What the island can say about a permission request.
pub enum Reply {
    /// The card is on screen and a human can act on it.
    Ack,
    /// A human clicked: `allow` or `deny`.
    Decision(String),
    /// Nobody can act on it — paused, or another request already holds the card.
    Decline,
}

/// Permission requests the island has been told about.
#[derive(Default)]
pub struct Pending(pub Mutex<HashMap<String, mpsc::Sender<Reply>>>);

static COUNTER: AtomicU64 = AtomicU64::new(1);

/// `\\.\pipe\liv-<sid>` — must match liv-hook's `pipe_path()` exactly.
#[cfg(windows)]
pub fn pipe_name() -> String {
    let key = crate::platform::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\liv-{key}")
}

/// One instance of the pipe `name`, which only this account may open. `first`
/// also refuses to join a pipe somebody else already owns under our name,
/// rather than serving on top of it.
#[cfg(windows)]
fn listen(name: &str, first: bool) -> std::io::Result<NamedPipeServer> {
    let mut options = ServerOptions::new();
    options.first_pipe_instance(first);
    // SAFETY: `attributes` points at a SECURITY_ATTRIBUTES that outlives the call.
    crate::platform::with_owner_only_access(|attributes| unsafe {
        options.create_with_security_attributes_raw(name, attributes)
    })
}

#[cfg(windows)]
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let name = pipe_name();
        let mut server = match listen(&name, true) {
            Ok(s) => s,
            Err(err) => {
                log::line(format!("cannot open the relay pipe: {err}"));
                return;
            }
        };
        loop {
            if server.connect().await.is_err() {
                // A failed instance never connects again: listen on a fresh one.
                if let Ok(fresh) = listen(&name, false) {
                    server = fresh;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            // Hand the connected instance to a task and listen on a fresh one.
            let next = match listen(&name, false) {
                Ok(s) => s,
                Err(err) => {
                    log::line(format!("cannot reopen the relay pipe: {err}"));
                    return;
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, connected).await });
        }
    });
}

#[cfg(target_os = "linux")]
pub fn start(app: AppHandle) {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    tauri::async_runtime::spawn(async move {
        let Some(path) = crate::platform::relay_socket_path() else {
            log::line("no private runtime directory ($XDG_RUNTIME_DIR) — Claude Code hooks are inactive");
            return;
        };
        // A socket file left behind by a crash answers nothing and can go. One
        // that answers belongs to a Liv that is still running: like
        // first_pipe_instance on Windows, we refuse to serve on top of it.
        if path.exists() {
            if std::os::unix::net::UnixStream::connect(&path).is_ok() {
                log::line("another Liv already serves the relay socket");
                return;
            }
            let _ = std::fs::remove_file(&path);
        }
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(err) => {
                log::line(format!("cannot open the relay socket: {err}"));
                return;
            }
        };
        // The runtime directory is already 0700; this is belt and braces.
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        let uid = unsafe { libc::getuid() };
        loop {
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
            };
            // Only the relay run by our own user may drive the island.
            if !matches!(stream.peer_cred(), Ok(c) if c.uid() == uid) {
                log::line("refused a relay connection from another user");
                continue;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, stream).await });
        }
    });
}

/// One accepted relay connection, whatever carries it.
trait Relay: AsyncRead + AsyncWrite + Unpin {
    /// Ends the conversation once everything has been written.
    fn finish(&mut self) {}
    /// The relay process on the other end, where the OS says.
    fn client_pid(&self) -> Option<u32> {
        None
    }
    /// Whether the other end runs as this account, asked once its line is read.
    fn same_user(&self) -> bool {
        true
    }
}

#[cfg(windows)]
impl Relay for NamedPipeServer {
    fn finish(&mut self) {
        let _ = self.disconnect();
    }
    fn same_user(&self) -> bool {
        use std::os::windows::io::AsRawHandle;
        crate::platform::pipe_client_is_same_user(self.as_raw_handle())
    }
    fn client_pid(&self) -> Option<u32> {
        use std::os::windows::io::AsRawHandle;
        crate::platform::pipe_client_pid(self.as_raw_handle())
    }
}

/// Dropping the stream closes it; the relay reads up to our newline first.
/// Whose it is was checked when it was accepted (`start`).
#[cfg(target_os = "linux")]
impl Relay for tokio::net::UnixStream {
    /// SO_PEERCRED: the process that connected, as the kernel saw it.
    fn client_pid(&self) -> Option<u32> {
        let pid = self.peer_cred().ok()?.pid()?;
        u32::try_from(pid).ok().filter(|pid| *pid > 1)
    }
}

/// The line a connection sends, without its newline: everything up to the
/// first one, or to the end of the stream. None when reading fails, or when no
/// whole line has come within `wait`.
async fn first_line(pipe: &mut impl Relay, wait: Duration) -> Option<Vec<u8>> {
    let read = async {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match pipe.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.contains(&b'\n') || buf.len() > MAX_PAYLOAD {
                        break;
                    }
                }
                Err(_) => return None,
            }
        }
        Some(buf)
    };
    let mut buf = tokio::time::timeout(wait, read).await.ok()??;
    if let Some(end) = buf.iter().position(|b| *b == b'\n') {
        buf.truncate(end);
    }
    Some(buf)
}

/// `event` as the log may show it: its name when it is one the relay sends,
/// else a fixed word.
fn loggable_event(event: &str) -> &'static str {
    KNOWN_EVENTS.iter().copied().find(|known| *known == event).unwrap_or("(other)")
}

/// A request id as the log may show it. Ours are `<pid>-<count>`; the island
/// hands them back, and anything else it sends is not written down.
fn loggable_id(id: &str) -> &str {
    let ours = id.len() <= 32
        && id.split_once('-').is_some_and(|(pid, count)| {
            !pid.is_empty() && !count.is_empty() && pid.bytes().chain(count.bytes()).all(|b| b.is_ascii_digit())
        });
    if ours { id } else { "(unknown)" }
}

async fn handle(app: AppHandle, mut pipe: impl Relay) {
    let Some(line) = first_line(&mut pipe, FIRST_LINE_TIMEOUT).await else { return };
    let line = &line[..];
    if !pipe.same_user() {
        log::line("refused a relay connection from another user");
        pipe.finish();
        return;
    }
    let Ok(mut payload) = serde_json::from_slice::<Value>(line) else { return };
    if !payload.is_object() {
        return;
    }

    // A virtual office's event: shown on its pill, and nothing else of what
    // follows — it is no session, counts for no recap, asks for no decision and
    // leaves nothing in the log.
    if is_office(&payload) {
        let enabled = app.state::<crate::Shared>().settings.lock().unwrap().office_enabled;
        if let Some(event) = office_event(payload, line.len(), enabled) {
            let _ = app.emit_to(WINDOW_LABEL, "office", event);
        }
        pipe.finish();
        return;
    }

    let event = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    note_session_window(&pipe, &payload, &event);
    crate::herdr::observe(&payload, &event);
    // Counts for the weekly recap — never the command, path or prompt itself.
    crate::recap::observe(&app, &payload);

    // Antigravity's PreToolUse: its relay waits for one line (agy_approvals.rs).
    if event == "PreToolUse" && payload.get("liv_kind").and_then(Value::as_str) == Some(agy_approvals::KIND) {
        agy_pre_tool(app, pipe, payload).await;
        return;
    }

    if event != "PermissionRequest" {
        // The status line relay calls in with every Claude Code update: not log-worthy.
        if event != "StatusLine" {
            log::line(format!("hook {}", loggable_event(&event)));
        }
        let _ = app.emit_to(WINDOW_LABEL, "hook", payload);
        pipe.finish();
        return;
    }

    let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::channel::<Reply>(4);
    {
        let pending = app.state::<Pending>();
        pending.0.lock().unwrap().insert(id.clone(), tx);
    }
    crate::recap::note_request(&app, &id, &payload);
    payload["request_id"] = json!(id);
    log::line(format!("hook PermissionRequest id={id}"));
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);

    // Answered in the terminal (or the app) instead: Claude Code ends the relay,
    // its end of the connection closes, and the island must drop the card at
    // once rather than keep offering a question that is already settled.
    let decision = tokio::select! {
        d = wait_for_decision(&id, &mut rx) => d,
        () = client_gone(&mut pipe) => {
            log::line(format!("hook id={id} answered elsewhere"));
            crate::recap::forget_request(&app, &id);
            None
        }
    };
    app.state::<Pending>().0.lock().unwrap().remove(&id);

    // No decision: say nothing at all. liv-hook then writes nothing to stdout
    // and Claude Code asks in the terminal, exactly as if Liv were closed.
    // The island is told, so a card that came up late (or is still up after the
    // long wait) goes instead of holding the view with nobody to answer.
    match decision {
        Some(d) => {
            let _ = pipe.write_all(format!("{d}\n").as_bytes()).await;
            let _ = pipe.flush().await;
        }
        None => {
            let _ = app.emit_to(WINDOW_LABEL, "approval-expired", &id);
        }
    }
    pipe.finish();
}

/// True for a line sent by `liv-hook office`.
fn is_office(payload: &Value) -> bool {
    payload.get("liv_kind").and_then(Value::as_str) == Some(OFFICE_KIND)
}

/// What the island is told for an office line of `len` bytes, or None when it
/// is told nothing: Settings → Integrations → Show my virtual office is off, or
/// the line is longer than an office event can be. The island reads the event
/// itself (src/core/office.ts); here it is only passed on, without the tag.
fn office_event(mut payload: Value, len: usize, enabled: bool) -> Option<Value> {
    if !enabled || len > MAX_OFFICE_LINE {
        return None;
    }
    payload.as_object_mut()?.remove("liv_kind");
    Some(payload)
}

/// Antigravity is about to run a tool and its relay waits for a line. The island always
/// gets the event, as for any agent. Then, when Approve commands from the island is on and
/// none of Antigravity's rules covers the command, the card comes up as a permission
/// request: once the island says it is on screen the relay is told `pending` (it then
/// waits for the click instead of a few seconds), and Allow, Deny or Reply in terminal
/// (`ask`) follow. Anything else — no card, no ack, no click in time — is `ask`, and
/// Antigravity shows its own prompt. The same flow as the Mac's processAgyApproval.
async fn agy_pre_tool(app: AppHandle, mut pipe: impl Relay, payload: Value) {
    let enabled = app.state::<crate::Shared>().settings.lock().unwrap().agy_approvals_enabled;
    let gate = agy_approvals::gate(&payload, enabled, &crate::platform::home_dir());
    log::line("hook PreToolUse");
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload.clone());
    let Some(gate) = gate else {
        reply_line(&mut pipe, "ask").await;
        pipe.finish();
        return;
    };

    let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::channel::<Reply>(4);
    app.state::<Pending>().0.lock().unwrap().insert(id.clone(), tx);
    crate::recap::note_request(&app, &id, &payload);
    let mut card = payload;
    card["hook_event_name"] = json!("PermissionRequest");
    card["request_id"] = json!(id);
    card["tool_input"]["command"] = json!(gate.command);
    log::line(format!("hook Antigravity command waits for the island id={id}"));
    let _ = app.emit_to(WINDOW_LABEL, "hook", card);

    // The relay hung up (Antigravity stopped waiting, or the turn was cancelled): the
    // card goes, nothing is written.
    let first = tokio::select! {
        r = tokio::time::timeout(ACK_TIMEOUT, rx.recv()) => r.ok().flatten(),
        () = client_gone(&mut pipe) => {
            agy_settled(&app, &id, "answered elsewhere");
            return;
        }
    };
    let decision = match first {
        Some(Reply::Ack) => {
            reply_line(&mut pipe, "pending").await;
            tokio::select! {
                r = wait_for_click(&mut rx, gate.wait) => match r {
                    Waited::Decision(d) => Some(d),
                    Waited::Released => None,
                    Waited::TimedOut => {
                        log::line(format!("hook id={id} timed out — Antigravity asks"));
                        None
                    }
                },
                () = client_gone(&mut pipe) => {
                    agy_settled(&app, &id, "answered elsewhere");
                    return;
                }
            }
        }
        // A click that beats the ack is still a click.
        Some(Reply::Decision(d)) => Some(d),
        Some(Reply::Decline) | None => None,
    };
    app.state::<Pending>().0.lock().unwrap().remove(&id);
    // Only a click on Allow or Deny is a decision; `ask` hands the command back to
    // Antigravity's own prompt, where its Always allow lives.
    let word = match decision.as_deref() {
        Some("allow") => "allow",
        Some("deny") => "deny",
        _ => "ask",
    };
    log::line(format!("hook id={id} answered {word}"));
    if word == "ask" {
        crate::recap::forget_request(&app, &id);
        let _ = app.emit_to(WINDOW_LABEL, "approval-expired", &id);
    }
    reply_line(&mut pipe, word).await;
    pipe.finish();
}

/// The relay left before an answer: forget the request, take the card down.
fn agy_settled(app: &AppHandle, id: &str, why: &str) {
    log::line(format!("hook id={id} {why}"));
    app.state::<Pending>().0.lock().unwrap().remove(id);
    crate::recap::forget_request(app, id);
    let _ = app.emit_to(WINDOW_LABEL, "approval-expired", id);
}

async fn reply_line(pipe: &mut impl Relay, word: &str) {
    let _ = pipe.write_all(format!("{word}\n").as_bytes()).await;
    let _ = pipe.flush().await;
}

/// Resolves once the relay has gone (end of stream or a broken pipe). It sends
/// nothing after its one line, so any read result means it is done.
async fn client_gone(pipe: &mut impl Relay) {
    let mut probe = [0u8; 64];
    loop {
        match pipe.read(&mut probe).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

/// Finds, once per session, the window it runs in — see session_window.rs.
///
/// Only while the session is unknown, so the process snapshot is not taken on
/// every event. The relay must still be running for its parents to be found:
/// a permission request always is (it waits for us), a quick event may already
/// have exited, and then a later event of the session tries again.
fn note_session_window(pipe: &impl Relay, payload: &Value, event: &str) {
    let Some(session) = payload.get("session_id").and_then(Value::as_str) else { return };
    if event == "SessionEnd" {
        session_window::forget(session);
        return;
    }
    if session_window::known(session) {
        return;
    }
    let Some(relay) = pipe.client_pid() else { return };
    let ancestors = crate::platform::process_ancestors(relay);
    // No ancestors: the relay was already gone, so try again next time. Some,
    // but none with a window (a classic console): settled, VS Code it is.
    if !ancestors.is_empty() {
        session_window::remember(session, crate::platform::window_owners(&ancestors));
    }
}

/// Two waits: a short one for "the card is up", then the long one for a human.
async fn wait_for_decision(id: &str, rx: &mut mpsc::Receiver<Reply>) -> Option<String> {
    match tokio::time::timeout(ACK_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Ack)) => {}
        // A click that beats the ack is still a click.
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {}", loggable(&d)));
            return Some(d);
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} not shown — terminal takes over"));
            return None;
        }
        Ok(None) => return None,
        Err(_) => {
            log::line(format!("hook id={id} island never acknowledged — terminal takes over"));
            return None;
        }
    }

    match wait_for_click(rx, DECISION_TIMEOUT).await {
        Waited::Decision(d) => {
            log::line(format!("hook id={id} answered {}", loggable(&d)));
            Some(d)
        }
        Waited::Released => {
            log::line(format!("hook id={id} released without a decision"));
            None
        }
        Waited::TimedOut => {
            log::line(format!("hook id={id} timed out — terminal takes over"));
            None
        }
    }
}

/// How the wait for a human ended.
#[derive(Debug, PartialEq)]
enum Waited {
    /// A click: `allow`, `deny`, or the answers to a question.
    Decision(String),
    /// The island let the request go without one.
    Released,
    /// Nobody answered within the wait.
    TimedOut,
}

/// Once the card is up: the island's answer, within `wait` in all. The island
/// saying again that the card is up (a request it was told about twice) is not
/// an answer, and the wait goes on.
async fn wait_for_click(rx: &mut mpsc::Receiver<Reply>, wait: Duration) -> Waited {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(Reply::Ack)) => {}
            Ok(Some(Reply::Decision(d))) => return Waited::Decision(d),
            Ok(Some(Reply::Decline)) | Ok(None) => return Waited::Released,
            Err(_) => return Waited::TimedOut,
        }
    }
}

/// The log says a question was answered, never with what.
fn loggable(decision: &str) -> &str {
    if decision.starts_with('{') { "a question" } else { decision }
}

fn send(app: &AppHandle, request_id: &str, reply: Reply, keep: bool) {
    let sender = {
        let pending = app.state::<Pending>();
        let mut map = pending.0.lock().unwrap();
        if keep { map.get(request_id).cloned() } else { map.remove(request_id) }
    };
    match sender {
        Some(tx) => {
            let _ = tx.try_send(reply);
        }
        None => log::line(format!("reply for id={} — no pending request", loggable_id(request_id))),
    }
}

/// The island has the card on screen; the long wait may begin.
pub fn acknowledge(app: &AppHandle, request_id: &str) {
    send(app, request_id, Reply::Ack, true);
}

/// Nobody can act on this one — paused, or another card already holds the view.
pub fn decline(app: &AppHandle, request_id: &str) {
    log::line(format!("decline id={}", loggable_id(request_id)));
    send(app, request_id, Reply::Decline, false);
}

/// Called by the island's Allow / Deny buttons. Only ever a bare word: turning
/// it into Claude Code's JSON is liv-hook's job.
pub fn answer(app: &AppHandle, request_id: &str, decision: &str) {
    let word = match decision {
        "allow" | "always" => "allow",
        _ => "deny",
    };
    log::line(format!("decision id={} {word}", loggable_id(request_id)));
    send(app, request_id, Reply::Decision(word.to_string()), false);
}

/// Called when an option is picked for a question Claude Code asked. `answers`
/// maps each question's text to the chosen label, which is the shape
/// AskUserQuestion takes them in.
pub fn answer_question(app: &AppHandle, request_id: &str, answers: &HashMap<String, serde_json::Value>) {
    log::line(format!("decision id={} answered a question", loggable_id(request_id)));
    // One line: the relay reads up to the first newline.
    let line = json!({ "answers": answers }).to_string();
    send(app, request_id, Reply::Decision(line), false);
}

#[cfg(test)]
mod tests {
    use super::*;

    impl Relay for tokio::io::DuplexStream {}

    fn block_on<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    /// The card's fast exit: the relay hanging up (Claude Code ended it because
    /// the prompt was answered in the terminal) is seen at once, and a relay
    /// that is still waiting is not mistaken for one that left.
    #[test]
    fn a_relay_that_hangs_up_is_seen_at_once() {
        block_on(async {
            let (mut ours, theirs) = tokio::io::duplex(64);
            let waiting = tokio::time::timeout(Duration::from_millis(50), client_gone(&mut ours)).await;
            assert!(waiting.is_err(), "a live relay must not count as gone");
            drop(theirs);
            let gone = tokio::time::timeout(Duration::from_millis(50), client_gone(&mut ours)).await;
            assert!(gone.is_ok(), "a closed relay must be seen within the poll");
        });
    }

    #[test]
    fn a_connection_that_sends_no_line_is_dropped_at_the_deadline() {
        use tokio::io::AsyncWriteExt;
        let wait = Duration::from_millis(80);
        block_on(async {
            // Connected and silent: given up on, not waited for.
            let (mut ours, _theirs) = tokio::io::duplex(64);
            let started = std::time::Instant::now();
            assert_eq!(first_line(&mut ours, wait).await, None);
            assert!(started.elapsed() >= wait && started.elapsed() < Duration::from_secs(2));

            // Half a line and then nothing is no line either.
            let (mut ours, mut theirs) = tokio::io::duplex(64);
            theirs.write_all(b"{\"hook_event_name\":").await.unwrap();
            assert_eq!(first_line(&mut ours, wait).await, None);

            // A line is taken up to its newline, at once; what follows is not part of it.
            let (mut ours, mut theirs) = tokio::io::duplex(64);
            theirs.write_all(b"{\"a\":1}\nmore").await.unwrap();
            let started = std::time::Instant::now();
            assert_eq!(first_line(&mut ours, Duration::from_secs(5)).await.as_deref(), Some(&b"{\"a\":1}"[..]));
            assert!(started.elapsed() < Duration::from_secs(1));

            // A relay that hangs up without a newline has said all it will.
            let (mut ours, mut theirs) = tokio::io::duplex(64);
            theirs.write_all(b"{\"a\":2}").await.unwrap();
            drop(theirs);
            assert_eq!(first_line(&mut ours, wait).await.as_deref(), Some(&b"{\"a\":2}"[..]));
        });
    }

    #[test]
    fn the_card_being_acknowledged_again_does_not_end_the_wait() {
        block_on(async {
            // The island acknowledges a request it was told about twice, then the click comes.
            let (tx, mut rx) = mpsc::channel::<Reply>(4);
            tx.send(Reply::Ack).await.unwrap();
            tx.send(Reply::Ack).await.unwrap();
            tx.send(Reply::Decision("allow".into())).await.unwrap();
            assert_eq!(wait_for_decision("1-1", &mut rx).await.as_deref(), Some("allow"));

            // Acknowledged again and again, the wait is still the one wait, not a new one each time.
            let (tx, mut rx) = mpsc::channel::<Reply>(4);
            let acks = tokio::spawn(async move {
                for _ in 0..6 {
                    let _ = tx.send(Reply::Ack).await;
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
                tx
            });
            let started = std::time::Instant::now();
            assert_eq!(wait_for_click(&mut rx, Duration::from_millis(100)).await, Waited::TimedOut);
            assert!(started.elapsed() < Duration::from_millis(170), "{:?}", started.elapsed());
            let tx = acks.await.unwrap();
            while rx.try_recv().is_ok() {}

            // A release and a hang-up of the island's side still end it.
            tx.send(Reply::Ack).await.unwrap();
            tx.send(Reply::Decline).await.unwrap();
            assert_eq!(wait_for_click(&mut rx, Duration::from_secs(5)).await, Waited::Released);
            drop(tx);
            assert_eq!(wait_for_click(&mut rx, Duration::from_secs(5)).await, Waited::Released);
        });
    }

    #[test]
    fn nothing_a_connection_or_the_island_sends_is_logged_as_it_came() {
        for event in KNOWN_EVENTS {
            assert_eq!(loggable_event(event), *event);
        }
        // The events the island's hooks install are all known.
        for (event, _) in crate::hooks::HOOK_EVENTS {
            assert_eq!(loggable_event(event), *event);
        }
        for forged in ["", "Stop\n2026-01-01 00:00:00 decision id=1-1 allow", "stop", "PreToolUse ", "SomethingNew"] {
            assert_eq!(loggable_event(forged), "(other)", "{forged:?}");
        }
        assert_eq!(loggable_id("4242-17"), "4242-17");
        for forged in ["", "-", "1-", "-1", "1-2-3", "1-2\nhook Stop", "a-1", "１-２", &"1".repeat(40)] {
            assert_eq!(loggable_id(forged), "(unknown)", "{forged:?}");
        }
    }

    /// The pipe's access list, as Windows spells it.
    #[cfg(windows)]
    fn access_list(handle: std::os::windows::io::RawHandle) -> String {
        use windows::core::PWSTR;
        use windows::Win32::Foundation::{LocalFree, HANDLE, HLOCAL};
        use windows::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1, SE_KERNEL_OBJECT,
        };
        use windows::Win32::Security::{DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
        unsafe {
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            let status = GetSecurityInfo(
                HANDLE(handle), SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, None, None, None, None, Some(&mut descriptor),
            );
            assert!(status.is_ok(), "{status:?}");
            let mut text = PWSTR::null();
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &mut text, None,
            )
            .unwrap();
            let spelled = text.to_string().unwrap();
            let _ = LocalFree(Some(HLOCAL(text.0.cast())));
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            spelled
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_pipe_is_this_accounts_alone_and_recognises_its_own_relay() {
        use std::io::Write;
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        let name = format!(r"\\.\pipe\liv-test-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
        let sid = crate::platform::current_user_sid().expect("our SID");
        block_on(async {
            let mut server = listen(&name, true).expect("the pipe opens");
            // One entry, ours, with nothing inherited: not Everyone's read access
            // that Windows gives a pipe by default.
            assert_eq!(access_list(server.as_raw_handle()), format!("D:P(A;;FA;;;{sid})"));
            // Nobody starts another pipe on the name, and our next instance joins it.
            assert!(listen(&name, true).is_err());
            let next = listen(&name, false).expect("a second instance");
            assert_eq!(access_list(next.as_raw_handle()), format!("D:P(A;;FA;;;{sid})"));

            // A relay of this account connects the way liv-hook does (hook/src/win.rs),
            // sends its line and is gone before we look.
            let path = name.clone();
            let relay = std::thread::spawn(move || {
                let mut pipe = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .security_qos_flags(0x0001_0000) // SECURITY_IDENTIFICATION
                    .open(&path)
                    .expect("this account may open its own pipe");
                pipe.write_all(b"{\"hook_event_name\":\"Stop\"}\n").unwrap();
            });
            server.connect().await.unwrap();
            relay.join().unwrap();
            let line = first_line(&mut server, Duration::from_secs(2)).await.expect("its line");
            assert_eq!(line, br#"{"hook_event_name":"Stop"}"#);
            assert!(server.same_user(), "a relay of this account is ours, even once it has gone");
        });
    }

    #[test]
    fn only_a_line_tagged_office_takes_the_office_path() {
        assert!(is_office(&json!({ "liv_kind": "office", "type": "reset" })));
        // A hook event, Antigravity's tagged one, and a tag that is not a string.
        assert!(!is_office(&json!({ "hook_event_name": "Stop" })));
        assert!(!is_office(&json!({ "hook_event_name": "PreToolUse", "liv_kind": agy_approvals::KIND })));
        assert!(!is_office(&json!({ "liv_kind": ["office"] })));
        assert!(!is_office(&json!({ "type": "office" })));
    }

    #[test]
    fn an_office_event_reaches_the_island_as_it_came_without_its_tag() {
        let line = json!({
            "liv_kind": "office",
            "type": "ask.open",
            "hook_event_name": "PermissionRequest",
            "request_id": "forged",
            "ask": { "id": "guion-12", "title": "¿Apruebas el guion?" },
        });
        let event = office_event(line, 200, true).expect("emitted");
        assert_eq!(
            event,
            json!({
                "type": "ask.open",
                "hook_event_name": "PermissionRequest",
                "request_id": "forged",
                "ask": { "id": "guion-12", "title": "¿Apruebas el guion?" },
            })
        );
    }

    #[test]
    fn an_office_event_is_dropped_when_the_office_is_switched_off_or_the_line_is_too_long() {
        let line = || json!({ "liv_kind": "office", "type": "reset" });
        assert!(office_event(line(), 40, false).is_none());
        assert!(office_event(line(), MAX_OFFICE_LINE, true).is_some());
        assert!(office_event(line(), MAX_OFFICE_LINE + 1, true).is_none());
    }
}
