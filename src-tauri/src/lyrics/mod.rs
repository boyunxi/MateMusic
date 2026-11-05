use std::fs;
use std::path::{Path, PathBuf};

use encoding_rs::{Encoding, GB18030, UTF_16BE, UTF_16LE, UTF_8};
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
            other => Err(format!(
                "暂不支持 .{other} 歌词格式，当前支持 LRC / SRT / 内嵌歌词"
            )),
        };
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
