//! Finding, ranking, and describing the local GGUF models on disk, plus the
//! environment-variable overrides and the llama.cpp tuning knobs.

use super::*;

pub(crate) fn model_catalog(paths: &DataPaths, settings: &LocalModelSettings) -> ModelCatalog {
    let mut errors = Vec::new();
    let model_dirs = [
        paths.models_path.clone(),
        paths.models_path.join("chat"),
        paths.models_path.join("embeddings"),
    ];
    for dir in &model_dirs {
        if let Err(error) = fs::create_dir_all(dir) {
            errors.push(format!(
                "Could not create model directory {}: {error}",
                dir.display()
            ));
        }
    }

    let mut models = Vec::new();
    collect_gguf_models(&paths.models_path, &mut models);
    if let Ok(dir) = env::var(AETHER_MODEL_DIR_ENV) {
        let dir = PathBuf::from(dir);
        collect_gguf_models(&dir, &mut models);
    }
    for var in [AETHER_CHAT_MODEL_ENV, AETHER_EMBEDDING_MODEL_ENV] {
        match env_model_path(var) {
            Ok(Some(path)) => models.push(path),
            Ok(None) => {}
            Err(error) => errors.push(error),
        }
    }
    for (value, embedding) in [
        (settings.chat_model.as_deref(), false),
        (settings.embedding_model.as_deref(), true),
    ] {
        if let Some(path) = value.and_then(|value| selected_direct_model_path(value, embedding)) {
            models.push(path);
        }
    }

    models = dedupe_model_paths(models);
    let embedding_model = pick_embedding_model(&models, settings);
    let chat_model = pick_chat_model(&models, settings);
    if models.is_empty() {
        errors.push(format!(
            "No local models found. Use Model Setup to install AiON MiST/Qwen3 Embedding and Gemma 4, add compatible GGUF models to {}, or set {AETHER_MODEL_DIR_ENV}.",
            paths.models_path.display()
        ));
    } else {
        if embedding_model.is_none() {
            errors.push(format!(
                "No embedding model selected. Put Qwen3 Embedding or another embedding GGUF in {} or set {AETHER_EMBEDDING_MODEL_ENV}.",
                paths.models_path.join("embeddings").display()
            ));
        }
        if chat_model.is_none() {
            errors.push(format!(
                "No chat GGUF selected. Put a Gemma chat model in {} or set {AETHER_CHAT_MODEL_ENV}.",
                paths.models_path.join("chat").display()
            ));
        }
    }

    ModelCatalog {
        models,
        chat_model,
        embedding_model,
        error: if errors.is_empty() {
            None
        } else {
            Some(errors.join(" "))
        },
    }
}

pub(crate) fn selected_direct_model_path(value: &str, embedding: bool) -> Option<PathBuf> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    if selected_model_matches_kind(&path, embedding) {
        Some(canonical_model_path(&path))
    } else {
        None
    }
}

pub(crate) fn collect_gguf_models(root: &Path, models: &mut Vec<PathBuf>) {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 4 {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push((path, depth + 1));
            } else if is_gguf_model(&path) {
                models.push(path);
            }
        }
    }
}

pub(crate) fn default_models_path(app_data_dir: &Path) -> PathBuf {
    // The repo-relative dev path is a compile-time string from the build
    // machine; on a phone it would point at a nonexistent host filesystem.
    if cfg!(all(debug_assertions, desktop)) {
        project_models_path()
    } else {
        app_data_dir.join("aether-models")
    }
}

pub(crate) fn project_models_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|path| path.join("aether-models"))
        .unwrap_or_else(|| PathBuf::from("aether-models"))
}

pub(crate) fn dedupe_model_paths(models: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for path in models {
        let path = canonical_model_path(&path);
        let key = path.display().to_string();
        if seen.insert(key) {
            deduped.push(path);
        }
    }
    deduped.sort_by_key(|path| model_label(path).to_lowercase());
    deduped
}

pub(crate) fn env_model_path(var: &str) -> Cmd<Option<PathBuf>> {
    let Ok(value) = env::var(var) else {
        return Ok(None);
    };
    let path = PathBuf::from(value.trim());
    let valid = match var {
        AETHER_CHAT_MODEL_ENV => is_chat_model(&path),
        AETHER_EMBEDDING_MODEL_ENV => is_embedding_model(&path),
        _ => is_gguf_model(&path),
    };
    if valid {
        Ok(Some(path))
    } else {
        Err(format!(
            "{var} does not point to an existing local model: {}",
            path.display()
        ))
    }
}

pub(crate) fn pick_embedding_model(
    models: &[PathBuf],
    settings: &LocalModelSettings,
) -> Option<PathBuf> {
    if let Ok(Some(path)) = env_model_path(AETHER_EMBEDDING_MODEL_ENV) {
        return Some(canonical_model_path(&path));
    }
    if let Some(model) = settings
        .embedding_model
        .as_deref()
        .and_then(|value| pick_selected_model(models, value, true))
    {
        return Some(model);
    }
    models
        .iter()
        .filter(|path| is_embedding_model(path))
        .max_by_key(|path| embedding_model_score(path))
        .cloned()
}

pub(crate) fn pick_chat_model(
    models: &[PathBuf],
    settings: &LocalModelSettings,
) -> Option<PathBuf> {
    if let Ok(Some(path)) = env_model_path(AETHER_CHAT_MODEL_ENV) {
        return Some(canonical_model_path(&path));
    }
    if let Some(model) = settings
        .chat_model
        .as_deref()
        .and_then(|value| pick_selected_model(models, value, false))
    {
        return Some(model);
    }
    pick_model_by_hints(models, &PREFERRED_CHAT_MODEL_HINTS, false).or_else(|| {
        models
            .iter()
            .find(|path| !is_embedding_model_name(path))
            .cloned()
    })
}

pub(crate) fn pick_selected_model(
    models: &[PathBuf],
    value: &str,
    embedding: bool,
) -> Option<PathBuf> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let direct = PathBuf::from(value);
    if selected_model_matches_kind(&direct, embedding) {
        return Some(canonical_model_path(&direct));
    }
    let normalized = value.to_lowercase();
    models
        .iter()
        .find(|path| {
            let label = model_label(path);
            path_to_model_value(path) == value
                || label == value
                || strip_gguf_extension(&label) == value
                || label.to_lowercase().contains(&normalized)
        })
        .filter(|path| selected_model_matches_kind(path, embedding))
        .cloned()
}

pub(crate) fn pick_model_by_hints(
    models: &[PathBuf],
    hints: &[&str],
    embedding: bool,
) -> Option<PathBuf> {
    for hint in hints {
        let hint = hint.to_lowercase();
        if let Some(model) = models.iter().find(|path| {
            let label = model_label(path).to_lowercase();
            label.contains(&hint)
                && if embedding {
                    is_embedding_model(path)
                } else {
                    is_chat_model(path)
                }
        }) {
            return Some(model.clone());
        }
    }
    None
}

pub(crate) fn embedding_model_score(path: &Path) -> i32 {
    let label = model_label(path).to_lowercase();
    let mut score = 0;
    if is_gguf_model(path) {
        score += 1_000;
    }
    if label.contains("qwen3-embedding") {
        score += 650;
    }
    if label.contains("bf16") {
        score += 400;
    } else if label.contains("f16") {
        score += 300;
    } else if label.contains("q8") {
        score += 150;
    }
    score
}

pub(crate) fn embedding_pooling_type(path: &Path) -> LlamaPoolingType {
    if is_qwen3_embedding_model(path) {
        LlamaPoolingType::Last
    } else {
        LlamaPoolingType::Mean
    }
}

pub(crate) fn embedding_attention_type(path: &Path) -> LlamaAttentionType {
    if is_qwen3_embedding_model(path) {
        LlamaAttentionType::Causal
    } else {
        LlamaAttentionType::Unspecified
    }
}

pub(crate) fn is_qwen3_embedding_model(path: &Path) -> bool {
    let label = model_label(path).to_lowercase();
    label.contains("qwen3-embedding")
}

pub(crate) fn qwen3_embedding_decode(path: &Path) -> bool {
    is_qwen3_embedding_model(path)
}

pub(crate) fn is_gguf_model(path: &Path) -> bool {
    path.is_file()
        && !is_mmproj_model(path)
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("gguf"))
}

pub(crate) fn is_chat_model(path: &Path) -> bool {
    is_gguf_model(path) && !is_embedding_model_name(path)
}

pub(crate) fn selected_model_matches_kind(path: &Path, embedding: bool) -> bool {
    if embedding {
        is_embedding_model(path)
    } else {
        is_chat_model(path)
    }
}

pub(crate) fn is_embedding_model(path: &Path) -> bool {
    is_gguf_model(path) && is_embedding_model_name(path)
}

pub(crate) fn is_embedding_model_name(path: &Path) -> bool {
    let label = model_label(path).to_lowercase();
    label.contains("embed") || label.contains("embedding")
}

pub(crate) fn is_mmproj_model(path: &Path) -> bool {
    model_label(path).to_lowercase().contains("mmproj")
}

pub(crate) fn canonical_model_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub(crate) fn path_to_model_value(path: &Path) -> String {
    path.display().to_string()
}

pub(crate) fn model_label(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(strip_gguf_extension)
        .unwrap_or_else(|| path.display().to_string())
}

/// Product name for user-facing status text. Filenames must stay in sync with
/// `managed_model_spec`; anything unmanaged falls back to its cleaned filename.
pub(crate) fn friendly_model_label(path: &Path) -> String {
    match path.file_name().and_then(|name| name.to_str()) {
        Some("gemma-4-E2B_q4_0-it.gguf") => "AiON LiTE".to_string(),
        Some("gemma-4-E4B_q4_0-it.gguf") => "AiON WiSE".to_string(),
        Some("Qwen3-Embedding-0.6B-Q8_0.gguf") => "AiON MiST".to_string(),
        _ => model_label(path),
    }
}

pub(crate) fn strip_gguf_extension(value: &str) -> String {
    value
        .strip_suffix(".gguf")
        .or_else(|| value.strip_suffix(".GGUF"))
        .unwrap_or(value)
        .to_string()
}

pub(crate) fn chat_context_tokens() -> u32 {
    // Phones get half the desktop window: the KV cache plus compute buffers
    // for 6k context put a multi-GB model into zram-thrashing territory,
    // which reads as a silent hang during prefill.
    let default = if cfg!(mobile) {
        3072
    } else {
        DEFAULT_CHAT_CONTEXT_TOKENS
    };
    env::var(AETHER_LLM_CONTEXT_ENV)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(default)
        .clamp(1024, 65_536)
}

pub(crate) fn chat_batch_token_limit() -> usize {
    env::var(AETHER_LLM_BATCH_TOKENS_ENV)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_CHAT_BATCH_TOKENS)
        .clamp(512, 8192)
}

pub(crate) fn local_gpu_enabled() -> bool {
    env_flag_enabled(AETHER_LLM_GPU_ENV, cfg!(target_os = "macos"))
}

pub(crate) fn embedding_gpu_enabled() -> bool {
    env_flag_enabled(AETHER_EMBED_GPU_ENV, false)
}

pub(crate) fn env_flag_enabled(name: &str, default: bool) -> bool {
    env::var(name).ok().map_or(default, |value| {
        matches!(value.to_lowercase().as_str(), "1" | "true" | "yes" | "on")
    })
}

pub(crate) fn embedding_batch_size() -> usize {
    env::var(AETHER_EMBED_BATCH_ENV)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_EMBEDDING_BATCH_SIZE)
        .clamp(1, 24)
}

pub(crate) fn embedding_batch_token_limit() -> usize {
    env::var(AETHER_EMBED_BATCH_TOKENS_ENV)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_EMBEDDING_BATCH_TOKENS)
        .clamp(512, 8192)
}

pub(crate) fn embedding_context_tokens(input_tokens: usize) -> u32 {
    let needed = input_tokens.saturating_add(16).min(u32::MAX as usize) as u32;
    DEFAULT_EMBEDDING_CONTEXT_TOKENS.max(needed).min(8192)
}

pub(crate) fn auto_thread_count() -> i32 {
    // Mobile keeps one core free instead of two: recent flagships (like the
    // all-big-core Snapdragon 8 Elite) have no little cores to avoid, prefill
    // is compute-bound, and the UI sits idle while AiON works.
    let reserve = if cfg!(mobile) { 1 } else { 2 };
    std::thread::available_parallelism()
        .map(|threads| threads.get().saturating_sub(reserve).clamp(2, 12) as i32)
        .unwrap_or(6)
}

pub(crate) fn normalize_embedding(values: &[f32]) -> Vec<f32> {
    let norm = values
        .iter()
        .map(|value| (*value as f64) * (*value as f64))
        .sum::<f64>()
        .sqrt();
    if norm <= f64::EPSILON {
        return values.to_vec();
    }
    values
        .iter()
        .map(|value| (*value as f64 / norm) as f32)
        .collect()
}

// Phones prefill on CPU, so prompt length is the ask latency. The mobile
// budget (5 sources x ~1100 chars + system + question) fits the 2048-token
// prompt window, where desktop's 8 full chunks would overflow it and get
// front-truncated — losing the system message and top-ranked sources while
// still paying full prefill cost.
