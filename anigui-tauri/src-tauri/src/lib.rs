use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const ANILIST_API: &str = "https://graphql.anilist.co";
const ANILIST_CLIENT_ID: &str = "45898";

// ─── Config ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Config {
    bash_path: Option<String>,
    quality: Option<String>,
    confirm_before_sync: Option<bool>,
    anilist_token: Option<String>,
    download_dir: Option<String>,
}

struct AppState {
    config: Mutex<Config>,
    config_path: std::path::PathBuf,
    player_active: Arc<Mutex<bool>>,
}

fn get_config_path() -> std::path::PathBuf {
    let base = std::env::var("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| dirs_next::home_dir().unwrap_or_default());
    base.join("anicli-gui").join("config.json")
}

fn load_config_from_disk(path: &std::path::Path) -> Config {
    if path.exists() {
        if let Ok(data) = std::fs::read_to_string(path) {
            if let Ok(cfg) = serde_json::from_str(&data) {
                return cfg;
            }
        }
    }
    Config::default()
}

fn save_config_to_disk(path: &std::path::Path, cfg: &Config) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(data) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(path, data);
    }
}

fn find_bash() -> Option<String> {
    let candidates = [
        which::which("bash").ok().map(|p| p.to_string_lossy().to_string()),
        Some(r"C:\Program Files\Git\bin\bash.exe".to_string()),
        Some(r"C:\Program Files (x86)\Git\bin\bash.exe".to_string()),
    ];
    for c in &candidates {
        if let Some(path) = c {
            if std::path::Path::new(path).exists() {
                return Some(path.clone());
            }
        }
    }
    None
}

// ─── AniList HTTP Helper ──────────────────────────────────────────────────────

async fn anilist_query(
    query: &str,
    variables: Value,
    token: Option<&str>,
) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "query": query,
        "variables": variables
    });

    let mut req = client
        .post(ANILIST_API)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json");

    if let Some(tok) = token {
        req = req.header("Authorization", format!("Bearer {}", tok));
    }

    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}

// ─── GraphQL Queries ──────────────────────────────────────────────────────────

const MEDIA_FIELDS: &str = r#"
fragment mediaFields on Media {
  id
  title { romaji english }
  episodes
  averageScore
  status
  season
  seasonYear
  genres
  description(asHtml: false)
  coverImage { medium large }
  relations {
    edges {
      relationType
      node {
        id
        title { romaji english }
        coverImage { medium }
        type
        format
      }
    }
  }
}
"#;

fn search_query() -> String {
    format!(
        r#"{} query ($search: String, $page: Int) {{
  Page(page: $page, perPage: 20) {{
    pageInfo {{ hasNextPage }}
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {{
      ...mediaFields
      mediaListEntry {{ id progress status }}
    }}
  }}
}}"#,
        MEDIA_FIELDS
    )
}

fn trending_query() -> String {
    format!(
        r#"{} query ($page: Int) {{
  Page(page: $page, perPage: 20) {{
    pageInfo {{ hasNextPage }}
    media(type: ANIME, sort: TRENDING_DESC) {{
      ...mediaFields
      mediaListEntry {{ id progress status }}
    }}
  }}
}}"#,
        MEDIA_FIELDS
    )
}

const VIEWER_QUERY: &str = "query { Viewer { id } }";

fn current_query() -> String {
    format!(
        r#"{} query ($userId: Int) {{
  MediaListCollection(userId: $userId, type: ANIME, status: CURRENT) {{
    lists {{
      entries {{
        id
        progress
        status
        media {{ ...mediaFields }}
      }}
    }}
  }}
}}"#,
        MEDIA_FIELDS
    )
}

const UPDATE_MUTATION: &str = r#"
mutation ($mediaId: Int, $progress: Int) {
  SaveMediaListEntry(mediaId: $mediaId, progress: $progress) {
    id progress status
  }
}"#;

const UPDATE_STATUS_MUTATION: &str = r#"
mutation ($mediaId: Int, $status: MediaListStatus) {
  SaveMediaListEntry(mediaId: $mediaId, status: $status) {
    id progress status
  }
}"#;

const DELETE_MUTATION: &str = r#"
mutation ($id: Int) {
  DeleteMediaListEntry(id: $id) { deleted }
}"#;

fn popular_season_query() -> String {
    format!(
        r#"{} query ($season: MediaSeason, $year: Int, $page: Int) {{
  Page(page: $page, perPage: 20) {{
    pageInfo {{ hasNextPage }}
    media(type: ANIME, season: $season, seasonYear: $year, sort: POPULARITY_DESC) {{
      ...mediaFields
      mediaListEntry {{ id progress status }}
    }}
  }}
}}"#,
        MEDIA_FIELDS
    )
}

fn upcoming_season_query() -> String {
    format!(
        r#"{} query ($season: MediaSeason, $year: Int, $page: Int) {{
  Page(page: $page, perPage: 20) {{
    pageInfo {{ hasNextPage }}
    media(type: ANIME, season: $season, seasonYear: $year, sort: POPULARITY_DESC) {{
      ...mediaFields
      mediaListEntry {{ id progress status }}
    }}
  }}
}}"#,
        MEDIA_FIELDS
    )
}

fn all_time_popular_query() -> String {
    format!(
        r#"{} query ($page: Int) {{
  Page(page: $page, perPage: 20) {{
    pageInfo {{ hasNextPage }}
    media(type: ANIME, sort: POPULARITY_DESC) {{
      ...mediaFields
      mediaListEntry {{ id progress status }}
    }}
  }}
}}"#,
        MEDIA_FIELDS
    )
}

fn planning_query() -> String {
    format!(
        r#"{} query ($userId: Int) {{
  MediaListCollection(userId: $userId, type: ANIME, status: PLANNING) {{
    lists {{
      entries {{
        id
        progress
        status
        media {{ ...mediaFields }}
      }}
    }}
  }}
}}"#,
        MEDIA_FIELDS
    )
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn get_config(state: State<AppState>) -> Value {
    let cfg = state.config.lock().unwrap();
    let bash = cfg.bash_path.clone().or_else(find_bash);
    serde_json::json!({
        "bash_path": bash.unwrap_or_default(),
        "quality": cfg.quality.clone().unwrap_or_else(|| "best".to_string()),
        "confirm_before_sync": cfg.confirm_before_sync.unwrap_or(true),
        "anilist_token": cfg.anilist_token.clone().unwrap_or_default(),
        "download_dir": cfg.download_dir.clone().unwrap_or_else(|| {
            dirs_next::download_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        })
    })
}

#[tauri::command]
fn save_config(state: State<AppState>, config: Value) -> bool {
    let mut cfg = state.config.lock().unwrap();
    if let Some(v) = config.get("bash_path").and_then(|v| v.as_str()) {
        cfg.bash_path = if v.is_empty() { None } else { Some(v.to_string()) };
    }
    if let Some(v) = config.get("anilist_token").and_then(|v| v.as_str()) {
        cfg.anilist_token = if v.is_empty() { None } else { Some(v.to_string()) };
    }
    if let Some(v) = config.get("quality").and_then(|v| v.as_str()) {
        cfg.quality = Some(v.to_string());
    }
    if let Some(v) = config.get("confirm_before_sync").and_then(|v| v.as_bool()) {
        cfg.confirm_before_sync = Some(v);
    }
    if let Some(v) = config.get("download_dir").and_then(|v| v.as_str()) {
        cfg.download_dir = if v.is_empty() { None } else { Some(v.to_string()) };
    }
    save_config_to_disk(&state.config_path, &cfg);
    true
}

#[tauri::command]
fn open_anilist_login() -> bool {
    let url = format!(
        "https://anilist.co/api/v2/oauth/authorize?client_id={}&response_type=token",
        ANILIST_CLIENT_ID
    );
    let _ = open::that(url);
    true
}

#[tauri::command]
async fn search_anime(state: State<'_, AppState>, query: String, page: Option<i64>) -> Result<Value, String> {
    let token = state.config.lock().unwrap().anilist_token.clone();
    anilist_query(
        &search_query(),
        serde_json::json!({ "search": query, "page": page.unwrap_or(1) }),
        token.as_deref(),
    )
    .await
}

#[tauri::command]
async fn get_trending(state: State<'_, AppState>, page: Option<i64>) -> Result<Value, String> {
    let token = state.config.lock().unwrap().anilist_token.clone();
    anilist_query(
        &trending_query(),
        serde_json::json!({ "page": page.unwrap_or(1) }),
        token.as_deref(),
    )
    .await
}

#[tauri::command]
async fn get_continue_watching(state: State<'_, AppState>) -> Result<Value, String> {
    let token = state.config.lock().unwrap().anilist_token.clone();
    let token = token.ok_or("Not logged in".to_string())?;

    let viewer = anilist_query(VIEWER_QUERY, serde_json::json!({}), Some(&token)).await?;
    let user_id = viewer["data"]["Viewer"]["id"]
        .as_i64()
        .ok_or("Could not get user ID")?;

    anilist_query(
        &current_query(),
        serde_json::json!({ "userId": user_id }),
        Some(&token),
    )
    .await
}

#[tauri::command]
async fn sync_progress(state: State<'_, AppState>, media_id: i64, ep_num: i64) -> Result<Value, String> {
    let token = state.config.lock().unwrap().anilist_token.clone();
    let token = token.ok_or("Not logged in")?;
    anilist_query(
        UPDATE_MUTATION,
        serde_json::json!({ "mediaId": media_id, "progress": ep_num }),
        Some(&token),
    )
    .await
}

#[tauri::command]
async fn update_status(state: State<'_, AppState>, media_id: i64, status: String) -> Result<Value, String> {
    let token = state.config.lock().unwrap().anilist_token.clone();

    if status == "Not in List" {
        // We need the list entry id — skip for now, handle on frontend
        return Ok(serde_json::json!({ "deleted": true }));
    }

    let token = token.ok_or("Not logged in")?;
    anilist_query(
        UPDATE_STATUS_MUTATION,
        serde_json::json!({ "mediaId": media_id, "status": status }),
        Some(&token),
    )
    .await
}

#[tauri::command]
fn play_episode(state: State<AppState>, app: AppHandle, title: String, ep_num: i64) -> Value {
    let cfg = state.config.lock().unwrap().clone();
    let bash = cfg.bash_path.clone().or_else(find_bash);

    let Some(bash_path) = bash else {
        return serde_json::json!({ "error": "bash not found. Set it in Settings." });
    };

    let quality = cfg.quality.clone().unwrap_or_else(|| "best".to_string());
    let token = cfg.anilist_token.clone();
    let player_active = state.player_active.clone();
    {
        let mut active = player_active.lock().unwrap();
        if *active {
            return serde_json::json!({ "error": "A video player is already running." });
        }
        *active = true;
    }

    std::thread::spawn(move || {
        let safe_title = title.replace('"', "");
        let cmd = format!(
            r#"ani-cli "{}" -S 1 -e {} -q {} --exit-after-play"#,
            safe_title, ep_num, quality
        );
        let start = std::time::Instant::now();
        let _ = std::process::Command::new(&bash_path)
            .args(["-lc", &cmd])
            .status();

        *player_active.lock().unwrap() = false;

        let elapsed = start.elapsed().as_secs_f64();
        if token.is_some() {
            let _ = app.emit("playback_finished", serde_json::json!({
                "epNum": ep_num,
                "elapsed": elapsed
            }));
        }
    });

    serde_json::json!({ "success": true })
}

#[tauri::command]
fn start_download(state: State<AppState>, app: AppHandle, title: String, ep_num: i64) -> Value {
    let cfg = state.config.lock().unwrap().clone();
    let bash = cfg.bash_path.clone().or_else(find_bash);

    let Some(bash_path) = bash else {
        return serde_json::json!({ "error": "bash not found" });
    };

    let quality = cfg.quality.clone().unwrap_or_else(|| "best".to_string());
    let download_dir = cfg.download_dir.clone().unwrap_or_else(|| {
        dirs_next::download_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });

    std::thread::spawn(move || {
        let safe_title = title.replace('"', "");
        let cmd = format!(
            r#"cd "{}" && ani-cli "{}" -S 1 -e {} -q {} -d"#,
            download_dir, safe_title, ep_num, quality
        );

        let mut child = match std::process::Command::new(&bash_path)
            .args(["-lc", &cmd])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit("download_log", serde_json::json!({ "line": format!("Error: {}", e) }));
                return;
            }
        };

        if let Some(stdout) = child.stdout.take() {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let _ = app.emit("download_log", serde_json::json!({ "line": line }));
            }
        }

        let status = child.wait();
        let _ = app.emit("download_finished", serde_json::json!({
            "success": status.map(|s| s.success()).unwrap_or(false)
        }));
    });

    serde_json::json!({ "success": true })
}

#[tauri::command]
async fn get_viewer_info(state: State<'_, AppState>) -> Result<Value, String> {
    let token = state.config.lock().unwrap().anilist_token.clone();
    let token = token.ok_or("Not logged in")?;
    const Q: &str = r#"query { Viewer { id name avatar { medium } } }"#;
    anilist_query(Q, serde_json::json!({}), Some(&token)).await
}

#[tauri::command]
async fn get_popular_this_season(state: State<'_, AppState>, season: String, year: i64, page: Option<i64>) -> Result<Value, String> {
    let token = state.config.lock().unwrap().anilist_token.clone();
    anilist_query(
        &popular_season_query(),
        serde_json::json!({ "season": season, "year": year, "page": page.unwrap_or(1) }),
        token.as_deref(),
    ).await
}

#[tauri::command]
async fn get_upcoming_season(state: State<'_, AppState>, season: String, year: i64, page: Option<i64>) -> Result<Value, String> {
    let token = state.config.lock().unwrap().anilist_token.clone();
    anilist_query(
        &upcoming_season_query(),
        serde_json::json!({ "season": season, "year": year, "page": page.unwrap_or(1) }),
        token.as_deref(),
    ).await
}

#[tauri::command]
async fn get_all_time_popular(state: State<'_, AppState>, page: Option<i64>) -> Result<Value, String> {
    let token = state.config.lock().unwrap().anilist_token.clone();
    anilist_query(
        &all_time_popular_query(),
        serde_json::json!({ "page": page.unwrap_or(1) }),
        token.as_deref(),
    ).await
}

#[tauri::command]
async fn get_planning(state: State<'_, AppState>) -> Result<Value, String> {
    let token = state.config.lock().unwrap().anilist_token.clone();
    let token = token.ok_or("Not logged in")?;
    let viewer = anilist_query(VIEWER_QUERY, serde_json::json!({}), Some(&token)).await?;
    let user_id = viewer["data"]["Viewer"]["id"].as_i64().ok_or("Could not get user ID")?;
    anilist_query(
        &planning_query(),
        serde_json::json!({ "userId": user_id }),
        Some(&token),
    ).await
}

#[tauri::command]
fn browse_folder() -> String {
    String::new()
}

// ─── App Entry ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config_path = get_config_path();
    let config = load_config_from_disk(&config_path);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            config: Mutex::new(config),
            config_path,
            player_active: Arc::new(Mutex::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            open_anilist_login,
            get_viewer_info,
            search_anime,
            get_trending,
            get_popular_this_season,
            get_upcoming_season,
            get_all_time_popular,
            get_continue_watching,
            get_planning,
            sync_progress,
            update_status,
            play_episode,
            start_download,
            browse_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
