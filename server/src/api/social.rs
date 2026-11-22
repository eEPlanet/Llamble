//! Friends and parties.
//!
//! **Friends**: ask someone on this instance by username; they accept. Friends see each
//! other's status and what they're playing, and can always DM. Kid accounts follow the same
//! rule as their DMs: a parent approves the person first.
//!
//! **Parties**: a small named group (up to 25) with its own chat and voice room, outside any
//! server. Like a mini server with nothing to set up: for playing a game, watching something
//! together, or just a quick place for the people you actually hang out with. Anyone in it can
//! add people; the creator can rename it, remove people, or delete it. A party is a channel of
//! kind "party" with no server, so messages, calls, screen sharing and notifications work
//! exactly like DMs.
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::models::{get_user, load_channel, load_users};
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;

pub const PARTY_MAX: i64 = 25;

pub async fn migrate(pool: &SqlitePool) -> anyhow::Result<()> {
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS friends (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            other_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            state TEXT NOT NULL,            -- 'friend' | 'outgoing' | 'incoming'
            since INTEGER NOT NULL,
            PRIMARY KEY (user_id, other_id)
        );",
    )
    .execute(pool)
    .await?;
    // profile page: a few words about you and a banner color
    crate::db::add_column(pool, "users", "bio", "TEXT NOT NULL DEFAULT ''").await?;
    crate::db::add_column(pool, "users", "banner", "TEXT NOT NULL DEFAULT ''").await?;
    // your own private note about a friend ("plays Tuesdays")
    crate::db::add_column(pool, "friends", "note", "TEXT NOT NULL DEFAULT ''").await?;
    // a party made by adding someone to a call, until it's kept (see voice::add_to_call)
    crate::db::add_column(pool, "channels", "unsaved", "INTEGER NOT NULL DEFAULT 0").await?;
    // pinned at the top of your Friends (Contacts) list
    crate::db::add_column(pool, "friends", "favorite", "INTEGER NOT NULL DEFAULT 0").await?;
    // who made a party (can rename it, remove people, delete it)
    crate::db::add_column(pool, "channels", "owner_id", "TEXT").await?;
    Ok(())
}

// ------------------------------------------------------------------ friends

async fn friend_json(state: &Shared, me: &str, other: &str) -> ApiResult<Value> {
    let row: Option<(String, i64, String, bool)> = sqlx::query_as("SELECT state, since, note, favorite FROM friends WHERE user_id = ? AND other_id = ?").bind(me).bind(other).fetch_optional(&state.db).await?;
    let (st, since, note, fav) = row.ok_or_else(AppError::not_found)?;
    Ok(json!({ "user": get_user(&state.db, other).await?, "state": st, "since": since, "note": note, "favorite": fav }))
}

/// Both sides hear about a change to their friendship.
async fn tell_both(state: &Shared, a: &str, b: &str) {
    for (me, other) in [(a, b), (b, a)] {
        let v = match friend_json(state, me, other).await {
            Ok(v) => v,
            Err(_) => json!({ "user": { "id": other }, "state": "none" }),
        };
        state.hub.send_users(&[me.to_string()], "FRIEND_UPDATE", &v);
    }
}

pub async fn is_friend(state: &Shared, a: &str, b: &str) -> bool {
    let r: Option<i64> = sqlx::query_scalar("SELECT 1 FROM friends WHERE user_id = ? AND other_id = ? AND state = 'friend'").bind(a).bind(b).fetch_optional(&state.db).await.unwrap_or(None);
    r.is_some()
}

pub async fn list_friends(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, i64, String, bool)> = sqlx::query_as("SELECT other_id, state, since, note, favorite FROM friends WHERE user_id = ? ORDER BY since DESC").bind(&auth.id).fetch_all(&state.db).await?;
    let ids: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let users = load_users(&state.db, &ids).await?;
    Ok(Json(json!(rows
        .into_iter()
        .filter_map(|(id, st, since, note, fav)| users.get(&id).map(|u| json!({ "user": u, "state": st, "since": since, "note": note, "favorite": fav })))
        .collect::<Vec<_>>())))
}

#[derive(Deserialize)]
pub struct AddFriend {
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
}

/// Ask someone to be friends (or accept, if they already asked you).
pub async fn add_friend(State(state): State<Shared>, auth: AuthUser, Json(req): Json<AddFriend>) -> ApiResult<Json<Value>> {
    let other: Option<String> = match (&req.user_id, &req.username) {
        (Some(id), _) => sqlx::query_scalar("SELECT id FROM users WHERE id = ? AND is_bot = 0").bind(id).fetch_optional(&state.db).await?,
        (None, Some(name)) => sqlx::query_scalar("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND is_bot = 0").bind(name.trim().trim_start_matches('@')).fetch_optional(&state.db).await?,
        _ => None,
    };
    let other = other.ok_or_else(|| AppError::bad("nobody on this Llamble has that username"))?;
    if other == auth.id {
        return Err(AppError::bad("you can't friend yourself"));
    }
    // kids: a parent approves the person first (same rule as DMs)
    if let Err(kid) = crate::kids::dm_allowed(&state, &auth.id, &other).await {
        let target = if kid == auth.id { other.clone() } else { auth.id.clone() };
        crate::kids::request(&state, &kid, "dm", &target).await?;
        return Err(AppError::forbidden_msg("A parent needs to approve this person first. They've been asked."));
    }
    let theirs: Option<String> = sqlx::query_scalar("SELECT state FROM friends WHERE user_id = ? AND other_id = ?").bind(&other).bind(&auth.id).fetch_optional(&state.db).await?;
    let now = now_ms();
    match theirs.as_deref() {
        Some("friend") => {}
        Some("outgoing") => {
            // they asked first: this accepts
            for (a, b) in [(&auth.id, &other), (&other, &auth.id)] {
                sqlx::query("INSERT INTO friends (user_id, other_id, state, since) VALUES (?,?, 'friend', ?) ON CONFLICT(user_id, other_id) DO UPDATE SET state = 'friend', since = excluded.since").bind(a).bind(b).bind(now).execute(&state.db).await?;
            }
        }
        _ => {
            sqlx::query("INSERT OR REPLACE INTO friends (user_id, other_id, state, since) VALUES (?,?, 'outgoing', ?)").bind(&auth.id).bind(&other).bind(now).execute(&state.db).await?;
            sqlx::query("INSERT OR REPLACE INTO friends (user_id, other_id, state, since) VALUES (?,?, 'incoming', ?)").bind(&other).bind(&auth.id).bind(now).execute(&state.db).await?;
        }
    }
    tell_both(&state, &auth.id, &other).await;
    Ok(Json(friend_json(&state, &auth.id, &other).await?))
}

/// Accept a request someone sent you.
pub async fn accept_friend(State(state): State<Shared>, auth: AuthUser, Path(other): Path<String>) -> ApiResult<Json<Value>> {
    let mine: Option<String> = sqlx::query_scalar("SELECT state FROM friends WHERE user_id = ? AND other_id = ?").bind(&auth.id).bind(&other).fetch_optional(&state.db).await?;
    if mine.as_deref() != Some("incoming") {
        return Err(AppError::bad("there's no request from them"));
    }
    add_friend(State(state), auth, Json(AddFriend { username: None, user_id: Some(other) })).await
}

/// A friend's page: the friendship plus the servers you both belong to.
pub async fn get_friend(State(state): State<Shared>, auth: AuthUser, Path(other): Path<String>) -> ApiResult<Json<Value>> {
    let mut v = friend_json(&state, &auth.id, &other).await?;
    let shared: Vec<String> = sqlx::query_scalar("SELECT a.guild_id FROM members a JOIN members b ON a.guild_id = b.guild_id WHERE a.user_id = ? AND b.user_id = ?")
        .bind(&auth.id)
        .bind(&other)
        .fetch_all(&state.db)
        .await?;
    v["mutual_guilds"] = json!(shared);
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct FriendNote {
    pub note: String,
}

/// Your private note about a friend (only you see it).
pub async fn note_friend(State(state): State<Shared>, auth: AuthUser, Path(other): Path<String>, Json(req): Json<FriendNote>) -> ApiResult<Json<Value>> {
    let note: String = req.note.chars().take(500).collect();
    let r = sqlx::query("UPDATE friends SET note = ? WHERE user_id = ? AND other_id = ?").bind(&note).bind(&auth.id).bind(&other).execute(&state.db).await?;
    if r.rows_affected() == 0 {
        return Err(AppError::not_found());
    }
    let v = friend_json(&state, &auth.id, &other).await?;
    state.hub.send_users(&[auth.id.clone()], "FRIEND_UPDATE", &v);
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct Favorite {
    pub favorite: bool,
}

/// Pin a friend at the top of your list (or unpin them). Only you see your favorites.
pub async fn favorite_friend(State(state): State<Shared>, auth: AuthUser, Path(other): Path<String>, Json(req): Json<Favorite>) -> ApiResult<Json<Value>> {
    let r = sqlx::query("UPDATE friends SET favorite = ? WHERE user_id = ? AND other_id = ? AND state = 'friend'").bind(req.favorite).bind(&auth.id).bind(&other).execute(&state.db).await?;
    if r.rows_affected() == 0 {
        return Err(AppError::bad("only friends can be favorites"));
    }
    let v = friend_json(&state, &auth.id, &other).await?;
    state.hub.send_users(&[auth.id.clone()], "FRIEND_UPDATE", &v);
    Ok(Json(v))
}

/// Unfriend, decline a request, or cancel one you sent.
pub async fn remove_friend(State(state): State<Shared>, auth: AuthUser, Path(other): Path<String>) -> ApiResult<Json<Value>> {
    sqlx::query("DELETE FROM friends WHERE (user_id = ? AND other_id = ?) OR (user_id = ? AND other_id = ?)").bind(&auth.id).bind(&other).bind(&other).bind(&auth.id).execute(&state.db).await?;
    tell_both(&state, &auth.id, &other).await;
    Ok(Json(json!({ "ok": true })))
}

// ------------------------------------------------------------------ parties

async fn party(state: &Shared, auth: &AuthUser, id: &str) -> ApiResult<(crate::models::Channel, Option<String>, Vec<String>)> {
    let ch = load_channel(&state.db, id).await.map_err(|_| AppError::not_found())?;
    if ch.kind != "party" {
        return Err(AppError::not_found());
    }
    let members: Vec<String> = sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id = ?").bind(id).fetch_all(&state.db).await?;
    if !members.contains(&auth.id) && !auth.is_admin {
        return Err(AppError::not_found());
    }
    let owner: Option<String> = sqlx::query_scalar("SELECT owner_id FROM channels WHERE id = ?").bind(id).fetch_one(&state.db).await?;
    Ok((ch, owner, members))
}

/// Who may be in a party with whom: the same rule as a DM (friends, a shared server, family),
/// and kids only with people a parent approved.
async fn may_join(state: &Shared, adder: &AuthUser, who: &str, members: &[String]) -> ApiResult<()> {
    let shares: Option<i64> = sqlx::query_scalar("SELECT 1 FROM members a JOIN members b ON a.guild_id = b.guild_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1").bind(&adder.id).bind(who).fetch_optional(&state.db).await?;
    if shares.is_none() && !is_friend(state, &adder.id, who).await && !adder.is_admin && !crate::kids::is_guardian(state, &adder.id, who).await && !crate::kids::is_guardian(state, who, &adder.id).await {
        return Err(AppError::forbidden_msg("you can only add your friends or people in your servers"));
    }
    for m in members {
        if m == who {
            continue;
        }
        if let Err(kid) = crate::kids::dm_allowed(state, m, who).await {
            let target = if kid == *m { who.to_string() } else { m.clone() };
            crate::kids::request(state, &kid, "dm", &target).await?;
            let name = get_user(&state.db, who).await.map(|u| u.display_name).unwrap_or_default();
            return Err(AppError::forbidden_msg(format!("{name} can't join yet: a parent needs to approve them first (they've been asked)")));
        }
    }
    Ok(())
}

async fn party_payload(state: &Shared, id: &str) -> ApiResult<Value> {
    crate::api::messages::dm_payload(state, id).await
}

/// A party with no name of its own is called after the people in it, not counting whoever
/// made it: "Sam", "Sam & Jordan", "Sam, Jordan & Riley", "Sam, Jordan, Riley +2".
pub async fn default_party_name(state: &Shared, maker: &str, members: &[String]) -> String {
    let others: Vec<String> = members.iter().filter(|m| m.as_str() != maker).cloned().collect();
    let users = load_users(&state.db, &others).await.unwrap_or_default();
    let names: Vec<String> = others.iter().filter_map(|id| users.get(id).map(|u| u.display_name.clone())).collect();
    let n = match names.len() {
        0 => "Party".to_string(),
        1 => names[0].clone(),
        2 => format!("{} & {}", names[0], names[1]),
        3 => format!("{}, {} & {}", names[0], names[1], names[2]),
        k => format!("{}, {}, {} +{}", names[0], names[1], names[2], k - 3),
    };
    n.chars().take(60).collect()
}

#[derive(Deserialize)]
pub struct NewParty {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub user_ids: Vec<String>,
}

pub async fn create_party(State(state): State<Shared>, auth: AuthUser, Json(req): Json<NewParty>) -> ApiResult<Json<Value>> {
    let mut members = vec![auth.id.clone()];
    for u in req.user_ids {
        if !members.contains(&u) {
            members.push(u);
        }
    }
    if members.len() as i64 > PARTY_MAX {
        return Err(AppError::bad(format!("a party holds up to {PARTY_MAX} people")));
    }
    // its people never change, so a party starts with them
    if members.len() < 2 {
        return Err(AppError::bad("pick at least one person for the party"));
    }
    for (i, u) in members.iter().enumerate().skip(1) {
        may_join(&state, &auth, u, &members[..i]).await?;
    }
    let mut name = req.name.trim().chars().take(60).collect::<String>();
    if name.is_empty() {
        name = default_party_name(&state, &auth.id, &members).await;
    }
    let id = new_id();
    sqlx::query("INSERT INTO channels (id, guild_id, kind, name, owner_id, created_at) VALUES (?, NULL, 'party', ?, ?, ?)").bind(&id).bind(&name).bind(&auth.id).bind(now_ms()).execute(&state.db).await?;
    for u in &members {
        sqlx::query("INSERT INTO dm_members (channel_id, user_id) VALUES (?,?)").bind(&id).bind(u).execute(&state.db).await?;
    }
    let v = party_payload(&state, &id).await?;
    state.hub.send_users(&members, "CHANNEL_CREATE", &v);
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct EditParty {
    pub name: String,
}

pub async fn rename_party(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Json(req): Json<EditParty>) -> ApiResult<Json<Value>> {
    let (_, owner, members) = party(&state, &auth, &id).await?;
    if owner.as_deref() != Some(auth.id.as_str()) && !auth.is_admin {
        return Err(AppError::forbidden_msg("only whoever made the party can rename it"));
    }
    let name = req.name.trim().chars().take(60).collect::<String>();
    if name.is_empty() {
        return Err(AppError::bad("give the party a name"));
    }
    sqlx::query("UPDATE channels SET name = ? WHERE id = ?").bind(&name).bind(&id).execute(&state.db).await?;
    let v = party_payload(&state, &id).await?;
    state.hub.send_users(&members, "CHANNEL_UPDATE", &v);
    Ok(Json(v))
}

/// A party's people never change once it's made: to bring someone else in, start a new party
/// with everyone (the old one and its chat stay as they are). For a quick call, add them to the
/// call instead (they join the call, not the chat).
pub async fn add_to_party(State(state): State<Shared>, auth: AuthUser, Path((id, _who)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    party(&state, &auth, &id).await?;
    Err(AppError::bad("a party's people stay the same: start a new party with everyone instead (this one keeps its chat)"))
}

/// Leave (yourself) or remove someone (the creator). Their messages are deleted with them. The
/// last one out deletes the party; if the creator leaves, whoever's been in longest takes over.
pub async fn remove_from_party(State(state): State<Shared>, auth: AuthUser, Path((id, who)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let (_, owner, members) = party(&state, &auth, &id).await?;
    let is_owner = owner.as_deref() == Some(auth.id.as_str()) || auth.is_admin;
    if who != auth.id && !is_owner {
        return Err(AppError::forbidden_msg("only whoever made the party can remove people"));
    }
    if !members.contains(&who) {
        return Err(AppError::not_found());
    }
    sqlx::query("DELETE FROM dm_members WHERE channel_id = ? AND user_id = ?").bind(&id).bind(&who).execute(&state.db).await?;
    state.hub.send_users(&[who.clone()], "CHANNEL_DELETE", &json!({ "id": id, "guild_id": null }));
    let left: Vec<String> = members.into_iter().filter(|m| *m != who).collect();
    // they can't get back in, so what they wrote leaves with them (they'd have no way to delete
    // it later); the others are told which messages went
    let gone: Vec<String> = sqlx::query_scalar("SELECT id FROM messages WHERE channel_id = ? AND author_id = ?").bind(&id).bind(&who).fetch_all(&state.db).await?;
    if !gone.is_empty() {
        sqlx::query("DELETE FROM messages WHERE channel_id = ? AND author_id = ?").bind(&id).bind(&who).execute(&state.db).await?;
        state.hub.send_users(&left, "MESSAGE_DELETE_BULK", &json!({ "channel_id": id, "ids": gone }));
    }
    if left.is_empty() {
        sqlx::query("DELETE FROM channels WHERE id = ?").bind(&id).execute(&state.db).await?;
        return Ok(Json(json!({ "deleted": true })));
    }
    if owner.as_deref() == Some(who.as_str()) {
        sqlx::query("UPDATE channels SET owner_id = (SELECT user_id FROM dm_members WHERE channel_id = ?1 ORDER BY rowid LIMIT 1) WHERE id = ?1").bind(&id).execute(&state.db).await?;
    }
    let v = party_payload(&state, &id).await?;
    state.hub.send_users(&left, "CHANNEL_UPDATE", &v);
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct KeepParty {
    #[serde(default)]
    pub name: Option<String>,
}

/// Keep a party that was made by adding someone to a call (anyone in it can), optionally
/// naming it. Until then it's deleted a while after its call ends.
pub async fn keep_party(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Json(req): Json<KeepParty>) -> ApiResult<Json<Value>> {
    let (_, _, members) = party(&state, &auth, &id).await?;
    if let Some(n) = req.name.map(|n| n.trim().chars().take(60).collect::<String>()).filter(|n| !n.is_empty()) {
        sqlx::query("UPDATE channels SET name = ? WHERE id = ?").bind(&n).bind(&id).execute(&state.db).await?;
    }
    sqlx::query("UPDATE channels SET unsaved = 0 WHERE id = ?").bind(&id).execute(&state.db).await?;
    let v = party_payload(&state, &id).await?;
    state.hub.send_users(&members, "CHANNEL_UPDATE", &v);
    Ok(Json(v))
}

/// The party made for a call becomes a kept party as soon as anyone writes or shares anything
/// in its chat.
pub async fn kept_by_message(state: &Shared, cid: &str) {
    if let Ok(r) = sqlx::query("UPDATE channels SET unsaved = 0 WHERE id = ? AND unsaved = 1").bind(cid).execute(&state.db).await {
        if r.rows_affected() > 0 {
            if let Ok(v) = party_payload(state, cid).await {
                let members: Vec<String> = sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id = ?").bind(cid).fetch_all(&state.db).await.unwrap_or_default();
                state.hub.send_users(&members, "CHANNEL_UPDATE", &v);
            }
        }
    }
}

/// Delete a party for everyone (used when a call's party was never kept).
pub async fn drop_party(state: &Shared, id: &str) {
    let members: Vec<String> = sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id = ?").bind(id).fetch_all(&state.db).await.unwrap_or_default();
    if sqlx::query("DELETE FROM channels WHERE id = ?").bind(id).execute(&state.db).await.is_ok() {
        state.hub.send_users(&members, "CHANNEL_DELETE", &json!({ "id": id, "guild_id": null }));
    }
}

pub async fn delete_party(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (_, owner, members) = party(&state, &auth, &id).await?;
    if owner.as_deref() != Some(auth.id.as_str()) && !auth.is_admin {
        return Err(AppError::forbidden_msg("only whoever made the party can delete it (you can leave it)"));
    }
    sqlx::query("DELETE FROM channels WHERE id = ?").bind(&id).execute(&state.db).await?;
    state.hub.send_users(&members, "CHANNEL_DELETE", &json!({ "id": id, "guild_id": null }));
    Ok(Json(json!({ "deleted": true })))
}

/// Someone's profile page: their card plus what they wrote about themselves.
pub async fn get_profile(State(state): State<Shared>, _auth: AuthUser, Path(uid): Path<String>) -> ApiResult<Json<Value>> {
    let row: Option<(String, String, i64)> = sqlx::query_as("SELECT bio, banner, created_at FROM users WHERE id = ?").bind(&uid).fetch_optional(&state.db).await?;
    let (bio, banner, joined) = row.ok_or_else(AppError::not_found)?;
    Ok(Json(json!({ "user": get_user(&state.db, &uid).await?, "bio": bio, "banner": banner, "joined_at": joined })))
}

#[derive(Deserialize)]
pub struct EditProfile {
    pub bio: Option<String>,
    pub banner: Option<String>,
}

/// Change what your profile page says.
pub async fn edit_profile(State(state): State<Shared>, auth: AuthUser, Json(req): Json<EditProfile>) -> ApiResult<Json<Value>> {
    if let Some(b) = req.bio {
        let b: String = b.trim().chars().take(300).collect();
        sqlx::query("UPDATE users SET bio = ? WHERE id = ?").bind(b).bind(&auth.id).execute(&state.db).await?;
    }
    if let Some(c) = req.banner {
        let ok = c.is_empty() || (c.len() <= 32 && c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '#'));
        if !ok {
            return Err(AppError::bad("unknown banner"));
        }
        sqlx::query("UPDATE users SET banner = ? WHERE id = ?").bind(c).bind(&auth.id).execute(&state.db).await?;
    }
    get_profile(State(state), auth.clone(), Path(auth.id.clone())).await
}
