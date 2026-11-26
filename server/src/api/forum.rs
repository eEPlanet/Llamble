//! Forum spaces.
//!
//! A forum post and its replies are ordinary messages in a "forum" space, so attachments,
//! @mentions, link previews, editing, deleting, blocking, reporting and search all work the same
//! as chat. Each one also has a `forum_items` row:
//! - a post: its title and tags (thread_id is NULL), and the best answer if one was picked;
//! - a reply: the post it belongs to (thread_id), what it replies to (the message's own
//!   reply_to: NULL or the post = a reply to the post; another reply = a branch under it), and
//!   what it quotes (quoted replies don't branch; they show inside the reply with a jump link).
//!
//! Everything stays in time order. Likes are ❤️ reactions and never move anything; the apps
//! make busy posts glow instead. Following a post notifies you of new replies (its writer
//! follows it automatically).
use crate::error::{now_ms, ApiResult, AppError};
use crate::models::{load_channel, load_message, Channel};
use crate::perms::{self, require_channel};
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

pub const LIKE: &str = "❤️";

pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS forum_items (
            message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            channel_id TEXT NOT NULL,
            thread_id TEXT,                 -- NULL: a post; else the post this reply belongs to
            title TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',
            quotes TEXT NOT NULL DEFAULT '[]',
            best_reply_id TEXT
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_forum_thread ON forum_items(thread_id)").execute(pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_forum_channel ON forum_items(channel_id, thread_id)").execute(pool).await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS forum_follows (
            post_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL,
            PRIMARY KEY (post_id, user_id)
        )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// What a forum message carries besides the message itself (from the create request).
pub struct ForumIn {
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub thread_id: Option<String>,
    pub quotes: Vec<String>,
}

/// Checked forum parts of a new message, ready to store.
pub struct ForumOk {
    pub thread_id: Option<String>,
    pub title: String,
    pub tags: Vec<String>,
    pub quotes: Vec<String>,
}

fn clean_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for t in tags {
        let t: String = t.trim().trim_start_matches('#').chars().filter(|c| !c.is_control()).take(24).collect();
        if !t.is_empty() && !out.iter().any(|o| o.eq_ignore_ascii_case(&t)) {
            out.push(t);
        }
        if out.len() >= 5 {
            break;
        }
    }
    out
}

/// Is this message a post (not a reply) in this forum?
async fn is_post(state: &Shared, cid: &str, mid: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM forum_items WHERE message_id = ? AND channel_id = ? AND thread_id IS NULL")
        .bind(mid).bind(cid).fetch_optional(&state.db).await.ok().flatten().is_some()
}

/// Is this message the post itself or one of its replies?
async fn in_thread(state: &Shared, post: &str, mid: &str) -> bool {
    mid == post
        || sqlx::query_scalar::<_, i64>("SELECT 1 FROM forum_items WHERE message_id = ? AND thread_id = ?")
            .bind(mid).bind(post).fetch_optional(&state.db).await.ok().flatten().is_some()
}

/// Check the forum parts of a new message in a forum space. `reply_to` is the message's own
/// reply_to (already checked to be in this channel).
pub async fn check(state: &Shared, ch: &Channel, f: ForumIn, reply_to: &Option<String>) -> ApiResult<ForumOk> {
    match f.thread_id {
        None => {
            let title: String = f.title.unwrap_or_default().trim().chars().filter(|c| !c.is_control()).take(200).collect();
            if title.is_empty() {
                return Err(AppError::bad("a post needs a title"));
            }
            if reply_to.is_some() {
                return Err(AppError::bad("a new post can't be a reply"));
            }
            Ok(ForumOk { thread_id: None, title, tags: clean_tags(&f.tags), quotes: vec![] })
        }
        Some(t) => {
            if !is_post(state, &ch.id, &t).await {
                return Err(AppError::bad("that post isn't in this forum"));
            }
            if let Some(r) = reply_to {
                if !in_thread(state, &t, r).await {
                    return Err(AppError::bad("you can only reply to something in the same post"));
                }
            }
            let mut quotes = vec![];
            for q in f.quotes.iter().take(10) {
                if !quotes.contains(q) && in_thread(state, &t, q).await {
                    quotes.push(q.clone());
                }
            }
            Ok(ForumOk { thread_id: Some(t), title: String::new(), tags: vec![], quotes })
        }
    }
}

/// Store a checked forum message (inside create_message's transaction).
pub async fn store(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, mid: &str, cid: &str, f: &ForumOk) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO forum_items (message_id, channel_id, thread_id, title, tags, quotes) VALUES (?,?,?,?,?,?)")
        .bind(mid).bind(cid).bind(&f.thread_id).bind(&f.title).bind(json!(f.tags).to_string()).bind(json!(f.quotes).to_string())
        .execute(&mut **tx).await?;
    Ok(())
}

/// The forum parts to put on a message's payload ({} for chat messages).
pub async fn parts(state: &Shared, mid: &str) -> Option<Value> {
    let r: Option<(Option<String>, String, String, String, Option<String>)> =
        sqlx::query_as("SELECT thread_id, title, tags, quotes, best_reply_id FROM forum_items WHERE message_id = ?").bind(mid).fetch_optional(&state.db).await.ok().flatten();
    r.map(|(thread, title, tags, quotes, best)| {
        json!({
            "thread_id": thread, "title": title,
            "tags": serde_json::from_str::<Value>(&tags).unwrap_or(json!([])),
            "quotes": serde_json::from_str::<Value>(&quotes).unwrap_or(json!([])),
            "best_reply_id": best,
        })
    })
}

/// After a forum message is created: the writer of a post follows it; a reply tells the
/// post's followers (other than the writer, and whoever was replied to, who already hears).
pub async fn created(state: &Shared, ch: &Channel, mid: &str, author: &str, f: &ForumOk, replied_to: Option<&str>, preview: &str) {
    match &f.thread_id {
        None => {
            let _ = sqlx::query("INSERT OR IGNORE INTO forum_follows (post_id, user_id) VALUES (?,?)").bind(mid).bind(author).execute(&state.db).await;
        }
        Some(post) => {
            let title: String = sqlx::query_scalar("SELECT title FROM forum_items WHERE message_id = ?").bind(post).fetch_one(&state.db).await.unwrap_or_default();
            let followers: Vec<String> = sqlx::query_scalar("SELECT user_id FROM forum_follows WHERE post_id = ?").bind(post).fetch_all(&state.db).await.unwrap_or_default();
            let audience = crate::state::channel_audience(&state.db, ch).await;
            let from = crate::api::notifications::who(state, author).await;
            let guild = match &ch.guild_id {
                Some(g) => crate::api::notifications::guild_brief(state, g).await,
                None => Value::Null,
            };
            let preview: String = preview.chars().take(140).collect();
            for u in followers {
                if u == author || Some(u.as_str()) == replied_to || !audience.contains(&u) || crate::api::safety::blocked_either(state, &u, author).await {
                    continue;
                }
                crate::api::notifications::notify(
                    state,
                    &u,
                    "forum_reply",
                    Some(mid),
                    json!({ "post_id": post, "message_id": mid, "channel_id": ch.id, "channel_name": ch.name, "title": title, "from": from, "preview": preview, "guild": guild }),
                )
                .await;
            }
        }
    }
}

/// Deleting a post deletes its replies too.
pub async fn delete_thread(state: &Shared, mid: &str) {
    let replies: Vec<String> = sqlx::query_scalar("SELECT message_id FROM forum_items WHERE thread_id = ?").bind(mid).fetch_all(&state.db).await.unwrap_or_default();
    for r in replies {
        crate::api::notifications::forget_message(state, &r).await;
        let _ = sqlx::query("DELETE FROM messages WHERE id = ?").bind(&r).execute(&state.db).await;
    }
}

#[derive(Deserialize)]
pub struct ListQ {
    /// all | unanswered | solved | following | media (posts with pictures or videos)
    pub filter: Option<String>,
    pub tag: Option<String>,
    /// posts older than this message id (paging)
    pub before: Option<String>,
}

async fn post_card(state: &Shared, uid: &str, mid: &str) -> Option<Value> {
    let m = load_message(&state.db, mid).await.ok()?;
    let f = parts(state, mid).await?;
    let (replies, last): (i64, Option<i64>) = sqlx::query_as("SELECT COUNT(*), MAX(m.created_at) FROM forum_items f JOIN messages m ON m.id = f.message_id WHERE f.thread_id = ?")
        .bind(mid).fetch_one(&state.db).await.ok()?;
    let likes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reactions WHERE message_id = ? AND emoji = ?").bind(mid).bind(LIKE).fetch_one(&state.db).await.unwrap_or(0);
    let liked = sqlx::query_scalar::<_, i64>("SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ? AND user_id = ?").bind(mid).bind(LIKE).bind(uid).fetch_optional(&state.db).await.ok().flatten().is_some();
    let following = sqlx::query_scalar::<_, i64>("SELECT 1 FROM forum_follows WHERE post_id = ? AND user_id = ?").bind(mid).bind(uid).fetch_optional(&state.db).await.ok().flatten().is_some();
    let mut v = serde_json::to_value(&m).ok()?;
    v["forum"] = f;
    v["reply_count"] = json!(replies);
    v["last_activity"] = json!(last.unwrap_or(m.created_at));
    v["likes"] = json!(likes);
    v["liked"] = json!(liked);
    v["following"] = json!(following);
    Some(v)
}

/// GET /api/channels/{cid}/forum: the posts, newest first.
pub async fn list(State(state): State<Shared>, auth: AuthUser, Path(cid): Path<String>, Query(q): Query<ListQ>) -> ApiResult<Json<Value>> {
    let ch = forum_channel(&state, &cid, &auth).await?;
    let filter = match q.filter.as_deref().unwrap_or("all") {
        "unanswered" => " AND NOT EXISTS (SELECT 1 FROM forum_items r WHERE r.thread_id = f.message_id)",
        "solved" => " AND f.best_reply_id IS NOT NULL",
        "media" => " AND EXISTS (SELECT 1 FROM message_attachments ma JOIN files fl ON fl.id = ma.file_id WHERE ma.message_id = f.message_id AND (fl.mime LIKE 'image/%' OR fl.mime LIKE 'video/%'))",
        "following" => " AND EXISTS (SELECT 1 FROM forum_follows w WHERE w.post_id = f.message_id AND w.user_id = ?3)",
        _ => " AND ?3 IS NOT NULL",
    };
    let sql = format!(
        "SELECT f.message_id FROM forum_items f WHERE f.channel_id = ?1 AND f.thread_id IS NULL{filter}
         AND (?2 = '' OR f.message_id < ?2)
         AND (?4 = '' OR EXISTS (SELECT 1 FROM json_each(f.tags) j WHERE lower(j.value) = lower(?4)))
         ORDER BY f.message_id DESC LIMIT 50"
    );
    let ids: Vec<String> = sqlx::query_scalar(&sql)
        .bind(&ch.id)
        .bind(q.before.clone().unwrap_or_default())
        .bind(&auth.id)
        .bind(q.tag.clone().unwrap_or_default())
        .fetch_all(&state.db)
        .await?;
    let mut out = vec![];
    for id in ids {
        if let Some(c) = post_card(&state, &auth.id, &id).await {
            out.push(c);
        }
    }
    let tags: Vec<String> = sqlx::query_scalar("SELECT DISTINCT j.value FROM forum_items f, json_each(f.tags) j WHERE f.channel_id = ? AND f.thread_id IS NULL ORDER BY j.value LIMIT 50")
        .bind(&ch.id).fetch_all(&state.db).await.unwrap_or_default();
    Ok(Json(json!({ "posts": out, "tags": tags })))
}

async fn forum_channel(state: &Shared, cid: &str, auth: &AuthUser) -> ApiResult<Channel> {
    let ch = load_channel(&state.db, cid).await?;
    if ch.kind != "forum" {
        return Err(AppError::bad("that isn't a forum"));
    }
    require_channel(&state.db, &ch, &auth.id, perms::VIEW).await?;
    Ok(ch)
}

/// GET /api/channels/{cid}/forum/{pid}: a post and all its replies (in time order; the apps
/// build the branches from each reply's reply_to).
pub async fn thread(State(state): State<Shared>, auth: AuthUser, Path((cid, pid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let ch = forum_channel(&state, &cid, &auth).await?;
    if !is_post(&state, &ch.id, &pid).await {
        return Err(AppError::not_found());
    }
    let post = post_card(&state, &auth.id, &pid).await.ok_or_else(AppError::not_found)?;
    let ids: Vec<String> = sqlx::query_scalar("SELECT message_id FROM forum_items WHERE thread_id = ? ORDER BY message_id").bind(&pid).fetch_all(&state.db).await?;
    let mut replies = vec![];
    for id in ids {
        let Ok(m) = load_message(&state.db, &id).await else { continue };
        let mut v = serde_json::to_value(&m).unwrap_or_default();
        v["forum"] = parts(&state, &id).await.unwrap_or(json!({}));
        v["likes"] = json!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM reactions WHERE message_id = ? AND emoji = ?").bind(&id).bind(LIKE).fetch_one(&state.db).await.unwrap_or(0));
        v["liked"] = json!(sqlx::query_scalar::<_, i64>("SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ? AND user_id = ?").bind(&id).bind(LIKE).bind(&auth.id).fetch_optional(&state.db).await.ok().flatten().is_some());
        replies.push(v);
    }
    // opening a post reads its reply notifications
    let mut ids_read = vec![pid.clone()];
    ids_read.extend(replies.iter().filter_map(|r| r["id"].as_str().map(String::from)));
    for id in ids_read {
        crate::api::notifications::read_ref(&state, &auth.id, &id).await;
    }
    Ok(Json(json!({ "post": post, "replies": replies })))
}

/// PUT / DELETE /api/forum/{pid}/follow
pub async fn follow(State(state): State<Shared>, auth: AuthUser, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    let ch = post_channel(&state, &pid, &auth).await?;
    let _ = ch;
    sqlx::query("INSERT OR IGNORE INTO forum_follows (post_id, user_id) VALUES (?,?)").bind(&pid).bind(&auth.id).execute(&state.db).await?;
    Ok(Json(json!({ "following": true })))
}
pub async fn unfollow(State(state): State<Shared>, auth: AuthUser, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    sqlx::query("DELETE FROM forum_follows WHERE post_id = ? AND user_id = ?").bind(&pid).bind(&auth.id).execute(&state.db).await?;
    Ok(Json(json!({ "following": false })))
}

async fn post_channel(state: &Shared, pid: &str, auth: &AuthUser) -> ApiResult<Channel> {
    let cid: String = sqlx::query_scalar("SELECT channel_id FROM forum_items WHERE message_id = ? AND thread_id IS NULL").bind(pid).fetch_optional(&state.db).await?.ok_or_else(AppError::not_found)?;
    forum_channel(state, &cid, auth).await
}

#[derive(Deserialize)]
pub struct BestReq {
    pub reply_id: Option<String>,
}

/// PUT /api/forum/{pid}/best {reply_id | null}: pick (or clear) the best answer. The post's
/// writer or staff who can manage messages.
pub async fn best(State(state): State<Shared>, auth: AuthUser, Path(pid): Path<String>, Json(req): Json<BestReq>) -> ApiResult<Json<Value>> {
    let ch = post_channel(&state, &pid, &auth).await?;
    let p = require_channel(&state.db, &ch, &auth.id, perms::VIEW).await?;
    let author: String = sqlx::query_scalar("SELECT author_id FROM messages WHERE id = ?").bind(&pid).fetch_one(&state.db).await?;
    if author != auth.id && p & perms::MANAGE_MESSAGES == 0 {
        return Err(AppError::forbidden_msg("only the person who asked, or staff, can pick the best answer"));
    }
    if let Some(r) = &req.reply_id {
        let ok: Option<i64> = sqlx::query_scalar("SELECT 1 FROM forum_items WHERE message_id = ? AND thread_id = ?").bind(r).bind(&pid).fetch_optional(&state.db).await?;
        if ok.is_none() {
            return Err(AppError::bad("that reply isn't in this post"));
        }
    }
    sqlx::query("UPDATE forum_items SET best_reply_id = ? WHERE message_id = ?").bind(&req.reply_id).bind(&pid).execute(&state.db).await?;
    state.emit_channel(&ch, "FORUM_BEST", &json!({ "channel_id": ch.id, "post_id": pid, "reply_id": req.reply_id, "at": now_ms() })).await;
    Ok(Json(json!({ "ok": true, "best_reply_id": req.reply_id })))
}

/// The colors a forum space uses (staff pick them in Edit Space; people can override them for
/// themselves in the apps). `base`: a color for the alternating reply cards ("" = the app's
/// own card colors). `branch`: the set used for each branch level.
pub const BRANCH_SETS: [&str; 5] = ["llamble", "rainbow", "calm", "mono", "contrast"];

pub fn clean_style(v: &Value) -> Value {
    let base = v["base"].as_str().unwrap_or("").trim().to_string();
    let base = if base.len() == 7 && base.starts_with('#') && base[1..].chars().all(|c| c.is_ascii_hexdigit()) { base } else { String::new() };
    let branch = v["branch"].as_str().filter(|b| BRANCH_SETS.contains(b)).unwrap_or("llamble");
    json!({ "base": base, "branch": branch })
}
