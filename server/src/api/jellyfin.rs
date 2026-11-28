//! Jellyfin as a Watch Party movie library (self-hosted instances).
//!
//! An instance admin gives the address of a Jellyfin server and an API key made in its
//! dashboard, and picks which Jellyfin libraries to share. Members then pick movies, shows
//! and videos from those libraries in a Watch Party. Everything goes through this server:
//! the key never leaves it, members need no Jellyfin account, and nothing outside the
//! chosen libraries can be reached.
//!
//! Playback: straight through when the browser can play the file ("direct"), otherwise via
//! Jellyfin's own converting (HLS). HLS playlists name their parts with relative links, so
//! those links carry a short-lived signed path instead of the person's sign-in.
use crate::error::{now_ms, ApiResult, AppError};
use crate::state::{AuthUser, Shared};
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Response, StatusCode};
use axum::Json;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;

struct Jf {
    url: String,
    key: String,
    libs: Vec<String>,
}

fn jf(state: &Shared) -> Option<Jf> {
    let s = state.s();
    let url = s.jellyfin_url.trim().trim_end_matches('/').to_string();
    if !s.watch_party || !s.watch_library || url.is_empty() || s.jellyfin_key.trim().is_empty() {
        return None;
    }
    Some(Jf { url, key: s.jellyfin_key.trim().to_string(), libs: s.jellyfin_libraries.clone() })
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(5)).build().unwrap_or_default()
}

fn auth_header(key: &str) -> String {
    format!("MediaBrowser Client=\"Llamble\", Device=\"Llamble server\", DeviceId=\"llamble-server\", Version=\"1\", Token=\"{key}\"")
}

async fn get_json(j: &Jf, path: &str) -> ApiResult<Value> {
    let r = client()
        .get(format!("{}{}", j.url, path))
        .header("Authorization", auth_header(&j.key))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| AppError::bad(format!("couldn't reach Jellyfin: {e}")))?;
    if r.status() == 401 || r.status() == 403 {
        return Err(AppError::bad("Jellyfin didn't accept the API key"));
    }
    if !r.status().is_success() {
        return Err(AppError::bad(format!("Jellyfin answered {}", r.status())));
    }
    r.json().await.map_err(|_| AppError::bad("Jellyfin sent something unexpected"))
}

fn not_set() -> AppError {
    AppError::bad("Jellyfin isn't connected on this Llamble")
}

/// Answers from `allowed`, for a few minutes (a poster grid asks for hundreds at once).
static BOXSETS: once_cell::sync::Lazy<dashmap::DashMap<String, (Vec<String>, i64)>> = once_cell::sync::Lazy::new(Default::default);

/// Where shared items can be: each shared library, then each collection (box set) in them.
/// A collection's movies aren't filed under it: they live in their own library and are only
/// linked, so a movie shared through a collection is found by asking the collection.
async fn places(j: &Jf) -> Vec<String> {
    let key = format!("{}|{}", j.url, j.libs.join(","));
    let now = crate::error::now_ms();
    let sets = match BOXSETS.get(&key).filter(|v| now - v.1 < 5 * 60_000).map(|v| v.0.clone()) {
        Some(s) => s,
        None => {
            let mut s = vec![];
            for lib in &j.libs {
                if let Ok(v) = get_json(j, &format!("/Items?ParentId={lib}&Recursive=true&IncludeItemTypes=BoxSet&Limit=500")).await {
                    s.extend(v["Items"].as_array().cloned().unwrap_or_default().iter().filter_map(|it| it["Id"].as_str().map(String::from)));
                }
            }
            BOXSETS.insert(key, (s.clone(), now));
            s
        }
    };
    j.libs.iter().cloned().chain(sets).collect()
}

static ALLOWED: once_cell::sync::Lazy<dashmap::DashMap<String, (bool, i64)>> = once_cell::sync::Lazy::new(Default::default);

/// Is this Jellyfin item inside one of the shared libraries? Asked of each library ("is this
/// item somewhere under you?"): an item's own parents in Jellyfin are its folders on disk, not
/// the library, so they can't answer it.
async fn allowed(j: &Jf, id: &str) -> bool {
    if j.libs.is_empty() || id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return false;
    }
    let key = format!("{}|{}|{id}", j.url, j.libs.join(","));
    let now = crate::error::now_ms();
    if let Some(v) = ALLOWED.get(&key) {
        if now - v.1 < 5 * 60_000 {
            return v.0;
        }
    }
    let mut ok = false;
    for lib in places(j).await {
        if let Ok(v) = get_json(j, &format!("/Items?ParentId={lib}&Recursive=true&Ids={id}&Limit=1")).await {
            if v["Items"].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                ok = true;
                break;
            }
        }
    }
    if ALLOWED.len() > 20_000 {
        ALLOWED.clear();
    }
    ALLOWED.insert(key, (ok, now));
    ok
}

/// One item, looked up inside the shared libraries: the same kind of request as the library list
/// and `allowed`, which every Jellyfin answers. (Older ones have no GET /Items/{id}, and some
/// answer 400 Bad Request to an item list that names no library.)
async fn item(j: &Jf, id: &str, fields: &str) -> ApiResult<Value> {
    let mut last = None;
    for lib in places(j).await {
        match get_json(j, &format!("/Items?ParentId={lib}&Recursive=true&Ids={id}&Fields={fields}&Limit=1")).await {
            Ok(v) => {
                if let Some(it) = v["Items"].get(0) {
                    return Ok(it.clone());
                }
            }
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(AppError::not_found))
}

fn item_brief(it: &Value) -> Value {
    let kind = match it["Type"].as_str().unwrap_or("") {
        "Movie" => "movie",
        "Series" => "series",
        "Episode" => "episode",
        "BoxSet" => "collection",
        _ => "video",
    };
    let mut title = it["Name"].as_str().unwrap_or("Untitled").to_string();
    if kind == "episode" {
        let s = it["ParentIndexNumber"].as_i64();
        let e = it["IndexNumber"].as_i64();
        let tag = match (s, e) {
            (Some(s), Some(e)) => format!("S{s}E{e} · "),
            _ => String::new(),
        };
        title = format!("{}{}{}", it["SeriesName"].as_str().map(|n| format!("{n} · ")).unwrap_or_default(), tag, title);
    }
    json!({
        "id": it["Id"], "kind": kind, "title": title, "year": it["ProductionYear"],
        "duration_ms": it["RunTimeTicks"].as_i64().map(|t| t / 10_000),
        "has_poster": it["ImageTags"]["Primary"].is_string(),
    })
}

// ---------------------------------------------------------------- admin

/// GET /api/watch/jellyfin/libraries — test the connection and list Jellyfin's libraries.
pub async fn libraries(State(state): State<Shared>, auth: AuthUser) -> ApiResult<Json<Value>> {
    if !auth.is_master {
        return Err(AppError::forbidden());
    }
    let s = state.s();
    let j = Jf { url: s.jellyfin_url.trim().trim_end_matches('/').to_string(), key: s.jellyfin_key.trim().to_string(), libs: s.jellyfin_libraries.clone() };
    if j.url.is_empty() || j.key.is_empty() {
        return Err(AppError::bad("enter the Jellyfin address and API key first"));
    }
    let v = get_json(&j, "/Library/VirtualFolders").await?;
    let libs: Vec<Value> = v
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|l| json!({ "id": l["ItemId"], "name": l["Name"], "type": l["CollectionType"], "shared": l["ItemId"].as_str().map(|i| j.libs.iter().any(|x| x.eq_ignore_ascii_case(i))).unwrap_or(false) }))
        .collect();
    Ok(Json(json!({ "libraries": libs })))
}

// ---------------------------------------------------------------- browsing

#[derive(Deserialize)]
pub struct BrowseQ {
    #[serde(default)]
    pub q: String,
    /// a series: list its episodes
    #[serde(default)]
    pub series: Option<String>,
    /// a collection: list what's in it
    #[serde(default)]
    pub collection: Option<String>,
}

/// GET /api/watch/jellyfin/items?q=&series= — movies, shows and videos in the shared libraries.
pub async fn items(State(state): State<Shared>, _auth: AuthUser, Query(bq): Query<BrowseQ>) -> ApiResult<Json<Value>> {
    let j = jf(&state).ok_or_else(not_set)?;
    let fields = "Fields=ProductionYear,RunTimeTicks&EnableImageTypes=Primary";
    if let Some(sid) = bq.series.filter(|s| !s.is_empty()) {
        if !allowed(&j, &sid).await {
            return Err(AppError::not_found());
        }
        let v = get_json(&j, &format!("/Shows/{sid}/Episodes?{fields}")).await?;
        let list: Vec<Value> = v["Items"].as_array().cloned().unwrap_or_default().iter().map(item_brief).collect();
        return Ok(Json(json!({ "items": list })));
    }
    if let Some(cid) = bq.collection.filter(|s| !s.is_empty()) {
        if !allowed(&j, &cid).await {
            return Err(AppError::not_found());
        }
        let v = get_json(&j, &format!("/Items?ParentId={cid}&SortBy=ProductionYear,SortName&{fields}")).await?;
        let list: Vec<Value> = v["Items"].as_array().cloned().unwrap_or_default().iter().map(item_brief).collect();
        return Ok(Json(json!({ "items": list })));
    }
    let q: String = bq.q.chars().filter(|c| !c.is_control()).take(80).collect();
    let mut out = vec![];
    for lib in &j.libs {
        let mut path = format!("/Items?ParentId={lib}&Recursive=true&IncludeItemTypes=Movie,Series,Video,BoxSet&SortBy=SortName&Limit=300&{fields}");
        if !q.trim().is_empty() {
            path.push_str(&format!("&SearchTerm={}", url::form_urlencoded::byte_serialize(q.trim().as_bytes()).collect::<String>()));
        }
        if let Ok(v) = get_json(&j, &path).await {
            out.extend(v["Items"].as_array().cloned().unwrap_or_default().iter().map(item_brief));
        }
    }
    Ok(Json(json!({ "items": out })))
}

/// Look up an item for the queue: (title) if it's shared and playable.
pub async fn queue_title(state: &Shared, id: &str) -> ApiResult<String> {
    let j = jf(state).ok_or_else(not_set)?;
    if !allowed(&j, id).await {
        return Err(AppError::bad("that isn't in a shared Jellyfin library"));
    }
    let v = item(&j, &id, "ProductionYear,RunTimeTicks").await?;
    if v["Type"] == "Series" {
        return Err(AppError::bad("pick an episode"));
    }
    if v["Type"] == "BoxSet" {
        return Err(AppError::bad("open the collection and pick a movie"));
    }
    Ok(item_brief(&v)["title"].as_str().unwrap_or("Untitled").to_string())
}

// ---------------------------------------------------------------- playing

fn sign(state: &Shared, uid: &str, id: &str, exp: i64) -> String {
    let mut m = Hmac::<Sha256>::new_from_slice(&state.secret).unwrap();
    m.update(format!("jf|{uid}|{id}|{exp}").as_bytes());
    hex::encode(&m.finalize().into_bytes()[..16])
}

/// "exp.uid.sig" — a path piece that lets HLS parts load without the sign-in token.
fn path_token(state: &Shared, uid: &str, id: &str) -> String {
    let exp = now_ms() / 1000 + 12 * 3600;
    format!("{exp}.{uid}.{}", sign(state, uid, id, exp))
}

fn check_token(state: &Shared, tok: &str, id: &str) -> bool {
    let mut p = tok.splitn(3, '.');
    let (Some(exp), Some(uid), Some(sig)) = (p.next(), p.next(), p.next()) else { return false };
    let Ok(exp) = exp.parse::<i64>() else { return false };
    exp > now_ms() / 1000 && sign(state, uid, id, exp) == sig
}

/// POST /api/watch/jellyfin/{id}/session — what the player needs: subtitles, length, and the
/// signed address for converted (HLS) playback.
#[derive(Deserialize, Default)]
pub struct SessionQ {
    /// the device can play HEVC (H.265) itself
    #[serde(default)]
    pub hevc: Option<u8>,
}

pub async fn session(State(state): State<Shared>, auth: AuthUser, Path(id): Path<String>, Query(sq): Query<SessionQ>) -> ApiResult<Json<Value>> {
    let j = jf(&state).ok_or_else(not_set)?;
    if !allowed(&j, &id).await {
        return Err(AppError::not_found());
    }
    let v = item(&j, &id, "MediaStreams,MediaSources").await?;
    let src = v["MediaSources"].get(0).cloned().unwrap_or(Value::Null);
    let streams = src["MediaStreams"].as_array().cloned().or_else(|| v["MediaStreams"].as_array().cloned()).unwrap_or_default();
    let subs: Vec<Value> = streams
        .iter()
        .filter(|s| s["Type"] == "Subtitle" && s["IsTextSubtitleStream"].as_bool().unwrap_or(false))
        .map(|s| json!({ "index": s["Index"], "label": s["DisplayTitle"].as_str().or(s["Language"].as_str()).unwrap_or("Subtitles"), "lang": s["Language"], "default": s["IsDefault"] }))
        .collect();
    let video = streams.iter().find(|s| s["Type"] == "Video").cloned().unwrap_or(Value::Null);
    let audio = streams.iter().find(|s| s["Type"] == "Audio").cloned().unwrap_or(Value::Null);
    let container = src["Container"].as_str().unwrap_or("").to_lowercase();
    let vcodec = video["Codec"].as_str().unwrap_or("").to_lowercase();
    let is_hevc = vcodec == "hevc" || vcodec == "h265";
    let can_hevc = sq.hevc == Some(1);
    // what this device plays as-is
    let direct = ["mp4", "m4v", "mov", "webm"].iter().any(|c| container.split(',').any(|x| x == *c))
        && (["h264", "vp8", "vp9", "av1"].contains(&vcodec.as_str()) || (is_hevc && can_hevc))
        && ["aac", "mp3", "opus", "vorbis", "flac", ""].contains(&audio["Codec"].as_str().unwrap_or("").to_lowercase().as_str());
    // Otherwise Jellyfin streams it in pieces (HLS). The picture is only re-encoded when it has to
    // be: H.264, or HEVC on a device that plays HEVC (most 4K files), are repackaged as they are,
    // full quality and almost no work for the server. Anything else becomes 1080p H.264 at a good
    // bitrate: converting 4K as it plays is more than most servers can keep up with (choppy).
    // A bitrate is ALWAYS sent: current Jellyfin reads "no bitrate" as zero, and if it converts
    // it then shrinks the picture to almost nothing (416x228 at 1 kbps). The limit is high, and
    // Jellyfin never goes above the file's own quality, so it doesn't stop a pass-through.
    let (video_args, plan) = if is_hevc && can_hevc {
        ("VideoCodec=hevc,h264&SegmentContainer=mp4&AllowVideoStreamCopy=true&VideoBitrate=200000000&MaxStreamingBitrate=200000000", "copy")
    } else if vcodec == "h264" {
        ("VideoCodec=h264&SegmentContainer=ts&AllowVideoStreamCopy=true&VideoBitrate=200000000&MaxStreamingBitrate=200000000", "copy")
    } else {
        ("VideoCodec=h264&SegmentContainer=ts&MaxWidth=1920&MaxHeight=1080&VideoBitrate=10000000&MaxStreamingBitrate=10320000", "convert")
    };
    // what the file is, for the player's Stream info
    let info = json!({
        "file": video["DisplayTitle"].as_str().unwrap_or(""),
        "codec": vcodec,
        "width": video["Width"],
        "height": video["Height"],
        "bitrate": video["BitRate"].as_i64().or(src["Bitrate"].as_i64()),
        "container": container,
        "plan": if direct { "direct" } else { plan },
    });
    let play_session = crate::error::new_id();
    Ok(Json(json!({
        "id": id,
        "title": item_brief(&v)["title"],
        "play_session_id": play_session,
        "duration_ms": v["RunTimeTicks"].as_i64().map(|t| t / 10_000),
        "media_source_id": src["Id"].as_str().unwrap_or(&id),
        "direct": direct,
        "hls": format!("/api/watch/jf/{}/{id}/hls/master.m3u8?MediaSourceId={}&{video_args}&AudioCodec=aac&AllowAudioStreamCopy=true&TranscodingMaxAudioChannels=2&MinSegments=1&BreakOnNonKeyFrames=true&DeviceId=llamble-{}&PlaySessionId={}",
            path_token(&state, &auth.id, &id), src["Id"].as_str().unwrap_or(&id), auth.id, play_session),
        "subs": subs,
        "info": info,
    })))
}

#[derive(Deserialize)]
pub struct StopQ {
    pub play: String,
}

/// DELETE /api/watch/jellyfin/session?play=… — this person stopped watching (left, skipped, next
/// movie): Jellyfin can stop converting for them now instead of running on in the background.
pub async fn stop(State(state): State<Shared>, auth: AuthUser, Query(q): Query<StopQ>) -> ApiResult<Json<Value>> {
    let j = jf(&state).ok_or_else(not_set)?;
    if q.play.is_empty() || !q.play.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::bad("bad play session"));
    }
    let r = client()
        .delete(format!("{}/Videos/ActiveEncodings", j.url))
        .query(&[("deviceId", format!("llamble-{}", auth.id)), ("playSessionId", q.play.clone())])
        .header("Authorization", auth_header(&j.key))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;
    Ok(Json(json!({ "ok": r.map(|r| r.status().is_success()).unwrap_or(false) })))
}

/// Pass a Jellyfin response through (keeping what the player needs for seeking).
async fn pass(j: &Jf, path: &str, headers: &HeaderMap) -> ApiResult<Response<Body>> {
    let mut req = client().get(format!("{}{}", j.url, path)).header("Authorization", auth_header(&j.key));
    if let Some(r) = headers.get("range") {
        req = req.header("Range", r.clone());
    }
    let r = req.send().await.map_err(|e| AppError::bad(format!("couldn't reach Jellyfin: {e}")))?;
    let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut out = Response::builder().status(status);
    for h in ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"] {
        if let Some(v) = r.headers().get(h) {
            if let Ok(v) = HeaderValue::from_bytes(v.as_bytes()) {
                out = out.header(h, v);
            }
        }
    }
    Ok(out.body(Body::from_stream(r.bytes_stream())).map_err(|_| AppError::bad("bad response"))?)
}

/// GET /api/watch/jellyfin/{id}/stream — the file as it is (for players that can play it).
pub async fn stream(State(state): State<Shared>, _auth: AuthUser, Path(id): Path<String>, Query(sq): Query<SubQ>, headers: HeaderMap) -> ApiResult<Response<Body>> {
    let j = jf(&state).ok_or_else(not_set)?;
    if !allowed(&j, &id).await {
        return Err(AppError::not_found());
    }
    let src = sq.source.filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).unwrap_or_else(|| id.clone());
    pass(&j, &format!("/Videos/{id}/stream?static=true&MediaSourceId={src}"), &headers).await
}

/// GET /api/watch/jf/{tok}/{id}/hls/{*rest} — Jellyfin's converted (HLS) playlists and parts.
pub async fn hls(State(state): State<Shared>, Path((tok, id, rest)): Path<(String, String, String)>, raw: axum::extract::RawQuery, headers: HeaderMap) -> ApiResult<Response<Body>> {
    if !check_token(&state, &tok, &id) {
        return Err(AppError::forbidden());
    }
    let j = jf(&state).ok_or_else(not_set)?;
    if rest.contains("..") || rest.starts_with('/') {
        return Err(AppError::bad("bad path"));
    }
    let q = raw.0.map(|q| format!("?{q}")).unwrap_or_default();
    pass(&j, &format!("/Videos/{id}/{rest}{q}"), &headers).await
}

#[derive(Deserialize)]
pub struct SubQ {
    #[serde(default)]
    pub source: Option<String>,
}

/// GET /api/watch/jellyfin/{id}/subs/{index} — a subtitle track as WebVTT.
pub async fn subs(State(state): State<Shared>, _auth: AuthUser, Path((id, index)): Path<(String, i64)>, Query(sq): Query<SubQ>, headers: HeaderMap) -> ApiResult<Response<Body>> {
    let j = jf(&state).ok_or_else(not_set)?;
    if !allowed(&j, &id).await {
        return Err(AppError::not_found());
    }
    let src = sq.source.filter(|s| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).unwrap_or_else(|| id.clone());
    pass(&j, &format!("/Videos/{id}/{src}/Subtitles/{index}/0/Stream.vtt"), &headers).await
}

/// GET /api/watch/jellyfin/{id}/poster
pub async fn poster(State(state): State<Shared>, _auth: AuthUser, Path(id): Path<String>, headers: HeaderMap) -> ApiResult<Response<Body>> {
    let j = jf(&state).ok_or_else(not_set)?;
    if !allowed(&j, &id).await {
        return Err(AppError::not_found());
    }
    pass(&j, &format!("/Items/{id}/Images/Primary?maxHeight=480&quality=85"), &headers).await
}
