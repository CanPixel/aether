//! Chat prompt assembly and model-output cleanup.
//!
//! The cleanup half exists because a local model's raw output is not presentable:
//! it leaks stop markers, invents citation numbers past the source count, and
//! spaces brackets inconsistently.

use super::*;

pub(crate) fn chat_citation_limit() -> usize {
    if cfg!(mobile) {
        5
    } else {
        8
    }
}

pub(crate) fn chat_snippet_char_limit() -> usize {
    if cfg!(mobile) {
        1100
    } else {
        usize::MAX
    }
}

pub(crate) fn build_chat_messages(
    prompt: &str,
    citations: &[SearchResult],
    history: &[ConversationTurn],
) -> Vec<ChatPromptMessage> {
    let snippet_limit = chat_snippet_char_limit();
    let context_block = citations
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let mut source_text = strip_numeric_bracket_markers(&item.text);
            if source_text.chars().count() > snippet_limit {
                source_text = source_text.chars().take(snippet_limit).collect();
            }
            format!(
                "[{}] {}\nURL: {}\nCollection: {}\n{}",
                index + 1,
                item.title,
                item.url,
                item.collection_id,
                source_text
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let context = if context_block.is_empty() {
        "No stored context was retrieved."
    } else {
        &context_block
    };
    // Phones decode on CPU, so every generated token is user-visible latency:
    // steer the model toward tight answers instead of hard-truncating them.
    let brevity = if cfg!(mobile) {
        " Keep answers concise: a few sentences or a short list unless the question needs more."
    } else {
        ""
    };
    let mut messages = vec![ChatPromptMessage {
        role: "system",
        content: format!(
            "You are Æther, a private local research assistant. Answer only from the supplied local collection context. If the context is insufficient, say what is missing. Cite sources only with Æther source numbers [1] through [{}]. Do not copy bracketed reference numbers from webpage text.{brevity}",
            citations.len().max(1)
        ),
    }];

    // Prior turns come first so "what about that?" resolves, but each answer is
    // condensed: the citations for *this* question must stay the dominant context.
    for turn in history {
        messages.push(ChatPromptMessage {
            role: "user",
            content: turn.prompt.clone(),
        });
        messages.push(ChatPromptMessage {
            role: "assistant",
            content: condense_history_answer(&turn.answer),
        });
    }

    messages.push(ChatPromptMessage {
        role: "user",
        content: format!("Local collection context:\n{context}\n\nQuestion: {prompt}"),
    });
    messages
}

// Strips citation markers and clips length. Replaying markers from an old answer
// would let the model reuse source numbers that no longer refer to anything.
pub(crate) fn condense_history_answer(answer: &str) -> String {
    let cleaned = strip_numeric_bracket_markers(answer);
    let trimmed = cleaned.trim();
    if trimmed.chars().count() <= PROMPT_HISTORY_ANSWER_CHARS {
        return trimmed.to_string();
    }
    let mut condensed = trimmed
        .chars()
        .take(PROMPT_HISTORY_ANSWER_CHARS)
        .collect::<String>();
    condensed.push('…');
    condensed
}

pub(crate) fn render_model_chat_prompt(
    model: &LlamaModel,
    messages: &[ChatPromptMessage],
) -> Cmd<RenderedChatPrompt> {
    let template = match model.chat_template(None) {
        Ok(template) => template,
        Err(_) => {
            return Ok(RenderedChatPrompt {
                prompt: fallback_chat_prompt(messages),
                add_bos: AddBos::Never,
            })
        }
    };
    let chat = messages
        .iter()
        .map(|message| LlamaChatMessage::new(message.role.to_string(), message.content.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    match model.apply_chat_template(&template, &chat, true) {
        Ok(prompt) => Ok(RenderedChatPrompt {
            prompt,
            add_bos: AddBos::Never,
        }),
        Err(_) => Ok(RenderedChatPrompt {
            prompt: fallback_chat_prompt(messages),
            add_bos: AddBos::Never,
        }),
    }
}

pub(crate) fn fallback_chat_prompt(messages: &[ChatPromptMessage]) -> String {
    let mut prompt = String::from("<bos>");
    let mut system_messages = Vec::new();

    for message in messages {
        match message.role {
            "system" | "developer" => {
                system_messages.push(message.content.trim().to_string());
            }
            "assistant" => {
                prompt.push_str("<|turn>model\n");
                prompt.push_str(message.content.trim());
                prompt.push_str("<turn|>\n");
            }
            "user" => {
                if !system_messages.is_empty() {
                    prompt.push_str("<|turn>system\n");
                    prompt.push_str(&system_messages.join("\n\n"));
                    prompt.push_str("<turn|>\n");
                    system_messages.clear();
                }
                prompt.push_str("<|turn>user\n");
                prompt.push_str(message.content.trim());
                prompt.push_str("<turn|>\n");
            }
            role => {
                prompt.push_str("<|turn>");
                prompt.push_str(role);
                prompt.push('\n');
                prompt.push_str(message.content.trim());
                prompt.push_str("<turn|>\n");
            }
        }
    }

    if !system_messages.is_empty() {
        prompt.push_str("<|turn>system\n");
        prompt.push_str(&system_messages.join("\n\n"));
        prompt.push_str("<turn|>\n");
    }

    prompt.push_str("<|turn>model\n");
    prompt
}

// Streaming deltas hold back a short tail starting at the most recent '<' so a
// stop marker arriving across several tokens is never shown to the user.
pub(crate) fn stream_safe_len(output: &str) -> usize {
    let tail_start = output.len().saturating_sub(18);
    let Some((boundary, _)) = output
        .char_indices()
        .find(|(index, _)| *index >= tail_start)
    else {
        return output.len();
    };
    match output[boundary..].rfind('<') {
        Some(position) => boundary + position,
        None => output.len(),
    }
}

pub(crate) fn contains_stop_marker(output: &str) -> bool {
    output.contains("<end_of_turn>")
        || output.contains("<start_of_turn>")
        || output.contains("<turn|>")
        || output.contains("<|turn>")
        || output.contains("<|eot_id|>")
        || output.contains("<|end|>")
}

pub(crate) fn clean_model_output(output: &str) -> String {
    let mut cleaned = output.to_string();
    for marker in [
        "<end_of_turn>",
        "<start_of_turn>model",
        "<start_of_turn>assistant",
        "<start_of_turn>",
        "<turn|>",
        "<|turn>model",
        "<|turn>assistant",
        "<|turn>user",
        "<|turn>system",
        "<|turn>",
        "<|eot_id|>",
        "<|end|>",
    ] {
        cleaned = cleaned.replace(marker, "");
    }
    cleaned.trim().to_string()
}

pub(crate) fn normalize_answer_citations(answer: &str, citation_count: usize) -> String {
    tidy_citation_spacing(&rewrite_numeric_bracket_markers(
        answer,
        citation_count,
        true,
    ))
}

pub(crate) fn strip_numeric_bracket_markers(text: &str) -> String {
    rewrite_numeric_bracket_markers(text, 0, false)
}

pub(crate) fn rewrite_numeric_bracket_markers(
    text: &str,
    citation_count: usize,
    keep_valid: bool,
) -> String {
    let mut rewritten = String::with_capacity(text.len());
    let mut cursor = 0usize;

    while let Some(relative_start) = text[cursor..].find('[') {
        let start = cursor + relative_start;
        let Some(relative_end) = text[start + 1..].find(']') else {
            break;
        };
        let end = start + 1 + relative_end;
        let inner = &text[start + 1..end];
        let Some(numbers) = parse_numeric_citation_marker(inner) else {
            rewritten.push_str(&text[cursor..=start]);
            cursor = start + 1;
            continue;
        };

        rewritten.push_str(&text[cursor..start]);
        if keep_valid {
            let valid = numbers
                .into_iter()
                .filter(|number| *number > 0 && *number <= citation_count)
                .map(|number| number.to_string())
                .collect::<Vec<_>>();
            if !valid.is_empty() {
                rewritten.push('[');
                rewritten.push_str(&valid.join(", "));
                rewritten.push(']');
            }
        }
        cursor = end + 1;
    }

    rewritten.push_str(&text[cursor..]);
    rewritten
}

pub(crate) fn parse_numeric_citation_marker(value: &str) -> Option<Vec<usize>> {
    if value.trim().is_empty()
        || !value.chars().all(|character| {
            character.is_ascii_digit() || character == ',' || character.is_whitespace()
        })
    {
        return None;
    }

    let mut numbers = Vec::new();
    for part in value.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return None;
        }
        let number = part.parse::<usize>().ok()?;
        numbers.push(number);
    }
    (!numbers.is_empty()).then_some(numbers)
}

pub(crate) fn tidy_citation_spacing(value: &str) -> String {
    let mut tidied = value.trim().to_string();
    for (from, to) in [
        (" .", "."),
        (" ,", ","),
        (" ;", ";"),
        (" :", ":"),
        (" !", "!"),
        (" ?", "?"),
        (" )", ")"),
        ("( ", "("),
    ] {
        tidied = tidied.replace(from, to);
    }
    while tidied.contains("  ") {
        tidied = tidied.replace("  ", " ");
    }
    tidied
}
