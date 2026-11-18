//! `liv-hook office`: one event from a virtual office (docs/OFICINA.md).
//!
//! The office is another program — a team of agents working on its own — and
//! tells Liv what happens by running this with one JSON object on stdin. The
//! object goes to the app as it came, tagged so the app shows it on the office's
//! pill and nowhere else. Nothing of what a hook event goes through applies: no
//! event name, no working directory, no terminal context, no capped strings.
//!
//! Never blocking the office: the app gets the same connect timeout and budget
//! as a hook event nobody waits on, nothing is read back, nothing is printed,
//! and the exit code is 0 whether Liv was there or not.

use std::io::Read;
use std::sync::mpsc;

use serde_json::Value;

use crate::{talk, FIRE_AND_FORGET_BUDGET};

/// The first argument that selects this mode.
pub const ARG: &str = "office";
/// What `liv_kind` says in the line the app receives.
const KIND: &str = "office";
/// The most an event may be, in bytes of JSON. A larger one is dropped whole:
/// cut short it would no longer be the object the office sent.
pub const MAX_EVENT: usize = 16 * 1024;

const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

pub fn run() -> ! {
    let raw = read(std::io::stdin().lock());
    if let Some(line) = prepare(&raw) {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(talk(&line, false, &|| {}));
        });
        let _ = rx.recv_timeout(FIRE_AND_FORGET_BUDGET);
    }
    std::process::exit(0);
}

/// What stdin holds, up to one byte more than an event (and its BOM) may be,
/// which is enough to know it is too long. The rest is read and dropped, so an
/// office that writes more never finds the pipe closed under it.
fn read(mut input: impl Read) -> Vec<u8> {
    let mut raw = Vec::new();
    let limit = (MAX_EVENT + BOM.len() + 1) as u64;
    let _ = input.by_ref().take(limit).read_to_end(&mut raw);
    let _ = std::io::copy(&mut input, &mut std::io::sink());
    raw
}

/// The line to send for what was read, or None when there is nothing to send:
/// not JSON, not an object, or more than [`MAX_EVENT`].
pub fn prepare(raw: &[u8]) -> Option<String> {
    // PowerShell 5 pipes a UTF-8 BOM first; serde_json would choke on it.
    let raw = raw.strip_prefix(&BOM).unwrap_or(raw);
    if raw.len() > MAX_EVENT {
        return None;
    }
    let mut payload = serde_json::from_slice::<Value>(raw).ok()?;
    // Whatever the office wrote there, the tag is ours: an office event can
    // never pass for another kind of line.
    payload.as_object_mut()?.insert("liv_kind".into(), Value::String(KIND.into()));
    let mut line = payload.to_string();
    line.push('\n');
    Some(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sent(raw: &[u8]) -> Value {
        let line = prepare(raw).expect("forwarded");
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1, "one line, whatever the strings hold");
        serde_json::from_str(line.trim_end()).unwrap()
    }

    #[test]
    fn an_event_is_tagged_and_otherwise_sent_as_it_came() {
        let raw = r#"{"type":"agent.state","agent":{"id":"editora","name":"Editora"},"state":"working","summary":"Montando\nel vídeo 12"}"#;
        let mut expected: Value = serde_json::from_str(raw).unwrap();
        expected["liv_kind"] = Value::String("office".into());
        // Nothing a hook event gets: no event name, no cwd, no terminal context.
        assert_eq!(sent(raw.as_bytes()), expected);
    }

    #[test]
    fn the_tag_cannot_be_chosen_by_the_office() {
        let v = sent(br#"{"type":"reset","liv_kind":"agy_pre_tool","hook_event_name":"PermissionRequest"}"#);
        assert_eq!(v["liv_kind"], "office");
    }

    #[test]
    fn a_long_text_is_not_cut_the_way_a_hook_field_is() {
        let summary = "é".repeat(crate::MAX_FIELD_LEN);
        let v = sent(format!(r#"{{"type":"news","news":{{"title":"{summary}"}}}}"#).as_bytes());
        assert_eq!(v["news"]["title"].as_str().unwrap(), summary);
    }

    #[test]
    fn a_bom_is_not_a_reason_to_drop_the_event() {
        let mut raw = BOM.to_vec();
        raw.extend_from_slice(br#"{"type":"reset"}"#);
        assert_eq!(sent(&raw)["type"], "reset");
    }

    #[test]
    fn what_is_not_one_json_object_is_dropped() {
        for raw in ["", "   ", "not json", "[1,2]", "\"reset\"", "42", "null", r#"{"type":"reset"} {"type":"reset"}"#] {
            assert!(prepare(raw.as_bytes()).is_none(), "{raw:?}");
        }
    }

    #[test]
    fn an_event_over_16_kb_is_dropped_and_one_of_exactly_16_kb_is_not() {
        let event = |len: usize| {
            let frame = r#"{"type":"news","news":{"title":""}}"#.len();
            format!(r#"{{"type":"news","news":{{"title":"{}"}}}}"#, "x".repeat(len - frame)).into_bytes()
        };
        assert_eq!(event(MAX_EVENT).len(), MAX_EVENT);
        assert!(prepare(&event(MAX_EVENT)).is_some());
        assert!(prepare(&event(MAX_EVENT + 1)).is_none());
        // The BOM is not part of the event.
        let mut with_bom = BOM.to_vec();
        with_bom.extend_from_slice(&event(MAX_EVENT));
        assert!(prepare(&with_bom).is_some());
    }

    #[test]
    fn stdin_is_read_to_its_end_but_only_an_events_worth_is_kept() {
        let mut input = std::io::Cursor::new(vec![b'x'; 1 << 20]);
        let raw = read(&mut input);
        assert_eq!(raw.len(), MAX_EVENT + BOM.len() + 1);
        assert_eq!(input.position(), 1 << 20, "the rest is drained, not left in the pipe");
        assert!(prepare(&raw).is_none());

        let small = br#"{"type":"reset"}"#;
        assert_eq!(read(&small[..]), small);
    }
}
