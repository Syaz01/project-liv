// Claude API client — the same integration as ClaudeService.swift: multi-turn
// chat with web search, and files sent as document/image/text blocks.
//
// Everything happens here rather than in the island: the API key never leaves
// the credential store, and file bytes never cross the IPC boundary.
//
// Without a key, the chat goes to the user's own Claude Code instead
// (claude_code.rs).
//
// LIV_ANTHROPIC_BASE_URL points the chat at an Anthropic-compatible gateway
// instead. Only that variable is read: Claude Code's own
// ANTHROPIC_BASE_URL may name a proxy the user never meant to hand this key to.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Url;
use serde_json::{json, Value};

use crate::chat::{self, Chat, ChatContext, ChatReply, ModelInfo};
use crate::i18n::{t, tf};
use crate::{claude_code, net, secrets};

/// Credential store entry of the Anthropic API key.
pub const KEY: &str = "anthropic-api-key";
const DEFAULT_ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const BASE_URL_VAR: &str = "LIV_ANTHROPIC_BASE_URL";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Server-side fallback: on a policy decline the API retries the same request on
/// a fallback model inside the same call, so the island never shows a dead end.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// Room for the answer and for the thinking before it: on the current models
/// thinking is always on and counts toward this limit, shown or not.
const MAX_TOKENS: u32 = 16_000;
/// A web search that runs long comes back paused, to be asked for again:
/// how many times a turn is resumed before Liv shows what it has.
const MAX_RESUMES: usize = 4;
/// Text and code files are inlined; anything larger is skipped, as on macOS.
const MAX_INLINE_TEXT: u64 = 200_000;

/// The model of a new install. The same id as "default" in
/// src/core/claude-models.json, which a test below holds it to.
pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
static CATALOG: &str = include_str!("../../src/core/claude-models.json");

/// The models offered before the account can be asked for its own list: the
/// ones in src/core/claude-models.json, shared with the settings window.
pub fn catalog() -> Vec<ModelInfo> {
    let file: Value = serde_json::from_str(CATALOG).expect("claude-models.json");
    let text = |model: &Value, field: &str| model.get(field).and_then(Value::as_str).map(str::to_string);
    file.get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| Some(ModelInfo { id: text(model, "id")?, label: text(model, "label")? }))
        .collect()
}

/// Whether a declined request can be re-run on another model inside the same
/// call. Haiku has no such fallback, and the API rejects the request outright.
fn takes_fallbacks(model: &str) -> bool {
    !model.contains("haiku")
}

/// Whether Claude can answer at all: an API key, or else Claude Code.
pub fn ready() -> bool {
    secrets::present(KEY) || claude_code::available()
}

/// The Messages endpoint: Anthropic's, or the gateway in LIV_ANTHROPIC_BASE_URL.
/// Read once; the gateway's host (never the key) goes to the log once.
fn endpoint() -> Result<Url, String> {
    static ENDPOINT: OnceLock<Result<Url, String>> = OnceLock::new();
    ENDPOINT
        .get_or_init(|| {
            let raw = std::env::var(BASE_URL_VAR).ok().filter(|v| !v.trim().is_empty());
            let resolved = match raw {
                None => Ok(Url::parse(DEFAULT_ENDPOINT).expect("valid default endpoint")),
                Some(raw) => net::anthropic_endpoint(&raw),
            };
            match &resolved {
                Ok(url) if url.as_str() != DEFAULT_ENDPOINT => crate::log::line(format!(
                    "chat: Claude requests go to {} ({BASE_URL_VAR})",
                    net::host_for_log(url)
                )),
                Err(err) => crate::log::line(format!("chat: {err}")),
                _ => {}
            }
            resolved
        })
        .clone()
}

/// The model list endpoint next to the Messages one.
fn models_endpoint(messages: &Url) -> Url {
    let mut url = messages.clone();
    let path = url.path().trim_end_matches("/messages").to_string();
    url.set_path(&format!("{path}/models"));
    url.set_query(Some("limit=100"));
    url
}

/// The user's content blocks for one turn. The file context rides along
/// with the first message only, exactly like ClaudeService.chat().
fn user_content(first: bool, context: Option<&ChatContext>, query: &str) -> Vec<Value> {
    let mut content: Vec<Value> = Vec::new();
    if first {
        match context {
            Some(ChatContext::File { name, path }) => {
                if let Some(block) = file_block(path) {
                    content.push(block);
                }
                content.push(json!({ "type": "text", "text": format!("File: {name}") }));
            }
            None => {}
        }
    }
    content.push(json!({ "type": "text", "text": query }));
    content
}

fn request_body(model: &str, system: &str, history: &[Value], user: &Value) -> Value {
    let mut messages = history.to_vec();
    messages.push(user.clone());
    let mut body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "tools": [{ "type": "web_search_20260209", "name": "web_search", "max_uses": 5 }],
        "messages": messages,
    });
    if takes_fallbacks(model) {
        body["fallbacks"] = json!("default");
    }
    body
}

/// True when the API turned the request down because of `fallbacks` itself (a
/// model or a gateway that does not take it): the turn is then sent without.
fn rejects_fallbacks(error: &str) -> bool {
    error.starts_with("Claude API 400") && error.to_lowercase().contains("fallback")
}

/// A turn the API paused mid-search: its blocks so far, to send back as they are.
fn paused(response: &Value) -> Option<Vec<Value>> {
    if response.get("stop_reason").and_then(Value::as_str) != Some("pause_turn") {
        return None;
    }
    response.get("content").and_then(Value::as_array).cloned().filter(|blocks| !blocks.is_empty())
}

/// The assistant's full text from a Messages API content array — the same as
/// claudeResponseText() on the Mac. Web search answers interleave text
/// with tool blocks, and citations split a sentence across adjacent text
/// blocks: every text block is kept, joined as is, and only the whole trimmed.
pub fn response_text(content: &[Value]) -> Option<String> {
    let text: String = content
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// The content blocks to keep in the history and the text to show, or why there are none.
fn interpret(response: &Value) -> Result<(Vec<Value>, String), String> {
    // A policy decline comes back as HTTP 200 with stop_reason "refusal".
    if response.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        let why = response
            .pointer("/stop_details/explanation")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| t("Claude declined this one."));
        return Err(why);
    }
    let blocks = response
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| t("Unexpected API response."))?;
    let text = response_text(&blocks).ok_or_else(|| t("No response text."))?;
    Ok((blocks, text))
}

/// One chat turn. Returns the assistant's text, or a message the island shows
/// in the note view.
pub async fn send(
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    // No key: Settings → Chat → Your AI subscriptions lets Claude Code answer
    // instead (cli_relay.rs); chat.rs sends the turn there before it gets here.
    let Some(key) = secrets::get(KEY) else {
        return Err(t("API key missing. Open settings."));
    };
    let endpoint = endpoint()?;

    let turn = chat.begin(chat::ANTHROPIC);
    let user = json!({ "role": "user", "content": user_content(turn.first, context.as_ref(), &query) });
    let mut body = request_body(model, &chat::system_prompt(true), &turn.history, &user);

    let mut response = ask(&endpoint, &key, &mut body).await?;
    // A long search comes back paused: the same request with what Claude has
    // so far as its own turn picks up where it stopped. Nothing is added to it.
    let mut so_far: Vec<Value> = Vec::new();
    for _ in 0..MAX_RESUMES {
        let Some(blocks) = paused(&response) else { break };
        so_far.extend(blocks);
        let mut messages = turn.history.clone();
        messages.push(user.clone());
        messages.push(json!({ "role": "assistant", "content": so_far }));
        body["messages"] = Value::Array(messages);
        response = ask(&endpoint, &key, &mut body).await?;
    }
    let (blocks, text) = interpret(&join_resumed(so_far, response))?;

    // Store the whole content — tool_use / tool_result blocks included — so the
    // next turn has the right context.
    let plain = chat::plain_question(turn.first, context.as_ref(), &query);
    chat.commit(&turn, user, json!({ "role": "assistant", "content": blocks }), &plain, &text);
    Ok(ChatReply { text })
}

/// The whole answer of a turn that was resumed: what came before each pause,
/// then the last response's blocks, as one content array. The API reads two
/// assistant turns in a row as one, so this is what it saw.
fn join_resumed(mut so_far: Vec<Value>, mut response: Value) -> Value {
    if so_far.is_empty() {
        return response;
    }
    if let Some(last) = response.get("content").and_then(Value::as_array) {
        so_far.extend(last.iter().cloned());
    }
    response["content"] = Value::Array(so_far);
    response
}

/// One request. If the API refuses `fallbacks` itself, the same request goes
/// once more without it, and stays without it for the rest of the turn.
async fn ask(endpoint: &Url, key: &str, body: &mut Value) -> Result<Value, String> {
    match call(endpoint, key, body).await {
        Err(error) if body.get("fallbacks").is_some() && rejects_fallbacks(&error) => {
            if let Some(fields) = body.as_object_mut() {
                fields.remove("fallbacks");
            }
            call(endpoint, key, body).await
        }
        other => other,
    }
}

async fn call(endpoint: &Url, key: &str, body: &Value) -> Result<Value, String> {
    // Thinking and a few searches come before the first word of the answer.
    call_with_timeout(endpoint, key, body, Duration::from_secs(180)).await
}

async fn call_with_timeout(endpoint: &Url, key: &str, body: &Value, timeout: Duration) -> Result<Value, String> {
    let mut request = net::client(endpoint, timeout)?
        .post(endpoint.clone())
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json");
    // The beta is named only by a request that uses it.
    if body.get("fallbacks").is_some() {
        request = request.header("anthropic-beta", FALLBACK_BETA);
    }
    let response = request
        .json(body)
        .send()
        .await
        .map_err(|e| tf("Network error: {error}", &[("error", &e.to_string())]))?;

    let status = response.status();
    if !status.is_success() {
        // Surface the API's own message, which is what makes a bad key obvious.
        let body = net::read_capped(response, net::MAX_ERROR_BODY).await.unwrap_or_default();
        return Err(format!("Claude API {status}: {}", net::error_detail(&body)));
    }
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    serde_json::from_slice(&bytes).map_err(|e| tf("Bad API response: {error}", &[("error", &e.to_string())]))
}

/// The models on the user's Anthropic account, newest first, as the API lists them.
pub async fn available_models() -> Result<Vec<ModelInfo>, String> {
    let key = secrets::get(KEY).ok_or_else(|| t("No API key — add it in Settings."))?;
    models(&key).await
}

pub async fn models(key: &str) -> Result<Vec<ModelInfo>, String> {
    let url = models_endpoint(&endpoint()?);
    let response = net::client(&url, Duration::from_secs(10))?
        .get(url.clone())
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .send()
        .await
        .map_err(|e| tf("Network error: {error}", &[("error", &e.to_string())]))?;
    let status = response.status();
    if !status.is_success() {
        let body = net::read_capped(response, net::MAX_ERROR_BODY).await.unwrap_or_default();
        return Err(format!("Claude API {status}: {}", net::error_detail(&body)));
    }
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    let json: Value = serde_json::from_slice(&bytes).map_err(|_| t("Unexpected API response."))?;
    Ok(parse_models(&json))
}

fn parse_models(json: &Value) -> Vec<ModelInfo> {
    json.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_string();
            let label = m.get("display_name").and_then(Value::as_str).unwrap_or(&id).to_string();
            Some(ModelInfo { id, label })
        })
        .collect()
}

/// PDF → document block, image → image block, text/code → inline text.
/// Mirrors readFileAsBlock() in ClaudeService.swift.
fn file_block(path: &str) -> Option<Value> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let media_type = match ext.as_str() {
        "pdf" => Some(("document", "application/pdf")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "png" => Some(("image", "image/png")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        _ => None,
    };

    if let Some((block_type, media)) = media_type {
        let bytes = std::fs::read(path).ok()?;
        return Some(json!({
            "type": block_type,
            "source": { "type": "base64", "media_type": media, "data": base64(&bytes) },
        }));
    }

    let len = std::fs::metadata(path).ok()?.len();
    if len > MAX_INLINE_TEXT {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(json!({ "type": "text", "text": format!("File contents:\n{text}") }))
}

/// Small standalone base64 encoder — not worth another dependency.
/// Also used for Stripe's basic auth and the images sent to other providers.
pub(crate) fn base64_for(bytes: &[u8]) -> String {
    base64(bytes)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Uses the configured Claude API key for model discovery and one short synthetic request"]
    fn configured_api_lists_and_calls_sonnet_5_5() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let models = runtime.block_on(available_models()).unwrap_or_else(|_| panic!("Configured Claude API model discovery failed"));
        println!("Available Claude API models: {:?}", models.iter().map(|m| &m.id).collect::<Vec<_>>());
        assert!(models.iter().any(|m| m.id == "claude-sonnet-5-5"), "Sonnet 5.5 is not in this account's model list");
        let body = json!({
            "model": "claude-sonnet-5-5",
            "max_tokens": 256,
            "system": "Answer with the single word OK.",
            "messages": [{ "role": "user", "content": "This is a synthetic connection test." }],
        });
        let response = runtime.block_on(call(&endpoint().unwrap(), &secrets::get(KEY).unwrap(), &body))
            .unwrap_or_else(|_| panic!("Sonnet 5.5 synthetic request failed"));
        let (_, reply) = interpret(&response).unwrap_or_else(|_| panic!("Sonnet 5.5 synthetic request failed"));
        assert_eq!(reply.trim(), "OK");
        println!("Sonnet 5.5 returned the expected synthetic reply");
    }

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    fn texts(parts: &[&str]) -> Vec<Value> {
        parts.iter().map(|t| json!({ "type": "text", "text": t })).collect()
    }

    #[test]
    fn every_text_block_is_kept_in_order_without_added_separators() {
        assert_eq!(response_text(&texts(&["Simple answer."])).as_deref(), Some("Simple answer."));
        let content = vec![
            json!({"type":"text","text":"I'll look that up.\n"}),
            json!({"type":"server_tool_use","id":"srvtoolu_01","name":"web_search","input":{"query":"test"}}),
            json!({"type":"web_search_tool_result","tool_use_id":"srvtoolu_01","content":[]}),
            json!({"type":"text","text":"The answer is 42."}),
        ];
        assert_eq!(response_text(&content).as_deref(), Some("I'll look that up.\nThe answer is 42."));
        // An empty leading block does not hide the answer.
        let content = vec![
            json!({"type":"text","text":""}),
            json!({"type":"web_search_tool_result","tool_use_id":"b","content":[]}),
            json!({"type":"text","text":"Here is the actual answer."}),
        ];
        assert_eq!(response_text(&content).as_deref(), Some("Here is the actual answer."));
        // Citations split a sentence across blocks: no newline is inserted.
        assert_eq!(
            response_text(&texts(&["Paris is the ", "capital", " of France."])).as_deref(),
            Some("Paris is the capital of France.")
        );
        // Search result text never leaks into the answer.
        let content = vec![
            json!({"type":"text","text":"Answer."}),
            json!({"type":"web_search_tool_result","tool_use_id":"a","content":[{"type":"web_search_result","title":"Page","text":"Leak"}]}),
        ];
        assert_eq!(response_text(&content).as_deref(), Some("Answer."));
        assert_eq!(response_text(&[json!({"type":"server_tool_use","id":"x"})]), None);
        assert_eq!(response_text(&texts(&["", "  \n"])), None);
    }

    #[test]
    fn a_refusal_or_an_empty_answer_is_an_error() {
        let refusal = json!({"stop_reason":"refusal","stop_details":{"explanation":"Not this."},"content":[]});
        assert_eq!(interpret(&refusal).unwrap_err(), "Not this.");
        assert_eq!(interpret(&json!({"stop_reason":"refusal"})).unwrap_err(), "Claude declined this one.");
        assert_eq!(interpret(&json!({"id":"x"})).unwrap_err(), "Unexpected API response.");
        assert_eq!(interpret(&json!({"content":[]})).unwrap_err(), "No response text.");
        let (blocks, text) = interpret(&json!({"content":[{"type":"text","text":" Hi "}]})).unwrap();
        assert_eq!(text, "Hi");
        assert_eq!(blocks.len(), 1);
    }

    #[test]
    fn the_request_carries_history_web_search_and_the_new_turn_last() {
        let history = vec![json!({"role":"user","content":"a"}), json!({"role":"assistant","content":"b"})];
        let user = json!({"role":"user","content":[{"type":"text","text":"c"}]});
        let body = request_body("claude-x", "sys", &history, &user);
        assert_eq!(body["model"], "claude-x");
        assert_eq!(body["system"], "sys");
        assert_eq!(body["max_tokens"], MAX_TOKENS);
        assert_eq!(body["tools"][0]["name"], "web_search");
        assert_eq!(body["messages"].as_array().unwrap().len(), 3);
        assert_eq!(body["messages"][2], user);
        // Nothing the current models reject: thinking and sampling are left to them.
        for field in ["temperature", "top_p", "top_k", "thinking", "tool_choice"] {
            assert!(body.get(field).is_none(), "{field}");
        }
    }

    #[test]
    fn the_catalog_is_the_shared_file_and_starts_with_the_default() {
        let file: Value = serde_json::from_str(CATALOG).unwrap();
        assert_eq!(file["default"], DEFAULT_MODEL);
        let ids: Vec<String> = catalog().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"]);
        assert_eq!(ids[0], DEFAULT_MODEL);
        assert_eq!(catalog()[0].label, "Claude Opus 5.5");
    }

    #[test]
    fn a_fallback_is_asked_for_only_where_the_model_has_one() {
        let user = json!({"role":"user","content":"q"});
        for model in ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-opus-5"] {
            assert_eq!(request_body(model, "s", &[], &user)["fallbacks"], "default", "{model}");
        }
        for model in ["claude-haiku-5-5", "claude-haiku-4-5"] {
            assert!(request_body(model, "s", &[], &user).get("fallbacks").is_none(), "{model}");
        }
        assert!(rejects_fallbacks("Claude API 400 Bad Request: fallbacks: Extra inputs are not permitted"));
        assert!(rejects_fallbacks("Claude API 400 Bad Request: This model does not support server-side Fallback."));
        assert!(!rejects_fallbacks("Claude API 401 Unauthorized: invalid x-api-key"));
        assert!(!rejects_fallbacks("Claude API 400 Bad Request: max_tokens: too large"));
        assert!(!rejects_fallbacks("Network error: fallback dns"));
    }

    #[test]
    fn a_paused_turn_is_resumed_and_its_parts_joined_in_order() {
        let search = json!({"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{"query":"x"}});
        let pause = json!({"stop_reason":"pause_turn","content":[{"type":"text","text":"Looking. "}, search]});
        assert_eq!(paused(&pause).unwrap().len(), 2);
        assert!(paused(&json!({"stop_reason":"end_turn","content":[{"type":"text","text":"Done."}]})).is_none());
        // A pause with nothing in it cannot be resumed: it is read as it is.
        assert!(paused(&json!({"stop_reason":"pause_turn","content":[]})).is_none());

        let last = json!({"stop_reason":"end_turn","content":[
            {"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[]},
            {"type":"text","text":"Found it."}
        ]});
        let (blocks, text) = interpret(&join_resumed(paused(&pause).unwrap(), last.clone())).unwrap();
        assert_eq!(text, "Looking. Found it.");
        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[1], search);
        // A turn that never paused is left untouched.
        assert_eq!(join_resumed(Vec::new(), last.clone()), last);
    }

    /// A one-shot HTTP server on this machine: answers each connection with the
    /// next canned reply and hands back what it was sent.
    fn fake_api(replies: Vec<(u16, Value)>) -> (Url, std::thread::JoinHandle<Vec<(String, Value)>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://127.0.0.1:{}/v1/messages", listener.local_addr().unwrap().port())).unwrap();
        let server = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for (status, reply) in replies {
                let (mut stream, _) = listener.accept().unwrap();
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                let (head, body) = loop {
                    let n = stream.read(&mut buf).unwrap();
                    raw.extend_from_slice(&buf[..n]);
                    let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                    let head = String::from_utf8_lossy(&raw[..end]).to_lowercase();
                    let length: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .map(|v| v.trim().parse().unwrap())
                        .unwrap_or(0);
                    if raw.len() >= end + 4 + length {
                        break (head, serde_json::from_slice(&raw[end + 4..end + 4 + length]).unwrap());
                    }
                };
                seen.push((head, body));
                let text = reply.to_string();
                let reason = if status == 200 { "OK" } else { "Bad Request" };
                write!(stream, "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len()).unwrap();
            }
            seen
        });
        (url, server)
    }

    #[test]
    fn a_request_refused_for_its_fallback_goes_once_more_without_it() {
        let (url, server) = fake_api(vec![
            (400, json!({"type":"error","error":{"type":"invalid_request_error","message":"fallbacks: not supported for this model"}})),
            (200, json!({"stop_reason":"end_turn","content":[{"type":"text","text":"Hi"}]})),
        ]);
        let mut body = request_body("claude-older", "s", &[], &json!({"role":"user","content":"q"}));
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let response = runtime.block_on(ask(&url, "test-key", &mut body)).unwrap();
        assert_eq!(interpret(&response).unwrap().1, "Hi");

        let seen = server.join().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].1["fallbacks"], "default");
        assert!(seen[0].0.contains("anthropic-beta: server-side-fallback-2026-07-01"), "{}", seen[0].0);
        assert!(seen[1].1.get("fallbacks").is_none());
        assert!(!seen[1].0.contains("anthropic-beta"), "{}", seen[1].0);
        assert!(body.get("fallbacks").is_none());
        for (head, sent) in &seen {
            assert!(head.contains("anthropic-version: 2023-06-01"), "{head}");
            assert!(head.contains("x-api-key: test-key"), "{head}");
            assert_eq!(sent["max_tokens"], MAX_TOKENS);
        }
    }

    #[test]
    fn any_other_error_is_shown_as_the_api_says_it() {
        let (url, server) = fake_api(vec![(400, json!({"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: too large"}}))]);
        let mut body = request_body("claude-opus-5-5", "s", &[], &json!({"role":"user","content":"q"}));
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let error = runtime.block_on(ask(&url, "test-key", &mut body)).unwrap_err();
        assert!(error.starts_with("Claude API 400"), "{error}");
        assert!(error.contains("max_tokens: too large"), "{error}");
        assert_eq!(server.join().unwrap().len(), 1);
        assert_eq!(body["fallbacks"], "default");
    }

    #[test]
    fn context_is_sent_with_the_first_turn_only() {
        // A file that cannot be read still names itself.
        let ctx = ChatContext::File { name: "gone.pdf".into(), path: "/no/such/gone.pdf".into() };
        let first = user_content(true, Some(&ctx), "q");
        assert_eq!(first.len(), 2);
        assert_eq!(first[0]["text"], "File: gone.pdf");
        assert_eq!(user_content(false, Some(&ctx), "q"), vec![json!({"type":"text","text":"q"})]);
    }

    #[test]
    fn the_model_list_sits_next_to_the_messages_endpoint() {
        let url = Url::parse(DEFAULT_ENDPOINT).unwrap();
        assert_eq!(models_endpoint(&url).as_str(), "https://api.anthropic.com/v1/models?limit=100");
        let url = net::anthropic_endpoint("https://gw.example.com/anthropic").unwrap();
        assert_eq!(models_endpoint(&url).as_str(), "https://gw.example.com/anthropic/v1/models?limit=100");
        let list = json!({"data":[{"id":"claude-opus-5-5","display_name":"Claude Opus 5.5"},{"id":"claude-x"},{"nope":1}]});
        assert_eq!(
            parse_models(&list),
            vec![
                ModelInfo { id: "claude-opus-5-5".into(), label: "Claude Opus 5.5".into() },
                ModelInfo { id: "claude-x".into(), label: "claude-x".into() },
            ]
        );
    }
}
