mod db;
mod scan;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, Row};
use serde::Serialize;
use tauri::{AppHandle, State};

pub(crate) fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

pub(crate) fn path_string(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    if let Some(stripped) = value.strip_prefix(r"\\?\") {
        return stripped.to_string();
    }
    value.to_string()
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub scanning: bool,
    pub folder: String,
    pub scanned: u64,
    pub imported: u64,
    pub skipped: u64,
    pub errors: u64,
    pub current: String,
}

struct ScanJob {
    cancel: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

pub struct LibraryState {
    db_path: PathBuf,
    covers_dir: PathBuf,
    scan: Mutex<Option<ScanJob>>,
    status: Arc<Mutex<ScanStatus>>,
}

impl LibraryState {
    pub fn new(db_path: PathBuf, covers_dir: PathBuf) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建数据目录失败 {}: {e}", parent.display()))?;
        }
        fs::create_dir_all(&covers_dir)
            .map_err(|e| format!("创建封面目录失败 {}: {e}", covers_dir.display()))?;
        db::open(&db_path).map_err(|e| format!("初始化曲库失败: {e}"))?;

        Ok(Self {
            db_path,
            covers_dir,
            scan: Mutex::new(None),
            status: Arc::new(Mutex::new(ScanStatus::default())),
        })
    }

    fn conn(&self) -> Result<Connection, String> {
        db::open(&self.db_path).map_err(|e| format!("打开曲库失败: {e}"))
    }

    fn status_snapshot(&self) -> ScanStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_default()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackRow {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_no: Option<u32>,
    pub disc_no: Option<u32>,
    pub year: Option<u32>,
    pub genre: Option<String>,
    pub duration: f64,
    pub codec: Option<String>,
    pub sample_rate: Option<u32>,
    pub bits: Option<u32>,
    pub channels: Option<u32>,
    pub bitrate: Option<u32>,
    pub cover_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackPage {
    pub total: i64,
    pub tracks: Vec<TrackRow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderRow {
    pub id: i64,
    pub path: String,
    pub last_scan_at: Option<i64>,
    pub track_count: i64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub tracks: i64,
    pub folders: i64,
    pub albums: i64,
    pub artists: i64,
    pub total_duration: f64,
}

const TRACK_COLUMNS: &str = "id, path, title, artist, album, album_artist, track_no, disc_no, year, genre, duration, codec, sample_rate, bits, channels, bitrate, cover_path";

fn opt_u32(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<u32>> {
    Ok(row
        .get::<_, Option<i64>>(index)?
        .map(|value| value.max(0) as u32))
}

fn map_track(row: &Row<'_>) -> rusqlite::Result<TrackRow> {
    Ok(TrackRow {
        id: row.get(0)?,
        path: row.get(1)?,
        title: row.get(2)?,
        artist: row.get(3)?,
        album: row.get(4)?,
        album_artist: row.get(5)?,
        track_no: opt_u32(row, 6)?,
        disc_no: opt_u32(row, 7)?,
        year: opt_u32(row, 8)?,
        genre: row.get(9)?,
        duration: row.get::<_, Option<f64>>(10)?.unwrap_or(0.0),
        codec: row.get(11)?,
        sample_rate: opt_u32(row, 12)?,
        bits: opt_u32(row, 13)?,
        channels: opt_u32(row, 14)?,
        bitrate: opt_u32(row, 15)?,
        cover_path: row.get(16)?,
    })
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[tauri::command]
pub fn library_import_folder(
    app: AppHandle,
    state: State<'_, LibraryState>,
    path: String,
) -> Result<(), String> {
    let root = fs::canonicalize(&path).map_err(|e| format!("无法访问目录 {path}: {e}"))?;
    if !root.is_dir() {
        return Err("选择的路径不是目录".to_string());
    }
    let root_str = path_string(&root);

    let conn = state.conn()?;
    conn.execute(
        "INSERT OR IGNORE INTO folders(path, added_at) VALUES (?1, ?2)",
        params![root_str, now_secs()],
    )
    .map_err(|e| format!("写入目录失败: {e}"))?;
    let folder_id: i64 = conn
        .query_row(
            "SELECT id FROM folders WHERE path = ?1",
            [root_str.as_str()],
            |row| row.get(0),
        )
        .map_err(|e| format!("读取目录失败: {e}"))?;

    let previous = state
        .scan
        .lock()
        .map_err(|_| "扫描状态锁失败".to_string())?
        .take();
    if let Some(job) = previous {
        job.cancel.store(true, Ordering::Relaxed);
        if let Some(join) = job.join {
            let _ = join.join();
        }
    }

    {
        let mut status = state
            .status
            .lock()
            .map_err(|_| "扫描状态锁失败".to_string())?;
        *status = ScanStatus {
            scanning: true,
            folder: root_str.clone(),
            ..Default::default()
        };
    }

    let cancel = Arc::new(AtomicBool::new(false));
    let status = Arc::clone(&state.status);
    let cancel_thread = Arc::clone(&cancel);
    let db_path = state.db_path.clone();
    let covers_dir = state.covers_dir.clone();
    let app_handle = app.clone();
    let root_thread = root_str.clone();
    let join = thread::Builder::new()
        .name("matemusic-scan".to_string())
        .spawn(move || {
            scan::run(
                app_handle,
                db_path,
                covers_dir,
                folder_id,
                root_thread,
                status,
                cancel_thread,
            );
        })
        .map_err(|e| format!("无法启动扫描线程: {e}"))?;

    *state
        .scan
        .lock()
        .map_err(|_| "扫描状态锁失败".to_string())? = Some(ScanJob {
        cancel,
        join: Some(join),
    });

    Ok(())
}

#[tauri::command]
pub fn library_cancel_scan(state: State<'_, LibraryState>) -> Result<(), String> {
    if let Some(job) = state
        .scan
        .lock()
        .map_err(|_| "扫描状态锁失败".to_string())?
        .as_ref()
    {
        job.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub fn library_scan_status(state: State<'_, LibraryState>) -> ScanStatus {
    state.status_snapshot()
}

#[tauri::command]
pub fn library_get_tracks(
    state: State<'_, LibraryState>,
    search: Option<String>,
    sort: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<TrackPage, String> {
    let conn = state.conn()?;
    let limit = limit.unwrap_or(200).clamp(1, 1000) as i64;
    let offset = offset.unwrap_or(0).max(0) as i64;
    let order = match sort.as_deref() {
        Some("artist") => "artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE",
        Some("album") => "album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE",
        Some("recent") => "added_at DESC, id DESC",
        Some("duration") => "duration DESC, title COLLATE NOCASE",
        _ => "title COLLATE NOCASE, artist COLLATE NOCASE",
    };
    let query = search.unwrap_or_default().trim().to_string();

    if query.is_empty() {
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
            .map_err(|e| format!("统计曲目失败: {e}"))?;
        let sql = format!(
            "SELECT {TRACK_COLUMNS} FROM tracks ORDER BY {order} LIMIT ?1 OFFSET ?2"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("查询曲目失败: {e}"))?;
        let tracks = stmt
            .query_map(params![limit, offset], map_track)
            .map_err(|e| format!("查询曲目失败: {e}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("读取曲目失败: {e}"))?;
        Ok(TrackPage { total, tracks })
    } else {
        let like = format!("%{}%", escape_like(&query));
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tracks WHERE title LIKE ?1 ESCAPE '\\' OR artist LIKE ?1 ESCAPE '\\' OR album LIKE ?1 ESCAPE '\\'",
                params![like.as_str()],
                |row| row.get(0),
            )
            .map_err(|e| format!("统计曲目失败: {e}"))?;
        let sql = format!(
            "SELECT {TRACK_COLUMNS} FROM tracks WHERE title LIKE ?1 ESCAPE '\\' OR artist LIKE ?1 ESCAPE '\\' OR album LIKE ?1 ESCAPE '\\' ORDER BY {order} LIMIT ?2 OFFSET ?3"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("查询曲目失败: {e}"))?;
        let tracks = stmt
            .query_map(params![like, limit, offset], map_track)
            .map_err(|e| format!("查询曲目失败: {e}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("读取曲目失败: {e}"))?;
        Ok(TrackPage { total, tracks })
    }
}

#[tauri::command]
pub fn library_get_folders(state: State<'_, LibraryState>) -> Result<Vec<FolderRow>, String> {
    let conn = state.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.path, f.last_scan_at, (SELECT COUNT(*) FROM tracks t WHERE t.folder_id = f.id) FROM folders f ORDER BY f.path COLLATE NOCASE",
        )
        .map_err(|e| format!("查询目录失败: {e}"))?;
    let folders = stmt
        .query_map([], |row| {
            Ok(FolderRow {
                id: row.get(0)?,
                path: row.get(1)?,
                last_scan_at: row.get(2)?,
                track_count: row.get(3)?,
            })
        })
        .map_err(|e| format!("查询目录失败: {e}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("读取目录失败: {e}"))?;
    Ok(folders)
}

#[tauri::command]
pub fn library_stats(state: State<'_, LibraryState>) -> Result<LibraryStats, String> {
    let conn = state.conn()?;
    conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM tracks),
            (SELECT COUNT(*) FROM folders),
            (SELECT COUNT(DISTINCT album) FROM tracks WHERE album IS NOT NULL AND album <> ''),
            (SELECT COUNT(DISTINCT artist) FROM tracks WHERE artist IS NOT NULL AND artist <> ''),
            (SELECT COALESCE(SUM(duration), 0) FROM tracks)",
        [],
        |row| {
            Ok(LibraryStats {
                tracks: row.get(0)?,
                folders: row.get(1)?,
                albums: row.get(2)?,
                artists: row.get(3)?,
                total_duration: row.get(4)?,
            })
        },
    )
    .map_err(|e| format!("统计曲库失败: {e}"))
}

#[tauri::command]
pub fn settings_get_all(
    state: State<'_, LibraryState>,
) -> Result<HashMap<String, String>, String> {
    let conn = state.conn()?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| format!("读取设置失败: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取设置失败: {e}"))?;
    let mut settings = HashMap::new();
    for row in rows {
        let (key, value) = row.map_err(|e| format!("读取设置失败: {e}"))?;
        settings.insert(key, value);
    }
    Ok(settings)
}

#[tauri::command]
pub fn settings_set(
    state: State<'_, LibraryState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let conn = state.conn()?;
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| format!("写入设置失败: {e}"))?;
    Ok(())
}
