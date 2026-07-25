//! The llama.cpp calls themselves: embeddings, chat completion, and iCE generation,
//! plus the extractive fallback used when only the embedding model is installed.

use super::*;

// The chat path streams tokens and status lines back to the renderer through boxed
// callbacks. Named here so the generate/complete signatures stay readable.
pub(crate) type TokenSink = Box<dyn FnMut(&str) + Send>;
pub(crate) type StatusSink = Box<dyn FnMut(String) + Send>;

/// Where a generation reports back to. Both sinks come from the same
/// ChatStreamEmitter and are always supplied together, so they travel together.
#[derive(Default)]
pub(crate) struct ChatSinks {
    pub(crate) token: Option<TokenSink>,
    pub(crate) status: Option<StatusSink>,
}

pub(crate) async fn local_embed(
    state: &State<'_, Backend>,
    settings: &UserSettings,
    inputs: Vec<String>,
) -> Cmd<Vec<Vec<f32>>> {
    local_embed_with_progress(state, settings, inputs, None).await
}

pub(crate) async fn local_embed_query(
    state: &State<'_, Backend>,
    settings: &UserSettings,
    query: String,
) -> Cmd<Vec<f32>> {
    local_embed(
        state,
        settings,
        vec![embedding_query_input(&state.paths, settings, &query)],
    )
    .await?
    .into_iter()
    .next()
    .ok_or_else(|| "Local embedding model returned no embedding.".to_string())
}

pub(crate) fn embedding_query_input(
    paths: &DataPaths,
    settings: &UserSettings,
    query: &str,
) -> String {
    let catalog = model_catalog(paths, &settings.local_model);
    let Some(model_path) = catalog.embedding_model.as_deref() else {
        return query.to_string();
    };
    let label = model_label(model_path).to_lowercase();

    if label.contains("qwen3-embedding") {
        return format!("Instruct: {QWEN3_EMBEDDING_RETRIEVAL_INSTRUCTION}\nQuery: {query}");
    }

    query.to_string()
}

pub(crate) async fn local_embed_with_progress(
    state: &State<'_, Backend>,
    settings: &UserSettings,
    inputs: Vec<String>,
    progress: Option<EmbeddingProgress>,
) -> Cmd<Vec<Vec<f32>>> {
    let catalog = model_catalog(&state.paths, &settings.local_model);
    let model_path = catalog.embedding_model.ok_or_else(|| {
        format!(
            "No local embedding model found. Install AiON MiST/Qwen3 Embedding, add another embedding GGUF to {}, or set {AETHER_EMBEDDING_MODEL_ENV}.",
            state.paths.models_path.display()
        )
    })?;
    let runtime = Arc::clone(&state.native_runtime);
    task::spawn_blocking(move || {
        let mut runtime = runtime
            .lock()
            .map_err(|_| "Local model runtime is unavailable.".to_string())?;
        match progress {
            Some(progress) => runtime.embed_with_progress(&model_path, inputs, Some(progress)),
            None => runtime.embed(&model_path, inputs),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) async fn local_chat(
    state: &State<'_, Backend>,
    settings: &UserSettings,
    prompt: &str,
    citations: Vec<SearchResult>,
    // Prior turns for follow-up questions. Empty for one-shot callers such as AiR.
    history: &[ConversationTurn],
    stream: Option<ChatStreamEmitter>,
) -> Cmd<ChatResult> {
    let started_at = Instant::now();
    let catalog = model_catalog(&state.paths, &settings.local_model);
    // With only the embedding model installed there is nothing to generate with, but
    // retrieval still works. Returning the ranked passages is far more useful than an
    // error, and it is what makes MiST-only a usable install rather than a dead end.
    let Some(model_path) = catalog.chat_model else {
        if citations.is_empty() {
            return Err(format!(
                "No local chat model is installed, and no captured passages matched. Capture a page or install a chat model in {}.",
                state.paths.models_path.display()
            ));
        }
        if let Some(stream) = &stream {
            stream.citations(&citations);
        }
        return Ok(extractive_answer(
            citations,
            started_at.elapsed().as_secs_f64(),
        ));
    };
    if let Some(stream) = &stream {
        stream.citations(&citations);
    }
    let messages = build_chat_messages(prompt, &citations, history);
    let runtime = Arc::clone(&state.native_runtime);
    let cancel = Arc::clone(&state.generation_cancelled);
    let model_label = model_label(&model_path);
    let completion = task::spawn_blocking(move || {
        let mut runtime = runtime
            .lock()
            .map_err(|_| "Local model runtime is unavailable.".to_string())?;
        let token_stream = stream.clone();
        let token: Option<TokenSink> = token_stream
            .map(|stream| Box::new(move |delta: &str| stream.delta(delta)) as TokenSink);
        let status: Option<StatusSink> = stream
            .map(|stream| Box::new(move |status: String| stream.status(&status)) as StatusSink);
        runtime.complete_chat(
            &model_path,
            messages,
            DEFAULT_GENERATION_TOKENS,
            0.2,
            &cancel,
            ChatSinks { token, status },
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    let elapsed_seconds = started_at.elapsed().as_secs_f64();
    let answer = normalize_answer_citations(&clean_model_output(&completion.text), citations.len());
    let tokens_per_second = if completion.generated_tokens > 0 && elapsed_seconds > 0.0 {
        completion.generated_tokens as f64 / elapsed_seconds
    } else {
        0.0
    };
    let chunks = citations.len();
    Ok(ChatResult {
        answer,
        model: model_label,
        citations,
        metrics: ChatMetrics {
            generated_tokens: completion.generated_tokens,
            tokens_per_second,
            elapsed_seconds,
            chunks,
        },
    })
}

// The retrieval-only answer. Deliberately presented as quoted passages with their
// sources rather than as prose: nothing here was generated, and dressing excerpts up
// as an answer would imply reasoning that did not happen.
pub(crate) const EXTRACTIVE_MODEL_LABEL: &str = "AiON MiST (passages only)";

pub(crate) fn extractive_answer(citations: Vec<SearchResult>, elapsed_seconds: f64) -> ChatResult {
    let mut answer = String::from(
        "No chat model is installed, so ÆTHER cannot write an answer. These are the passages from your library that best match the question:\n\n",
    );
    for (index, citation) in citations.iter().enumerate() {
        answer.push_str(&format!(
            "**{}. {}** [{}]\n\n> {}\n\n",
            index + 1,
            citation.title.trim(),
            index + 1,
            semantic_trail_excerpt(citation.text.trim(), 480).replace('\n', " ")
        ));
    }
    answer.push_str(
        "_Install a chat model in Settings to get written answers grounded in these sources._",
    );

    let chunks = citations.len();
    ChatResult {
        answer,
        model: EXTRACTIVE_MODEL_LABEL.to_string(),
        citations,
        metrics: ChatMetrics {
            // Nothing was generated, so the token metrics are honestly zero.
            generated_tokens: 0,
            tokens_per_second: 0.0,
            elapsed_seconds,
            chunks,
        },
    }
}

pub(crate) async fn local_generate_iceberg(
    state: &State<'_, Backend>,
    settings: &UserSettings,
    topic: &str,
) -> Cmd<IcebergResult> {
    let catalog = model_catalog(&state.paths, &settings.local_model);
    let model_path = catalog.chat_model.ok_or_else(|| {
        format!(
            "No local generative GGUF model found. Add Gemma or another chat model to {} or set {AETHER_CHAT_MODEL_ENV}.",
            state.paths.models_path.display()
        )
    })?;
    let prompt = build_iceberg_prompt(topic);
    let generated =
        complete_iceberg_attempt(state, model_path.clone(), prompt.clone(), 0.35).await?;
    let items = match normalize_iceberg_items(&generated) {
        Ok(items) => items,
        Err(first_error) => {
            let retry_prompt = format!(
                "{prompt}\n\nThe previous response was malformed. Return exactly 18 compact items \
                 and close every JSON object and array. Keep each description and reason to one \
                 short sentence. Output JSON only."
            );
            let retry =
                complete_iceberg_attempt(state, model_path.clone(), retry_prompt, 0.2).await?;
            normalize_iceberg_items(&retry).map_err(|retry_error| {
                format!(
                    "Crystallization returned malformed data twice. First attempt: {first_error} \
                     Retry: {retry_error}"
                )
            })?
        }
    };
    Ok(IcebergResult {
        keyword: topic.to_string(),
        model: model_label(&model_path),
        items,
        generated_at: now(),
    })
}

async fn complete_iceberg_attempt(
    state: &State<'_, Backend>,
    model_path: PathBuf,
    prompt: String,
    temperature: f32,
) -> Cmd<String> {
    let messages = vec![ChatPromptMessage {
        role: "user",
        content: prompt,
    }];
    let runtime = Arc::clone(&state.native_runtime);
    let cancel = Arc::clone(&state.generation_cancelled);
    let completion = task::spawn_blocking(move || {
        let mut runtime = runtime
            .lock()
            .map_err(|_| "Local model runtime is unavailable.".to_string())?;
        runtime.complete_chat(
            &model_path,
            messages,
            DEFAULT_ICEBERG_GENERATION_TOKENS,
            temperature,
            &cancel,
            ChatSinks::default(),
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    let generated = completion.text;
    if state.generation_cancelled.load(AtomicOrdering::Relaxed) {
        return Err("Crystallization stopped.".to_string());
    }
    Ok(clean_model_output(&generated))
}

impl NativeModelRuntime {
    pub(crate) fn ensure_backend(&mut self) -> Cmd<()> {
        if self.backend.is_some() {
            return Ok(());
        }

        let mut backend = LlamaBackend::init().map_err(|error| error.to_string())?;
        backend.void_logs();
        self.backend = Some(backend);
        Ok(())
    }

    pub(crate) fn ensure_model(&mut self, kind: NativeModelKind, path: &Path) -> Cmd<()> {
        let path = canonical_model_path(path);
        let current_path = match kind {
            NativeModelKind::Chat => self.chat.as_ref().map(|loaded| loaded.path.as_path()),
            NativeModelKind::Embedding => {
                self.embedding.as_ref().map(|loaded| loaded.path.as_path())
            }
        };
        if current_path == Some(path.as_path()) {
            return Ok(());
        }

        self.ensure_backend()?;
        let backend = self
            .backend
            .as_ref()
            .ok_or_else(|| "Local model backend is not initialized.".to_string())?;
        // Mobile: load weights into anonymous memory instead of mmapping the
        // GGUF. Mmapped weight pages are ordinary page cache, and Android
        // evicts them under the memory pressure the native tab WebViews
        // create — after which every generated token faults back to flash and
        // decode slows to a crawl. Malloc'd weights are app RSS and stay put.
        let use_mmap = if cfg!(mobile) {
            false
        } else {
            backend.supports_mmap()
        };
        let mut params = LlamaModelParams::default().with_use_mmap(use_mmap);
        let use_gpu = match kind {
            NativeModelKind::Chat => local_gpu_enabled(),
            NativeModelKind::Embedding => embedding_gpu_enabled(),
        };
        if use_gpu && backend.supports_gpu_offload() {
            params = params.with_n_gpu_layers(999);
        } else {
            params = params
                .with_n_gpu_layers(0)
                .with_devices(&[])
                .map_err(|error| format!("Failed to select CPU model backend: {error}"))?;
        }
        let model = LlamaModel::load_from_file(backend, &path, &params).map_err(|error| {
            format!("Failed to load local model {}: {error}", model_label(&path))
        })?;
        let loaded = LoadedNativeModel { path, model };
        match kind {
            NativeModelKind::Chat => self.chat = Some(loaded),
            NativeModelKind::Embedding => self.embedding = Some(loaded),
        }
        Ok(())
    }

    pub(crate) fn embed(&mut self, model_path: &Path, inputs: Vec<String>) -> Cmd<Vec<Vec<f32>>> {
        self.embed_with_progress(model_path, inputs, None)
    }

    pub(crate) fn embed_with_progress(
        &mut self,
        model_path: &Path,
        inputs: Vec<String>,
        progress: Option<EmbeddingProgress>,
    ) -> Cmd<Vec<Vec<f32>>> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }

        self.ensure_model(NativeModelKind::Embedding, model_path)?;
        let backend = self
            .backend
            .as_ref()
            .ok_or_else(|| "Local model backend is not initialized.".to_string())?;
        let model = &self
            .embedding
            .as_ref()
            .ok_or_else(|| "Local embedding model is not loaded.".to_string())?
            .model;
        let threads = auto_thread_count();
        let total = inputs.len();
        let mut embeddings = Vec::with_capacity(total);
        let mut tokenized_inputs = Vec::with_capacity(total);

        if let Some(progress) = &progress {
            progress.emit_message("Tokenizing chunks", 0, total);
        }

        for input in inputs {
            let tokens = model
                .str_to_token(&input, AddBos::Always)
                .map_err(|error| error.to_string())?;
            if tokens.is_empty() {
                return Err("Local embedding input produced no tokens.".to_string());
            }
            tokenized_inputs.push(tokens);
        }

        let max_sequences = if is_qwen3_embedding_model(model_path) {
            1
        } else {
            embedding_batch_size().min(16)
        };
        let max_batch_tokens = embedding_batch_token_limit();
        let mut input_index = 0;
        let mut batches = Vec::new();

        while input_index < tokenized_inputs.len() {
            let mut batch_token_count = 0usize;
            let mut batch_end = input_index;

            while batch_end < tokenized_inputs.len()
                && batch_end - input_index < max_sequences
                && (batch_token_count == 0
                    || batch_token_count + tokenized_inputs[batch_end].len() <= max_batch_tokens)
            {
                batch_token_count += tokenized_inputs[batch_end].len();
                batch_end += 1;
            }

            batches.push((input_index, batch_end, batch_token_count));
            input_index = batch_end;
        }

        let max_batch_token_count = batches
            .iter()
            .map(|(_, _, batch_token_count)| *batch_token_count)
            .max()
            .unwrap_or_default();
        let max_batch_sequence_count = batches
            .iter()
            .map(|(batch_start, batch_end, _)| batch_end - batch_start)
            .max()
            .unwrap_or(1);
        let n_ctx = embedding_context_tokens(max_batch_token_count);
        if max_batch_token_count as u32 > n_ctx {
            return Err(format!(
                "Local embedding batch is too long for the embedding context: {} tokens exceeds {}.",
                max_batch_token_count, n_ctx
            ));
        }
        let n_batch = n_ctx.max(max_batch_token_count as u32).max(512);
        let offload_embedding_ops = embedding_gpu_enabled();
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(n_ctx))
            .with_n_seq_max(max_batch_sequence_count as u32)
            .with_n_batch(n_batch)
            .with_n_ubatch(n_batch)
            .with_n_threads(threads)
            .with_n_threads_batch(threads)
            .with_embeddings(true)
            .with_offload_kqv(offload_embedding_ops)
            .with_op_offload(offload_embedding_ops)
            .with_attention_type(embedding_attention_type(model_path))
            .with_pooling_type(embedding_pooling_type(model_path));
        let mut ctx = model
            .new_context(backend, ctx_params)
            .map_err(|error| error.to_string())?;

        for (batch_start, batch_end, batch_token_count) in batches {
            let batch_sequence_count = batch_end - batch_start;
            if let Some(progress) = &progress {
                progress.emit_message(
                    format!(
                        "Embedding chunks {}-{batch_end} of {total}",
                        batch_start + 1
                    ),
                    batch_start,
                    total,
                );
            }

            ctx.clear_kv_cache();
            let mut batch = LlamaBatch::new(batch_token_count, batch_sequence_count as i32);
            for (sequence_index, tokens) in
                tokenized_inputs[batch_start..batch_end].iter().enumerate()
            {
                batch
                    .add_sequence(tokens, sequence_index as i32, false)
                    .map_err(|error| error.to_string())?;
            }
            // Qwen3 Embedding is decoder-style; the llama_encode path segfaults in
            // llm_build_qwen3 on macOS with llama-cpp-2 0.1.146.
            if qwen3_embedding_decode(model_path) {
                ctx.decode(&mut batch).map_err(|error| error.to_string())?;
            } else {
                ctx.encode(&mut batch).map_err(|error| error.to_string())?;
            }

            for sequence_index in 0..batch_sequence_count {
                let embedding = ctx
                    .embeddings_seq_ith(sequence_index as i32)
                    .map_err(|error| error.to_string())?;
                embeddings.push(normalize_embedding(embedding));
            }
            if let Some(progress) = &progress {
                progress.emit(batch_end, total);
            }
        }

        Ok(embeddings)
    }

    #[cfg(desktop)]
    pub(crate) fn warm_embedding_model(&mut self, model_path: &Path) -> Cmd<()> {
        self.ensure_model(NativeModelKind::Embedding, model_path)
    }

    pub(crate) fn complete_chat(
        &mut self,
        model_path: &Path,
        messages: Vec<ChatPromptMessage>,
        max_tokens: usize,
        temperature: f32,
        cancel: &AtomicBool,
        mut sinks: ChatSinks,
    ) -> Cmd<ChatCompletion> {
        // The first ask pays for the multi-GB model load; on phone-class
        // storage that is long enough to read as a hang without a status.
        let needs_load = self
            .chat
            .as_ref()
            .map(|loaded| loaded.path != canonical_model_path(model_path))
            .unwrap_or(true);
        if needs_load {
            if let Some(callback) = sinks.status.as_mut() {
                callback(format!(
                    "Loading {} (first ask takes a moment)",
                    friendly_model_label(model_path)
                ));
            }
        }
        self.ensure_model(NativeModelKind::Chat, model_path)?;
        let rendered = {
            let model = &self
                .chat
                .as_ref()
                .ok_or_else(|| "Local chat model is not loaded.".to_string())?
                .model;
            render_model_chat_prompt(model, &messages)?
        };
        self.complete_loaded_prompt(
            &rendered.prompt,
            max_tokens,
            temperature,
            rendered.add_bos,
            cancel,
            sinks,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn complete_loaded_prompt(
        &mut self,
        prompt: &str,
        max_tokens: usize,
        temperature: f32,
        add_bos: AddBos,
        cancel: &AtomicBool,
        mut sinks: ChatSinks,
    ) -> Cmd<ChatCompletion> {
        let backend = self
            .backend
            .as_ref()
            .ok_or_else(|| "Local model backend is not initialized.".to_string())?;
        let model = &self
            .chat
            .as_ref()
            .ok_or_else(|| "Local chat model is not loaded.".to_string())?
            .model;
        let mut tokens = model
            .str_to_token(prompt, add_bos)
            .map_err(|error| error.to_string())?;
        if tokens.is_empty() {
            return Err("Local chat prompt produced no tokens.".to_string());
        }

        let n_ctx = chat_context_tokens();
        let max_prompt_tokens =
            n_ctx.saturating_sub((max_tokens as u32).min(1024)).max(512) as usize;
        if tokens.len() > max_prompt_tokens {
            tokens = tokens[tokens.len() - max_prompt_tokens..].to_vec();
        }
        let n_batch = (chat_batch_token_limit() as u32).min(n_ctx).max(512);
        // Mobile: small micro-batches keep the compute buffer allocation
        // phone-sized and make prefill progress tick in visible steps.
        let n_ubatch = if cfg!(mobile) {
            n_batch.min(512)
        } else {
            n_batch.min(2048)
        }
        .max(512);
        let threads = auto_thread_count();
        let offload_ops = local_gpu_enabled();
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(n_ctx))
            .with_n_batch(n_batch)
            .with_n_ubatch(n_ubatch)
            .with_n_threads(threads)
            .with_n_threads_batch(threads)
            .with_offload_kqv(offload_ops)
            .with_op_offload(offload_ops);
        let mut ctx = model
            .new_context(backend, ctx_params)
            .map_err(|error| error.to_string())?;

        let last_prompt_index = tokens.len().saturating_sub(1);
        let prompt_batch_limit = if cfg!(mobile) {
            (n_batch as usize).min(512)
        } else {
            n_batch as usize
        };
        let total_prompt_tokens = tokens.len();
        let mut prompt_cursor = 0usize;
        let mut sample_index = 0;
        while prompt_cursor < tokens.len() {
            if cancel.load(AtomicOrdering::Relaxed) {
                return Err("Generation stopped.".to_string());
            }
            if let Some(callback) = sinks.status.as_mut() {
                let percent = prompt_cursor * 100 / total_prompt_tokens;
                callback(format!("Reading context {percent}%"));
            }
            let prompt_end = (prompt_cursor + prompt_batch_limit).min(tokens.len());
            let mut prompt_batch = LlamaBatch::new(prompt_end - prompt_cursor, 1);
            for (offset, token) in tokens[prompt_cursor..prompt_end].iter().enumerate() {
                let index = prompt_cursor + offset;
                prompt_batch
                    .add(*token, index as i32, &[0], index == last_prompt_index)
                    .map_err(|error| error.to_string())?;
            }
            ctx.decode(&mut prompt_batch)
                .map_err(|error| error.to_string())?;
            if prompt_end == tokens.len() {
                sample_index = prompt_batch.n_tokens() - 1;
            }
            prompt_cursor = prompt_end;
        }
        if let Some(callback) = sinks.status.as_mut() {
            callback("Generating answer".to_string());
        }

        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::top_k(DEFAULT_TOP_K),
            LlamaSampler::top_p(DEFAULT_TOP_P, 1),
            LlamaSampler::temp(temperature),
            LlamaSampler::dist(0xA371_2026),
        ]);
        let mut decoder = UTF_8.new_decoder();
        let mut output = String::new();
        let mut generated_tokens = 0usize;
        let mut streamed_len = 0usize;
        let mut batch = LlamaBatch::new(1, 1);
        // Not a loop counter: this is the absolute position in the KV cache, which
        // starts after the prompt and is what llama_batch entries are keyed by.
        let mut position = tokens.len() as i32;

        // clippy reads `position` as a loop counter and suggests enumerate(). It is
        // not one: it is the absolute KV-cache position that llama_batch entries are
        // keyed by, it starts after the prompt, and it is not incremented on every
        // iteration.
        #[allow(clippy::explicit_counter_loop)]
        for _ in 0..max_tokens {
            if cancel.load(AtomicOrdering::Relaxed) {
                break;
            }
            let token = sampler.sample(&ctx, sample_index);
            if model.is_eog_token(token) {
                break;
            }
            generated_tokens = generated_tokens.saturating_add(1);
            let piece = model
                .token_to_piece(token, &mut decoder, true, None)
                .map_err(|error| error.to_string())?;
            output.push_str(&piece);
            if contains_stop_marker(&output) {
                break;
            }
            if let Some(on_token) = sinks.token.as_mut() {
                let safe_end = stream_safe_len(&output);
                if safe_end > streamed_len {
                    on_token(&output[streamed_len..safe_end]);
                    streamed_len = safe_end;
                }
            }

            batch.clear();
            batch
                .add(token, position, &[0], true)
                .map_err(|error| error.to_string())?;
            ctx.decode(&mut batch).map_err(|error| error.to_string())?;
            sample_index = batch.n_tokens() - 1;
            position += 1;
        }

        if output.trim().is_empty() && cancel.load(AtomicOrdering::Relaxed) {
            return Err("Generation stopped.".to_string());
        }

        Ok(ChatCompletion {
            text: output,
            generated_tokens,
        })
    }
}

#[derive(Clone)]
pub(crate) struct ModelDownloadSpec {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) repository: &'static str,
    pub(crate) revision: &'static str,
    pub(crate) filename: &'static str,
    pub(crate) destination: PathBuf,
    pub(crate) expected_bytes: u64,
}

impl ModelDownloadSpec {
    pub(crate) fn source_url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/{}/{}?download=true",
            self.repository, self.revision, self.filename
        )
    }
}
