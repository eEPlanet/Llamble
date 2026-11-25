//! Watch Party spaces: a voice + chat space with one shared player and a queue.
//!
//! Anyone in the room can queue something: a YouTube video, a video or stream link, a movie
//! from the instance's movie library (instance staff fill it; self-hosted only), or a file
//! streamed live from their own device. Whoever queued what's playing controls it, and so
//! do people with the "Run watch party" permission; everyone else can vote to skip.
//! No screen share and no recording in these spaces.
//!
//! The server keeps the queue and "what's playing, from where, since when"; every app plays
//! it locally and lines itself up with that (YouTube, links and library), or watches the
//! streamer's live video (device).
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::models::{load_channel, Channel};
use crate::perms;
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    for q in [
        "CREATE TABLE IF NOT EXISTS watch_items (
            id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            added_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,          -- youtube | url | library | jellyfin | device
            src TEXT NOT NULL,           -- YouTube id, link, library file id, or streamer's user id
            title TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            done INTEGER NOT NULL DEFAULT 0
        )",
        "CREATE INDEX IF NOT EXISTS idx_watch_items_channel ON watch_items(channel_id, done, created_at)",
        "CREATE TABLE IF NOT EXISTS watch_now (
            channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            item_id TEXT NOT NULL,
            playing INTEGER NOT NULL DEFAULT 1,
            pos_ms INTEGER NOT NULL DEFAULT 0,
            at_ms INTEGER NOT NULL
        )",
        "CREATE TABLE IF NOT EXISTS watch_skip_votes (
            item_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            PRIMARY KEY (item_id, user_id)
        )",
        "CREATE TABLE IF NOT EXISTS watch_library (
            file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            added_by TEXT,
            created_at INTEGER NOT NULL
        )",
    ] {
        sqlx::query(q).execute(pool).await?;
    }
    // a poster and subtitles for uploaded movies (made from the video when it has them)
    crate::db::add_column(pool, "watch_library", "poster_file_id", "TEXT").await?;
    crate::db::add_column(pool, "watch_library", "subs_file_id", "TEXT").await?;
    Ok(())
}

/// A YouTube video id from a link (or the bare id).
pub fn youtube_id(s: &str) -> Option<String> {
    let s = s.trim();
    let ok = |id: &str| id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok(s) {
        return Some(s.to_string());
    }
    let u = url::Url::parse(s).ok()?;
    let host = u.host_str()?.trim_start_matches("www.").trim_start_matches("m.").to_string();
    let id = match host.as_str() {
        "youtu.be" => u.path_segments()?.next()?.to_string(),
        "youtube.com" | "music.youtube.com" | "youtube-nocookie.com" => {
            if let Some((_, v)) = u.query_pairs().find(|(k, _)| k == "v") {
                v.to_string()
            } else {
                let mut seg = u.path_segments()?;
                match seg.next()? {
                    "shorts" | "embed" | "live" | "v" => seg.next()?.to_string(),
                    _ => return None,
                }
            }
        }
        _ => return None,
    };
    ok(&id).then_some(id)
}

async fn watch_channel(state: &Shared, cid: &str, uid: &str) -> ApiResult<(Channel, i64)> {
    let ch = load_channel(&state.db, cid).await?;
    if ch.kind != "watch" {
        return Err(AppError::bad("not a Watch Party space"));
    }
    let p = perms::channel_perms(&state.db, &ch, uid).await?;
    if p & perms::VIEW == 0 {
        return Err(AppError::not_found());
    }
    if !perms::open_to(&ch, p) && !in_room(state, cid, uid) {
        return Err(AppError::forbidden_msg("This space is locked right now."));
    }
    if !state.s().watch_party {
        return Err(AppError::forbidden_msg("Watch Party is turned off on this Llamble"));
    }
    Ok((ch, p))
}

/// Kids need a parent's OK for Watch Party.
async fn kid_ok(state: &Shared, auth: &AuthUser) -> ApiResult<()> {
    if auth.is_kid && !crate::kids::settings(state, &auth.id).await.watch_party {
        return Err(AppError::forbidden_msg("Ask a parent to turn on Watch Party for you."));
    }
    Ok(())
}

pub async fn kid_may_join(state: &Shared, auth: &AuthUser) -> ApiResult<()> {
    kid_ok(state, auth).await
}

fn in_room(state: &Shared, cid: &str, uid: &str) -> bool {
    state.hub.voice.get(uid).map(|v| v.channel_id == cid).unwrap_or(false)
}

fn room_people(state: &Shared, cid: &str) -> Vec<String> {
    state.hub.voice.iter().filter(|v| v.channel_id == cid).map(|v| v.user_id.clone()).collect()
}

// ---------------------------------------------------------------- late joiners held

/// Watch Party rooms → people who came in while something was playing: their mic is held
/// until it pauses or stops, or someone running it lets them talk.
static HELD: once_cell::sync::Lazy<dashmap::DashMap<String, std::collections::BTreeSet<String>>> = once_cell::sync::Lazy::new(Default::default);
/// …and the held people who asked to talk.
static ASKED: once_cell::sync::Lazy<dashmap::DashMap<String, std::collections::BTreeSet<String>>> = once_cell::sync::Lazy::new(Default::default);

fn held_in(cid: &str) -> Vec<String> {
    HELD.get(cid).map(|s| s.iter().cloned().collect()).unwrap_or_default()
}

fn asked_in(cid: &str) -> Vec<String> {
    ASKED.get(cid).map(|s| s.iter().cloned().collect()).unwrap_or_default()
}

/// Someone is joining a Watch Party room: hold their mic if something is playing (unless
/// they run it, or what's playing is theirs). Returns whether they're held.
pub async fn hold_on_join(state: &Shared, cid: &str, uid: &str, p: i64) -> bool {
    if HELD.get(cid).map(|s| s.contains(uid)).unwrap_or(false) {
        return true; // rejoining doesn't get you out of it
    }
    let Some((iid, playing, ..)) = current(state, cid).await else { return false };
    if !playing || p & (perms::WATCH_RUN | perms::MANAGE_CHANNELS) != 0 {
        return false;
    }
    if item(state, &iid).await.map(|it| it.1 == uid).unwrap_or(false) {
        return false;
    }
    HELD.entry(cid.to_string()).or_default().insert(uid.to_string());
    true
}

fn talk_sources(state: &Shared, p: i64) -> Vec<&'static str> {
    let mut s = vec!["microphone"];
    if p & perms::VIDEO != 0 && state.s().watch_device_stream {
        s.extend(["screen_share", "screen_share_audio"]);
    }
    s
}

/// Give held people their mic back (everyone, or one person).
async fn release(state: &Shared, ch: &Channel, only: Option<&str>) {
    let who: Vec<String> = match only {
        Some(u) => {
            let had = HELD.get_mut(&ch.id).map(|mut s| s.remove(u)).unwrap_or(false);
            if had { vec![u.to_string()] } else { vec![] }
        }
        None => HELD.remove(&ch.id).map(|(_, s)| s.into_iter().collect()).unwrap_or_default(),
    };
    for u in &who {
        if let Some(mut s) = ASKED.get_mut(&ch.id) {
            s.remove(u);
        }
        let p = crate::perms::channel_perms(&state.db, ch, u).await.unwrap_or(0);
        crate::api::voice::set_sources(state, &ch.id, u, &talk_sources(state, p)).await;
        state.hub.send_user(u, "WATCH_TALK", &json!({ "channel_id": ch.id, "can_speak": p & perms::SPEAK != 0 }));
    }
}

fn item_json(r: &(String, String, String, String, String, i64)) -> Value {
    let (id, added_by, kind, src, title, created_at) = r;
    json!({ "id": id, "added_by": added_by, "kind": kind, "src": src, "title": title, "created_at": created_at })
}

async fn current(state: &Shared, cid: &str) -> Option<(String, bool, i64, i64)> {
    sqlx::query_as("SELECT item_id, playing, pos_ms, at_ms FROM watch_now WHERE channel_id = ?").bind(cid).fetch_optional(&state.db).await.ok().flatten()
}

async fn item(state: &Shared, id: &str) -> Option<(String, String, String, String, String, i64)> {
    sqlx::query_as("SELECT id, added_by, kind, src, title, created_at FROM watch_items WHERE id = ?").bind(id).fetch_optional(&state.db).await.ok().flatten()
}

async fn snapshot(state: &Shared, cid: &str, viewer: &str, p: i64) -> ApiResult<Value> {
    let queue: Vec<(String, String, String, String, String, i64)> =
        sqlx::query_as("SELECT id, added_by, kind, src, title, created_at FROM watch_items WHERE channel_id = ? AND done = 0 ORDER BY created_at").bind(cid).fetch_all(&state.db).await?;
    let now = match current(state, cid).await {
        Some((iid, playing, pos, at)) => match item(state, &iid).await {
            Some(it) => {
                let votes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM watch_skip_votes WHERE item_id = ?").bind(&iid).fetch_one(&state.db).await?;
                let mine: Option<i64> = sqlx::query_scalar("SELECT 1 FROM watch_skip_votes WHERE item_id = ? AND user_id = ?").bind(&iid).bind(viewer).fetch_optional(&state.db).await?;
                json!({ "item": item_json(&it), "playing": playing, "pos_ms": pos, "at_ms": at, "skip_votes": votes, "voted": mine.is_some() })
            }
            None => Value::Null,
        },
        None => Value::Null,
    };
    let s = state.s();
    Ok(json!({
        "channel_id": cid,
        "now": now,
        "queue": queue.iter().filter(|q| now["item"]["id"] != json!(q.0)).map(item_json).collect::<Vec<_>>(),
        "server_now": now_ms(),
        "in_room": room_people(state, cid).len(),
        "run": p & (perms::WATCH_RUN | perms::MANAGE_CHANNELS) != 0,
        "held": held_in(cid),
        "asked": asked_in(cid),
        "sources": { "library": s.watch_library, "device": s.watch_device_stream },
    }))
}

async fn changed(state: &Shared, ch: &Channel) {
    state.emit_channel(ch, "WATCH_UPDATE", &json!({ "channel_id": ch.id, "server_now": now_ms() })).await;
}

/// Start the next thing in the queue (or nothing).
async fn advance(state: &Shared, ch: &Channel) -> ApiResult<()> {
    if let Some((iid, ..)) = current(state, &ch.id).await {
        sqlx::query("UPDATE watch_items SET done = 1 WHERE id = ?").bind(&iid).execute(&state.db).await?;
        sqlx::query("DELETE FROM watch_skip_votes WHERE item_id = ?").bind(&iid).execute(&state.db).await?;
    }
    let next: Option<String> = sqlx::query_scalar("SELECT id FROM watch_items WHERE channel_id = ? AND done = 0 ORDER BY created_at LIMIT 1").bind(&ch.id).fetch_optional(&state.db).await?;
    // between videos (or at the end): everyone held may talk again
    release(state, ch, None).await;
    match next {
        Some(n) => {
            sqlx::query("INSERT OR REPLACE INTO watch_now (channel_id, item_id, playing, pos_ms, at_ms) VALUES (?,?,1,0,?)").bind(&ch.id).bind(&n).bind(now_ms()).execute(&state.db).await?;
        }
        None => {
            sqlx::query("DELETE FROM watch_now WHERE channel_id = ?").bind(&ch.id).execute(&state.db).await?;
        }
    }
    changed(state, ch).await;
    Ok(())
}

/// GET /api/channels/{cid}/watch
pub async fn get(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    let (_, p) = watch_channel(&state, &cid, &auth.id).await?;
    Ok(Json(snapshot(&state, &cid, &auth.id, p).await?))
}

#[derive(Deserialize)]
pub struct AddReq {
    pub kind: String,
    /// not needed for "device" (it's you)
    #[serde(default)]
    pub src: String,
    #[serde(default)]
    pub title: String,
}

/// POST /api/channels/{cid}/watch/queue {kind, src, title}
pub async fn add(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<AddReq>) -> ApiResult<Json<Value>> {
    let (ch, p) = watch_channel(&state, &cid, &auth.id).await?;
    kid_ok(&state, &auth).await?;
    if p & perms::CONNECT == 0 {
        return Err(AppError::forbidden());
    }
    let s = state.s();
    let title_in: String = req.title.trim().chars().filter(|c| !c.is_control()).take(120).collect();
    let (kind, src, title) = match req.kind.as_str() {
        "youtube" | "link" | "url" => {
            if let Some(id) = youtube_id(&req.src) {
                // the video's real title (from its page, cached like link previews)
                let title = if title_in.is_empty() {
                    let e = crate::api::embeds::unfurl_one(&state, &format!("https://www.youtube.com/watch?v={id}")).await;
                    e.and_then(|e| e["title"].as_str().map(|t| t.trim_end_matches(" - YouTube").to_string())).filter(|t| !t.is_empty()).unwrap_or_else(|| "YouTube video".to_string())
                } else {
                    title_in
                };
                ("youtube", id.clone(), title)
            } else {
                let u = url::Url::parse(req.src.trim()).map_err(|_| AppError::bad("that isn't a link"))?;
                if !["http", "https"].contains(&u.scheme()) {
                    return Err(AppError::bad("links must start with http:// or https://"));
                }
                let host = u.host_str().unwrap_or("").trim_start_matches("www.").trim_start_matches("mobile.").to_string();
                if ["x.com", "twitter.com", "fixupx.com", "vxtwitter.com"].contains(&host.as_str()) {
                    return Err(AppError::bad("X (Twitter) videos can't play in a Watch Party: X doesn't let its videos play outside X. Use a YouTube link or a direct link to a video file."));
                }
                let name = u.path_segments().and_then(|s| s.last()).filter(|s| !s.is_empty()).unwrap_or(u.host_str().unwrap_or("Video")).to_string();
                // a web page isn't a video: say so now instead of queueing something that can't play
                let looks_like_file = name.rsplit_once('.').map(|(_, ext)| ["mp4", "m4v", "webm", "mov", "mkv", "m3u8", "ogv", "mp3", "m4a"].contains(&ext.to_lowercase().as_str())).unwrap_or(false);
                let mut title = title_in;
                if !looks_like_file {
                    if let Some(e) = crate::api::embeds::unfurl_one(&state, u.as_str()).await {
                        if e["type"] == "link" {
                            return Err(AppError::bad("That link is a web page, not a video. Paste a YouTube link or a direct link to a video file (like .mp4)."));
                        }
                        if title.is_empty() {
                            title = e["title"].as_str().unwrap_or("").to_string();
                        }
                    }
                }
                ("url", u.to_string(), if title.is_empty() { name } else { title })
            }
        }
        "jellyfin" => {
            let t = crate::api::jellyfin::queue_title(&state, req.src.trim()).await?;
            ("jellyfin", req.src.trim().to_string(), t)
        }
        "library" => {
            if !s.watch_library {
                return Err(AppError::forbidden_msg("the movie library is turned off on this Llamble"));
            }
            let t: Option<String> = sqlx::query_scalar("SELECT title FROM watch_library WHERE file_id = ?").bind(req.src.trim()).fetch_optional(&state.db).await?;
            let t = t.ok_or_else(|| AppError::bad("that movie isn't in the library"))?;
            ("library", req.src.trim().to_string(), t)
        }
        "device" => {
            if !s.watch_device_stream {
                return Err(AppError::forbidden_msg("streaming from your device is turned off on this Llamble"));
            }
            if p & perms::VIDEO == 0 {
                return Err(AppError::forbidden());
            }
            if !in_room(&state, &cid, &auth.id) {
                return Err(AppError::bad("join the room first, then stream from your device"));
            }
            ("device", auth.id.clone(), if title_in.is_empty() { "A video from my device".to_string() } else { title_in })
        }
        _ => return Err(AppError::bad("kind must be youtube, url, library, jellyfin or device")),
    };
    let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM watch_items WHERE channel_id = ? AND done = 0").bind(&cid).fetch_one(&state.db).await?;
    if queued >= 100 {
        return Err(AppError::bad("the queue is full (100)"));
    }
    let id = new_id();
    let title: String = title.chars().take(120).collect();
    sqlx::query("INSERT INTO watch_items (id, channel_id, added_by, kind, src, title, created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(&id)
        .bind(&cid)
        .bind(&auth.id)
        .bind(kind)
        .bind(&src)
        .bind(&title)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    if current(&state, &cid).await.is_none() {
        sqlx::query("INSERT OR REPLACE INTO watch_now (channel_id, item_id, playing, pos_ms, at_ms) VALUES (?,?,1,0,?)").bind(&cid).bind(&id).bind(now_ms()).execute(&state.db).await?;
    }
    changed(&state, &ch).await;
    Ok(Json(snapshot(&state, &cid, &auth.id, p).await?))
}

/// May `uid` run what's playing (or remove `item_added_by`'s item)?
fn runs(p: i64, uid: &str, added_by: &str) -> bool {
    uid == added_by || p & (perms::WATCH_RUN | perms::MANAGE_CHANNELS) != 0
}

/// DELETE /api/channels/{cid}/watch/queue/{iid}
pub async fn remove(State(state): State<Shared>, auth: AuthUser, Path((cid, iid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let (ch, p) = watch_channel(&state, &cid, &auth.id).await?;
    let it = item(&state, &iid).await.ok_or_else(AppError::not_found)?;
    if !runs(p, &auth.id, &it.1) {
        return Err(AppError::forbidden_msg("only the person who added it (or someone who runs the watch party) can remove it"));
    }
    let playing = current(&state, &cid).await.map(|c| c.0 == iid).unwrap_or(false);
    if playing {
        advance(&state, &ch).await?;
    } else {
        sqlx::query("UPDATE watch_items SET done = 1 WHERE id = ? AND channel_id = ?").bind(&iid).bind(&cid).execute(&state.db).await?;
        changed(&state, &ch).await;
    }
    Ok(Json(snapshot(&state, &cid, &auth.id, p).await?))
}

#[derive(Deserialize)]
pub struct ControlReq {
    /// play | pause | seek | next | ended
    pub action: String,
    #[serde(default)]
    pub pos_ms: Option<i64>,
    /// for "ended": which item finished (ignored if something else is playing by now)
    #[serde(default)]
    pub item_id: Option<String>,
}

/// POST /api/channels/{cid}/watch/control
pub async fn control(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<ControlReq>) -> ApiResult<Json<Value>> {
    let (ch, p) = watch_channel(&state, &cid, &auth.id).await?;
    let Some((iid, playing, pos, at)) = current(&state, &cid).await else {
        return Ok(Json(snapshot(&state, &cid, &auth.id, p).await?));
    };
    if req.action == "ended" {
        // any viewer's player may report the end; only counts for what's still playing
        if req.item_id.as_deref() == Some(iid.as_str()) {
            advance(&state, &ch).await?;
        }
        return Ok(Json(snapshot(&state, &cid, &auth.id, p).await?));
    }
    let it = item(&state, &iid).await.ok_or_else(AppError::not_found)?;
    if !runs(p, &auth.id, &it.1) {
        return Err(AppError::forbidden_msg("only whoever queued this (or someone who runs the watch party) can control it; you can vote to skip"));
    }
    let now = now_ms();
    let here = if playing { pos + (now - at) } else { pos };
    match req.action.as_str() {
        "play" => {
            sqlx::query("UPDATE watch_now SET playing = 1, pos_ms = ?, at_ms = ? WHERE channel_id = ?").bind(req.pos_ms.unwrap_or(here).max(0)).bind(now).bind(&cid).execute(&state.db).await?;
        }
        "pause" => {
            sqlx::query("UPDATE watch_now SET playing = 0, pos_ms = ?, at_ms = ? WHERE channel_id = ?").bind(req.pos_ms.unwrap_or(here).max(0)).bind(now).bind(&cid).execute(&state.db).await?;
            // an intermission: everyone held may talk
            release(&state, &ch, None).await;
        }
        "seek" => {
            let to = req.pos_ms.ok_or_else(|| AppError::bad("give pos_ms"))?.max(0);
            sqlx::query("UPDATE watch_now SET pos_ms = ?, at_ms = ? WHERE channel_id = ?").bind(to).bind(now).bind(&cid).execute(&state.db).await?;
        }
        "next" => {
            advance(&state, &ch).await?;
            return Ok(Json(snapshot(&state, &cid, &auth.id, p).await?));
        }
        _ => return Err(AppError::bad("action must be play, pause, seek, next or ended")),
    }
    changed(&state, &ch).await;
    Ok(Json(snapshot(&state, &cid, &auth.id, p).await?))
}

/// POST /api/channels/{cid}/watch/skip — vote to skip; more than half the room skips it.
pub async fn vote_skip(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    let (ch, p) = watch_channel(&state, &cid, &auth.id).await?;
    if !in_room(&state, &cid, &auth.id) {
        return Err(AppError::bad("join the room to vote"));
    }
    let Some((iid, ..)) = current(&state, &cid).await else { return Err(AppError::bad("nothing is playing")) };
    sqlx::query("INSERT OR IGNORE INTO watch_skip_votes (item_id, user_id) VALUES (?,?)").bind(&iid).bind(&auth.id).execute(&state.db).await?;
    let people = room_people(&state, &cid);
    let votes: Vec<String> = sqlx::query_scalar("SELECT user_id FROM watch_skip_votes WHERE item_id = ?").bind(&iid).fetch_all(&state.db).await?;
    let counted = votes.iter().filter(|v| people.contains(v)).count();
    if counted * 2 > people.len() {
        advance(&state, &ch).await?;
    } else {
        changed(&state, &ch).await;
    }
    Ok(Json(snapshot(&state, &cid, &auth.id, p).await?))
}

/// Someone left a Watch Party room: a live stream from their device ends with them.
pub async fn left_room(state: &Shared, cid: &str, uid: &str) {
    let Ok(ch) = load_channel(&state.db, cid).await else { return };
    if ch.kind != "watch" {
        return;
    }
    if let Some(mut s) = HELD.get_mut(cid) {
        s.remove(uid);
    }
    if let Some(mut s) = ASKED.get_mut(cid) {
        s.remove(uid);
    }
    // their device streams waiting in the queue can't play either
    let _ = sqlx::query("UPDATE watch_items SET done = 1 WHERE channel_id = ? AND kind = 'device' AND src = ? AND done = 0").bind(cid).bind(uid).execute(&state.db).await;
    if let Some((iid, ..)) = current(state, cid).await {
        if let Some(it) = item(state, &iid).await {
            if it.2 == "device" && it.3 == uid {
                let _ = advance(state, &ch).await;
                return;
            }
        }
    }
    // the last one out: hold the movie's place until someone comes back
    if room_people(state, cid).is_empty() {
        if let Some((_, true, pos, at)) = current(state, cid).await {
            let now = crate::error::now_ms();
            let here = (pos + (now - at)).max(0);
            let _ = sqlx::query("UPDATE watch_now SET playing = 0, pos_ms = ?, at_ms = ? WHERE channel_id = ?").bind(here).bind(now).bind(cid).execute(&state.db).await;
            EMPTY_HOLD.insert(cid.to_string());
        }
    }
    changed(state, &ch).await;
}

/// Watch rooms whose movie was stopped because everyone left (not paused by anyone).
static EMPTY_HOLD: once_cell::sync::Lazy<dashmap::DashSet<String>> = once_cell::sync::Lazy::new(Default::default);

/// Someone joined a Watch room: if its movie stopped because everyone had left, it carries on
/// from where it was.
pub async fn someone_came_back(state: &Shared, cid: &str) {
    if EMPTY_HOLD.remove(cid).is_none() {
        return;
    }
    let Ok(ch) = load_channel(&state.db, cid).await else { return };
    if current(state, cid).await.map(|c| !c.1).unwrap_or(false) {
        let _ = sqlx::query("UPDATE watch_now SET playing = 1, at_ms = ? WHERE channel_id = ?").bind(crate::error::now_ms()).bind(cid).execute(&state.db).await;
        changed(state, &ch).await;
    }
}

/// POST /api/channels/{cid}/watch/ask-to-talk — a held guest asks.
pub async fn ask_to_talk(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    let (ch, p) = watch_channel(&state, &cid, &auth.id).await?;
    if !HELD.get(&cid).map(|s| s.contains(&auth.id)).unwrap_or(false) {
        return Err(AppError::bad("you can already talk"));
    }
    ASKED.entry(cid.clone()).or_default().insert(auth.id.clone());
    changed(&state, &ch).await;
    Ok(Json(snapshot(&state, &cid, &auth.id, p).await?))
}

/// POST /api/channels/{cid}/watch/let-talk/{uid} — whoever runs what's playing (or staff)
/// gives someone their mic back; "all" for everyone.
pub async fn let_talk(State(state): State<Shared>, auth: AuthUser, Path((cid, uid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let (ch, p) = watch_channel(&state, &cid, &auth.id).await?;
    let runs_now = match current(&state, &cid).await {
        Some((iid, ..)) => item(&state, &iid).await.map(|it| runs(p, &auth.id, &it.1)).unwrap_or(false),
        None => p & (perms::WATCH_RUN | perms::MANAGE_CHANNELS) != 0,
    };
    if !runs_now {
        return Err(AppError::forbidden_msg("only whoever is running what's playing (or staff) can let people talk"));
    }
    release(&state, &ch, if uid == "all" { None } else { Some(uid.as_str()) }).await;
    changed(&state, &ch).await;
    Ok(Json(snapshot(&state, &cid, &auth.id, p).await?))
}

// ---------------------------------------------------------------- movie library

/// GET /api/watch/library — the instance's movies (anyone signed in, when it's on).
pub async fn library(State(state): State<Shared>, _auth: AuthUser) -> ApiResult<Json<Value>> {
    if !state.s().watch_library {
        return Ok(Json(json!({ "on": false, "movies": [] })));
    }
    let rows: Vec<(String, String, i64, Option<i64>, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT l.file_id, l.title, l.created_at, f.size, f.mime, l.poster_file_id, l.subs_file_id FROM watch_library l JOIN files f ON f.id = l.file_id ORDER BY lower(l.title)",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({
        "on": true,
        "jellyfin": crate::api::watch::jellyfin_on(&state),
        "movies": rows.into_iter().map(|(id, t, c, size, mime, poster, subs)| json!({ "file_id": id, "title": t, "created_at": c, "size": size, "mime": mime, "poster_file_id": poster, "subs_file_id": subs })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct LibAdd {
    pub file_id: String,
    pub title: String,
}

fn staff(auth: &AuthUser) -> ApiResult<()> {
    if !auth.is_admin {
        return Err(AppError::forbidden_msg("only instance staff can change the movie library"));
    }
    Ok(())
}

/// POST /api/watch/library {file_id, title} — instance staff add an uploaded video.
pub async fn library_add(State(state): State<Shared>, auth: AuthUser, Json(req): Json<LibAdd>) -> ApiResult<Json<Value>> {
    staff(&auth)?;
    if !state.s().watch_library {
        return Err(AppError::forbidden_msg("the movie library is turned off on this Llamble"));
    }
    let f = crate::models::get_file(&state.db, &req.file_id).await.map_err(|_| AppError::bad("upload the video first"))?;
    if !f.mime.starts_with("video/") {
        return Err(AppError::bad("that file isn't a video"));
    }
    let title: String = req.title.trim().chars().filter(|c| !c.is_control()).take(120).collect();
    let title = if title.is_empty() { f.filename.clone() } else { title };
    sqlx::query("INSERT OR REPLACE INTO watch_library (file_id, title, added_by, created_at) VALUES (?,?,?,?)").bind(&f.id).bind(&title).bind(&auth.id).bind(now_ms()).execute(&state.db).await?;
    tokio::spawn(auto_extras(state.clone(), f.id.clone(), auth.id.clone()));
    Ok(Json(json!({ "file_id": f.id, "title": title })))
}

pub fn jellyfin_on(state: &Shared) -> bool {
    let s = state.s();
    s.watch_library && !s.jellyfin_url.is_empty() && !s.jellyfin_key.is_empty() && !s.jellyfin_libraries.is_empty()
}

/// Pull out the first text subtitle track, if the video has one. Runs after a movie is
/// added. Posters are uploaded by staff.
async fn auto_extras(state: Shared, file_id: String, uploader: String) {
    let src = crate::api::files::file_path(&state, &file_id);
    let run = |args: Vec<String>| async move {
        tokio::time::timeout(std::time::Duration::from_secs(180), tokio::process::Command::new("ffmpeg").args(args).kill_on_drop(true).output()).await.ok().and_then(|r| r.ok())
    };
    let src_s = src.to_string_lossy().to_string();
    if let Some(o) = run(vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-i".into(), src_s, "-map".into(), "0:s:0".into(), "-f".into(), "webvtt".into(), "-".into()]).await {
        if o.status.success() && o.stdout.len() > 10 {
            if let Ok(sid) = crate::api::files::store_bytes(&state, &uploader, "subtitles.vtt", "text/vtt", &o.stdout).await {
                let _ = sqlx::query("UPDATE watch_library SET subs_file_id = ? WHERE file_id = ? AND subs_file_id IS NULL").bind(&sid).bind(&file_id).execute(&state.db).await;
            }
        }
    }
}

#[derive(Deserialize)]
pub struct LibEdit {
    #[serde(default)]
    pub title: Option<String>,
    /// an uploaded picture
    #[serde(default)]
    pub poster_file_id: Option<String>,
    /// an uploaded .vtt or .srt file ("" removes the subtitles)
    #[serde(default)]
    pub subs_file_id: Option<String>,
}

/// PATCH /api/watch/library/{file_id} — staff set a movie's title, poster or subtitles.
pub async fn library_edit(State(state): State<Shared>, auth: AuthUser, Path(fid): Path<String>, Json(req): Json<LibEdit>) -> ApiResult<Json<Value>> {
    staff(&auth)?;
    if let Some(t) = req.title {
        let t: String = t.trim().chars().filter(|c| !c.is_control()).take(120).collect();
        if !t.is_empty() {
            sqlx::query("UPDATE watch_library SET title = ? WHERE file_id = ?").bind(&t).bind(&fid).execute(&state.db).await?;
        }
    }
    if let Some(p) = req.poster_file_id {
        let f = crate::models::get_file(&state.db, &p).await.map_err(|_| AppError::bad("upload the picture first"))?;
        if !f.mime.starts_with("image/") {
            return Err(AppError::bad("the poster must be a picture"));
        }
        sqlx::query("UPDATE watch_library SET poster_file_id = ? WHERE file_id = ?").bind(&p).bind(&fid).execute(&state.db).await?;
    }
    if let Some(sid) = req.subs_file_id {
        if sid.is_empty() {
            sqlx::query("UPDATE watch_library SET subs_file_id = NULL WHERE file_id = ?").bind(&fid).execute(&state.db).await?;
        } else {
            let f = crate::models::get_file(&state.db, &sid).await.map_err(|_| AppError::bad("upload the subtitles first"))?;
            // players read WebVTT; turn .srt (or anything ffmpeg reads) into it
            let path = crate::api::files::file_path(&state, &sid);
            let bytes = tokio::fs::read(&path).await.unwrap_or_default();
            let vtt = if bytes.starts_with(b"WEBVTT") || bytes.starts_with(b"\xEF\xBB\xBFWEBVTT") {
                sid.clone()
            } else {
                let o = tokio::process::Command::new("ffmpeg").args(["-hide_banner", "-loglevel", "error", "-i"]).arg(&path).args(["-f", "webvtt", "-"]).output().await.map_err(|_| AppError::bad("couldn't read those subtitles"))?;
                if !o.status.success() || o.stdout.len() < 7 {
                    return Err(AppError::bad(format!("couldn't read those subtitles ({})", f.filename)));
                }
                crate::api::files::store_bytes(&state, &auth.id, "subtitles.vtt", "text/vtt", &o.stdout).await.map_err(|e| AppError::bad(e.to_string()))?
            };
            sqlx::query("UPDATE watch_library SET subs_file_id = ? WHERE file_id = ?").bind(&vtt).bind(&fid).execute(&state.db).await?;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

/// May this person see a library movie's poster or subtitles?
pub async fn library_extra_ok(state: &Shared, file_id: &str) -> bool {
    state.s().watch_library
        && sqlx::query_scalar::<_, i64>("SELECT 1 FROM watch_library WHERE poster_file_id = ? OR subs_file_id = ?").bind(file_id).bind(file_id).fetch_optional(&state.db).await.ok().flatten().is_some()
}

/// DELETE /api/watch/library/{file_id}
pub async fn library_remove(State(state): State<Shared>, auth: AuthUser, Path(fid): Path<String>) -> ApiResult<Json<Value>> {
    staff(&auth)?;
    sqlx::query("DELETE FROM watch_library WHERE file_id = ?").bind(&fid).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

/// May this person watch a library file (needs to be in a guild, library on, file listed)?
pub async fn library_file_ok(state: &Shared, file_id: &str) -> bool {
    state.s().watch_library
        && sqlx::query_scalar::<_, i64>("SELECT 1 FROM watch_library WHERE file_id = ?").bind(file_id).fetch_optional(&state.db).await.ok().flatten().is_some()
}

#[cfg(test)]
mod tests {
    use super::youtube_id;
    #[test]
    fn yt() {
        for s in ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ?t=3", "https://m.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"] {
            assert_eq!(youtube_id(s).as_deref(), Some("dQw4w9WgXcQ"), "{s}");
        }
        assert_eq!(youtube_id("https://example.com/watch?v=dQw4w9WgXcQ"), None);
    }
}
