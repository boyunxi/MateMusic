use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, StandardTagKey, StandardVisualKey};
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use super::{cue, db, now_secs, path_string, ScanStatus};
use crate::lyrics::decode_text;

const AUDIO_EXTENSIONS: &[&str] = &[
    "flac", "mp3", "m4a", "mp4", "aac", "ogg", "opus", "wav", "aiff", "aif", "alac", "ape",
    "wma", "dsf", "dff", "wv",
];

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("未知曲目")
        .to_string()
}

fn parse_number(value: &str) -> Option<u32> {
    value
        .trim()
        .split(['/', ' '])
        .next()
        .and_then(|part| part.parse::<u32>().ok())
}

fn parse_year(value: &str) -> Option<u32> {
    let digits: String = value
        .chars()
        .filter(|c| c.is_ascii_digit())
        .take(4)
        .collect();
    digits.parse::<u32>().ok()
}

struct Parsed {
    title: String,
    artist: Option<String>,
    album: Option<String>,
    album_artist: Option<String>,
    track_no: Option<u32>,
    disc_no: Option<u32>,
    year: Option<u32>,
    genre: Option<String>,
    duration: f64,
    codec: String,
    sample_rate: Option<u32>,
    bits: Option<u32>,
    channels: Option<u32>,
    bitrate: Option<u32>,
    cover: Option<(Vec<u8>, String)>,
}

fn fallback(path: &Path, size: i64) -> Parsed {
    Parsed {
        title: file_stem(path),
        artist: None,
        album: None,
        album_artist: None,
        track_no: None,
        disc_no: None,
        year: None,
        genre: None,
        duration: 0.0,
        codec: path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_uppercase())
            .unwrap_or_else(|| "未知".to_string()),
        sample_rate: None,
        bits: None,
        channels: None,
        bitrate: None,
        cover: None,
    }
    .with_size(size)
}

impl Parsed {
    fn with_size(mut self, size: i64) -> Self {
        if self.bitrate.is_none() && self.duration > 0.0 {
            self.bitrate = Some(((size as f64 * 8.0) / self.duration) as u32);
        }
        self
    }
}

fn parse_metadata(path: &Path, size: i64) -> Result<Parsed, String> {
    let file = fs::File::open(path).map_err(|e| format!("打开失败: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|ext| ext.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("无法识别格式: {e}"))?;

    let mut format = probed.format;
    let (track_id, params) = {
        let track = format
            .default_track()
            .ok_or_else(|| "没有默认音轨".to_string())?;
        (track.id, track.codec_params.clone())
    };

    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();

    let codec = if extension == "opus" {
        "Opus".to_string()
    } else {
        symphonia::default::get_codecs()
            .get_codec(params.codec)
            .map(|desc| desc.short_name.to_string())
            .unwrap_or_else(|| extension.to_ascii_uppercase())
    };

    let mut sample_rate = params.sample_rate;
    let mut channels = params.channels.map(|value| value.count() as u32);
    if sample_rate.is_none() || channels.is_none() {
        if let Ok(mut decoder) =
            symphonia::default::get_codecs().make(&params, &DecoderOptions::default())
        {
            if let Ok(packet) = format.next_packet() {
                if packet.track_id() == track_id {
                    if let Ok(audio_buf) = decoder.decode(&packet) {
                        let spec = *audio_buf.spec();
                        sample_rate = Some(spec.rate);
                        channels = Some(spec.channels.count() as u32);
                    }
                }
            }
            let _ = format.seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::new(0, 0.0),
                    track_id: Some(track_id),
                },
            );
            decoder.reset();
        }
    }

    let duration = match (params.time_base, params.n_frames) {
        (Some(tb), Some(frames)) => {
            let time = tb.calc_time(frames);
            time.seconds as f64 + time.frac
        }
        _ => 0.0,
    };

    let mut parsed = Parsed {
        title: file_stem(path),
        artist: None,
        album: None,
        album_artist: None,
        track_no: None,
        disc_no: None,
        year: None,
        genre: None,
        duration,
        codec,
        sample_rate,
        bits: params.bits_per_sample,
        channels,
        bitrate: None,
        cover: None,
    };

    if let Some(revision) = format.metadata().current() {
        for tag in revision.tags() {
            let Some(key) = tag.std_key else {
                continue;
            };
            let value = tag.value.to_string();
            if value.trim().is_empty() {
                continue;
            }
            match key {
                StandardTagKey::TrackTitle => parsed.title = value,
                StandardTagKey::Artist => parsed.artist = Some(value),
                StandardTagKey::Album => parsed.album = Some(value),
                StandardTagKey::AlbumArtist => parsed.album_artist = Some(value),
                StandardTagKey::TrackNumber => parsed.track_no = parse_number(&value),
                StandardTagKey::DiscNumber => parsed.disc_no = parse_number(&value),
                StandardTagKey::Date | StandardTagKey::ReleaseDate => {
                    if parsed.year.is_none() {
                        parsed.year = parse_year(&value);
                    }
                }
                StandardTagKey::Genre => parsed.genre = Some(value),
                _ => {}
            }
        }

        let visual = revision
            .visuals()
            .iter()
            .find(|visual| matches!(visual.usage, Some(StandardVisualKey::FrontCover)))
            .or_else(|| revision.visuals().first());
        if let Some(visual) = visual {
            if !visual.data.is_empty() && visual.data.len() <= 32 * 1024 * 1024 {
                parsed.cover = Some((visual.data.to_vec(), visual.media_type.clone()));
            }
        }
    }

    Ok(parsed.with_size(size))
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn save_cover(
    covers_dir: &Path,
    track_path: &Path,
    data: &[u8],
    media_type: &str,
) -> Option<String> {
    let ext = match media_type.to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "jpg",
    };
    let hash = fnv1a(track_path.to_string_lossy().as_bytes());
    let dest = covers_dir.join(format!("{hash:016x}.{ext}"));
    if !dest.exists() {
        fs::write(&dest, data).ok()?;
    }
    Some(dest.to_string_lossy().to_string())
}

fn mtime_secs(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

const UPSERT_TRACK: &str = r#"
INSERT INTO tracks (
    source_key, path, cue_path, cue_start, cue_end, folder_id, title, artist, album, album_artist,
    track_no, disc_no, year, genre, duration, codec, sample_rate, bits, channels, bitrate, size,
    mtime, cover_path, added_at, updated_at
) VALUES (
    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
    ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
    ?21, ?22, ?23, ?24, ?25
)
ON CONFLICT(source_key) DO UPDATE SET
    path = excluded.path,
    cue_path = excluded.cue_path,
    cue_start = excluded.cue_start,
    cue_end = excluded.cue_end,
    folder_id = excluded.folder_id,
    title = excluded.title,
    artist = excluded.artist,
    album = excluded.album,
    album_artist = excluded.album_artist,
    track_no = excluded.track_no,
    disc_no = excluded.disc_no,
    year = excluded.year,
    genre = excluded.genre,
    duration = excluded.duration,
    codec = excluded.codec,
    sample_rate = excluded.sample_rate,
    bits = excluded.bits,
    channels = excluded.channels,
    bitrate = excluded.bitrate,
    size = excluded.size,
    mtime = excluded.mtime,
    cover_path = excluded.cover_path,
    updated_at = excluded.updated_at
"#;

struct CueInfo {
    cue_path: String,
    album: Option<String>,
    performer: Option<String>,
    tracks: Vec<cue::CueTrack>,
}

struct TrackRecord {
    source_key: String,
    path: String,
    cue_path: Option<String>,
    cue_start: Option<f64>,
    cue_end: Option<f64>,
    folder_id: i64,
    title: String,
    artist: Option<String>,
    album: Option<String>,
    album_artist: Option<String>,
    track_no: Option<u32>,
    disc_no: Option<u32>,
    year: Option<u32>,
    genre: Option<String>,
    duration: f64,
    codec: String,
    sample_rate: Option<u32>,
    bits: Option<u32>,
    channels: Option<u32>,
    bitrate: Option<u32>,
    size: i64,
    mtime: i64,
    cover_path: Option<String>,
}

fn normalized_key(path: &Path) -> String {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    path_string(&canonical).to_ascii_lowercase()
}

fn upsert_track(conn: &Connection, record: &TrackRecord) -> Result<(), String> {
    let now = now_secs();
    conn.execute(
        UPSERT_TRACK,
        params![
            &record.source_key,
            &record.path,
            &record.cue_path,
            record.cue_start,
            record.cue_end,
            record.folder_id,
            &record.title,
            &record.artist,
            &record.album,
            &record.album_artist,
            record.track_no,
            record.disc_no,
            record.year,
            &record.genre,
            record.duration,
            &record.codec,
            record.sample_rate,
            record.bits,
            record.channels,
            record.bitrate,
            record.size,
            record.mtime,
            &record.cover_path,
            now,
            now
        ],
    )
    .map_err(|e| format!("写入曲目失败: {e}"))?;
    Ok(())
}

fn track_exists(
    conn: &Connection,
    source_key: &str,
    size: i64,
    mtime: i64,
) -> Result<bool, String> {
    let existing: Option<(i64, i64)> = conn
        .query_row(
            "SELECT size, mtime FROM tracks WHERE source_key = ?1",
            [source_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("查询曲目失败: {e}"))?;
    Ok(existing == Some((size, mtime)))
}

fn update_status(
    status: &Arc<Mutex<ScanStatus>>,
    scanned: u64,
    imported: u64,
    skipped: u64,
    errors: u64,
    current: &str,
) {
    if let Ok(mut status) = status.lock() {
        status.scanned = scanned;
        status.imported = imported;
        status.skipped = skipped;
        status.errors = errors;
        status.current = current.to_string();
    }
}

pub fn run(
    app: AppHandle,
    db_path: PathBuf,
    covers_dir: PathBuf,
    folder_id: i64,
    root: String,
    status: Arc<Mutex<ScanStatus>>,
    cancel: Arc<AtomicBool>,
) {
    let result = run_inner(
        &app,
        &db_path,
        &covers_dir,
        folder_id,
        &root,
        &status,
        &cancel,
    );

    if let Err(error) = result {
        eprintln!("scan failed: {error}");
        if let Ok(mut status) = status.lock() {
            status.errors += 1;
            status.current = error;
        }
    }
    if let Ok(mut status) = status.lock() {
        status.scanning = false;
        status.current.clear();
    }
    emit_progress(&app, &status);
    let _ = app.emit("library://changed", ());
}

fn run_inner(
    app: &AppHandle,
    db_path: &Path,
    covers_dir: &Path,
    folder_id: i64,
    root: &str,
    status: &Arc<Mutex<ScanStatus>>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let conn = db::open(db_path).map_err(|e| format!("打开数据库失败: {e}"))?;
    let mut scanned = 0u64;
    let mut imported = 0u64;
    let mut skipped = 0u64;
    let mut errors = 0u64;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut seen: HashSet<String> = HashSet::new();
    let mut cue_map: HashMap<String, CueInfo> = HashMap::new();

    // 先收集 CUE，建立「音频文件 -> 虚拟分轨」映射
    for entry in WalkDir::new(root).follow_links(false).into_iter().filter_map(|e| e.ok()) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let is_cue = entry
            .path()
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("cue"))
            .unwrap_or(false);
        if !is_cue {
            continue;
        }

        let bytes = match fs::read(entry.path()) {
            Ok(bytes) => bytes,
            Err(error) => {
                errors += 1;
                eprintln!("cue read error {}: {error}", entry.path().display());
                continue;
            }
        };
        let text = match decode_text(&bytes, None) {
            Ok((text, _)) => text,
            Err(error) => {
                errors += 1;
                eprintln!("cue decode error {}: {error}", entry.path().display());
                continue;
            }
        };
        for group in cue::parse_cue(&text) {
            let directory = entry.path().parent().unwrap_or_else(|| Path::new(root));
            let audio = directory.join(&group.file);
            if !audio.is_file() {
                continue;
            }
            cue_map.insert(
                normalized_key(&audio),
                CueInfo {
                    cue_path: path_string(entry.path()),
                    album: group.album,
                    performer: group.performer,
                    tracks: group.tracks,
                },
            );
        }
    }

    for entry in WalkDir::new(root).follow_links(false).into_iter().filter_map(|e| e.ok()) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if !entry.file_type().is_file() || !is_audio(entry.path()) {
            continue;
        }

        let path = entry.path();
        let path_str = path_string(path);
        scanned += 1;

        let size = fs::metadata(path).map(|meta| meta.len() as i64).unwrap_or(0);
        let mtime = mtime_secs(path);
        let key = normalized_key(path);

        if let Some(cue_info) = cue_map.get(&key) {
            let parsed = match parse_metadata(path, size) {
                Ok(parsed) => parsed,
                Err(error) => {
                    errors += 1;
                    eprintln!("metadata error {}: {error}", path.display());
                    fallback(path, size)
                }
            };
            let cover_path = parsed
                .cover
                .as_ref()
                .and_then(|(data, media_type)| save_cover(covers_dir, path, data, media_type));

            conn.execute(
                "DELETE FROM tracks WHERE path = ?1 AND cue_path IS NULL",
                [path_str.as_str()],
            )
            .map_err(|e| format!("清理旧曲目失败: {e}"))?;

            for track in &cue_info.tracks {
                let source_key = format!("{}#{}", path_str, (track.start * 1000.0).round() as i64);
                seen.insert(source_key.clone());

                if track_exists(&conn, &source_key, size, mtime)? {
                    skipped += 1;
                    continue;
                }

                let duration = track
                    .end
                    .map(|end| (end - track.start).max(0.0))
                    .unwrap_or_else(|| (parsed.duration - track.start).max(0.0));
                let record = TrackRecord {
                    source_key,
                    path: path_str.clone(),
                    cue_path: Some(cue_info.cue_path.clone()),
                    cue_start: Some(track.start),
                    cue_end: track.end,
                    folder_id,
                    title: track.title.clone(),
                    artist: track
                        .performer
                        .clone()
                        .or_else(|| cue_info.performer.clone())
                        .or_else(|| parsed.artist.clone()),
                    album: cue_info.album.clone().or_else(|| parsed.album.clone()),
                    album_artist: cue_info
                        .performer
                        .clone()
                        .or_else(|| parsed.album_artist.clone()),
                    track_no: Some(track.number),
                    disc_no: parsed.disc_no,
                    year: parsed.year,
                    genre: parsed.genre.clone(),
                    duration,
                    codec: parsed.codec.clone(),
                    sample_rate: parsed.sample_rate,
                    bits: parsed.bits,
                    channels: parsed.channels,
                    bitrate: parsed.bitrate,
                    size,
                    mtime,
                    cover_path: cover_path.clone(),
                };
                upsert_track(&conn, &record)?;
                imported += 1;
            }
        } else {
            let source_key = path_str.clone();
            seen.insert(source_key.clone());

            if track_exists(&conn, &source_key, size, mtime)? {
                skipped += 1;
            } else {
                let parsed = match parse_metadata(path, size) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        errors += 1;
                        eprintln!("metadata error {}: {error}", path.display());
                        fallback(path, size)
                    }
                };
                let cover_path = parsed
                    .cover
                    .as_ref()
                    .and_then(|(data, media_type)| save_cover(covers_dir, path, data, media_type));
                let record = TrackRecord {
                    source_key,
                    path: path_str.clone(),
                    cue_path: None,
                    cue_start: None,
                    cue_end: None,
                    folder_id,
                    title: parsed.title,
                    artist: parsed.artist,
                    album: parsed.album,
                    album_artist: parsed.album_artist,
                    track_no: parsed.track_no,
                    disc_no: parsed.disc_no,
                    year: parsed.year,
                    genre: parsed.genre,
                    duration: parsed.duration,
                    codec: parsed.codec,
                    sample_rate: parsed.sample_rate,
                    bits: parsed.bits,
                    channels: parsed.channels,
                    bitrate: parsed.bitrate,
                    size,
                    mtime,
                    cover_path,
                };
                upsert_track(&conn, &record)?;
                imported += 1;
            }
        }

        update_status(status, scanned, imported, skipped, errors, &path_str);
        if last_emit.elapsed() >= Duration::from_millis(200) {
            emit_progress(app, status);
            last_emit = Instant::now();
        }
    }

    if !cancel.load(Ordering::Relaxed) {
        let existing_keys: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT source_key FROM tracks WHERE folder_id = ?1")
                .map_err(|e| format!("查询旧曲目失败: {e}"))?;
            let rows = stmt
                .query_map([folder_id], |row| row.get::<_, String>(0))
                .map_err(|e| format!("查询旧曲目失败: {e}"))?;
            rows.filter_map(|row| row.ok()).collect()
        };
        for key in existing_keys {
            if !seen.contains(&key) {
                conn.execute("DELETE FROM tracks WHERE source_key = ?1", [key])
                    .map_err(|e| format!("清理旧曲目失败: {e}"))?;
            }
        }
    }

    conn.execute(
        "UPDATE folders SET last_scan_at = ?1 WHERE id = ?2",
        params![now_secs(), folder_id],
    )
    .map_err(|e| format!("更新目录时间失败: {e}"))?;

    update_status(status, scanned, imported, skipped, errors, "");
    Ok(())
}
fn emit_progress(app: &AppHandle, status: &Arc<Mutex<ScanStatus>>) {
    if let Ok(status) = status.lock() {
        let _ = app.emit("scan://progress", status.clone());
    }
}
