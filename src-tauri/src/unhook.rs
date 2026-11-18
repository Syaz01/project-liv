// `liv --remove-hooks`: what the uninstaller runs when the user answers yes to
// "Remove Liv's hooks from Claude Code and the other agents too?"
// (src-tauri/nsis/hooks.nsh). Without that click nothing here runs: a config
// file of the user's is never rewritten unasked.
//
// It is the same removal Settings offers, through the same hardened writer
// (config_file.rs): the file is read strictly, only Liv's own entries leave it,
// and a dated backup is taken next to it before anything is written. What is
// not there is left alone, and one file that cannot be cleaned does not stop
// the others.
//
// No window is made and no other instance is spoken to: it runs, writes its
// lines to the log, and exits.

use crate::{agents, hooks, log};

/// The argument the uninstaller passes.
pub const ARG: &str = "--remove-hooks";

pub fn asked<I: IntoIterator<Item = String>>(args: I) -> bool {
    args.into_iter().skip(1).any(|arg| arg == ARG)
}

/// One place Liv may have written to: whether its entries are there, and how
/// to take them out (the fingerprint of what was read, then the write).
pub struct Place<'a> {
    pub name: String,
    pub installed: bool,
    pub preview: Box<dyn Fn() -> Result<String, String> + 'a>,
    pub write: Box<dyn Fn(&str) -> Result<String, String> + 'a>,
}

/// What became of one place.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// Liv's entries were not there.
    Absent,
    /// Removed; the backups taken, one per line ("" when there was no file to back up).
    Removed(String),
    Failed(String),
}

/// Cleans every place in turn. A failure is reported and the rest go on.
pub fn remove(places: &[Place]) -> Vec<(String, Outcome)> {
    places
        .iter()
        .map(|place| {
            let outcome = if !place.installed {
                Outcome::Absent
            } else {
                match (place.preview)().and_then(|fingerprint| (place.write)(&fingerprint)) {
                    Ok(backups) => Outcome::Removed(backups),
                    Err(err) => Outcome::Failed(err),
                }
            };
            (place.name.clone(), outcome)
        })
        .collect()
}

/// True when nothing failed: the uninstaller says so otherwise.
pub fn all_clean(report: &[(String, Outcome)]) -> bool {
    !report.iter().any(|(_, outcome)| matches!(outcome, Outcome::Failed(_)))
}

/// Everywhere Liv installs hooks: Claude Code's hooks and its status line,
/// then every other agent (agents.rs).
fn places() -> Vec<Place<'static>> {
    let claude = hooks::status();
    let mut places = vec![
        Place {
            name: "Claude Code".into(),
            installed: claude.installed,
            preview: Box::new(|| hooks::preview(false).map(|plan| plan.fingerprint)),
            write: Box::new(|fingerprint| hooks::write(false, fingerprint)),
        },
        Place {
            name: "Claude Code status line".into(),
            installed: claude.plan_relay_installed,
            preview: Box::new(|| hooks::status_line_preview(false).map(|plan| plan.fingerprint)),
            write: Box::new(|fingerprint| hooks::status_line_write(false, fingerprint)),
        },
    ];
    for agent in agents::list() {
        let id = agent.id;
        places.push(Place {
            name: agent.name.into(),
            installed: agent.installed,
            preview: Box::new(move || agents::preview(id, false).map(|plan| plan.fingerprint)),
            write: Box::new(move |fingerprint| agents::apply(id, false, fingerprint)),
        });
    }
    places
}

/// Removes Liv's hooks wherever they are, logging what was done (the files'
/// names, never their contents). The process's exit code: 0 when nothing failed.
pub fn run() -> i32 {
    log::line("remove-hooks: asked by the uninstaller");
    let report = remove(&places());
    for (name, outcome) in &report {
        match outcome {
            Outcome::Absent => {}
            Outcome::Removed(backups) if backups.is_empty() => log::line(format!("remove-hooks: {name}: removed")),
            Outcome::Removed(backups) => {
                log::line(format!("remove-hooks: {name}: removed, backup at {}", backups.replace('\n', ", ")))
            }
            Outcome::Failed(err) => log::line(format!("remove-hooks: {name}: not removed: {err}")),
        }
    }
    if all_clean(&report) { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_the_uninstallers_own_argument_asks_for_it() {
        assert!(asked(args(&["liv.exe", "--remove-hooks"])));
        assert!(asked(args(&["liv.exe", "--autostart", "--remove-hooks"])));
        assert!(!asked(args(&["liv.exe"])));
        assert!(!asked(args(&["liv.exe", "--autostart"])));
        assert!(!asked(args(&["liv.exe", "--remove-hooks-please"])));
        // The program's own path is not an argument, whatever it is called.
        assert!(!asked(args(&["--remove-hooks"])));
    }

    #[test]
    fn what_is_not_there_is_left_alone_and_a_failure_does_not_stop_the_rest() {
        let calls = RefCell::new(Vec::<String>::new());
        let place = |name: &str, installed: bool, preview: Result<&'static str, &'static str>, write: Result<&'static str, &'static str>| {
            let calls = &calls;
            let label = name.to_string();
            let label_w = name.to_string();
            Place {
                name: name.into(),
                installed,
                preview: Box::new(move || {
                    calls.borrow_mut().push(format!("preview {label}"));
                    preview.map(str::to_string).map_err(str::to_string)
                }),
                write: Box::new(move |fingerprint| {
                    calls.borrow_mut().push(format!("write {label_w} {fingerprint}"));
                    write.map(str::to_string).map_err(str::to_string)
                }),
            }
        };
        let report = remove(&[
            place("absent", false, Ok("f0"), Ok("")),
            place("clean", true, Ok("f1"), Ok("settings.json.bak")),
            place("unreadable", true, Err("not JSON"), Ok("")),
            place("changed", true, Ok("f3"), Err("changed since it was read")),
            place("no file", true, Ok("f4"), Ok("")),
        ]);
        assert_eq!(
            report,
            vec![
                ("absent".to_string(), Outcome::Absent),
                ("clean".to_string(), Outcome::Removed("settings.json.bak".into())),
                ("unreadable".to_string(), Outcome::Failed("not JSON".into())),
                ("changed".to_string(), Outcome::Failed("changed since it was read".into())),
                ("no file".to_string(), Outcome::Removed(String::new())),
            ]
        );
        // Nothing is read where Liv is not, nothing is written where the read
        // failed, and every write carries the fingerprint of its own read.
        assert_eq!(
            *calls.borrow(),
            ["preview clean", "write clean f1", "preview unreadable", "preview changed", "write changed f3", "preview no file", "write no file f4"]
        );
        assert!(!all_clean(&report));
        assert!(all_clean(&report[..2]));
        assert!(all_clean(&[]));
    }
}
