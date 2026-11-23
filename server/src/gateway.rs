use crate::api::guilds::guild_payload;
use crate::api::messages::dm_payload;
use crate::models::get_user;
use crate::state::{auth_token, AuthUser, Shared};
use axum::extract::ws::{Message as WsMsg, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

#[derive(Deserialize)]
pub struct GwQ {
    pub access_token: Option<String>,
}

pub async fn upgrade(State(state): State<Shared>, Query(q): Query<GwQ>, ws: WebSocketUpgrade) -> Result<Response, crate::error::AppError> {
    let token = q.access_token.ok_or_else(crate::error::AppError::unauthorized)?;
    let auth = auth_token(&state, &token).await?;
    Ok(ws.max_message_size(64 * 1024).on_upgrade(move |sock| session(state, auth, sock)))
}

async fn ready_payload(state: &Shared, auth: &AuthUser) -> anyhow::Result<Value> {
    let user = get_user(&state.db, &auth.id).await?;
    let gids: Vec<String> = sqlx::query_scalar("SELECT guild_id FROM members WHERE user_id = ? ORDER BY joined_at")
        .bind(&auth.id)
        .fetch_all(&state.db)
        .await?;
    let mut guilds = vec![];
    for g in &gids {
        if let Ok(p) = guild_payload(state, g).await {
            guilds.push(p);
        }
    }
    let dm_ids: Vec<String> = sqlx::query_scalar("SELECT channel_id FROM dm_members WHERE user_id = ?")
        .bind(&auth.id)
        .fetch_all(&state.db)
        .await?;
    let mut dms = vec![];
    for c in &dm_ids {
        if let Ok(p) = dm_payload(state, c).await {
            dms.push(p);
        }
    }
    let reads: Vec<(String, String)> = sqlx::query_as("SELECT channel_id, last_read_id FROM read_states WHERE user_id = ?")
        .bind(&auth.id)
        .fetch_all(&state.db)
        .await?;
    let related = state.related_users(&auth.id).await;
    let presences: Vec<Value> = related
        .iter()
        .filter(|u| state.hub.is_online(u) && status_of(state, u) != "invisible")
        .map(|u| json!({ "user_id": u, "status": status_of(state, u), "game": game_of(u), "hidden": hidden(u) }))
        .collect();
    let voice: Vec<Value> = state
        .hub
        .voice
        .iter()
        .filter(|v| match &v.guild_id {
            Some(g) => gids.contains(g),
            None => dm_ids.contains(&v.channel_id),
        })
        .map(|v| serde_json::to_value(v.value()).unwrap())
        .collect();
    Ok(json!({
        "user": user,
        "guilds": guilds,
        "dms": dms,
        "friends": crate::api::social::list_friends(axum::extract::State(state.clone()), auth.clone()).await.map(|j| j.0).unwrap_or(json!([])),
        "read_states": reads.into_iter().map(|(c, m)| json!({ "channel_id": c, "last_read_id": m })).collect::<Vec<_>>(),
        "presences": presences,
        "my_status": { "status": status_of(state, &auth.id), "hide_activity": hidden(&auth.id) },
        "voice_states": voice,
        "shows": crate::shows::active(state).await,
        "config": {
            "voice_enabled": crate::voice_server::enabled(state),
            "voice_ai": crate::voicebot::config_json(state).await,
            "images": crate::images::config_json(state).await,
            "max_upload_bytes": state.s().max_upload_bytes(),
            "guild_create": state.s().guild_create,
            "people_name": state.s().people_name,
            "watch": { "on": state.s().watch_party, "library": state.s().watch_library, "device": state.s().watch_device_stream },
            "media": {
                "max_share": state.s().max_share,
                "max_camera": state.s().max_camera,
                "mic_default_kbps": state.s().mic_default_kbps,
                "mic_max_kbps": state.s().mic_max_kbps,
                "server_recording": state.s().allow_server_recording,
            },
            "public_domain": crate::remote::public_domain(state).await,
            "version": crate::config::server_version(),
            "client_download": crate::config::client_download_url(),
            "bot": { "id": state.bot_id, "name": state.s().bot_name, "server_backend": crate::ai::server_llama_url(state).await.is_some(), "worker_policy": crate::bot::gpu_policy(state).await },
        }
    }))
}

/// Set when the server is stopping (an update, a restart). Every connection is closed politely,
/// spread over a couple of seconds, and each app is told to wait a random few seconds before
/// reconnecting. Without this, every phone's connection broke in the same instant and they all
/// reconnected at once: a burst a router's attack detection (e.g. CrowdSec's port-scan check)
/// can mistake for an attack and ban the server for.
pub static SHUTDOWN: once_cell::sync::Lazy<tokio::sync::watch::Sender<bool>> = once_cell::sync::Lazy::new(|| tokio::sync::watch::channel(false).0);

pub static STATUSES: once_cell::sync::Lazy<dashmap::DashMap<String, String>> = once_cell::sync::Lazy::new(Default::default);

/// What each person is playing right now (Windows app game detection), shown as "Playing X".
static GAMES: once_cell::sync::Lazy<dashmap::DashMap<String, String>> = once_cell::sync::Lazy::new(Default::default);

fn game_of(uid: &str) -> Option<String> {
    GAMES.get(uid).map(|g| g.clone())
}

async fn set_game(state: &Shared, uid: &str, game: Option<String>) {
    let changed = match &game {
        Some(g) => GAMES.insert(uid.to_string(), g.clone()).as_ref() != Some(g),
        None => GAMES.remove(uid).is_some(),
    };
    if changed {
        state.emit_related(uid, "ACTIVITY_UPDATE", &json!({ "user_id": uid, "game": game })).await;
    }
}

fn status_of(_state: &Shared, uid: &str) -> String {
    STATUSES.get(uid).map(|s| s.clone()).unwrap_or_else(|| "online".into())
}

/// People who've turned on "Hide what I'm doing".
pub static HIDDEN: once_cell::sync::Lazy<dashmap::DashSet<String>> = once_cell::sync::Lazy::new(Default::default);

fn hidden(uid: &str) -> bool {
    HIDDEN.contains(uid)
}

/// What others see as someone's status (invisible shows as offline).
fn shown_status(state: &Shared, uid: &str) -> String {
    let s = status_of(state, uid);
    if s == "invisible" { "offline".into() } else { s }
}

/// The status and "hide what I'm doing" saved on the account, loaded the first time it's needed.
async fn load_status(state: &Shared, uid: &str) {
    if STATUSES.contains_key(uid) {
        return;
    }
    let r: Option<(String, bool)> = sqlx::query_as("SELECT status, hide_activity FROM users WHERE id = ?").bind(uid).fetch_optional(&state.db).await.ok().flatten();
    let (st, hide) = r.unwrap_or_else(|| ("online".into(), false));
    STATUSES.insert(uid.to_string(), st);
    if hide {
        HIDDEN.insert(uid.to_string());
    }
}

async fn session(state: Shared, auth: AuthUser, sock: WebSocket) {
    let (mut sink, mut stream) = sock.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Register before taking the READY snapshot: anything that happens while READY is
    // being built (someone else coming online, joining voice...) is queued on `tx` and
    // delivered right after it. Registering afterwards lost those events, which is why
    // people could be missing from lists after everyone reconnected at once (restarts).
    let worker_tx = tx.clone();
    load_status(&state, &auth.id).await;
    let (conn_id, first) = state.hub.register(&auth.id, tx);
    if first {
        // (an invisible person coming online stays "offline" to everyone)
        let status = shown_status(&state, &auth.id);
        state.emit_related(&auth.id, "PRESENCE_UPDATE", &json!({ "user_id": auth.id, "status": status, "hidden": hidden(&auth.id) })).await;
    }
    let ready = match ready_payload(&state, &auth).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("ready failed: {e:#}");
            let _ = sink.close().await;
            if state.hub.unregister(&auth.id, conn_id) {
                state.emit_related(&auth.id, "PRESENCE_UPDATE", &json!({ "user_id": auth.id, "status": "offline" })).await;
            }
            return;
        }
    };
    if sink.send(WsMsg::Text(json!({ "t": "READY", "d": ready }).to_string().into())).await.is_err() {
        if state.hub.unregister(&auth.id, conn_id) {
            state.emit_related(&auth.id, "PRESENCE_UPDATE", &json!({ "user_id": auth.id, "status": "offline" })).await;
        }
        return;
    }
    // an alarm still ringing rings on this device too
    crate::api::alarms::on_ready(&state, &auth.id).await;

    let mut last_seen = Instant::now();
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    let mut stopping = SHUTDOWN.subscribe();
    loop {
        tokio::select! {
            _ = async { let _ = stopping.wait_for(|s| *s).await; } => {
                use rand::Rng;
                let (pause, retry) = { let mut r = rand::thread_rng(); (r.gen_range(0..1500u64), r.gen_range(4_000..25_000u64)) };
                tokio::time::sleep(Duration::from_millis(pause)).await;
                let _ = sink.send(WsMsg::Text(json!({ "t": "RESTARTING", "d": { "retry_in_ms": retry } }).to_string().into())).await;
                let _ = sink.send(WsMsg::Close(Some(axum::extract::ws::CloseFrame { code: 1012, reason: "restarting".into() }))).await;
                break;
            },
            out = rx.recv() => match out {
                Some(text) => if sink.send(WsMsg::Text(text.into())).await.is_err() { break },
                None => break, // kicked
            },
            inc = stream.next() => match inc {
                Some(Ok(WsMsg::Text(t))) => {
                    last_seen = Instant::now();
                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                        match v["op"].as_str() {
                            Some("ping") => { let _ = sink.send(WsMsg::Text(json!({"t":"PONG"}).to_string().into())).await; }
                            Some("presence") => {
                                // status (saved on the account, so every device agrees) and/or
                                // "hide what I'm doing"
                                let mut changed = false;
                                if let Some(st) = v["status"].as_str().filter(|s| ["online", "idle", "dnd", "invisible"].contains(s)) {
                                    STATUSES.insert(auth.id.clone(), st.to_string());
                                    let _ = sqlx::query("UPDATE users SET status = ? WHERE id = ?").bind(st).bind(&auth.id).execute(&state.db).await;
                                    changed = true;
                                }
                                if let Some(h) = v["hide_activity"].as_bool() {
                                    if h { HIDDEN.insert(auth.id.clone()); } else { HIDDEN.remove(&auth.id); }
                                    let _ = sqlx::query("UPDATE users SET hide_activity = ? WHERE id = ?").bind(h).bind(&auth.id).execute(&state.db).await;
                                    changed = true;
                                }
                                if changed {
                                    if status_of(&state, &auth.id) == "invisible" || hidden(&auth.id) {
                                        set_game(&state, &auth.id, None).await;
                                    }
                                    let shown = shown_status(&state, &auth.id);
                                    state.emit_related(&auth.id, "PRESENCE_UPDATE", &json!({ "user_id": auth.id, "status": shown, "hidden": hidden(&auth.id) })).await;
                                    // the person's other devices pick up the change too
                                    state.hub.send_user(&auth.id, "MY_STATUS", &json!({ "status": status_of(&state, &auth.id), "hide_activity": hidden(&auth.id) }));
                                }
                            }
                            Some("activity") => {
                                let game: Option<String> = v["game"]
                                    .as_str()
                                    .map(|g| g.trim().chars().filter(|c| !c.is_control()).take(80).collect::<String>())
                                    .filter(|g| !g.is_empty());
                                // invisible people don't announce what they're playing either
                                let game = if status_of(&state, &auth.id) == "invisible" || hidden(&auth.id) { None } else { game };
                                set_game(&state, &auth.id, game).await;
                            }
                            Some("worker_register") => {
                                if crate::bot::worker_eligible(&state, &auth.id).await {
                                    state.bot.workers.insert(conn_id, crate::bot::Worker {
                                        user_id: auth.id.clone(),
                                        tx: worker_tx.clone(),
                                        gpu: v["gpu"].as_str().unwrap_or("GPU").chars().take(80).collect(),
                                        vram_mb: v["vram_mb"].as_i64().unwrap_or(0),
                                        model: v["model"].as_str().unwrap_or("").chars().take(120).collect(),
                                        active: 0,
                                        available: v["available"].as_bool().unwrap_or(true),
                                        reason: v["reason"].as_str().unwrap_or("").chars().take(80).collect(),
                                        images: v["images"].as_bool().unwrap_or(false),
                                    });
                                    let _ = sink.send(WsMsg::Text(json!({"t":"WORKER_ACCEPTED","d":{}}).to_string().into())).await;
                                    tracing::info!("GPU worker online: {} ({})", auth.id, v["gpu"]);
                                } else {
                                    let policy = crate::bot::gpu_policy(&state).await;
                                    let _ = sink.send(WsMsg::Text(json!({"t":"WORKER_REJECTED","d":{"reason": crate::bot::rejection_reason(&policy)}}).to_string().into())).await;
                                }
                            }
                            Some("worker_unregister") => crate::bot::worker_gone(&state, conn_id),
                            Some("worker_status") => {
                                if let Some(mut w) = state.bot.workers.get_mut(&conn_id) {
                                    w.available = v["available"].as_bool().unwrap_or(false);
                                    w.reason = v["reason"].as_str().unwrap_or("").chars().take(80).collect();
                                    if let Some(b) = v["images"].as_bool() {
                                        w.images = b;
                                    }
                                }
                            }
                            Some("job_chunk") | Some("job_tools") | Some("job_done") | Some("job_error") => crate::bot::job_event(&state, conn_id, &v),
                            _ => {}
                        }
                    }
                }
                Some(Ok(WsMsg::Pong(_))) | Some(Ok(WsMsg::Ping(_))) => last_seen = Instant::now(),
                Some(Ok(WsMsg::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            _ = ping.tick() => {
                if last_seen.elapsed() > Duration::from_secs(90) { break; }
                if sink.send(WsMsg::Ping(Vec::new().into())).await.is_err() { break; }
            }
        }
    }

    crate::bot::worker_gone(&state, conn_id);
    if state.hub.unregister(&auth.id, conn_id) {
        // grace period so a quick reconnect doesn't flap presence / drop voice
        let st = state.clone();
        let uid = auth.id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(8)).await;
            if !st.hub.is_online(&uid) {
                set_game(&st, &uid, None).await;
                st.emit_related(&uid, "PRESENCE_UPDATE", &json!({ "user_id": uid, "status": "offline" })).await;
                // The chat connection says nothing about the call: a phone in another app can lose
                // it while the call (a separate connection to the voice server) carries on. Who's
                // in a call is decided by the voice server alone (voice::watch_calls); only a
                // server without one falls back to the chat connection.
                if !crate::voice_server::enabled(&st) {
                    crate::api::voice::leave_voice(&st, &uid).await;
                }
            }
        });
    }
}
