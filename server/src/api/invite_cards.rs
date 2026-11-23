//! Inviting people who are already on this instance into a server, from inside Llamble.
//!
//! An invite is a card posted in a chat: in your DM with the person (inviting one person)
//! or in a party's chat (inviting the party). The card has a Join button that joins right in
//! the app, and shows who has joined. Each invited person also gets a notification.
//!
//! Who you can find: an instance setting ("connections" = your friends and people who share
//! a server with you, or "everyone"). Kid accounts never show up, except to their own
//! parents, and only a parent can invite their kid (to a server the parent is in).
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::models::load_channel;
use crate::perms::{self, require_guild};
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS invite_cards (
            id TEXT PRIMARY KEY,
            guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
            inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            -- the DM or party the card was posted in
            channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            message_id TEXT,
            party INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS invite_card_people (
            card_id TEXT NOT NULL REFERENCES invite_cards(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            joined_at INTEGER,
            declined_at INTEGER,
            reminded_at INTEGER,
            PRIMARY KEY (card_id, user_id)
        )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn is_member(state: &Shared, gid: &str, uid: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?").bind(gid).bind(uid).fetch_optional(&state.db).await.ok().flatten().is_some()
}

async fn is_banned(state: &Shared, gid: &str, uid: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM bans WHERE guild_id = ? AND user_id = ?").bind(gid).bind(uid).fetch_optional(&state.db).await.ok().flatten().is_some()
}

/// Friends, and people who share a server with `me`.
async fn connected(state: &Shared, me: &str, other: &str) -> bool {
    if crate::api::social::is_friend(state, me, other).await {
        return true;
    }
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM members a JOIN members b ON a.guild_id = b.guild_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1")
        .bind(me)
        .bind(other)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// May `me` invite `other` (to anything)? Kids: only their own parents. Others: per the
/// instance's search setting.
async fn may_invite(state: &Shared, me: &str, other: &str) -> bool {
    if me == other {
        return false;
    }
    let Ok(u) = crate::models::get_user(&state.db, other).await else { return false };
    if u.is_bot {
        return false;
    }
    if crate::kids::is_kid(state, other).await {
        return crate::kids::is_guardian(state, other, me).await;
    }
    state.s().invite_search == "everyone" || connected(state, me, other).await
}

#[derive(Deserialize)]
pub struct SearchQ {
    #[serde(default)]
    pub q: String,
}

/// GET /api/guilds/{gid}/invite-search?q= — people you could invite (needs Create invite).
pub async fn search(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, Query(sq): Query<SearchQ>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::CREATE_INVITE).await?;
    let q = sq.q.trim().trim_start_matches('@').to_lowercase();
    let like = format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    // your own kids first, then everyone who matches
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM users WHERE is_bot = 0 AND id != ?
           AND (? = '' OR lower(username) LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\')
         ORDER BY (id IN (SELECT kid_id FROM guardians WHERE guardian_id = ?)) DESC, lower(display_name)
         LIMIT 400",
    )
    .bind(&auth.id)
    .bind(&q)
    .bind(&like)
    .bind(&like)
    .bind(&auth.id)
    .fetch_all(&state.db)
    .await?;
    let mut out = vec![];
    for id in ids {
        if out.len() >= 25 {
            break;
        }
        if !may_invite(&state, &auth.id, &id).await || is_banned(&state, &gid, &id).await {
            continue;
        }
        let Ok(u) = crate::models::get_user(&state.db, &id).await else { continue };
        let mut v = serde_json::to_value(&u).unwrap();
        v["member"] = json!(is_member(&state, &gid, &id).await);
        v["your_kid"] = json!(u.is_kid);
        out.push(v);
    }
    Ok(Json(json!({ "people": out, "scope": state.s().invite_search })))
}

/// Post the card message in a chat as the inviter, then attach the invite embed.
async fn post_card(state: &Shared, auth: &AuthUser, headers: HeaderMap, channel_id: &str, gid: &str, party: bool, people: &[String]) -> ApiResult<String> {
    let guild = crate::api::notifications::guild_brief(state, gid).await;
    let name = guild["name"].as_str().unwrap_or("my server").to_string();
    let card = new_id();
    sqlx::query("INSERT INTO invite_cards (id, guild_id, inviter_id, channel_id, party, created_at) VALUES (?,?,?,?,?,?)")
        .bind(&card)
        .bind(gid)
        .bind(&auth.id)
        .bind(channel_id)
        .bind(party)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    for u in people {
        let joined = is_member(state, gid, u).await.then(now_ms);
        sqlx::query("INSERT OR IGNORE INTO invite_card_people (card_id, user_id, joined_at) VALUES (?,?,?)").bind(&card).bind(u).bind(joined).execute(&state.db).await?;
    }
    let Json(msg) = crate::api::messages::create_message(
        State(state.clone()),
        auth.clone(),
        Path(channel_id.to_string()),
        headers,
        Json(crate::api::messages::CreateMsg {
            content: format!("Join me in **{name}**"),
            reply_to: None,
            attachments: vec![],
            nonce: None,
            effect: None,
            shared_from: None,
            voice: None,
        }),
    )
    .await?;
    let mid = msg["id"].as_str().unwrap_or_default().to_string();
    sqlx::query("UPDATE invite_cards SET message_id = ? WHERE id = ?").bind(&mid).bind(&card).execute(&state.db).await?;
    let embed = json!({ "type": "invite", "card_id": card, "guild": guild });
    sqlx::query("UPDATE messages SET embeds = ? WHERE id = ?").bind(json!([embed]).to_string()).bind(&mid).execute(&state.db).await?;
    let ch = load_channel(&state.db, channel_id).await?;
    let m = crate::models::load_message(&state.db, &mid).await?;
    state.emit_channel(&ch, "MESSAGE_UPDATE", &serde_json::to_value(&m).unwrap()).await;
    // each person who isn't in the server yet gets a notification
    let from = crate::api::notifications::who(state, &auth.id).await;
    for u in people {
        if !is_member(state, gid, u).await {
            crate::api::notifications::notify(
                state,
                u,
                "server_invite",
                Some(&card),
                json!({ "card_id": card, "guild": guild, "from": from, "channel_id": channel_id, "message_id": mid, "party": party }),
            )
            .await;
        }
    }
    Ok(card)
}

/// The DM between two people, made if needed (the invite is reason enough to start one).
async fn dm_with(state: &Shared, a: &str, b: &str) -> ApiResult<String> {
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT x.channel_id FROM dm_members x JOIN dm_members y ON x.channel_id = y.channel_id
         JOIN channels c ON c.id = x.channel_id AND c.kind = 'dm'
         WHERE x.user_id = ? AND y.user_id = ? LIMIT 1",
    )
    .bind(a)
    .bind(b)
    .fetch_optional(&state.db)
    .await?;
    if let Some(c) = existing {
        return Ok(c);
    }
    let c = new_id();
    sqlx::query("INSERT INTO channels (id, guild_id, kind, created_at) VALUES (?, NULL, 'dm', ?)").bind(&c).bind(now_ms()).execute(&state.db).await?;
    for u in [a, b] {
        sqlx::query("INSERT INTO dm_members (channel_id, user_id) VALUES (?,?)").bind(&c).bind(u).execute(&state.db).await?;
    }
    let payload = crate::api::messages::dm_payload(state, &c).await?;
    state.hub.send_users(&[a.to_string(), b.to_string()], "CHANNEL_CREATE", &payload);
    Ok(c)
}

#[derive(Deserialize)]
pub struct InvitePeople {
    pub user_ids: Vec<String>,
}

/// POST /api/guilds/{gid}/invite-people {user_ids} — one card in each person's DM.
pub async fn invite_people(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, headers: HeaderMap, Json(req): Json<InvitePeople>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::CREATE_INVITE).await?;
    if auth.is_kid {
        return Err(AppError::forbidden_msg("Ask a parent to invite people."));
    }
    let mut sent = vec![];
    let mut skipped = vec![];
    for u in req.user_ids.into_iter().take(25) {
        if !may_invite(&state, &auth.id, &u).await || is_banned(&state, &gid, &u).await {
            skipped.push(json!({ "user_id": u, "why": "can't be invited" }));
            continue;
        }
        if is_member(&state, &gid, &u).await {
            skipped.push(json!({ "user_id": u, "why": "already in the server" }));
            continue;
        }
        let dm = dm_with(&state, &auth.id, &u).await?;
        let card = post_card(&state, &auth, headers.clone(), &dm, &gid, false, &[u.clone()]).await?;
        sent.push(json!({ "user_id": u, "card_id": card, "channel_id": dm }));
    }
    Ok(Json(json!({ "sent": sent, "skipped": skipped })))
}

#[derive(Deserialize)]
pub struct InviteParty {
    pub party_id: String,
}

/// POST /api/guilds/{gid}/invite-party {party_id} — one card in the party's chat.
pub async fn invite_party(State(state): State<Shared>, auth: AuthUser, Path(gid): Path<String>, headers: HeaderMap, Json(req): Json<InviteParty>) -> ApiResult<Json<Value>> {
    require_guild(&state.db, &gid, &auth.id, perms::CREATE_INVITE).await?;
    if auth.is_kid {
        return Err(AppError::forbidden_msg("Ask a parent to invite people."));
    }
    let ch = load_channel(&state.db, &req.party_id).await?;
    let members: Vec<String> = sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id = ?").bind(&ch.id).fetch_all(&state.db).await?;
    if ch.kind != "party" || !members.contains(&auth.id) {
        return Err(AppError::not_found());
    }
    let mut people = vec![];
    for u in members.into_iter().filter(|u| *u != auth.id) {
        // kids only through their own parent; nobody who's banned there
        if crate::kids::is_kid(&state, &u).await && !crate::kids::is_guardian(&state, &u, &auth.id).await {
            continue;
        }
        if is_banned(&state, &gid, &u).await {
            continue;
        }
        people.push(u);
    }
    if people.is_empty() {
        return Err(AppError::bad("nobody in that party can be invited"));
    }
    let card = post_card(&state, &auth, headers, &ch.id, &gid, true, &people).await?;
    Ok(Json(json!({ "card_id": card, "channel_id": ch.id })))
}

struct Card {
    guild_id: String,
    inviter_id: String,
    channel_id: String,
    party: bool,
}

async fn load_card(state: &Shared, id: &str) -> ApiResult<Card> {
    let r: Option<(String, String, String, bool)> =
        sqlx::query_as("SELECT guild_id, inviter_id, channel_id, party FROM invite_cards WHERE id = ?").bind(id).fetch_optional(&state.db).await?;
    let (guild_id, inviter_id, channel_id, party) = r.ok_or_else(AppError::not_found)?;
    Ok(Card { guild_id, inviter_id, channel_id, party })
}

async fn in_chat(state: &Shared, cid: &str, uid: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM dm_members WHERE channel_id = ? AND user_id = ?").bind(cid).bind(uid).fetch_optional(&state.db).await.ok().flatten().is_some()
}

/// The card's live state, as `viewer` sees it.
async fn card_json(state: &Shared, id: &str, c: &Card, viewer: &str) -> ApiResult<Value> {
    let mut guild = crate::api::notifications::guild_brief(state, &c.guild_id).await;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM members WHERE guild_id = ?").bind(&c.guild_id).fetch_one(&state.db).await?;
    guild["member_count"] = json!(count);
    let rows: Vec<(String, Option<i64>, Option<i64>, Option<i64>)> =
        sqlx::query_as("SELECT user_id, joined_at, declined_at, reminded_at FROM invite_card_people WHERE card_id = ?").bind(id).fetch_all(&state.db).await?;
    let mut people = vec![];
    let mut mine = Value::Null;
    for (u, joined_at, declined_at, reminded_at) in rows {
        let joined = joined_at.is_some() || is_member(state, &c.guild_id, &u).await;
        let seen: Option<i64> = sqlx::query_scalar("SELECT read_at FROM notifications WHERE user_id = ? AND ref_id = ? AND kind = 'server_invite' ORDER BY created_at LIMIT 1")
            .bind(&u)
            .bind(id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
        let p = json!({
            "user": crate::api::notifications::who(state, &u).await,
            "joined": joined, "declined": declined_at.is_some() && !joined,
            "seen": seen.is_some() || joined || declined_at.is_some(), "reminded": reminded_at.is_some(),
        });
        if u == viewer {
            mine = p.clone();
        }
        people.push(p);
    }
    Ok(json!({
        "id": id, "guild": guild, "party": c.party, "channel_id": c.channel_id,
        "inviter": crate::api::notifications::who(state, &c.inviter_id).await,
        "people": people, "me": mine, "is_inviter": c.inviter_id == viewer,
    }))
}

async fn may_see(state: &Shared, c: &Card, uid: &str) -> bool {
    c.inviter_id == uid || in_chat(state, &c.channel_id, uid).await
}

/// Tell everyone in the card's chat that it changed.
async fn changed(state: &Shared, id: &str, c: &Card) {
    let members: Vec<String> = sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id = ?").bind(&c.channel_id).fetch_all(&state.db).await.unwrap_or_default();
    state.hub.send_users(&members, "INVITE_CARD_UPDATE", &json!({ "card_id": id }));
}

/// GET /api/invite-cards/{id} — also counts as seeing it.
pub async fn get(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let c = load_card(&state, &id).await?;
    if !may_see(&state, &c, &auth.id).await {
        return Err(AppError::not_found());
    }
    let unseen: Option<i64> = sqlx::query_scalar("SELECT 1 FROM notifications WHERE user_id = ? AND ref_id = ? AND kind = 'server_invite' AND read_at IS NULL LIMIT 1")
        .bind(&auth.id)
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
    if unseen.is_some() {
        crate::api::notifications::read_ref(&state, &auth.id, &id).await;
        changed(&state, &id, &c).await;
    }
    Ok(Json(card_json(&state, &id, &c, &auth.id).await?))
}

async fn invited(state: &Shared, id: &str, uid: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM invite_card_people WHERE card_id = ? AND user_id = ?").bind(id).bind(uid).fetch_optional(&state.db).await.ok().flatten().is_some()
}

/// POST /api/invite-cards/{id}/join
pub async fn join(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let c = load_card(&state, &id).await?;
    if !invited(&state, &id, &auth.id).await {
        return Err(AppError::forbidden_msg("this invite isn't for you"));
    }
    // a kid's card can only come from their parent (checked when it was sent), so no
    // extra approval is needed; the parent must still be in the server
    if auth.is_kid {
        if !crate::kids::is_guardian(&state, &auth.id, &c.inviter_id).await || !is_member(&state, &c.guild_id, &c.inviter_id).await {
            return Err(AppError::forbidden_msg("Ask a parent to invite you."));
        }
    } else if !is_member(&state, &c.guild_id, &c.inviter_id).await {
        // the inviter left: the invite no longer stands
        return Err(AppError::bad("this invite has ended (the person who sent it isn't in the server anymore)"));
    }
    crate::api::guilds::add_member(&state, &c.guild_id, &auth.id).await?;
    sqlx::query("UPDATE invite_card_people SET joined_at = COALESCE(joined_at, ?) WHERE card_id = ? AND user_id = ?").bind(now_ms()).bind(&id).bind(&auth.id).execute(&state.db).await?;
    crate::api::notifications::clear_ref(&state, &auth.id, "server_invite", &id).await;
    if !c.party {
        let guild = crate::api::notifications::guild_brief(&state, &c.guild_id).await;
        let by = crate::api::notifications::who(&state, &auth.id).await;
        crate::api::notifications::notify(&state, &c.inviter_id, "invite_accepted", Some(&id), json!({ "card_id": id, "guild": guild, "by": by })).await;
    }
    changed(&state, &id, &c).await;
    Ok(Json(json!({ "guild_id": c.guild_id, "card": card_json(&state, &id, &c, &auth.id).await? })))
}

/// Someone joined a server (by any route: a card, a link, a parent): every invite card to it
/// counts them as joined, and their invite notifications for it go away.
pub async fn joined_guild(state: &Shared, gid: &str, uid: &str) {
    let cards: Vec<(String, String)> = sqlx::query_as(
        "SELECT c.id, c.channel_id FROM invite_cards c JOIN invite_card_people p ON p.card_id = c.id WHERE c.guild_id = ? AND p.user_id = ?",
    )
    .bind(gid)
    .bind(uid)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    for (card, channel) in cards {
        let _ = sqlx::query("UPDATE invite_card_people SET joined_at = COALESCE(joined_at, ?) WHERE card_id = ? AND user_id = ?").bind(now_ms()).bind(&card).bind(uid).execute(&state.db).await;
        crate::api::notifications::clear_ref(state, uid, "server_invite", &card).await;
        let members: Vec<String> = sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id = ?").bind(&channel).fetch_all(&state.db).await.unwrap_or_default();
        state.hub.send_users(&members, "INVITE_CARD_UPDATE", &json!({ "card_id": card }));
    }
}

/// POST /api/invite-cards/{id}/decline
pub async fn decline(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let c = load_card(&state, &id).await?;
    if !invited(&state, &id, &auth.id).await {
        return Err(AppError::forbidden());
    }
    sqlx::query("UPDATE invite_card_people SET declined_at = ? WHERE card_id = ? AND user_id = ? AND joined_at IS NULL").bind(now_ms()).bind(&id).bind(&auth.id).execute(&state.db).await?;
    crate::api::notifications::clear_ref(&state, &auth.id, "server_invite", &id).await;
    changed(&state, &id, &c).await;
    Ok(Json(card_json(&state, &id, &c, &auth.id).await?))
}

/// POST /api/invite-cards/{id}/remind/{uid} — the inviter nudges someone once.
pub async fn remind(State(state): State<Shared>, auth: AuthUser, Path((id, uid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let c = load_card(&state, &id).await?;
    if c.inviter_id != auth.id {
        return Err(AppError::forbidden_msg("only the person who sent the invite can remind people"));
    }
    if !invited(&state, &id, &uid).await || is_member(&state, &c.guild_id, &uid).await {
        return Err(AppError::bad("they don't need a reminder"));
    }
    let r = sqlx::query("UPDATE invite_card_people SET reminded_at = ? WHERE card_id = ? AND user_id = ? AND reminded_at IS NULL AND declined_at IS NULL")
        .bind(now_ms())
        .bind(&id)
        .bind(&uid)
        .execute(&state.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(AppError::bad("they've already been reminded (or said no thanks)"));
    }
    let guild = crate::api::notifications::guild_brief(&state, &c.guild_id).await;
    let from = crate::api::notifications::who(&state, &auth.id).await;
    let mid: Option<String> = sqlx::query_scalar("SELECT message_id FROM invite_cards WHERE id = ?").bind(&id).fetch_one(&state.db).await?;
    crate::api::notifications::notify_once(
        &state,
        &uid,
        "server_invite",
        &id,
        json!({ "card_id": id, "guild": guild, "from": from, "channel_id": c.channel_id, "message_id": mid, "party": c.party, "reminder": true }),
    )
    .await;
    changed(&state, &id, &c).await;
    Ok(Json(card_json(&state, &id, &c, &auth.id).await?))
}
