//! Durable store IO. Every write is temp-then-rename with a one-generation `.bak`
//! beside it, and an unreadable store is quarantined rather than overwritten — a
//! corrupt file must never cost the user their library.

use super::*;

pub(crate) fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(BACKUP_SUFFIX);
    path.with_file_name(name)
}

pub(crate) fn temp_write_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(TEMP_WRITE_SUFFIX);
    path.with_file_name(name)
}

pub(crate) async fn ensure_parent_dir(path: &Path) -> Cmd<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

// Writes bytes to a sibling temp file, fsyncs it, then renames it over the target.
// `rotate` additionally renames the previous good file to `<name>.bak` first, so a
// crash can never leave the store both truncated and without a recoverable copy.
//
// Both renames are atomic within a directory, so the target is only ever the old
// complete file or the new complete file. The gap where the target is momentarily
// absent is covered by the backup, which `read_json_or_default` falls back to.
pub(crate) async fn write_bytes_atomically(path: &Path, bytes: &[u8], rotate: bool) -> Cmd<()> {
    ensure_parent_dir(path).await?;
    let temp = temp_write_path(path);

    // Scope the handle so it is flushed and closed before the rename.
    {
        let mut file = tokio::fs::File::create(&temp)
            .await
            .map_err(|error| error.to_string())?;
        file.write_all(bytes)
            .await
            .map_err(|error| error.to_string())?;
        // Without this the rename can land before the data does, which is exactly
        // the truncated-store case this function exists to prevent.
        file.sync_all().await.map_err(|error| error.to_string())?;
    }

    if rotate && tokio::fs::try_exists(path).await.unwrap_or(false) {
        let backup = backup_path(path);
        if let Err(error) = tokio::fs::rename(path, &backup).await {
            // A missing backup is recoverable; failing the whole save is not.
            diag_warn!("could not rotate backup for {}: {error}", path.display());
        }
    }

    tokio::fs::rename(&temp, path)
        .await
        .map_err(|error| error.to_string())
}

pub(crate) async fn write_store_durably(path: &Path, bytes: &[u8]) -> Cmd<()> {
    write_bytes_atomically(path, bytes, true).await
}

// Quarantines an unparseable store instead of overwriting it. Losing a store to a
// bug is bad; silently replacing it with a default and destroying the evidence is
// worse, so the bad bytes are kept for manual recovery.
pub(crate) async fn quarantine_unreadable_store(path: &Path) {
    if !tokio::fs::try_exists(path).await.unwrap_or(false) {
        return;
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".corrupt-{}", now().replace(':', "-")));
    let target = path.with_file_name(name);
    match tokio::fs::rename(path, &target).await {
        Ok(()) => diag_error!("kept unreadable store at {} for recovery", target.display()),
        Err(error) => diag_error!("could not quarantine {}: {error}", path.display()),
    }
}

// Load order: primary store, then `.bak`, then a fresh default. A parse failure on
// the primary is treated as corruption rather than as an error, so one bad file
// cannot make the app permanently unopenable.
pub(crate) async fn read_json_or_default<T>(path: &Path) -> Cmd<T>
where
    T: DeserializeOwned + Default + Serialize,
{
    if let Ok(raw) = tokio::fs::read_to_string(path).await {
        match serde_json::from_str::<T>(&raw) {
            Ok(value) => return Ok(value),
            Err(error) => diag_warn!("{} is unreadable ({error}); trying backup", path.display()),
        }
    }

    let backup = backup_path(path);
    if let Ok(raw) = tokio::fs::read_to_string(&backup).await {
        if let Ok(value) = serde_json::from_str::<T>(&raw) {
            diag_info!("recovered {} from backup", path.display());
            quarantine_unreadable_store(path).await;
            // Restore without rotating: the backup we just read is the only good
            // copy left, and rotating here would overwrite it with the bad file.
            write_bytes_atomically(path, raw.as_bytes(), false).await?;
            return Ok(value);
        }
        diag_error!("backup {} is also unreadable", backup.display());
    }

    quarantine_unreadable_store(path).await;
    let data = T::default();
    let raw = serde_json::to_string_pretty(&data).map_err(|error| error.to_string())?;
    write_bytes_atomically(path, format!("{raw}\n").as_bytes(), false).await?;
    Ok(data)
}

pub(crate) async fn save_json<T: Serialize>(path: &Path, data: &T) -> Cmd<()> {
    let raw = serde_json::to_string_pretty(data).map_err(|error| error.to_string())?;
    write_store_durably(path, format!("{raw}\n").as_bytes()).await
}

pub(crate) async fn get_collection(path: &Path, collection_id: &str) -> Cmd<CollectionSummary> {
    load_library(path)
        .await?
        .collections
        .into_iter()
        .find(|collection| collection.id == collection_id)
        .ok_or_else(|| "Collection not found.".to_string())
}
