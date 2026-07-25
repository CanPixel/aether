//! System status, settings, session restore, downloads, window geometry, and
//! conversation threads — the state that has to survive a quit.

use super::*;

pub(crate) async fn system_status(state: &State<'_, Backend>) -> Cmd<SystemStatus> {
    let settings = load_settings(&state.paths.settings_path).await?;
    let library = load_library(&state.paths.library_path).await?;
    let catalog = model_catalog(&state.paths, &settings.local_model);
    Ok(SystemStatus {
        runtime_ready: catalog.chat_model.is_some() || catalog.embedding_model.is_some(),
        runtime_name: LOCAL_RUNTIME_NAME.to_string(),
        embedding_model: catalog
            .embedding_model
            .as_ref()
            .map(|path| path_to_model_value(path)),
        chat_model: catalog
            .chat_model
            .as_ref()
            .map(|path| path_to_model_value(path)),
        available_models: catalog
            .models
            .iter()
            .map(|path| path_to_model_value(path))
            .collect(),
        chat_models: catalog
            .models
            .iter()
            .filter(|path| is_chat_model(path))
            .map(|path| path_to_model_value(path))
            .collect(),
        embedding_models: catalog
            .models
            .iter()
            .filter(|path| is_embedding_model(path))
            .map(|path| path_to_model_value(path))
            .collect(),
        model_dir: state.paths.models_path.display().to_string(),
        db_path: state.paths.db_path.display().to_string(),
        library_path: state.paths.library_path.display().to_string(),
        collections: library.collections,
        error: catalog.error,
    })
}

pub(crate) async fn load_library(path: &Path) -> Cmd<LibraryData> {
    read_json_or_default(path).await
}

pub(crate) async fn load_settings(path: &Path) -> Cmd<UserSettings> {
    read_json_or_default(path).await
}

pub(crate) async fn persist_update_last_checked_at(paths: &DataPaths, checked_at: &str) -> Cmd<()> {
    let mut settings = load_settings(&paths.settings_path).await?;
    settings.updates.last_checked_at = Some(checked_at.to_string());
    save_json(&paths.settings_path, &settings).await
}

pub(crate) fn release_version_from_tag(tag: &str) -> String {
    tag.trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .to_string()
}

pub(crate) fn version_is_newer(candidate: &str, current: &str) -> bool {
    let candidate_parts = version_parts(candidate);
    let current_parts = version_parts(current);
    let max_len = candidate_parts.len().max(current_parts.len()).max(3);
    for index in 0..max_len {
        let candidate_value = candidate_parts.get(index).copied().unwrap_or_default();
        let current_value = current_parts.get(index).copied().unwrap_or_default();
        if candidate_value > current_value {
            return true;
        }
        if candidate_value < current_value {
            return false;
        }
    }
    false
}

pub(crate) fn version_parts(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

pub(crate) async fn load_icebergs(path: &Path) -> Cmd<IcebergData> {
    read_json_or_default(path).await
}

pub(crate) async fn load_conversations(path: &Path) -> Cmd<ConversationData> {
    read_json_or_default(path).await
}

pub(crate) async fn load_session(path: &Path) -> Cmd<SessionData> {
    read_json_or_default(path).await
}

// Snapshots the open tabs. Called after any tab mutation rather than at exit, because
// force_exit() hard-kills the process on quit and never gives a shutdown hook a turn.
pub(crate) async fn persist_session_tabs(state: &State<'_, Backend>) -> Cmd<()> {
    let (tabs, active_tab_id) = {
        let guard = lock_tabs(state)?;
        let tabs = guard
            .tabs
            .iter()
            // A tab parked on the internal start page has nothing to reopen.
            .filter(|tab| tab.url != START_PAGE_URL && !tab.url.starts_with("aether://"))
            .map(|tab| SessionTab {
                id: tab.id.clone(),
                url: tab.url.clone(),
                title: tab.title.clone(),
            })
            .collect::<Vec<_>>();
        (tabs, guard.active_tab_id.clone())
    };

    let mut session = load_session(&state.paths.session_path).await?;
    session.tabs = tabs;
    session.active_tab_id = active_tab_id;
    save_json(&state.paths.session_path, &session).await
}

// Fire-and-forget wrapper for the sync command paths. A failed session write must
// never make a tab action fail.
pub(crate) fn schedule_session_save(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Backend>();
        if let Err(error) = persist_session_tabs(&state).await {
            diag_warn!("could not save session: {error}");
        }
    });
}

pub(crate) async fn persist_session_window(paths: &DataPaths, window: SessionWindow) -> Cmd<()> {
    let mut session = load_session(&paths.session_path).await?;
    session.window = Some(window);
    save_json(&paths.session_path, &session).await
}

#[cfg(desktop)]
pub(crate) fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string())
}

// Derives a safe filename from a URL. Path separators and control characters are
// stripped so a crafted URL cannot write outside the downloads directory.
#[cfg(desktop)]
pub(crate) fn file_name_from_url(url: &Url) -> String {
    let raw = url
        .path_segments()
        .and_then(|mut segments| segments.rfind(|segment| !segment.is_empty()))
        .unwrap_or("download");
    let decoded = percent_decode_download_name(raw);
    let cleaned = decoded
        .chars()
        .filter(|character| {
            !character.is_control() && !matches!(character, '/' | '\\' | ':' | '\0')
        })
        .collect::<String>();
    let trimmed = cleaned.trim().trim_start_matches('.').to_string();
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.chars().take(180).collect()
    }
}

#[cfg(desktop)]
pub(crate) fn percent_decode_download_name(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&raw[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

// Never overwrite an existing file: a second download of the same name becomes
// "name (2).ext" the way a browser does.
#[cfg(desktop)]
pub(crate) fn resolve_download_destination(app: &AppHandle, url: &Url) -> Option<PathBuf> {
    let dir = app.path().download_dir().ok().or_else(|| {
        app.path()
            .home_dir()
            .ok()
            .map(|home| home.join("Downloads"))
    })?;
    if fs::create_dir_all(&dir).is_err() {
        return None;
    }

    let name = file_name_from_url(url);
    let candidate = dir.join(&name);
    if !candidate.exists() {
        return Some(candidate);
    }

    let path = Path::new(&name);
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let extension = path
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default();
    for index in 2..1000 {
        let candidate = dir.join(format!("{stem} ({index}){extension}"));
        if !candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(desktop)]
pub(crate) fn emit_download_event(
    app: &AppHandle,
    status: &str,
    filename: &str,
    path: Option<&Path>,
    url: &str,
) {
    let _ = app.emit(
        AETHER_DOWNLOAD_EVENT,
        DownloadProgress {
            status: status.to_string(),
            filename: filename.to_string(),
            path: path.map(|path| path.display().to_string()),
            url: url.to_string(),
        },
    );
}

#[cfg(desktop)]
pub(crate) fn restore_session_tabs(state: &State<Backend>, session: &SessionData) {
    if session.tabs.is_empty() {
        return;
    }
    let Ok(mut tabs) = state.tabs.lock() else {
        return;
    };
    let restored = session
        .tabs
        .iter()
        .map(|tab| {
            let mut managed = ManagedTab::new("browser", &tab.url);
            // Keep the stored id so the saved active-tab id still resolves.
            managed.id = tab.id.clone();
            if !tab.title.is_empty() {
                managed.title = tab.title.clone();
            }
            managed
        })
        .collect::<Vec<_>>();

    let active = if restored.iter().any(|tab| tab.id == session.active_tab_id) {
        session.active_tab_id.clone()
    } else {
        restored[0].id.clone()
    };

    tabs.active_tab_id = active;
    tabs.tabs = restored;
    // The dashboard is still the landing surface; restored tabs wait behind it.
    tabs.dashboard_open = true;
}

#[cfg(desktop)]
pub(crate) fn current_window_geometry(window: &Window) -> Option<SessionWindow> {
    let scale = window.scale_factor().ok()?;
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    Some(SessionWindow {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
    })
}

#[cfg(desktop)]
pub(crate) fn apply_session_window(window: &Window, geometry: SessionWindow) {
    // Guard against a stored geometry that would open the window off-screen or too
    // small to use (a display was unplugged, or the config was hand-edited).
    if geometry.width < 480.0 || geometry.height < 360.0 {
        return;
    }
    let _ = window.set_size(Size::Logical(LogicalSize::new(
        geometry.width,
        geometry.height,
    )));
    if geometry.x > -20_000.0 && geometry.y > -20_000.0 {
        let _ = window.set_position(Position::Logical(LogicalPosition::new(
            geometry.x, geometry.y,
        )));
    }
}

#[cfg(desktop)]
pub(crate) fn save_window_geometry_now(app: &AppHandle) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    let Some(geometry) = current_window_geometry(&window) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Backend>();
        if let Err(error) = persist_session_window(&state.paths, geometry).await {
            diag_warn!("could not save window geometry: {error}");
        }
    });
}

// Resize and move fire continuously while dragging, so throttle the writes. The
// CloseRequested handler catches whatever the throttle skipped.
#[cfg(desktop)]
pub(crate) fn schedule_window_geometry_save(app: &AppHandle) {
    let state = app.state::<Backend>();
    {
        let Ok(mut last) = state.window_geometry_saved_at.lock() else {
            return;
        };
        if let Some(previous) = *last {
            if previous.elapsed() < Duration::from_millis(500) {
                return;
            }
        }
        *last = Some(Instant::now());
    }
    save_window_geometry_now(app);
}

pub(crate) fn conversation_thread_key(collection_id: Option<&str>) -> String {
    collection_id
        .filter(|id| !id.is_empty())
        .unwrap_or(CURRENT_PAGE_THREAD_KEY)
        .to_string()
}

pub(crate) async fn conversation_thread(
    paths: &DataPaths,
    collection_id: Option<&str>,
) -> Vec<ConversationTurn> {
    let key = conversation_thread_key(collection_id);
    load_conversations(&paths.conversations_path)
        .await
        .unwrap_or_default()
        .threads
        .remove(&key)
        .unwrap_or_default()
}

pub(crate) async fn append_conversation_turn(
    paths: &DataPaths,
    collection_id: Option<&str>,
    turn: ConversationTurn,
) -> Cmd<()> {
    let key = conversation_thread_key(collection_id);
    let mut data = load_conversations(&paths.conversations_path).await?;
    let thread = data.threads.entry(key).or_default();
    thread.push(turn);
    if thread.len() > MAX_THREAD_TURNS {
        let overflow = thread.len() - MAX_THREAD_TURNS;
        thread.drain(0..overflow);
    }
    save_json(&paths.conversations_path, &data).await
}
