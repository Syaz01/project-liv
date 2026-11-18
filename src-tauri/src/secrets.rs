// API keys live in the Windows Credential Manager or, on Linux, the Secret
// Service (GNOME Keyring, KWallet) — never on disk and never in the front end — the island can only ask whether a key is present.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use keyring::Entry;

const SERVICE: &str = "dev.liv.island";

/// Every key Liv may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    "anthropic-api-key",
    "openai-api-key",
    "google-api-key",
    "openrouter-api-key",
    "openai-compatible-key",
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "gitlab-url",
    "gitlab-token",
    "gitea-url",
    "gitea-token",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
];

fn entry(key: &str) -> Option<Entry> {
    if !KNOWN_KEYS.contains(&key) {
        return None;
    }
    Entry::new(SERVICE, key).ok()
}

/// Whether each key is stored, as last seen. Each Secret Service lookup opens a
/// D-Bus session of its own (tens of milliseconds), and the settings ask about
/// every key on every page: a page switch took seconds. Only presence is kept,
/// never a value, and only what a lookup answered for sure.
static PRESENT: LazyLock<Mutex<HashMap<String, bool>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn remember(key: &str, present: bool) {
    PRESENT.lock().unwrap().insert(key.to_string(), present);
}

pub fn get(key: &str) -> Option<String> {
    match entry(key)?.get_password() {
        Ok(value) if !value.is_empty() => {
            remember(key, true);
            Some(value)
        }
        Ok(_) | Err(keyring::Error::NoEntry) => {
            remember(key, false);
            None
        }
        // A locked or unreachable store says nothing about the key.
        Err(_) => None,
    }
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        remember(key, false);
        return Ok(());
    }
    entry.set_password(value).map_err(|e| e.to_string())?;
    remember(key, true);
    Ok(())
}

pub fn clear(key: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            remember(key, false);
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

pub fn present(key: &str) -> bool {
    if let Some(&known) = PRESENT.lock().unwrap().get(key) {
        return known;
    }
    get(key).is_some()
}

/// Looks every key up once, off the main thread, so the settings open on known answers.
pub fn warm_up() {
    std::thread::spawn(|| {
        for key in KNOWN_KEYS {
            let _ = get(key);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_is_answered_from_memory_once_known() {
        remember("calcom-api-key", true);
        assert!(present("calcom-api-key"));
        remember("calcom-api-key", false);
        assert!(!present("calcom-api-key"));
    }
}
