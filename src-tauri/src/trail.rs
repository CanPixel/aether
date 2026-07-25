//! Semantic trails: the ranked, reasoned list of captures related to a query.

use super::*;

pub(crate) fn semantic_trail_default_query(captured: &CapturedPage) -> String {
    normalize_captured_text(&format!(
        "{}\n\n{}",
        captured.title,
        semantic_trail_excerpt(&captured.text, 1600)
    ))
}

pub(crate) fn semantic_trail_items(
    candidates: Vec<SemanticTrailChunkCandidate>,
    limit: usize,
) -> Vec<SemanticTrailItem> {
    let mut items = Vec::<SemanticTrailItem>::new();
    let mut indexes = HashMap::<String, usize>::new();

    for candidate in candidates {
        let key = normalize_capture_url_key(&candidate.chunk.url);
        if let Some(index) = indexes.get(&key).copied() {
            let item = &mut items[index];
            item.excerpt = merge_semantic_trail_excerpts(&item.excerpt, &candidate.chunk.text);
            for reason in candidate.reasons {
                add_semantic_trail_reason(&mut item.reasons, reason);
            }
            continue;
        }

        if items.len() >= limit {
            continue;
        }

        indexes.insert(key, items.len());
        items.push(SemanticTrailItem {
            id: candidate.chunk.capture_id.clone(),
            collection_id: candidate.chunk.collection_id.clone(),
            collection_name: candidate.collection_name,
            capture_id: candidate.chunk.capture_id,
            app_id: candidate.chunk.app_id,
            title: candidate.chunk.title,
            url: candidate.chunk.url.clone(),
            host: get_tab_host(&candidate.chunk.url),
            captured_at: candidate.chunk.captured_at,
            chunk_index: candidate.chunk.chunk_index,
            excerpt: semantic_trail_excerpt(&candidate.chunk.text, 520),
            score: candidate.score,
            reasons: candidate.reasons,
        });
    }

    items
}

pub(crate) fn semantic_trail_score_breakdown(
    distance: f64,
    captured_at: &str,
) -> SemanticTrailScoreBreakdown {
    // Relatedness is about meaning across the whole library, regardless of where a source
    // came from. Semantic similarity dominates; recency is only a gentle tiebreaker.
    let semantic = semantic_score_from_distance(distance);
    let recency = semantic_trail_recency_score(captured_at);
    let total = round_score((semantic * 0.92) + (recency * 0.08));

    SemanticTrailScoreBreakdown {
        total,
        semantic,
        recency,
    }
}

pub(crate) fn semantic_score_from_distance(distance: f64) -> f64 {
    if !distance.is_finite() {
        return 0.0;
    }
    round_score((1.0 - (distance / 1.2)).clamp(0.0, 1.0) * 100.0)
}

pub(crate) fn semantic_trail_recency_score(captured_at: &str) -> f64 {
    let Ok(parsed) = DateTime::parse_from_rfc3339(captured_at) else {
        return 0.0;
    };
    let days = Utc::now()
        .signed_duration_since(parsed.with_timezone(&Utc))
        .num_days()
        .max(0);
    match days {
        0..=7 => 100.0,
        8..=30 => 80.0,
        31..=90 => 60.0,
        91..=180 => 40.0,
        181..=365 => 25.0,
        _ => 10.0,
    }
}

pub(crate) fn semantic_trail_reasons(
    score: &SemanticTrailScoreBreakdown,
    same_collection: bool,
) -> Vec<SemanticTrailReason> {
    let mut reasons = Vec::new();
    if score.semantic >= 55.0 {
        reasons.push(SemanticTrailReason::SemanticMatch);
    }
    if score.recency >= 80.0 {
        reasons.push(SemanticTrailReason::RecentCapture);
    }
    if same_collection {
        reasons.push(SemanticTrailReason::SameCollection);
    }
    if reasons.is_empty() {
        reasons.push(SemanticTrailReason::SemanticMatch);
    }
    reasons
}

pub(crate) fn semantic_trail_edges(
    root: &SemanticTrailRoot,
    items: &[SemanticTrailItem],
) -> Vec<SemanticTrailEdge> {
    let mut edges = Vec::new();
    for item in items.iter().take(12) {
        push_semantic_trail_edge(
            &mut edges,
            "root",
            &item.id,
            SemanticTrailEdgeKind::SemanticMatch,
            item.score.total,
        );
        if !root.host.is_empty() && root.host == item.host {
            push_semantic_trail_edge(
                &mut edges,
                "root",
                &item.id,
                SemanticTrailEdgeKind::SameHost,
                item.score.total,
            );
        }
    }

    for left_index in 0..items.len().min(8) {
        for right_index in (left_index + 1)..items.len().min(8) {
            let left = &items[left_index];
            let right = &items[right_index];
            let weight = left.score.total.min(right.score.total);
            if left.collection_id == right.collection_id {
                push_semantic_trail_edge(
                    &mut edges,
                    &left.id,
                    &right.id,
                    SemanticTrailEdgeKind::SameCollection,
                    weight,
                );
            } else if !left.host.is_empty() && left.host == right.host {
                push_semantic_trail_edge(
                    &mut edges,
                    &left.id,
                    &right.id,
                    SemanticTrailEdgeKind::SameHost,
                    weight,
                );
            }
        }
    }

    edges
}

pub(crate) fn push_semantic_trail_edge(
    edges: &mut Vec<SemanticTrailEdge>,
    from: &str,
    to: &str,
    kind: SemanticTrailEdgeKind,
    weight: f64,
) {
    if edges.len() >= 36 || from == to {
        return;
    }
    edges.push(SemanticTrailEdge {
        from: from.to_string(),
        to: to.to_string(),
        kind,
        weight: round_score(weight),
    });
}

pub(crate) fn add_semantic_trail_reason(
    reasons: &mut Vec<SemanticTrailReason>,
    reason: SemanticTrailReason,
) {
    if !reasons.contains(&reason) {
        reasons.push(reason);
    }
}

pub(crate) fn merge_semantic_trail_excerpts(existing: &str, next: &str) -> String {
    let next = semantic_trail_excerpt(next, 360);
    if next.is_empty() || existing.contains(&next) {
        return existing.to_string();
    }
    semantic_trail_excerpt(&format!("{existing}\n\n[…]\n\n{next}"), 920)
}

pub(crate) fn semantic_trail_excerpt(text: &str, limit: usize) -> String {
    let normalized = normalize_captured_text(text);
    if normalized.chars().count() <= limit {
        return normalized;
    }
    let mut excerpt = normalized.chars().take(limit).collect::<String>();
    excerpt.push('…');
    excerpt
}

pub(crate) fn round_score(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}
