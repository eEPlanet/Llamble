//! The demo account, for app store reviewers (and anyone the admin wants to show Llamble to).
//!
//! An admin turns it on in Settings → Demo account. That makes a sandbox on this same
//! instance: one sign-in for the reviewer plus a few made-up people, in a made-up server with
//! chats, notes and news. The sandbox is sealed off in both directions:
//!  - demo accounts can't see, find, friend, message, invite or call anyone outside it, can't
//!    join other servers, and get no instance news, Discover, kids or admin pages;
//!  - nobody outside it can see, find, friend, message, invite or call demo accounts, and the
//!    demo server never shows up in Discover.
//! Everything else is the real app (real calls, rooms, notifications), so reviewers can test
//! what the app's permissions are for. Its content is rebuilt every night; the sign-in stays.
use crate::api::{guilds, messages, news, notes, social};
use crate::error::{new_id, now_ms, ApiResult, AppError};
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, State};
use axum::Json;
use dashmap::DashSet;
use once_cell::sync::Lazy;
use serde_json::{json, Value};

/// Ids of the demo accounts (the reviewer and the made-up people).
static DEMO: Lazy<DashSet<String>> = Lazy::new(DashSet::new);

const REVIEWER: &str = "llamble-demo";
/// (username, display name) of the made-up people
const PEOPLE: [(&str, &str); 4] = [("demo-maya", "Maya"), ("demo-sam", "Sam"), ("demo-theo", "Theo"), ("demo-lena", "Lena")];

pub fn is_demo(uid: &str) -> bool {
    DEMO.contains(uid)
}

/// Are these two in different worlds (one in the demo sandbox, one not)? Bots (the instance's
/// AI) belong to both.
pub fn apart(state: &Shared, a: &str, b: &str) -> bool {
    if a == state.bot_id || b == state.bot_id {
        return false;
    }
    is_demo(a) != is_demo(b)
}

/// What a demo account may never use at all (checked on every request it makes).
pub fn blocked(method: &axum::http::Method, path: &str) -> Option<&'static str> {
    let p = path.trim_end_matches('/');
    let starts = |s: &str| p == s || p.starts_with(&format!("{s}/"));
    if starts("/api/discover") || starts("/api/admin") || starts("/api/kids") || starts("/api/invites") || starts("/api/invite-cards") || starts("/api/remote") {
        return Some("that isn't available on the demo account");
    }
    if p.starts_with("/api/guilds/") && (p.contains("/invite") || p.ends_with("/invites") || p.contains("/join-requests")) {
        return Some("the demo account can't invite people");
    }
    if p == "/api/news" && method != axum::http::Method::GET {
        return Some("that isn't available on the demo account");
    }
    None
}

/// Load who's in the sandbox (at startup).
pub async fn load(state: &Shared) {
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM users WHERE demo = 1").fetch_all(&state.db).await.unwrap_or_default();
    DEMO.clear();
    for id in ids {
        DEMO.insert(id);
    }
}

async fn saved(state: &Shared) -> Value {
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'demo'").fetch_optional(&state.db).await.ok().flatten();
    v.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_else(|| json!({ "enabled": false }))
}

async fn save(state: &Shared, v: &Value) {
    let _ = sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('demo', ?)").bind(v.to_string()).execute(&state.db).await;
}

fn as_user(id: &str) -> AuthUser {
    // made-up people act through the normal handlers; admin rights only so the demo server
    // can be made where only admins may create servers (they never sign in)
    AuthUser { id: id.to_string(), is_admin: true, is_master: false, is_kid: false, token_hash: String::new() }
}

fn password() -> String {
    // easy to type on a phone: three short words and a number
    const W: [&str; 24] = ["lake", "dock", "kayak", "pine", "maple", "otter", "canoe", "cabin", "trail", "river", "cloud", "ember", "bison", "cedar", "fern", "loon", "moss", "pebble", "quail", "reed", "sage", "thrush", "wren", "zinnia"];
    use rand::Rng;
    let mut r = rand::thread_rng();
    let b: [u8; 4] = [r.gen(), r.gen(), r.gen(), r.gen()];
    format!("{}-{}-{}-{}", W[b[0] as usize % 24], W[b[1] as usize % 24], W[b[2] as usize % 24], 10 + b[3] as usize % 90)
}

/// Make (or find) a demo account. The reviewer's password is set each time it's made, so a
/// reviewer who deleted the account gets it back the next night.
async fn ensure_user(state: &Shared, username: &str, display: &str, pw: &str, reviewer: bool) -> ApiResult<String> {
    let hash = crate::api::auth::hash_password(pw.to_string()).await?;
    // the same account each time: remembered by name (even if a reviewer deleted it, which
    // renames it to "Deleted User"), so the reviewer's sign-in stays the same
    let known: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'demo-' || ?").bind(username).fetch_optional(&state.db).await?;
    let id: Option<String> = match known {
        Some(k) => sqlx::query_scalar("SELECT id FROM users WHERE id = ? AND demo = 1").bind(k).fetch_optional(&state.db).await?,
        None => None,
    };
    let id = match id {
        Some(id) => {
            sqlx::query("UPDATE users SET username = ?, display_name = ?, password_hash = ?, is_admin = 0 WHERE id = ?").bind(username).bind(display).bind(&hash).bind(&id).execute(&state.db).await?;
            id
        }
        None => {
            let taken: Option<i64> = sqlx::query_scalar("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").bind(username).fetch_optional(&state.db).await?;
            if taken.is_some() {
                return Err(AppError::bad(format!("someone already uses the name \"{username}\"; rename them to turn on the demo")));
            }
            let id = new_id();
            sqlx::query("INSERT INTO users (id, username, display_name, password_hash, is_admin, is_bot, created_at, demo) VALUES (?,?,?,?,0,0,?,1)")
                .bind(&id)
                .bind(username)
                .bind(display)
                .bind(&hash)
                .bind(now_ms())
                .execute(&state.db)
                .await?;
            id
        }
    };
    // the made-up people never see the tutorial; the reviewer is offered it like anyone new
    sqlx::query("UPDATE users SET demo = 1, tutorial_at = ? WHERE id = ?").bind(if reviewer { None } else { Some(now_ms()) }).bind(&id).execute(&state.db).await?;
    let _ = sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('demo-' || ?, ?)").bind(username).bind(&id).execute(&state.db).await;
    DEMO.insert(id.clone());
    Ok(id)
}

/// Take the demo content away (the accounts stay, sealed off).
async fn wipe(state: &Shared) {
    let ids: Vec<String> = DEMO.iter().map(|e| e.key().clone()).collect();
    if ids.is_empty() {
        return;
    }
    let list = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    // servers the demo people own (the demo server, and any a reviewer made)
    let q = format!("SELECT id FROM guilds WHERE owner_id IN ({list})");
    let mut qq = sqlx::query_scalar::<_, String>(&q);
    for i in &ids {
        qq = qq.bind(i);
    }
    for gid in qq.fetch_all(&state.db).await.unwrap_or_default() {
        let owner: String = sqlx::query_scalar("SELECT owner_id FROM guilds WHERE id = ?").bind(&gid).fetch_one(&state.db).await.unwrap_or_default();
        let _ = guilds::delete_guild(State(state.clone()), as_user(&owner), Path(gid)).await;
    }
    // their chats with each other
    let q = format!("SELECT DISTINCT channel_id FROM dm_members WHERE user_id IN ({list})");
    let mut qq = sqlx::query_scalar::<_, String>(&q);
    for i in &ids {
        qq = qq.bind(i);
    }
    for cid in qq.fetch_all(&state.db).await.unwrap_or_default() {
        let _ = sqlx::query("DELETE FROM channels WHERE id = ?").bind(&cid).execute(&state.db).await;
    }
    for (table, col) in [("friends", "user_id"), ("friends", "other_id"), ("notifications", "user_id"), ("members", "user_id")] {
        let q = format!("DELETE FROM {table} WHERE {col} IN ({list})");
        let mut qq = sqlx::query(&q);
        for i in &ids {
            qq = qq.bind(i);
        }
        let _ = qq.execute(&state.db).await;
    }
    for id in &ids {
        state.hub.kick_user(id);
    }
}

async fn say(state: &Shared, who: &str, cid: &str, text: &str) {
    let body: messages::CreateMsg = serde_json::from_value(json!({ "content": text })).unwrap();
    let _ = messages::create_message(State(state.clone()), as_user(who), Path(cid.to_string()), axum::http::HeaderMap::new(), Json(body)).await;
}

/// Build the demo world: the made-up people, their server, chats, notes and news, and the
/// reviewer as their friend.
async fn build(state: &Shared, reviewer_pw: &str) -> ApiResult<String> {
    let me = ensure_user(state, REVIEWER, "Demo", reviewer_pw, true).await?;
    let mut people = vec![];
    for (u, d) in PEOPLE {
        people.push(ensure_user(state, u, d, &password(), false).await?);
    }
    let (maya, sam, theo, lena) = (&people[0], &people[1], &people[2], &people[3]);
    let g = guilds::create_guild(State(state.clone()), as_user(maya), Json(guilds::CreateGuild { name: "The Lake House".into() })).await?.0;
    let gid = g["guild"]["id"].as_str().unwrap_or_default().to_string();
    for u in [sam, theo, lena, &me] {
        guilds::add_member(state, &gid, u).await?;
    }
    let chans = guilds::guild_payload(state, &gid).await?;
    let general = chans["channels"].as_array().and_then(|a| a.iter().find(|c| c["kind"] == "text")).and_then(|c| c["id"].as_str()).unwrap_or_default().to_string();
    if state.s().watch_party {
        let req: guilds::CreateChannel = serde_json::from_value(json!({ "name": "Movie Night", "kind": "watch" })).unwrap();
        let _ = guilds::create_channel(State(state.clone()), as_user(maya), Path(gid.clone()), Json(req)).await;
    }
    say(state, sam, &general, "Movie night Friday? I'll bring popcorn 🍿").await;
    say(state, maya, &general, "Yes! I set up a **Watch Party** room, add what you want to watch to the queue").await;
    say(state, theo, &general, "Dock's fixed, kayaks are out of storage 🛶").await;
    say(state, lena, &general, "Welcome to The Lake House! Try a voice room, or call one of us from Friends.").await;
    for (who, text, color) in [(lena, "Trash goes out Thursday night 🗑️", "yellow"), (theo, "Boat keys are on the hook by the back door", "blue"), (maya, "Family dinner Sunday at 6, bring a dish!", "pink")] {
        let req: notes::CreateNote = serde_json::from_value(json!({ "content": text, "color": color })).unwrap();
        let _ = notes::create(State(state.clone()), as_user(who), Path(gid.clone()), Json(req)).await;
    }
    let post: news::PostReq = serde_json::from_value(json!({ "title": "Summer at the lake", "body": "The dock is fixed, the kayaks are out of storage and Movie Night is every Friday. See you there!" })).unwrap();
    let _ = news::create_guild(State(state.clone()), as_user(maya), Path(gid.clone()), Json(post)).await;
    // friends with Maya and Sam, and a chat from Sam
    for f in [maya, sam] {
        let req: social::AddFriend = serde_json::from_value(json!({ "user_id": me })).unwrap();
        let _ = social::add_friend(State(state.clone()), as_user(f), Json(req)).await;
        let _ = social::accept_friend(State(state.clone()), as_user(&me), Path(f.to_string())).await;
    }
    let dm = messages::open_dm(State(state.clone()), as_user(sam), Json(messages::OpenDm { recipient_id: me.clone() })).await?.0;
    if let Some(cid) = dm["id"].as_str() {
        say(state, sam, cid, "Hey! Give me a call any time. If I don't pick up, leave a voicemail 📞").await;
    }
    Ok(me)
}

// ---------------------------------------------------------------- admin

async fn require_admin(auth: &AuthUser) -> ApiResult<()> {
    if auth.is_admin && !is_demo(&auth.id) {
        Ok(())
    } else {
        Err(AppError::forbidden())
    }
}

fn view(v: &Value) -> Value {
    json!({ "enabled": v["enabled"].as_bool().unwrap_or(false), "username": REVIEWER, "password": v["password"], "reset_at": v["reset_at"] })
}

/// GET /api/admin/demo
pub async fn get(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    require_admin(&auth).await?;
    Ok(Json(view(&saved(&state).await)))
}

#[derive(serde::Deserialize)]
pub struct SetDemo {
    pub enabled: bool,
}

/// PUT /api/admin/demo {enabled}: turn the demo on (builds it) or off (takes it away and
/// signs the demo accounts out for good).
pub async fn set(State(state): State<Shared>, auth: AuthUser, Json(req): Json<SetDemo>) -> ApiResult<Json<Value>> {
    require_admin(&auth).await?;
    let mut v = saved(&state).await;
    wipe(&state).await;
    if req.enabled {
        let pw = v["password"].as_str().map(str::to_string).unwrap_or_else(password);
        build(&state, &pw).await?;
        v = json!({ "enabled": true, "password": pw, "reset_at": now_ms() });
    } else {
        let _ = sqlx::query("UPDATE users SET password_hash = '!' WHERE demo = 1").execute(&state.db).await;
        let _ = sqlx::query("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE demo = 1)").execute(&state.db).await;
        v = json!({ "enabled": false, "password": v["password"] });
    }
    save(&state, &v).await;
    Ok(Json(view(&v)))
}

/// POST /api/admin/demo/reset: rebuild its content now (same sign-in).
pub async fn reset(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    require_admin(&auth).await?;
    let mut v = saved(&state).await;
    if v["enabled"] != true {
        return Err(AppError::bad("the demo account is off"));
    }
    wipe(&state).await;
    build(&state, v["password"].as_str().unwrap_or_default()).await?;
    v["reset_at"] = json!(now_ms());
    save(&state, &v).await;
    Ok(Json(view(&v)))
}

/// Every night: put the demo back the way it started (whatever a reviewer did to it).
pub fn spawn_nightly(state: Shared) {
    tokio::spawn(async move {
        load(&state).await;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(600)).await;
            let mut v = saved(&state).await;
            if v["enabled"] == true && now_ms() - v["reset_at"].as_i64().unwrap_or(0) > 24 * 3600 * 1000 {
                wipe(&state).await;
                if build(&state, v["password"].as_str().unwrap_or_default()).await.is_ok() {
                    v["reset_at"] = json!(now_ms());
                    save(&state, &v).await;
                }
            }
        }
    });
}
