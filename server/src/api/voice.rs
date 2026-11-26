//! Voice/video/screen share. Media flows through a self-hosted LiveKit SFU; this server
//! authorizes joins (mints short-lived LiveKit tokens) and tracks who is in which channel.
use crate::error::{ApiResult, AppError};
use crate::models::{get_user, load_channel};
use crate::perms::{self, require_channel};
use crate::state::{channel_audience, AuthUser, Shared, VoiceState};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

async fn mint_livekit_token(state: &Shared, room: &str, identity: &str, name: &str, sources: &[&str]) -> ApiResult<String> {
    let (key, secret) = crate::voice_server::credentials(state).await.ok_or_else(|| AppError::bad("voice not configured"))?;
    let now = chrono_now();
    let claims = json!({
        "iss": key,
        "sub": identity,
        "name": name,
        "nbf": now - 10,
        "exp": now + 6 * 3600,
        "video": {
            "room": room,
            "roomJoin": true,
            "canSubscribe": true,
            "canPublish": !sources.is_empty(),
            "canPublishData": true,
            // allowed everything (talk + video): no list, which also lets through tracks of
            // no particular kind, like a show's music player; otherwise only what's allowed
            "canPublishSources": if sources.len() >= 4 { &[][..] } else { sources },
        }
    });
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| anyhow::anyhow!(e).into())
}

fn chrono_now() -> i64 {
    crate::error::now_ms() / 1000
}

pub async fn broadcast_voice(state: &Shared, channel_id: &str, payload: Value) {
    if let Ok(ch) = load_channel(&state.db, channel_id).await {
        let mut ids = channel_audience(&state.db, &ch).await;
        ids.extend(call_guests(channel_id).into_iter().filter(|g| !ids.contains(g)).collect::<Vec<_>>());
        state.hub.send_users(&ids, "VOICE_STATE_UPDATE", &payload);
    }
}

pub async fn leave_voice(state: &Shared, user_id: &str) {
    if let Some((_, vs)) = state.hub.voice.remove(user_id) {
        ring_on_leave(state, &vs.channel_id, user_id).await;
        // last one out: Llamble forgets what was said in this call
        let empty = !state.hub.voice.iter().any(|v| v.channel_id == vs.channel_id);
        if empty {
            crate::voicebot::forget_channel(&vs.channel_id);
        }
        broadcast_voice(state, &vs.channel_id, json!({ "user_id": user_id, "channel_id": null, "guild_id": vs.guild_id })).await;
        crate::api::watch::left_room(state, &vs.channel_id, user_id).await;
        // the call is over: people added to it can't come back in
        if empty {

        }
    }
}

pub async fn join(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, headers: axum::http::HeaderMap) -> ApiResult<Json<Value>> {
    crate::kids::check_quiet(&state, &auth.id).await?;
    if !crate::voice_server::enabled(&state) {
        return Err(AppError::bad("voice isn't available on this server"));
    }
    crate::settings::learn_lan_ip(&state, &headers).await;
    // the built-in voice server may still be (re)starting, e.g. right after the server
    // learned its address or after an update: give it a moment instead of failing the call
    crate::voice_server::wait_ready(&state, std::time::Duration::from_secs(12)).await;
    let ch = load_channel(&state.db, &cid).await?;
    if !(ch.kind == "voice" || ch.kind == "dm" || ch.kind == "party" || ch.kind == "watch") {
        return Err(AppError::bad("that isn't a voice room"));
    }
    if ch.kind == "watch" {
        if !state.s().watch_party {
            return Err(AppError::forbidden_msg("Watch Party is turned off on this Llamble"));
        }
        crate::api::watch::kid_may_join(&state, &auth).await?;
    }
    // someone added to a DM or party call joins with talk + video, without seeing the chat
    let guest = ch.guild_id.is_none() && is_guest(&cid, &auth.id);
    // a locked room: only people already in it, and staff who can lock spaces, get in
    let already = state.hub.voice.get(&auth.id).map(|v| v.channel_id == cid).unwrap_or(false);
    let p = if guest {
        perms::SPEAK | perms::VIDEO
    } else {
        let p = perms::channel_perms(&state.db, &ch, &auth.id).await?;
        if p & perms::VIEW == 0 {
            return Err(AppError::not_found());
        }
        if !already && !perms::open_to(&ch, p) {
            return Err(AppError::forbidden_msg("This space is locked right now."));
        }
        if p & perms::CONNECT == 0 {
            return Err(AppError::forbidden());
        }
        p
    };
    // a Watch Party already playing: late joiners come in with their mic held (no barging in)
    let held = ch.kind == "watch" && p & perms::SPEAK != 0 && crate::api::watch::hold_on_join(&state, &cid, &auth.id, p).await;
    let mut sources = vec![];
    if p & perms::SPEAK != 0 && !held {
        sources.push("microphone");
    }
    if ch.kind == "watch" {
        // a Watch Party: talk, plus a video file streamed from your device (sent as a
        // "screen share" track; the app offers no real screen sharing or camera here)
        if p & perms::VIDEO != 0 && state.s().watch_device_stream {
            sources.extend(["screen_share", "screen_share_audio"]);
        }
    } else if p & perms::VIDEO != 0 {
        sources.extend(["camera", "screen_share", "screen_share_audio"]);
    }
    let user = get_user(&state.db, &auth.id).await?;
    let token = mint_livekit_token(&state, &cid, &auth.id, &user.display_name, &sources).await?;

    // moving between channels: announce leave from the old one
    if let Some(old) = state.hub.voice.get(&auth.id).map(|v| v.channel_id.clone()) {
        if old != cid {
            leave_voice(&state, &auth.id).await;
        }
    }
    let vs = VoiceState {
        user_id: auth.id.clone(),
        channel_id: cid.clone(),
        guild_id: ch.guild_id.clone(),
        muted: p & perms::SPEAK == 0 || held,
        deafened: false,
        video: false,
        screen: false,
        friends_only: false,
    };
    state.hub.voice.insert(auth.id.clone(), vs.clone());
    broadcast_voice(&state, &cid, serde_json::to_value(&vs).unwrap()).await;
    ring_on_join(&state, &cid, &auth.id).await;
    if ch.kind == "watch" {
        // a movie that stopped when everyone left carries on for whoever comes back
        crate::api::watch::someone_came_back(&state, &cid).await;
    }
    let url = crate::voice_server::client_url(&state, &headers).await;
    Ok(Json(json!({ "url": url, "token": token, "room": cid, "can_speak": p & perms::SPEAK != 0 && !held, "held": held, "can_video": p & perms::VIDEO != 0 })))
}

pub async fn leave(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    leave_voice(&state, &auth.id).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct VoiceUpdate {
    pub muted: Option<bool>,
    pub deafened: Option<bool>,
    pub video: Option<bool>,
    pub screen: Option<bool>,
    pub friends_only: Option<bool>,
}

pub async fn update(State(state): State<Shared>, auth: AuthUser, Json(req): Json<VoiceUpdate>) -> ApiResult<Json<Value>> {
    let vs = {
        let mut e = state.hub.voice.get_mut(&auth.id).ok_or_else(|| AppError::bad("not in voice"))?;
        if let Some(v) = req.muted { e.muted = v; }
        if let Some(v) = req.deafened { e.deafened = v; }
        if let Some(v) = req.video { e.video = v; }
        if let Some(v) = req.screen { e.screen = v; }
        if let Some(v) = req.friends_only { e.friends_only = v; }
        e.clone()
    };
    broadcast_voice(&state, &vs.channel_id, serde_json::to_value(&vs).unwrap()).await;
    Ok(Json(serde_json::to_value(&vs).unwrap()))
}

// ---------------------------------------------------------------- ringing
//
// Calling someone (a DM, or a party) rings their devices like a phone until one of these:
// - they answer (join the call)        -> stops ringing on their other devices
// - they decline                       -> the caller is told
// - the caller hangs up first          -> "missed call" in the chat
// - nobody answers in RING_SECS        -> "missed call" in the chat
// One ring per channel at a time; everyone still being rung is in `waiting`.

const RING_SECS: u64 = 30;

struct Ring {
    id: u64,
    from: String,
    waiting: Vec<String>,
    /// people added to a call already going: no "missed call" note in a chat they can't see
    added: bool,
}

static RINGS: once_cell::sync::Lazy<dashmap::DashMap<String, Ring>> = once_cell::sync::Lazy::new(Default::default);
static RING_IDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[derive(Deserialize, Default)]
pub struct RingReq {
    /// an urgent call: rings through Do Not Disturb with the alarm sound, marked URGENT
    #[serde(default)]
    pub urgent: bool,
}

/// For DMs and parties: ring the other people in it.
pub async fn ring(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, body: Option<Json<RingReq>>) -> ApiResult<Json<Value>> {
    let urgent = body.map(|b| b.0.urgent).unwrap_or(false);
    let ch = load_channel(&state.db, &cid).await?;
    if ch.kind != "dm" && ch.kind != "party" {
        return Err(AppError::bad("only DMs and parties can ring"));
    }
    require_channel(&state.db, &ch, &auth.id, perms::CONNECT).await?;
    // already in the call don't need ringing
    let in_call: Vec<String> = state.hub.voice.iter().filter(|v| v.channel_id == cid).map(|v| v.user_id.clone()).collect();
    let mut others: Vec<String> = channel_audience(&state.db, &ch).await.into_iter().filter(|u| u != &auth.id && !in_call.contains(u)).collect();
    // nobody rings someone who's blocked them (or whom they've blocked)
    let mut open = vec![];
    for u in others.drain(..) {
        if !crate::api::safety::blocked_either(&state, &auth.id, &u).await {
            open.push(u);
        }
    }
    let others = open;
    if others.is_empty() {
        return Ok(Json(json!({ "ok": true, "ringing": 0 })));
    }
    // only ring people something of theirs can hear: an open Llamble, or their phone's listener.
    // Nobody reachable: say so straight away (and leave a "missed call") instead of ringing nothing.
    let (ids, unreachable): (Vec<String>, Vec<String>) = others.into_iter().partition(|u| state.hub.reachable(u));
    if ids.is_empty() {
        missed_call_note(&state, &cid, &auth.id).await;
        return Ok(Json(json!({ "ok": true, "ringing": 0, "unreachable": unreachable })));
    }
    let id = RING_IDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    RINGS.insert(cid.clone(), Ring { id, from: auth.id.clone(), waiting: ids.clone(), added: false });
    let caller = get_user(&state.db, &auth.id).await.map(|u| u.display_name).unwrap_or_else(|_| "Someone".into());
    let place = if ch.kind == "party" { Some(ch.name.clone()) } else { None };
    state.hub.send_users(&ids, "CALL_RING", &json!({ "channel_id": cid, "from": auth.id, "ring_id": id, "seconds": RING_SECS, "party": place, "urgent": urgent }));
    for u in &ids {
        crate::pushes::call(u, &cid, id, &caller, place.as_deref(), &auth.id, false, urgent);
    }
    // nobody answered in time
    let (st, c) = (state.clone(), cid.clone());
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(RING_SECS)).await;
        if RINGS.get(&c).map(|r| r.id == id).unwrap_or(false) {
            end_ring(&st, &c, "missed").await;
        }
    });
    Ok(Json(json!({ "ok": true, "ringing": ids.len(), "ring_id": id, "unreachable": unreachable })))
}

/// The whole ring is over: stop it everywhere, and leave a "missed call" when nobody picked up.
async fn end_ring(state: &Shared, cid: &str, reason: &str) {
    let Some((_, r)) = RINGS.remove(cid) else { return };
    let mut all = r.waiting.clone();
    all.push(r.from.clone());
    state.hub.send_users(&all, "CALL_RING_END", &json!({ "channel_id": cid, "ring_id": r.id, "reason": reason }));
    for u in &r.waiting {
        crate::pushes::call_end(u, cid, r.id);
    }
    if (reason == "missed" || reason == "cancelled") && !r.added {
        missed_call_note(state, cid, &r.from).await;
    }
}

/// "📞 Missed call" in the chat, from the caller, so the other person sees it later.
async fn missed_call_note(state: &Shared, cid: &str, from: &str) {
    let who = AuthUser { id: from.to_string(), is_admin: false, is_master: false, is_kid: false, token_hash: String::new() };
    let req = crate::api::messages::CreateMsg { content: "📞 Missed call".into(), reply_to: None, attachments: vec![], nonce: None, effect: None, shared_from: None, voice: None, ..Default::default() };
    let _ = crate::api::messages::create_message(State(state.clone()), who, Path(cid.to_string()), axum::http::HeaderMap::new(), Json(req)).await;
}

/// Someone stopped being rung (answered or declined). Ends the ring when nobody is left.
async fn stop_ringing_one(state: &Shared, cid: &str, user: &str, reason: &str) {
    let (rid, from, left) = {
        let Some(mut r) = RINGS.get_mut(cid) else { return };
        if !r.waiting.iter().any(|u| u == user) {
            return;
        }
        r.waiting.retain(|u| u != user);
        (r.id, r.from.clone(), r.waiting.len())
    };
    // their other devices stop ringing
    state.hub.send_users(&[user.to_string()], "CALL_RING_END", &json!({ "channel_id": cid, "ring_id": rid, "reason": reason }));
    crate::pushes::call_end(user, cid, rid);
    if reason == "declined" {
        state.hub.send_users(&[from.clone()], "CALL_DECLINED", &json!({ "channel_id": cid, "by": user }));
    }
    if left == 0 {
        // everyone answered or declined: nothing more to ring (no missed-call note)
        let ended = RINGS.remove_if(cid, |_, r| r.id == rid).is_some();
        if ended {
            let reason = if reason == "answered" { "answered" } else { "declined" };
            state.hub.send_users(&[from], "CALL_RING_END", &json!({ "channel_id": cid, "ring_id": rid, "reason": reason }));
        }
    }
}

#[derive(Deserialize)]
pub struct RingAnswer {
    /// "declined" (someone being rung) or "cancelled" (the caller hung up before an answer)
    pub reason: String,
}

pub async fn ring_end(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<RingAnswer>) -> ApiResult<Json<Value>> {
    let from = RINGS.get(&cid).map(|r| r.from.clone());
    match (req.reason.as_str(), from) {
        ("cancelled", Some(f)) if f == auth.id => end_ring(&state, &cid, "cancelled").await,
        ("declined", Some(_)) => stop_ringing_one(&state, &cid, &auth.id, "declined").await,
        _ => {}
    }
    Ok(Json(json!({ "ok": true })))
}

/// Joining a call answers its ring; the caller leaving before anyone answers cancels it.
async fn ring_on_join(state: &Shared, cid: &str, user: &str) {
    stop_ringing_one(state, cid, user, "answered").await;
}
async fn ring_on_leave(state: &Shared, cid: &str, user: &str) {
    let is_caller = RINGS.get(cid).map(|r| r.from == user).unwrap_or(false);
    let alone = !state.hub.voice.iter().any(|v| v.channel_id == cid && v.user_id != user);
    if is_caller && alone {
        end_ring(state, cid, "cancelled").await;
    }
}

// ---------------------------------------------------------------- adding people to a call
//
// Adding someone to a call (DM or party) makes a new party: everyone in the call plus who was
// added, with its own fresh chat, named after the people in it. The call moves there (CALL_MOVED)
// and the added people are rung. The party is "unsaved": when the call ends everyone is asked to
// keep it (with a name) or delete it; anything written in its chat keeps it; if nobody keeps it,
// it's deleted a while after the call ends. Adding someone to an unsaved call party just adds
// them to it. The DM or party the call started in is never changed.

/// nobody's on a call in this unsaved party since (ms); deleted after UNSAVED_GRACE
static CALL_PARTY_EMPTY: once_cell::sync::Lazy<dashmap::DashMap<String, i64>> = once_cell::sync::Lazy::new(Default::default);
const UNSAVED_GRACE_MS: i64 = 15 * 60_000;

pub fn call_guests(_cid: &str) -> Vec<String> {
    vec![]
}
fn is_guest(_cid: &str, _uid: &str) -> bool {
    false
}

#[derive(Deserialize)]
pub struct AddToCall {
    pub user_ids: Vec<String>,
}

pub async fn add_to_call(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<AddToCall>) -> ApiResult<Json<Value>> {
    let ch = load_channel(&state.db, &cid).await?;
    if ch.guild_id.is_some() || (ch.kind != "dm" && ch.kind != "party") {
        return Err(AppError::bad("people can only be added to DM and party calls"));
    }
    if !state.hub.voice.get(&auth.id).map(|v| v.channel_id == cid).unwrap_or(false) {
        return Err(AppError::bad("join the call first"));
    }
    if req.user_ids.is_empty() || req.user_ids.len() > 10 {
        return Err(AppError::bad("add 1 to 10 people at a time"));
    }
    let members = channel_audience(&state.db, &ch).await;
    let in_call: Vec<String> = state.hub.voice.iter().filter(|v| v.channel_id == cid).map(|v| v.user_id.clone()).collect();
    let mut added = vec![];
    for u in req.user_ids {
        if u == auth.id || in_call.contains(&u) || added.contains(&u) {
            continue;
        }
        if !members.contains(&u) && !crate::api::social::is_friend(&state, &auth.id, &u).await {
            return Err(AppError::bad("you can only add your friends to a call"));
        }
        if crate::api::safety::blocked_either(&state, &auth.id, &u).await {
            return Err(AppError::bad("you can't add this person to a call"));
        }
        added.push(u);
    }
    if added.is_empty() {
        return Ok(Json(json!({ "ok": true, "ringing": 0, "party_id": cid })));
    }
    let unsaved: bool = ch.kind == "party" && sqlx::query_scalar("SELECT unsaved FROM channels WHERE id = ?").bind(&cid).fetch_one(&state.db).await.unwrap_or(false);
    let pid = if unsaved {
        // already the call's own party: they just join it
        for u in &added {
            sqlx::query("INSERT OR IGNORE INTO dm_members (channel_id, user_id) VALUES (?,?)").bind(&cid).bind(u).execute(&state.db).await?;
        }
        let all: Vec<String> = sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id = ?").bind(&cid).fetch_all(&state.db).await?;
        let v = crate::api::messages::dm_payload(&state, &cid).await?;
        state.hub.send_users(&added, "CHANNEL_CREATE", &v);
        state.hub.send_users(&all, "CHANNEL_UPDATE", &v);
        cid.clone()
    } else {
        // a new party: everyone on the call (in a DM, both of you even if they're still being
        // rung) plus who was added
        let mut people: Vec<String> = vec![auth.id.clone()];
        let base: Vec<String> = if ch.kind == "dm" { members.clone() } else { in_call.clone() };
        for u in base.iter().chain(added.iter()) {
            if !people.contains(u) {
                people.push(u.clone());
            }
        }
        let name = crate::api::social::default_party_name(&state, "", &people).await;
        let id = crate::error::new_id();
        sqlx::query("INSERT INTO channels (id, guild_id, kind, name, owner_id, created_at, unsaved) VALUES (?, NULL, 'party', ?, ?, ?, 1)").bind(&id).bind(&name).bind(&auth.id).bind(crate::error::now_ms()).execute(&state.db).await?;
        for u in &people {
            sqlx::query("INSERT INTO dm_members (channel_id, user_id) VALUES (?,?)").bind(&id).bind(u).execute(&state.db).await?;
        }
        let v = crate::api::messages::dm_payload(&state, &id).await?;
        state.hub.send_users(&people, "CHANNEL_CREATE", &v);
        // everyone on the call goes over to it
        state.hub.send_users(&in_call, "CALL_MOVED", &json!({ "from": cid, "to": id }));
        id
    };
    // ring the added people in the party (those who can be reached)
    let (added, unreachable): (Vec<String>, Vec<String>) = added.into_iter().partition(|u| state.hub.reachable(u));
    if added.is_empty() {
        return Ok(Json(json!({ "ok": true, "ringing": 0, "party_id": pid, "unreachable": unreachable })));
    }
    let ring_id = {
        let mut e = RINGS.entry(pid.clone()).or_insert_with(|| Ring { id: RING_IDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed), from: auth.id.clone(), waiting: vec![], added: true });
        for u in &added {
            if !e.waiting.contains(u) {
                e.waiting.push(u.clone());
            }
        }
        e.id
    };
    let caller = get_user(&state.db, &auth.id).await.map(|u| u.display_name).unwrap_or_else(|_| "Someone".into());
    let place: String = sqlx::query_scalar("SELECT name FROM channels WHERE id = ?").bind(&pid).fetch_one(&state.db).await.unwrap_or_default();
    for u in &added {
        state.hub.send_users(&[u.clone()], "CALL_RING", &json!({ "channel_id": pid, "from": auth.id, "ring_id": ring_id, "seconds": RING_SECS, "party": place, "with": in_call }));
        crate::pushes::call(u, &pid, ring_id, &caller, Some(&place), &auth.id, false, false);
    }
    let (st, c) = (state.clone(), pid.clone());
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(RING_SECS)).await;
        if RINGS.get(&c).map(|r| r.id == ring_id).unwrap_or(false) {
            end_ring(&st, &c, "missed").await;
        }
    });
    Ok(Json(json!({ "ok": true, "ringing": added.len(), "ring_id": ring_id, "party_id": pid, "unreachable": unreachable })))
}

/// Unsaved call parties nobody has been on a call in for a while are deleted (nobody kept them
/// and nothing was written in them).
pub async fn sweep_call_parties(state: &Shared) {
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM channels WHERE kind = 'party' AND unsaved = 1").fetch_all(&state.db).await.unwrap_or_default();
    let now = crate::error::now_ms();
    for id in ids {
        if state.hub.voice.iter().any(|v| v.channel_id == id) || RINGS.contains_key(&id) {
            CALL_PARTY_EMPTY.remove(&id);
            continue;
        }
        let since = *CALL_PARTY_EMPTY.entry(id.clone()).or_insert(now);
        if now - since >= UNSAVED_GRACE_MS {
            CALL_PARTY_EMPTY.remove(&id);
            tracing::info!("call party {id} was never kept: deleting it");
            crate::api::social::drop_party(state, &id).await;
        }
    }
}

#[derive(serde::Deserialize)]
pub struct LockReq {
    pub locked: bool,
}

/// POST /api/channels/{cid}/lock {locked} — staff lock a room on the fly: nobody new comes in.
pub async fn lock(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Json(req): Json<LockReq>) -> ApiResult<Json<Value>> {
    let ch = load_channel(&state.db, &cid).await?;
    if ch.guild_id.is_none() || ch.kind == "category" {
        return Err(AppError::bad("only a server's spaces can be locked"));
    }
    let p = perms::channel_perms(&state.db, &ch, &auth.id).await?;
    if p & (perms::LOCK_SPACES | perms::MANAGE_CHANNELS) == 0 {
        return Err(AppError::forbidden_msg("you can't lock this space"));
    }
    sqlx::query("UPDATE channels SET locked = ? WHERE id = ?").bind(req.locked).bind(&cid).execute(&state.db).await?;
    let ch = load_channel(&state.db, &cid).await?;
    state.emit_guild(ch.guild_id.as_deref().unwrap_or_default(), "CHANNEL_UPDATE", &ch).await;
    Ok(Json(serde_json::to_value(&ch).unwrap()))
}

/// Change what someone in a room may send, live (e.g. give a held Watch Party guest their mic).
pub async fn set_sources(state: &Shared, room: &str, identity: &str, sources: &[&str]) -> bool {
    let Some((key, secret)) = crate::voice_server::credentials(state).await else { return false };
    let now = chrono_now();
    let claims = json!({ "iss": key, "nbf": now - 10, "exp": now + 60, "video": { "room": room, "roomAdmin": true } });
    let Ok(token) = jsonwebtoken::encode(&jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256), &claims, &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes())) else { return false };
    let url = format!("{}/twirp/livekit.RoomService/UpdateParticipant", crate::voice_server::internal_url(state).await);
    let srcs: Vec<String> = sources.iter().map(|s| s.to_uppercase()).collect();
    let body = json!({ "room": room, "identity": identity, "permission": { "canSubscribe": true, "canPublish": !srcs.is_empty(), "canPublishData": true, "canPublishSources": srcs } });
    match reqwest::Client::new().post(url).bearer_auth(token).json(&body).timeout(std::time::Duration::from_secs(5)).send().await {
        Ok(r) if r.status().is_success() => true,
        Ok(r) => {
            tracing::warn!("voice server refused to change {identity}'s permissions: {}", r.status());
            false
        }
        Err(e) => {
            tracing::warn!("couldn't reach the voice server to change {identity}'s permissions: {e}");
            false
        }
    }
}

// ---------------------------------------------------------------- who's really in a call
//
// You're in a call until you hang up or your app really leaves the voice server. Every 15 s
// the voice server is asked who's in each room; someone listed here but gone from the room for
// 30 s straight (app killed, phone lost signal for good) is taken out. If the voice server
// can't be asked, nobody is taken out.

static MISSING: once_cell::sync::Lazy<dashmap::DashMap<String, i64>> = once_cell::sync::Lazy::new(Default::default);

async fn room_identities(state: &Shared, room: &str) -> Option<Vec<String>> {
    let (key, secret) = crate::voice_server::credentials(state).await?;
    let now = chrono_now();
    let claims = json!({ "iss": key, "nbf": now - 10, "exp": now + 60, "video": { "room": room, "roomAdmin": true, "roomList": true } });
    let token = jsonwebtoken::encode(&jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256), &claims, &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes())).ok()?;
    let url = format!("{}/twirp/livekit.RoomService/ListParticipants", crate::voice_server::internal_url(state).await);
    let r = reqwest::Client::new().post(url).bearer_auth(token).json(&json!({ "room": room })).timeout(std::time::Duration::from_secs(5)).send().await.ok()?;
    if r.status() == reqwest::StatusCode::NOT_FOUND {
        return Some(vec![]); // no such room: nobody's in it
    }
    if !r.status().is_success() {
        return None;
    }
    let v: Value = r.json().await.ok()?;
    Some(v["participants"].as_array().map(|a| a.iter().filter_map(|p| p["identity"].as_str().map(String::from)).collect()).unwrap_or_default())
}

pub fn watch_calls(state: Shared) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            sweep_call_parties(&state).await;
            if !crate::voice_server::enabled(&state) {
                continue;
            }
            let mut rooms: std::collections::HashMap<String, Vec<String>> = Default::default();
            for v in state.hub.voice.iter() {
                rooms.entry(v.channel_id.clone()).or_default().push(v.user_id.clone());
            }
            let now = crate::error::now_ms();
            for (room, users) in rooms {
                let Some(present) = room_identities(&state, &room).await else { continue };
                for u in users {
                    if present.contains(&u) {
                        MISSING.remove(&u);
                        continue;
                    }
                    let since = *MISSING.entry(u.clone()).or_insert(now);
                    if now - since >= 30_000 {
                        MISSING.remove(&u);
                        if state.hub.voice.get(&u).map(|v| v.channel_id == room).unwrap_or(false) {
                            tracing::info!("{u} left the voice server: taking them out of the call");
                            leave_voice(&state, &u).await;
                        }
                    }
                }
            }
        }
    });
}
