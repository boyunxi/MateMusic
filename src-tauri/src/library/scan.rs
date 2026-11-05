use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, StandardTagKey, StandardVisualKey};
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use super::{db, now_secs, path_string, ScanStatus};

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
    let params = {
        let track = format
            .default_track()
            .ok_or_else(|| "没有默认音轨".to_string())?;
        track.codec_params.clone()
    };

    let codec = symphonia::default::get_codecs()
        .get_codec(params.codec)
        .map(|desc| desc.short_name.to_string())
        .unwrap_or_else(|| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.to_ascii_uppercase())
                .unwrap_or_else(|| "未知".to_string())
        });

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
        sample_rate: params.sample_rate,
        bits: params.bits_per_sample,
        channels: params.channels.map(|channels| channels.count() as u32),
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
    path, folder_id, title, artist, album, album_artist, track_no, disc_no, year, genre,
    duration, codec, sample_rate, bits, channels, bitrate, size, mtime, cover_path, added_at, updated_at
) VALUES (
    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
    ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21
)
ON CONFLICT(path) DO UPDATE SET
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

        let existing: Option<(i64, i64)> = conn
            .query_row(
                "SELECT size, mtime FROM tracks WHERE path = ?1",
                [path_str.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("查询曲目失败: {e}"))?;

        if existing == Some((size, mtime)) {
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
                .and_then(|(data, media_type)| {
                    save_cover(covers_dir, path, data, media_type)
                });
            let now = now_secs();

            conn.execute(
                UPSERT_TRACK,
                params![
                    &path_str,
                    folder_id,
                    parsed.title,
                    parsed.artist,
                    parsed.album,
                    parsed.album_artist,
                    parsed.track_no,
                    parsed.disc_no,
                    parsed.year,
                    parsed.genre,
                    parsed.duration,
                    parsed.codec,
                    parsed.sample_rate,
                    parsed.bits,
                    parsed.channels,
                    parsed.bitrate,
                    size,
                    mtime,
                    cover_path,
                    now,
                    now
                ],
            )
            .map_err(|e| format!("写入曲目失败: {e}"))?;
            imported += 1;
        }

        if let Ok(mut status) = status.lock() {
            status.scanned = scanned;
            status.imported = imported;
            status.skipped = skipped;
            status.errors = errors;
            status.current = path_str;
        }
        if last_emit.elapsed() >= Duration::from_millis(200) {
            emit_progress(app, status);
            last_emit = Instant::now();
        }
    }

    conn.execute(
        "UPDATE folders SET last_scan_at = ?1 WHERE id = ?2",
        params![now_secs(), folder_id],
    )
    .map_err(|e| format!("更新目录时间失败: {e}"))?;

    if let Ok(mut status) = status.lock() {
        status.scanned = scanned;
        status.imported = imported;
        status.skipped = skipped;
        status.errors = errors;
        status.current.clear();
    }

    Ok(())
}

fn emit_progress(app: &AppHandle, status: &Arc<Mutex<ScanStatus>>) {
    if let Ok(status) = status.lock() {
        let _ = app.emit("scan://progress", status.clone());
    }
}
