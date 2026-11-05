use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use encoding_rs::{Encoding, GB18030, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252};
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use serde::Serialize;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, StandardTagKey};
use symphonia::core::probe::Hint;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LyricWord {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub text: String,
    pub translation: Option<String>,
    pub words: Vec<LyricWord>,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LyricDoc {
    pub source: String,
    pub format: String,
    pub encoding: String,
    pub synced: bool,
    pub offset_ms: i64,
    pub lines: Vec<LyricLine>,
}

const EXTERNAL_FORMATS: &[&str] = &["lrc", "srt", "ttml", "ass"];

fn find_external(audio: &Path) -> Option<(PathBuf, String)> {
    let directory = audio.parent()?;
    let stem = audio.file_stem()?.to_str()?;

    for extension in ["lrc", "srt", "ttml", "ass"] {
        for candidate in [extension.to_string(), extension.to_uppercase()] {
            let path = directory.join(format!("{stem}.{candidate}"));
            if path.is_file() {
                return Some((path, extension.to_string()));
            }
        }
    }

    let entries = fs::read_dir(directory).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(candidate_stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !candidate_stem.eq_ignore_ascii_case(stem) {
            continue;
        }
        let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        let extension = extension.to_ascii_lowercase();
        if EXTERNAL_FORMATS.contains(&extension.as_str()) {
            return Some((path, extension));
        }
    }

    None
}

pub(crate) fn decode_text(bytes: &[u8], requested: Option<&str>) -> Result<(String, String), String> {
    if let Some(label) = requested {
        let encoding = Encoding::for_label(label.as_bytes())
            .ok_or_else(|| format!("未知歌词编码: {label}"))?;
        let (text, _, _) = encoding.decode(bytes);
        return Ok((text.into_owned(), encoding.name().to_string()));
    }

    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (text, _, _) = UTF_8.decode(&bytes[3..]);
        return Ok((text.into_owned(), "utf-8".to_string()));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = UTF_16LE.decode(&bytes[2..]);
        return Ok((text.into_owned(), "utf-16le".to_string()));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = UTF_16BE.decode(&bytes[2..]);
        return Ok((text.into_owned(), "utf-16be".to_string()));
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok((text.to_string(), "utf-8".to_string()));
    }

    let (text, _, _) = GB18030.decode(bytes);
    Ok((text.into_owned(), "gb18030".to_string()))
}

fn parse_clock(value: &str) -> Option<f64> {
    let value = value.trim().replace(',', ".");
    let parts: Vec<&str> = value.split(':').collect();
    match parts.as_slice() {
        [minutes, seconds] => {
            let minutes: f64 = minutes.trim().parse().ok()?;
            let seconds: f64 = seconds.trim().parse().ok()?;
            Some(minutes * 60.0 + seconds)
        }
        [hours, minutes, seconds] => {
            let hours: f64 = hours.trim().parse().ok()?;
            let minutes: f64 = minutes.trim().parse().ok()?;
            let seconds: f64 = seconds.trim().parse().ok()?;
            Some(hours * 3600.0 + minutes * 60.0 + seconds)
        }
        _ => None,
    }
}

fn split_word_tags(text: &str) -> (String, Vec<(f64, String)>) {
    let mut tags: Vec<(f64, usize, usize)> = Vec::new();
    let mut search = 0;
    while let Some(relative) = text[search..].find('<') {
        let open = search + relative;
        let Some(close_relative) = text[open + 1..].find('>') else {
            break;
        };
        let close = open + 1 + close_relative;
        if let Some(start) = parse_clock(&text[open + 1..close]) {
            tags.push((start, open, close + 1));
        }
        search = close + 1;
    }

    if tags.is_empty() {
        return (text.to_string(), Vec::new());
    }

    let mut cleaned = String::new();
    cleaned.push_str(&text[..tags[0].1]);
    let mut words = Vec::new();
    for (index, (start, _, tag_end)) in tags.iter().enumerate() {
        let segment_end = tags
            .get(index + 1)
            .map(|next| next.1)
            .unwrap_or(text.len());
        let segment = &text[*tag_end..segment_end];
        cleaned.push_str(segment);
        if !segment.trim().is_empty() {
            words.push((*start, segment.to_string()));
        }
    }

    (cleaned, words)
}

fn plain_doc(text: String, source: &str, format: &str, encoding: &str) -> LyricDoc {
    let lines = text
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|line| LyricLine {
            text: line.to_string(),
            ..Default::default()
        })
        .collect();

    LyricDoc {
        source: source.to_string(),
        format: format.to_string(),
        encoding: encoding.to_string(),
        synced: false,
        offset_ms: 0,
        lines,
    }
}

fn parse_lrc(text: &str, source: String, encoding: String) -> LyricDoc {
    let mut offset_ms = 0i64;
    let mut timestamped: Vec<(f64, String)> = Vec::new();
    let mut plain: Vec<String> = Vec::new();

    for raw_line in text.lines() {
        let mut rest = raw_line.trim();
        if rest.is_empty() {
            continue;
        }

        let mut stamps = Vec::new();
        loop {
            let trimmed = rest.trim_start();
            if !trimmed.starts_with('[') {
                rest = trimmed;
                break;
            }
            let Some(close) = trimmed.find(']') else {
                break;
            };
            let inside = &trimmed[1..close];
            rest = &trimmed[close + 1..];

            if let Some(value) = inside.strip_prefix("offset:") {
                if let Ok(parsed) = value.trim().parse::<i64>() {
                    offset_ms = parsed;
                }
                continue;
            }
            if let Some(stamp) = parse_clock(inside) {
                stamps.push(stamp);
            }
        }

        let content = rest.trim();
        if content.is_empty() {
            continue;
        }

        if stamps.is_empty() {
            plain.push(content.to_string());
        } else {
            for stamp in stamps {
                timestamped.push((stamp, content.to_string()));
            }
        }
    }

    if timestamped.is_empty() {
        let mut document = plain_doc(plain.join("\n"), &source, "lrc", &encoding);
        document.offset_ms = offset_ms;
        return document;
    }

    timestamped.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let entries: Vec<(f64, String, Vec<(f64, String)>)> = timestamped
        .into_iter()
        .map(|(start, text)| {
            let (cleaned, words) = split_word_tags(&text);
            (start, cleaned, words)
        })
        .collect();

    let mut raw_lines: Vec<(f64, String, Vec<(f64, String)>, Option<String>)> = Vec::new();
    let mut index = 0;
    while index < entries.len() {
        let start = entries[index].0;
        let mut end = index + 1;
        while end < entries.len() && (entries[end].0 - start).abs() < 0.05 {
            end += 1;
        }
        let translation = if end > index + 1 {
            let joined = entries[index + 1..end]
                .iter()
                .map(|entry| entry.1.clone())
                .filter(|line| !line.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            if joined.is_empty() {
                None
            } else {
                Some(joined)
            }
        } else {
            None
        };
        raw_lines.push((
            start,
            entries[index].1.clone(),
            entries[index].2.clone(),
            translation,
        ));
        index = end;
    }

    let mut lines = Vec::new();
    let count = raw_lines.len();
    for line_index in 0..count {
        let (start, text, words, translation) = &raw_lines[line_index];
        let end = raw_lines
            .get(line_index + 1)
            .map(|next| next.0)
            .unwrap_or(start + 5.0)
            .max(*start);

        let mut word_list = Vec::new();
        for (word_index, (word_start, word_text)) in words.iter().enumerate() {
            let word_end = words
                .get(word_index + 1)
                .map(|next| next.0)
                .unwrap_or(end)
                .clamp(*word_start, end);
            word_list.push(LyricWord {
                start: *word_start,
                end: word_end,
                text: word_text.clone(),
            });
        }

        lines.push(LyricLine {
            start: Some(*start),
            end: Some(end),
            text: text.clone(),
            translation: translation.clone(),
            words: word_list,
        });
    }

    LyricDoc {
        source,
        format: "lrc".to_string(),
        encoding,
        synced: true,
        offset_ms,
        lines,
    }
}

fn parse_srt(text: &str, source: String, encoding: String) -> LyricDoc {
    let normalized = text.replace("\r\n", "\n");
    let mut lines = Vec::new();

    for block in normalized.split("\n\n") {
        let block_lines: Vec<&str> = block
            .lines()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .collect();
        if block_lines.len() < 2 {
            continue;
        }
        let Some(time_index) = block_lines.iter().position(|line| line.contains("-->")) else {
            continue;
        };
        let Some((start, end)) = block_lines[time_index].split_once("-->") else {
            continue;
        };
        let (Some(start), Some(end)) = (parse_clock(start), parse_clock(end)) else {
            continue;
        };
        let content = &block_lines[time_index + 1..];
        if content.is_empty() {
            continue;
        }
        let (text, translation) = if content.len() > 1 {
            (content[0].to_string(), Some(content[1..].join("\n")))
        } else {
            (content[0].to_string(), None)
        };
        lines.push(LyricLine {
            start: Some(start),
            end: Some(end),
            text,
            translation,
            words: Vec::new(),
        });
    }

    let mut document = LyricDoc {
        source,
        format: "srt".to_string(),
        encoding,
        synced: !lines.is_empty(),
        offset_ms: 0,
        lines,
    };
    document
        .lines
        .sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    document
}

fn normalize_text(text: &str) -> String {
    let mut output = String::new();
    let mut last_space = false;
    for ch in text.chars() {
        if ch == '\n' {
            output.push('\n');
            last_space = true;
        } else if ch.is_whitespace() {
            if !last_space {
                output.push(' ');
                last_space = true;
            }
        } else {
            output.push(ch);
            last_space = false;
        }
    }
    output.trim().to_string()
}

fn normalize_word_text(text: &str) -> String {
    let core = normalize_text(text);
    if core.is_empty() {
        return if text.chars().any(|ch| ch.is_whitespace()) {
            " ".to_string()
        } else {
            String::new()
        };
    }
    let leading = text.chars().next().map(char::is_whitespace).unwrap_or(false);
    let trailing = text.chars().last().map(char::is_whitespace).unwrap_or(false);
    let mut output = String::new();
    if leading {
        output.push(' ');
    }
    output.push_str(&core);
    if trailing {
        output.push(' ');
    }
    output
}

fn parse_ttml_time(value: &str, relative_to: Option<f64>) -> Option<f64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    let base = if let Some(number) = lower.strip_suffix("ms") {
        number.trim().parse::<f64>().ok()? / 1000.0
    } else if let Some(number) = lower.strip_suffix('s') {
        number.trim().parse::<f64>().ok()?
    } else if let Some(number) = lower.strip_suffix('m') {
        number.trim().parse::<f64>().ok()? * 60.0
    } else if let Some(number) = lower.strip_suffix('h') {
        number.trim().parse::<f64>().ok()? * 3600.0
    } else {
        let lowered = lower.replace(',', ".");
        let parts: Vec<&str> = lowered.split(':').collect();
        match parts.as_slice() {
            [minutes, seconds] => {
                let minutes: f64 = minutes.trim().parse().ok()?;
                let seconds: f64 = seconds.trim().parse().ok()?;
                minutes * 60.0 + seconds
            }
            [hours, minutes, seconds] => {
                let hours: f64 = hours.trim().parse().ok()?;
                let minutes: f64 = minutes.trim().parse().ok()?;
                let seconds: f64 = seconds.trim().parse().ok()?;
                hours * 3600.0 + minutes * 60.0 + seconds
            }
            [hours, minutes, seconds, frames] => {
                let hours: f64 = hours.trim().parse().ok()?;
                let minutes: f64 = minutes.trim().parse().ok()?;
                let seconds: f64 = seconds.trim().parse().ok()?;
                let frames: f64 = frames.trim().parse().ok()?;
                hours * 3600.0 + minutes * 60.0 + seconds + frames / 30.0
            }
            _ => return None,
        }
    };
    Some(base + relative_to.unwrap_or(0.0))
}

fn ttml_begin(value: &str, parent_start: Option<f64>) -> Option<f64> {
    if value.contains(':') {
        parse_ttml_time(value, None)
    } else {
        parse_ttml_time(value, parent_start)
    }
}

fn ttml_end(value: &str, parent_start: Option<f64>, begin: Option<f64>) -> Option<f64> {
    let end = ttml_begin(value, parent_start);
    match (end, begin) {
        (Some(end), Some(begin)) if end >= begin => Some(end),
        _ => end,
    }
}

fn xml_attr(element: &BytesStart<'_>, name: &str) -> Option<String> {
    element
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.local_name().as_ref() == name)
        .and_then(|attribute| {
            attribute
                .normalized_value(XmlVersion::Implicit1_0)
                .ok()
        })
        .map(|value| value.into_owned())
}

struct TtmlSpan {
    start: Option<f64>,
    end: Option<f64>,
    text: String,
}

struct TtmlLineState {
    start: Option<f64>,
    end: Option<f64>,
    text: String,
    spans: Vec<TtmlSpan>,
    words: Vec<LyricWord>,
}

fn finish_ttml_line(state: TtmlLineState, lines: &mut Vec<LyricLine>) {
    let text = normalize_text(&state.text);
    if text.is_empty() {
        return;
    }
    let mut words = state.words;
    words.retain(|word| !word.text.trim().is_empty());
    lines.push(LyricLine {
        start: state.start,
        end: state.end,
        text,
        translation: None,
        words,
    });
}

fn parse_ttml(text: &str, source: String, encoding: String) -> LyricDoc {
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(false);
    let mut lines: Vec<LyricLine> = Vec::new();
    let mut current: Option<TtmlLineState> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                let name = element.name();
                let local = name.local_name();
                match local.as_ref() {
                    "p" => {
                        if let Some(state) = current.take() {
                            finish_ttml_line(state, &mut lines);
                        }
                        let begin = xml_attr(&element, "begin")
                            .and_then(|value| ttml_begin(&value, Some(0.0)));
                        let end = xml_attr(&element, "end")
                            .and_then(|value| ttml_end(&value, Some(0.0), begin))
                            .or_else(|| {
                                xml_attr(&element, "dur")
                                    .and_then(|value| parse_ttml_time(&value, None))
                                    .map(|duration| begin.unwrap_or(0.0) + duration)
                            });
                        current = Some(TtmlLineState {
                            start: begin,
                            end,
                            text: String::new(),
                            spans: Vec::new(),
                            words: Vec::new(),
                        });
                    }
                    "span" => {
                        if let Some(state) = current.as_mut() {
                            let parent = state.start;
                            let begin = xml_attr(&element, "begin")
                                .and_then(|value| ttml_begin(&value, parent));
                            let end = xml_attr(&element, "end")
                                .and_then(|value| ttml_end(&value, parent, begin))
                                .or_else(|| {
                                    xml_attr(&element, "dur")
                                        .and_then(|value| parse_ttml_time(&value, None))
                                        .map(|duration| begin.unwrap_or(0.0) + duration)
                                });
                            state.spans.push(TtmlSpan {
                                start: begin,
                                end,
                                text: String::new(),
                            });
                        }
                    }
                    "br" => {
                        if let Some(state) = current.as_mut() {
                            state.text.push('\n');
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(element)) => {
                let value = element.xml_content(XmlVersion::Implicit1_0).into_owned();
                if let Some(state) = current.as_mut() {
                    state.text.push_str(&value);
                    if let Some(span) = state.spans.last_mut() {
                        span.text.push_str(&value);
                    }
                }
            }
            Ok(Event::CData(element)) => {
                let value = element.xml_content(XmlVersion::Implicit1_0).into_owned();
                if let Some(state) = current.as_mut() {
                    state.text.push_str(&value);
                    if let Some(span) = state.spans.last_mut() {
                        span.text.push_str(&value);
                    }
                }
            }
            Ok(Event::End(element)) => {
                let name = element.name();
                match name.local_name().as_ref() {
                    "span" => {
                        if let Some(state) = current.as_mut() {
                            if let Some(span) = state.spans.pop() {
                                let start = span.start.or_else(|| {
                                    if span.end.is_some() {
                                        state
                                            .words
                                            .last()
                                            .map(|word| word.end)
                                            .or(state.start)
                                    } else {
                                        None
                                    }
                                });
                                if let Some(start) = start {
                                    let text = normalize_word_text(&span.text);
                                    if !text.trim().is_empty() {
                                        state.words.push(LyricWord {
                                            start,
                                            end: span.end.unwrap_or(start),
                                            text,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    "p" => {
                        if let Some(state) = current.take() {
                            finish_ttml_line(state, &mut lines);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }

    if let Some(state) = current.take() {
        finish_ttml_line(state, &mut lines);
    }

    finalize_timed_lines(lines, "ttml", source, encoding)
}

fn ass_karaoke_duration(block: &str) -> Option<f64> {
    let bytes = block.as_bytes();
    let mut index = 0;
    let mut total = 0.0;
    let mut found = false;
    while index + 1 < bytes.len() {
        if bytes[index] == b'\\' && matches!(bytes[index + 1], b'k' | b'K') {
            let mut cursor = index + 2;
            if cursor < bytes.len() && matches!(bytes[cursor], b'f' | b'o' | b'F' | b'O') {
                cursor += 1;
            }
            let digits = cursor;
            while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                cursor += 1;
            }
            if cursor > digits {
                if let Ok(centiseconds) = block[digits..cursor].parse::<f64>() {
                    total += centiseconds / 100.0;
                    found = true;
                }
            }
            index = cursor;
            continue;
        }
        index += 1;
    }
    found.then_some(total)
}

fn parse_ass_text(text: &str, line_start: f64) -> (String, Vec<LyricWord>) {
    let mut cleaned = String::new();
    let mut words: Vec<LyricWord> = Vec::new();
    let mut cursor = 0;
    let mut current_time = line_start;
    let mut word_start = line_start;
    let mut word_text = String::new();
    let mut pending: Option<f64> = None;
    let bytes = text.as_bytes();

    while cursor < bytes.len() {
        let ch = text[cursor..].chars().next().unwrap_or('\0');
        if ch == '{' {
            if let Some(relative) = text[cursor + 1..].find('}') {
                let end = cursor + 1 + relative;
                if let Some(duration) = ass_karaoke_duration(&text[cursor + 1..end]) {
                    if pending.is_some() && !word_text.trim().is_empty() {
                        let word_end = word_start + pending.unwrap_or(0.0);
                        words.push(LyricWord {
                            start: word_start,
                            end: word_end,
                            text: word_text.clone(),
                        });
                        current_time = word_end;
                    }
                    word_text.clear();
                    word_start = current_time;
                    pending = Some(duration);
                }
                cursor = end + 1;
                continue;
            }
        }
        if ch == '\\' {
            let next = text[cursor + 1..].chars().next();
            match next {
                Some('N') | Some('n') => {
                    cleaned.push('\n');
                    if pending.is_some() {
                        word_text.push('\n');
                    }
                }
                Some('h') => {
                    cleaned.push(' ');
                    if pending.is_some() {
                        word_text.push(' ');
                    }
                }
                _ => {}
            }
            cursor += 1 + next.map(|value| value.len_utf8()).unwrap_or(0);
            continue;
        }
        cleaned.push(ch);
        if pending.is_some() {
            word_text.push(ch);
        }
        cursor += ch.len_utf8();
    }

    if let Some(duration) = pending {
        if !word_text.trim().is_empty() {
            words.push(LyricWord {
                start: word_start,
                end: word_start + duration,
                text: word_text,
            });
        }
    }

    (normalize_text(&cleaned), words)
}

fn parse_ass(text: &str, source: String, encoding: String) -> LyricDoc {
    let mut in_events = false;
    let mut format: Vec<String> = vec![
        "Layer".to_string(),
        "Start".to_string(),
        "End".to_string(),
        "Style".to_string(),
        "Name".to_string(),
        "MarginL".to_string(),
        "MarginR".to_string(),
        "MarginV".to_string(),
        "Effect".to_string(),
        "Text".to_string(),
    ];
    let mut lines: Vec<LyricLine> = Vec::new();

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            in_events = line.eq_ignore_ascii_case("[Events]");
            continue;
        }
        if !in_events {
            continue;
        }
        if line
            .get(..7)
            .map(|prefix| prefix.eq_ignore_ascii_case("Format:"))
            .unwrap_or(false)
        {
            format = line[7..]
                .split(',')
                .map(|item| item.trim().to_string())
                .collect();
            continue;
        }
        if !line
            .get(..9)
            .map(|prefix| prefix.eq_ignore_ascii_case("Dialogue:"))
            .unwrap_or(false)
        {
            continue;
        }

        let fields: Vec<&str> = line[9..].splitn(format.len(), ',').collect();
        let field = |name: &str| {
            format
                .iter()
                .position(|item| item.eq_ignore_ascii_case(name))
                .and_then(|index| fields.get(index).copied())
                .unwrap_or("")
        };
        let (Some(start), Some(end)) = (parse_clock(field("Start")), parse_clock(field("End"))) else {
            continue;
        };
        let text = field("Text");
        if text.trim().is_empty() {
            continue;
        }
        let (cleaned, mut words) = parse_ass_text(text, start);
        if cleaned.is_empty() {
            continue;
        }
        let line_end = end.max(start);
        for word in words.iter_mut() {
            word.end = word.end.clamp(word.start, line_end);
        }
        lines.push(LyricLine {
            start: Some(start),
            end: Some(line_end),
            text: cleaned,
            translation: None,
            words,
        });
    }

    finalize_timed_lines(lines, "ass", source, encoding)
}

fn finalize_timed_lines(
    mut lines: Vec<LyricLine>,
    format: &str,
    source: String,
    encoding: String,
) -> LyricDoc {
    lines.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut merged: Vec<LyricLine> = Vec::new();
    for line in lines {
        if let Some(previous) = merged.last_mut() {
            let same_start = match (previous.start, line.start) {
                (Some(a), Some(b)) => (a - b).abs() < 0.05,
                _ => false,
            };
            if same_start && previous.translation.is_none() && previous.text != line.text {
                previous.translation = Some(line.text);
                continue;
            }
        }
        merged.push(line);
    }

    let count = merged.len();
    for index in 0..count {
        let line_end = merged[index]
            .end
            .or_else(|| merged.get(index + 1).and_then(|next| next.start))
            .or_else(|| merged[index].start.map(|start| start + 5.0));
        merged[index].end = line_end;
        if !merged[index].words.is_empty() {
            let end = line_end.unwrap_or(0.0);
            let words_len = merged[index].words.len();
            for word_index in 0..words_len {
                let next_start = merged[index]
                    .words
                    .get(word_index + 1)
                    .map(|next| next.start);
                let word = &mut merged[index].words[word_index];
                if word.end > word.start {
                    continue;
                }
                word.end = next_start.unwrap_or(end).max(word.start);
            }
        }
    }

    let synced = merged.iter().any(|line| line.start.is_some());
    LyricDoc {
        source,
        format: format.to_string(),
        encoding,
        synced,
        offset_ms: 0,
        lines: merged,
    }
}

fn synchsafe(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .take(4)
        .fold(0usize, |value, byte| (value << 7) | (byte & 0x7f) as usize)
}

fn be_u32(bytes: &[u8]) -> u32 {
    bytes
        .iter()
        .take(4)
        .fold(0u32, |value, byte| (value << 8) | *byte as u32)
}

fn synchronise_removal(bytes: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        output.push(bytes[index]);
        if bytes[index] == 0xFF && bytes.get(index + 1) == Some(&0x00) {
            index += 2;
        } else {
            index += 1;
        }
    }
    output
}

fn find_sylt_frame(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 10 || &bytes[..3] != b"ID3" {
        return None;
    }
    let version = bytes[3];
    let flags = bytes[5];
    let size = synchsafe(&bytes[6..10]);
    let end = (10 + size).min(bytes.len());
    let raw_tag = &bytes[10..end];
    let owned = (flags & 0x80 != 0).then(|| synchronise_removal(raw_tag));
    let tag = owned.as_deref().unwrap_or(raw_tag);

    let mut position = 0;
    if version >= 3 && flags & 0x40 != 0 {
        if tag.len() < 4 {
            return None;
        }
        let extended = if version >= 4 {
            synchsafe(&tag[..4])
        } else {
            be_u32(&tag[..4]) as usize + 4
        };
        position = extended.min(tag.len());
    }

    while position < tag.len() {
        let (id, frame_size, header_size, frame_flags) = if version <= 2 {
            if position + 6 > tag.len() {
                break;
            }
            let id = &tag[position..position + 3];
            let size = ((tag[position + 3] as usize) << 16)
                | ((tag[position + 4] as usize) << 8)
                | tag[position + 5] as usize;
            (id.to_vec(), size, 6usize, 0u16)
        } else {
            if position + 10 > tag.len() {
                break;
            }
            let id = &tag[position..position + 4];
            let size = if version >= 4 {
                synchsafe(&tag[position + 4..position + 8])
            } else {
                be_u32(&tag[position + 4..position + 8]) as usize
            };
            let frame_flags = ((tag[position + 8] as u16) << 8) | tag[position + 9] as u16;
            (id.to_vec(), size, 10usize, frame_flags)
        };

        if id.iter().all(|byte| *byte == 0) {
            break;
        }
        if position + header_size + frame_size > tag.len() {
            break;
        }
        let payload = &tag[position + header_size..position + header_size + frame_size];
        if (version <= 2 && &id == b"SLT") || (version >= 3 && &id == b"SYLT") {
            let unreadable = if version >= 4 {
                frame_flags & 0x000C != 0
            } else {
                frame_flags & 0x00C0 != 0
            };
            if unreadable {
                return None;
            }
            let grouped = (version == 3 && frame_flags & 0x0020 != 0)
                || (version >= 4 && frame_flags & 0x0040 != 0);
            let has_data_length = version >= 4 && frame_flags & 0x0001 != 0;
            let mut offset = 0usize;
            if grouped {
                offset += 1;
            }
            if has_data_length {
                offset += 4;
            }
            let payload = payload.get(offset..).unwrap_or_default();
            return Some(if version >= 4 && frame_flags & 0x0002 != 0 {
                synchronise_removal(payload)
            } else {
                payload.to_vec()
            });
        }
        position += header_size + frame_size;
    }

    None
}

fn find_terminator(bytes: &[u8], encoding: u8) -> Option<(usize, usize)> {
    if encoding == 1 || encoding == 2 {
        let mut index = 0;
        while index + 1 < bytes.len() {
            if bytes[index] == 0 && bytes[index + 1] == 0 {
                return Some((index, 2));
            }
            index += 2;
        }
        None
    } else {
        bytes
            .iter()
            .position(|byte| *byte == 0)
            .map(|index| (index, 1))
    }
}

fn decode_sylt_text(bytes: &[u8], encoding: u8) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let (text, _, _) = match encoding {
        0 => WINDOWS_1252.decode(bytes),
        1 => {
            if bytes.starts_with(&[0xFE, 0xFF]) {
                UTF_16BE.decode(&bytes[2..])
            } else if bytes.starts_with(&[0xFF, 0xFE]) {
                UTF_16LE.decode(&bytes[2..])
            } else {
                UTF_16LE.decode(bytes)
            }
        }
        2 => UTF_16BE.decode(bytes),
        _ => UTF_8.decode(bytes),
    };
    text.into_owned()
}

fn parse_sylt_payload(payload: &[u8], sample_rate: Option<u32>) -> Option<LyricDoc> {
    if payload.len() < 6 {
        return None;
    }
    let encoding = payload[0];
    let timestamp_format = payload[4];
    let content_type = payload[5];
    if !matches!(timestamp_format, 1 | 2) || content_type != 1 {
        return None;
    }

    let mut rest = &payload[6..];
    let (descriptor_end, terminator) = find_terminator(rest, encoding)?;
    rest = &rest[descriptor_end + terminator..];

    let mut entries: Vec<(f64, String)> = Vec::new();
    while !rest.is_empty() {
        let Some((text_end, terminator)) = find_terminator(rest, encoding) else {
            break;
        };
        let text = decode_sylt_text(&rest[..text_end], encoding);
        rest = &rest[text_end + terminator..];
        if rest.len() < 4 {
            break;
        }
        let stamp = be_u32(&rest[..4]);
        rest = &rest[4..];

        let seconds = if timestamp_format == 2 {
            stamp as f64 / 1000.0
        } else {
            let rate = sample_rate.unwrap_or(44_100) as f64;
            let samples_per_frame = if rate <= 24_000.0 { 576.0 } else { 1152.0 };
            stamp as f64 * samples_per_frame / rate
        };
        let text = text.replace('\r', "");
        if !text.trim().is_empty() {
            entries.push((seconds, text));
        }
    }

    if entries.is_empty() {
        return None;
    }

    let mut lines: Vec<LyricLine> = Vec::new();
    for (start, text) in entries {
        let continuation = lines.last().map(|line| {
            let line_end = line.end.unwrap_or_else(|| {
                line.words
                    .last()
                    .map(|word| word.end)
                    .unwrap_or_else(|| line.start.unwrap_or(0.0))
            });
            start - line_end <= 0.2
                && !text.contains('\n')
                && line.text.chars().count() + text.chars().count() <= 60
        });
        if continuation == Some(true) {
            let line = lines.last_mut().unwrap();
            let word_end = start + 0.3;
            line.words.push(LyricWord {
                start,
                end: word_end,
                text: text.clone(),
            });
            line.text.push_str(&text);
            line.end = Some(word_end);
        } else {
            lines.push(LyricLine {
                start: Some(start),
                end: None,
                text,
                translation: None,
                words: Vec::new(),
            });
        }
    }

    let encoding_label = match encoding {
        0 => "windows-1252",
        1 | 2 => "utf-16",
        _ => "utf-8",
    };
    Some(finalize_timed_lines(
        lines,
        "sylt",
        "内嵌 SYLT".to_string(),
        encoding_label.to_string(),
    ))
}

fn read_id3_prefix(path: &Path) -> Option<Vec<u8>> {
    let mut file = fs::File::open(path).ok()?;
    let mut header = [0u8; 10];
    file.read_exact(&mut header).ok()?;
    if &header[..3] == b"ID3" {
        let total = (10 + synchsafe(&header[6..10])).min(16 * 1024 * 1024);
        let mut bytes = vec![0u8; total];
        bytes[..10].copy_from_slice(&header);
        let mut filled = 10;
        while filled < total {
            match file.read(&mut bytes[filled..]) {
                Ok(0) | Err(_) => break,
                Ok(read) => filled += read,
            }
        }
        bytes.truncate(filled);
        return Some(bytes);
    }
    if &header[..4] == b"RIFF" {
        let total = be_u32(&header[4..8]) as usize;
        let mut bytes = vec![0u8; (8 + total).min(16 * 1024 * 1024)];
        bytes[..10].copy_from_slice(&header);
        let mut filled = 10;
        while filled < bytes.len() {
            match file.read(&mut bytes[filled..]) {
                Ok(0) | Err(_) => break,
                Ok(read) => filled += read,
            }
        }
        bytes.truncate(filled);
        let mut position = 12;
        while position + 8 <= bytes.len() {
            let id = &bytes[position..position + 4];
            let size = be_u32(&bytes[position + 4..position + 8]) as usize;
            let start = position + 8;
            let end = start.checked_add(size)?.min(bytes.len());
            if (id == b"id3 " || id == b"ID3 ") && bytes[start..end].starts_with(b"ID3") {
                return Some(bytes[start..end].to_vec());
            }
            position = start + size + (size & 1);
        }
    }
    None
}

fn probe_sample_rate(path: &Path) -> Option<u32> {
    let file = fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;
    probed
        .format
        .default_track()
        .and_then(|track| track.codec_params.sample_rate)
}

fn embedded_sylt(path: &Path) -> Option<LyricDoc> {
    let bytes = read_id3_prefix(path)?;
    let payload = find_sylt_frame(&bytes)?;
    parse_sylt_payload(&payload, probe_sample_rate(path))
}

fn embedded_lyrics(path: &Path) -> Result<Option<String>, String> {
    let file = fs::File::open(path).map_err(|e| format!("打开音频失败: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("无法识别音频格式: {e}"))?;
    let mut format = probed.format;

    if let Some(revision) = format.metadata().current() {
        for tag in revision.tags() {
            let known = matches!(tag.std_key, Some(StandardTagKey::Lyrics));
            let by_key = tag.key.eq_ignore_ascii_case("LYRICS")
                || tag.key.eq_ignore_ascii_case("UNSYNCEDLYRICS");
            if known || by_key {
                let text = tag.value.to_string();
                if !text.trim().is_empty() {
                    return Ok(Some(text));
                }
            }
        }
    }

    Ok(None)
}

#[tauri::command]
pub fn lyrics_get(
    path: String,
    encoding: Option<String>,
) -> Result<Option<LyricDoc>, String> {
    load_lyrics(&path, encoding.as_deref())
}

pub fn load_lyrics(path: &str, encoding: Option<&str>) -> Result<Option<LyricDoc>, String> {
    let audio = PathBuf::from(path);
    if !audio.is_file() {
        return Err(format!("音频文件不存在: {path}"));
    }

    if let Some((file, format)) = find_external(&audio) {
        let bytes = fs::read(&file).map_err(|e| format!("读取歌词失败: {e}"))?;
        let (text, detected) = decode_text(&bytes, encoding)?;
        let source = format!(
            "外置 {}",
            file.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("歌词")
        );
        return match format.as_str() {
            "lrc" => Ok(Some(parse_lrc(&text, source, detected))),
            "srt" => Ok(Some(parse_srt(&text, source, detected))),
            "ttml" => Ok(Some(parse_ttml(&text, source, detected))),
            "ass" => Ok(Some(parse_ass(&text, source, detected))),
            other => Err(format!(
                "暂不支持 .{other} 歌词格式，当前支持 LRC / SRT / TTML / ASS / SYLT / 内嵌歌词"
            )),
        };
    }

    if let Some(document) = embedded_sylt(&audio) {
        return Ok(Some(document));
    }

    match embedded_lyrics(&audio) {
        Ok(Some(text)) => Ok(Some(plain_doc(
            text,
            "内嵌歌词",
            "plain",
            "utf-8",
        ))),
        Ok(None) => Ok(None),
        Err(error) => {
            eprintln!("lyrics embedded error: {error}");
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ttml_karaoke_and_translation() {
        let text = r#"<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <body><div>
    <p begin="00:00:01.000" end="00:00:04.000">
      <span begin="00:00:01.000" end="00:00:02.000">Hello </span><span begin="00:00:02.000" end="00:00:04.000">world</span>
    </p>
    <p begin="00:00:01.000" end="00:00:04.000">你好</p>
    <p begin="00:00:04.000" end="00:00:06.000">World</p>
  </div></body>
</tt>"#;
        let document = parse_ttml(text, "ttml".into(), "utf-8".into());
        assert!(document.synced);
        assert_eq!(document.lines.len(), 2);
        assert_eq!(document.lines[0].text, "Hello world");
        assert_eq!(document.lines[0].translation.as_deref(), Some("你好"));
        assert_eq!(document.lines[0].words.len(), 2);
        assert_eq!(document.lines[0].words[0].text, "Hello ");
        assert_eq!(document.lines[0].words[1].text, "world");
        assert!((document.lines[0].words[0].start - 1.0).abs() < 1e-6);
        assert!((document.lines[0].words[1].start - 2.0).abs() < 1e-6);
        assert_eq!(document.lines[1].text, "World");
    }

    #[test]
    fn parses_ass_karaoke_tags() {
        let text = "[Script Info]\nTitle: test\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:05.00,Default,,0,0,0,,{\\k50}Hel{\\kf50}lo\nDialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,{\\k100}World\n";
        let document = parse_ass(text, "ass".into(), "utf-8".into());
        assert!(document.synced);
        assert_eq!(document.lines.len(), 2);
        assert_eq!(document.lines[0].text, "Hello");
        assert_eq!(document.lines[0].words.len(), 2);
        assert!((document.lines[0].words[0].start - 1.0).abs() < 1e-6);
        assert!((document.lines[0].words[0].end - 1.5).abs() < 1e-6);
        assert!((document.lines[0].words[1].start - 1.5).abs() < 1e-6);
        assert_eq!(document.lines[1].words.len(), 1);
        assert!((document.lines[1].words[0].end - 6.0).abs() < 1e-6);
    }

    fn synchsafe_bytes(value: usize) -> [u8; 4] {
        [
            ((value >> 21) & 0x7f) as u8,
            ((value >> 14) & 0x7f) as u8,
            ((value >> 7) & 0x7f) as u8,
            (value & 0x7f) as u8,
        ]
    }

    #[test]
    fn parses_sylt_frame() {
        let mut payload = Vec::new();
        payload.push(3u8);
        payload.extend_from_slice(b"eng");
        payload.push(2);
        payload.push(1);
        payload.extend_from_slice(b"Lyrics\0");
        payload.extend_from_slice(b"Hello\0");
        payload.extend_from_slice(&1000u32.to_be_bytes());
        payload.extend_from_slice(b"World\0");
        payload.extend_from_slice(&3000u32.to_be_bytes());

        let mut frame = Vec::new();
        frame.extend_from_slice(b"SYLT");
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(&[0, 0]);
        frame.extend_from_slice(&payload);

        let mut tag = Vec::new();
        tag.extend_from_slice(b"ID3");
        tag.extend_from_slice(&[3, 0, 0]);
        tag.extend_from_slice(&synchsafe_bytes(frame.len()));
        tag.extend_from_slice(&frame);

        let sylt = find_sylt_frame(&tag).expect("SYLT frame");
        let document = parse_sylt_payload(&sylt, Some(44_100)).expect("SYLT document");
        assert!(document.synced);
        assert_eq!(document.format, "sylt");
        assert_eq!(document.lines.len(), 2);
        assert_eq!(document.lines[0].text, "Hello");
        assert!((document.lines[0].start.unwrap() - 1.0).abs() < 1e-6);
        assert_eq!(document.lines[1].text, "World");
        assert!((document.lines[1].start.unwrap() - 3.0).abs() < 1e-6);
    }

    #[test]
    fn parses_ttml_duration_attribute() {
        let text = r#"<tt><body><div><p begin="1s" dur="2.5s">Hi</p></div></body></tt>"#;
        let document = parse_ttml(text, "ttml".into(), "utf-8".into());
        assert_eq!(document.lines.len(), 1);
        assert!((document.lines[0].start.unwrap() - 1.0).abs() < 1e-6);
        assert!((document.lines[0].end.unwrap() - 3.5).abs() < 1e-6);
    }

    #[test]
    fn parses_ttml_offset_time() {
        assert!((parse_ttml_time("2.5s", Some(10.0)).unwrap() - 12.5).abs() < 1e-6);
        assert!((parse_ttml_time("00:00:03.500", None).unwrap() - 3.5).abs() < 1e-6);
    }
}
