//! Phone notifications without Google (or anyone else).
//!
//! The Android app runs a tiny listener that keeps one quiet connection to this server
//! (`GET /api/notify/stream`, a plain event stream) while Llamble isn't on screen. When
//! someone DMs or @mentions a person, a small notice goes down that connection: who, a
//! preview line, and which chat to open. Nothing else travels on it; between notices it
//! sends a few bytes every few minutes so phone networks don't cut it.
use crate::{models::Channel, state::{AuthUser, Shared}};
use axum::{
    response::sse::{Event, KeepAlive, Sse},
};
use dashmap::DashMap;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::{convert::Infallible, sync::atomic::{AtomicU64, Ordering}, time::Duration};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

static LISTENERS: Lazy<DashMap<String, Vec<(u64, UnboundedSender<String>)>>> = Lazy::new(Default::default);
static NEXT: AtomicU64 = AtomicU64::new(1);

/// Removes its listener when the connection ends.
struct Leave(String, u64);
impl Drop for Leave {
    fn drop(&mut self) {
        if let Some(mut v) = LISTENERS.get_mut(&self.0) {
            v.retain(|(i, _)| *i != self.1);
        }
        LISTENERS.remove_if(&self.0, |_, v| v.is_empty());
    }
}

pub async fn stream(auth: AuthUser) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let (tx, rx) = unbounded_channel::<String>();
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    LISTENERS.entry(auth.id.clone()).or_default().push((id, tx));
    let guard = Leave(auth.id.clone(), id);
    let hello = futures::stream::once(async { Ok(Event::default().event("hello").data("{}")) });
    let stopping = crate::gateway::SHUTDOWN.subscribe();
    let notices = futures::stream::unfold((rx, guard, stopping, false), |(mut rx, guard, mut stopping, done)| async move {
        if done {
            return None;
        }
        let got = tokio::select! {
            msg = rx.recv() => Some(msg),
            _ = async { let _ = stopping.wait_for(|s| *s).await; } => None,
        };
        match got {
            Some(msg) => Some((Ok(Event::default().event("notify").data(msg?)), (rx, guard, stopping, false))),
            // the server is stopping: say goodbye (with when to come back) and end the stream politely
            None => {
                use rand::Rng;
                let retry: u64 = rand::thread_rng().gen_range(10_000..40_000);
                Some((Ok(Event::default().event("bye").data(format!("{{\"retry_in_ms\":{retry}}}"))), (rx, guard, stopping, true)))
            }
        }
    });
    use futures::StreamExt;
    Sse::new(hello.chain(notices)).keep_alive(KeepAlive::new().interval(Duration::from_secs(180)).text("still here"))
}

fn send(user: &str, notice: &Value) {
    if let Some(v) = LISTENERS.get(user) {
        let s = notice.to_string();
        for (_, tx) in v.iter() {
            let _ = tx.send(s.clone());
        }
    }
}

/// A new message: tell the phones of whoever it's for (DMs, and @mentions of them,
/// @everyone or @here in a channel they can see). Never the author, never someone on
/// Do Not Disturb.
pub async fn message_created(state: &Shared, ch: &Channel, msg: &Value, author_id: &str) {
    if LISTENERS.is_empty() {
        return;
    }
    if msg["voice"]["urgent"].as_bool() == Some(true) {
        return; // urgent() alerts for it instead
    }
    let content = msg["content"].as_str().unwrap_or_default();
    let everyone = content.contains("@everyone") || content.contains("@here");
    let audience = crate::state::channel_audience(&state.db, ch).await;
    let author = msg["author"]["display_name"].as_str().or(msg["author"]["username"].as_str()).unwrap_or("Someone").to_string();
    let mut body: String = content.chars().take(180).collect();
    if body.is_empty() && msg["voice"].is_object() {
        body = if msg["voice"]["voicemail"].as_bool() == Some(true) { "📞 Left you a voicemail".into() } else { "🎤 Voice message".into() };
    }
    if body.is_empty() {
        body = msg["attachments"][0]["filename"].as_str().map(|f| format!("📎 {f}")).unwrap_or_else(|| "sent something".into());
    }
    let place = match &ch.guild_id {
        None => String::new(),
        Some(g) => {
            let gname: String = sqlx::query_scalar("SELECT name FROM guilds WHERE id = ?").bind(g).fetch_one(&state.db).await.unwrap_or_default();
            format!(" (#{}, {})", ch.name, gname)
        }
    };
    for uid in audience {
        if uid == author_id || !LISTENERS.contains_key(&uid) {
            continue;
        }
        if crate::gateway::STATUSES.get(&uid).map(|s| s.as_str() == "dnd").unwrap_or(false) {
            continue;
        }
        let for_them = ch.guild_id.is_none() || content.contains(&format!("<@{uid}>")) || everyone;
        if !for_them {
            continue;
        }
        if ch.guild_id.is_some() && crate::perms::require_channel(&state.db, ch, &uid, crate::perms::VIEW).await.is_err() {
            continue;
        }
        send(&uid, &json!({
            "tag": format!("m:{}", msg["id"].as_str().unwrap_or_default()),
            "title": format!("{author}{place}"),
            "body": body,
            "channel_id": ch.id,
            "guild_id": ch.guild_id,
        }));
    }
}

/// Someone is calling: the phone rings (full screen, with Answer / Decline) even with Llamble closed.
pub fn call(user: &str, channel_id: &str, ring_id: u64, caller: &str, party: Option<&str>, from: &str, guest: bool, urgent: bool) {
    send(user, &json!({
        "kind": "call",
        "from": from,
        "party": party,
        "guest": guest,
        "urgent": urgent,
        "tag": format!("call:{channel_id}"),
        "title": if urgent { format!("URGENT: {caller}") } else { caller.to_string() },
        "body": match (party, urgent) {
            (Some(p), true) => format!("Urgent call to {p}"),
            (Some(p), false) => format!("is calling {p}"),
            (None, true) => "Urgent call".to_string(),
            (None, false) => "is calling you".to_string(),
        },
        "channel_id": channel_id,
        "ring_id": ring_id,
    }));
}

/// The ring is over (answered somewhere, declined, cancelled or missed): stop ringing.
pub fn call_end(user: &str, channel_id: &str, ring_id: u64) {
    send(user, &json!({ "kind": "call_end", "tag": format!("call:{channel_id}"), "channel_id": channel_id, "ring_id": ring_id }));
}

/// An urgent voice message: every phone in the chat alerts like an emergency (loud, full screen,
/// ignores Llamble's own Do Not Disturb), until they open it or tap "Got it".
pub async fn urgent(state: &Shared, ch: &Channel, msg: &Value, author_id: &str) {
    let audience = crate::state::channel_audience(&state.db, ch).await;
    let author = msg["author"]["display_name"].as_str().or(msg["author"]["username"].as_str()).unwrap_or("Someone").to_string();
    let place = if ch.kind == "party" { format!(" to {}", ch.name) } else { String::new() };
    for uid in audience {
        if uid == author_id {
            continue;
        }
        send(&uid, &json!({
            "kind": "urgent",
            "tag": format!("urgent:{}", msg["id"].as_str().unwrap_or_default()),
            "title": format!("URGENT: {author}{place}"),
            "body": "Urgent voice message. Tap to listen.",
            "channel_id": ch.id,
            "message_id": msg["id"],
        }));
    }
}

/// They've heard it: stop alerting on their other devices.
pub fn urgent_done(user: &str, message_id: &str) {
    send(user, &json!({ "kind": "urgent_end", "tag": format!("urgent:{message_id}") }));
}
