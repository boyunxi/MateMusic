import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  FolderOpen,
  ListPlus,
  Music2,
  Play,
  Search,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { formatTime, formatTrackFormat } from "../../lib/format";
import {
  cancelScan,
  coverArtClass,
  coverUrl,
  getFolders,
  getScanStatus,
  getStats,
  getTracks,
  importFolder,
  subscribeLibraryChanged,
  subscribeScan,
} from "../../lib/library";
import type {
  FolderRow,
  LibraryStats,
  LibraryTrack,
  ScanStatus,
} from "../../lib/library";
import { inTauri } from "../../lib/player";
import { useAppStore } from "../../store/useAppStore";

const SORTS = [
  { id: "title", label: "标题" },
  { id: "artist", label: "艺术家" },
  { id: "album", label: "专辑" },
  { id: "recent", label: "最近" },
];

export default function LibraryView() {
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("title");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const playTrack = useAppStore((state) => state.playTrack);
  const enqueue = useAppStore((state) => state.enqueue);
  const currentId = useAppStore((state) => state.queue[state.currentIndex]?.id ?? null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 54,
    overscan: 8,
  });

  const refresh = useCallback(async () => {
    if (!inTauri) return;
    try {
      const [page, statsData, folderData] = await Promise.all([
        getTracks({ search: search.trim() || null, sort, limit: 500, offset: 0 }),
        getStats(),
        getFolders(),
      ]);
      setTracks(page.tracks);
      setTotal(page.total);
      setStats(statsData);
      setFolders(folderData);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [search, sort]);

  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 180);
    return () => clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!inTauri) return;
    let disposed = false;
    let unlistenScan: (() => void) | undefined;
    let unlistenLibrary: (() => void) | undefined;

    void getScanStatus()
      .then((status) => {
        if (!disposed) setScan(status);
      })
      .catch(() => {});

    void subscribeScan((status) => setScan(status)).then((fn) => {
      if (disposed) fn();
      else unlistenScan = fn;
    });

    void subscribeLibraryChanged(() => void refresh()).then((fn) => {
      if (disposed) fn();
      else unlistenLibrary = fn;
    });

    return () => {
      disposed = true;
      unlistenScan?.();
      unlistenLibrary?.();
    };
  }, [refresh]);

  const handleImport = async () => {
    if (!inTauri) return;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择音乐文件夹",
      });
      if (typeof selected !== "string") return;
      setBusy(true);
      setError(null);
      await importFolder(selected);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const virtualItems = virtualizer.getVirtualItems();
  const empty = tracks.length === 0;

  return (
    <div className="library-view">
      <header className="library-head">
        <div>
          <p className="eyebrow">曲库</p>
          <h1>本地音乐</h1>
          <p className="library-stats">
            {stats
              ? `${stats.tracks} 首 · ${stats.albums} 张专辑 · ${stats.artists} 位艺术家`
              : "尚未导入音乐"}
          </p>
        </div>
        <button className="import-button" type="button" onClick={handleImport} disabled={busy}>
          <FolderOpen size={16} />
          {busy ? "读取中…" : "导入文件夹"}
        </button>
      </header>

      <div className="library-toolbar">
        <label className="search-box">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索标题、艺术家、专辑"
            aria-label="搜索曲库"
          />
          {search && (
            <button type="button" className="search-clear" onClick={() => setSearch("")} aria-label="清空搜索">
              <X size={14} />
            </button>
          )}
        </label>
        <div className="sort-tabs" role="group" aria-label="排序">
          {SORTS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={sort === item.id ? "is-active" : ""}
              onClick={() => setSort(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {scan?.scanning && (
        <div className="scan-bar">
          <span className="scan-pulse" />
          <span>
            正在扫描 · 已看 {scan.scanned} · 入库 {scan.imported} · 跳过 {scan.skipped}
            {scan.errors > 0 ? ` · 错误 ${scan.errors}` : ""}
          </span>
          <span className="scan-current">{scan.current.split(/[\\/]/).pop()}</span>
          <button type="button" onClick={() => void cancelScan()}>
            取消
          </button>
        </div>
      )}

      {error && <p className="error-line">{error}</p>}

      <div ref={scrollRef} className="library-scroll">
        {empty ? (
          <div className="library-empty">
            <Music2 size={28} strokeWidth={1.4} />
            <p>曲库还是空的</p>
            <p>导入一个本地音乐文件夹，MateMusic 会在后台建立索引。</p>
            <button type="button" onClick={handleImport} disabled={busy}>
              <FolderOpen size={15} /> 选择文件夹
            </button>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((virtualRow) => {
              const track = tracks[virtualRow.index];
              const cover = coverUrl(track.coverPath);
              return (
                <div
                  key={track.id}
                  className={`track-row ${currentId === track.id ? "is-current" : ""}`}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  onDoubleClick={() => playTrack(track, tracks)}
                >
                  <span className={`track-cover ${coverArtClass(track.id)}`}>
                    {cover && <img src={cover} alt="" loading="lazy" />}
                  </span>
                  <span className="track-main">
                    <strong>{track.title}</strong>
                    <em>{track.artist ?? "未知艺术家"}</em>
                  </span>
                  <span className="track-album">{track.album ?? "—"}</span>
                  <span className="track-format">
                    {formatTrackFormat(track.codec, track.bits, track.sampleRate)}
                  </span>
                  <span className="track-duration">{formatTime(track.duration)}</span>
                  <span className="track-actions">
                    <button
                      type="button"
                      onClick={() => playTrack(track, tracks)}
                      aria-label={`播放 ${track.title}`}
                    >
                      <Play size={15} fill="currentColor" />
                    </button>
                    <button
                      type="button"
                      onClick={() => enqueue(track)}
                      aria-label={`将 ${track.title} 加入队列`}
                    >
                      <ListPlus size={15} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <footer className="library-foot">
        显示 {tracks.length} / {total} 首
        {folders.length > 0 ? ` · ${folders.length} 个目录` : ""}
      </footer>
    </div>
  );
}
