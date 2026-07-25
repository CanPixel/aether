//! AiR: rendering a set of captures into a Markdown dossier on disk.

use super::*;

pub(crate) async fn air_prepare_dossier(
    state: &State<'_, Backend>,
    input: AirDossierInput,
    synthesize: bool,
) -> Cmd<AirPreparedDossier> {
    let lens_kind = input.lens_kind.unwrap_or_default();
    let lens = input.lens.trim().to_string();
    let visible_lens = if lens.is_empty() {
        match lens_kind {
            AirLensKind::Topic => "Local knowledge".to_string(),
            AirLensKind::Flow => "Current Flow lens".to_string(),
            AirLensKind::Hub => "Selected knowledge hub".to_string(),
            AirLensKind::Answer => "Latest AiON answer".to_string(),
            AirLensKind::Iceberg => "Saved iCE map".to_string(),
        }
    } else {
        lens
    };
    let generated_at = now();
    let limit = input.limit.unwrap_or(12).clamp(1, 24);
    let (sources, seed_answer, ice_map, seed_model) =
        air_gather_context(state, &input, lens_kind, &visible_lens, limit).await?;
    let title = format!("AiR Dossier: {visible_lens}");
    let output_dir = resolve_air_export_dir(&state.paths, false).await?;

    let mut model = seed_model.unwrap_or_else(|| "deterministic-scaffold".to_string());
    let synthesized_sections = if synthesize {
        match air_synthesize_sections(
            state,
            &visible_lens,
            lens_kind,
            &sources,
            seed_answer.as_deref(),
            ice_map.as_deref(),
        )
        .await
        {
            Ok((synthesis_model, sections)) => {
                model = synthesis_model;
                Some(sections)
            }
            Err(_) => None,
        }
    } else {
        None
    };

    let markdown_preview = build_air_markdown(AirMarkdownInput {
        title: &title,
        lens: &visible_lens,
        lens_kind,
        generated_at: &generated_at,
        model: &model,
        sources: &sources,
        synthesized_sections: synthesized_sections.as_deref(),
        seed_answer: seed_answer.as_deref(),
        ice_map: ice_map.as_deref(),
    });

    Ok(AirPreparedDossier {
        title,
        lens: visible_lens,
        lens_kind,
        generated_at,
        model: Some(model),
        output_dir: output_dir.display().to_string(),
        markdown_preview,
        sources,
    })
}

pub(crate) async fn air_gather_context(
    state: &State<'_, Backend>,
    input: &AirDossierInput,
    lens_kind: AirLensKind,
    lens: &str,
    limit: usize,
) -> Cmd<(
    Vec<AirDossierSource>,
    Option<String>,
    Option<String>,
    Option<String>,
)> {
    match lens_kind {
        AirLensKind::Answer => {
            let Some(answer) = input.answer.clone() else {
                return Ok((Vec::new(), None, None, None));
            };
            let library = load_library(&state.paths.library_path).await?;
            let collection_names = library
                .collections
                .iter()
                .map(|collection| (collection.id.clone(), collection.name.clone()))
                .collect::<HashMap<_, _>>();
            let sources = search_results_to_air_sources(
                dedupe_citations(answer.citations)
                    .into_iter()
                    .take(limit)
                    .collect(),
                &collection_names,
            );
            Ok((sources, Some(answer.answer), None, Some(answer.model)))
        }
        AirLensKind::Iceberg => {
            let icebergs = load_icebergs(&state.paths.icebergs_path).await?;
            let selected = input
                .saved_iceberg_id
                .as_deref()
                .and_then(|id| icebergs.icebergs.iter().find(|iceberg| iceberg.id == id))
                .or_else(|| {
                    icebergs
                        .icebergs
                        .iter()
                        .find(|iceberg| iceberg.title.eq_ignore_ascii_case(lens))
                })
                .or_else(|| icebergs.icebergs.first());
            let Some(iceberg) = selected else {
                return Ok((Vec::new(), None, None, None));
            };
            let mut items = iceberg.iceberg.items.clone();
            items.sort_by(|left, right| {
                left.level
                    .cmp(&right.level)
                    .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            });
            let sources = items
                .iter()
                .take(limit)
                .map(|item| AirDossierSource {
                    id: format!("iceberg-{}", item.id),
                    title: item.name.clone(),
                    excerpt: format!("Level {}: {}", item.level, item.description),
                    collection_name: Some(format!("iCE · {}", iceberg.title)),
                    url: None,
                    host: None,
                    captured_at: Some(iceberg.updated_at.clone()),
                    score: None,
                })
                .collect::<Vec<_>>();
            let map = items
                .iter()
                .map(|item| {
                    format!(
                        "- Level {} · {}: {}",
                        item.level, item.name, item.description
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            Ok((
                sources,
                None,
                Some(map),
                Some(iceberg.iceberg.model.clone()),
            ))
        }
        AirLensKind::Hub => {
            let sources = air_sources_for_hub(state, input.collection_id.as_deref(), limit).await?;
            Ok((sources, None, None, None))
        }
        AirLensKind::Flow => {
            if let Some(collection_id) = input.collection_id.as_deref() {
                let sources = air_sources_for_hub(state, Some(collection_id), limit).await?;
                return Ok((sources, None, None, None));
            }
            let mut sources = match input.capture_id.as_deref() {
                Some(capture_id) => air_sources_for_capture(state, capture_id).await?,
                None => Vec::new(),
            };
            let existing = sources
                .iter()
                .map(|source| source.id.clone())
                .collect::<HashSet<_>>();
            let related = air_sources_for_topic(state, lens, limit).await?;
            sources.extend(
                related
                    .into_iter()
                    .filter(|source| !existing.contains(&source.id))
                    .take(limit.saturating_sub(sources.len())),
            );
            Ok((sources, None, None, None))
        }
        AirLensKind::Topic => {
            let sources = air_sources_for_topic(state, lens, limit).await?;
            Ok((sources, None, None, None))
        }
    }
}

pub(crate) async fn air_sources_for_hub(
    state: &State<'_, Backend>,
    collection_id: Option<&str>,
    limit: usize,
) -> Cmd<Vec<AirDossierSource>> {
    let library = load_library(&state.paths.library_path).await?;
    let collection_names = library
        .collections
        .iter()
        .map(|collection| (collection.id.clone(), collection.name.clone()))
        .collect::<HashMap<_, _>>();
    let vectors = with_vectors_read(state, |vectors| vectors.chunks.clone()).await?;
    let mut chunks_by_capture = HashMap::<String, Vec<ChunkRecord>>::new();
    for chunk in vectors {
        chunks_by_capture
            .entry(chunk.capture_id.clone())
            .or_default()
            .push(chunk);
    }
    let mut captures = library
        .captures
        .into_iter()
        .filter(|capture| {
            collection_id
                .map(|id| capture.collection_id == id)
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();
    captures.sort_by(|left, right| right.captured_at.cmp(&left.captured_at));
    Ok(captures
        .into_iter()
        .take(limit)
        .map(|capture| {
            let excerpt = chunks_by_capture
                .get(&capture.id)
                .and_then(|chunks| chunks.iter().max_by_key(|chunk| chunk.text.chars().count()))
                .map(|chunk| semantic_trail_excerpt(&chunk.text, 700))
                .or_else(|| {
                    capture
                        .metadata
                        .as_ref()
                        .and_then(|metadata| metadata.summary.clone())
                })
                .unwrap_or_default();
            AirDossierSource {
                id: capture.id.clone(),
                title: capture.title,
                excerpt,
                collection_name: collection_names.get(&capture.collection_id).cloned(),
                url: Some(capture.url.clone()),
                host: Some(get_tab_host(&capture.url)),
                captured_at: Some(capture.captured_at),
                score: None,
            }
        })
        .collect())
}

pub(crate) async fn air_sources_for_capture(
    state: &State<'_, Backend>,
    capture_id: &str,
) -> Cmd<Vec<AirDossierSource>> {
    let library = load_library(&state.paths.library_path).await?;
    let collection_names = library
        .collections
        .iter()
        .map(|collection| (collection.id.clone(), collection.name.clone()))
        .collect::<HashMap<_, _>>();
    let Some(capture) = library
        .captures
        .iter()
        .find(|capture| capture.id == capture_id)
        .cloned()
    else {
        return Ok(Vec::new());
    };
    let mut chunks = with_vectors_read(state, |vectors| {
        vectors
            .chunks
            .iter()
            .filter(|chunk| chunk.capture_id == capture_id)
            .cloned()
            .collect::<Vec<_>>()
    })
    .await?;
    chunks.sort_by_key(|chunk| chunk.chunk_index);
    let excerpt = semantic_trail_excerpt(
        &chunks
            .iter()
            .map(|chunk| chunk.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n"),
        1200,
    );
    Ok(vec![AirDossierSource {
        id: capture.id.clone(),
        title: capture.title,
        excerpt,
        collection_name: collection_names.get(&capture.collection_id).cloned(),
        url: Some(capture.url.clone()),
        host: Some(get_tab_host(&capture.url)),
        captured_at: Some(capture.captured_at),
        score: Some(100.0),
    }])
}

pub(crate) async fn air_sources_for_topic(
    state: &State<'_, Backend>,
    lens: &str,
    limit: usize,
) -> Cmd<Vec<AirDossierSource>> {
    let library = load_library(&state.paths.library_path).await?;
    let collection_names = library
        .collections
        .iter()
        .map(|collection| (collection.id.clone(), collection.name.clone()))
        .collect::<HashMap<_, _>>();
    let vectors = with_vectors_read(state, |vectors| vectors.chunks.clone()).await?;
    if vectors.is_empty() {
        return Ok(Vec::new());
    }

    let results = if lens.trim().is_empty() || lens == "Current Flow lens" {
        let mut chunks = vectors;
        chunks.sort_by(|left, right| right.captured_at.cmp(&left.captured_at));
        chunks
            .into_iter()
            .take(limit * 2)
            .map(|chunk| SearchResult {
                score: 0.0,
                id: chunk.id,
                collection_id: chunk.collection_id,
                capture_id: chunk.capture_id,
                app_id: chunk.app_id,
                title: chunk.title,
                url: chunk.url,
                captured_at: chunk.captured_at,
                chunk_index: chunk.chunk_index,
                text: chunk.text,
            })
            .collect::<Vec<_>>()
    } else {
        let settings = load_settings(&state.paths.settings_path).await?;
        let query_vector = local_embed_query(state, &settings, lens.to_string()).await?;
        let mut scored = vectors
            .into_iter()
            .filter_map(|chunk| {
                let distance = cosine_distance(&query_vector, &chunk.vector);
                if !distance.is_finite() {
                    return None;
                }
                Some((distance, chunk))
            })
            .collect::<Vec<_>>();
        scored.sort_by(|left, right| left.0.partial_cmp(&right.0).unwrap_or(Ordering::Equal));
        scored
            .into_iter()
            .take(limit * 3)
            .map(|(score, chunk)| SearchResult {
                score,
                id: chunk.id,
                collection_id: chunk.collection_id,
                capture_id: chunk.capture_id,
                app_id: chunk.app_id,
                title: chunk.title,
                url: chunk.url,
                captured_at: chunk.captured_at,
                chunk_index: chunk.chunk_index,
                text: chunk.text,
            })
            .collect::<Vec<_>>()
    };
    Ok(search_results_to_air_sources(
        dedupe_citations(results).into_iter().take(limit).collect(),
        &collection_names,
    ))
}

pub(crate) fn search_results_to_air_sources(
    results: Vec<SearchResult>,
    collection_names: &HashMap<String, String>,
) -> Vec<AirDossierSource> {
    results
        .into_iter()
        .map(|result| {
            let collection_name = collection_names.get(&result.collection_id).cloned();
            AirDossierSource {
                id: result.capture_id.clone(),
                title: result.title,
                excerpt: semantic_trail_excerpt(&result.text, 850),
                collection_name,
                url: Some(result.url.clone()),
                host: Some(get_tab_host(&result.url)),
                captured_at: Some(result.captured_at),
                score: Some(round_score(semantic_score_from_distance(result.score))),
            }
        })
        .collect()
}

pub(crate) async fn air_synthesize_sections(
    state: &State<'_, Backend>,
    lens: &str,
    lens_kind: AirLensKind,
    sources: &[AirDossierSource],
    seed_answer: Option<&str>,
    ice_map: Option<&str>,
) -> Cmd<(String, String)> {
    let settings = load_settings(&state.paths.settings_path).await?;
    let citations = sources
        .iter()
        .enumerate()
        .map(|(index, source)| SearchResult {
            id: source.id.clone(),
            collection_id: source.collection_name.clone().unwrap_or_default(),
            capture_id: source.id.clone(),
            app_id: "air".to_string(),
            title: source.title.clone(),
            url: source
                .url
                .clone()
                .unwrap_or_else(|| format!("aether://air/source/{}", index + 1)),
            captured_at: source.captured_at.clone().unwrap_or_else(now),
            chunk_index: index,
            text: source.excerpt.clone(),
            score: source.score.unwrap_or(0.0),
        })
        .collect::<Vec<_>>();
    let source_rule = if citations.is_empty() {
        "No local source excerpts matched. Say that coverage is currently sparse."
    } else {
        "Use only the numbered local source excerpts. Cite every concrete claim with bracket citations like [1] or [2]."
    };
    let prompt = format!(
        "Render a concise Markdown dossier for Æther AiR.\nLens kind: {}\nLens: {lens}\n{source_rule}\n\nInclude exactly these sections:\n## Summary\n## Key Findings\n## Source-Backed Notes\n## Unresolved Questions\n\nDo not include YAML frontmatter, a title, or a source index. Keep prose dense and professional.\n\nSeed AiON answer:\n{}\n\nSaved iCE map:\n{}",
        air_lens_label(lens_kind),
        seed_answer.unwrap_or("None"),
        ice_map.unwrap_or("None")
    );
    let result = local_chat(state, &settings, &prompt, citations, &[], None).await?;
    Ok((
        result.model,
        normalize_model_markdown_citations(&result.answer, sources.len()),
    ))
}

pub(crate) struct AirMarkdownInput<'a> {
    pub(crate) title: &'a str,
    pub(crate) lens: &'a str,
    pub(crate) lens_kind: AirLensKind,
    pub(crate) generated_at: &'a str,
    pub(crate) model: &'a str,
    pub(crate) sources: &'a [AirDossierSource],
    pub(crate) synthesized_sections: Option<&'a str>,
    pub(crate) seed_answer: Option<&'a str>,
    pub(crate) ice_map: Option<&'a str>,
}

pub(crate) fn build_air_markdown(input: AirMarkdownInput<'_>) -> String {
    let tags = air_tags(input.lens)
        .into_iter()
        .map(|tag| yaml_string(&tag))
        .collect::<Vec<_>>()
        .join(", ");
    let mut markdown = format!(
        "---\ntitle: {}\ncreated: {}\naether_lens: {}\nsource_count: {}\ntags: [{}]\nmodel: {}\ntype: aether-dossier\n---\n\n# {}\n\n_Rendered by AiR from the {} lens on {}._\n\n",
        yaml_string(input.title),
        yaml_string(input.generated_at),
        yaml_string(input.lens),
        input.sources.len(),
        tags,
        yaml_string(input.model),
        markdown_escape(input.title),
        air_lens_label(input.lens_kind),
        markdown_escape(input.generated_at)
    );

    if let Some(sections) = input
        .synthesized_sections
        .map(str::trim)
        .filter(|sections| !sections.is_empty())
    {
        markdown.push_str(sections);
        markdown.push_str("\n\n");
    } else {
        markdown.push_str("## Summary\n\n");
        if input.sources.is_empty() {
            markdown.push_str(&format!(
                "No local sources matched [[{}]] yet. This dossier preserves the requested lens and can be regenerated after more captures are available.\n\n",
                markdown_escape(input.lens)
            ));
        } else {
            markdown.push_str(&format!(
                "This dossier gathers {} local source{} around [[{}]]. It is generated as a deterministic citation scaffold from Æther's captured knowledge.\n\n",
                input.sources.len(),
                if input.sources.len() == 1 { "" } else { "s" },
                markdown_escape(input.lens)
            ));
        }

        markdown.push_str("## Key Findings\n\n");
        if input.sources.is_empty() {
            markdown.push_str("- Coverage is sparse; capture or connect more relevant material before treating this lens as complete.\n\n");
        } else {
            for (index, source) in input.sources.iter().take(6).enumerate() {
                markdown.push_str(&format!(
                    "- **{}** anchors this lens with: {} [^{}]\n",
                    markdown_escape(&source.title),
                    markdown_escape(&semantic_trail_excerpt(&source.excerpt, 180)),
                    index + 1
                ));
            }
            markdown.push('\n');
        }

        markdown.push_str("## Source-Backed Notes\n\n");
        for (index, source) in input.sources.iter().enumerate() {
            markdown.push_str(&format!(
                "### {}. {}\n\n{}\n\n",
                index + 1,
                markdown_escape(&source.title),
                markdown_escape(&source.excerpt)
            ));
            let mut meta = Vec::new();
            if let Some(collection) = &source.collection_name {
                meta.push(format!("Hub: {}", markdown_escape(collection)));
            }
            if let Some(host) = &source.host {
                meta.push(format!("Host: {}", markdown_escape(host)));
            }
            if let Some(captured_at) = &source.captured_at {
                meta.push(format!("Captured: {}", markdown_escape(captured_at)));
            }
            if let Some(score) = source.score {
                meta.push(format!("Match: {score:.1}"));
            }
            if !meta.is_empty() {
                markdown.push_str(&format!("{}\n\n", meta.join(" · ")));
            }
        }

        if let Some(answer) = input
            .seed_answer
            .map(str::trim)
            .filter(|answer| !answer.is_empty())
        {
            markdown.push_str("## AiON Seed\n\n");
            markdown.push_str(&markdown_escape(answer));
            markdown.push_str("\n\n");
        }

        if let Some(map) = input.ice_map.map(str::trim).filter(|map| !map.is_empty()) {
            markdown.push_str("## iCE Map\n\n");
            markdown.push_str(&markdown_escape(map));
            markdown.push_str("\n\n");
        }

        markdown.push_str("## Unresolved Questions\n\n");
        markdown.push_str("- Which claims need fresher or primary-source confirmation?\n");
        markdown.push_str("- Which adjacent hubs should be captured next to improve coverage?\n\n");
    }

    markdown.push_str("## Source Index\n\n");
    if input.sources.is_empty() {
        markdown.push_str("No source index entries were available for this render.\n");
    } else {
        for (index, source) in input.sources.iter().enumerate() {
            let title = markdown_escape(&source.title);
            let collection = source
                .collection_name
                .as_deref()
                .map(markdown_escape)
                .unwrap_or_else(|| "Knowledge Hub".to_string());
            let captured_at = source
                .captured_at
                .as_deref()
                .map(markdown_escape)
                .unwrap_or_else(|| "unknown capture date".to_string());
            if let Some(url) = &source.url {
                markdown.push_str(&format!(
                    "[^{}]: [{}]({}) — {} · {}\n",
                    index + 1,
                    title,
                    url.replace(')', "%29"),
                    collection,
                    captured_at
                ));
            } else {
                markdown.push_str(&format!(
                    "[^{}]: {} — {} · {}\n",
                    index + 1,
                    title,
                    collection,
                    captured_at
                ));
            }
        }
    }
    markdown
}

pub(crate) async fn resolve_air_export_dir(paths: &DataPaths, create: bool) -> Cmd<PathBuf> {
    let preferred = documents_air_dir();
    let candidates = preferred
        .into_iter()
        .chain(std::iter::once(paths.air_exports_path.clone()))
        .collect::<Vec<_>>();
    for candidate in candidates {
        if !create {
            if candidate.exists()
                || candidate
                    .parent()
                    .is_some_and(|parent| parent.exists() && parent.is_dir())
            {
                return Ok(candidate);
            }
            continue;
        }
        if tokio::fs::create_dir_all(&candidate).await.is_ok() {
            return Ok(candidate);
        }
    }
    if create {
        Err("Could not create an AiR export folder.".to_string())
    } else {
        Ok(paths.air_exports_path.clone())
    }
}

pub(crate) fn documents_air_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|home| home.join("Documents").join("Æther").join("AiR"))
}

pub(crate) async fn air_list_recent(paths: &DataPaths) -> Cmd<Vec<AirRecentFile>> {
    let mut files = Vec::<AirRecentFile>::new();
    let mut directories = Vec::new();
    if let Some(documents) = documents_air_dir() {
        directories.push(documents);
    }
    directories.push(paths.air_exports_path.clone());

    for directory in directories {
        let Ok(mut entries) = tokio::fs::read_dir(&directory).await else {
            continue;
        };
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| error.to_string())?
        {
            let path = entry.path();
            if !path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
            {
                continue;
            }
            let filename = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("aether-dossier.md")
                .to_string();
            let metadata = entry.metadata().await.ok();
            let rendered_at = metadata
                .and_then(|metadata| metadata.modified().ok())
                .map(|modified| {
                    DateTime::<Utc>::from(modified)
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                })
                .unwrap_or_else(now);
            let content = tokio::fs::read_to_string(&path).await.unwrap_or_default();
            files.push(AirRecentFile {
                title: air_frontmatter_value(&content, "title")
                    .unwrap_or_else(|| air_title_from_filename(&filename)),
                lens: air_frontmatter_value(&content, "aether_lens").unwrap_or_default(),
                source_count: air_frontmatter_value(&content, "source_count")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0),
                path: path.display().to_string(),
                filename,
                rendered_at,
            });
        }
    }
    files.sort_by(|left, right| right.rendered_at.cmp(&left.rendered_at));
    files.truncate(12);
    Ok(files)
}

pub(crate) fn air_frontmatter_value(markdown: &str, key: &str) -> Option<String> {
    let mut lines = markdown.lines();
    if lines.next()? != "---" {
        return None;
    }
    let prefix = format!("{key}:");
    for line in lines {
        if line == "---" {
            break;
        }
        if let Some(value) = line.strip_prefix(&prefix) {
            return Some(value.trim().trim_matches('"').replace("\\\"", "\""));
        }
    }
    None
}

pub(crate) fn air_dossier_filename(title: &str, generated_at: &str) -> String {
    let _ = generated_at;
    let filename = title
        .trim()
        .chars()
        .map(|char| match char {
            '/' | '\\' | '\0' => '-',
            char if char.is_control() => ' ',
            char => char,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(['.', ' '])
        .to_string();
    if filename.is_empty() {
        "AiR Dossier.md".to_string()
    } else {
        format!("{filename}.md")
    }
}

pub(crate) fn air_title_from_filename(filename: &str) -> String {
    filename
        .trim_end_matches(".md")
        .split('-')
        .filter(|part| !part.chars().all(|char| char.is_ascii_digit()))
        .take(8)
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn yaml_string(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace(['\n', '\r'], " ")
    )
}

pub(crate) fn markdown_escape(value: &str) -> String {
    strip_numeric_bracket_markers(value)
        .replace('\r', "")
        .trim()
        .to_string()
}

pub(crate) fn air_tags(lens: &str) -> Vec<String> {
    let mut tags = vec![
        "aether".to_string(),
        "air".to_string(),
        "dossier".to_string(),
    ];
    for word in lens
        .split(|char: char| !char.is_alphanumeric())
        .filter(|word| word.chars().count() >= 3)
        .take(4)
    {
        tags.push(word.to_lowercase());
    }
    tags.sort();
    tags.dedup();
    tags
}

pub(crate) fn air_lens_label(kind: AirLensKind) -> &'static str {
    match kind {
        AirLensKind::Topic => "topic",
        AirLensKind::Flow => "Flow",
        AirLensKind::Hub => "hub",
        AirLensKind::Answer => "AiON answer",
        AirLensKind::Iceberg => "iCE",
    }
}

pub(crate) fn normalize_model_markdown_citations(markdown: &str, source_count: usize) -> String {
    normalize_answer_citations(&clean_model_output(markdown), source_count)
}
