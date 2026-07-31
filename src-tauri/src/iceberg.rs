//! iCE (Iceberg Complexity Explorer): prompt construction and the normaliser that
//! turns a model's loosely-shaped JSON into laid-out, level-banded topics.
//!
//! The normaliser is defensive on purpose — a 4B model will return missing fields,
//! out-of-range scores, and duplicate names, and none of that should reach the UI.

use super::*;

pub(crate) fn build_iceberg_prompt(keyword: &str) -> String {
    format!(
        r#"Create an iceberg chart for the topic "{keyword}".

Return JSON only with this exact shape:
{{
  "recommendedItemCount": 24,
  "items": [
    {{
      "name": "Visible phrase",
      "description": "One short explanation.",
      "depthScore": 12,
      "familiarity": 85,
      "specificity": 20,
      "jargonDensity": 15,
      "prerequisiteDepth": 10,
      "obscurity": 12,
      "reason": "Common public entry point."
    }}
  ]
}}

Rules:
- Choose recommendedItemCount based on topic scope: 12-18 for narrow topics, 20-30 for medium topics, 32-45 for broad domains.
- Return between 12 and 45 usable items.
- Cover all five iceberg layers whenever the topic has enough material. Include at least one item intentionally scored for each depth band: 0-19, 20-39, 40-59, 60-79, and 80-100.
- Prefer 2-5 genuinely obscure or specialist items for the 80-100 band instead of stopping at intermediate concepts.
- Do not include more than 10 items that would clearly belong to the same depth band.
- Use concise item names that fit on a node.
- Every item must include a non-empty description.
- Scores are integers from 0-100, never 1-10.
- depthScore: intended iceberg depth, where 0-19 is public surface knowledge and 80-100 is obscure, specialist, prerequisite-heavy, or rarely explained.
- familiarity: how likely a general audience already knows this.
- specificity: how narrow the concept is within the topic.
- jargonDensity: how much specialist vocabulary is needed.
- prerequisiteDepth: how much prior conceptual knowledge is required.
- obscurity: how rarely this appears in mainstream explainers or beginner material.
- reason: one short explanation for why the item sits at its depth.
- Do not include level; the app will compute levels from the scoring rubric.
- Do not include markdown, prose, or comments."#
    )
}

#[derive(Clone)]
pub(crate) struct ScoredIcebergItem {
    pub(crate) item: IcebergItem,
    pub(crate) score: f64,
}

fn recover_complete_iceberg_items(json_text: &str) -> Option<serde_json::Value> {
    let array_start = json_text.find('[')?;
    let mut objects = Vec::new();
    let mut object_start = None;
    let mut object_depth = 0_u32;
    let mut in_string = false;
    let mut escaped = false;

    for (offset, character) in json_text[array_start + 1..].char_indices() {
        let index = array_start + 1 + offset;

        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }

        match character {
            '"' if object_depth > 0 => in_string = true,
            '{' => {
                if object_depth == 0 {
                    object_start = Some(index);
                }
                object_depth += 1;
            }
            '}' if object_depth > 0 => {
                object_depth -= 1;
                if object_depth == 0 {
                    let start = object_start.take()?;
                    if let Ok(value) =
                        serde_json::from_str::<serde_json::Value>(&json_text[start..=index])
                    {
                        objects.push(value);
                    }
                }
            }
            ']' if object_depth == 0 => break,
            _ => {}
        }
    }

    (!objects.is_empty()).then_some(serde_json::Value::Array(objects))
}

pub(crate) fn normalize_iceberg_items(response: &str) -> Cmd<Vec<IcebergItem>> {
    let json_text = response
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed = match serde_json::from_str::<serde_json::Value>(json_text) {
        Ok(value) => value,
        Err(_) => {
            let parsed_array =
                json_text
                    .find('[')
                    .zip(json_text.rfind(']'))
                    .and_then(|(start, end)| {
                        serde_json::from_str::<serde_json::Value>(&json_text[start..=end]).ok()
                    });
            parsed_array
                .or_else(|| recover_complete_iceberg_items(json_text))
                .ok_or_else(|| "Local model did not return valid iceberg JSON.".to_string())?
        }
    };
    let requested_count = iceberg_requested_count(&parsed);
    let items_value = parsed.get("items").cloned().unwrap_or(parsed);
    let raw_items = items_value
        .as_array()
        .ok_or_else(|| "Local model did not return valid iceberg JSON.".to_string())?;
    let target_count = requested_count
        .unwrap_or(raw_items.len())
        .clamp(ICEBERG_MIN_ITEMS, ICEBERG_MAX_ITEMS);
    let mut candidates = Vec::<ScoredIcebergItem>::new();
    let mut seen_names = HashSet::<String>::new();
    for raw in raw_items {
        let name = raw
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim();
        let description = raw
            .get("description")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim();
        if name.is_empty() || description.is_empty() {
            continue;
        }

        let dedupe_key = slugify(name);
        if dedupe_key.is_empty() || !seen_names.insert(dedupe_key) {
            continue;
        }

        let fallback_level = iceberg_level_field(raw).unwrap_or(3);
        let fallback_score = iceberg_fallback_score(fallback_level);
        let familiarity = iceberg_metric_field(raw, &["familiarity"]);
        let specificity = iceberg_metric_field(raw, &["specificity"]);
        let jargon_density = iceberg_metric_field(raw, &["jargonDensity", "jargon_density"]);
        let prerequisite_depth =
            iceberg_metric_field(raw, &["prerequisiteDepth", "prerequisite_depth"]);
        let obscurity = iceberg_metric_field(raw, &["obscurity"]);
        let explicit_depth =
            iceberg_metric_field(raw, &["depthScore", "depth_score", "complexityScore"]);
        let score = explicit_depth.unwrap_or_else(|| {
            iceberg_depth_score(
                familiarity,
                specificity,
                jargon_density,
                prerequisite_depth,
                obscurity,
                fallback_score,
            )
        });
        let score = round_score(score.clamp(0.0, 100.0));
        let level = iceberg_level_from_score(score);
        let reason = iceberg_string_field(raw, &["reason", "rationale", "levelReason"])
            .map(|reason| reason.chars().take(220).collect::<String>());

        candidates.push(ScoredIcebergItem {
            item: IcebergItem {
                id: String::new(),
                name: name.to_string(),
                description: description.to_string(),
                level,
                x: 0.0,
                y: 0.0,
                depth_score: Some(score),
                familiarity,
                specificity,
                jargon_density,
                prerequisite_depth,
                obscurity,
                reason,
            },
            score,
        });
    }

    stretch_iceberg_candidate_levels(&mut candidates);

    candidates.sort_by(|left, right| {
        left.item
            .level
            .cmp(&right.item.level)
            .then_with(|| {
                left.score
                    .partial_cmp(&right.score)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| left.item.name.cmp(&right.item.name))
    });

    let mut buckets = HashMap::<u8, Vec<ScoredIcebergItem>>::new();
    for candidate in candidates {
        buckets
            .entry(candidate.item.level)
            .or_default()
            .push(candidate);
    }

    let mut selected = Vec::<ScoredIcebergItem>::new();
    let mut by_level = HashMap::<u8, usize>::new();

    for level in 1..=ICEBERG_LEVEL_COUNT {
        if selected.len() >= target_count {
            break;
        }
        if let Some(candidate) = take_iceberg_candidate(&mut buckets, level) {
            *by_level.entry(level).or_default() += 1;
            selected.push(candidate);
        }
    }

    while selected.len() < target_count {
        let mut added_any = false;
        for level in 1..=ICEBERG_LEVEL_COUNT {
            if selected.len() >= target_count {
                break;
            }
            if by_level.get(&level).copied().unwrap_or_default() >= ICEBERG_MAX_ITEMS_PER_LEVEL {
                continue;
            }
            if let Some(candidate) = take_iceberg_candidate(&mut buckets, level) {
                *by_level.entry(level).or_default() += 1;
                selected.push(candidate);
                added_any = true;
            }
        }

        if !added_any {
            break;
        }
    }

    selected.sort_by(|left, right| {
        left.item
            .level
            .cmp(&right.item.level)
            .then_with(|| {
                left.score
                    .partial_cmp(&right.score)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| left.item.name.cmp(&right.item.name))
    });

    let mut normalized = Vec::<IcebergItem>::new();
    let mut ids = Vec::<String>::new();
    let mut layout_counts = HashMap::<u8, usize>::new();
    for candidate in selected {
        let level_count = layout_counts.entry(candidate.item.level).or_default();
        let index = *level_count;
        *level_count += 1;
        let mut item = candidate.item;
        item.id = unique_slug(&format!("{}-{}-{}", item.level, index + 1, item.name), &ids);
        ids.push(item.id.clone());
        item.x = ICEBERG_LEVEL_LANES[index % ICEBERG_LEVEL_LANES.len()];
        item.y = 120.0 + index as f64 * 44.0;
        normalized.push(item);
    }

    if normalized.is_empty() {
        Err("Local model did not return any usable iceberg items.".to_string())
    } else {
        Ok(normalized)
    }
}

pub(crate) fn stretch_iceberg_candidate_levels(candidates: &mut [ScoredIcebergItem]) {
    if candidates.len() < ICEBERG_LEVEL_COUNT as usize {
        return;
    }

    let present_levels = candidates
        .iter()
        .map(|candidate| candidate.item.level)
        .collect::<HashSet<_>>();
    if present_levels.len() >= ICEBERG_LEVEL_COUNT as usize {
        return;
    }

    // Small local models often compress everything into middle scores. For iCE,
    // the useful ranking is relative to the requested topic, so spread a usable
    // set across all five bands instead of returning empty deep layers.
    let mut indices = (0..candidates.len()).collect::<Vec<_>>();
    indices.sort_by(|left, right| {
        candidates[*left]
            .score
            .partial_cmp(&candidates[*right].score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                candidates[*left]
                    .item
                    .name
                    .cmp(&candidates[*right].item.name)
            })
    });
    let total = candidates.len();
    for (rank, index) in indices.into_iter().enumerate() {
        let level = ((rank * ICEBERG_LEVEL_COUNT as usize) / total + 1)
            .min(ICEBERG_LEVEL_COUNT as usize) as u8;
        let score = iceberg_score_for_level_band(candidates[index].score, level);
        candidates[index].score = score;
        candidates[index].item.level = level;
        candidates[index].item.depth_score = Some(score);
    }
}

pub(crate) fn iceberg_score_for_level_band(score: f64, level: u8) -> f64 {
    let level = level.clamp(1, ICEBERG_LEVEL_COUNT);
    let lower = f64::from(level.saturating_sub(1)) * 20.0;
    let upper = if level == ICEBERG_LEVEL_COUNT {
        100.0
    } else {
        f64::from(level) * 20.0 - 1.0
    };
    round_score(score.clamp(lower, upper))
}

pub(crate) fn take_iceberg_candidate(
    buckets: &mut HashMap<u8, Vec<ScoredIcebergItem>>,
    level: u8,
) -> Option<ScoredIcebergItem> {
    let bucket = buckets.get_mut(&level)?;
    if bucket.is_empty() {
        None
    } else {
        Some(bucket.remove(0))
    }
}

pub(crate) fn iceberg_requested_count(value: &serde_json::Value) -> Option<usize> {
    let count = value
        .get("recommendedItemCount")
        .or_else(|| value.get("itemCount"))
        .or_else(|| value.get("recommended_count"))
        .and_then(|value| value.as_u64())?;
    usize::try_from(count).ok()
}

pub(crate) fn iceberg_level_field(value: &serde_json::Value) -> Option<u8> {
    let level = value
        .get("level")
        .or_else(|| value.get("proposedLevel"))
        .or_else(|| value.get("depthLevel"))
        .and_then(|value| value.as_u64())?;
    Some((level as u8).clamp(1, ICEBERG_LEVEL_COUNT))
}

pub(crate) fn iceberg_metric_field(value: &serde_json::Value, names: &[&str]) -> Option<f64> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(json_number))
        .map(normalize_iceberg_metric)
}

pub(crate) fn iceberg_string_field(value: &serde_json::Value, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(crate) fn json_number(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| {
            value
                .as_str()
                .and_then(|text| text.trim().parse::<f64>().ok())
        })
        .filter(|value| value.is_finite())
}

pub(crate) fn normalize_iceberg_metric(value: f64) -> f64 {
    let normalized = if (0.0..=1.0).contains(&value) {
        value * 100.0
    } else {
        value
    };
    round_score(normalized.clamp(0.0, 100.0))
}

pub(crate) fn iceberg_fallback_score(level: u8) -> f64 {
    match level.clamp(1, ICEBERG_LEVEL_COUNT) {
        1 => 10.0,
        2 => 30.0,
        3 => 50.0,
        4 => 70.0,
        _ => 90.0,
    }
}

pub(crate) fn iceberg_depth_score(
    familiarity: Option<f64>,
    specificity: Option<f64>,
    jargon_density: Option<f64>,
    prerequisite_depth: Option<f64>,
    obscurity: Option<f64>,
    fallback_score: f64,
) -> f64 {
    let familiarity = familiarity.unwrap_or(100.0 - fallback_score);
    let specificity = specificity.unwrap_or(fallback_score);
    let jargon_density = jargon_density.unwrap_or(fallback_score);
    let prerequisite_depth = prerequisite_depth.unwrap_or(fallback_score);
    let obscurity = obscurity.unwrap_or(fallback_score);

    specificity * 0.3
        + jargon_density * 0.25
        + prerequisite_depth * 0.2
        + obscurity * 0.15
        + (100.0 - familiarity) * 0.1
}

pub(crate) fn iceberg_level_from_score(score: f64) -> u8 {
    match score {
        value if value < 20.0 => 1,
        value if value < 40.0 => 2,
        value if value < 60.0 => 3,
        value if value < 80.0 => 4,
        _ => 5,
    }
}

pub(crate) fn clamp_optional_score(value: Option<f64>, min: f64, max: f64) -> Option<f64> {
    value
        .filter(|value| value.is_finite())
        .map(|value| round_score(value.clamp(min, max)))
}

pub(crate) fn normalize_saved_items(items: Vec<IcebergItem>) -> Vec<IcebergItem> {
    items
        .into_iter()
        .filter(|item| !item.name.trim().is_empty() && !item.description.trim().is_empty())
        .map(|mut item| {
            item.name = item.name.trim().to_string();
            item.description = item.description.trim().to_string();
            item.level = item.level.clamp(1, ICEBERG_LEVEL_COUNT);
            item.depth_score = clamp_optional_score(item.depth_score, 0.0, 100.0);
            item.familiarity = clamp_optional_score(item.familiarity, 0.0, 100.0);
            item.specificity = clamp_optional_score(item.specificity, 0.0, 100.0);
            item.jargon_density = clamp_optional_score(item.jargon_density, 0.0, 100.0);
            item.prerequisite_depth = clamp_optional_score(item.prerequisite_depth, 0.0, 100.0);
            item.obscurity = clamp_optional_score(item.obscurity, 0.0, 100.0);
            item.reason = item
                .reason
                .map(|reason| reason.trim().chars().take(220).collect::<String>())
                .filter(|reason| !reason.is_empty());
            if item.id.trim().is_empty() {
                item.id = unique_slug(&format!("{}-{}", item.level, item.name), &[]);
            }
            item
        })
        .collect()
}

pub(crate) fn saved_iceberg_summary(iceberg: &SavedIceberg) -> SavedIcebergSummary {
    SavedIcebergSummary {
        id: iceberg.id.clone(),
        title: iceberg.title.clone(),
        keyword: iceberg.iceberg.keyword.clone(),
        model: iceberg.iceberg.model.clone(),
        icon: iceberg.icon.clone(),
        generated_at: iceberg.iceberg.generated_at.clone(),
        saved_at: iceberg.saved_at.clone(),
        updated_at: iceberg.updated_at.clone(),
        item_count: iceberg.iceberg.items.len(),
    }
}

pub(crate) fn dedupe_citations(citations: Vec<SearchResult>) -> Vec<SearchResult> {
    let mut unique = Vec::<SearchResult>::new();
    let mut indexes = HashMap::<String, usize>::new();
    for citation in citations {
        let key = normalize_citation_key(&citation.url);
        if let Some(existing_index) = indexes.get(&key).copied() {
            let existing = &mut unique[existing_index];
            if !existing.text.contains(&citation.text) {
                // Join non-contiguous excerpts from the same page with a neutral
                // marker. A numbered "Chunk N" label here leaks into the model's
                // context and gets echoed as an uncitable "[Chunk N]" reference.
                existing.text = format!("{}\n\n[…]\n\n{}", existing.text, citation.text)
                    .chars()
                    .take(9000)
                    .collect();
            }
            existing.score = existing.score.min(citation.score);
        } else {
            indexes.insert(key, unique.len());
            unique.push(citation);
        }
    }
    unique
}

pub(crate) fn split_text(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    let chars = text.chars().collect::<Vec<_>>();
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let end = (start + chunk_size).min(chars.len());
        let chunk = chars[start..end]
            .iter()
            .collect::<String>()
            .trim()
            .to_string();
        if !chunk.is_empty() {
            chunks.push(chunk);
        }
        if end == chars.len() {
            break;
        }
        start = end.saturating_sub(overlap);
    }
    chunks
}

pub(crate) fn cosine_distance(left: &[f32], right: &[f32]) -> f64 {
    if left.is_empty() || left.len() != right.len() {
        return f64::INFINITY;
    }
    let mut dot = 0.0_f64;
    let mut left_norm = 0.0_f64;
    let mut right_norm = 0.0_f64;
    for (left, right) in left.iter().zip(right.iter()) {
        let left = *left as f64;
        let right = *right as f64;
        dot += left * right;
        left_norm += left * left;
        right_norm += right * right;
    }
    if left_norm == 0.0 || right_norm == 0.0 {
        f64::INFINITY
    } else {
        1.0 - dot / (left_norm.sqrt() * right_norm.sqrt())
    }
}
