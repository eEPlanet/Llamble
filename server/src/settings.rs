//! Instance settings editable by admins from the app (stored in SQLite).
//! Environment variables only provide the first-boot defaults.
use crate::error::{ApiResult, AppError};
use crate::state::{AuthUser, Shared};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ServerSettings {
    /// the NAS's address on the home network (voice needs it); learned automatically
    pub lan_ip: Option<String>,
    pub max_upload_mb: u64,
    /// "admin" or "all"
    pub guild_create: String,
    pub unfurl_links: bool,
    pub bot_name: String,
    /// allow members to record calls on the server (used by show recording)
    pub allow_server_recording: bool,
    /// highest screen-share quality anyone may send: 720p30 … 2160p60, or native (their screen, up to 4K)
    pub max_share: String,
    /// highest camera quality: 360p | 720p | 1080p | 2160p
    pub max_camera: String,
    /// mic bitrate (kbps) for everyone who hasn't picked their own
    pub mic_default_kbps: u32,
    /// highest mic bitrate (kbps) anyone may send
    pub mic_max_kbps: u32,
    /// show news from the Llamble project on Home (signed; checked every 6 hours)
    pub llamble_news_enabled: bool,
    /// where the signed news file lives
    pub llamble_news_url: String,
    /// only accept the apps over HTTPS (the remote-access domain); plain HTTP gets told where
    /// to go instead. Never applies until HTTPS is actually working, nor to the NAS itself.
    #[serde(default)]
    pub require_https: bool,
    /// what this instance calls the people list: "Friends" (default), "Contacts", or its own word
    #[serde(default = "default_people_name")]
    pub people_name: String,
    /// who you can find when inviting people to a server: "connections" (your friends and
    /// people who share a server with you) or "everyone" on the instance. Kids never show
    /// up, except to their own parents.
    #[serde(default = "default_invite_search")]
    pub invite_search: String,
    /// any member (not kids) can send an "Invite to Llamble" link; off = admins only
    #[serde(default = "yes")]
    pub member_invites: bool,
    /// the Watch Party module: servers can add Watch Party spaces
    #[serde(default = "yes")]
    pub watch_party: bool,
    /// the instance's movie library (instance staff add movies; for self-hosted instances)
    #[serde(default = "yes")]
    pub watch_library: bool,
    /// members can stream a video file from their own device into a Watch Party
    #[serde(default = "yes")]
    pub watch_device_stream: bool,
    /// a Jellyfin server whose libraries Watch Parties can play (self-hosted)
    #[serde(default)]
    pub jellyfin_url: String,
    /// an API key made in Jellyfin's dashboard (stays on this server)
    #[serde(default)]
    pub jellyfin_key: String,
    /// which Jellyfin libraries are shared (their ids)
    #[serde(default)]
    pub jellyfin_libraries: Vec<String>,
}

fn yes() -> bool {
    true
}

fn default_invite_search() -> String {
    "connections".into()
}

fn default_people_name() -> String {
    "Friends".into()
}

/// Opus bitrates offered in the apps (kbps).
pub const MIC_KBPS: [u32; 20] = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 510];

impl ServerSettings {
    pub fn defaults(cfg: &crate::config::Config) -> Self {
        ServerSettings {
            lan_ip: None,
            max_upload_mb: cfg.max_upload_bytes / 1024 / 1024,
            guild_create: cfg.guild_create.clone(),
            unfurl_links: cfg.unfurl_links,
            bot_name: cfg.bot_name.clone(),
            allow_server_recording: false,
            max_share: "native".into(),
            max_camera: "2160p".into(),
            mic_default_kbps: 128,
            mic_max_kbps: 510,
            llamble_news_enabled: true,
            llamble_news_url: "https://llamble.com/news.json".into(),
            require_https: false,
            people_name: default_people_name(),
            invite_search: default_invite_search(),
            member_invites: true,
            watch_party: true,
            watch_library: true,
            watch_device_stream: true,
            jellyfin_url: String::new(),
            jellyfin_key: String::new(),
            jellyfin_libraries: vec![],
        }
    }
    pub fn max_upload_bytes(&self) -> u64 {
        self.max_upload_mb.max(1) * 1024 * 1024
    }
}

pub async fn load_into_cache(state: &Shared) {
    let mut s = ServerSettings::defaults(&state.cfg);
    if let Ok(Some(v)) = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'server'")
        .fetch_optional(&state.db)
        .await
    {
        if let Ok(saved) = serde_json::from_str::<Value>(&v) {
            // merge saved over defaults (tolerates fields added in later versions)
            let mut base = serde_json::to_value(&s).unwrap();
            if let (Some(b), Some(o)) = (base.as_object_mut(), saved.as_object()) {
                for (k, val) in o {
                    b.insert(k.clone(), val.clone());
                }
            }
            if let Ok(m) = serde_json::from_value(base) {
                s = m;
            }
        }
    }
    *state.settings.write().unwrap() = s;
}

async fn save(state: &Shared, s: &ServerSettings) -> ApiResult<()> {
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('server', ?)")
        .bind(serde_json::to_string(s).unwrap())
        .execute(&state.db)
        .await?;
    *state.settings.write().unwrap() = s.clone();
    Ok(())
}

pub async fn get(state: &Shared) -> ServerSettings {
    state.settings.read().unwrap().clone()
}

fn private_ipv4(host: &str) -> Option<String> {
    let ip: std::net::Ipv4Addr = host.split(':').next()?.parse().ok()?;
    (ip.is_private()).then(|| ip.to_string())
}

/// Learn the NAS's home-network IP from how clients reach it (e.g. Host: 192.168.1.20:8090).
pub async fn learn_lan_ip(state: &Shared, headers: &HeaderMap) {
    let Some(host) = headers.get("host").and_then(|h| h.to_str().ok()) else { return };
    let Some(ip) = private_ipv4(host) else { return };
    let cur = get(state).await;
    if cur.lan_ip.as_deref() == Some(ip.as_str()) || cur.lan_ip.is_some() {
        return;
    }
    let mut s = cur;
    s.lan_ip = Some(ip.clone());
    if save(state, &s).await.is_ok() {
        tracing::info!("learned home-network address {ip} (used for voice)");
        crate::voice_server::refresh(state.clone());
    }
}

pub async fn get_settings(State(state): State<Shared>, auth: AuthUser, headers: HeaderMap) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    learn_lan_ip(&state, &headers).await;
    Ok(Json(json!({
        "settings": get(&state).await,
        "voice": crate::voice_server::status_json(&state).await,
    })))
}

pub async fn put_settings(State(state): State<Shared>, auth: AuthUser, Json(req): Json<Value>) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    let mut cur = serde_json::to_value(get(&state).await).unwrap();
    if let (Some(c), Some(r)) = (cur.as_object_mut(), req.as_object()) {
        for (k, v) in r {
            if c.contains_key(k) {
                c.insert(k.clone(), v.clone());
            }
        }
    }
    let mut s: ServerSettings = serde_json::from_value(cur).map_err(|e| AppError::bad(e.to_string()))?;
    s.max_upload_mb = s.max_upload_mb.clamp(1, 20_000);
    if !["admin", "all"].contains(&s.guild_create.as_str()) {
        return Err(AppError::bad("guild_create must be admin or all"));
    }
    if !["720p30", "1080p30", "1080p60", "1440p30", "1440p60", "2160p30", "2160p60", "native"].contains(&s.max_share.as_str()) {
        return Err(AppError::bad("max_share must be one of 720p30, 1080p30, 1080p60, 1440p30, 1440p60, 2160p30, 2160p60, native"));
    }
    if !["360p", "720p", "1080p", "2160p"].contains(&s.max_camera.as_str()) {
        return Err(AppError::bad("max_camera must be 360p, 720p, 1080p or 2160p"));
    }
    if !MIC_KBPS.contains(&s.mic_default_kbps) || !MIC_KBPS.contains(&s.mic_max_kbps) {
        return Err(AppError::bad("mic bitrates must be one of 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 510"));
    }
    if s.mic_default_kbps > s.mic_max_kbps {
        return Err(AppError::bad("the default mic bitrate can't be above the highest allowed"));
    }
    s.llamble_news_url = s.llamble_news_url.trim().to_string();
    let local_test = std::env::var("LLAMBLE_NEWS_TEST_KEY").is_ok() && s.llamble_news_url.starts_with("http://127.0.0.1");
    if !s.llamble_news_url.starts_with("https://") && !local_test {
        return Err(AppError::bad("the Llamble news address must start with https://"));
    }
    s.jellyfin_url = s.jellyfin_url.trim().trim_end_matches('/').to_string();
    if !s.jellyfin_url.is_empty() && !(s.jellyfin_url.starts_with("http://") || s.jellyfin_url.starts_with("https://")) {
        return Err(AppError::bad("the Jellyfin address must start with http:// or https://"));
    }
    if !["connections", "everyone"].contains(&s.invite_search.as_str()) {
        return Err(AppError::bad("invite_search must be connections or everyone"));
    }
    s.people_name = s.people_name.trim().chars().take(20).collect();
    if s.people_name.is_empty() {
        s.people_name = default_people_name();
    }
    s.bot_name = s.bot_name.trim().chars().take(32).collect();
    if s.bot_name.is_empty() {
        s.bot_name = "Llamble".into();
    }
    if let Some(ip) = &s.lan_ip {
        if !ip.is_empty() && ip.parse::<std::net::Ipv4Addr>().is_err() {
            return Err(AppError::bad("home-network address must be an IPv4 address like 192.168.1.20"));
        }
    }
    if s.lan_ip.as_deref() == Some("") {
        s.lan_ip = None;
    }
    let before = get(&state).await;
    if s.require_https && !before.require_https && https_url(&state).await.is_none() {
        return Err(AppError::bad("Set up remote access (a domain with HTTPS) first: HTTPS isn't working yet"));
    }
    save(&state, &s).await?;
    if before.bot_name != s.bot_name {
        let _ = sqlx::query("UPDATE users SET display_name = ? WHERE id = ?").bind(&s.bot_name).bind(&state.bot_id).execute(&state.db).await;
        if let Ok(u) = crate::models::get_user(&state.db, &state.bot_id).await {
            let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM users WHERE is_bot = 0").fetch_all(&state.db).await.unwrap_or_default();
            state.hub.send_users(&ids, "USER_UPDATE", &u);
        }
    }
    if before.lan_ip != s.lan_ip {
        crate::voice_server::refresh(state.clone());
    }
    if s.llamble_news_enabled && (before.llamble_news_url != s.llamble_news_url || !before.llamble_news_enabled) {
        let st = state.clone();
        tokio::spawn(async move { crate::api::news::refresh(&st).await });
    }
    // everyone connected picks up the new limits right away (no reconnect needed)
    // (demo accounts get their own view of these at sign-in: no movies, no AI)
    let online = crate::demo::without(state.hub.online_users());
    state.hub.send_users(
        &online,
        "CONFIG_UPDATE",
        &json!({
            "max_upload_bytes": s.max_upload_bytes(),
            "guild_create": s.guild_create,
            "people_name": s.people_name,
            "member_invites": s.member_invites,
            "watch": { "on": s.watch_party, "library": s.watch_library, "device": s.watch_device_stream, "jellyfin": s.watch_library && !s.jellyfin_url.is_empty() && !s.jellyfin_libraries.is_empty() },
            "media": { "max_share": s.max_share, "max_camera": s.max_camera, "mic_default_kbps": s.mic_default_kbps, "mic_max_kbps": s.mic_max_kbps, "server_recording": s.allow_server_recording },
        }),
    );
    Ok(Json(json!({ "settings": s })))
}

// ---------------------------------------------------------------- HTTPS only

/// The instance's HTTPS address, if HTTPS is set up and working.
pub async fn https_url(state: &Shared) -> Option<String> {
    let domain = crate::remote::public_domain(state).await?;
    let ready = state.remote.status.read().await.tls_state == "ready";
    ready.then(|| format!("https://{domain}"))
}

/// Public: is plain HTTP still allowed, and where's the HTTPS address? (The apps ask this.)
pub async fn https_info(State(state): State<Shared>) -> Json<Value> {
    Json(json!({ "require_https": get(&state).await.require_https, "https_url": https_url(&state).await }))
}

/// On the plain-HTTP listener: when "Require HTTPS" is on (and HTTPS really works), send
/// everyone to the HTTPS address. Requests from the NAS itself, health checks and the
/// LLAMBLE_ALLOW_HTTP=1 escape hatch always get through, so nobody gets locked out.
pub async fn plain_http_guard(
    State(state): State<Shared>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let path = req.uri().path().to_string();
    let open = peer.ip().is_loopback()
        || path == "/api/health"
        || path == "/api/https-info"
        || path.starts_with("/.well-known/")
        || std::env::var("LLAMBLE_ALLOW_HTTP").map(|v| v == "1").unwrap_or(false)
        || !get(&state).await.require_https;
    if open {
        return next.run(req).await;
    }
    let Some(url) = https_url(&state).await else { return next.run(req).await };
    if path.starts_with("/api/") || path.starts_with("/livekit") {
        return (
            axum::http::StatusCode::UPGRADE_REQUIRED,
            Json(json!({ "error": format!("This server only accepts secure connections. Use {url}"), "https_url": url })),
        )
            .into_response();
    }
    let q = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    axum::response::Redirect::permanent(&format!("{url}{path}{q}")).into_response()
}
