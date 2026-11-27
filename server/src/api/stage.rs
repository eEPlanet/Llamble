//! Show spaces ("stage" spaces): a live show with a host, guests on stage and an audience.
//!
//! - **Roles:** the host runs it (and directs: what the audience sees); moderators manage
//!   raised hands and can mute; guests are on stage (mic, camera, screen); everyone else in the
//!   room is the audience, who watch, chat, react and raise a hand. Server staff (Manage Spaces)
//!   can always host. Roles are kept per space.
//! - **Off air / live:** before going live only the host, moderators and guests can be in the
//!   room (to set up and test); the audience sees "Starting soon" and the next scheduled show.
//! - **Hands:** listed in the order they were raised; the host or a moderator brings someone up
//!   (their voice pass changes live: mic, camera, screen), sends them back, mutes them, lowers
//!   everyone's hands or turns hands off.
//! - **The director's choices** (layout, who's on the main shot, follow whoever talks) go out
//!   to everyone in STAGE_UPDATE, and every app draws the stage that way. Only people on stage
//!   send video, so the audience pulls just the few streams on stage.
//! - **Scheduled shows:** a title, a time and a description. People mark **Interested** and get
//!   reminders in Notifications (a day before, 15 minutes before) and a "live now" ping. People
//!   can **follow** a show space to hear about new shows and when it goes live.
//! - **Who can watch:** "members" (anyone who can see the space). "tickets" is reserved for
//!   ticket holders once the store sells them (not built).
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::models::{load_channel, Channel};
use crate::perms::{self, require_channel};
use crate::state::{channel_audience, AuthUser, Shared};
use axum::extract::{Path, State};
use axum::Json;
use dashmap::DashMap;
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Value};

/// Raised hands by space, in the order raised.
static HANDS: Lazy<DashMap<String, Vec<(String, i64)>>> = Lazy::new(DashMap::new);

pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    sqlx::raw_sql(
        r#"
CREATE TABLE IF NOT EXISTS stages (
    channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    live INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    live_since INTEGER,
    hands_open INTEGER NOT NULL DEFAULT 1,
    audience TEXT NOT NULL DEFAULT 'members',
    director TEXT NOT NULL DEFAULT '{}',
    event_id TEXT
);
CREATE TABLE IF NOT EXISTS stage_roles (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,                -- host | moderator | guest
    muted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS stage_events (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    starts_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',   -- scheduled | live | done | cancelled
    reminded_day INTEGER NOT NULL DEFAULT 0,
    reminded_soon INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stage_events ON stage_events(channel_id, starts_at);
-- Interested (things with a time: scheduled shows, later events) and Follow (hear about new ones)
CREATE TABLE IF NOT EXISTS interests (
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (kind, ref_id, user_id)
);
CREATE TABLE IF NOT EXISTS follows (
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (kind, ref_id, user_id)
);
"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------- who's who

async fn stage_channel(state: &Shared, cid: &str, uid: &str) -> ApiResult<(Channel, i64)> {
    let ch = load_channel(&state.db, cid).await?;
    if ch.kind != "stage" {
        return Err(AppError::bad("that isn't a show space"));
    }
    let p = require_channel(&state.db, &ch, uid, perms::VIEW).await?;
    Ok((ch, p))
}

async fn ensure(state: &Shared, cid: &str) {
    let _ = sqlx::query("INSERT OR IGNORE INTO stages (channel_id) VALUES (?)").bind(cid).execute(&state.db).await;
}

pub async fn role_of(state: &Shared, cid: &str, uid: &str) -> Option<(String, bool)> {
    sqlx::query_as::<_, (String, bool)>("SELECT role, muted FROM stage_roles WHERE channel_id = ? AND user_id = ?").bind(cid).bind(uid).fetch_optional(&state.db).await.ok().flatten()
}

fn staff(p: i64) -> bool {
    p & perms::MANAGE_CHANNELS != 0
}

/// May run the show (go live, direct, give roles): server staff or a host.
async fn runs(state: &Shared, cid: &str, uid: &str, p: i64) -> bool {
    staff(p) || matches!(role_of(state, cid, uid).await, Some((r, _)) if r == "host")
}

/// May manage hands and guests: those who run it, and moderators.
async fn manages(state: &Shared, cid: &str, uid: &str, p: i64) -> bool {
    runs(state, cid, uid, p).await || matches!(role_of(state, cid, uid).await, Some((r, _)) if r == "moderator")
}

async fn is_live(state: &Shared, cid: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT live FROM stages WHERE channel_id = ?").bind(cid).fetch_optional(&state.db).await.ok().flatten() == Some(1)
}

/// What a person may send in a show room's call: people on stage (hosts and guests) their
/// mic (unless muted), camera and screen; everyone else nothing. Server staff count as hosts.
pub async fn sources_for(state: &Shared, cid: &str, uid: &str, p: i64) -> Vec<&'static str> {
    let (on_stage, muted) = match role_of(state, cid, uid).await {
        Some((r, m)) if r == "host" || r == "guest" => (true, m),
        _ => (staff(p), false),
    };
    if !on_stage {
        return vec![];
    }
    let mut s = vec![];
    if p & perms::SPEAK != 0 && !muted {
        s.push("microphone");
    }
    if p & perms::VIDEO != 0 {
        s.extend(["camera", "screen_share", "screen_share_audio"]);
    }
    s
}

/// May this person come into the room now? Before the show is live: only the people who put
/// it on (staff, hosts, moderators, guests).
pub async fn may_join(state: &Shared, cid: &str, uid: &str, p: i64) -> ApiResult<()> {
    if is_live(state, cid).await || staff(p) || role_of(state, cid, uid).await.is_some() {
        return Ok(());
    }
    Err(AppError::forbidden_msg("This show isn't live yet."))
}

/// Apply someone's voice pass now (after their role changed), and tell their app.
async fn refresh_sources(state: &Shared, ch: &Channel, uid: &str) {
    let p = perms::channel_perms(&state.db, ch, uid).await.unwrap_or(0);
    let srcs = sources_for(state, &ch.id, uid, p).await;
    let in_room = state.hub.voice.get(uid).map(|v| v.channel_id == ch.id).unwrap_or(false);
    if in_room {
        crate::api::voice::set_sources(state, &ch.id, uid, &srcs).await;
    }
    let can_speak = srcs.contains(&"microphone");
    let can_video = srcs.contains(&"camera");
    state.hub.send_user(uid, "WATCH_TALK", &json!({ "channel_id": ch.id, "can_speak": can_speak, "can_video": can_video, "stage": true }));
}

// ---------------------------------------------------------------- the state everyone sees

async fn snapshot(state: &Shared, cid: &str) -> Value {
    ensure(state, cid).await;
    let (live, title, live_since, hands_open, audience, director, event_id): (i64, String, Option<i64>, i64, String, String, Option<String>) =
        sqlx::query_as("SELECT live, title, live_since, hands_open, audience, director, event_id FROM stages WHERE channel_id = ?")
            .bind(cid)
            .fetch_one(&state.db)
            .await
            .unwrap_or((0, String::new(), None, 1, "members".into(), "{}".into(), None));
    let roles: Vec<(String, String, bool)> = sqlx::query_as("SELECT user_id, role, muted FROM stage_roles WHERE channel_id = ? ORDER BY role, user_id").bind(cid).fetch_all(&state.db).await.unwrap_or_default();
    let hands: Vec<Value> = HANDS.get(cid).map(|h| h.iter().map(|(u, at)| json!({ "user_id": u, "at": at })).collect()).unwrap_or_default();
    let events: Vec<(String, String, String, i64, String)> = sqlx::query_as(
        "SELECT id, title, description, starts_at, status FROM stage_events WHERE channel_id = ? AND status IN ('scheduled','live') AND starts_at > ? ORDER BY starts_at LIMIT 10",
    )
    .bind(cid)
    .bind(now_ms() - 6 * 3600 * 1000)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let mut ev = vec![];
    for (id, t, d, at, st) in events {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM interests WHERE kind = 'show' AND ref_id = ?").bind(&id).fetch_one(&state.db).await.unwrap_or(0);
        ev.push(json!({ "id": id, "title": t, "description": d, "starts_at": at, "status": st, "interested": n }));
    }
    let watching = state.hub.voice.iter().filter(|v| v.channel_id == cid).count();
    json!({
        "channel_id": cid,
        "live": live == 1,
        "title": title,
        "live_since": live_since,
        "hands_open": hands_open == 1,
        "audience": audience,
        "director": serde_json::from_str::<Value>(&director).unwrap_or(json!({})),
        "event_id": event_id,
        "roles": roles.into_iter().map(|(u, r, m)| json!({ "user_id": u, "role": r, "muted": m })).collect::<Vec<_>>(),
        "hands": hands,
        "events": ev,
        "in_room": watching,
    })
}

async fn changed(state: &Shared, ch: &Channel) {
    let snap = snapshot(state, &ch.id).await;
    let ids = channel_audience(&state.db, ch).await;
    state.hub.send_users(&ids, "STAGE_UPDATE", &snap);
}

/// GET /api/channels/{cid}/stage: the show's state, plus what's yours (role, interested, following).
pub async fn get(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    let (_, p) = stage_channel(&state, &cid, &auth.id).await?;
    let mut v = snapshot(&state, &cid).await;
    let mine: Vec<String> = sqlx::query_scalar("SELECT i.ref_id FROM interests i JOIN stage_events e ON e.id = i.ref_id WHERE i.kind = 'show' AND i.user_id = ? AND e.channel_id = ?")
        .bind(&auth.id).bind(&cid).fetch_all(&state.db).await?;
    v["my_interested"] = json!(mine);
    v["following"] = json!(following(&state, "space", &cid, &auth.id).await);
    v["can_run"] = json!(runs(&state, &cid, &auth.id, p).await);
    v["can_manage"] = json!(manages(&state, &cid, &auth.id, p).await);
    Ok(Json(v))
}

/// The live shows this person can see (sign-in: for the LIVE marks and Right now).
pub async fn live_for(state: &Shared, uid: &str) -> Vec<Value> {
    let rows: Vec<(String, String, Option<i64>)> = sqlx::query_as("SELECT channel_id, title, live_since FROM stages WHERE live = 1").fetch_all(&state.db).await.unwrap_or_default();
    let mut out = vec![];
    for (cid, title, since) in rows {
        let Ok(ch) = load_channel(&state.db, &cid).await else { continue };
        if channel_audience(&state.db, &ch).await.iter().any(|u| u == uid) {
            out.push(json!({ "channel_id": cid, "guild_id": ch.guild_id, "title": title, "live_since": since }));
        }
    }
    out
}

// ---------------------------------------------------------------- going live

#[derive(Deserialize)]
pub struct LiveReq {
    #[serde(default)]
    pub title: String,
    /// which scheduled show this is (else the one closest to now, if any)
    pub event_id: Option<String>,
}

/// POST /api/channels/{cid}/stage/live: go live.
pub async fn go_live(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<LiveReq>) -> ApiResult<Json<Value>> {
    let (ch, p) = stage_channel(&state, &cid, &auth.id).await?;
    if !runs(&state, &cid, &auth.id, p).await {
        return Err(AppError::forbidden_msg("only the host or server staff can start the show"));
    }
    ensure(&state, &cid).await;
    if is_live(&state, &cid).await {
        return Err(AppError::bad("the show is already live"));
    }
    // which scheduled show this is: the one named, else one within two hours of now
    let event: Option<(String, String)> = match &req.event_id {
        Some(e) => sqlx::query_as("SELECT id, title FROM stage_events WHERE id = ? AND channel_id = ? AND status = 'scheduled'").bind(e).bind(&cid).fetch_optional(&state.db).await?,
        None => sqlx::query_as("SELECT id, title FROM stage_events WHERE channel_id = ? AND status = 'scheduled' AND starts_at BETWEEN ? AND ? ORDER BY abs(starts_at - ?) LIMIT 1")
            .bind(&cid).bind(now_ms() - 2 * 3600 * 1000).bind(now_ms() + 2 * 3600 * 1000).bind(now_ms())
            .fetch_optional(&state.db).await?,
    };
    let mut title: String = req.title.trim().chars().filter(|c| !c.is_control()).take(120).collect();
    if title.is_empty() {
        title = event.as_ref().map(|e| e.1.clone()).unwrap_or_else(|| ch.name.clone());
    }
    sqlx::query("UPDATE stages SET live = 1, title = ?, live_since = ?, event_id = ? WHERE channel_id = ?")
        .bind(&title).bind(now_ms()).bind(event.as_ref().map(|e| &e.0)).bind(&cid).execute(&state.db).await?;
    if let Some((eid, _)) = &event {
        sqlx::query("UPDATE stage_events SET status = 'live' WHERE id = ?").bind(eid).execute(&state.db).await?;
    }
    // whoever starts it is a host (on stage)
    if !matches!(role_of(&state, &cid, &auth.id).await, Some((r, _)) if r == "host") {
        sqlx::query("INSERT OR REPLACE INTO stage_roles (channel_id, user_id, role, muted) VALUES (?,?,'host',0)").bind(&cid).bind(&auth.id).execute(&state.db).await?;
        refresh_sources(&state, &ch, &auth.id).await;
    }
    // tell the people who wanted to know: interested in this show, and followers of the space
    let mut told: Vec<String> = vec![auth.id.clone()];
    let mut who: Vec<String> = vec![];
    if let Some((eid, _)) = &event {
        who.extend(sqlx::query_scalar::<_, String>("SELECT user_id FROM interests WHERE kind = 'show' AND ref_id = ?").bind(eid).fetch_all(&state.db).await?);
    }
    who.extend(sqlx::query_scalar::<_, String>("SELECT user_id FROM follows WHERE kind = 'space' AND ref_id = ?").bind(&cid).fetch_all(&state.db).await?);
    let audience = channel_audience(&state.db, &ch).await;
    let guild = match &ch.guild_id {
        Some(g) => crate::api::notifications::guild_brief(&state, g).await,
        None => Value::Null,
    };
    for u in who {
        if told.contains(&u) || !audience.contains(&u) {
            continue;
        }
        told.push(u.clone());
        crate::api::notifications::notify(&state, &u, "show_live", Some(&cid), json!({ "channel_id": cid, "channel_name": ch.name, "title": title, "guild": guild })).await;
    }
    changed(&state, &ch).await;
    Ok(Json(snapshot(&state, &cid).await))
}

/// POST /api/channels/{cid}/stage/end: end the show (guests leave the stage, hands go down).
pub async fn end(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    let (ch, p) = stage_channel(&state, &cid, &auth.id).await?;
    if !runs(&state, &cid, &auth.id, p).await {
        return Err(AppError::forbidden_msg("only the host or server staff can end the show"));
    }
    let event: Option<String> = sqlx::query_scalar("SELECT event_id FROM stages WHERE channel_id = ?").bind(&cid).fetch_optional(&state.db).await?.flatten();
    if let Some(e) = event {
        sqlx::query("UPDATE stage_events SET status = 'done' WHERE id = ?").bind(e).execute(&state.db).await?;
    }
    sqlx::query("UPDATE stages SET live = 0, live_since = NULL, event_id = NULL WHERE channel_id = ?").bind(&cid).execute(&state.db).await?;
    let guests: Vec<String> = sqlx::query_scalar("SELECT user_id FROM stage_roles WHERE channel_id = ? AND role = 'guest'").bind(&cid).fetch_all(&state.db).await?;
    sqlx::query("DELETE FROM stage_roles WHERE channel_id = ? AND role = 'guest'").bind(&cid).execute(&state.db).await?;
    for g in guests {
        refresh_sources(&state, &ch, &g).await;
    }
    HANDS.remove(&cid);
    // the audience goes home; the people who put it on can stay to wrap up
    let in_room: Vec<String> = state.hub.voice.iter().filter(|v| v.channel_id == cid).map(|v| v.user_id.clone()).collect();
    for u in in_room {
        let up = perms::channel_perms(&state.db, &ch, &u).await.unwrap_or(0);
        if !staff(up) && role_of(&state, &cid, &u).await.is_none() {
            state.hub.send_user(&u, "STAGE_ENDED", &json!({ "channel_id": cid }));
        }
    }
    changed(&state, &ch).await;
    Ok(Json(snapshot(&state, &cid).await))
}

// ---------------------------------------------------------------- hands and guests

#[derive(Deserialize)]
pub struct HandReq {
    pub up: bool,
}

/// POST /api/channels/{cid}/stage/hand {up}: raise or lower your hand.
pub async fn hand(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<HandReq>) -> ApiResult<Json<Value>> {
    let (ch, _) = stage_channel(&state, &cid, &auth.id).await?;
    if req.up {
        let in_room = state.hub.voice.get(&auth.id).map(|v| v.channel_id == cid).unwrap_or(false);
        if !in_room || !is_live(&state, &cid).await {
            return Err(AppError::bad("raise your hand while you're watching the show"));
        }
        let open: i64 = sqlx::query_scalar("SELECT hands_open FROM stages WHERE channel_id = ?").bind(&cid).fetch_one(&state.db).await?;
        if open == 0 {
            return Err(AppError::bad("hands are off for this show right now"));
        }
        if matches!(role_of(&state, &cid, &auth.id).await, Some((r, _)) if r == "host" || r == "guest") {
            return Err(AppError::bad("you're already on stage"));
        }
        let mut h = HANDS.entry(cid.clone()).or_default();
        if !h.iter().any(|(u, _)| u == &auth.id) {
            h.push((auth.id.clone(), now_ms()));
        }
    } else if let Some(mut h) = HANDS.get_mut(&cid) {
        h.retain(|(u, _)| u != &auth.id);
    }
    changed(&state, &ch).await;
    Ok(Json(json!({ "ok": true })))
}

fn lower(cid: &str, uid: &str) {
    if let Some(mut h) = HANDS.get_mut(cid) {
        h.retain(|(u, _)| u != uid);
    }
}

#[derive(Deserialize)]
pub struct HandsReq {
    pub open: Option<bool>,
    #[serde(default)]
    pub lower_all: bool,
}

/// POST /api/channels/{cid}/stage/hands {open?, lower_all?}: hands on/off, lower everyone's.
pub async fn hands(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<HandsReq>) -> ApiResult<Json<Value>> {
    let (ch, p) = stage_channel(&state, &cid, &auth.id).await?;
    if !manages(&state, &cid, &auth.id, p).await {
        return Err(AppError::forbidden());
    }
    ensure(&state, &cid).await;
    if let Some(o) = req.open {
        sqlx::query("UPDATE stages SET hands_open = ? WHERE channel_id = ?").bind(o).bind(&cid).execute(&state.db).await?;
        if !o {
            HANDS.remove(&cid);
        }
    }
    if req.lower_all {
        HANDS.remove(&cid);
    }
    changed(&state, &ch).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct PersonReq {
    pub user_id: String,
}

/// POST /api/channels/{cid}/stage/bring {user_id}: bring someone up on stage as a guest.
pub async fn bring(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<PersonReq>) -> ApiResult<Json<Value>> {
    let (ch, p) = stage_channel(&state, &cid, &auth.id).await?;
    if !manages(&state, &cid, &auth.id, p).await {
        return Err(AppError::forbidden());
    }
    let their = perms::channel_perms(&state.db, &ch, &req.user_id).await.unwrap_or(0);
    if their & perms::VIEW == 0 {
        return Err(AppError::not_found());
    }
    if matches!(role_of(&state, &cid, &req.user_id).await, Some((r, _)) if r == "host") {
        return Err(AppError::bad("they're already a host"));
    }
    sqlx::query("INSERT OR REPLACE INTO stage_roles (channel_id, user_id, role, muted) VALUES (?,?,'guest',0)").bind(&cid).bind(&req.user_id).execute(&state.db).await?;
    lower(&cid, &req.user_id);
    refresh_sources(&state, &ch, &req.user_id).await;
    state.hub.send_user(&req.user_id, "STAGE_ON", &json!({ "channel_id": cid, "by": auth.id }));
    changed(&state, &ch).await;
    Ok(Json(json!({ "ok": true })))
}

/// POST /api/channels/{cid}/stage/back {user_id}: send a guest back to the audience (a guest
/// can step down themself).
pub async fn send_back(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<PersonReq>) -> ApiResult<Json<Value>> {
    let (ch, p) = stage_channel(&state, &cid, &auth.id).await?;
    if req.user_id != auth.id && !manages(&state, &cid, &auth.id, p).await {
        return Err(AppError::forbidden());
    }
    sqlx::query("DELETE FROM stage_roles WHERE channel_id = ? AND user_id = ? AND role = 'guest'").bind(&cid).bind(&req.user_id).execute(&state.db).await?;
    refresh_sources(&state, &ch, &req.user_id).await;
    changed(&state, &ch).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct MuteReq {
    pub user_id: String,
    pub muted: bool,
}

/// POST /api/channels/{cid}/stage/mute {user_id, muted}: mute (or unmute) someone on stage.
pub async fn mute(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<MuteReq>) -> ApiResult<Json<Value>> {
    let (ch, p) = stage_channel(&state, &cid, &auth.id).await?;
    if !manages(&state, &cid, &auth.id, p).await {
        return Err(AppError::forbidden());
    }
    let r = sqlx::query("UPDATE stage_roles SET muted = ? WHERE channel_id = ? AND user_id = ? AND role IN ('host','guest')").bind(req.muted).bind(&cid).bind(&req.user_id).execute(&state.db).await?;
    if r.rows_affected() == 0 {
        return Err(AppError::bad("they aren't on stage"));
    }
    refresh_sources(&state, &ch, &req.user_id).await;
    changed(&state, &ch).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct RoleReq {
    pub user_id: String,
    /// host | moderator | none
    pub role: String,
}

/// POST /api/channels/{cid}/stage/role {user_id, role}: make someone a host or moderator (or
/// take it away). Server staff and hosts.
pub async fn set_role(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<RoleReq>) -> ApiResult<Json<Value>> {
    let (ch, p) = stage_channel(&state, &cid, &auth.id).await?;
    if !runs(&state, &cid, &auth.id, p).await {
        return Err(AppError::forbidden_msg("only the host or server staff can give show roles"));
    }
    let their = perms::channel_perms(&state.db, &ch, &req.user_id).await.unwrap_or(0);
    if their & perms::VIEW == 0 {
        return Err(AppError::not_found());
    }
    match req.role.as_str() {
        "host" | "moderator" => {
            sqlx::query("INSERT OR REPLACE INTO stage_roles (channel_id, user_id, role, muted) VALUES (?,?,?,0)").bind(&cid).bind(&req.user_id).bind(&req.role).execute(&state.db).await?;
        }
        "none" => {
            sqlx::query("DELETE FROM stage_roles WHERE channel_id = ? AND user_id = ?").bind(&cid).bind(&req.user_id).execute(&state.db).await?;
        }
        _ => return Err(AppError::bad("role must be host, moderator or none")),
    }
    lower(&cid, &req.user_id);
    refresh_sources(&state, &ch, &req.user_id).await;
    changed(&state, &ch).await;
    Ok(Json(json!({ "ok": true })))
}

/// POST /api/channels/{cid}/stage/director {...}: what the audience sees, the same settings the
/// recording director uses (every app paints the stage from them with the same scene engine):
/// - focus ("<uid>" camera or "screen:<uid>") and hold (the director's pick stays put)
/// - follow_talk: the main shot jumps to whoever talks
/// - layout: auto (main shot + pop-up windows) | screen (main shot + everyone's face) | grid
/// - pip (talker | talkers | off), pip_pos (tl | tr | bl | br), pip_size (s | m | l)
/// - title (bar at the top), lower_third {text, sub}, card (full-screen, e.g. "Be right back")
/// Only the fields sent change; send null to clear one.
pub async fn director(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<Value>) -> ApiResult<Json<Value>> {
    let (ch, p) = stage_channel(&state, &cid, &auth.id).await?;
    if !runs(&state, &cid, &auth.id, p).await {
        return Err(AppError::forbidden_msg("only the host directs the show"));
    }
    ensure(&state, &cid).await;
    let cur: String = sqlx::query_scalar("SELECT director FROM stages WHERE channel_id = ?").bind(&cid).fetch_one(&state.db).await?;
    let mut d: serde_json::Map<String, Value> = serde_json::from_str(&cur).unwrap_or_default();
    let text = |v: &Value, n: usize| -> Value {
        match v.as_str() {
            Some(s) if !s.trim().is_empty() => json!(s.trim().chars().filter(|c| !c.is_control()).take(n).collect::<String>()),
            _ => Value::Null,
        }
    };
    let pick = |v: &Value, ok: &[&str], def: &str| -> Value { json!(v.as_str().filter(|x| ok.contains(x)).unwrap_or(def)) };
    let Some(obj) = req.as_object() else { return Err(AppError::bad("send the director's settings")) };
    for (k, v) in obj {
        let val = match k.as_str() {
            "focus" => text(v, 64),
            "hold" | "follow_talk" => json!(v.as_bool().unwrap_or(false)),
            "layout" => pick(v, &["auto", "screen", "grid"], "auto"),
            "pip" => pick(v, &["talker", "talkers", "off"], "talker"),
            "pip_pos" => pick(v, &["tl", "tr", "bl", "br"], "br"),
            "pip_size" => pick(v, &["s", "m", "l"], "m"),
            "title" => text(v, 80),
            "card" => text(v, 80),
            "lower_third" => match text(&v["text"], 60) {
                Value::Null => Value::Null,
                t => json!({ "text": t, "sub": text(&v["sub"], 80) }),
            },
            _ => continue,
        };
        d.insert(k.clone(), val);
    }
    let d = Value::Object(d);
    sqlx::query("UPDATE stages SET director = ? WHERE channel_id = ?").bind(d.to_string()).bind(&cid).execute(&state.db).await?;
    changed(&state, &ch).await;
    Ok(Json(json!({ "ok": true, "director": d })))
}

/// Someone left the room: their raised hand goes down.
pub async fn left_room(state: &Shared, cid: &str, uid: &str) {
    if HANDS.get(cid).map(|h| h.iter().any(|(u, _)| u == uid)).unwrap_or(false) {
        lower(cid, uid);
        if let Ok(ch) = load_channel(&state.db, cid).await {
            changed(state, &ch).await;
        }
    }
}

// ---------------------------------------------------------------- scheduled shows

#[derive(Deserialize)]
pub struct EventReq {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub starts_at: i64,
}

/// POST /api/channels/{cid}/stage/events: schedule a show. Followers of the space hear about it.
pub async fn schedule(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<EventReq>) -> ApiResult<Json<Value>> {
    let (ch, p) = stage_channel(&state, &cid, &auth.id).await?;
    if !runs(&state, &cid, &auth.id, p).await {
        return Err(AppError::forbidden_msg("only the host or server staff can schedule shows"));
    }
    let title: String = req.title.trim().chars().filter(|c| !c.is_control()).take(120).collect();
    if title.is_empty() {
        return Err(AppError::bad("give the show a title"));
    }
    if req.starts_at < now_ms() - 60_000 || req.starts_at > now_ms() + 400 * 86_400_000 {
        return Err(AppError::bad("pick a time from now to about a year ahead"));
    }
    let id = new_id();
    let desc: String = req.description.trim().chars().take(2000).collect();
    sqlx::query("INSERT INTO stage_events (id, channel_id, title, description, starts_at, created_by, created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(&id).bind(&cid).bind(&title).bind(&desc).bind(req.starts_at).bind(&auth.id).bind(now_ms())
        .execute(&state.db).await?;
    // whoever scheduled it is interested in it
    sqlx::query("INSERT OR IGNORE INTO interests (kind, ref_id, user_id, created_at) VALUES ('show',?,?,?)").bind(&id).bind(&auth.id).bind(now_ms()).execute(&state.db).await?;
    let audience = channel_audience(&state.db, &ch).await;
    let guild = match &ch.guild_id {
        Some(g) => crate::api::notifications::guild_brief(&state, g).await,
        None => Value::Null,
    };
    let followers: Vec<String> = sqlx::query_scalar("SELECT user_id FROM follows WHERE kind = 'space' AND ref_id = ?").bind(&cid).fetch_all(&state.db).await?;
    for u in followers {
        if u != auth.id && audience.contains(&u) {
            crate::api::notifications::notify(&state, &u, "show_scheduled", Some(&id), json!({ "event_id": id, "channel_id": cid, "channel_name": ch.name, "title": title, "starts_at": req.starts_at, "guild": guild })).await;
        }
    }
    changed(&state, &ch).await;
    Ok(Json(json!({ "id": id })))
}

/// DELETE /api/stage-events/{id}: cancel a scheduled show (the interested are told).
pub async fn cancel(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (cid, title, status): (String, String, String) = sqlx::query_as("SELECT channel_id, title, status FROM stage_events WHERE id = ?").bind(&id).fetch_optional(&state.db).await?.ok_or_else(AppError::not_found)?;
    let (ch, p) = stage_channel(&state, &cid, &auth.id).await?;
    if !runs(&state, &cid, &auth.id, p).await {
        return Err(AppError::forbidden());
    }
    sqlx::query("UPDATE stage_events SET status = 'cancelled' WHERE id = ?").bind(&id).execute(&state.db).await?;
    if status == "scheduled" {
        let who: Vec<String> = sqlx::query_scalar("SELECT user_id FROM interests WHERE kind = 'show' AND ref_id = ?").bind(&id).fetch_all(&state.db).await?;
        for u in who {
            if u != auth.id {
                crate::api::notifications::notify(&state, &u, "show_cancelled", Some(&id), json!({ "event_id": id, "channel_id": cid, "channel_name": ch.name, "title": title })).await;
            }
        }
    }
    crate::api::notifications::forget_ref(&state, &id).await;
    changed(&state, &ch).await;
    Ok(Json(json!({ "ok": true })))
}

/// PUT / DELETE /api/stage-events/{id}/interested
pub async fn interested(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let cid: String = sqlx::query_scalar("SELECT channel_id FROM stage_events WHERE id = ? AND status IN ('scheduled','live')").bind(&id).fetch_optional(&state.db).await?.ok_or_else(AppError::not_found)?;
    let (ch, _) = stage_channel(&state, &cid, &auth.id).await?;
    sqlx::query("INSERT OR IGNORE INTO interests (kind, ref_id, user_id, created_at) VALUES ('show',?,?,?)").bind(&id).bind(&auth.id).bind(now_ms()).execute(&state.db).await?;
    changed(&state, &ch).await;
    Ok(Json(json!({ "interested": true })))
}
pub async fn not_interested(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    sqlx::query("DELETE FROM interests WHERE kind = 'show' AND ref_id = ? AND user_id = ?").bind(&id).bind(&auth.id).execute(&state.db).await?;
    if let Ok(Some(cid)) = sqlx::query_scalar::<_, String>("SELECT channel_id FROM stage_events WHERE id = ?").bind(&id).fetch_optional(&state.db).await {
        if let Ok(ch) = load_channel(&state.db, &cid).await {
            changed(&state, &ch).await;
        }
    }
    Ok(Json(json!({ "interested": false })))
}

async fn following(state: &Shared, kind: &str, id: &str, uid: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM follows WHERE kind = ? AND ref_id = ? AND user_id = ?").bind(kind).bind(id).bind(uid).fetch_optional(&state.db).await.ok().flatten().is_some()
}

/// PUT / DELETE /api/channels/{cid}/follow: follow a show space (new shows, going live).
pub async fn follow(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    stage_channel(&state, &cid, &auth.id).await?;
    sqlx::query("INSERT OR IGNORE INTO follows (kind, ref_id, user_id, created_at) VALUES ('space',?,?,?)").bind(&cid).bind(&auth.id).bind(now_ms()).execute(&state.db).await?;
    Ok(Json(json!({ "following": true })))
}
pub async fn unfollow(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    sqlx::query("DELETE FROM follows WHERE kind = 'space' AND ref_id = ? AND user_id = ?").bind(&cid).bind(&auth.id).execute(&state.db).await?;
    Ok(Json(json!({ "following": false })))
}

/// Reminders for scheduled shows: a day before (if it was scheduled further out than that) and
/// 15 minutes before, to everyone interested. Checked every minute.
pub fn spawn_reminders(state: Shared) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            remind(&state).await;
        }
    });
}

pub async fn remind(state: &Shared) {
    let now = now_ms();
    let rows: Vec<(String, String, String, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT id, channel_id, title, starts_at, created_at, reminded_day, reminded_soon FROM stage_events WHERE status = 'scheduled' AND starts_at BETWEEN ? AND ?",
    )
    .bind(now)
    .bind(now + 86_400_000)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    for (id, cid, title, at, created, day, soon) in rows {
        let which = if soon == 0 && at - now <= 15 * 60_000 {
            sqlx::query("UPDATE stage_events SET reminded_soon = 1, reminded_day = 1 WHERE id = ?").bind(&id).execute(&state.db).await.ok();
            Some("soon")
        } else if day == 0 && at - now > 15 * 60_000 {
            sqlx::query("UPDATE stage_events SET reminded_day = 1 WHERE id = ?").bind(&id).execute(&state.db).await.ok();
            // scheduled less than a day ahead: no "tomorrow" reminder, just the 15-minute one
            if at - created > 86_400_000 { Some("day") } else { None }
        } else {
            None
        };
        let Some(which) = which else { continue };
        let Ok(ch) = load_channel(&state.db, &cid).await else { continue };
        let audience = channel_audience(&state.db, &ch).await;
        let guild = match &ch.guild_id {
            Some(g) => crate::api::notifications::guild_brief(state, g).await,
            None => Value::Null,
        };
        let who: Vec<String> = sqlx::query_scalar("SELECT user_id FROM interests WHERE kind = 'show' AND ref_id = ?").bind(&id).fetch_all(&state.db).await.unwrap_or_default();
        for u in who {
            if audience.contains(&u) {
                crate::api::notifications::notify(state, &u, "show_reminder", Some(&id), json!({ "event_id": id, "channel_id": cid, "channel_name": ch.name, "title": title, "starts_at": at, "when": which, "guild": guild })).await;
            }
        }
    }
}
