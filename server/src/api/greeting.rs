//! Voicemail greetings: what callers hear before the tone.
//!
//! Each person picks one:
//! - **default**: "<name> can't answer right now. Leave a message after the tone."
//! - **voice**: their own words, said by one of the server's voices (Kokoro)
//! - **recorded**: a greeting they recorded themselves
//!
//! Spoken greetings are made on this server and kept as files (made again only when the words
//! or voice change). The default one uses the instance's voice when the voices are downloaded
//! (Settings → Voice AI); without them, the caller's device says it (the fallback).
use crate::error::{now_ms, ApiResult, AppError};
use crate::state::{AuthUser, Shared};
use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_TEXT: usize = 300;
const MAX_RECORDED_BYTES: i64 = 6 * 1024 * 1024;

pub async fn migrate(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    crate::db::add_column(pool, "users", "vm_greeting", "TEXT NOT NULL DEFAULT 'default'").await?;
    crate::db::add_column(pool, "users", "vm_greeting_text", "TEXT NOT NULL DEFAULT ''").await?;
    crate::db::add_column(pool, "users", "vm_greeting_voice", "INTEGER").await?;
    crate::db::add_column(pool, "users", "vm_greeting_file", "TEXT").await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS tts_cache (key TEXT PRIMARY KEY, file_id TEXT NOT NULL, created_at INTEGER NOT NULL)").execute(pool).await?;
    Ok(())
}

fn default_text(name: &str) -> String {
    format!("{name} can't answer right now. Leave a message after the tone.")
}

/// Files anyone may play: greetings.
pub async fn is_greeting_file(state: &Shared, file_id: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 WHERE EXISTS (SELECT 1 FROM tts_cache WHERE file_id = ?1) OR EXISTS (SELECT 1 FROM users WHERE vm_greeting_file = ?1 AND vm_greeting = 'recorded')")
        .bind(file_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// The spoken file for these words in this voice (made once, then reused).
async fn spoken(state: &Shared, owner: &str, text: &str, voice: i64) -> anyhow::Result<String> {
    let s = crate::voicebot::load_settings(state).await;
    let key = hex::encode(Sha256::digest(format!("{voice}|{}|{text}", s.speed).as_bytes()));
    let hit: Option<String> = sqlx::query_scalar("SELECT c.file_id FROM tts_cache c JOIN files f ON f.id = c.file_id WHERE c.key = ?").bind(&key).fetch_optional(&state.db).await?;
    if let Some(f) = hit {
        return Ok(f);
    }
    let wav = crate::voicebot::speak(state, text, voice, s.speed).await?;
    let id = crate::api::files::store_bytes(state, owner, "greeting.wav", "audio/wav", &wav).await?;
    sqlx::query("INSERT OR REPLACE INTO tts_cache (key, file_id, created_at) VALUES (?,?,?)").bind(&key).bind(&id).bind(now_ms()).execute(&state.db).await?;
    Ok(id)
}

/// GET /api/users/{uid}/greeting — what a caller plays before the tone.
/// {kind, text, file_id}: play file_id if there is one, else say text on the device.
pub async fn get_greeting(State(state): State<Shared>, auth: AuthUser, Path(uid): Path<String>) -> ApiResult<Json<Value>> {
    if crate::demo::apart(&state, &auth.id, &uid) {
        return Err(AppError::not_found());
    }
    let row: Option<(String, String, String, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT COALESCE(NULLIF(display_name, ''), username), vm_greeting, vm_greeting_text, vm_greeting_voice, vm_greeting_file FROM users WHERE id = ?",
    )
    .bind(&uid)
    .fetch_optional(&state.db)
    .await?;
    let (name, kind, text, voice, file) = row.ok_or_else(AppError::not_found)?;
    let out = match kind.as_str() {
        "recorded" if file.is_some() => json!({ "kind": "recorded", "text": default_text(&name), "file_id": file }),
        "voice" if !text.trim().is_empty() => {
            let v = voice.unwrap_or(crate::voicebot::load_settings(&state).await.voice);
            let f = if crate::voicebot::tts_available(&state) { spoken(&state, &uid, &text, v).await.ok() } else { None };
            json!({ "kind": "voice", "text": text, "file_id": f })
        }
        _ => {
            let t = default_text(&name);
            let f = if crate::voicebot::tts_available(&state) {
                let v = crate::voicebot::load_settings(&state).await.voice;
                spoken(&state, &uid, &t, v).await.ok()
            } else {
                None
            };
            json!({ "kind": "default", "text": t, "file_id": f })
        }
    };
    Ok(Json(out))
}

/// GET /api/users/@me/greeting — your setup, plus the voices to pick from.
pub async fn my_greeting(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let (kind, text, voice, file): (String, String, Option<i64>, Option<String>) =
        sqlx::query_as("SELECT vm_greeting, vm_greeting_text, vm_greeting_voice, vm_greeting_file FROM users WHERE id = ?").bind(&auth.id).fetch_one(&state.db).await?;
    let s = crate::voicebot::load_settings(&state).await;
    Ok(Json(json!({
        "kind": kind, "text": text, "voice": voice.unwrap_or(s.voice), "file_id": file,
        "voices_ready": crate::voicebot::tts_available(&state),
        "voices": crate::voicebot::VOICES.iter().enumerate().map(|(i, (_, label))| json!({ "sid": i, "label": label })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct SetGreeting {
    /// default | voice | recorded
    pub kind: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub voice: Option<i64>,
    /// an audio file you uploaded (recorded)
    #[serde(default)]
    pub file_id: Option<String>,
}

/// PUT /api/users/@me/greeting
pub async fn set_greeting(State(state): State<Shared>, auth: AuthUser, Json(req): Json<SetGreeting>) -> ApiResult<Json<Value>> {
    match req.kind.as_str() {
        "default" => {
            sqlx::query("UPDATE users SET vm_greeting = 'default' WHERE id = ?").bind(&auth.id).execute(&state.db).await?;
        }
        "voice" => {
            let text: String = req.text.unwrap_or_default().trim().chars().take(MAX_TEXT).collect();
            if text.is_empty() {
                return Err(AppError::bad("write what the greeting should say"));
            }
            if !crate::voicebot::tts_available(&state) {
                return Err(AppError::bad("this Llamble's voices aren't downloaded yet (an admin turns them on in Voice AI)"));
            }
            let voice = req.voice.unwrap_or(crate::voicebot::load_settings(&state).await.voice).clamp(0, crate::voicebot::VOICES.len() as i64 - 1);
            // make it now, so callers don't wait for it later
            spoken(&state, &auth.id, &text, voice).await.map_err(|e| AppError::bad(e.to_string()))?;
            sqlx::query("UPDATE users SET vm_greeting = 'voice', vm_greeting_text = ?, vm_greeting_voice = ? WHERE id = ?").bind(&text).bind(voice).bind(&auth.id).execute(&state.db).await?;
        }
        "recorded" => {
            let fid = req.file_id.ok_or_else(|| AppError::bad("record a greeting first"))?;
            let f: Option<(String, String, i64)> = sqlx::query_as("SELECT uploader_id, mime, size FROM files WHERE id = ?").bind(&fid).fetch_optional(&state.db).await?;
            let (up, mime, size) = f.ok_or_else(AppError::not_found)?;
            if up != auth.id || !mime.starts_with("audio/") || size > MAX_RECORDED_BYTES {
                return Err(AppError::bad("that isn't a greeting you recorded"));
            }
            sqlx::query("UPDATE users SET vm_greeting = 'recorded', vm_greeting_file = ? WHERE id = ?").bind(&fid).bind(&auth.id).execute(&state.db).await?;
        }
        _ => return Err(AppError::bad("kind must be default, voice or recorded")),
    }
    my_greeting(State(state), auth).await
}

#[derive(Deserialize)]
pub struct Preview {
    pub text: String,
    pub voice: i64,
}

/// POST /api/users/@me/greeting/preview — hear your words in a voice before saving.
pub async fn preview(State(state): State<Shared>, _auth: AuthUser, Json(req): Json<Preview>) -> ApiResult<axum::response::Response> {
    let text: String = req.text.trim().chars().take(MAX_TEXT).collect();
    if text.is_empty() {
        return Err(AppError::bad("write something to hear"));
    }
    let s = crate::voicebot::load_settings(&state).await;
    let w = crate::voicebot::speak(&state, &text, req.voice, s.speed).await.map_err(|e| AppError::bad(e.to_string()))?;
    Ok(([("content-type", "audio/wav")], w).into_response())
}
