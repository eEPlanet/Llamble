//! Blocking and reporting.
//!
//! Block: you stop hearing from someone. They can't DM you, call or ring you, or send you a
//! friend request, and any friendship between you ends. In servers you share, the apps fold
//! their messages away ("Blocked message", tap to show). They aren't told.
//!
//! Report: a message or a person can be reported to the people who run things here: this
//! Llamble's admins, and for a server message also that server's owner. They get a
//! notification with a copy of what was reported (kept even if it's deleted later), and can
//! delete the message, ban the person from the server, or dismiss it. Removing an account is
//! the admin's Accounts page. Reports never leave this Llamble.
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::models::load_channel;
use crate::perms::{self, require_channel};
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS blocks (
            user_id TEXT NOT NULL,
            blocked_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, blocked_id)
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS reports (
            id TEXT PRIMARY KEY,
            reporter_id TEXT NOT NULL,
            user_id TEXT NOT NULL,          -- who's being reported
            message_id TEXT,                -- the message, when it's about one
            channel_id TEXT,
            guild_id TEXT,
            reason TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '',
            snapshot TEXT NOT NULL,         -- a copy of the message as it was
            status TEXT NOT NULL DEFAULT 'open', -- open | dismissed | deleted | banned
            handled_by TEXT,
            handled_at INTEGER,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Has either of these two blocked the other?
pub async fn blocked_either(state: &Shared, a: &str, b: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM blocks WHERE (user_id = ?1 AND blocked_id = ?2) OR (user_id = ?2 AND blocked_id = ?1) LIMIT 1")
        .bind(a)
        .bind(b)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// The ids this person has blocked (sent at sign-in so the apps can fold their messages away).
pub async fn my_blocks(state: &Shared, uid: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT blocked_id FROM blocks WHERE user_id = ? ORDER BY created_at").bind(uid).fetch_all(&state.db).await.unwrap_or_default()
}

async fn tell_blocks(state: &Shared, uid: &str) {
    let ids = my_blocks(state, uid).await;
    state.hub.send_user(uid, "BLOCKS_UPDATE", &json!({ "blocked": ids }));
}

/// GET /api/blocks: the people you've blocked.
pub async fn list_blocks(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, i64)> = sqlx::query_as("SELECT blocked_id, created_at FROM blocks WHERE user_id = ? ORDER BY created_at DESC").bind(&auth.id).fetch_all(&state.db).await?;
    let mut out = vec![];
    for (id, at) in rows {
        out.push(json!({ "user": crate::api::notifications::who(&state, &id).await, "created_at": at }));
    }
    Ok(Json(json!(out)))
}

/// PUT /api/blocks/{uid}
pub async fn block(State(state): State<Shared>, auth: AuthUser, Path(uid): Path<String>) -> ApiResult<Json<Value>> {
    if uid == auth.id {
        return Err(AppError::bad("you can't block yourself"));
    }
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM users WHERE id = ? AND is_bot = 0").bind(&uid).fetch_optional(&state.db).await?;
    if exists.is_none() || crate::demo::apart(&state, &auth.id, &uid) {
        return Err(AppError::not_found());
    }
    sqlx::query("INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?,?,?)").bind(&auth.id).bind(&uid).bind(now_ms()).execute(&state.db).await?;
    // a block ends any friendship or pending request between you
    let _ = crate::api::social::remove_friend(State(state.clone()), auth.clone(), Path(uid.clone())).await;
    tell_blocks(&state, &auth.id).await;
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/blocks/{uid}
pub async fn unblock(State(state): State<Shared>, auth: AuthUser, Path(uid): Path<String>) -> ApiResult<Json<Value>> {
    sqlx::query("DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?").bind(&auth.id).bind(&uid).execute(&state.db).await?;
    tell_blocks(&state, &auth.id).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ReportReq {
    pub user_id: Option<String>,
    pub message_id: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub note: String,
}

pub const REASONS: [&str; 6] = ["harassment", "hate", "sexual", "violence", "spam", "other"];

/// Who handles a report: this Llamble's admins, plus the server's owner for a server message.
async fn handlers(state: &Shared, guild_id: Option<&str>) -> Vec<String> {
    let mut ids: Vec<String> = sqlx::query_scalar("SELECT id FROM users WHERE is_admin = 1 AND is_bot = 0 AND demo = 0").fetch_all(&state.db).await.unwrap_or_default();
    if let Some(g) = guild_id {
        if let Ok(Some(o)) = sqlx::query_scalar::<_, String>("SELECT owner_id FROM guilds WHERE id = ?").bind(g).fetch_optional(&state.db).await {
            if !ids.contains(&o) && !crate::demo::is_demo(&o) {
                ids.push(o);
            }
        }
    }
    ids
}

/// POST /api/reports {user_id | message_id, reason, note}
pub async fn report(State(state): State<Shared>, auth: AuthUser, Json(req): Json<ReportReq>) -> ApiResult<Json<Value>> {
    if !REASONS.contains(&req.reason.as_str()) {
        return Err(AppError::bad("pick a reason"));
    }
    let note: String = req.note.trim().chars().filter(|c| !c.is_control() || *c == '\n').take(1000).collect();
    let recent: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reports WHERE reporter_id = ? AND created_at > ?").bind(&auth.id).bind(now_ms() - 3600 * 1000).fetch_one(&state.db).await?;
    if recent >= 20 {
        return Err(AppError::bad("that's a lot of reports in a short time; try again in a little while"));
    }
    let (user_id, message_id, channel_id, guild_id, snapshot) = match &req.message_id {
        Some(mid) => {
            let r: Option<(String, String, String, i64)> = sqlx::query_as("SELECT channel_id, author_id, content, created_at FROM messages WHERE id = ?").bind(mid).fetch_optional(&state.db).await?;
            let (cid, author, content, at) = r.ok_or_else(AppError::not_found)?;
            let ch = load_channel(&state.db, &cid).await?;
            require_channel(&state.db, &ch, &auth.id, perms::VIEW).await?;
            if author == auth.id {
                return Err(AppError::bad("that's your own message"));
            }
            let files: Vec<(String, String)> = sqlx::query_as("SELECT f.filename, f.mime FROM message_attachments ma JOIN files f ON f.id = ma.file_id WHERE ma.message_id = ?").bind(mid).fetch_all(&state.db).await.unwrap_or_default();
            let snap = json!({
                "content": content,
                "created_at": at,
                "files": files.into_iter().map(|(n, m)| json!({ "name": n, "mime": m })).collect::<Vec<_>>(),
                "channel_name": ch.name,
                "kind": ch.kind,
            });
            (author, Some(mid.clone()), Some(cid), ch.guild_id.clone(), snap)
        }
        None => {
            let uid = req.user_id.clone().ok_or_else(|| AppError::bad("say who or what you're reporting"))?;
            if uid == auth.id {
                return Err(AppError::bad("you can't report yourself"));
            }
            let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM users WHERE id = ?").bind(&uid).fetch_optional(&state.db).await?;
            if exists.is_none() || crate::demo::apart(&state, &auth.id, &uid) {
                return Err(AppError::not_found());
            }
            (uid, None, None, None, json!({}))
        }
    };
    let id = new_id();
    sqlx::query("INSERT INTO reports (id, reporter_id, user_id, message_id, channel_id, guild_id, reason, note, snapshot, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(&id).bind(&auth.id).bind(&user_id).bind(&message_id).bind(&channel_id).bind(&guild_id).bind(&req.reason).bind(&note).bind(snapshot.to_string()).bind(now_ms())
        .execute(&state.db).await?;
    let about = crate::api::notifications::who(&state, &user_id).await;
    let guild = match &guild_id {
        Some(g) => crate::api::notifications::guild_brief(&state, g).await,
        None => Value::Null,
    };
    let preview: String = snapshot["content"].as_str().unwrap_or_default().chars().take(140).collect();
    for h in handlers(&state, guild_id.as_deref()).await {
        if h == user_id {
            continue; // nobody handles a report about themselves
        }
        crate::api::notifications::notify(&state, &h, "report", Some(&id), json!({ "about": about, "reason": req.reason, "guild": guild, "preview": preview, "message": message_id.is_some() })).await;
    }
    Ok(Json(json!({ "ok": true, "id": id })))
}

/// May this person handle this report? Admins handle all; a server's owner handles its own.
async fn may_handle(state: &Shared, auth: &AuthUser, guild_id: Option<&str>, about: &str) -> bool {
    if about == auth.id {
        return false;
    }
    if auth.is_admin && !crate::demo::is_demo(&auth.id) {
        return true;
    }
    match guild_id {
        Some(g) => sqlx::query_scalar::<_, String>("SELECT owner_id FROM guilds WHERE id = ?").bind(g).fetch_optional(&state.db).await.ok().flatten().as_deref() == Some(auth.id.as_str()),
        None => false,
    }
}

type ReportRow = (String, String, String, Option<String>, Option<String>, Option<String>, String, String, String, String, Option<String>, Option<i64>, i64);
const REPORT_COLS: &str = "id, reporter_id, user_id, message_id, channel_id, guild_id, reason, note, snapshot, status, handled_by, handled_at, created_at";

async fn report_json(state: &Shared, r: &ReportRow) -> Value {
    let (id, reporter, user, mid, cid, gid, reason, note, snap, status, by, at, created) = r;
    let still_there = match mid {
        Some(m) => sqlx::query_scalar::<_, i64>("SELECT 1 FROM messages WHERE id = ?").bind(m).fetch_optional(&state.db).await.ok().flatten().is_some(),
        None => false,
    };
    json!({
        "id": id,
        "reporter": crate::api::notifications::who(state, reporter).await,
        "user": crate::api::notifications::who(state, user).await,
        "message_id": mid, "channel_id": cid,
        "guild": match gid { Some(g) => crate::api::notifications::guild_brief(state, g).await, None => Value::Null },
        "reason": reason, "note": note,
        "snapshot": serde_json::from_str::<Value>(snap).unwrap_or(Value::Null),
        "message_there": still_there,
        "status": status,
        "handled_by": match by { Some(b) => crate::api::notifications::who(state, b).await, None => Value::Null },
        "handled_at": at,
        "created_at": created,
    })
}

/// GET /api/reports: the reports this person handles, open ones first.
pub async fn list_reports(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let rows: Vec<ReportRow> = sqlx::query_as(&format!("SELECT {REPORT_COLS} FROM reports ORDER BY (status = 'open') DESC, created_at DESC LIMIT 500")).fetch_all(&state.db).await?;
    let mut out = vec![];
    for r in &rows {
        if may_handle(&state, &auth, r.5.as_deref(), &r.2).await {
            out.push(report_json(&state, r).await);
        }
        if out.len() >= 200 {
            break;
        }
    }
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
pub struct Resolve {
    pub action: String, // dismiss | delete | ban
}

/// POST /api/reports/{id}/resolve {action}
pub async fn resolve(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Json(req): Json<Resolve>) -> ApiResult<Json<Value>> {
    let r: ReportRow = sqlx::query_as(&format!("SELECT {REPORT_COLS} FROM reports WHERE id = ?")).bind(&id).fetch_optional(&state.db).await?.ok_or_else(AppError::not_found)?;
    if !may_handle(&state, &auth, r.5.as_deref(), &r.2).await {
        return Err(AppError::forbidden());
    }
    let status = match req.action.as_str() {
        "dismiss" => "dismissed",
        "delete" => {
            let mid = r.3.clone().ok_or_else(|| AppError::bad("this report isn't about a message"))?;
            if let Ok(Some(cid)) = sqlx::query_scalar::<_, String>("SELECT channel_id FROM messages WHERE id = ?").bind(&mid).fetch_optional(&state.db).await {
                crate::api::highlights::forget(&state, "message_id", &mid).await;
                crate::api::notifications::forget_message(&state, &mid).await;
                crate::api::forum::delete_thread(&state, &mid).await;
                sqlx::query("DELETE FROM messages WHERE id = ?").bind(&mid).execute(&state.db).await?;
                if let Ok(ch) = load_channel(&state.db, &cid).await {
                    state.emit_channel(&ch, "MESSAGE_DELETE", &json!({ "id": mid, "channel_id": ch.id })).await;
                }
            }
            "deleted"
        }
        "ban" => {
            let gid = r.5.clone().ok_or_else(|| AppError::bad("bans are for server messages; to remove an account, use Accounts"))?;
            let owner: String = sqlx::query_scalar("SELECT owner_id FROM guilds WHERE id = ?").bind(&gid).fetch_one(&state.db).await?;
            if r.2 == owner {
                return Err(AppError::bad("that's the server's owner; they can't be banned from their own server"));
            }
            sqlx::query("INSERT OR REPLACE INTO bans (guild_id, user_id, reason, created_at) VALUES (?,?,?,?)").bind(&gid).bind(&r.2).bind(format!("reported: {}", r.6)).bind(now_ms()).execute(&state.db).await?;
            let member: Option<i64> = sqlx::query_scalar("SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?").bind(&gid).bind(&r.2).fetch_optional(&state.db).await?;
            if member.is_some() {
                crate::api::guilds::remove_member_inner(&state, &gid, &r.2).await?;
            }
            "banned"
        }
        _ => return Err(AppError::bad("action must be dismiss, delete or ban")),
    };
    sqlx::query("UPDATE reports SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?").bind(status).bind(&auth.id).bind(now_ms()).bind(&id).execute(&state.db).await?;
    // everyone who was told about it sees it's been dealt with
    let told: Vec<String> = sqlx::query_scalar("SELECT user_id FROM notifications WHERE kind = 'report' AND ref_id = ?").bind(&id).fetch_all(&state.db).await.unwrap_or_default();
    for u in told {
        crate::api::notifications::read_ref(&state, &u, &id).await;
    }
    let r: ReportRow = sqlx::query_as(&format!("SELECT {REPORT_COLS} FROM reports WHERE id = ?")).bind(&id).fetch_one(&state.db).await?;
    let v = report_json(&state, &r).await;
    Ok(Json(json!({ "ok": true, "status": status, "report": v })))
}
