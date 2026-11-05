use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS folders (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL UNIQUE,
    added_at     INTEGER NOT NULL,
    last_scan_at INTEGER
);

CREATE TABLE IF NOT EXISTS tracks (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL UNIQUE,
    folder_id    INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    artist       TEXT,
    album        TEXT,
    album_artist TEXT,
    track_no     INTEGER,
    disc_no      INTEGER,
    year         INTEGER,
    genre        TEXT,
    duration     REAL NOT NULL DEFAULT 0,
    codec        TEXT,
    sample_rate  INTEGER,
    bits         INTEGER,
    channels     INTEGER,
    bitrate      INTEGER,
    size         INTEGER NOT NULL DEFAULT 0,
    mtime        INTEGER NOT NULL DEFAULT 0,
    cover_path   TEXT,
    added_at     INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
CREATE INDEX IF NOT EXISTS idx_tracks_folder ON tracks(folder_id);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playlists (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, position)
);

CREATE TABLE IF NOT EXISTS playback_state (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    current_track_id INTEGER,
    position        REAL NOT NULL DEFAULT 0,
    queue_json      TEXT,
    mode            TEXT,
    updated_at      INTEGER NOT NULL
);
"#;

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let mut version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version < 1 {
        conn.execute_batch(SCHEMA_V1)?;
        conn.execute_batch("PRAGMA user_version = 1;")?;
        version = 1;
    }
    if version < 2 {
        conn.execute_batch(
            "ALTER TABLE playback_state ADD COLUMN current_index INTEGER NOT NULL DEFAULT -1;",
        )?;
        conn.execute_batch("PRAGMA user_version = 2;")?;
    }
    Ok(())
}
