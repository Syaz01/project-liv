//! The relay as an agent runs it: the built program, started the way Claude
//! Code's exec form starts it — no shell, its path with forward slashes, the
//! event's name as its only argument — and what it does with its input.
//!
//! Nothing here reaches a running Liv: the relay gives up, or finds nothing it
//! can read, before it would connect.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The relay's path as Liv writes it in `command` (src-tauri/src/agents.rs, `Relay::program`).
fn relay() -> String {
    env!("CARGO_BIN_EXE_liv-hook").replace('\\', "/")
}

/// Waits for `child` to end, at most `limit`: its exit code and how long it took.
fn finish(child: &mut std::process::Child, limit: Duration) -> (Option<i32>, Duration) {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return (status.code(), started.elapsed());
        }
        if started.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the relay was still running after {limit:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn printed(child: &mut std::process::Child) -> String {
    let mut out = String::new();
    child.stdout.take().unwrap().read_to_string(&mut out).unwrap();
    out
}

#[test]
fn an_input_left_open_costs_two_seconds_not_the_hooks_timeout() {
    for event in ["PreToolUse", "PermissionRequest"] {
        let mut child = Command::new(relay())
            .arg(event)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("started with no shell, by its path with forward slashes");
        // Held open for as long as the relay runs, and never written to.
        let held = child.stdin.take().unwrap();
        let (code, took) = finish(&mut child, Duration::from_secs(20));
        drop(held);
        assert_eq!(code, Some(0), "{event}: always exit 0");
        assert!(took >= Duration::from_millis(1500) && took < Duration::from_secs(10), "{event}: {took:?}");
        assert_eq!(printed(&mut child), "", "{event}: nothing is said, so nothing is allowed");
    }
}

#[test]
fn an_input_that_is_no_event_ends_at_once_in_silence() {
    for (agent, expected) in [(None, ""), (Some("copilot"), "{\"permissionDecision\":\"ask\"}\n")] {
        let mut command = Command::new(relay());
        if let Some(agent) = agent {
            command.args(["--agent", agent]);
        }
        // An empty input, closed: nothing to forward.
        let mut child = command
            .arg("PermissionRequest")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let (code, took) = finish(&mut child, Duration::from_secs(20));
        assert_eq!(code, Some(0));
        assert!(took < Duration::from_secs(1), "{took:?}");
        // Claude Code is told nothing; Copilot, which denies without an answer, to ask.
        assert_eq!(printed(&mut child), expected, "{agent:?}");
    }
}
