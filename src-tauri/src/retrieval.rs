//! Library and hub search, plus hub suggestion for a captured page.

use super::*;

pub(crate) async fn search_collection(
    state: &State<'_, Backend>,
    input: SearchCollectionInput,
) -> Cmd<Vec<SearchResult>> {
    let query = input.query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    get_collection(state, &input.collection_id).await?;
    let settings = load_settings(&state.paths.settings_path).await?;
    let query_vector = local_embed_query(state, &settings, query).await?;
    with_vectors_read(state, |vectors| {
        let mut scored = vectors
            .chunks
            .iter()
            .filter(|chunk| chunk.collection_id == input.collection_id)
            .map(|chunk| (cosine_distance(&query_vector, &chunk.vector), chunk))
            .collect::<Vec<_>>();
        scored.sort_by(|left, right| left.0.partial_cmp(&right.0).unwrap_or(Ordering::Equal));
        scored.truncate(input.limit.unwrap_or(8));
        scored
            .into_iter()
            .map(|(score, chunk)| SearchResult {
                score,
                id: chunk.id.clone(),
                collection_id: chunk.collection_id.clone(),
                capture_id: chunk.capture_id.clone(),
                app_id: chunk.app_id.clone(),
                title: chunk.title.clone(),
                url: chunk.url.clone(),
                captured_at: chunk.captured_at.clone(),
                chunk_index: chunk.chunk_index,
                text: chunk.text.clone(),
            })
            .collect::<Vec<_>>()
    })
    .await
}

// Library search groups by capture, not by chunk. The chunk-level results that
// power retrieval are the wrong shape for a person: eight hits from one long page
// reads as eight sources. One row per source, with its best-matching passage and a
// count of how many passages matched, is what someone scanning results wants.
pub(crate) async fn search_library(
    state: &State<'_, Backend>,
    input: SearchLibraryInput,
) -> Cmd<LibrarySearchResult> {
    let query = input.query.trim().to_string();
    if query.is_empty() {
        return Ok(LibrarySearchResult {
            query,
            hits: Vec::new(),
            mode: "semantic".to_string(),
            searched_chunks: 0,
        });
    }

    // One pass over the library for both the labels and the scope check. These
    // used to be two independent reads, each parsing the whole file, to answer
    // questions about the same snapshot.
    let collection_names = with_library_read(state, |library| -> Cmd<HashMap<String, String>> {
        if let Some(collection_id) = input.collection_id.as_deref() {
            find_collection(library, collection_id)?;
        }
        Ok(library
            .collections
            .iter()
            .map(|collection| (collection.id.clone(), collection.name.clone()))
            .collect())
    })
    .await??;

    let settings = load_settings(&state.paths.settings_path).await?;
    let limit = input.limit.unwrap_or(20).clamp(1, 60);

    // Without an embedding model there is nothing to compare vectors against, so
    // fall back to literal matching rather than failing. Search staying usable with
    // no models installed is the difference between a browsable library and a
    // library you can only guess at.
    let query_vector = local_embed_query(state, &settings, query.clone())
        .await
        .ok();
    let mode = if query_vector.is_some() {
        "semantic"
    } else {
        "literal"
    };
    let needle = query.to_lowercase();

    let scope = input.collection_id.clone();
    let (hits, searched_chunks) = with_vectors_read(state, |vectors| {
        rank_library_hits(
            &vectors.chunks,
            &collection_names,
            scope.as_deref(),
            query_vector.as_deref(),
            &needle,
            limit,
        )
    })
    .await?;

    Ok(LibrarySearchResult {
        query,
        hits,
        mode: mode.to_string(),
        searched_chunks,
    })
}

// Pure ranking core, split out from search_library so the retrieval contract can be
// tested without a Tauri app or a 640 MB embedding model. Everything model-independent
// about search quality — scoping, per-capture grouping, ordering, limits — lives here.
pub(crate) fn rank_library_hits(
    chunks: &[ChunkRecord],
    collection_names: &HashMap<String, String>,
    scope: Option<&str>,
    query_vector: Option<&[f32]>,
    needle: &str,
    limit: usize,
) -> (Vec<LibrarySearchHit>, usize) {
    // map_or rather than is_none_or: the latter needs Rust 1.82 and this crate
    // declares MSRV 1.77.2.
    let scoped = chunks
        .iter()
        .filter(|chunk| scope.map_or(true, |id| chunk.collection_id == id));

    let mut best: HashMap<String, LibrarySearchHit> = HashMap::new();
    let mut examined = 0_usize;

    for chunk in scoped {
        examined += 1;
        let score = match query_vector {
            Some(vector) => semantic_score_from_distance(cosine_distance(vector, &chunk.vector)),
            None => literal_match_score(needle, chunk),
        };
        if score <= 0.0 {
            continue;
        }

        match best.get_mut(&chunk.capture_id) {
            Some(existing) => {
                existing.chunk_matches += 1;
                // One row per source shows its *best* passage, so a later weaker
                // chunk must not overwrite a stronger earlier one.
                if score > existing.score {
                    existing.score = score;
                    existing.excerpt = semantic_trail_excerpt(&chunk.text, 240);
                }
            }
            None => {
                best.insert(
                    chunk.capture_id.clone(),
                    LibrarySearchHit {
                        capture_id: chunk.capture_id.clone(),
                        collection_id: chunk.collection_id.clone(),
                        collection_name: collection_names
                            .get(&chunk.collection_id)
                            .cloned()
                            .unwrap_or_else(|| "Unknown hub".to_string()),
                        title: chunk.title.clone(),
                        url: chunk.url.clone(),
                        host: get_tab_host(&chunk.url),
                        captured_at: chunk.captured_at.clone(),
                        excerpt: semantic_trail_excerpt(&chunk.text, 240),
                        score,
                        chunk_matches: 1,
                    },
                );
            }
        }
    }

    let mut hits = best.into_values().collect::<Vec<_>>();
    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| right.captured_at.cmp(&left.captured_at))
            // Final tiebreak keeps output stable: HashMap iteration order is not.
            .then_with(|| left.capture_id.cmp(&right.capture_id))
    });
    hits.truncate(limit);
    (hits, examined)
}

// Literal scoring for the no-embedding-model path. Title and host matches outrank
// body matches, because someone typing a remembered name wants that page first.
pub(crate) fn literal_match_score(needle: &str, chunk: &ChunkRecord) -> f64 {
    if needle.is_empty() {
        return 0.0;
    }
    let mut score = 0.0_f64;
    if chunk.title.to_lowercase().contains(needle) {
        score += 70.0;
    }
    if chunk.url.to_lowercase().contains(needle) {
        score += 20.0;
    }
    if chunk.text.to_lowercase().contains(needle) {
        score += 25.0;
    }
    score.min(100.0)
}

#[tauri::command]
pub(crate) async fn aether_search_library(
    state: State<'_, Backend>,
    input: SearchLibraryInput,
) -> Cmd<LibrarySearchResult> {
    search_library(&state, input).await
}

#[derive(Clone)]
pub(crate) struct SemanticTrailChunkCandidate {
    pub(crate) chunk: ChunkRecord,
    pub(crate) collection_name: String,
    pub(crate) score: SemanticTrailScoreBreakdown,
    pub(crate) reasons: Vec<SemanticTrailReason>,
}

#[derive(Clone)]
pub(crate) struct FlowSourceCandidate {
    pub(crate) capture: CaptureSummary,
    pub(crate) collection_name: String,
    pub(crate) vector: Vec<f32>,
    pub(crate) excerpt: String,
}

pub(crate) struct FlowEdgeCandidate {
    pub(crate) from: String,
    pub(crate) to: String,
    pub(crate) weight: f64,
}

pub(crate) async fn semantic_trail_generate(
    state: &State<'_, Backend>,
    input: SemanticTrailInput,
) -> Cmd<SemanticTrailResult> {
    let limit = input
        .limit
        .unwrap_or(DEFAULT_SEMANTIC_TRAIL_LIMIT)
        .clamp(1, MAX_SEMANTIC_TRAIL_LIMIT);
    let explicit_query = input
        .query
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty());
    let (root, visible_query, embedding_query, root_url_key) = if let Some(query) = explicit_query {
        (
            SemanticTrailRoot {
                title: query.to_string(),
                url: String::new(),
                host: String::new(),
                excerpt: "Custom Focus lens matching captured sources across your knowledge hubs."
                    .to_string(),
            },
            query.to_string(),
            query.to_string(),
            None,
        )
    } else {
        let active_tab = {
            let tabs = lock_tabs(state)?;
            if tabs.dashboard_open {
                return Err("Open a web page before building Flow.".to_string());
            }
            tabs.active_tab()
                .cloned()
                .ok_or_else(|| "No active browser tab.".to_string())?
        };
        let captured = extract_readable_active_page(state, &active_tab).await?;
        let root_host = get_tab_host(&captured.url);
        let root_url_key = normalize_capture_url_key(&captured.url);
        (
            SemanticTrailRoot {
                title: captured.title.clone(),
                url: captured.url.clone(),
                host: root_host,
                excerpt: semantic_trail_excerpt(&captured.text, 420),
            },
            captured.title.clone(),
            semantic_trail_default_query(&captured),
            Some(root_url_key),
        )
    };

    let (collection_names, root_collection_ids) = with_library_read(state, |library| {
        let names = library
            .collections
            .iter()
            .map(|collection| (collection.id.clone(), collection.name.clone()))
            .collect::<HashMap<_, _>>();
        let roots = root_url_key
            .as_deref()
            .map(|key| {
                library
                    .captures
                    .iter()
                    .filter(|capture| normalize_capture_url_key(&capture.url) == key)
                    .map(|capture| capture.collection_id.clone())
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default();
        (names, roots)
    })
    .await?;

    if with_vectors_read(state, |vectors| vectors.chunks.is_empty()).await? {
        return Ok(SemanticTrailResult {
            query: visible_query,
            generated_at: now(),
            root,
            items: Vec::new(),
            edges: Vec::new(),
        });
    }

    let settings = load_settings(&state.paths.settings_path).await?;
    let query_vector = local_embed_query(state, &settings, embedding_query).await?;

    // Scored inside the read lock so only the chunks that survive the score
    // threshold are cloned. Cloning the store first and filtering after copied
    // every chunk's text and vector to throw almost all of them away.
    let mut candidates = with_vectors_read(state, |vectors| {
        vectors
            .chunks
            .iter()
            .filter_map(|chunk| {
                let distance = cosine_distance(&query_vector, &chunk.vector);
                if !distance.is_finite() {
                    return None;
                }
                let same_collection = root_collection_ids.contains(&chunk.collection_id);
                let score = semantic_trail_score_breakdown(distance, &chunk.captured_at);
                if score.semantic < SEMANTIC_TRAIL_MIN_SCORE {
                    return None;
                }
                let reasons = semantic_trail_reasons(&score, same_collection);
                let collection_name = collection_names
                    .get(&chunk.collection_id)
                    .cloned()
                    .unwrap_or_else(|| "Knowledge Hub".to_string());
                Some(SemanticTrailChunkCandidate {
                    chunk: chunk.clone(),
                    collection_name,
                    score,
                    reasons,
                })
            })
            .collect::<Vec<_>>()
    })
    .await?;

    candidates.sort_by(|left, right| {
        right
            .score
            .total
            .partial_cmp(&left.score.total)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                right
                    .score
                    .semantic
                    .partial_cmp(&left.score.semantic)
                    .unwrap_or(Ordering::Equal)
            })
    });

    let items = semantic_trail_items(candidates, limit);
    let edges = semantic_trail_edges(&root, &items);

    Ok(SemanticTrailResult {
        query: visible_query,
        generated_at: now(),
        root,
        items,
        edges,
    })
}

// Rank the user's hubs against the active page so capture can silently pre-select the best
// home for it. Best-effort: any reason we cannot produce a confident match returns Ok(None)
// rather than an error, so a failed suggestion never blocks or interrupts capturing.
pub(crate) async fn suggest_capture_hub(
    state: &State<'_, Backend>,
) -> Cmd<Option<CaptureHubSuggestion>> {
    let active_tab = {
        let tabs = lock_tabs(state)?;
        if tabs.dashboard_open {
            return Ok(None);
        }
        match tabs.active_tab().cloned() {
            Some(tab) => tab,
            None => return Ok(None),
        }
    };

    let captured = match extract_readable_active_page(state, &active_tab).await {
        Ok(page) => page,
        Err(_) => return Ok(None),
    };

    let names = collection_names(state).await?;
    if names.is_empty() {
        return Ok(None);
    }
    if with_vectors_read(state, |vectors| vectors.chunks.is_empty()).await? {
        return Ok(None);
    }

    let settings = load_settings(&state.paths.settings_path).await?;
    let embedding_query = semantic_trail_default_query(&captured);
    let query_vector = match local_embed_query(state, &settings, embedding_query).await {
        Ok(vector) => vector,
        Err(_) => return Ok(None),
    };

    // A hub is a strong home for this page if it already holds a source whose meaning is
    // close to it, so score each hub by its single closest chunk.
    //
    // Folded inside the read lock: the result is one entry per collection, so
    // cloning the whole chunk store to produce it was pure waste.
    let best_by_collection = with_vectors_read(state, |vectors| {
        let mut best: HashMap<String, (f64, String)> = HashMap::new();
        for chunk in &vectors.chunks {
            let distance = cosine_distance(&query_vector, &chunk.vector);
            if !distance.is_finite() {
                continue;
            }
            let semantic = semantic_score_from_distance(distance);
            let entry = best
                .entry(chunk.collection_id.clone())
                .or_insert((0.0, String::new()));
            if semantic > entry.0 {
                entry.0 = semantic;
                entry.1 = chunk.title.clone();
            }
        }
        best
    })
    .await?;

    let Some((collection_id, (confidence, sample_title))) =
        best_by_collection.into_iter().max_by(|left, right| {
            left.1
                 .0
                .partial_cmp(&right.1 .0)
                .unwrap_or(Ordering::Equal)
        })
    else {
        return Ok(None);
    };

    if confidence < CAPTURE_SUGGEST_MIN_SCORE {
        return Ok(None);
    }

    let collection_name = names
        .get(&collection_id)
        .cloned()
        .unwrap_or_else(|| "Knowledge Hub".to_string());

    Ok(Some(CaptureHubSuggestion {
        collection_id,
        collection_name,
        confidence: round_score(confidence),
        sample_title,
    }))
}
