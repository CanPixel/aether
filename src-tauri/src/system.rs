//! System status, settings, session restore, downloads, window geometry, and
//! conversation threads — the state that has to survive a quit.

use super::*;

pub(crate) async fn system_status(state: &State<'_, Backend>) -> Cmd<SystemStatus> {
    let settings = load_settings(&state.paths.settings_path).await?;
    let collections = with_library_read(state, |library| library.collections.clone()).await?;
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
        collections,
        content_blocking: content_blocking::content_blocking_status(),
        ai_free_search: ai_free_search_status(&settings.browser),
        error: catalog.error,
    })
}

pub(crate) async fn load_library(path: &Path) -> Cmd<LibraryData> {
    read_json_or_default(path).await
}

/// Drops captures whose collection no longer exists, returning how many went.
///
/// A capture in this state is not reachable from the hub list, but it is still in
/// `captures`, so it keeps answering searches — under the "Knowledge Hub" fallback
/// name, because there is no collection left to name it. To the user that is a
/// source they deleted coming back.
pub(crate) fn drop_captures_without_collections(library: &mut LibraryData) -> usize {
    let collections = library
        .collections
        .iter()
        .map(|collection| collection.id.clone())
        .collect::<HashSet<_>>();
    let before = library.captures.len();
    library
        .captures
        .retain(|capture| collections.contains(&capture.collection_id));
    before - library.captures.len()
}

/// Drops chunks whose capture is gone, returning how many went.
///
/// Deliberately keyed on the capture rather than the collection: a chunk belongs
/// to a capture, and `drop_captures_without_collections` has already removed the
/// captures of dead collections, so one rule covers both kinds of orphan.
pub(crate) fn retain_chunks_with_live_captures(
    chunks: &mut Vec<ChunkRecord>,
    live_captures: &HashSet<String>,
) -> usize {
    let before = chunks.len();
    chunks.retain(|chunk| live_captures.contains(&chunk.capture_id));
    before - chunks.len()
}

/// Clears orphans left behind by a crash mid-delete, once, at startup.
///
/// The delete paths now commit in the order that makes an interrupted delete leave
/// only the harmless orphan, so this is not needed for anything written after that
/// change. It is here for stores that predate it: the bad ordering was live, and a
/// store carrying its orphans has no other way to shed them.
///
/// **On the lock nesting.** The library write lock is held across the vector
/// mutation, which is the only way this is safe against a capture running at the
/// same time: capture commits its library entry first and writes chunks second, so
/// a snapshot of live captures taken without that lock could miss an entry whose
/// chunks then land — and those brand-new chunks would look exactly like orphans.
/// Holding the library lock makes that interleaving impossible. It cannot deadlock
/// against capture, which never holds the library lock while waiting for the
/// vector one; the helpers each acquire and release in turn.
pub(crate) async fn reconcile_orphans(state: &State<'_, Backend>) -> Cmd<(usize, usize)> {
    let mut library_guard = state.library.write().await;
    if library_guard.is_none() {
        *library_guard = Some(load_library(&state.paths.library_path).await?);
    }
    let library = library_guard.as_mut().expect("library cache");

    let dropped_captures = drop_captures_without_collections(library);
    let live_captures = library
        .captures
        .iter()
        .map(|capture| capture.id.clone())
        .collect::<HashSet<_>>();

    let mut vectors_guard = state.vectors.write().await;
    if vectors_guard.is_none() {
        *vectors_guard = Some(load_vectors(&state.paths.chunks_path).await?);
    }
    let vectors = vectors_guard.as_mut().expect("vector store cache");
    let dropped_chunks = retain_chunks_with_live_captures(&mut vectors.chunks, &live_captures);

    // Nothing to write in the common case, which is every launch after the first
    // on a healthy store. Both saves rewrite whole files, so skipping them matters.
    if dropped_chunks > 0 {
        // Same reasoning as a user-initiated delete: the point is that the vectors
        // of an unreachable source actually leave the sidecar.
        compact_vectors(&state.paths.chunks_path, vectors).await?;
        save_vector_metadata(&state.paths.chunks_path, vectors).await?;
    }
    if dropped_captures > 0 {
        save_json(&state.paths.library_path, library).await?;
    }

    if dropped_captures > 0 || dropped_chunks > 0 {
        diag_info!(
            "reconciled an interrupted delete: dropped {dropped_captures} orphaned capture(s) and {dropped_chunks} orphaned chunk(s)"
        );
    }
    Ok((dropped_captures, dropped_chunks))
}

/// Looks a collection up in an already-loaded library. Split from `get_collection`
/// so a caller that holds the library can check an id without a second read — the
/// double read this replaced was the whole cost of validating a search's scope.
pub(crate) fn find_collection(
    library: &LibraryData,
    collection_id: &str,
) -> Cmd<CollectionSummary> {
    library
        .collections
        .iter()
        .find(|collection| collection.id == collection_id)
        .cloned()
        .ok_or_else(|| "Collection not found.".to_string())
}

pub(crate) async fn get_collection(
    state: &State<'_, Backend>,
    collection_id: &str,
) -> Cmd<CollectionSummary> {
    with_library_read(state, |library| find_collection(library, collection_id)).await?
}

/// Collection id -> display name, for labelling search hits and graph nodes.
///
/// Every retrieval path needs exactly this and nothing else from the library, so
/// it is worth a named helper: the alternative each site reached for was cloning
/// the whole collection list to build the same map.
pub(crate) async fn collection_names(
    state: &State<'_, Backend>,
) -> Cmd<HashMap<String, String>> {
    with_library_read(state, |library| {
        library
            .collections
            .iter()
            .map(|collection| (collection.id.clone(), collection.name.clone()))
            .collect()
    })
    .await
}

/// Reads the cached library, loading it from disk on first use.
pub(crate) async fn with_library_read<T>(
    state: &State<'_, Backend>,
    read: impl FnOnce(&LibraryData) -> T,
) -> Cmd<T> {
    {
        let guard = state.library.read().await;
        if let Some(library) = guard.as_ref() {
            return Ok(read(library));
        }
    }
    let mut guard = state.library.write().await;
    if guard.is_none() {
        *guard = Some(load_library(&state.paths.library_path).await?);
    }
    Ok(read(guard.as_ref().expect("library cache")))
}

/// Mutates the cached library under the write lock and persists the result, so a
/// read-modify-write cannot interleave with another command's.
///
/// The closure is fallible because most callers validate against the library they
/// are about to change ("Collection not found", "Page is already in X"), and doing
/// that outside the lock is the race this function exists to close. A closure that
/// returns `Err` may already have edited the library, so the cache is dropped
/// rather than saved: the next read reloads the last known-good file, and a
/// half-applied edit never becomes visible.
pub(crate) async fn with_library_mut<T>(
    state: &State<'_, Backend>,
    mutate: impl FnOnce(&mut LibraryData) -> Cmd<T>,
) -> Cmd<T> {
    let mut guard = state.library.write().await;
    if guard.is_none() {
        *guard = Some(load_library(&state.paths.library_path).await?);
    }
    let library = guard.as_mut().expect("library cache");

    let result = match mutate(library) {
        Ok(result) => result,
        Err(error) => {
            *guard = None;
            return Err(error);
        }
    };

    // Same reasoning as the error path: if the write fails, what is on disk and
    // what is in memory have diverged, and memory is the wrong one to trust.
    if let Err(error) = save_json(&state.paths.library_path, library).await {
        *guard = None;
        return Err(error);
    }
    Ok(result)
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
            // A tab parked on the internal start page has nothing to reopen, and a
            // private tab must not survive the session that opened it.
            .filter(|tab| {
                !tab.private && tab.url != START_PAGE_URL && !tab.url.starts_with("aether://")
            })
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
