import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  FolderOpen,
  ListMusic,
  ListPlus,
  Music2,
  Play,
  Plus,
  Search,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { formatTime, formatTrackFormat } from "../../lib/format";
import {
  coverArtClass,
  coverUrl,
  getFolders,
  getPlaylists,
  getPlaylistTracks,
  getStats,
  getTracks,
  importFolder,
  subscribeLibraryChanged,
} from "../../lib/library";
import type {
  FolderRow,
  LibraryStats,
  LibraryTrack,
  PlaylistRow,
} from "../../lib/library";
import { inTauri } from "../../lib/player";
import { useAppStore } from "../../store/useAppStore";
import { useToastStore } from "../../store/useToastStore";
import PlaylistModal from "./PlaylistModal";

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
  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);
  const [playlistId, setPlaylistId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("title");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<{ track?: LibraryTrack } | null>(null);

  const pushToast = useToastStore((state) => state.push);
  const playTrack = useAppStore((state) => state.playTrack);
  const enqueue = useAppStore((state) => state.enqueue);
  const currentId = useAppStore((state) => state.queue[state.currentIndex]?.id ?? null);

  const scrollRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!inTauri) return;
    try {
      const [statsData, folderData, playlistData] = await Promise.all([
        getStats(),
        getFolders(),
        getPlaylists(),
      ]);
      setStats(statsData);
      setFolders(folderData);
      setPlaylists(playlistData);

      if (playlistId != null) {
        const playlistTracks = await getPlaylistTracks(playlistId);
        setTracks(playlistTracks);
        setTotal(playlistTracks.length);
      } else {
        const page = await getTracks({
          search: search.trim() || null,
          sort,
          limit: 500,
          offset: 0,
        });
        setTracks(page.tracks);
        setTotal(page.total);
      }
    } catch (err) {
      pushToast({ kind: "error", message: String(err) });
    }
  }, [playlistId, search, sort, pushToast]);

  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 180);
    return () => clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!inTauri) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeLibraryChanged(() => void refresh()).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const displayTracks = useMemo(() => {
    if (playlistId == null) return tracks;
    const query = search.trim().toLowerCase();
    const filtered = tracks.filter(
      (track) =>
        !query ||
        [track.title, track.artist, track.album].some((value) =>
          value?.toLowerCase().includes(query),
        ),
    );
    const sorted = [...filtered];
    const compare = (a: string | null, b: string | null) =>
      (a ?? "").localeCompare(b ?? "", "zh-Hans-CN");
    switch (sort) {
      case "artist":
        sorted.sort(
          (a, b) => compare(a.artist, b.artist) || compare(a.album, b.album),
        );
        break;
      case "album":
        sorted.sort(
          (a, b) =>
            compare(a.album, b.album) ||
            (a.discNo ?? 0) - (b.discNo ?? 0) ||
            (a.trackNo ?? 0) - (b.trackNo ?? 0),
        );
        break;
      case "duration":
        sorted.sort((a, b) => b.duration - a.duration);
        break;
      case "recent":
        break;
      default:
        sorted.sort((a, b) => compare(a.title, b.title));
    }
    return sorted;
  }, [tracks, playlistId, search, sort]);

  const virtualizer = useVirtualizer({
    count: displayTracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 54,
    overscan: 8,
  });

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
      await importFolder(selected);
      pushToast({ kind: "info", message: "已开始扫描文件夹", duration: 3000 });
      await refresh();
    } catch (err) {
      pushToast({ kind: "error", message: String(err), duration: 6000 });
    } finally {
      setBusy(false);
    }
  };

  const activePlaylist = playlists.find((playlist) => playlist.id === playlistId) ?? null;
  const virtualItems = virtualizer.getVirtualItems();
  const empty = displayTracks.length === 0;

  return (
    <div className="library-view">
      <header className="library-head">
        <div>
          <p className="eyebrow">曲库</p>
          <h1>{activePlaylist?.name ?? "本地音乐"}</h1>
          <p className="library-stats">
            {activePlaylist
              ? `${displayTracks.length} 首 · 歌单`
              : stats
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
            <button
              type="button"
              className="search-clear"
              onClick={() => setSearch("")}
              aria-label="清空搜索"
            >
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

      <div className="playlist-bar">
        <button
          type="button"
          className={`playlist-chip ${playlistId == null ? "is-active" : ""}`}
          onClick={() => setPlaylistId(null)}
        >
          全部曲目
        </button>
        {playlists.map((playlist) => (
          <button
            key={playlist.id}
            type="button"
            className={`playlist-chip ${playlistId === playlist.id ? "is-active" : ""}`}
            onClick={() => setPlaylistId(playlist.id)}
          >
            {playlist.name}
            <em>{playlist.trackCount}</em>
          </button>
        ))}
        <button
          type="button"
          className="playlist-chip playlist-create"
          onClick={() => setModal({})}
        >
          <Plus size={13} />
          新建歌单
        </button>
      </div>

      <div ref={scrollRef} className="library-scroll">
        {empty ? (
          <div className="library-empty">
            <Music2 size={28} strokeWidth={1.4} />
            <p>{playlistId != null ? "这个歌单还是空的" : "曲库还是空的"}</p>
            <p>
              {playlistId != null
                ? "在全部曲目里点「加入歌单」，把歌曲放进来。"
                : "导入一个本地音乐文件夹，MateMusic 会在后台建立索引。"}
            </p>
            {playlistId == null && (
              <button type="button" onClick={handleImport} disabled={busy}>
                <FolderOpen size={15} /> 选择文件夹
              </button>
            )}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((virtualRow) => {
              const track = displayTracks[virtualRow.index];
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
                  onDoubleClick={() => playTrack(track, displayTracks)}
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
                      onClick={() => playTrack(track, displayTracks)}
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
                    <button
                      type="button"
                      onClick={() => setModal({ track })}
                      aria-label={`将 ${track.title} 加入歌单`}
                    >
                      <ListMusic size={15} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <footer className="library-foot">
        显示 {displayTracks.length} / {total} 首
        {folders.length > 0 ? ` · ${folders.length} 个目录` : ""}
        {activePlaylist ? ` · 歌单「${activePlaylist.name}」` : ""}
      </footer>

      {modal && (
        <PlaylistModal
          track={modal.track}
          onClose={() => setModal(null)}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}
