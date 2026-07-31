//! The binary vector sidecar (`chunks.vec`) beside the JSON chunk metadata.
//!
//! Write ordering is load-bearing: vector data is fsynced before the metadata that
//! references it, so a crash mid-save can leave an unreferenced slot but never a
//! chunk pointing at a slot that was never written.

use super::*;

pub(crate) async fn load_vectors(path: &Path) -> Cmd<VectorStoreData> {
    // A v1 store carries its vectors inline, so it must be detected before the v2
    // deserializer silently drops them (`vector` is #[serde(skip)] there).
    if let Ok(raw) = tokio::fs::read_to_string(path).await {
        let declared_version = serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|value| value.get("version").and_then(serde_json::Value::as_u64));
        if declared_version.unwrap_or(1) < VECTOR_STORE_VERSION as u64 {
            return migrate_legacy_vectors(path, &raw).await;
        }
    }

    let mut data: VectorStoreData = read_json_or_default(path).await?;
    hydrate_vectors(path, &mut data).await?;
    Ok(data)
}

// Reads the sidecar and attaches each chunk's vector. Chunks whose slot is missing
// from the file are dropped rather than fatal: a partial sidecar should cost the
// affected sources, not the whole library.
pub(crate) async fn hydrate_vectors(path: &Path, data: &mut VectorStoreData) -> Cmd<()> {
    if data.chunks.is_empty() {
        return Ok(());
    }
    if data.dim == 0 {
        diag_warn!("vector store has chunks but no dimension; dropping stale metadata");
        data.chunks.clear();
        return Ok(());
    }

    let vector_path = vector_data_path(path);
    let bytes = match tokio::fs::read(&vector_path).await {
        Ok(bytes) => bytes,
        Err(error) => {
            diag_warn!(
                "vector sidecar {} unreadable ({error}); captures need re-indexing",
                vector_path.display()
            );
            data.chunks.clear();
            return Ok(());
        }
    };

    let stride = data.dim * 4;
    let available = (bytes.len() / stride) as u64;
    let before = data.chunks.len();

    // Parked chunks hold no slot, so they survive regardless of what the sidecar has.
    data.chunks
        .retain(|chunk| chunk.needs_reembed || chunk.vector_slot < available);
    for chunk in &mut data.chunks {
        if chunk.needs_reembed {
            continue;
        }
        let start = chunk.vector_slot as usize * stride;
        chunk.vector = bytes[start..start + stride]
            .chunks_exact(4)
            .map(|word| f32::from_le_bytes([word[0], word[1], word[2], word[3]]))
            .collect();
    }

    if data.chunks.len() != before {
        diag_warn!(
            "dropped {} chunk(s) missing from the vector sidecar",
            before - data.chunks.len()
        );
    }
    Ok(())
}

pub(crate) async fn migrate_legacy_vectors(path: &Path, raw: &str) -> Cmd<VectorStoreData> {
    let legacy: LegacyVectorStoreData = match serde_json::from_str(raw) {
        Ok(legacy) => legacy,
        Err(error) => {
            diag_warn!("could not read legacy vector store ({error}); starting fresh");
            return Ok(VectorStoreData::default());
        }
    };

    // v1 imposed no single width, so a store written across an embedding-model change
    // holds a mix. v2 has one stride, so the migration must pick one width and park the
    // rest. Choosing the width the most chunks use preserves the most vectors; picking
    // the first chunk's width would hand the store to whichever model happened to be
    // written first, which on a real install was the *older* model.
    let mut data = VectorStoreData {
        dim: majority_vector_dim(&legacy.chunks),
        ..VectorStoreData::default()
    };
    data.push_chunks(legacy.chunks.into_iter().map(|chunk| ChunkRecord {
        id: chunk.id,
        vector: chunk.vector,
        vector_slot: 0,
        needs_reembed: false,
        text: chunk.text,
        collection_id: chunk.collection_id,
        capture_id: chunk.capture_id,
        title: chunk.title,
        url: chunk.url,
        app_id: chunk.app_id,
        captured_at: chunk.captured_at,
        chunk_index: chunk.chunk_index,
    }));

    let parked = data.pending_reembed_count();
    diag_info!(
        "migrating {} chunk(s) to the binary vector store at {} dims{}",
        data.chunks.len(),
        data.dim,
        if parked > 0 {
            format!(", parking {parked} from another embedding model for re-indexing")
        } else {
            String::new()
        }
    );
    // Keep the pre-migration file under a name no ordinary save touches. The `.bak`
    // rotation is one generation deep, so the next capture would overwrite a v1 backup
    // with a v2 copy and leave no way back to the original vectors.
    archive_pre_migration_store(path, raw).await;
    write_vector_sidecar(path, &data, 0).await?;
    save_vector_metadata(path, &data).await?;
    Ok(data)
}

// The width the most chunks share, so the migration keeps the largest set of usable
// vectors. Ties break toward the wider vector, which is the newer model in practice.
pub(crate) fn majority_vector_dim(chunks: &[LegacyChunkRecord]) -> usize {
    let mut counts: HashMap<usize, usize> = HashMap::new();
    for chunk in chunks {
        if !chunk.vector.is_empty() {
            *counts.entry(chunk.vector.len()).or_insert(0) += 1;
        }
    }
    counts
        .into_iter()
        .max_by_key(|(dim, count)| (*count, *dim))
        .map(|(dim, _)| dim)
        .unwrap_or(0)
}

// Writes the untouched v1 bytes alongside the store, once. A second migration must not
// clobber the first archive: that copy is the only remaining source for any vector the
// migration parked.
pub(crate) async fn archive_pre_migration_store(path: &Path, raw: &str) {
    let mut name = path.file_stem().unwrap_or_default().to_os_string();
    name.push(PRE_MIGRATION_SUFFIX);
    let target = path.with_file_name(name);
    if tokio::fs::try_exists(&target).await.unwrap_or(false) {
        return;
    }
    match write_bytes_atomically(&target, raw.as_bytes(), false).await {
        Ok(()) => diag_error!(
            "archived the pre-migration vector store at {}",
            target.display()
        ),
        Err(error) => diag_error!("could not archive the pre-migration store: {error}"),
    }
}

pub(crate) async fn with_vectors_read<T>(
    state: &State<'_, Backend>,
    read: impl FnOnce(&VectorStoreData) -> T,
) -> Cmd<T> {
    {
        let guard = state.vectors.read().await;
        if let Some(vectors) = guard.as_ref() {
            return Ok(read(vectors));
        }
    }
    let mut guard = state.vectors.write().await;
    if guard.is_none() {
        *guard = Some(load_vectors(&state.paths.chunks_path).await?);
    }
    Ok(read(guard.as_ref().expect("vector store cache")))
}

pub(crate) async fn with_vectors_mut<T>(
    state: &State<'_, Backend>,
    mutate: impl FnOnce(&mut VectorStoreData) -> T,
) -> Cmd<T> {
    let mut guard = state.vectors.write().await;
    if guard.is_none() {
        *guard = Some(load_vectors(&state.paths.chunks_path).await?);
    }
    let vectors = guard.as_mut().expect("vector store cache");
    let result = mutate(vectors);
    save_vectors(&state.paths.chunks_path, vectors).await?;
    Ok(result)
}

/// `with_vectors_mut` for a deletion the user asked for, which rewrites the
/// sidecar instead of waiting for the usual compaction thresholds.
///
/// Removing a chunk drops its text — the metadata file is rewritten whole on
/// every save — but the vector itself only leaves the sidecar when compaction
/// renumbers the live slots, and that needs 512 slots at ≥50% dead. Until then
/// the floats for a source the user deleted are still on disk. Embedding vectors
/// are not the text, but they are derived from it, and "delete" should not leave
/// a residue whose lifetime depends on how much else happens to be in the store.
///
/// Kept separate from `with_vectors_mut` on purpose: this rewrites the whole
/// sidecar, which is the cost the ratio thresholds exist to avoid on the routine
/// save path. Only an explicit delete is worth paying it.
pub(crate) async fn with_vectors_deleted<T>(
    state: &State<'_, Backend>,
    mutate: impl FnOnce(&mut VectorStoreData) -> T,
) -> Cmd<T> {
    let mut guard = state.vectors.write().await;
    if guard.is_none() {
        *guard = Some(load_vectors(&state.paths.chunks_path).await?);
    }
    let vectors = guard.as_mut().expect("vector store cache");
    let result = mutate(vectors);
    compact_vectors(&state.paths.chunks_path, vectors).await?;
    save_vector_metadata(&state.paths.chunks_path, vectors).await?;
    Ok(result)
}

// Vector rows are large and machine-managed, so the metadata is persisted as compact
// JSON instead of the pretty format used for small user-editable stores.
pub(crate) async fn save_vector_metadata(path: &Path, data: &VectorStoreData) -> Cmd<()> {
    let raw = serde_json::to_string(data).map_err(|error| error.to_string())?;
    write_store_durably(path, raw.as_bytes()).await
}

// Writes vectors for every chunk whose slot is at or beyond `slots_present`.
// `slots_present == 0` rewrites the sidecar from scratch.
pub(crate) async fn write_vector_sidecar(
    path: &Path,
    data: &VectorStoreData,
    slots_present: u64,
) -> Cmd<()> {
    let vector_path = vector_data_path(path);
    ensure_parent_dir(&vector_path).await?;

    let mut pending = data
        .chunks
        .iter()
        .filter(|chunk| !chunk.needs_reembed && chunk.vector_slot >= slots_present)
        .collect::<Vec<_>>();
    if pending.is_empty() && slots_present > 0 {
        return Ok(());
    }
    // Slot order is file order; appending out of order would corrupt the stride index.
    pending.sort_by_key(|chunk| chunk.vector_slot);

    let mut buffer = Vec::with_capacity(pending.len() * data.dim.max(1) * 4);
    for chunk in pending {
        for value in &chunk.vector {
            buffer.extend_from_slice(&value.to_le_bytes());
        }
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(slots_present > 0)
        .truncate(slots_present == 0)
        .open(&vector_path)
        .await
        .map_err(|error| error.to_string())?;
    file.write_all(&buffer)
        .await
        .map_err(|error| error.to_string())?;
    // The metadata written next will reference these slots, so they must be on disk
    // before it lands. Orphaned vector bytes are harmless; dangling slots are not.
    file.sync_all().await.map_err(|error| error.to_string())
}

pub(crate) async fn sidecar_slots_present(path: &Path, dim: usize) -> u64 {
    if dim == 0 {
        return 0;
    }
    match tokio::fs::metadata(vector_data_path(path)).await {
        Ok(meta) => meta.len() / (dim as u64 * 4),
        Err(_) => 0,
    }
}

// Deletes leave dead slots behind. Once they dominate the sidecar, renumber the live
// chunks and rewrite it so the file cannot grow without bound.
pub(crate) async fn compact_vectors_if_needed(
    path: &Path,
    data: &mut VectorStoreData,
) -> Cmd<bool> {
    // Parked chunks hold no slot, so counting them as live would understate how much
    // of the sidecar is dead and stop compaction from ever triggering.
    let live = data.embedded_count();
    if data.next_slot < VECTOR_COMPACTION_MIN_SLOTS {
        return Ok(false);
    }
    let dead = data.next_slot.saturating_sub(live);
    if (dead as f64) < data.next_slot as f64 * VECTOR_COMPACTION_DEAD_RATIO {
        return Ok(false);
    }

    compact_vectors(path, data).await?;
    Ok(true)
}

// Renumbers the live chunks and rewrites the sidecar from scratch, unconditionally.
// Callers that only want this when it pays for itself go through
// compact_vectors_if_needed; a user-initiated delete calls it directly, because
// there the point is that the bytes actually leave the file.
pub(crate) async fn compact_vectors(path: &Path, data: &mut VectorStoreData) -> Cmd<()> {
    let live = data.embedded_count();
    let dead = data.next_slot.saturating_sub(live);

    // Embedded chunks first in slot order, parked ones after, so renumbering walks
    // exactly the records that occupy the sidecar.
    data.chunks
        .sort_by_key(|chunk| (chunk.needs_reembed, chunk.vector_slot));
    let mut next = 0_u64;
    for chunk in data.chunks.iter_mut() {
        if chunk.needs_reembed {
            continue;
        }
        chunk.vector_slot = next;
        next += 1;
    }
    data.next_slot = live;
    if dead > 0 {
        diag_info!("compacted vector store, reclaimed {dead} dead slot(s)");
    }
    write_vector_sidecar(path, data, 0).await
}

pub(crate) async fn save_vectors(path: &Path, data: &mut VectorStoreData) -> Cmd<()> {
    if !compact_vectors_if_needed(path, data).await? {
        let slots_present = sidecar_slots_present(path, data.dim).await;
        write_vector_sidecar(path, data, slots_present).await?;
    }
    save_vector_metadata(path, data).await
}
