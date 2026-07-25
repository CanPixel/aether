//! Ranking a query against captured chunks: the current page as a pseudo-source,
//! semantic ranking, and the lexical fallback used with no embedding model.

use super::*;

pub(crate) fn capture_chunk_settings(
    _paths: &DataPaths,
    _settings: &UserSettings,
) -> (usize, usize) {
    (DEFAULT_CAPTURE_CHUNK_SIZE, DEFAULT_CAPTURE_CHUNK_OVERLAP)
}

pub(crate) fn current_page_search_result(
    captured: &CapturedPage,
    collection_id: Option<&str>,
    chunk_index: usize,
    score: f64,
    text: String,
) -> SearchResult {
    SearchResult {
        id: format!("current-{}", uuid()),
        collection_id: collection_id
            .map(ToString::to_string)
            .unwrap_or_else(|| "current-page".to_string()),
        capture_id: "current-page".to_string(),
        app_id: "browser".to_string(),
        title: captured.title.clone(),
        url: captured.url.clone(),
        captured_at: now(),
        chunk_index,
        text,
        score,
    }
}

// The current page isn't pre-indexed like a knowledge hub, so rank its chunks at
// ask-time. We mirror the hub's semantic retrieval (embed the query + chunks, rank
// by cosine distance, keep the best matches) and fall back to lexical scoring only
// when no embedding model is available. Returning several chunks instead of the
// single best is what lets the model actually answer: dedupe_citations later merges
// these same-URL chunks into one context-dense citation, just like the hub.
pub(crate) async fn current_page_citations(
    state: &State<'_, Backend>,
    settings: &UserSettings,
    captured: CapturedPage,
    prompt: &str,
    collection_id: Option<&str>,
    limit: usize,
) -> Vec<SearchResult> {
    if limit == 0 {
        return Vec::new();
    }
    let (chunk_size, chunk_overlap) = capture_chunk_settings(&state.paths, settings);
    let chunks = split_text(&captured.text, chunk_size, chunk_overlap);
    if chunks.is_empty() {
        return Vec::new();
    }

    if let Some(ranked) = semantic_rank_chunks(state, settings, &chunks, prompt, limit).await {
        return ranked
            .into_iter()
            .map(|(index, distance)| {
                current_page_search_result(
                    &captured,
                    collection_id,
                    index,
                    distance,
                    chunks[index].clone(),
                )
            })
            .collect();
    }

    // Lexical fallback (no embedding model): keep the highest-scoring chunks.
    let mut scored = chunks
        .iter()
        .enumerate()
        .map(|(index, text)| (lexical_relevance_score(text, prompt), index))
        .filter(|(score, _)| *score > 0.0)
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| right.0.partial_cmp(&left.0).unwrap_or(Ordering::Equal));

    if scored.is_empty() {
        // Nothing matched lexically — anchor on the start of the page rather than
        // returning nothing.
        let first = chunks.into_iter().next().unwrap_or_default();
        return vec![current_page_search_result(
            &captured,
            collection_id,
            0,
            0.0,
            first,
        )];
    }

    scored
        .into_iter()
        .take(limit)
        .map(|(score, index)| {
            current_page_search_result(
                &captured,
                collection_id,
                index,
                score,
                chunks[index].clone(),
            )
        })
        .collect()
}

// Embed the query alongside the page chunks in one batch, then order chunk indices
// by ascending cosine distance. Returns None when embedding is unavailable so the
// caller can fall back to lexical scoring.
pub(crate) async fn semantic_rank_chunks(
    state: &State<'_, Backend>,
    settings: &UserSettings,
    chunks: &[String],
    prompt: &str,
    limit: usize,
) -> Option<Vec<(usize, f64)>> {
    let mut inputs = Vec::with_capacity(chunks.len() + 1);
    inputs.push(embedding_query_input(&state.paths, settings, prompt));
    inputs.extend(chunks.iter().cloned());

    let embeddings = local_embed(state, settings, inputs).await.ok()?;
    if embeddings.len() != chunks.len() + 1 {
        return None;
    }

    let query_vector = &embeddings[0];
    let mut scored = embeddings[1..]
        .iter()
        .enumerate()
        .map(|(index, vector)| (cosine_distance(query_vector, vector), index))
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| left.0.partial_cmp(&right.0).unwrap_or(Ordering::Equal));
    Some(
        scored
            .into_iter()
            .take(limit)
            .map(|(distance, index)| (index, distance))
            .collect(),
    )
}

pub(crate) fn lexical_relevance_score(text: &str, query: &str) -> f64 {
    let terms = query_terms(query);
    if terms.is_empty() {
        return 0.0;
    }
    let haystack = text.to_lowercase();
    terms
        .iter()
        .map(|term| lexical_term_score(&haystack, term))
        .sum()
}

pub(crate) fn lexical_term_score(haystack: &str, term: &str) -> f64 {
    let occurrences = haystack.matches(term).count();
    if occurrences > 0 {
        // Reward repeated mentions so a chunk that actually discusses the term beats
        // one that merely name-drops it once. Without this, every matching chunk ties
        // and the tie-break is arbitrary.
        return 2.0 + (term.len() as f64 / 10.0) + (occurrences.saturating_sub(1) as f64) * 0.5;
    }
    let stem_len = term.len().min(6);
    if stem_len >= 5 && haystack.contains(&term[..stem_len]) {
        return 1.25 + (stem_len as f64 / 12.0);
    }
    if let Some(singular) = term.strip_suffix('s') {
        if singular.len() >= 5 && haystack.contains(singular) {
            return 1.5 + (singular.len() as f64 / 12.0);
        }
    }
    0.0
}

pub(crate) fn query_terms(query: &str) -> Vec<String> {
    let stopwords = [
        "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how",
        "i", "in", "is", "it", "me", "most", "of", "on", "or", "should", "the", "this", "to",
        "was", "were", "what", "when", "where", "which", "who", "why", "with",
    ];
    let stopwords = stopwords.into_iter().collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    query
        .split(|character: char| !character.is_alphanumeric())
        .map(str::trim)
        .map(str::to_lowercase)
        .filter(|term| term.len() > 2 && !stopwords.contains(term.as_str()))
        .filter(|term| seen.insert(term.clone()))
        .collect()
}
