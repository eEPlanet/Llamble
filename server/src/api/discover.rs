//! How people find and get into servers, and invites to Llamble itself.
//!
//! Each server picks who can get in (`guilds.join_mode`):
//! - **open**: listed under Open servers; anyone can preview it and tap Join; any member can invite
//! - **preview**: listed; anyone can preview it; you request to join (or get a staff invite)
//! - **request**: listed (name, icon, description); no preview; request to join (or a staff invite)
//! - **invite**: not listed; staff invites only (the default)
//!
//! Requests go to the server's staff (people who can kick or manage the server) in their
//! Notifications; they approve or decline. After a decline you can ask again in 7 days.
//!
//! **Invite to Llamble**: any member (not kids) can make a one-time link that signs someone
//! up for this instance without adding them to a server, unless an instance admin turns that
//! off. The account remembers who invited it, for the Accounts page.
//!
//! **Add as friends**: an invite can carry "make us friends"; whoever uses it becomes the
//! inviter's friend right away (both chose it: one sent it, the other accepted it).
use crate::error::{invite_code, now_ms, ApiResult, AppError};
use crate::models::*;
use crate::perms;
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

pub const MODES: [&str; 4] = ["open", "preview", "request", "invite"];
const ASK_AGAIN_MS: i64 = 7 * 24 * 3600 * 1000;
const LLAMBLE_INVITE_MS: i64 = 7 * 24 * 3600 * 1000;
/// unused Invite to Llamble links one person can have at a time
const LLAMBLE_INVITE_MAX: i64 = 10;

pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    crate::db::add_column(pool, "guilds", "join_mode", "TEXT NOT NULL DEFAULT 'invite'").await?;
    crate::db::add_column(pool, "guilds", "description", "TEXT NOT NULL DEFAULT ''").await?;
    // when it was first listed (for the "something new" dot on Open servers)
    crate::db::add_column(pool, "guilds", "listed_at", "INTEGER").await?;
    crate::db::add_column(pool, "invites", "add_friend", "INTEGER NOT NULL DEFAULT 0").await?;
    crate::db::add_column(pool, "invite_cards", "add_friend", "INTEGER NOT NULL DEFAULT 0").await?;
    crate::db::add_column(pool, "users", "invited_by", "TEXT").await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS join_requests (
            guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            note TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,              -- 'pending' | 'declined'
            created_at INTEGER NOT NULL,
            decided_at INTEGER,
            PRIMARY KEY (guild_id, user_id)
        )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Server staff: can manage the server or kick people (owner and admins included).
pub fn is_staff(p: i64) -> bool {
    p & (perms::ADMINISTRATOR | perms::MANAGE_GUILD | perms::KICK) != 0
}

pub async fn join_mode(state: &Shared, gid: &str) -> String {
    sqlx::query_scalar("SELECT join_mode FROM guilds WHERE id = ?").bind(gid).fetch_optional(&state.db).await.ok().flatten().unwrap_or_else(|| "invite".into())
}

/// May this member send invites to the server? Open servers: anyone with Create invite.
/// Everything else: staff only.
pub async fn require_inviter(state: &Shared, gid: &str, uid: &str) -> ApiResult<()> {
    let p = perms::require_guild(&state.db, gid, uid, perms::VIEW).await?;
    let ok = if join_mode(state, gid).await == "open" { p & perms::CREATE_INVITE != 0 } else { is_staff(p) };
    if !ok {
        return Err(AppError::forbidden_msg("Only this server's staff can invite people."));
    }
    Ok(())
}

/// A chat in a server anyone can preview (open / preview, and not locked).
pub async fn previewable_channel(state: &Shared, ch: &Channel) -> bool {
    let Some(g) = &ch.guild_id else { return false };
    !ch.locked && ch.kind == "text" && matches!(join_mode(state, g).await.as_str(), "open" | "preview")
}

async fn is_member(state: &Shared, gid: &str, uid: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?").bind(gid).bind(uid).fetch_optional(&state.db).await.ok().flatten().is_some()
}

async fn is_banned(state: &Shared, gid: &str, uid: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM bans WHERE guild_id = ? AND user_id = ?").bind(gid).bind(uid).fetch_optional(&state.db).await.ok().flatten().is_some()
}

/// Make two people friends now (they both chose it through an invite). Kids still need a
/// parent's OK: then a parent is asked instead, as with any friend request.
pub async fn make_friends(state: &Shared, a: &str, b: &str) {
    if a == b {
        return;
    }
    if crate::api::social::is_friend(state, a, b).await {
        return;
    }
    if let Err(kid) = crate::kids::dm_allowed(state, a, b).await {
        let other = if kid == a { b } else { a };
        let _ = crate::kids::request(state, &kid, "dm", other).await;
        return;
    }
    let now = now_ms();
    for (x, y) in [(a, b), (b, a)] {
        let _ = sqlx::query("INSERT INTO friends (user_id, other_id, state, since) VALUES (?,?, 'friend', ?) ON CONFLICT(user_id, other_id) DO UPDATE SET state = 'friend', since = excluded.since")
            .bind(x)
            .bind(y)
            .bind(now)
            .execute(&state.db)
            .await;
        crate::api::notifications::clear_ref(state, x, "friend_request", y).await;
    }
    crate::api::social::tell_both(state, a, b).await;
}

/// After someone used a link invite: friends with the inviter, if the invite says so.
pub async fn after_invite(state: &Shared, code: &str, uid: &str) {
    let row: Option<(Option<String>, bool)> = sqlx::query_as("SELECT creator_id, add_friend FROM invites WHERE code = ?").bind(code.trim()).fetch_optional(&state.db).await.ok().flatten();
    if let Some((Some(creator), true)) = row {
        make_friends(state, &creator, uid).await;
    }
}

fn brief(id: &str, name: &str, icon: &Option<String>, desc: &str, mode: &str, count: i64) -> Value {
    json!({ "id": id, "name": name, "icon_file_id": icon, "description": desc, "join_mode": mode, "member_count": count })
}

#[derive(Deserialize)]
pub struct ListQ {
    #[serde(default)]
    pub q: String,
}

/// GET /api/discover?q= — servers that are listed, that you aren't in.
pub async fn list(State(state): State<Shared>, auth: AuthUser, Query(q): Query<ListQ>) -> ApiResult<Json<Value>> {
    let like = format!("%{}%", q.q.trim().replace('%', "").replace('_', ""));
    let rows: Vec<(String, String, Option<String>, String, String, Option<i64>, i64)> = sqlx::query_as(
        "SELECT g.id, g.name, g.icon_file_id, g.description, g.join_mode, g.listed_at,
                (SELECT COUNT(*) FROM members m WHERE m.guild_id = g.id) AS n
         FROM guilds g
         WHERE g.join_mode IN ('open','preview','request')
           AND NOT EXISTS (SELECT 1 FROM members m WHERE m.guild_id = g.id AND m.user_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.guild_id = g.id AND b.user_id = ?1)
           AND (g.name LIKE ?2 OR g.description LIKE ?2)
         ORDER BY n DESC, lower(g.name) LIMIT 500",
    )
    .bind(&auth.id)
    .bind(&like)
    .fetch_all(&state.db)
    .await?;
    let mut out = vec![];
    for (id, name, icon, desc, mode, listed, n) in rows {
        let mut v = brief(&id, &name, &icon, &desc, &mode, n);
        v["listed_at"] = json!(listed);
        v["request"] = request_state(&state, &id, &auth.id).await;
        out.push(v);
    }
    Ok(Json(json!({ "servers": out })))
}

/// Your request to a server: null, {"status":"pending"} or {"status":"declined","again_at":ms}.
async fn request_state(state: &Shared, gid: &str, uid: &str) -> Value {
    let r: Option<(String, Option<i64>)> = sqlx::query_as("SELECT status, decided_at FROM join_requests WHERE guild_id = ? AND user_id = ?").bind(gid).bind(uid).fetch_optional(&state.db).await.ok().flatten();
    match r {
        Some((s, d)) if s == "declined" => {
            let again = d.unwrap_or(0) + ASK_AGAIN_MS;
            if again <= now_ms() { Value::Null } else { json!({ "status": "declined", "again_at": again }) }
        }
        Some((s, _)) => json!({ "status": s }),
        None => Value::Null,
    }
}

async fn listed_guild(state: &Shared, gid: &str, uid: &str) -> ApiResult<(Value, String)> {
    let row: Option<(String, Option<String>, String, String)> = sqlx::query_as("SELECT name, icon_file_id, description, join_mode FROM guilds WHERE id = ?").bind(gid).fetch_optional(&state.db).await?;
    let (name, icon, desc, mode) = row.ok_or_else(AppError::not_found)?;
    if mode == "invite" || is_banned(state, gid, uid).await {
        return Err(AppError::not_found());
    }
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM members WHERE guild_id = ?").bind(gid).fetch_one(&state.db).await?;
    Ok((brief(gid, &name, &icon, &desc, &mode, n), mode))
}

/// GET /api/discover/{gid} — the server as a visitor sees it. Open / preview: its spaces
/// (read-only) and how many people are in each room. Request: just the name and description.
pub async fn preview(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>) -> ApiResult<Json<Value>> {
    let (mut g, mode) = listed_guild(&state, &gid, &auth.id).await?;
    g["request"] = request_state(&state, &gid, &auth.id).await;
    g["member"] = json!(is_member(&state, &gid, &auth.id).await);
    if mode == "request" {
        return Ok(Json(json!({ "guild": g, "channels": [] })));
    }
    let chans = sqlx::query_as::<_, Channel>(&format!("SELECT {CHANNEL_COLS} FROM channels c WHERE c.guild_id = ? ORDER BY c.position, c.created_at"))
        .bind(&gid)
        .fetch_all(&state.db)
        .await?;
    let mut out = vec![];
    for c in chans {
        if c.locked || !["text", "voice", "watch", "category"].contains(&c.kind.as_str()) {
            continue;
        }
        let here = state.hub.voice.iter().filter(|v| v.channel_id == c.id).count();
        out.push(json!({ "id": c.id, "kind": c.kind, "name": c.name, "topic": c.topic, "parent_id": c.parent_id, "position": c.position, "in_room": here }));
    }
    Ok(Json(json!({ "guild": g, "channels": out })))
}

#[derive(Deserialize)]
pub struct MsgQ {
    pub before: Option<String>,
}

/// GET /api/discover/{gid}/channels/{cid}/messages — read a chat before joining.
pub async fn preview_messages(State(state): State<Shared>, auth: AuthUser, Path((gid, cid)): Path<(String, String)>, Query(q): Query<MsgQ>) -> ApiResult<Json<Vec<Message>>> {
    listed_guild(&state, &gid, &auth.id).await?;
    let ch = load_channel(&state.db, &cid).await?;
    if ch.guild_id.as_deref() != Some(gid.as_str()) || !previewable_channel(&state, &ch).await {
        return Err(AppError::not_found());
    }
    let rows = sqlx::query_as::<_, MessageRow>(&format!("SELECT {MSG_COLS} FROM messages WHERE channel_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT 50"))
        .bind(&cid)
        .bind(&q.before)
        .bind(&q.before)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(hydrate_messages(&state.db, rows).await?))
}

/// POST /api/discover/{gid}/join — Open servers only.
pub async fn join(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>) -> ApiResult<Json<Value>> {
    let (_, mode) = listed_guild(&state, &gid, &auth.id).await?;
    if mode != "open" {
        return Err(AppError::forbidden_msg("This server takes requests to join."));
    }
    if !crate::kids::join_allowed(&state, &auth.id, &gid).await? {
        return Ok(Json(json!({ "guild_id": gid, "pending": true })));
    }
    crate::api::guilds::add_member(&state, &gid, &auth.id).await?;
    Ok(Json(json!({ "guild_id": gid })))
}

/// Everyone who can approve requests for a server.
async fn staff_of(state: &Shared, gid: &str) -> Vec<String> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT user_id FROM members WHERE guild_id = ?").bind(gid).fetch_all(&state.db).await.unwrap_or_default();
    let mut out = vec![];
    for u in ids {
        if let Ok(p) = perms::guild_perms(&state.db, gid, &u).await {
            if is_staff(p) {
                out.push(u);
            }
        }
    }
    out
}

fn req_ref(gid: &str, uid: &str) -> String {
    format!("{gid}:{uid}")
}

#[derive(Deserialize)]
pub struct AskReq {
    #[serde(default)]
    pub note: String,
}

/// POST /api/discover/{gid}/request {note}
pub async fn request(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, Json(req): Json<AskReq>) -> ApiResult<Json<Value>> {
    let (g, mode) = listed_guild(&state, &gid, &auth.id).await?;
    if mode == "open" {
        return Err(AppError::bad("this server is open: just join"));
    }
    if is_member(&state, &gid, &auth.id).await {
        return Err(AppError::bad("you're already in this server"));
    }
    match request_state(&state, &gid, &auth.id).await.get("status").and_then(|s| s.as_str()) {
        Some("pending") => return Ok(Json(json!({ "status": "pending" }))),
        Some("declined") => return Err(AppError::forbidden_msg("Your request was declined. You can ask again a week after that.")),
        _ => {}
    }
    let note: String = req.note.trim().chars().take(300).collect();
    sqlx::query("INSERT OR REPLACE INTO join_requests (guild_id, user_id, note, status, created_at) VALUES (?,?,?, 'pending', ?)")
        .bind(&gid)
        .bind(&auth.id)
        .bind(&note)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    let from = crate::api::notifications::who(&state, &auth.id).await;
    let r = req_ref(&gid, &auth.id);
    for s in staff_of(&state, &gid).await {
        crate::api::notifications::notify_once(&state, &s, "join_request", &r, json!({ "guild": g, "from": from, "note": note })).await;
    }
    Ok(Json(json!({ "status": "pending" })))
}

/// DELETE /api/discover/{gid}/request — take back your own request.
pub async fn cancel_request(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>) -> ApiResult<Json<Value>> {
    let r = sqlx::query("DELETE FROM join_requests WHERE guild_id = ? AND user_id = ? AND status = 'pending'").bind(&gid).bind(&auth.id).execute(&state.db).await?;
    if r.rows_affected() > 0 {
        let rf = req_ref(&gid, &auth.id);
        for s in staff_of(&state, &gid).await {
            crate::api::notifications::clear_ref(&state, &s, "join_request", &rf).await;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

async fn require_staff(state: &Shared, gid: &str, uid: &str) -> ApiResult<()> {
    let p = perms::require_guild(&state.db, gid, uid, perms::VIEW).await?;
    if !is_staff(p) {
        return Err(AppError::forbidden());
    }
    Ok(())
}

/// GET /api/guilds/{gid}/join-requests — staff.
pub async fn list_requests(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>) -> ApiResult<Json<Value>> {
    require_staff(&state, &gid, &auth.id).await?;
    let rows: Vec<(String, String, i64)> = sqlx::query_as("SELECT user_id, note, created_at FROM join_requests WHERE guild_id = ? AND status = 'pending' ORDER BY created_at").bind(&gid).fetch_all(&state.db).await?;
    let mut out = vec![];
    for (u, note, at) in rows {
        out.push(json!({ "user": crate::api::notifications::who(&state, &u).await, "note": note, "created_at": at }));
    }
    Ok(Json(json!(out)))
}

/// POST /api/guilds/{gid}/join-requests/{uid}/{approve|decline} — staff.
pub async fn decide(State(state): State<Shared>, auth: AuthUser, Path((gid, uid, what)): Path<(String, String, String)>) -> ApiResult<Json<Value>> {
    require_staff(&state, &gid, &auth.id).await?;
    let pending: Option<i64> = sqlx::query_scalar("SELECT 1 FROM join_requests WHERE guild_id = ? AND user_id = ? AND status = 'pending'").bind(&gid).bind(&uid).fetch_optional(&state.db).await?;
    let rf = req_ref(&gid, &uid);
    let staff = staff_of(&state, &gid).await;
    if pending.is_none() {
        for s in &staff {
            crate::api::notifications::clear_ref(&state, s, "join_request", &rf).await;
        }
        return Err(AppError::bad("that request was already handled"));
    }
    let guild = crate::api::notifications::guild_brief(&state, &gid).await;
    let mut pending_parent = false;
    match what.as_str() {
        "approve" => {
            sqlx::query("DELETE FROM join_requests WHERE guild_id = ? AND user_id = ?").bind(&gid).bind(&uid).execute(&state.db).await?;
            // kids: their parent still has to OK the server
            if crate::kids::join_allowed(&state, &uid, &gid).await? {
                crate::api::guilds::add_member(&state, &gid, &uid).await?;
            } else {
                pending_parent = true;
            }
            crate::api::notifications::notify_once(&state, &uid, "join_approved", &gid, json!({ "guild": guild, "pending_parent": pending_parent })).await;
        }
        "decline" => {
            sqlx::query("UPDATE join_requests SET status = 'declined', decided_at = ? WHERE guild_id = ? AND user_id = ?").bind(now_ms()).bind(&gid).bind(&uid).execute(&state.db).await?;
            crate::api::notifications::notify_once(&state, &uid, "join_declined", &gid, json!({ "guild": guild })).await;
        }
        _ => return Err(AppError::bad("approve or decline")),
    }
    for s in &staff {
        crate::api::notifications::clear_ref(&state, s, "join_request", &rf).await;
    }
    Ok(Json(json!({ "ok": true, "pending_parent": pending_parent })))
}

// ------------------------------------------------------------------ Invite to Llamble

#[derive(Deserialize)]
pub struct LlambleInvite {
    #[serde(default)]
    pub add_friend: bool,
}

/// POST /api/invites/llamble {add_friend} — a one-time link to join this Llamble (no server).
pub async fn create_llamble_invite(State(state): State<Shared>, auth: AuthUser, Json(req): Json<LlambleInvite>) -> ApiResult<Json<Value>> {
    if auth.is_kid {
        return Err(AppError::forbidden_msg("Ask a parent to invite people."));
    }
    if !state.s().member_invites && !auth.is_admin {
        return Err(AppError::forbidden_msg("Only this Llamble's admins can invite people to it."));
    }
    let now = now_ms();
    let open: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invites WHERE creator_id = ? AND guild_id IS NULL AND grants_admin = 0 AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?)")
        .bind(&auth.id)
        .bind(now)
        .fetch_one(&state.db)
        .await?;
    if open >= LLAMBLE_INVITE_MAX && !auth.is_admin {
        return Err(AppError::bad("you have 10 unused invites already; wait for them to be used or expire"));
    }
    let code = invite_code();
    let exp = now + LLAMBLE_INVITE_MS;
    sqlx::query("INSERT INTO invites (code, guild_id, creator_id, max_uses, expires_at, grants_admin, created_at, add_friend) VALUES (?,NULL,?,1,?,0,?,?)")
        .bind(&code)
        .bind(&auth.id)
        .bind(exp)
        .bind(now)
        .bind(req.add_friend)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "code": code, "expires_at": exp, "max_uses": 1, "add_friend": req.add_friend })))
}

/// After sign-up: remember who invited them, tell the inviter, and friend them if asked.
pub async fn after_signup(state: &Shared, code: &str, uid: &str, guild_id: &Option<String>) {
    let creator: Option<String> = sqlx::query_scalar("SELECT creator_id FROM invites WHERE code = ?").bind(code.trim()).fetch_optional(&state.db).await.ok().flatten().flatten();
    let Some(creator) = creator else { return };
    let _ = sqlx::query("UPDATE users SET invited_by = ? WHERE id = ?").bind(&creator).bind(uid).execute(&state.db).await;
    after_invite(state, code, uid).await;
    if guild_id.is_none() {
        let by = crate::api::notifications::who(state, uid).await;
        crate::api::notifications::notify(state, &creator, "invite_accepted", Some(uid), json!({ "by": by, "guild": null })).await;
    }
}
