//! The Notifications desk: things a person should see or act on (server invites, friend
//! requests, being added to a party, being removed from a server, …), plus @mentions of you
//! and replies to you in servers and parties, so you can go straight to them. Ordinary chat
//! messages and voicemail are not here: they have their own places. A mention counts as read
//! once you've read that chat past it (on any device), so it only needs seeing once.
//!
//! Each notification has a kind and a small JSON body the apps know how to show. It's
//! "read" once the person has opened it (or marked everything read) and can be cleared.
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            data TEXT NOT NULL DEFAULT '{}',
            -- what it's about, so a later change (accepted, joined) can update or clear it
            ref_id TEXT,
            created_at INTEGER NOT NULL,
            read_at INTEGER
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at)").execute(pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_notifications_ref ON notifications(ref_id)").execute(pool).await?;
    Ok(())
}

fn row_json(r: (String, String, String, Option<String>, i64, Option<i64>)) -> Value {
    let (id, kind, data, ref_id, created_at, read_at) = r;
    json!({
        "id": id, "kind": kind, "data": serde_json::from_str::<Value>(&data).unwrap_or(json!({})),
        "ref_id": ref_id, "created_at": created_at, "read_at": read_at,
    })
}

async fn load(state: &Shared, id: &str) -> Option<(String, Value)> {
    let r: Option<(String, String, String, String, Option<String>, i64, Option<i64>)> =
        sqlx::query_as("SELECT user_id, id, kind, data, ref_id, created_at, read_at FROM notifications WHERE id = ?").bind(id).fetch_optional(&state.db).await.ok()?;
    r.map(|(u, id, k, d, rf, c, rd)| (u, row_json((id, k, d, rf, c, rd))))
}

/// Give someone a notification (and tell their apps right away). Returns its id.
pub async fn notify(state: &Shared, user_id: &str, kind: &str, ref_id: Option<&str>, data: Value) -> Option<String> {
    let id = new_id();
    sqlx::query("INSERT INTO notifications (id, user_id, kind, data, ref_id, created_at) VALUES (?,?,?,?,?,?)")
        .bind(&id)
        .bind(user_id)
        .bind(kind)
        .bind(data.to_string())
        .bind(ref_id)
        .bind(now_ms())
        .execute(&state.db)
        .await
        .ok()?;
    if let Some((_, v)) = load(state, &id).await {
        state.hub.send_user(user_id, "NOTIFICATION_CREATE", &v);
    }
    Some(id)
}

/// Replace one person's notification about something (e.g. a repeated friend request).
pub async fn notify_once(state: &Shared, user_id: &str, kind: &str, ref_id: &str, data: Value) -> Option<String> {
    clear_ref(state, user_id, kind, ref_id).await;
    notify(state, user_id, kind, Some(ref_id), data).await
}

/// Remove a person's notifications of a kind about something (it's been dealt with).
pub async fn clear_ref(state: &Shared, user_id: &str, kind: &str, ref_id: &str) {
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM notifications WHERE user_id = ? AND kind = ? AND ref_id = ?")
        .bind(user_id)
        .bind(kind)
        .bind(ref_id)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
    if ids.is_empty() {
        return;
    }
    let _ = sqlx::query("DELETE FROM notifications WHERE user_id = ? AND kind = ? AND ref_id = ?").bind(user_id).bind(kind).bind(ref_id).execute(&state.db).await;
    state.hub.send_user(user_id, "NOTIFICATION_DELETE", &json!({ "ids": ids }));
}

/// Mark a person's notifications about something as read (e.g. they opened the invite card).
pub async fn read_ref(state: &Shared, user_id: &str, ref_id: &str) {
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM notifications WHERE user_id = ? AND ref_id = ? AND read_at IS NULL")
        .bind(user_id)
        .bind(ref_id)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
    if ids.is_empty() {
        return;
    }
    let now = now_ms();
    let _ = sqlx::query("UPDATE notifications SET read_at = ? WHERE user_id = ? AND ref_id = ? AND read_at IS NULL").bind(now).bind(user_id).bind(ref_id).execute(&state.db).await;
    state.hub.send_user(user_id, "NOTIFICATION_READ", &json!({ "ids": ids, "read_at": now }));
}

/// GET /api/notifications — the newest 200.
pub async fn list(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, String, Option<String>, i64, Option<i64>)> =
        sqlx::query_as("SELECT id, kind, data, ref_id, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200")
            .bind(&auth.id)
            .fetch_all(&state.db)
            .await?;
    Ok(Json(json!(rows.into_iter().map(row_json).collect::<Vec<_>>())))
}

#[derive(Deserialize)]
pub struct ReadReq {
    /// these ids; leave out to mark everything read
    #[serde(default)]
    pub ids: Option<Vec<String>>,
}

/// POST /api/notifications/read {ids?}
pub async fn mark_read(State(state): State<Shared>, auth: AuthUser, Json(req): Json<ReadReq>) -> ApiResult<Json<Value>> {
    let now = now_ms();
    let ids: Vec<String> = match req.ids {
        Some(ids) => {
            let mut out = vec![];
            for id in ids.into_iter().take(500) {
                let r = sqlx::query("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL").bind(now).bind(&id).bind(&auth.id).execute(&state.db).await?;
                if r.rows_affected() > 0 {
                    out.push(id);
                }
            }
            out
        }
        None => {
            let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM notifications WHERE user_id = ? AND read_at IS NULL").bind(&auth.id).fetch_all(&state.db).await?;
            sqlx::query("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").bind(now).bind(&auth.id).execute(&state.db).await?;
            ids
        }
    };
    if !ids.is_empty() {
        state.hub.send_user(&auth.id, "NOTIFICATION_READ", &json!({ "ids": ids, "read_at": now }));
    }
    Ok(Json(json!({ "ids": ids, "read_at": now })))
}

/// DELETE /api/notifications/{id}  ("all" clears every read one)
pub async fn remove(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let ids: Vec<String> = if id == "all" {
        sqlx::query_scalar("SELECT id FROM notifications WHERE user_id = ? AND read_at IS NOT NULL").bind(&auth.id).fetch_all(&state.db).await?
    } else {
        match load(&state, &id).await {
            Some((owner, _)) if owner == auth.id => vec![id],
            _ => return Err(AppError::not_found()),
        }
    };
    for i in &ids {
        sqlx::query("DELETE FROM notifications WHERE id = ? AND user_id = ?").bind(i).bind(&auth.id).execute(&state.db).await?;
    }
    if !ids.is_empty() {
        state.hub.send_user(&auth.id, "NOTIFICATION_DELETE", &json!({ "ids": ids }));
    }
    Ok(Json(json!({ "ids": ids })))
}

/// Who someone is, for a notification's text.
pub async fn who(state: &Shared, uid: &str) -> Value {
    match crate::models::get_user(&state.db, uid).await {
        Ok(u) => json!({ "id": u.id, "username": u.username, "display_name": u.display_name, "avatar_file_id": u.avatar_file_id }),
        Err(_) => json!({ "id": uid }),
    }
}

/// A server's name and icon, for a notification's text.
pub async fn guild_brief(state: &Shared, gid: &str) -> Value {
    let r: Option<(String, Option<String>)> = sqlx::query_as("SELECT name, icon_file_id FROM guilds WHERE id = ?").bind(gid).fetch_optional(&state.db).await.ok().flatten();
    match r {
        Some((name, icon)) => json!({ "id": gid, "name": name, "icon_file_id": icon }),
        None => json!({ "id": gid }),
    }
}

// ---------------------------------------------------------------- mentions and replies

/// A new message: notify the people it @mentions, and the person it replies to. Servers and
/// parties only (a DM is all for you anyway). Not the author, and only people who can see it.
pub async fn message_mentions(state: &Shared, ch: &crate::models::Channel, msg: &Value, author_id: &str, reply_author: Option<&str>) {
    if ch.kind == "dm" {
        return;
    }
    let content = msg["content"].as_str().unwrap_or_default();
    static MENTION: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| regex::Regex::new(r"<@([0-9a-z]+)>").unwrap());
    let mut who: Vec<(String, bool)> = vec![];
    for c in MENTION.captures_iter(content) {
        let u = c[1].to_string();
        if u != author_id && !who.iter().any(|(x, _)| x == &u) {
            who.push((u, false));
        }
    }
    if let Some(r) = reply_author.filter(|r| *r != author_id) {
        match who.iter_mut().find(|(x, _)| x == r) {
            Some(e) => e.1 = true,
            None => who.push((r.to_string(), true)),
        }
    }
    if who.is_empty() {
        return;
    }
    let from = who_brief(state, author_id).await;
    let guild = match &ch.guild_id {
        Some(g) => guild_brief(state, g).await,
        None => Value::Null,
    };
    // "<@id>" reads as "@name" in the preview
    let mut text = content.to_string();
    for c in MENTION.captures_iter(content) {
        let name: Option<String> = sqlx::query_scalar("SELECT display_name FROM users WHERE id = ?").bind(&c[1]).fetch_optional(&state.db).await.ok().flatten();
        text = text.replace(&c[0], &format!("@{}", name.unwrap_or_else(|| "someone".into())));
    }
    let mut preview: String = text.chars().take(140).collect();
    if preview.is_empty() {
        preview = msg["attachments"][0]["filename"].as_str().map(|f| format!("📎 {f}")).unwrap_or_default();
    }
    let mid = msg["id"].as_str().unwrap_or_default().to_string();
    for (uid, reply) in who {
        if crate::perms::require_channel(&state.db, ch, &uid, crate::perms::VIEW).await.is_err() {
            continue;
        }
        notify(state, &uid, "mention", Some(&mid), json!({
            "message_id": mid, "channel_id": ch.id, "channel_name": ch.name, "kind": ch.kind,
            "guild": guild, "from": from, "preview": preview, "reply": reply,
        })).await;
    }
}

async fn who_brief(state: &Shared, uid: &str) -> Value {
    who(state, uid).await
}

/// Read a chat up to here: its mentions of you up to that message are read too.
pub async fn read_mentions_upto(state: &Shared, user_id: &str, channel_id: &str, upto: &str) {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM notifications WHERE user_id = ? AND kind = 'mention' AND read_at IS NULL AND json_extract(data, '$.channel_id') = ? AND ref_id <= ?",
    )
    .bind(user_id)
    .bind(channel_id)
    .bind(upto)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    if ids.is_empty() {
        return;
    }
    let now = now_ms();
    for id in &ids {
        let _ = sqlx::query("UPDATE notifications SET read_at = ? WHERE id = ?").bind(now).bind(id).execute(&state.db).await;
    }
    state.hub.send_user(user_id, "NOTIFICATION_READ", &json!({ "ids": ids, "read_at": now }));
}

/// A message was deleted: its mention notifications go too.
pub async fn forget_message(state: &Shared, message_id: &str) {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT id, user_id FROM notifications WHERE kind = 'mention' AND ref_id = ?").bind(message_id).fetch_all(&state.db).await.unwrap_or_default();
    if rows.is_empty() {
        return;
    }
    let _ = sqlx::query("DELETE FROM notifications WHERE kind = 'mention' AND ref_id = ?").bind(message_id).execute(&state.db).await;
    for (id, u) in rows {
        state.hub.send_user(&u, "NOTIFICATION_DELETE", &json!({ "ids": [id] }));
    }
}
