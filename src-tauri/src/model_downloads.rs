//! Fetching managed GGUF models from Hugging Face, with resumable progress.

use super::*;

/// One progress tick for a managed model download. A struct rather than six
/// positional arguments: at the call sites the bare numbers read as
/// `0, Some(spec.expected_bytes), overall_downloaded, overall_total`, which is
/// impossible to check by eye.
pub(crate) struct ModelDownloadStage<'a> {
    pub(crate) status: &'a str,
    pub(crate) downloaded_bytes: u64,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) overall_downloaded_bytes: u64,
    pub(crate) overall_total_bytes: Option<u64>,
    pub(crate) message: Option<String>,
}

pub(crate) async fn download_managed_models(
    app: &AppHandle,
    state: &State<'_, Backend>,
    input: DownloadModelsInput,
) -> Cmd<()> {
    let specs = selected_model_downloads(&state.paths, &input)?;
    let hf_token = input
        .hf_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(huggingface_token);
    let overall_total = specs
        .iter()
        .map(|spec| spec.expected_bytes)
        .reduce(|first, second| first.saturating_add(second));
    let mut overall_downloaded = 0u64;

    for spec in &specs {
        if let Some(existing_bytes) =
            completed_model_bytes(&spec.destination, spec.expected_bytes).await
        {
            overall_downloaded = overall_downloaded.saturating_add(existing_bytes);
            emit_model_download_progress(
                app,
                spec,
                ModelDownloadStage {
                    status: "skipped",
                    downloaded_bytes: existing_bytes,
                    total_bytes: Some(spec.expected_bytes),
                    overall_downloaded_bytes: overall_downloaded,
                    overall_total_bytes: overall_total,
                    message: Some("Already installed".to_string()),
                },
            );
            continue;
        }

        emit_model_download_progress(
            app,
            spec,
            ModelDownloadStage {
                status: "queued",
                downloaded_bytes: 0,
                total_bytes: Some(spec.expected_bytes),
                overall_downloaded_bytes: overall_downloaded,
                overall_total_bytes: overall_total,
                message: Some("Preparing download".to_string()),
            },
        );

        match download_model_file(
            app,
            &state.http_client(),
            spec,
            overall_downloaded,
            overall_total,
            hf_token.as_deref(),
        )
        .await
        {
            Ok(downloaded_bytes) => {
                overall_downloaded = overall_downloaded.saturating_add(downloaded_bytes);
                emit_model_download_progress(
                    app,
                    spec,
                    ModelDownloadStage {
                        status: "complete",
                        downloaded_bytes,
                        total_bytes: Some(downloaded_bytes),
                        overall_downloaded_bytes: overall_downloaded,
                        overall_total_bytes: overall_total,
                        message: Some("Installed".to_string()),
                    },
                );
            }
            Err(error) => {
                emit_model_download_progress(
                    app,
                    spec,
                    ModelDownloadStage {
                        status: "error",
                        downloaded_bytes: 0,
                        total_bytes: Some(spec.expected_bytes),
                        overall_downloaded_bytes: overall_downloaded,
                        overall_total_bytes: overall_total,
                        message: Some(error.clone()),
                    },
                );
                return Err(error);
            }
        }
    }

    persist_downloaded_model_selection(&state.paths, &specs).await
}

pub(crate) fn selected_model_downloads(
    paths: &DataPaths,
    input: &DownloadModelsInput,
) -> Cmd<Vec<ModelDownloadSpec>> {
    let mut specs = vec![managed_model_spec(paths, "mist")?];
    let mut selected = HashSet::new();

    for model in &input.chat_models {
        let normalized = model.trim().to_lowercase();
        if normalized.is_empty() {
            continue;
        }
        if !selected.insert(normalized.clone()) {
            continue;
        }
        specs.push(managed_model_spec(paths, &normalized)?);
    }

    Ok(specs)
}

pub(crate) fn managed_model_spec(paths: &DataPaths, id: &str) -> Cmd<ModelDownloadSpec> {
    match id {
        "mist" => Ok(ModelDownloadSpec {
            id: "mist",
            label: "AiON MiST",
            repository: "Qwen/Qwen3-Embedding-0.6B-GGUF",
            revision: "370f27d7550e0def9b39c1f16d3fbaa13aa67728",
            filename: "Qwen3-Embedding-0.6B-Q8_0.gguf",
            destination: paths
                .models_path
                .join("embeddings")
                .join("Qwen3-Embedding-0.6B-GGUF")
                .join("Qwen3-Embedding-0.6B-Q8_0.gguf"),
            expected_bytes: 639_150_592,
        }),
        "lite" => Ok(ModelDownloadSpec {
            id: "lite",
            label: "AiON LiTE",
            repository: "google/gemma-4-E2B-it-qat-q4_0-gguf",
            revision: "1894d1fc0a19d86697abd40483f5983c867df03f",
            filename: "gemma-4-E2B_q4_0-it.gguf",
            destination: paths
                .models_path
                .join("chat")
                .join("gemma-4-E2B-it-qat-q4_0-gguf")
                .join("gemma-4-E2B_q4_0-it.gguf"),
            expected_bytes: 3_349_514_112,
        }),
        "wise" => Ok(ModelDownloadSpec {
            id: "wise",
            label: "AiON WiSE",
            repository: "google/gemma-4-E4B-it-qat-q4_0-gguf",
            revision: "bb3b92e6f031fa438b409f898dd9f14f499a0cb0",
            filename: "gemma-4-E4B_q4_0-it.gguf",
            destination: paths
                .models_path
                .join("chat")
                .join("gemma-4-E4B-it-qat-q4_0-gguf")
                .join("gemma-4-E4B_q4_0-it.gguf"),
            expected_bytes: 5_154_939_136,
        }),
        _ => Err(format!("Unknown AiON model selection: {id}")),
    }
}

pub(crate) async fn completed_model_bytes(path: &Path, expected_bytes: u64) -> Option<u64> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    let len = metadata.len();
    if metadata.is_file() && len == expected_bytes {
        Some(len)
    } else {
        None
    }
}

pub(crate) async fn download_model_file(
    app: &AppHandle,
    client: &Client,
    spec: &ModelDownloadSpec,
    overall_base_bytes: u64,
    overall_total_bytes: Option<u64>,
    hf_token: Option<&str>,
) -> Cmd<u64> {
    let parent = spec
        .destination
        .parent()
        .ok_or_else(|| format!("Invalid model destination: {}", spec.destination.display()))?;
    tokio::fs::create_dir_all(parent).await.map_err(|error| {
        format!(
            "Could not create model directory {}: {error}",
            parent.display()
        )
    })?;

    let temp_path = spec
        .destination
        .with_file_name(format!("{}.part", spec.filename));
    let _ = tokio::fs::remove_file(&temp_path).await;

    let mut request = client.get(spec.source_url());
    if let Some(token) = hf_token {
        request = request.bearer_auth(token);
    }

    let mut response = request
        .send()
        .await
        .map_err(|error| format!("Could not reach Hugging Face for {}: {error}", spec.label))?;
    let status = response.status();
    if !status.is_success() {
        return Err(huggingface_download_error(spec, status.as_u16()));
    }

    let total_bytes = response.content_length().or(Some(spec.expected_bytes));
    let mut file = tokio::fs::File::create(&temp_path).await.map_err(|error| {
        format!(
            "Could not create temporary model file {}: {error}",
            temp_path.display()
        )
    })?;
    let mut downloaded_bytes = 0u64;
    let mut last_emit = Instant::now();

    emit_model_download_progress(
        app,
        spec,
        ModelDownloadStage {
            status: "downloading",
            downloaded_bytes,
            total_bytes,
            overall_downloaded_bytes: overall_base_bytes,
            overall_total_bytes,
            message: Some("Downloading from Hugging Face".to_string()),
        },
    );

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Download interrupted for {}: {error}", spec.label))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Could not write {}: {error}", spec.filename))?;
        downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);

        if last_emit.elapsed() >= Duration::from_millis(160) {
            emit_model_download_progress(
                app,
                spec,
                ModelDownloadStage {
                    status: "downloading",
                    downloaded_bytes,
                    total_bytes,
                    overall_downloaded_bytes: overall_base_bytes.saturating_add(downloaded_bytes),
                    overall_total_bytes,
                    message: None,
                },
            );
            last_emit = Instant::now();
        }
    }

    file.flush()
        .await
        .map_err(|error| format!("Could not finalize {}: {error}", spec.filename))?;
    drop(file);

    if let Some(total) = total_bytes {
        if downloaded_bytes != total {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(format!(
                "Downloaded {} bytes for {}, expected {}.",
                downloaded_bytes, spec.label, total
            ));
        }
    }

    let _ = tokio::fs::remove_file(&spec.destination).await;
    tokio::fs::rename(&temp_path, &spec.destination)
        .await
        .map_err(|error| {
            format!(
                "Could not move {} into {}: {error}",
                temp_path.display(),
                spec.destination.display()
            )
        })?;

    Ok(downloaded_bytes)
}

pub(crate) async fn persist_downloaded_model_selection(
    paths: &DataPaths,
    specs: &[ModelDownloadSpec],
) -> Cmd<()> {
    let mut settings = load_settings(&paths.settings_path).await?;
    if let Some(embedding) = specs.iter().find(|spec| spec.id == "mist") {
        settings.local_model.embedding_model = Some(embedding.destination.display().to_string());
    }
    if let Some(chat) = specs
        .iter()
        .rev()
        .find(|spec| spec.id == "lite" || spec.id == "wise")
    {
        settings.local_model.chat_model = Some(chat.destination.display().to_string());
    }
    save_json(&paths.settings_path, &settings).await
}

pub(crate) fn huggingface_token() -> Option<String> {
    [
        HF_TOKEN_ENV,
        HUGGINGFACE_HUB_TOKEN_ENV,
        HUGGING_FACE_HUB_TOKEN_ENV,
    ]
    .iter()
    .find_map(|var| env::var(var).ok())
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
}

pub(crate) fn huggingface_download_error(spec: &ModelDownloadSpec, status: u16) -> String {
    let auth_hint = if status == 401 || status == 403 {
        format!(
            " Accept the model terms on Hugging Face, then paste a Hugging Face read token in setup. Advanced users can also launch ÆTHER with {HF_TOKEN_ENV} or {HUGGINGFACE_HUB_TOKEN_ENV} set."
        )
    } else {
        String::new()
    };
    format!(
        "Could not download {} from official Hugging Face source {}/{} ({status}).{}",
        spec.label, spec.repository, spec.filename, auth_hint
    )
}

pub(crate) fn emit_model_download_progress(
    app: &AppHandle,
    spec: &ModelDownloadSpec,
    stage: ModelDownloadStage<'_>,
) {
    let ModelDownloadStage {
        status,
        downloaded_bytes,
        total_bytes,
        overall_downloaded_bytes,
        overall_total_bytes,
        message,
    } = stage;
    let _ = app.emit(
        AETHER_MODEL_DOWNLOAD_PROGRESS_EVENT,
        ModelDownloadProgress {
            id: spec.id.to_string(),
            label: spec.label.to_string(),
            filename: spec.filename.to_string(),
            status: status.to_string(),
            downloaded_bytes,
            total_bytes,
            overall_downloaded_bytes,
            overall_total_bytes,
            message,
        },
    );
}
