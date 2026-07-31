//! The Flow query graph: hubs and sources as nodes, semantic similarity as edges.

use super::*;

pub(crate) async fn flow_graph_generate(
    state: &State<'_, Backend>,
    input: FlowGraphInput,
) -> Cmd<FlowGraphResult> {
    let query = input.query.unwrap_or_default().trim().to_string();
    let source_limit = input
        .source_limit
        .unwrap_or(DEFAULT_FLOW_GRAPH_SOURCE_LIMIT)
        .clamp(1, MAX_FLOW_GRAPH_SOURCE_LIMIT);
    let (collections, mut captures) = with_library_read(state, |library| {
        (library.collections.clone(), library.captures.clone())
    })
    .await?;
    let collection_names = collections
        .iter()
        .map(|collection| (collection.id.clone(), collection.name.clone()))
        .collect::<HashMap<_, _>>();

    captures.sort_by(|left, right| right.captured_at.cmp(&left.captured_at));

    // The graph needs two things per capture: one averaged vector and one excerpt.
    // Both are derived inside the read lock, and only for the newest
    // `source_limit` captures that actually have chunks — the rest of the store is
    // never touched. Cloning `vectors.chunks` first, as this used to, copied every
    // chunk's text and vector in the library to build a summary of at most 180.
    let (indexed_source_count, mut summaries) = with_vectors_read(state, |vectors| {
        // Borrowed, so grouping costs pointers rather than records.
        let mut grouped = HashMap::<&str, Vec<&ChunkRecord>>::new();
        for chunk in &vectors.chunks {
            grouped
                .entry(chunk.capture_id.as_str())
                .or_default()
                .push(chunk);
        }

        let indexed = captures
            .iter()
            .filter(|capture| grouped.contains_key(capture.id.as_str()))
            .count();

        let summaries = captures
            .iter()
            .filter_map(|capture| grouped.get(capture.id.as_str()).map(|chunks| (capture, chunks)))
            .filter_map(|(capture, chunks)| {
                let vector = average_flow_source_vector(chunks)?;
                let excerpt = chunks
                    .iter()
                    .max_by_key(|chunk| chunk.text.chars().count())
                    .map(|chunk| semantic_trail_excerpt(&chunk.text, 300))
                    .unwrap_or_default();
                Some((capture.id.clone(), (vector, excerpt)))
            })
            // After the filter, not before: a capture whose chunks are all parked
            // for re-embedding averages to nothing, and taking first would let
            // those consume slots and shrink the graph. Lazy, so this still stops
            // at `source_limit` successes rather than summarising everything.
            .take(source_limit)
            .collect::<HashMap<_, _>>();

        (indexed, summaries)
    })
    .await?;

    let mut sources = Vec::<FlowSourceCandidate>::new();
    for capture in captures {
        if sources.len() >= source_limit {
            break;
        }
        let Some((vector, excerpt)) = summaries.remove(&capture.id) else {
            continue;
        };
        let collection_name = collection_names
            .get(&capture.collection_id)
            .cloned()
            .unwrap_or_else(|| "Knowledge Hub".to_string());
        sources.push(FlowSourceCandidate {
            capture,
            collection_name,
            vector,
            excerpt,
        });
    }

    let query_scores = if query.is_empty() || sources.is_empty() {
        HashMap::new()
    } else {
        let settings = load_settings(&state.paths.settings_path).await?;
        let query_vector = local_embed_query(state, &settings, query.clone()).await?;
        sources
            .iter()
            .map(|source| {
                let distance = cosine_distance(&query_vector, &source.vector);
                (
                    flow_source_node_id(&source.capture.id),
                    semantic_score_from_distance(distance),
                )
            })
            .filter(|(_, score)| score.is_finite())
            .collect::<HashMap<_, _>>()
    };

    let mut nodes = Vec::<FlowGraphNode>::new();
    if !query.is_empty() {
        nodes.push(FlowGraphNode {
            id: "query".to_string(),
            kind: FlowGraphNodeKind::Query,
            title: query.clone(),
            subtitle: "Semantic search lens".to_string(),
            weight: 72.0,
            collection_id: None,
            collection_name: None,
            capture_id: None,
            url: None,
            host: None,
            captured_at: None,
            excerpt: None,
            score: None,
        });
    }

    for collection in &collections {
        nodes.push(FlowGraphNode {
            id: flow_hub_node_id(&collection.id),
            kind: FlowGraphNodeKind::Hub,
            title: collection.name.clone(),
            subtitle: format!(
                "{} sources · {} chunks",
                collection.capture_count, collection.chunk_count
            ),
            weight: (42.0 + (collection.capture_count as f64 * 7.0)).min(92.0),
            collection_id: Some(collection.id.clone()),
            collection_name: Some(collection.name.clone()),
            capture_id: None,
            url: None,
            host: None,
            captured_at: Some(collection.updated_at.clone()),
            excerpt: Some(collection.description.clone())
                .filter(|description| !description.is_empty()),
            score: None,
        });
    }

    for source in &sources {
        let node_id = flow_source_node_id(&source.capture.id);
        nodes.push(FlowGraphNode {
            id: node_id.clone(),
            kind: FlowGraphNodeKind::Source,
            title: source.capture.title.clone(),
            subtitle: source.collection_name.clone(),
            weight: (24.0 + (source.capture.chunk_count as f64 * 2.0)).min(58.0),
            collection_id: Some(source.capture.collection_id.clone()),
            collection_name: Some(source.collection_name.clone()),
            capture_id: Some(source.capture.id.clone()),
            url: Some(source.capture.url.clone()),
            host: Some(get_tab_host(&source.capture.url)),
            captured_at: Some(source.capture.captured_at.clone()),
            excerpt: Some(source.excerpt.clone()).filter(|excerpt| !excerpt.is_empty()),
            score: query_scores.get(&node_id).copied().map(round_score),
        });
    }

    let mut edges = Vec::<FlowGraphEdge>::new();
    for source in &sources {
        push_flow_graph_edge(
            &mut edges,
            &flow_hub_node_id(&source.capture.collection_id),
            &flow_source_node_id(&source.capture.id),
            FlowGraphEdgeKind::Contains,
            36.0,
        );
    }

    if !query_scores.is_empty() {
        let mut matches = query_scores.iter().collect::<Vec<_>>();
        matches.sort_by(|left, right| right.1.partial_cmp(left.1).unwrap_or(Ordering::Equal));
        for (node_id, score) in matches.into_iter().take(FLOW_GRAPH_QUERY_MATCH_LIMIT) {
            if *score >= FLOW_GRAPH_MIN_EDGE_SCORE {
                push_flow_graph_edge(
                    &mut edges,
                    "query",
                    node_id,
                    FlowGraphEdgeKind::QueryMatch,
                    *score,
                );
            }
        }
    }

    let mut semantic_edges = Vec::<FlowEdgeCandidate>::new();
    for left_index in 0..sources.len() {
        for right_index in (left_index + 1)..sources.len() {
            let left = &sources[left_index];
            let right = &sources[right_index];
            let distance = cosine_distance(&left.vector, &right.vector);
            let weight = semantic_score_from_distance(distance);
            if weight >= FLOW_GRAPH_MIN_EDGE_SCORE {
                semantic_edges.push(FlowEdgeCandidate {
                    from: flow_source_node_id(&left.capture.id),
                    to: flow_source_node_id(&right.capture.id),
                    weight,
                });
            }
        }
    }
    semantic_edges.sort_by(|left, right| {
        right
            .weight
            .partial_cmp(&left.weight)
            .unwrap_or(Ordering::Equal)
    });
    let mut neighbor_counts = HashMap::<String, usize>::new();
    let mut semantic_edge_count = 0_usize;
    for candidate in semantic_edges {
        if semantic_edge_count >= FLOW_GRAPH_MAX_SEMANTIC_EDGES {
            break;
        }
        let left_count = *neighbor_counts.get(&candidate.from).unwrap_or(&0);
        let right_count = *neighbor_counts.get(&candidate.to).unwrap_or(&0);
        if left_count >= FLOW_GRAPH_NEIGHBORS_PER_SOURCE
            || right_count >= FLOW_GRAPH_NEIGHBORS_PER_SOURCE
        {
            continue;
        }
        push_flow_graph_edge(
            &mut edges,
            &candidate.from,
            &candidate.to,
            FlowGraphEdgeKind::Semantic,
            candidate.weight,
        );
        semantic_edge_count += 1;
        *neighbor_counts.entry(candidate.from).or_insert(0) += 1;
        *neighbor_counts.entry(candidate.to).or_insert(0) += 1;
    }

    Ok(FlowGraphResult {
        query,
        generated_at: now(),
        nodes,
        edges,
        hub_count: collections.len(),
        source_count: sources.len(),
        omitted_source_count: indexed_source_count.saturating_sub(sources.len()),
    })
}

// Takes references rather than owned records: the caller groups borrowed chunks
// inside the vector store's read lock, and nothing here needs ownership.
pub(crate) fn average_flow_source_vector(chunks: &[&ChunkRecord]) -> Option<Vec<f32>> {
    let first = chunks.first()?;
    let dimensions = first.vector.len();
    if dimensions == 0 {
        return None;
    }
    let mut total = vec![0.0_f32; dimensions];
    let mut count = 0.0_f32;
    for chunk in chunks {
        if chunk.vector.len() != dimensions {
            continue;
        }
        for (index, value) in chunk.vector.iter().enumerate() {
            total[index] += *value;
        }
        count += 1.0;
    }
    if count == 0.0 {
        return None;
    }
    for value in &mut total {
        *value /= count;
    }
    Some(normalize_embedding(&total))
}

pub(crate) fn flow_hub_node_id(collection_id: &str) -> String {
    format!("hub-{collection_id}")
}

pub(crate) fn flow_source_node_id(capture_id: &str) -> String {
    format!("source-{capture_id}")
}

pub(crate) fn push_flow_graph_edge(
    edges: &mut Vec<FlowGraphEdge>,
    from: &str,
    to: &str,
    kind: FlowGraphEdgeKind,
    weight: f64,
) {
    if from == to {
        return;
    }
    edges.push(FlowGraphEdge {
        id: format!("{}-{from}-{to}", flow_edge_kind_label(kind)),
        from: from.to_string(),
        to: to.to_string(),
        kind,
        weight: round_score(weight),
    });
}

pub(crate) fn flow_edge_kind_label(kind: FlowGraphEdgeKind) -> &'static str {
    match kind {
        FlowGraphEdgeKind::Contains => "contains",
        FlowGraphEdgeKind::Semantic => "semantic",
        FlowGraphEdgeKind::QueryMatch => "query",
    }
}
